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
/** Output kept per stream. The dry loop over a full fleet is a few thousand lines; a runaway is
 *  truncated from the FRONT so the verdict lines at the end survive. */
const MAX_OUTPUT_CHARS = 200_000

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

export interface OrchestratorStatus {
  dir: string
  present: boolean
  python: string
  pythonVersion: string | null
  /** The driver's own menu (`python orch.py` with no arguments), when the tree is present and
   *  python answers - the one place every script and what it does is listed. */
  menu: string | null
  error: string | null
}

/** Bounded and newline-normalised: python on Windows emits CRLF into a pipe, and an agent reading
 *  the verdict lines should not have to strip carriage returns first. */
function tail(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n')
  return text.length > MAX_OUTPUT_CHARS
    ? `…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]\n${text.slice(-MAX_OUTPUT_CHARS)}`
    : text
}

/** One spawn, captured, with a deadline. Exposed for tests through `deps`; the real thing is
 *  Bun.spawn with windowsHide (python is a console program - see scripts/checks/spawn-console-window.mjs). */
export interface SpawnDeps {
  spawn?: (
    command: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>
}

/** Kill the WHOLE tree, not just python. An acting script blocks on its actuator (a powershell
 *  driving a window, `subprocess.run` in migrate_chat / chips / courier); killing only the
 *  interpreter would leave that actuator running unsupervised while the caller reads "timed
 *  out". The toolbox itself uses `taskkill /T /F` for the same reason (lib/enginelib.py). */
function killTree(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
    } else {
      proc.kill()
    }
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

async function realSpawn(command: string[], cwd: string, timeoutMs: number) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    windowsHide: true,
    env: orchestratorChildEnv(),
  })
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    killTree(proc)
  }, timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, stdout, stderr, timedOut }
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
    const r = await spawn(command, dir, timeoutMs)
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
      stdout: tail(r.stdout),
      stderr: tail(r.stderr),
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

/** Is the toolbox there and does python answer - and if so, the menu. Read-only. */
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
  if (present && pythonVersion) {
    const { menu: m, error: menuError } = await probeMenu(spawn, python, dir)
    menu = m
    error = error ?? menuError
  }
  return { dir, present, python, pythonVersion, menu, error }
}
