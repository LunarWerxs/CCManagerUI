/**
 * The orchestrator, driven from inside the daemon.
 *
 * WHAT IT IS. `orchestrator/` (a sibling of server/ and web/) is the Python toolbox that decides
 * what SHOULD happen to a chat: the dry loop, the sweep's lanes, moving chats between accounts,
 * archiving, naming, the tray-icon switch. It talks to this daemon over HTTP and owns no state the
 * daemon owns. Until 2026-09-03 it was a separate repository that an agent had to be TOLD about
 * ("you have to use both") - the owner's order that day was to fold it in, so one MCP surface
 * covers the whole fleet. This module is the seam: the daemon runs `python orch.py <script>` on the
 * caller's behalf and hands back what it printed. The rules stay where they are - in the scripts
 * (nothing acts without the tray icon; `--force` is a person's word; every act is verified) - so
 * driving them from here cannot bypass anything a hand-typed `python orch.py` could not.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a rewrite of the toolbox in TypeScript (v2 was exactly that, and
 * was retired for acting on chats that were not finished - orchestrator/README.md tells that story),
 * and not a shell: the script name is validated against the menu grammar and the arguments go to
 * the process as an argv array, never through a shell, so there is nothing to inject.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT } from './config'
import { killProcessTree } from './core/process'
import { readInstanceInfo } from './instance'

/** Where the toolbox lives. `AGENTHYDRA_ORCHESTRATOR_DIR` overrides for a layout where the Python
 *  tree sits somewhere else (a compiled binary with the tree copied beside it, or a developer
 *  pointing at a second checkout); the default is the sibling folder in this repo / this release. */
export function orchestratorDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTHYDRA_ORCHESTRATOR_DIR?.trim()
  return override || join(APP_ROOT, 'orchestrator')
}

/** The interpreter. `python` is what the toolbox's own docs and both owner machines use on Windows;
 *  Debian-family Linux and macOS ship only `python3`. `AGENTHYDRA_PYTHON` names a specific binary. */
export function pythonBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string {
  const override = env.AGENTHYDRA_PYTHON?.trim()
  if (override) return override
  return platform === 'win32' ? 'python' : 'python3'
}

/** A menu name: `chats`, `migrate_chat`, `loop`, `armed`. orch.py resolves it to scripts/<name>.py
 *  or to one of its own driver words; anything else is refused HERE, before a process exists. */
const SCRIPT_NAME = /^[a-z][a-z0-9_]{0,63}$/
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 4000
export const DEFAULT_TIMEOUT_MS = 10 * 60_000
/** A fleet-wide ACTING pass (the live loop, the sweep) legitimately runs past ten minutes, and
 *  killing it there would orphan actuators mid-act - so it gets the long deadline whichever tool
 *  asked for it, not only the one that happens to know. */
export const LONG_TIMEOUT_MS = 30 * 60_000
export const MAX_TIMEOUT_MS = 60 * 60_000

export function defaultDeadline(script: string, args: string[]): number {
  if (script === 'sweep' || (script === 'loop' && args.includes('--live'))) return LONG_TIMEOUT_MS
  return DEFAULT_TIMEOUT_MS
}

/** The driver's own words. orch.py's exit codes (DRIVER_EXIT_MEANINGS) describe THESE; a delegated
 *  script's exit code is its own (`orch.py <script>` returns `mod.main()` verbatim), so a 3 from
 *  migrate_chat means what migrate_chat's --help says, never "not armed". */
const DRIVER_WORDS = new Set(['loop', 'arm', 'resume', 'pause', 'disarm', 'armed'])

/** One run per script name at a time. The scripts carry their own locks for what must never
 *  overlap (a window, a lane's lockfile); this is the daemon-side backstop so two callers cannot
 *  start the same acting pass twice through this route. Different scripts may overlap. */
const inFlight = new Map<string, number>()

/** Is any toolbox script running through this daemon right now? The compiled updater asks
 *  before it replaces orchestrator/ (audit AH-08). */
export function orchestratorBusy(): boolean {
  return inFlight.size > 0
}

// ── durable operations (audit AH-09) ────────────────────────────────────────────────────────
//
// A script may run for 10, 30 or 60 minutes, and the HTTP route used to hold its result hostage
// to one connection whose idle timeout is 255 s. Reproduced end to end: ECONNRESET at 256 s, a
// retry answered "busy", and the original command finished at 270 s with nobody to tell. A client
// therefore read "network failure" for an act that was still running, and a blind retry could
// either hit busy or, later, repeat an act that had already completed.
//
// The registry below makes a run an OPERATION with an id and a lifetime beyond the connection:
//   * a caller may pass an idempotency key - a second request with the same key, while the
//     first is running or within OPERATION_TTL_MS of finishing, returns THE SAME operation and
//     starts nothing (so a retry after a dropped connection gets the original outcome);
//   * a caller may ask for the id up front (`async`) and poll it;
//   * a running operation can be cancelled, which kills the child's whole tree; the outcome then
//     says cancelled rather than failed.
// Results are kept in memory, bounded (OPERATION_KEEP) and expiring (OPERATION_TTL_MS): this is
// reconciliation for a dropped connection and a restart-free daemon, not an audit log - the
// toolbox's own ledgers are the durable record of what an act did.

export type OrchestratorOutcome = OrchestratorRun | { ok: false; error: string; busy?: boolean }

export interface OrchestratorOperation {
  id: string
  script: string
  args: string[]
  idempotencyKey: string | null
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** Null while running. */
  result: OrchestratorOutcome | null
  /** True once the child process actually started. A refusal before that (bad request, busy)
   *  is a result too, but not one an idempotency key should pin: the caller may retry. */
  ran: boolean
}

interface OperationEntry {
  op: OrchestratorOperation
  promise: Promise<OrchestratorOperation>
  kill: (() => void) | null
  cancelRequested: boolean
}

const OPERATION_TTL_MS = 60 * 60_000
const OPERATION_KEEP = 200
const operations = new Map<string, OperationEntry>()

function pruneOperations(now = Date.now()): void {
  const finished = [...operations.values()].filter((e) => e.op.finishedAt !== null)
  for (const e of finished) {
    if (now - (e.op.finishedAt ?? now) > OPERATION_TTL_MS) operations.delete(e.op.id)
  }
  const stillFinished = [...operations.values()]
    .filter((e) => e.op.finishedAt !== null)
    .sort((a, b) => (a.op.finishedAt ?? 0) - (b.op.finishedAt ?? 0))
  while (stillFinished.length > OPERATION_KEEP) {
    const oldest = stillFinished.shift()
    if (oldest) operations.delete(oldest.op.id)
  }
}

function snapshot(op: OrchestratorOperation): OrchestratorOperation {
  return { ...op, args: [...op.args] }
}

/**
 * Start a run as an operation - or, with an idempotency key that names one already running or
 * recently finished (and which actually ran), return that one and start nothing.
 */
export function startOrchestratorOperation(
  input: { script?: unknown; args?: unknown; timeoutMs?: unknown },
  opts: {
    idempotencyKey?: string | null
    deps?: SpawnDeps & { dir?: string; python?: string }
  } = {},
): { op: OrchestratorOperation; promise: Promise<OrchestratorOperation>; reused: boolean } {
  pruneOperations()
  const key = opts.idempotencyKey?.trim() || null
  if (key) {
    for (const e of operations.values()) {
      if (e.op.idempotencyKey === key && (e.op.status === 'running' || e.op.ran))
        return { op: snapshot(e.op), promise: e.promise, reused: true }
    }
  }
  const check = validateInvocation(input)
  const op: OrchestratorOperation = {
    id: crypto.randomUUID(),
    script: check.ok ? check.invocation.script : String(input.script ?? ''),
    args: check.ok ? check.invocation.args : [],
    idempotencyKey: key,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    result: null,
    ran: false,
  }
  const entry: OperationEntry = {
    op,
    promise: Promise.resolve(op),
    kill: null,
    cancelRequested: false,
  }
  const deps = opts.deps ?? {}
  entry.promise = runOrchestrator(input, {
    ...deps,
    onProcess: (kill) => {
      op.ran = true
      entry.kill = kill
      deps.onProcess?.(kill)
      // A cancel that arrived before the child existed lands the moment it does.
      if (entry.cancelRequested) kill()
    },
  }).then((result) => {
    // An injected spawn never reports a process; if the run went far enough to have a script
    // record, it ran as far as this registry is concerned.
    if ('script' in result) op.ran = true
    op.result = result
    op.finishedAt = Date.now()
    op.status = entry.cancelRequested ? 'cancelled' : result.ok ? 'done' : 'failed'
    return snapshot(op)
  })
  operations.set(op.id, entry)
  return { op: snapshot(op), promise: entry.promise, reused: false }
}

export function getOrchestratorOperation(id: string): OrchestratorOperation | null {
  const e = operations.get(id)
  return e ? snapshot(e.op) : null
}

export function listOrchestratorOperations(): OrchestratorOperation[] {
  pruneOperations()
  return [...operations.values()]
    .map((e) => snapshot(e.op))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Ask a running operation to stop. Its whole process tree is killed; the outcome then reads
 *  `cancelled`. A finished operation is left as it is. */
export function cancelOrchestratorOperation(
  id: string,
): { ok: true; status: OrchestratorOperation['status'] } | { ok: false; error: string } {
  const e = operations.get(id)
  if (!e) return { ok: false, error: 'no such operation' }
  if (e.op.status !== 'running') return { ok: true, status: e.op.status }
  e.cancelRequested = true
  e.kill?.()
  return { ok: true, status: 'running' }
}

/** Tests only: forget every operation (the registry is module state). */
export function resetOrchestratorOperationsForTests(): void {
  operations.clear()
}
/** Output kept per stream. The dry loop over a full fleet is a few thousand lines; a runaway is
 *  truncated from the FRONT so the verdict lines at the end survive. */
export const MAX_OUTPUT_CHARS = 200_000

export interface OrchestratorInvocation {
  script: string
  args: string[]
  timeoutMs: number
}

export type InvocationCheck =
  | { ok: true; invocation: OrchestratorInvocation }
  | { ok: false; error: string }

/** Pure. Shapes the caller's request into an argv the driver accepts, or says exactly why not. */
export function validateInvocation(input: {
  script?: unknown
  args?: unknown
  timeoutMs?: unknown
}): InvocationCheck {
  const script = typeof input.script === 'string' ? input.script.trim() : ''
  if (!script)
    return {
      ok: false,
      error: 'script is required (a menu name such as `chats`, `loop` or `armed`)',
    }
  if (!SCRIPT_NAME.test(script))
    return {
      ok: false,
      error: `script ${JSON.stringify(script)} is not a menu name (lowercase letters, digits, underscores)`,
    }
  const rawArgs = input.args == null ? [] : input.args
  if (!Array.isArray(rawArgs)) return { ok: false, error: 'args must be an array of strings' }
  if (rawArgs.length > MAX_ARGS)
    return { ok: false, error: `too many args (${rawArgs.length} > ${MAX_ARGS})` }
  const args: string[] = []
  for (const a of rawArgs) {
    if (typeof a !== 'string') return { ok: false, error: 'every arg must be a string' }
    if (a.length > MAX_ARG_LENGTH)
      return { ok: false, error: `an arg is longer than ${MAX_ARG_LENGTH} characters` }
    if (a.includes('\0')) return { ok: false, error: 'an arg contains a NUL byte' }
    args.push(a)
  }
  let timeoutMs = defaultDeadline(script, args)
  if (input.timeoutMs != null) {
    const n = Number(input.timeoutMs)
    if (!Number.isFinite(n) || n <= 0)
      return { ok: false, error: 'timeoutMs must be a positive number' }
    timeoutMs = Math.min(Math.floor(n), MAX_TIMEOUT_MS)
  }
  return { ok: true, invocation: { script, args, timeoutMs } }
}

/**
 * May a request carrying this Origin run an orchestrator script? Pure.
 *
 * The daemon's shared loopback guard (loopback-guard.mjs) rejects CROSS-site browser requests, but
 * a page served from ANOTHER loopback port is "same-site" to the Fetch spec (a site ignores the
 * port), and the guard strips ports before comparing - so a dev server, a preview, or any local
 * daemon's page could POST here. The orchestrator's own gateway closed exactly this hole on
 * 2026-09-03 (its commit 8c636b9: "Origins must now match exactly"); this route, which can run any
 * script with a person's `--force`, gets the same rule: no Origin (curl, the tray, an MCP client -
 * same-machine tools the owner ran) or the daemon's OWN origin, byte for byte. Nothing else.
 */
export function runOriginAllowed(
  originHeader: string | null | undefined,
  requestUrl: string,
): boolean {
  const origin = (originHeader ?? '').trim()
  if (!origin || origin === 'null') return !origin
  try {
    return new URL(origin).origin === new URL(requestUrl).origin
  } catch {
    return false
  }
}

/** What orch.py's exit codes mean, verbatim from its docstring, so a caller reads a verdict and not
 *  a number. A script's OWN codes (migrate_chat's 4 = live writer, 6 = held, ...) are in that
 *  script's `--help`; the driver passes them through unchanged. */
export const DRIVER_EXIT_MEANINGS: Readonly<Record<number, string>> = Object.freeze({
  0: 'ok',
  1: 'daemon failure',
  2: 'the loop found something that failed',
  3: 'unknown script, deterministic refusal, or not armed (nothing acts without the tray icon)',
})

/** Pure. 0 is ok for everyone; the other meanings apply only to the driver's own words. */
export function exitMeaning(script: string, code: number | null): string | null {
  if (code == null) return null
  if (code === 0) return DRIVER_EXIT_MEANINGS[0] ?? 'ok'
  return DRIVER_WORDS.has(script) ? (DRIVER_EXIT_MEANINGS[code] ?? null) : null
}

export interface OrchestratorRun {
  ok: boolean
  script: string
  args: string[]
  command: string[]
  cwd: string
  exitCode: number | null
  exitMeaning: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
}

/** One row of `lib/actionlib.CATALOG`, as `orch.py --catalog` prints it. Deliberately loose: the
 *  Python catalog is the source of truth and gains fields as scripts gain rails, and a daemon that
 *  rejected a key it had not been taught would turn a catalog addition into an outage here. */
export interface OrchestratorAction {
  /** `observe` (reads only) or `mutate` (changes something, behind the rails). */
  kind: string
  summary: string
  invocation?: string
  platforms?: string
  guards?: string[]
  result?: string
  availability?: string
  [extra: string]: unknown
}

export interface OrchestratorStatus {
  dir: string
  present: boolean
  python: string
  pythonVersion: string | null
  /** The driver's own menu (`python orch.py` with no arguments), when the tree is present and
   *  python answers - the one place every script and what it does is listed. */
  menu: string | null
  /** The same list as DATA (`orch.py --catalog`, i.e. lib/actionlib.CATALOG), so a caller reads
   *  the actions instead of parsing `menu`'s prose (audit AH-25). null means NOT READ, never "it
   *  has no actions" - `actionsError` says which, so the two can never look alike. */
  actions: Record<string, OrchestratorAction> | null
  actionsError: string | null
  error: string | null
}

/** Bounded and newline-normalised: python on Windows emits CRLF into a pipe, and an agent reading
 *  the verdict lines should not have to strip carriage returns first. `alreadyDropped` is what the
 *  spawn adapter discarded WHILE READING (see drainBounded); it is folded into the one truncation
 *  header so the caller sees the whole loss, not just this final trim. */
function tail(raw: string, alreadyDropped = 0): string {
  const text = raw.replace(/\r\n?/g, '\n')
  const extra = Math.max(0, text.length - MAX_OUTPUT_CHARS)
  const dropped = alreadyDropped + extra
  const kept = extra ? text.slice(-MAX_OUTPUT_CHARS) : text
  return dropped > 0 ? `…[truncated ${dropped} chars]\n${kept}` : kept
}

/** One spawn, captured, with a deadline. Exposed for tests through `deps`; the real thing is
 *  Bun.spawn with windowsHide (python is a console program - see scripts/checks/spawn-console-window.mjs). */
/** What a spawn adapter can hand back while the child runs. `onProcess` receives a kill switch
 *  the moment the child exists, so a caller (the durable-operation registry) can cancel it. */
export interface SpawnHooks {
  onProcess?: (kill: () => void) => void
}

export interface SpawnDeps {
  /** Forwarded to the spawn adapter; see SpawnHooks. */
  onProcess?: SpawnHooks['onProcess']
  spawn?: (
    command: string[],
    cwd: string,
    timeoutMs: number,
    hooks?: SpawnHooks,
  ) => Promise<{
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    /** Characters the adapter discarded from the FRONT of each stream while reading, when the
     *  child said more than MAX_OUTPUT_CHARS. A fake spawn may leave these out. */
    stdoutDropped?: number
    stderrDropped?: number
  }>
}

/**
 * Read a child's stream to its end while keeping at most `cap` characters of it - the LAST
 * `cap`, so the verdict lines survive - and counting what was let go (audit AH-14).
 *
 * Before this the adapter did `new Response(stream).text()` and applied the cap afterwards, so a
 * verbose or runaway script (a dry loop over a big fleet prints thousands of lines; a stuck one
 * can print forever until its deadline) had the daemon hold the ENTIRE output in memory first
 * and only then keep 200k of it. The cap now applies as the bytes arrive. Both streams are
 * drained concurrently by the caller so the child can never block on a full pipe.
 */
export async function drainBounded(
  stream: ReadableStream<Uint8Array> | null | undefined,
  cap = MAX_OUTPUT_CHARS,
  abandon?: AbortSignal,
): Promise<{ text: string; dropped: number }> {
  if (!stream) return { text: '', dropped: 0 }
  const decoder = new TextDecoder('utf-8')
  const reader = stream.getReader()
  // `abandon` fires when the child was killed and its pipe STILL has not closed: a grandchild the
  // tree walk could not see is holding it. What arrived so far is returned; waiting longer would
  // hold the route open for as long as that stranger lives (the CI container proved it: no
  // process table, a 120 s grandchild, a route that never answered).
  const giveUp = () => {
    reader.cancel().catch(() => {})
  }
  if (abandon?.aborted) giveUp()
  else abandon?.addEventListener('abort', giveUp, { once: true })
  let text = ''
  let dropped = 0
  const trim = () => {
    if (text.length > cap) {
      dropped += text.length - cap
      text = text.slice(-cap)
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      trim()
    }
    text += decoder.decode()
    trim()
  } catch {
    // A read error (the child was killed mid-write, the pipe closed under us): what arrived is
    // still the honest answer, and the exit code says the rest.
  } finally {
    abandon?.removeEventListener('abort', giveUp)
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
  return { text, dropped }
}

// The Unix process-tree walk and the tree kill live in ./core/process, beside the process table
// they read: dispatch.ts needs the same two, and keeping a second copy here is how its Unix
// branch stayed a bare single-process kill while this one was fixed (audit AH-15, and the
// adversarial re-check of that closure on 2026-09-06 that found the surviving duplicate).

/** Kill the WHOLE tree, not just python. An acting script blocks on its actuator (a powershell
 *  driving a window, `subprocess.run` in migrate_chat / chips / courier); killing only the
 *  interpreter would leave that actuator running unsupervised while the caller reads "timed
 *  out". The toolbox itself uses `taskkill /T /F` for the same reason (lib/enginelib.py). The walk
 *  and the kill live in core/process.ts (killProcessTree), shared with dispatch.ts, because two
 *  copies of this is how dispatch's Unix branch stayed a single-process kill after this one was
 *  fixed. */
function killTree(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    if (proc.pid) killProcessTree(proc.pid)
    // Settle Bun's own handle too: the tree kill above went through the OS, and on Windows it
    // already took this pid with it, so this is a no-op there and the real kill on a host where
    // the pid could not be enumerated.
    proc.kill('SIGKILL')
  } catch {
    // already gone
  }
}

/** The URL THIS daemon answers on, recorded by index.ts the moment it has bound its port. */
let daemonUrl: string | null = null

export function setOrchestratorDaemonUrl(url: string): void {
  daemonUrl = url
}

/**
 * The environment a toolbox child runs with.
 *
 * Two things are pinned here rather than inherited:
 *
 *   * PYTHONUTF8 / PYTHONIOENCODING: Python writing to a PIPE on Windows encodes with the locale
 *     code page (cp1252) unless told otherwise, and the toolbox prints '×', '🟢' and account names
 *     - decoded as UTF-8 here that would be mojibake on a machine without UTF-8 mode.
 *   * AGENTHYDRA_URL: THE DAEMON THAT SPAWNED THE CHILD (audit AH-04). hydralib's default is
 *     127.0.0.1:7787 and it only ever read AGENTHYDRA_URL, while this daemon auto-hops to another
 *     port when 7787 is taken and never told its child. Reproduced: AGENTHYDRA_PORT=17787 with no
 *     URL set, and the toolbox still addressed 7787 - a menu that looks healthy while every fleet
 *     read fails, or, with an older daemon on 7787, the wrong daemon answering. The bound URL
 *     overrides any AGENTHYDRA_URL the daemon itself inherited: a child of this daemon talks to
 *     this daemon, whatever the shell that started the daemon was pointed at.
 */
export function orchestratorChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  url: string | null = daemonUrl,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(base as Record<string, string>),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  const own = url ?? readInstanceInfo()?.url ?? null
  if (own) env.AGENTHYDRA_URL = own
  return env
}

/** After a kill, how long an unclosed pipe is waited on before the drain is abandoned. */
const DRAIN_GRACE_MS = 5_000

async function realSpawn(command: string[], cwd: string, timeoutMs: number, hooks?: SpawnHooks) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
    env: orchestratorChildEnv(),
  })
  const abandon = new AbortController()
  let grace: ReturnType<typeof setTimeout> | null = null
  const killAndBound = () => {
    killTree(proc)
    // The kill takes the tree we can see. If a pipe is still open DRAIN_GRACE_MS later, something
    // we could not see holds it; stop reading rather than hang the route on it.
    grace ??= setTimeout(() => abandon.abort(), DRAIN_GRACE_MS)
  }
  hooks?.onProcess?.(killAndBound)
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    killAndBound()
  }, timeoutMs)
  try {
    // Both streams drained together, bounded as they arrive (drainBounded): a child that fills one
    // pipe while the other is unread would otherwise deadlock, and one that never stops talking
    // would otherwise be held whole in memory until its deadline.
    const [out, err, code] = await Promise.all([
      drainBounded(proc.stdout, MAX_OUTPUT_CHARS, abandon.signal),
      drainBounded(proc.stderr, MAX_OUTPUT_CHARS, abandon.signal),
      proc.exited,
    ])
    return {
      code,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      stdoutDropped: out.dropped,
      stderrDropped: err.dropped,
    }
  } finally {
    // Whatever happened above (a drain that threw, a rejected exit), the deadline timer must not
    // fire on a run that is already over, and a child still alive must not outlive its adapter.
    clearTimeout(killer)
    if (grace) clearTimeout(grace)
    if (proc.exitCode === null && !proc.killed) killTree(proc)
  }
}

/** Run one script by its menu name. The driver's cwd is the toolbox root, exactly as a person
 *  typing `python orch.py <script>` there, so state/, the tray heartbeat and the ledgers resolve
 *  to the same files a hand-run would use. */
export async function runOrchestrator(
  input: { script?: unknown; args?: unknown; timeoutMs?: unknown },
  deps: SpawnDeps & { dir?: string; python?: string } = {},
): Promise<OrchestratorRun | { ok: false; error: string; busy?: boolean }> {
  const check = validateInvocation(input)
  if (!check.ok) return { ok: false, error: check.error }
  const { script, args, timeoutMs } = check.invocation
  const dir = deps.dir ?? orchestratorDir()
  const driver = join(dir, 'orch.py')
  if (!existsSync(driver))
    return {
      ok: false,
      error: `the orchestrator is not at ${dir} (no orch.py). It ships in this repo as orchestrator/; set AGENTHYDRA_ORCHESTRATOR_DIR if it lives elsewhere.`,
    }
  const command = [deps.python ?? pythonBinary(), 'orch.py', script, ...args]
  const spawn = deps.spawn ?? realSpawn
  const since = inFlight.get(script)
  if (since != null)
    return {
      ok: false,
      busy: true,
      error: `${script} is already running through this route (started ${Math.round((Date.now() - since) / 1000)}s ago) - wait for it rather than starting a second one`,
    }
  const started = Date.now()
  inFlight.set(script, started)
  try {
    const r = await spawn(command, dir, timeoutMs, { onProcess: deps.onProcess })
    return {
      ok: r.code === 0 && !r.timedOut,
      script,
      args,
      command,
      cwd: dir,
      exitCode: r.code,
      exitMeaning: exitMeaning(script, r.code),
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      stdout: tail(r.stdout, r.stdoutDropped ?? 0),
      stderr: tail(r.stderr, r.stderrDropped ?? 0),
    }
  } catch (e) {
    return {
      ok: false,
      error: `could not start ${command[0]}: ${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    inFlight.delete(script)
  }
}

/** `python --version` (or the equivalent probe spawn), reduced to a version string plus, on
 *  failure, the message that belongs in OrchestratorStatus.error. Split out of
 *  orchestratorStatus so its try/catch and its menu-probe sibling below don't nest. */
async function probePythonVersion(
  spawn: NonNullable<SpawnDeps['spawn']>,
  python: string,
  cwd: string,
): Promise<{ version: string | null; error: string | null }> {
  try {
    const v = await spawn([python, '--version'], cwd, 15_000)
    if (v.code !== 0)
      return {
        version: null,
        error: `${python} --version exited ${v.code}: ${`${v.stderr}${v.stdout}`.trim()}`,
      }
    return { version: `${v.stdout}${v.stderr}`.trim() || null, error: null }
  } catch (e) {
    return {
      version: null,
      error: `${python} is not runnable: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/** `python orch.py` with no arguments, i.e. the driver's own menu, reduced the same way. */
async function probeMenu(
  spawn: NonNullable<SpawnDeps['spawn']>,
  python: string,
  dir: string,
): Promise<{ menu: string | null; error: string | null }> {
  try {
    const m = await spawn([python, 'orch.py'], dir, 60_000)
    if (m.code !== 0)
      return { menu: null, error: `orch.py menu exited ${m.code}: ${m.stderr.trim()}` }
    return { menu: m.stdout.trim(), error: null }
  } catch (e) {
    return { menu: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** `python orch.py --catalog`, i.e. lib/actionlib.CATALOG as JSON (audit AH-25). Until this
 *  existed the only machine-readable view of the action list was the printed menu's prose, so
 *  every consumer - mcp.ts's orchestrator_menu among them - was a text parser over a layout
 *  nobody had promised to keep.
 *
 *  Its failure is deliberately NOT folded into OrchestratorStatus.error. The prose menu is the
 *  older surface and still the one a person reads; a driver too old to know `--catalog`, or a
 *  catalog that will not parse, is a missing convenience rather than an unhealthy toolbox, and
 *  reporting it as `error` would make a perfectly working install read as broken.
 *
 *  It is also NOT a dispatch allowlist, and must never become one. orch.py resolves a script name
 *  against the FILES under scripts/ on purpose (see `_scripts_on_disk` there), so a brand-new
 *  script is runnable the moment it lands, before anyone has written its catalog row -
 *  tests/test_actionlib.py is what catches a missing row, not a refusal to run. Gating runs on
 *  this list would turn that documented grace period into an outage. */
async function probeCatalog(
  spawn: NonNullable<SpawnDeps['spawn']>,
  python: string,
  dir: string,
): Promise<{ actions: Record<string, OrchestratorAction> | null; error: string | null }> {
  try {
    const c = await spawn([python, 'orch.py', '--catalog'], dir, 60_000)
    if (c.code !== 0)
      return {
        actions: null,
        error: `orch.py --catalog exited ${c.code}: ${`${c.stderr}${c.stdout}`.trim()}`,
      }
    let parsed: unknown
    try {
      parsed = JSON.parse(c.stdout)
    } catch (e) {
      return {
        actions: null,
        error: `orch.py --catalog did not print JSON: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    // An array or a bare string parses fine and would then read as a catalog with no rows, which
    // is the one answer this field must never give by accident.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { actions: null, error: 'orch.py --catalog printed JSON that is not an object' }
    return { actions: parsed as Record<string, OrchestratorAction>, error: null }
  } catch (e) {
    return { actions: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Is the toolbox there and does python answer - and if so, the menu and the action catalog.
 *  Read-only. */
export async function orchestratorStatus(
  deps: SpawnDeps & { dir?: string; python?: string } = {},
): Promise<OrchestratorStatus> {
  const dir = deps.dir ?? orchestratorDir()
  const python = deps.python ?? pythonBinary()
  const present = existsSync(join(dir, 'orch.py'))
  const spawn = deps.spawn ?? realSpawn
  let error: string | null = present ? null : `no orch.py under ${dir}`
  const { version: pythonVersion, error: versionError } = await probePythonVersion(
    spawn,
    python,
    present ? dir : APP_ROOT,
  )
  error = error ?? versionError
  let menu: string | null = null
  let actions: Record<string, OrchestratorAction> | null = null
  // Never left as a bare null: a status read that could not look must say so, or "not read" and
  // "read, and there is nothing" become the same answer.
  let actionsError: string | null = error ?? 'the toolbox was not read'
  if (present && pythonVersion) {
    // Two spawns of the same driver with nothing between them, so a status read costs one round
    // trip rather than two sequential 60s ceilings.
    const [m, c] = await Promise.all([
      probeMenu(spawn, python, dir),
      probeCatalog(spawn, python, dir),
    ])
    menu = m.menu
    error = error ?? m.error
    actions = c.actions
    actionsError = c.error
  }
  return { dir, present, python, pythonVersion, menu, actions, actionsError, error }
}
