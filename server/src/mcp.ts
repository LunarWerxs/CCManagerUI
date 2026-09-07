// AgentHydra MCP server (stdio) — a thin client over the running daemon's REST API, so an
// MCP-speaking agent (Claude Desktop/Code, Cursor) shares one source of truth with the web UI.
// Start the daemon first (`bun run start` from repo root); point elsewhere with
// AGENTHYDRA_URL / AGENTHYDRA_PORT.
//
// The JSON-RPC 2.0 / MCP protocol + the stdio loop live in the SHARED, zero-dependency engine
// `./mcp-stdio.mjs` (part of the shared kit — edit it there, never here). This file is only the
// app-specific part: an HTTP client + a tool table, each tool a thin proxy over an existing
// /api/* route from index.ts. Beyond the sessions/queue/accounts/scheduler/instances/update tools,
// this also exposes the usage-check subsystem (check_usage / check_my_usage — any agent can read
// its own remaining quota; the weekly all-models % is the binding cap), CLI instances, and the
// auto-resume monitor.
//
// INSTANCE NUMBERS. Everything here that addresses one instance takes an `instance` argument, and
// that argument accepts the instance's permanent NUMBER (`7`, `#7`). That is the identifier a human
// can say out loud and write into a prompt — the alternatives an instance carries are a Windows
// folder path and a random uuid, neither of which survives being spoken. Start at
// list_instance_numbers (the whole fleet, one number each, across Claude Desktop + Claude CLI +
// Codex), resolve_instance (confirm which account a reference means before spending its quota) and
// whoami (which numbered instance THIS process is). The legacy `dir` / `id` parameters all still
// work exactly as before; the number is purely additive.
//
// SELF-IDENTIFICATION runs HERE, not on the daemon — see the block above `detectSelf` and
// core/self-identity.ts. `whoami`, `check_my_usage` and a bare `usage_budget` all share it, so an
// agent can answer "whose quota am I spending?" without being told, including from a Claude
// Desktop session, which sets no CLAUDE_CONFIG_DIR at all.
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appEnv, IS_COMPILED, PORT, VERSION } from './config'
import type { SelfIdentityDetection } from './core/self-identity'
import { readInstanceInfo } from './instance'
import type { McpEngineTool } from './mcp-stdio.mjs'
import { runMcpStdio } from './mcp-stdio.mjs'
import type { UsageAdvice, UsageSnapshot } from './types'

// Resolve the base URL per call: an explicit AGENTHYDRA_URL/AGENTHYDRA_PORT always wins, else
// follow the port the daemon ACTUALLY bound (~/.agenthydra/runtime.json), so an auto-hopped port
// still works, else fall back to the static configured default.
export function daemonBase(): string {
  const url = appEnv('URL')
  if (url) return url
  const port = appEnv('PORT')
  if (port) return `http://127.0.0.1:${port}`
  return readInstanceInfo()?.url ?? `http://127.0.0.1:${PORT}`
}

/** The daemon isn't listening. Distinct from a real API error, so a fallback can fire on THIS and
 *  only this — a 500 from a running daemon must still surface as a failure, not be silently retried
 *  in-process against different code. */
class DaemonUnreachable extends Error {}

/** How to START the daemon, phrased for THIS distribution: a packaged build has no Bun, so telling
 *  its user to `bun run start` is a dead end — point them at the executable / tray instead. */
const startHint = IS_COMPILED
  ? 'Start it by running the AgentHydra executable (or its tray shortcut).'
  : 'Start it with `bun run start`.'

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${daemonBase()}${pathname}`, init)
  } catch (e) {
    throw new DaemonUnreachable(
      `couldn't reach the AgentHydra daemon at ${daemonBase()}. ${startHint} (${e instanceof Error ? e.message : String(e)})`,
    )
  }
  if (!res.ok) throw new Error(`AgentHydra ${res.status}: ${await res.text()}`)
  return res.json()
}

/**
 * Run a tool against the daemon, and if the daemon simply isn't running, do the work IN-PROCESS.
 *
 * WHY only some tools get this: the usage tools need nothing the daemon uniquely owns. The OAuth
 * tokens are files on disk, the quota endpoint is a plain HTTPS GET, and the transcripts are local
 * JSONL. So an agent can answer "how much quota do I have left?" with the app closed. The queue and
 * dispatch tools are the opposite: they mutate shared sqlite state and supervise real processes, so
 * a second, uncoordinated executor would be a correctness bug. Those keep failing loudly.
 *
 * The imports inside each fallback are DYNAMIC on purpose: they pull in bun:sqlite, and loading that
 * eagerly would open the database on every MCP start, including the (normal) case where the daemon
 * owns it and we never touch it.
 */
async function apiOrLocal(pathname: string, local: () => Promise<unknown>): Promise<unknown> {
  try {
    return await api(pathname)
  } catch (e) {
    if (e instanceof DaemonUnreachable) return await local()
    throw e
  }
}

// JSON Schema helper (the engine advertises each tool's `inputSchema` verbatim in tools/list).
const S = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
})
const JSON_HEADERS = { 'content-type': 'application/json' }
const str = (v: unknown): string => String(v ?? '')
const qs = (params: Record<string, unknown>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** The `instance` parameter, described once and reused by every tool that takes one — so the same
 *  sentence appears everywhere and there is no tool where a number quietly isn't accepted. */
const INSTANCE_PARAM = {
  type: ['string', 'number'],
  description:
    "Which instance: its permanent NUMBER (7 or '#7' — see list_instance_numbers), or its dir/id, or an unambiguous name. The number is the reliable one; names are user-editable and can collide.",
} as const

/** One row of the numbered fleet, as `/api/instance-numbers` returns it. */
interface ResolvedInstanceRow {
  num: number
  kind: 'desktop' | 'cli' | 'codex'
  handle: string
  ref: string
  name: string
  email: string | null
  plan: string | null
  /** Rate-limit tier — `Pro` / `Max 5×` / `Max 20×`. What the quota IS, as opposed to `plan`,
   *  which is what the subscription is called. The two disagree on org seats. */
  tier: string | null
  configDir: string
  loggedIn: boolean
  isRunning: boolean | null
}

// --- self-identification ------------------------------------------------------
//
// This is the part that has to run HERE, in the MCP server process, and not on the daemon: the
// whole method is reading this process's own environment and walking up to the `claude.exe` that
// spawned it. See core/self-identity.ts for what it looks at and why each signal is needed. The
// daemon is only asked the cheap, stateless question afterwards ("which instance owns this dir?").

/** The detection half is memoized: which instance a process belongs to CANNOT change while that
 *  process lives, and the ancestry fallback costs a PowerShell spawn. The dir→instance lookup is
 *  deliberately NOT cached — the fleet's account/plan data can change under us, and it is one
 *  loopback request. */
let selfDetectionCache: Promise<SelfIdentityDetection> | null = null

async function detectSelf(fresh = false): Promise<SelfIdentityDetection> {
  if (fresh || !selfDetectionCache) {
    selfDetectionCache = (async () => {
      const { detectSelfIdentity } = await import('./core/self-identity')
      return detectSelfIdentity()
    })()
  }
  try {
    return await selfDetectionCache
  } catch (e) {
    selfDetectionCache = null // a failed probe must not be remembered as the answer
    throw e
  }
}

/** Identity as the tools report it: the instance (when it is a managed one), the evidence, and an
 *  explicit warning whenever the answer is anything less than proven. */
interface SelfIdentityPayload {
  instance: ResolvedInstanceRow | null
  configDir: string | null
  kind: SelfIdentityDetection['kind']
  method: SelfIdentityDetection['method']
  confidence: SelfIdentityDetection['confidence']
  clues: SelfIdentityDetection['clues']
  ruledOut: string[]
  summary: string
  /** Present ONLY when the identification is uncertain or contradictory. Its absence is the
   *  signal that the number below can be quoted without a hedge. */
  warning?: string
}

async function selfIdentity(fresh = false): Promise<SelfIdentityPayload> {
  const { describeSelfIdentity } = await import('./core/self-identity')
  const detection = await detectSelf(fresh)

  let instance: ResolvedInstanceRow | null = null
  if (detection.configDir) {
    // A failed identity lookup may only ever cost the LABEL, never the detection — so this is
    // swallowed rather than thrown. The dir is still correct and still usable for a usage read.
    try {
      instance = (await apiOrLocal(
        `/api/instance-numbers/whoami${qs({ configDir: detection.configDir })}`,
        async () => {
          const { instanceForConfigDir } = await import('./core/instance-ref')
          return await instanceForConfigDir(detection.configDir as string)
        },
      )) as ResolvedInstanceRow | null
    } catch {
      instance = null
    }
  }

  const warnings: string[] = []
  if (detection.conflict) {
    warnings.push(
      'CONFLICT: two independent signals named different credential directories. The highest-priority one was used; do not spend quota on this identification without confirming it with the human.',
    )
  }
  if (detection.disambiguated) {
    warnings.push(
      `DISAMBIGUATED: ${detection.disambiguated}. The numbers are for the instance that rule chose; if a human names a different instance, theirs wins.`,
    )
  }
  if (detection.confidence === 'assumed') {
    warnings.push(
      'ASSUMED, not proven: no instance signal matched, so this fell back to the default ~/.claude login by elimination. If a human told you an instance number, THEIRS IS THE AUTHORITATIVE ANSWER — believe it over this.',
    )
  }
  if (detection.confidence === 'none') {
    warnings.push(
      'UNIDENTIFIED: this process does not look like it is running under Claude Code at all. Treat any quota reading as unattributed.',
    )
  }
  if (!instance && detection.confidence === 'exact' && detection.kind === 'desktop') {
    warnings.push(
      `This is a Claude Desktop user-data dir that AgentHydra does not manage (${detection.configDir}), so it has no instance number. Its quota can still be read.`,
    )
  }

  return {
    instance,
    configDir: detection.configDir,
    kind: detection.kind,
    method: detection.method,
    confidence: detection.confidence,
    clues: detection.clues,
    ruledOut: detection.ruledOut,
    summary: describeSelfIdentity(detection, instance),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  }
}

/** Enough of an instance row to name it in a sentence. Both the fleet rows and the slimmer
 *  `instance` echo that `/api/usage` attaches satisfy this. */
type NameableInstance = {
  num?: number
  name?: string
  plan?: string | null
  tier?: string | null
} | null

/** `instance #12 (Joel · Max 20×)` — the phrase an agent should use instead of a bare percentage.
 *  Prefers `tier` over `plan`: the tier is what the quota IS. */
function instanceLabel(i: NameableInstance): string | null {
  if (!i?.num) return null
  const what = i.tier ?? i.plan ?? null
  return `instance #${i.num}${i.name ? ` (${i.name}${what ? ` · ${what}` : ''})` : what ? ` (${what})` : ''}`
}

/**
 * Attach the one-line `nextStep` instruction to a usage result.
 *
 * Every usage tool goes through here so the guidance is identical wherever it appears, and so a
 * response that reached us without an `advice` block (an older daemon, a cached row) still gets
 * one derived from its own snapshot rather than silently losing the instruction.
 */
async function withNextStep(result: unknown, self?: SelfIdentityPayload | null): Promise<unknown> {
  if (result === null || typeof result !== 'object') return result
  const r = result as Record<string, unknown>
  const { nextStep, usageAdvice } = await import('./usage')
  const advice =
    (r.advice as UsageAdvice | undefined) ??
    (r.snapshot ? usageAdvice(r.snapshot as UsageSnapshot) : null)
  if (!advice) return result
  return {
    ...r,
    advice,
    nextStep: nextStep(advice, {
      // `self` is only passed when the target was worked out rather than named by the caller —
      // a caller who passed `instance: 7` has no attribution problem to warn about.
      identityUncertain: self ? self.confidence !== 'exact' || !!self.warning : false,
      instanceLabel: instanceLabel((r.instance as NameableInstance) ?? self?.instance ?? null),
    }),
  }
}

/** Daemon-offline usage read for one identified instance, mirroring `/api/usage?instance=N`'s
 *  routing. Codex is the one family that cannot be answered here (its quota is an OpenAI API call
 *  the offline path deliberately does not make), so it says so instead of returning a silent null. */
async function localUsageForInstance(row: ResolvedInstanceRow): Promise<unknown> {
  const { usageAdvice, parseUsageOutput } = await import('./usage')
  if (row.kind === 'codex') {
    const snapshot = parseUsageOutput('', row.name)
    return {
      snapshot,
      cached: false,
      key: row.ref,
      reason: 'check_failed',
      advice: usageAdvice(snapshot),
      daemon: `offline (answered locally) — instance #${row.num} is a Codex instance, whose quota comes from the OpenAI API; start AgentHydra and retry.`,
    }
  }
  const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
  const result =
    row.kind === 'desktop'
      ? await checkUsageForDesktop(row.handle)
      : await checkUsageForCliInstance(row.handle)
  if (!result) {
    const snapshot = parseUsageOutput('', row.name)
    return {
      snapshot,
      cached: false,
      key: row.ref,
      reason: 'check_failed',
      advice: usageAdvice(snapshot),
      daemon: 'offline (answered locally)',
    }
  }
  return {
    ...result,
    advice: result.advice ?? usageAdvice(result.snapshot),
    daemon: 'offline (answered locally)',
  }
}

/** Usage for a Claude DESKTOP user-data dir that is not a numbered instance. Always answered
 *  in-process: the desktop credential is Electron safeStorage, which the `configDir` REST route
 *  (a CLI `.credentials.json` reader) cannot open. */
async function localUsageForDesktopDir(dir: string): Promise<unknown> {
  const { checkUsageForDesktop } = await import('./usage-service')
  const { usageAdvice } = await import('./usage')
  const result = await checkUsageForDesktop(dir)
  return { ...result, advice: result.advice ?? usageAdvice(result.snapshot) }
}

/** Daemon-offline usage read for a bare CLI credential dir — the plain `~/.claude` login, or an
 *  explicit CLAUDE_CONFIG_DIR. */
async function localUsageForConfigDir(configDir: string): Promise<unknown> {
  const { checkUsage, usageAdvice, isNoData } = await import('./usage')
  const snapshot = await checkUsage({ configDir, account: configDir })
  return {
    snapshot,
    cached: false,
    key: `dir:${configDir}`,
    reason: isNoData(snapshot) ? 'check_failed' : 'ok',
    advice: usageAdvice(snapshot),
    daemon: 'offline (answered locally)',
  }
}

/** Resolve an `instance` argument to one real instance, or throw with the daemon's own reason
 *  (which distinguishes "no such number" from "that number's instance was deleted"). */
async function resolveRef(ref: unknown): Promise<ResolvedInstanceRow> {
  return (await api(`/api/instance-numbers/resolve${qs({ ref: str(ref) })}`)) as ResolvedInstanceRow
}

/**
 * The dir/id to act on: from `instance` (any spelling, resolved) or from the explicit legacy
 * param, whichever was supplied. Keeping BOTH is deliberate — every existing caller that already
 * passes a dir or id keeps working untouched, and the number is purely an addition.
 */
async function handleFrom(
  explicit: unknown,
  instance: unknown,
  legacyName: string,
): Promise<string> {
  if (instance != null && str(instance).trim()) return (await resolveRef(instance)).handle
  const direct = str(explicit).trim()
  if (direct) return direct
  throw new Error(`pass \`instance\` (its number, e.g. 7) or \`${legacyName}\``)
}

/**
 * Normalize a queue item's `instance_ref` so a plain number works there too.
 *
 * The queue stores `desktop:<dir>` / `cli:<id>` and the dispatcher parses exactly those two
 * prefixes (dispatch.ts), so a number has to be expanded BEFORE the item is written — a run pinned
 * to "#7" that failed to resolve at dispatch time would fail long after the human walked away.
 * Anything already in ref form passes through untouched. The dir is taken from `handle`, not from
 * the registry key, because dispatch existsSync()s it.
 */
async function normalizeInstanceRef(value: unknown): Promise<unknown> {
  if (value == null) return value
  const raw = str(value).trim()
  if (!raw || raw.startsWith('desktop:') || raw.startsWith('cli:')) return value
  const hit = await resolveRef(raw)
  if (hit.kind === 'codex')
    throw new Error(
      `instance #${hit.num} is a Codex instance; the queue runs Claude sessions, so it cannot be pinned to one. Pick a Claude Desktop or Claude CLI instance.`,
    )
  return `${hit.kind}:${hit.handle}`
}

/** The orchestrator's arg limit is 4000 characters; a seven-task spec with real prompts can pass
 *  it. Under the limit the spec travels inline (visible in the returned `command`); over it, it is
 *  written to a temp file the script reads (fan_out.py accepts either). */
const SPEC_INLINE_MAX = 3800
function specArg(spec: string): string {
  if (spec.length <= SPEC_INLINE_MAX) return spec
  const path = join(tmpdir(), `agenthydra-fanout-${randomUUID()}.json`)
  writeFileSync(path, spec, 'utf8')
  return path
}

/** What fan_out.py's own exit codes mean (its docstring is the source). */
const FAN_OUT_VERDICTS: Readonly<Record<number, string>> = Object.freeze({
  0: 'ok: every member spawned and confirmed / read / delivered / deleted and verified',
  4: 'partial: some members not confirmed, refused, unassigned, or not delivered - read each member',
  2: 'nothing happened: no account with room, every spawn refused, or nothing to deliver to',
  3: 'refused: bad spec, unknown group, or bad usage',
  1: 'daemon failure',
})

/** Run one fan_out.py invocation through the daemon and hand back its JSON report with the exit
 *  code translated. No JSON on stdout means the script never reached its own report (python
 *  missing, usage error), so the raw run comes back with ok:false rather than a bare failure. */
/** Resolve a move's `to` into the argv migrate_chat wants, plus the note a caller reports.
 *  Shared by move_chat and move_chats so a batch can never resolve a DIFFERENT target than a
 *  single move would for the same input - the two disagreeing about what "here" means is how a
 *  batch would quietly land 13 chats on the wrong account. */
async function resolveMoveTarget(
  to: unknown,
): Promise<{ toRef: string; targetNote: string | undefined }> {
  const toArg = to == null || str(to).trim() === '' ? 'here' : str(to).trim()
  if (toArg.toLowerCase() === 'here') {
    // "here" bills THIS process's account, so it is accepted only on a proven identity: an
    // assumed or disambiguated answer would make the wrong account the destination.
    const self = await selfIdentity()
    if (!self.instance || self.confidence !== 'exact' || self.warning)
      throw new Error(
        `cannot resolve "here" with certainty (${self.summary}${self.warning ? ` — ${self.warning}` : ''}). Pass \`to\` as the target's instance number (list_instance_numbers).`,
      )
    if (self.instance.kind !== 'desktop')
      throw new Error(
        `"here" is ${instanceLabel(self.instance)}, a ${self.instance.kind} instance; a chat can only land in a Claude DESKTOP instance — pass \`to\` explicitly.`,
      )
    return {
      toRef: String(self.instance.num),
      targetNote: `here = ${instanceLabel(self.instance)}`,
    }
  }
  if (toArg.toLowerCase() === 'best') return { toRef: 'best', targetNote: undefined } // the orchestrator ranks the fleet itself
  const row = await resolveRef(toArg)
  if (row.kind !== 'desktop')
    throw new Error(
      `${instanceLabel(row)} is a ${row.kind} instance; a chat can only land in a Claude DESKTOP instance.`,
    )
  return { toRef: String(row.num), targetNote: `to = ${instanceLabel(row)}` }
}

async function runFanOut(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const run = (await api('/api/orchestrator/run', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ script: 'fan_out', args, timeoutMs }),
  })) as Record<string, unknown>
  let payload: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(str(run.stdout))
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
  } catch {
    payload = null
  }
  const code = typeof run.exitCode === 'number' ? run.exitCode : null
  const verdict = code == null ? 'no exit code' : (FAN_OUT_VERDICTS[code] ?? `exit ${code}`)
  if (!payload) return { ...run, ok: false, args, verdict }
  return {
    ok: code === 0,
    ...payload,
    exitCode: code,
    verdict,
    ...(str(run.stderr).trim() ? { stderr: run.stderr } : {}),
  }
}

export const TOOLS: McpEngineTool[] = [
  // --- sessions (read-only) ---------------------------------------------------
  {
    name: 'list_sessions',
    description:
      // THE DEFAULT WINDOW IS NAMED IN THE FIRST SENTENCE, and that is the whole reason this
      // description was rewritten. The route defaults to period=24h, this tool had no period
      // parameter at all, and so an agent asked to go through "all my chat histories" got one day
      // of them and no indication that anything had been withheld — a silent wrong answer, which
      // is the worst kind an API can give. Say the default, and give it the knob to change it.
      'List local Claude, Codex, OpenCode and other local-agent sessions, most recently active ' +
      'first. DEFAULTS TO THE LAST 24 HOURS: pass period="all" (or an explicit since/until) or you ' +
      'are seeing one day of a store that may hold years. Each row carries its source and a ' +
      '`dispatched` flag: true means AgentHydra queued that work, false means a person drove it by ' +
      'hand. That is known exactly (every dispatch names the session id on the command line), not ' +
      'guessed at. Rows also carry `limit_stop` (non-null when the session hit a usage/quota wall — ' +
      'see list_rate_limited_sessions) and `title_source`/`title_tag`, which say where the row got ' +
      'its title from. Start at list_projects to learn what folders exist, then scope with project= ' +
      'and page with offset= rather than raising limit.',
    inputSchema: S({
      limit: { type: 'number', description: 'Max sessions to return (default 200, max 500).' },
      offset: {
        type: 'number',
        description:
          'Skip this many rows first — the paging cursor. Pages are contiguous: offset=500 with ' +
          'limit=500 is exactly page 2 of the same ordering.',
      },
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description:
          'How far back to reach, by last activity. DEFAULT "24h". Use "all" for the whole store.',
      },
      since: {
        type: 'string',
        description:
          'Lower bound on last activity — epoch milliseconds or an ISO date ("2026-08-01"). ' +
          'Overrides period when both are given.',
      },
      until: {
        type: 'string',
        description:
          'Upper bound on last activity, same formats. With since, this is an arbitrary date range.',
      },
      project: {
        type: 'string',
        description:
          'Case-insensitive substring of the working directory or project key, e.g. "agenthydra". ' +
          'Use list_projects to see what is available.',
      },
      source: {
        type: 'string',
        enum: ['claude', 'codex', 'opencode', 'hermes', 'foreign'],
        description:
          'Optional provider filter. "foreign" is the shared reader for the other local agents ' +
          '(Cursor, Windsurf, Zed, Copilot CLI and the rest) — omit it to get every store at once.',
      },
      instance: {
        type: 'string',
        description:
          'Scope to one Claude Desktop instance by its DIRECTORY NAME (list_instances -> name), ' +
          "'default' for the non-isolated install, or 'other' for plain CLI sessions. Claude only.",
      },
      archived: {
        type: 'string',
        enum: ['hide', 'include', 'only'],
        description:
          'Provider archive state. Default "hide" — archived is the majority of a real store, so ' +
          'including it buries live work. Pass "include" when the question is genuinely historical.',
      },
      dispatched: {
        type: 'string',
        enum: ['all', 'queued', 'manual'],
        description: 'Narrow to work AgentHydra queued, or to work driven by hand. Default all.',
      },
      rateLimited: {
        type: 'string',
        enum: ['all', 'only', 'pending'],
        description:
          'Narrow to sessions that hit a usage/quota wall ("only"), or to the ones still stopped ' +
          'at one right now ("pending"). Default all.',
      },
    }),
    run: (a) =>
      api(
        `/api/sessions${qs({
          limit: a.limit,
          offset: a.offset,
          period: a.period,
          since: a.since,
          until: a.until,
          project: a.project,
          source: a.source,
          instance: a.instance,
          archived: a.archived,
          dispatched: a.dispatched,
          ratelimited: a.rateLimited,
        })}`,
      ),
  },
  {
    name: 'list_projects',
    description:
      'Every folder that has local agent conversations in it, newest activity first, with a ' +
      'session count and a per-provider breakdown. This is the index of the index: the session ' +
      'list only ever answers newest-N, so this is how you find out what "all my chat histories" ' +
      'actually contains before querying it. Cheap — it reads the transcript index, never a ' +
      'transcript. Feed a `cwd` back in as list_sessions(project=…).',
    inputSchema: S({}),
    run: () => api('/api/sessions/projects'),
  },
  {
    name: 'list_rate_limited_sessions',
    description:
      'Conversations that were cut off by a usage/quota wall — "You\'ve hit your weekly limit · ' +
      'resets 3am" — newest first. `pending: true` on a row means nothing followed the notice, so ' +
      'that session is STILL stopped there and is the actionable half; pending:false means it was ' +
      "resumed later and is history. Detection trusts only the CLI's own error report, never model " +
      'prose or tool output, so a session that merely discussed rate limits is not listed. Claude ' +
      'sessions only: Codex and OpenCode record an error, but not in a form worth trusting, and a ' +
      'false claim here would be worse than a missing one. Defaults to the WHOLE store, not 24h, ' +
      'because this question is almost always historical.',
    inputSchema: S({
      limit: { type: 'number', description: 'Max sessions to return (default 200, max 500).' },
      pendingOnly: {
        type: 'boolean',
        description:
          'Only sessions still sitting at the wall right now. Default false (all of them).',
      },
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description: 'How far back to reach. DEFAULT "all" for this tool.',
      },
      project: { type: 'string', description: 'Case-insensitive cwd/project substring filter.' },
    }),
    run: (a) =>
      api(
        `/api/sessions${qs({
          limit: a.limit,
          period: a.period ?? 'all',
          project: a.project,
          archived: 'include',
          ratelimited: a.pendingOnly ? 'pending' : 'only',
        })}`,
      ),
  },
  {
    name: 'get_session',
    description: 'Get one session by id (full summary).',
    inputSchema: S(
      {
        id: { type: 'string' },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'hermes', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) => api(`/api/sessions/${encodeURIComponent(str(a.id))}${qs({ source: a.source })}`),
  },
  {
    name: 'search_sessions',
    description:
      // The completeness caveat is the load-bearing sentence. An agent that reads an empty result
      // as "this text is nowhere on the machine" will confidently rebuild work that already exists,
      // so the flag that says otherwise is named in the description, not just in the payload.
      'Search the CONTENT of local transcripts (Claude, Codex, OpenCode) for text, or for a regular expression with regex=true. Returns matching sessions newest-active first, each with a match count and snippets. READ THE `searched` FIELD ON THE RESULT. "index" means it came from the conversation index: instant and complete over what was SAID (human and assistant turns, matched by whole words and phrases), but it does NOT cover tool output such as file reads and command output, and does not match text inside a word — re-run with everything=true when a miss would matter. "scan" means it streamed the transcripts under a wall-clock budget; check budgetExhausted, because when that is true the search gave up early and finding nothing proves nothing. limitReached means the hit list was capped, not that time ran out. Use list_sessions when you already know which session you want; use this to find one by something said inside it.',
    inputSchema: S(
      {
        query: { type: 'string', description: 'Text to find, or a regex pattern if regex=true.' },
        regex: {
          type: 'boolean',
          description:
            'Treat query as a regular expression. Structurally unsafe patterns are rejected rather than risking a hang.',
        },
        caseSensitive: { type: 'boolean', description: 'Match case exactly (default false).' },
        source: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode', 'hermes', 'foreign'],
          description:
            "Optional provider filter. 'foreign' is the shared reader for the other local agents " +
            '(Cursor, Windsurf, Zed, Copilot CLI and the rest); omit it to search every store.',
        },
        instance: {
          type: 'string',
          description:
            "Scope to one Claude Desktop instance by its DIRECTORY NAME (list_instances -> name), or 'default' for the non-isolated install, or 'other' for plain CLI sessions. This one does NOT take an instance number.",
        },
        limit: { type: 'number', description: 'Max sessions to return (default 50, max 200).' },
        everything: {
          type: 'boolean',
          description:
            'Search every byte of every transcript, tool output included, instead of the fast conversation index. Slower (tens of seconds) and bounded by a time budget, but it is the only way to match text that appears inside a tool result or in the middle of a word. Use it when a normal search found nothing and you need to be sure.',
        },
      },
      ['query'],
    ),
    run: (a) =>
      api(
        `/api/sessions/search${qs({
          q: str(a.query),
          regex: a.regex ? '1' : undefined,
          case: a.caseSensitive ? '1' : undefined,
          source: a.source,
          instance: a.instance,
          limit: a.limit,
          everything: a.everything ? '1' : undefined,
        })}`,
      ),
  },
  {
    name: 'chat_rename',
    description:
      "RENAME a chat through the running app's own control - the one write that sticks while an " +
      'app is open (an app holds its chat list in memory and re-saves over any file edit). Use ' +
      'it on a chat the app renders as Untitled: an imported chat shows that way whatever its ' +
      'disk title says, which both breaks the naming law and makes it UNDELIVERABLE, because ' +
      'the courier aims by rendered name and reports those rows as no-title. Give it a real ' +
      'name that says what the work is; generic names are refused. If the row on screen reads ' +
      'differently from what the system thinks, pass current_title to name the visible row.',
    inputSchema: S(
      {
        session_id: { type: 'string', description: 'The chat/session id to rename.' },
        new_title: { type: 'string', description: 'The new name. Generic names are refused.' },
        current_title: {
          type: 'string',
          description: "The row's CURRENT on-screen name, when it differs from the stored title.",
        },
      },
      ['session_id', 'new_title'],
    ),
    run: (a) =>
      api(`/api/chats/${encodeURIComponent(str(a.session_id))}/rename`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ new_title: a.new_title, current_title: a.current_title }),
      }),
  },
  {
    name: 'chat_dossier',
    description:
      'ONE query, everything the system knows about a chat: which desktop instance holds it, its ' +
      'archive flag as it sits on disk RIGHT NOW, its lineage ids across auto-compact rolls, its ' +
      'done-mark, and the live process hosting it (if any). Use this FIRST for any "what ' +
      'happened to chat X / is it alive / who archived it" question — it replaces hand-joining ' +
      'the metadata stores, the marks table and the live registry. Query by a title fragment or ' +
      'by ANY session/chat id, current or prior.',
    inputSchema: S(
      { q: { type: 'string', description: 'Title fragment or any session/chat id (substring).' } },
      ['q'],
    ),
    run: (a) => api(`/api/chats/dossier${qs({ q: str(a.q) })}`),
  },
  {
    name: 'tail_session',
    description:
      'Tail a session transcript: the most recent turns. `limit` is applied AFTER the filters, so ' +
      'humanOnly=true gives you the last N things a PERSON said rather than N mixed turns — that is ' +
      'the cheapest way to find out what a long session was actually asked to do. Reasoning blocks ' +
      'are omitted unless thinking=true.',
    inputSchema: S(
      {
        id: { type: 'string' },
        limit: { type: 'number', description: 'Max turns to return (default 40).' },
        textOnly: { type: 'boolean', description: 'Drop tool_use/tool_result turns, text only.' },
        thinking: { type: 'boolean', description: "Include the model's reasoning blocks." },
        humanOnly: {
          type: 'boolean',
          description: 'Only the user turns. Overrides textOnly. Use this to skim a long session.',
        },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'hermes', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(
        `/api/sessions/${encodeURIComponent(str(a.id))}/tail${qs({
          limit: a.limit,
          textOnly: a.textOnly ? '1' : undefined,
          thinking: a.thinking ? '1' : undefined,
          humanOnly: a.humanOnly ? '1' : undefined,
          source: a.source,
        })}`,
      ),
  },

  {
    name: 'export_session',
    description:
      'Render a WHOLE session as readable Markdown (or self-contained HTML), not the tail window. ' +
      'Secrets in recognisable formats are replaced before the text is returned. Use this to hand a ' +
      'session to a person, or to read one end to end; use tail_session when the recent turns are ' +
      'enough, because a long session exported in full is very large.',
    inputSchema: S(
      {
        id: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'html'], description: 'Default markdown.' },
        thinking: { type: 'boolean', description: "Include the model's reasoning blocks." },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'hermes', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(
        `/api/sessions/${encodeURIComponent(str(a.id))}/export${qs({
          format: a.format,
          thinking: a.thinking ? '1' : undefined,
          source: a.source,
        })}`,
      ),
  },
  {
    name: 'scan_session_secrets',
    description:
      'Count the credentials a session printed into its transcript, with a REDACTED list of what ' +
      'and where. Never returns a secret, by design. Matches unmistakable formats only (private ' +
      'keys, AWS key ids, provider tokens): a count of zero means none of those were found, not ' +
      'that the session is clean.',
    inputSchema: S(
      {
        id: { type: 'string' },
        source: { type: 'string', enum: ['claude', 'codex', 'opencode', 'hermes', 'foreign'] },
      },
      ['id'],
    ),
    run: (a) =>
      api(`/api/sessions/${encodeURIComponent(str(a.id))}/secrets${qs({ source: a.source })}`),
  },

  // --- analytics ----------------------------------------------------------------
  {
    name: 'get_spend',
    description:
      'Token and dollar totals across sessions, broken down by model, project, day and dispatching ' +
      'account. Read `coverage`: the totals come from a background scan, so sessions/total tells ' +
      'you how much of the store it has reached, and a chart drawn from a half-warmed store is not ' +
      'wrong so much as partial. Costs use published list prices; a subscription plan is not billed ' +
      'per token. `unpricedModels` means those tokens counted but their money did not, so the ' +
      'total is a floor.',
    inputSchema: S({
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d', 'all'],
        description: 'How far back to total. Default 30d.',
      },
    }),
    run: (a) => api(`/api/analytics/spend${qs({ period: a.period })}`),
  },
  {
    name: 'get_activity',
    description:
      'When work happens and what it uses: an hour-of-week histogram, the tool mix, total ' +
      'agent-minutes (engaged time, not wall clock), and the sessions whose health signals stand ' +
      'out (long tool-failure streaks, heavy edit churn, repeated compaction).',
    inputSchema: S({
      period: { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Default 30d.' },
    }),
    run: (a) => api(`/api/analytics/activity${qs({ period: a.period })}`),
  },
  {
    name: 'get_recent_edits',
    description:
      'Files changed across recent sessions, newest first, each with the session and the turn that ' +
      'changed it so you can open the transcript at that point. Paths only, never diffs.',
    inputSchema: S({ limit: { type: 'number', description: 'Max entries (default 200).' } }),
    run: (a) => api(`/api/analytics/edits${qs({ limit: a.limit })}`),
  },
  {
    name: 'get_run_cost',
    description:
      'What ONE queued run cost, computed from the transcript turns inside that run’s own start ' +
      'and finish instants. Nothing is stored, so this can never disagree with the session total. ' +
      'AgentsView cannot answer this at all: it did not dispatch the work and so cannot tell which ' +
      'turns belong to which run.',
    inputSchema: S({ id: { type: 'string', description: 'Queue item id.' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/cost`),
  },

  // --- queue --------------------------------------------------------------------
  {
    name: 'list_queue',
    description:
      // rate_limited vs overloaded is the distinction an agent reading this most needs: the first is
      // YOUR quota (wait for the reset), the second is Anthropic's servers (already auto-retried).
      // unverified vs completed matters just as much: never treat unverified as done.
      'List every queue item (queued/running/completed/unverified/failed/rate_limited/overloaded/canceled), in run order. rate_limited = the account hit its own session/weekly cap; overloaded = a 529 that outlasted the automatic retries; unverified = the process exited 0 but no transcript evidence confirms it actually produced a turn - never treat this as the same as completed.',
    inputSchema: S(),
    run: () => api('/api/queue'),
  },
  {
    name: 'add_queue_item',
    description:
      '⛔ REFUSED ON EVERY CALL on this machine (HTTP 409): a queued run is a `claude -p` process nobody can see, and the no-headless law (owner, 2026-08-27, restated 2026-08-31: "there is no setting for this") is a literal `false` in headless-policy.ts. The queue remains as history and UI. To start visible work on other accounts use `fan_out`; to continue a chat, `fan_out_send` or the orchestrator courier. If it ever accepts: title, cwd, and prompt are required; session_id is required when resuming an existing session (new_chat=false).',
    inputSchema: S(
      {
        title: { type: 'string' },
        cwd: { type: 'string', description: 'Absolute working directory for the run.' },
        prompt: { type: 'string' },
        session_id: {
          type: 'string',
          description: 'Required unless new_chat is true (a fresh id is generated then).',
        },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        permission_mode: {
          type: 'string',
          enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        },
        account_id: { type: 'string' },
        instance_ref: {
          type: 'string',
          description:
            "Run under a signed-in instance's login. Easiest form: its permanent NUMBER ('7' or '#7' — see list_instance_numbers), which is expanded before the item is stored. Also accepts 'desktop:<dir>' (a dir from list_instances) or 'cli:<id>' (an id from list_cli_instances). Takes precedence over account_id.",
        },
        new_chat: {
          type: 'boolean',
          description: 'Start a brand-new session instead of resuming.',
        },
        fork: { type: 'boolean' },
      },
      ['title', 'cwd', 'prompt'],
    ),
    run: async (a) =>
      api('/api/queue', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...a, instance_ref: await normalizeInstanceRef(a.instance_ref) }),
      }),
  },
  {
    name: 'update_queue_item',
    description:
      "MUTATES: patch a queue item (title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, status, position, new_chat, fork). instance_ref runs the item under that signed-in instance's login and takes precedence over account_id — pass its permanent NUMBER ('7'), or 'desktop:<dir>' from list_instances, or 'cli:<id>' from list_cli_instances.",
    inputSchema: S(
      {
        id: { type: 'string' },
        patch: {
          type: 'object',
          description:
            "Fields to update; any subset of the queue item columns, e.g. instance_ref: run under a signed-in instance's login ('desktop:<dir>' from list_instances or 'cli:<id>' from list_cli_instances) — takes precedence over account_id.",
        },
      },
      ['id', 'patch'],
    ),
    run: async (a) => {
      const patch = { ...((a.patch as Record<string, unknown>) ?? {}) }
      // Only touch the key when the caller actually sent it: `instance_ref: null` is the documented
      // way to UNPIN a run, and adding the key where it was absent would clear a pin nobody asked
      // to clear.
      if ('instance_ref' in patch)
        patch.instance_ref = await normalizeInstanceRef(patch.instance_ref)
      return api(`/api/queue/${encodeURIComponent(str(a.id))}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch),
      })
    },
  },
  {
    name: 'run_queue_item',
    description: 'MUTATES: start running a queued item now (fails if already running).',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/run`, { method: 'POST' }),
  },
  {
    name: 'cancel_queue_item',
    description: 'MUTATES: cancel a running (or queued) item.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/cancel`, { method: 'POST' }),
  },
  {
    name: 'get_run_events',
    description:
      "Get a queue item's recorded run events (assistant/user/system turns for that run) AND how the run ended. Read `outcome` before drawing conclusions from the events: `died` is true whenever the run stopped without completing, `status` says which kind (unverified / failed / canceled / rate_limited / overloaded) and `exit_code` is the child process's own code, with -1 meaning the daemon lost the runner and never saw it exit. `unverified` means exit 0 but no transcript evidence confirmed a real turn happened - treat it as died, not completed. A log that simply stops is a crash or a kill, not a short answer, and the events alone cannot tell you which.",
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/queue/${encodeURIComponent(str(a.id))}/events`),
  },

  // --- incidents (server/src/incidents.ts) ---------------------------------------
  // A failed queue run is grouped with prior failures of the SAME project + error signature
  // instead of each occurrence reading as a fresh, unrelated alert - see incidents.ts's header.
  {
    name: 'list_incidents',
    description:
      "List failure incidents (grouped, deduped repeats of the same project + error), newest activity first. state filters to 'open' | 'acked' | 'resolved'; omit for every incident.",
    inputSchema: S({ state: { type: 'string', enum: ['open', 'acked', 'resolved'] } }),
    run: (a) => api(`/api/incidents${qs({ state: a.state })}`),
  },
  {
    name: 'ack_incident',
    description:
      "MUTATES: acknowledge an open incident ('seen, working on it'). No-op on a missing, already-acked, or already-resolved incident.",
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/incidents/${encodeURIComponent(str(a.id))}/ack`, { method: 'POST' }),
  },
  {
    name: 'resolve_incident',
    description:
      'MUTATES: resolve an incident. Terminal until the same project fails with the same error again, which reopens it.',
    inputSchema: S({ id: { type: 'string' } }, ['id']),
    run: (a) => api(`/api/incidents/${encodeURIComponent(str(a.id))}/resolve`, { method: 'POST' }),
  },

  // --- accounts -----------------------------------------------------------------
  // NO list_accounts TOOL, deliberately (owner ask 2026-09-04: keep one of each duplicated pair).
  // It listed the old pasted-credentials table, and its own description ended "This is NOT the
  // primary account list ... use list_instances / list_cli_instances for those" — a tool whose
  // text tells an agent not to use it is a duplicate that still costs a slot and still gets
  // called. Signed-in accounts live on instances: list_instance_numbers for the whole fleet,
  // list_instances / list_cli_instances / list_codex_instances per kind. The ROUTE stays
  // (GET /api/accounts, queue.ts) — Settings still renders the rare leftover credential there.

  // --- scheduler ------------------------------------------------------------------
  {
    name: 'get_scheduler',
    description:
      'Get the scheduler state: enabled, running/queued counts, spacing/poll seconds, max_concurrent.',
    inputSchema: S(),
    run: () => api('/api/scheduler'),
  },
  {
    name: 'set_scheduler',
    description:
      'MUTATES: update scheduler settings (any subset of enabled, spacing_seconds, poll_seconds, max_concurrent).',
    inputSchema: S({
      enabled: { type: 'boolean' },
      spacing_seconds: { type: 'number' },
      poll_seconds: { type: 'number' },
      max_concurrent: { type: 'number' },
    }),
    run: (a) =>
      api('/api/scheduler', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },

  // --- instance numbers ----------------------------------------------------------
  // START HERE for anything about "which account". Every instance — Claude Desktop, Claude CLI,
  // Codex — carries a permanent number in ONE shared sequence, and that number is the only
  // identifier that is short, stable and safe to write into a prompt. The alternatives are a
  // Windows folder path and a random uuid.
  {
    name: 'list_instance_numbers',
    description:
      "THE INSTANCE DIRECTORY: every instance (Claude Desktop, Claude CLI, Codex) in one flat list, each with its permanent NUMBER, kind, signed-in account email, plan, login state, and the dir/id the per-kind tools take. Numbers are unique across all three kinds, assigned once and NEVER reused, so '#7' means the same account tomorrow. Call this first whenever a human says 'instance 7' or you need to pick an account to route work to.",
    inputSchema: S(),
    run: () => api('/api/instance-numbers'),
  },
  {
    name: 'resolve_instance',
    description:
      "Turn any reference to an instance — a number (7, '#7'), a dir, an id, a 'desktop:<dir>'/'cli:<id>' ref, or an unambiguous name — into the one instance it means, with its account email and plan. Use this to CONFIRM which account you are about to touch before a mutating or quota-spending action. Errors distinguish an unknown number from a retired one (its instance was deleted; numbers are never recycled).",
    inputSchema: S({ instance: INSTANCE_PARAM }, ['instance']),
    run: (a) => resolveRef(a.instance),
  },
  {
    name: 'whoami',
    description:
      "WHICH INSTANCE AM I? Identifies the instance THIS process is actually running as — permanent number, kind, account email, plan and raw rate-limit tier — and shows its WORKING. It does NOT just read one env var: a Claude Desktop session sets no CLAUDE_CONFIG_DIR, so identification walks CODEX_HOME → CLAUDE_CONFIG_DIR → CLAUDE_CODE_EXECPATH → the instance folder holding this session's own claude-code-sessions file → the parent `claude.exe` process and the Electron host's --user-data-dir. Read `confidence`: 'exact' means a signal named the credential store and you may quote the number; 'assumed' means it fell back to the default ~/.claude login by ELIMINATION and must be hedged. `clues` is the literal proof, `ruledOut` says what was checked and came up empty. TWO THINGS THAT LOOK AUTHORITATIVE AND LIE, so never identify yourself from them: your transcript's location (a Desktop-instance session still writes to the DEFAULT ~/.claude/projects) and ~/.claude.json's oauthAccount email (the machine's default login, not the credential this session bills to). If a human tells you an instance number, THAT beats all of this.",
    inputSchema: S({
      fresh: {
        type: 'boolean',
        description:
          'Re-run the detection instead of reusing this process’s cached answer. Rarely needed — an identity cannot change while a process lives.',
      },
    }),
    run: async (a) => {
      const self = await selfIdentity(a.fresh === true)
      return {
        ...self,
        note: self.instance
          ? undefined
          : self.confidence === 'exact'
            ? 'Identified a credential directory that belongs to no managed instance, so there is no number to quote. check_my_usage still reads the right account.'
            : 'This process is not running as a managed instance — check_my_usage will report the default login, and will say so.',
        nextStep:
          self.confidence === 'exact'
            ? `Use ${instanceLabel(self.instance) ?? 'this account'} whenever you report quota, and call check_my_usage {} before any heavy or long work.`
            : 'Identification is NOT settled, so do not name an account. Ask the human which instance you are (their answer overrules this detection), and treat any quota reading as unattributed until they say.',
      }
    },
  },

  // --- multi-instance (isolated Claude Desktop instances) ------------------------
  {
    name: 'list_instances',
    description:
      'List isolated Claude Desktop instances with their live status and resolved account. Each row carries its permanent instance `num` — prefer that over `dir` when referring to one. For the whole fleet (Desktop + CLI + Codex) in one numbered list, use list_instance_numbers.',
    inputSchema: S(),
    run: () => api('/api/instances'),
  },
  {
    name: 'launch_instance',
    description:
      'MUTATES: open (launch) a Claude Desktop instance, by its number (`instance`) or its directory.',
    inputSchema: S({ instance: INSTANCE_PARAM, dir: { type: 'string' } }),
    run: async (a) =>
      api(`/api/instances/${encodeURIComponent(await handleFrom(a.dir, a.instance, 'dir'))}/open`, {
        method: 'POST',
      }),
  },
  {
    name: 'quit_instance',
    description:
      'MUTATES: quit a running Claude Desktop instance, by its number (`instance`) or its directory.',
    inputSchema: S({ instance: INSTANCE_PARAM, dir: { type: 'string' } }),
    run: async (a) =>
      api(`/api/instances/${encodeURIComponent(await handleFrom(a.dir, a.instance, 'dir'))}/quit`, {
        method: 'POST',
      }),
  },

  // --- usage-check subsystem (Feature B) ----------------------------------------
  {
    name: 'check_usage',
    description:
      "Read ONE account's remaining Claude subscription quota — session (5h) %, weekly (all models) %, any per-model weekly %, plus an `advice` verdict (severity / shouldOffload / safeToFanOut). The WEEKLY all-models % is the BINDING cap for pacing multi-agent work; a fresh 5-hour session % is a red herring when weekly is near 100, and switching flagship model does NOT dodge the all-models weekly bucket. NORMAL USE: pass `instance` — the permanent instance number a human quotes ('check instance 7'), which works for Claude Desktop, Claude CLI and Codex instances alike and echoes back WHICH account answered. `account` (a saved dispatch account id or label) and `configDir` (a CLAUDE_CONFIG_DIR that has been /login'd once) remain for the two older credential stores; with none of the three, falls back to THIS process's own config — but prefer check_my_usage for that.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'string',
        description: 'A CLAUDE_CONFIG_DIR that has been logged in once via `claude` → /login.',
      },
    }),
    run: async (a) => {
      const instance = a.instance != null ? str(a.instance).trim() : ''
      if (instance) return withNextStep(await api(`/api/usage${qs({ instance, refresh: '1' })}`))
      const account = a.account != null ? str(a.account) : ''
      const configDir =
        a.configDir != null ? str(a.configDir) : (process.env.CLAUDE_CONFIG_DIR ?? '')
      if (!account && !configDir)
        throw new Error(
          'pass `instance` (its number — see list_instance_numbers), `account`, or `configDir` (or use check_my_usage, which works out which account THIS process bills to on its own)',
        )
      return withNextStep(
        await api(
          `/api/usage${qs({ account: account || undefined, configDir: configDir || undefined, refresh: '1' })}`,
        ),
      )
    },
  },
  {
    name: 'check_my_usage',
    description:
      'Self-check: read YOUR OWN remaining Claude quota, right now, in ~300ms. Returns the session (5h) %, the weekly all-models % (the BINDING cap), an `advice` verdict with `shouldOffload` / `safeToFanOut` flags, and `identity` — WHICH numbered instance you are, on WHAT plan/tier, and HOW that was established, so you can report "instance #11 (Pro) is at 82% weekly" instead of an unattributed percentage. It identifies itself the same way whoami does (env → session file → parent process), so it reports the right account for a Claude DESKTOP session too, not just a CLI instance that sets CLAUDE_CONFIG_DIR. CALL THIS when you are doing long or heavy work: if `shouldOffload` is true you are close to being cut off mid-task, and you should WRITE YOUR WORKING CONTEXT, FINDINGS, AND NEXT STEPS TO A FILE BEFORE CONTINUING, so the work survives. Also call it before a big multi-agent fan-out — and gate on CURRENT + PROJECTED cost, because a fan-out cannot be recalled once launched while solo work can be stopped at any tool call. If `identity.warning` is present, the percentages are real but WHOSE they are is not settled: say so rather than quoting a bare number.',
    inputSchema: S(),
    run: async () => {
      const self = await selfIdentity()

      // Prefer the INSTANCE route. It matters: a desktop instance's credential lives in Electron
      // safeStorage, not in a `.credentials.json`, so reading it by configDir alone returns
      // check_failed — which is exactly what a Desktop session used to get back. Routing by number
      // takes the full credential chain (own token → linked CLI login → dispatch account).
      const usage = self.instance
        ? await apiOrLocal(`/api/usage${qs({ instance: self.instance.num, refresh: '1' })}`, () =>
            localUsageForInstance(self.instance as ResolvedInstanceRow),
          )
        : !self.configDir
          ? { snapshot: null, reason: 'check_failed' }
          : self.kind === 'desktop'
            ? // An UNMANAGED desktop user-data dir. Answered in-process rather than through
              // /api/usage?configDir=, which reads a CLI `.credentials.json` a desktop dir does
              // not have — the exact mismatch that made a Desktop session's self-check fail.
              // There is no REST route for an arbitrary desktop dir, and this needs none: the
              // safeStorage token is a local file and the quota endpoint is one HTTPS GET.
              await localUsageForDesktopDir(self.configDir)
            : // The plain `~/.claude` login (or a CLI config dir).
              await apiOrLocal(`/api/usage${qs({ configDir: self.configDir, refresh: '1' })}`, () =>
                localUsageForConfigDir(self.configDir as string),
              )

      return await withNextStep(
        {
          ...(usage as Record<string, unknown>),
          identity: self,
          // Kept at the top level for every existing caller written against the old shape.
          configDir: self.configDir,
          instance: self.instance,
        },
        self,
      )
    },
  },
  {
    name: 'list_usage',
    description:
      "Survey the quota of EVERY managed instance (desktop + CLI) in one call, each with its permanent instance `num` and its `advice` verdict. Use this to answer 'which of my accounts has headroom?' before routing heavy work, or to find the account that is about to hit its weekly cap — then refer to the winner by its number. Checks are concurrent and cost no quota.",
    inputSchema: S(),
    run: async () => {
      const survey = (await apiOrLocal('/api/usage/survey', async () => {
        const { surveyUsage } = await import('./usage-service')
        const { usageAdvice } = await import('./usage')
        const rows = await surveyUsage()
        return {
          rows: rows.map((r) => ({ ...r, advice: usageAdvice(r.result.snapshot) })),
          daemon: 'offline (answered locally)',
        }
      })) as Record<string, unknown>
      return {
        ...survey,
        // A survey has no single advice to branch on, so the instruction is about what to DO with
        // a list: pick by the binding cap, and quote the number so the human can check the choice.
        nextStep:
          'Route heavy work to the row with the lowest WEEKLY (all models) %, not the lowest session %, and name it by its `num` when you say where you sent it. A row whose advice.severity is "unknown" was not read successfully; that is not headroom.',
      }
    },
  },
  {
    name: 'usage_budget',
    description:
      "QUANTIFY the quota: turn a vague '98% used' into numbers you can actually plan with. Returns (a) `forecast` — the burn rate in %/HOUR, the hours of headroom left at that rate, and `exhaustsBeforeReset`, THE field that decides things: if false, the cap will NOT bite before it resets and you can work freely no matter how alarming the % looks; if true, you have `headroomHours` before you are cut off. And (b) `budget` — an estimated TOKEN headroom, derived by measuring (tokens counted from your Claude Code transcripts) / (percent burned), because Anthropic publishes no token or dollar quota. ALWAYS read `budget.caveat` and `budget.confidence`: the token figure only counts Claude Code on THIS machine, so if the account is also used from the desktop app or elsewhere it is an OPTIMISTIC UPPER BOUND. Use this before committing to a long task or a big fan-out. CALL IT WITH NO ARGUMENTS to budget YOURSELF — it identifies which instance this process is (same detection as whoami, so a Claude Desktop session works too) and returns an `identity` block naming the account it measured. Pass `instance` (its permanent number — the only form that works for Desktop, CLI and Codex alike, and it echoes back which account answered) to budget a different one; `dir` and `account` remain for the older desktop/dispatch paths. Add `configDir` to count a specific CLI config dir's transcripts.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      dir: { type: 'string', description: 'Desktop instance dir (from list_instances).' },
      account: { type: 'string', description: 'A saved dispatch account id or label.' },
      configDir: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Claude config dirs whose transcripts count as this account's spend. Defaults to the plain ~/.claude login (or, when `instance` is a CLI instance, that instance's own config dir).",
      },
    }),
    run: async (a) => {
      const params = new URLSearchParams()
      if (a.instance != null && str(a.instance).trim())
        params.set('instance', str(a.instance).trim())
      if (a.dir != null) params.set('dir', str(a.dir))
      if (a.account != null) params.set('account', str(a.account))
      const dirs = (Array.isArray(a.configDir) ? a.configDir : []).map(str)
      for (const d of dirs) params.append('configDir', d)

      // NO TARGET GIVEN → budget MYSELF. This used to throw, which meant the one caller who most
      // needs a burn rate (an agent deciding whether it can finish) had to know its own instance
      // number first — and a Desktop session had no way to learn it.
      let self: SelfIdentityPayload | null = null
      if (!params.has('instance') && !params.has('dir') && !params.has('account')) {
        self = await selfIdentity()
        if (self.instance) params.set('instance', String(self.instance.num))
        else if (self.kind === 'desktop' && self.configDir) params.set('dir', self.configDir)
        // The plain ~/.claude login: no instance number, no desktop dir. `configDir` is both the
        // credential to read AND the transcripts to count, which is exactly what the budget route's
        // configDir branch does.
        else if (self.configDir) params.append('configDir', self.configDir)
        else
          throw new Error(
            `could not identify which account this process runs as (${self.summary}). Pass \`instance\` (its number — see list_instance_numbers), \`dir\` or \`account\`.`,
          )
      }

      const withSelf = (r: unknown) =>
        withNextStep(self ? { ...(r as Record<string, unknown>), identity: self } : r, self)

      // Read the TARGET back off `params`, not off `a` — self-identification may have filled it in.
      const spendDirs = params.getAll('configDir')
      const dirParam = params.get('dir')

      return withSelf(
        await apiOrLocal(`/api/usage/budget?${params.toString()}`, async () => {
          // Offline path: `instance`, `dir` and `configDir` all work — the number registry, the
          // instance stores and a CLI login's credentials are plain files, readable with the app
          // closed. Only `account` cannot be answered here: it resolves a dispatch account out of
          // the daemon's sqlite, and racing the daemon for that DB is not worth the complexity.
          const { resolveInstance, resolveInstanceError } = await import('./core/instance-ref')
          const hit = params.has('instance') ? await resolveInstance(params.get('instance')) : null
          if (params.has('instance') && !hit)
            throw new Error(await resolveInstanceError(params.get('instance')))
          if (!hit && !dirParam && spendDirs.length === 0)
            throw new Error(
              'the AgentHydra daemon is not running; usage_budget can answer offline for `instance`, `dir` or `configDir` but not for `account`. Start the app, or pass `instance`.',
            )
          if (hit?.kind === 'codex')
            throw new Error(
              `instance #${hit.num} is a Codex instance; its quota comes from the OpenAI API, which this offline path does not call. Start the app and retry.`,
            )
          const { checkUsageForCliInstance, checkUsageForDesktop } = await import('./usage-service')
          const { buildUsageBudget, budgetSummary } = await import('./usage-budget')
          const { checkUsage, isNoData, usageAdvice } = await import('./usage')
          const result =
            hit?.kind === 'cli'
              ? await checkUsageForCliInstance(hit.handle)
              : hit?.kind === 'desktop' || dirParam
                ? await checkUsageForDesktop(hit?.handle ?? (dirParam as string))
                : await (async () => {
                    const cd = spendDirs[0] as string
                    const snapshot = await checkUsage({ configDir: cd, account: cd })
                    return {
                      snapshot,
                      cached: false,
                      key: `dir:${cd}`,
                      reason: isNoData(snapshot) ? ('check_failed' as const) : ('ok' as const),
                    }
                  })()
          if (!result) throw new Error(`instance #${hit?.num} could not be checked`)
          const budget = buildUsageBudget(result.snapshot, result.key, {
            configDirs: spendDirs.length
              ? spendDirs
              : hit?.kind === 'cli'
                ? [hit.configDir]
                : undefined,
          })
          return {
            snapshot: result.snapshot,
            reason: result.reason,
            advice: usageAdvice(result.snapshot),
            budget,
            summary: budgetSummary(budget, result.snapshot.weekAll?.pct ?? null),
            ...(hit ? { instance: { num: hit.num, kind: hit.kind, name: hit.name } } : {}),
            daemon: 'offline (answered locally)',
          }
        }),
      )
    },
  },

  // --- CLI instances (Feature A) ------------------------------------------------
  {
    name: 'list_cli_instances',
    description:
      'List CLI instances (a CLAUDE_CONFIG_DIR per account, logged in once) with their permanent instance `num`, login state, associated account, and last usage snapshot.',
    inputSchema: S(),
    run: () => api('/api/cli-instances'),
  },
  {
    name: 'create_cli_instance',
    description:
      "MUTATES: create a new CLI instance — mkdir its CLAUDE_CONFIG_DIR (loggedIn=false). Signing it in is the USER's step afterward (an AI must never perform the /login).",
    inputSchema: S({ name: { type: 'string' } }, ['name']),
    run: (a) =>
      api('/api/cli-instances', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: str(a.name) }),
      }),
  },
  {
    name: 'launch_cli_instance',
    description:
      'MUTATES: open a terminal running this CLI instance (its CLAUDE_CONFIG_DIR set), optionally with a model/effort. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
    }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/launch`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ model: a.model, effort: a.effort }),
        },
      ),
  },
  {
    name: 'cli_instance_login_helper',
    description:
      'MUTATES: open a terminal for the USER to run /login and sign this CLI instance in. The daemon never performs the login itself. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/cli-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/login`,
        { method: 'POST' },
      ),
  },
  {
    name: 'link_cli_instance_to_desktop',
    description:
      "MUTATES: link a CLI instance to a DESKTOP instance (they are normally the same Anthropic account with two separate logins). Linking groups them in the UI and lets each act as the other's usage-check fallback when one's token is expired. Both sides accept an instance NUMBER: `instance` for the CLI side, `desktop` for the desktop side. Pass desktopDir/desktop: null to unlink.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string', description: 'CLI instance id.' },
      desktop: {
        type: ['string', 'number', 'null'],
        description: "The desktop instance's number (or dir/name), or null to unlink.",
      },
      desktopDir: {
        type: ['string', 'null'],
        description: 'Desktop instance dir (from list_instances), or null to unlink.',
      },
    }),
    run: async (a) => {
      const id = await handleFrom(a.id, a.instance, 'id')
      // null is a meaningful VALUE here (unlink), so it must survive the resolve step untouched —
      // only a non-null `desktop` is looked up.
      const explicitNull = a.desktop === null || a.desktopDir === null
      const desktopDir = explicitNull
        ? null
        : a.desktop != null && str(a.desktop).trim()
          ? (await resolveRef(a.desktop)).handle
          : (a.desktopDir ?? null)
      return api(`/api/cli-instances/${encodeURIComponent(id)}/link-desktop`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ desktopDir }),
      })
    },
  },

  // --- Codex CLI + Desktop instances --------------------------------------------
  {
    name: 'list_codex_instances',
    description:
      'List isolated Codex instances (one CODEX_HOME and desktop profile per OpenAI login), each with its permanent instance `num` — the same sequence the Claude instances use, so a number is never ambiguous between them.',
    inputSchema: S(),
    run: () => api('/api/codex-instances'),
  },
  {
    name: 'create_codex_instance',
    description: "MUTATES: create an isolated CODEX_HOME. Authentication remains the user's step.",
    inputSchema: S({ name: { type: 'string' } }, ['name']),
    run: (a) =>
      api('/api/codex-instances', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: str(a.name) }),
      }),
  },
  {
    name: 'launch_codex_instance',
    description:
      'MUTATES: open a terminal running this Codex instance. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/launch`,
        { method: 'POST', headers: JSON_HEADERS, body: '{}' },
      ),
  },
  {
    name: 'codex_instance_login_helper',
    description:
      'MUTATES: open `codex login` in a terminal for the user. The daemon never authenticates for them. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/login`,
        { method: 'POST' },
      ),
  },
  {
    name: 'open_codex_desktop_instance',
    description:
      'MUTATES: launch this isolated Codex Desktop instance, independently from other Codex windows. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/open`,
        { method: 'POST' },
      ),
  },
  {
    name: 'focus_codex_desktop_instance',
    description:
      "MUTATES: bring this running Codex Desktop instance's window to the foreground. Identify it by number (`instance`) or by `id`.",
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/focus`,
        { method: 'POST' },
      ),
  },
  {
    name: 'quit_codex_desktop_instance',
    description:
      'MUTATES: stop this isolated Codex Desktop instance. Identify it by number (`instance`) or by `id`.',
    inputSchema: S({ instance: INSTANCE_PARAM, id: { type: 'string' } }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/desktop/quit`,
        { method: 'POST' },
      ),
  },
  {
    name: 'redeem_codex_reset_credit',
    description:
      "MUTATES: spend one banked Codex `/usage reset` credit, which restores the FULL 5h + weekly rate-limit windows in one shot. Refuses unless the busiest window is already 100% used, since redeeming early wastes most of the credit's value — the result names the busiest window's percent when it refuses. Pass `force: true` to redeem anyway. Identify the instance by number (`instance`) or by `id`.",
    inputSchema: S({
      instance: INSTANCE_PARAM,
      id: { type: 'string' },
      force: {
        type: 'boolean',
        description: 'Bypass the "busiest window is not fully used" guard.',
      },
    }),
    run: async (a) =>
      api(
        `/api/codex-instances/${encodeURIComponent(await handleFrom(a.id, a.instance, 'id'))}/redeem-reset-credit`,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ force: a.force === true }),
        },
      ),
  },

  // --- auto-resume monitor (Feature E) ------------------------------------------
  {
    name: 'get_monitor',
    description:
      'Get the auto-resume monitor: settings (enabled, maxAttempts, resumeBufferMin), the tracked rate-limited stops + their state (scheduled / blocked_weekly / needs_human), and per-account overrides.',
    inputSchema: S(),
    run: () => api('/api/monitor'),
  },
  {
    name: 'set_monitor',
    description:
      'MUTATES: update the auto-resume monitor (enabled, maxAttempts, resumeBufferMin). OFF by default. When on, a session killed by a 5-hour rate limit auto-resumes once the window clears — gated on the weekly cap not being maxed.',
    inputSchema: S({
      enabled: { type: 'boolean' },
      maxAttempts: { type: 'number' },
      resumeBufferMin: { type: 'number' },
    }),
    run: (a) =>
      api('/api/monitor', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(a) }),
  },

  {
    name: 'launch_terminal_session',
    description:
      '⛔ REFUSED ON EVERY CALL on this machine: terminal launches were removed (owner law, 2026-08-31 - a visible console is a window nobody asked for, a hidden one is a headless chat, and there is no setting). The tool stays so a caller gets the reason instead of a missing name. To START new work on another account use `fan_out` (N visible desktop chats, one per account, tracked as a group) or `orchestrator_run spawn_chat` (one chat). To CONTINUE a chat, deliver into it: `fan_out_send`, or `orchestrator_run cli_send` / `stage_reply` + `courier`.',
    inputSchema: S(
      {
        cwd: { type: 'string' },
        prompt: { type: 'string' },
        instance_ref: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        resume_session_id: { type: 'string' },
        visible: {
          type: 'boolean',
          description:
            'Put a console window on screen. Default false. Only when a person asked to watch this session.',
        },
      },
      ['cwd', 'prompt'],
    ),
    run: (a) =>
      api('/api/sessions/launch-terminal', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(a),
      }),
  },
  {
    name: 'import_session_to_desktop',
    description:
      "MUTATES: MOVE a FINISHED session into a desktop instance's app as a visible chat, and A MOVE IS A MOVE (owner rule, 2026-09-04): the source account no longer shows it. It lands in the target (the app's own claude://resume import, or a direct record write when that app is closed), carries the chat's model/permission settings, and ARCHIVES every other profile's copy — including against a running source app, which re-saves the flag away and used to leave a visible stale twin on the account you moved it off. `instance_ref` ('desktop:<dir>', from list_instance_numbers) is REQUIRED: there is no inferred target for a move. A TITLE DECISION IS REQUIRED (owner rule): pass `title` (a real, non-generic name) or `confirm_title` (the chat's current title restated exactly, after reviewing it — the dossier answers in one query); without one it is refused. Refuses a currently-live session (the move rewrites the transcript under an active writer) — settle or stop that engine first; a person's own targeted move through `orchestrator_run migrate_chat --stop-idle` is the path that may stop an IDLE engine for them. Finish all headless work FIRST and move LAST; a just-landed chat does not process peer messages until the user first interacts with it.",
    inputSchema: S(
      {
        session_id: { type: 'string' },
        instance_ref: { type: 'string' },
        title: { type: 'string' },
        confirm_title: { type: 'string' },
      },
      ['session_id'],
    ),
    // /migrate, NOT /import-desktop. The import half only LANDS the chat: it leaves the source
    // account's row untouched, so the thread showed on both accounts and every later resolve of
    // it was ambiguous (hit live 2026-09-04 — an agent moved a chat with this tool and the owner
    // still had it). stop_live:false keeps the import door's live refusal; the archive, the
    // settings carry and the running-app re-assert come free with the endpoint that owns them.
    run: async (a) =>
      api(`/api/sessions/${encodeURIComponent(str(a.session_id))}/migrate`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          instance_ref: a.instance_ref,
          title: a.title,
          confirm_title: a.confirm_title,
          stop_live: false,
        }),
      }),
  },
  {
    name: 'move_chat',
    description:
      'MUTATES: MOVE ONE CHAT BETWEEN ACCOUNTS IN ONE CALL — the path for "move the X chat from Martin to here" (owner, 2026-09-04: by hand this took a dozen round trips and minutes; now it is this call). `chat` is a title fragment — matched FUZZILY, so case, punctuation and a misspelling still find it ("arkitecht cleanup" finds "Arkitekt cleanup") — or a session id. `from` (optional) is the account it lives on — instance number, name, label or email — and scopes the search, so a title two accounts share is not ambiguous. `to` defaults to "here" (the instance THIS process runs as, resolved like whoami; refused unless that identity is exact); "best" picks the running desktop instance with the most real headroom (tier × remaining weekly %, from the usage survey, never the source); or name any instance by number/name/label/email. It runs the orchestrator\'s migrate_chat with EVERY rail it has — hold, breaker, live-writer refusal, verified landing, source row settled so the old account no longer shows it — plus --now: a chat whose turn is finished and whose transcript shows NO background job outstanding moves after 15s of quiet instead of the standing 300s (an outstanding job, a working or stuck engine still wait or refuse). `wait_secs` (default 330, max 360) is how long the call itself waits for a chat that is idle but not yet quiet enough. EVERY LANDING IS STAMPED bypassPermissions + ultracode, and then ADJUDICATED, because a disk read is not the mode the chat opens with: the app holds each chat\'s mode in MEMORY and only re-reads its store at its own process boot. Read `bypassVerdict`, never `permissionMode` (which is only what the disk said last). `app-confirmed` = the target app\'s own permission picker was driven and agreed; `adopted-at-boot` = the target app is closed, so it will read this stamp at its next boot; both are real. `disk-only` = NOT a guarantee, the chat may open on a prompting mode, and `bypassRemedy` is the exact command that fixes it. `bypassStamped` is true only for the two earned verdicts. `force` is a PERSON\'S word — pass it only when the human asked for this move (it overrides a hold or a superseded lineage; a live writer is never overridden). `dry_run` resolves the chat, the target, the hold and the engine\'s idleness and reports the plan without moving anything. Read `report`; `landed` is the verdict. A just-landed chat does not process peer messages until the user first interacts with it.',
    inputSchema: S(
      {
        chat: { type: 'string', description: 'Title fragment (fuzzy) or session id.' },
        from: {
          type: ['string', 'number'],
          description:
            'The instance the chat lives on: number, name, label or email. Optional; scopes the search and disambiguates a shared title.',
        },
        to: {
          type: ['string', 'number'],
          description:
            '"here" (default: the instance this process runs as), "best" (most headroom), or an instance number/name/label/email.',
        },
        title: {
          type: 'string',
          description:
            'Rename on landing (a real, non-generic name). Default: keep the current title.',
        },
        force: {
          type: 'boolean',
          description:
            "A person's word: override a hold / superseded lineage. Only when the human asked.",
        },
        wait_secs: {
          type: 'number',
          description:
            'Seconds to wait inside the call for an idle-but-young engine (default 330, max 360).',
        },
        dry_run: { type: 'boolean', description: 'Plan only: resolve everything, move nothing.' },
        archived: {
          type: 'boolean',
          description:
            'Move the chat even though it is ARCHIVED. Default FALSE, and leave it that way unless the human asked for that specific chat. Note that `archived` does NOT mean the chat is finished: it is Claude Desktop\'s resting "not on screen" state, carried by 2,598 of 2,611 chats when measured, so it is the MAJORITY of any account rather than a tail. That is why the default is off. Separate from `force`, both ways: neither implies the other.',
        },
      },
      ['chat'],
    ),
    run: async (a) => {
      const chat = str(a.chat).trim()
      if (!chat) throw new Error('chat is required: a title fragment or a session id')
      const wait = Math.max(0, Math.min(360, Number(a.wait_secs ?? 330) || 0))
      // One resolver, shared with move_chats (resolveMoveTarget), so a batch and a single
      // move can never disagree about which account "here" or "best" names.
      const { toRef, targetNote } = await resolveMoveTarget(a.to)
      const args = [
        chat,
        '--to',
        toRef,
        '--stop-idle',
        '--now',
        '--idle-wait',
        String(wait),
        '--json',
      ]
      if (a.from != null && str(a.from).trim() !== '') {
        const src = await resolveRef(str(a.from).trim())
        args.push('--from', String(src.num))
      }
      if (a.force === true) args.push('--force')
      if (a.title != null && str(a.title).trim() !== '') args.push('--title', str(a.title).trim())
      if (a.dry_run === true) args.push('--dry-run')
      // Off by default, and migrate_chat enforces the same default independently (exit 7),
      // so omitting this can only ever be safe. Owner, Michael, 2026-09-05: a move touches
      // unarchived chats only, unless the human asked for that specific chat.
      if (a.archived === true) args.push('--archived')
      const run = (await api('/api/orchestrator/run', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          script: 'migrate_chat',
          args,
          // the wait happens INSIDE the script, so the deadline must outlast it
          timeoutMs: (wait + 180) * 1000,
        }),
      })) as Record<string, unknown>
      let payload: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(str(run.stdout))
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
      } catch {
        payload = null
      }
      if (!payload) {
        // no JSON means the script never got to its own report (usage error, python missing,
        // daemon busy) — hand back the raw run so the reason is visible, never a bare failure
        return { ...run, ok: false, args, targetNote }
      }
      return {
        ok: payload.landed === true || payload.dryRun === true,
        ...payload,
        targetNote,
        exitCode: run.exitCode,
        exitMeaning: run.exitMeaning,
        ...(str(run.stderr).trim() ? { stderr: run.stderr } : {}),
      }
    },
  },
  {
    name: 'move_chats',
    description:
      "MUTATES: MOVE MANY CHATS BETWEEN ACCOUNTS IN ONE CALL — move_chat's plural, and the one you should reach for whenever more than a single chat is being moved (owner, 2026-09-05, angry: 13 chats took ~15 minutes as 13 separate calls). Do NOT loop move_chat and do NOT fire it in parallel: the daemon keys its in-flight map by SCRIPT NAME, so concurrent move_chat calls do not overlap — all but one return `409 busy` and the rest time their sockets out. This runs the orchestrator's migrate_batch, which executes migrate_chat's OWN pipeline inside ONE interpreter and ONE route-lock acquisition, BY PHASE rather than by chat (owner, 2026-09-06: \"move them all, archive them all, then set all the permissions\"): every chat is moved and verified, THEN every source row is settled, THEN one shared bypass watch is followed by every chat's permission stamp. So the fleet, session and usage-survey reads are paid once for the whole batch, the 8s bypass watch is paid once instead of once per chat, and the chats are usable as soon as the first phase ends. EVERY RAIL IS UNCHANGED AND PER CHAT: each chat is re-resolved immediately before its own gates (a liveness read from batch start is not liveness), a live writer is still refused, the landing is still verified by read-back, the source row is still settled, and the bypass verdict is still ADJUDICATED — read each result's `bypassVerdict`, never `permissionMode`. Imports are deliberately NOT parallelised: /import-desktop takes no act lock and two at once into one store can create a duplicate row that makes a chat permanently unreachable. Pass `chats` (title fragments or session ids), or `all_unarchived: true` to take every unarchived desktop chat — with `from` to scope that to one account and `limit` to cap it. A REFUSED CHAT DOES NOT STOP THE BATCH: it is reported by name with its reason and the rest continue, so read `refused` and the per-chat `results`, never just `moved`. `dry_run: true` plans every chat and moves nothing. Expect roughly 15-25s per chat that actually lands (the import, the source settle and the app's own permission picker each drive one window under its own lock, so they are irreducibly serial); the saving is in what is no longer repeated and no longer waited for twice, not in doing several at once.",
    inputSchema: S(
      {
        chats: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description:
            'The chats to move: each a title fragment (fuzzy) or a session id. Omit only when using all_unarchived.',
        },
        all_unarchived: {
          type: 'boolean',
          description:
            "Instead of naming chats, take EVERY unarchived desktop chat (scope it with `from`, cap it with `limit`). Archived chats are excluded — that is Claude Desktop's resting state and the majority of any account.",
        },
        from: {
          type: ['string', 'number'],
          description:
            'The account the chats live on: number, name, label or email. Scopes both the search and all_unarchived.',
        },
        to: {
          type: ['string', 'number'],
          description:
            '"here" (default: the instance this process runs as), "best" (most headroom), or an instance number/name/label/email. Resolved exactly as move_chat resolves it.',
        },
        force: {
          type: 'boolean',
          description:
            "A person's word, applied to EVERY chat in the batch: override a hold / superseded lineage. A live writer is never overridden. Only when the human asked.",
        },
        archived: {
          type: 'boolean',
          description:
            'Allow ARCHIVED chats to move too. Default false. Ignored by all_unarchived, which is unarchived by definition.',
        },
        limit: {
          type: 'number',
          description:
            'With all_unarchived, cap the batch at the N most recently active chats. 0 or omitted means no cap.',
        },
        wait_secs: {
          type: 'number',
          description:
            'Seconds each chat may wait for an idle-but-young engine (default 60 for a batch, max 360). Lower than move_chat on purpose: waiting 330s per chat is what makes a batch take a quarter of an hour.',
        },
        dry_run: { type: 'boolean', description: 'Plan every chat, move nothing.' },
      },
      [],
    ),
    run: async (a) => {
      const chats = Array.isArray(a.chats)
        ? a.chats.map((c) => str(c).trim()).filter((c) => c !== '')
        : []
      const all = a.all_unarchived === true
      if (!all && chats.length === 0)
        throw new Error(
          'name the chats in `chats`, or pass all_unarchived: true (optionally with `from` and `limit`)',
        )
      // A batch's per-chat wait defaults LOW. move_chat's 330s is right when a human asked for
      // one specific chat and will wait for it; multiplied across a batch it is the entire
      // complaint this tool exists to answer.
      const wait = Math.max(0, Math.min(360, Number(a.wait_secs ?? 60) || 0))
      const { toRef, targetNote } = await resolveMoveTarget(a.to)
      const args = ['--to', toRef, '--stop-idle', '--now', '--idle-wait', String(wait), '--json']
      for (const c of chats) args.push('--chat', c)
      if (all) args.push('--all-unarchived')
      if (a.from != null && str(a.from).trim() !== '') {
        const src = await resolveRef(str(a.from).trim())
        args.push('--from', String(src.num))
      }
      if (a.force === true) args.push('--force')
      if (a.archived === true) args.push('--archived')
      if (a.dry_run === true) args.push('--dry-run')
      const limit = Math.max(0, Math.floor(Number(a.limit ?? 0) || 0))
      if (limit > 0) args.push('--limit', String(limit))
      // The batch's own deadline must outlast every chat's wait plus its work, or the daemon
      // kills a run mid-move and the report never comes back.
      const planned = all ? Math.max(limit || 40, 40) : chats.length
      const timeoutMs = Math.min(3_600_000, (planned * (wait + 90) + 180) * 1000)
      const run = (await api('/api/orchestrator/run', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ script: 'migrate_batch', args, timeoutMs }),
      })) as Record<string, unknown>
      let payload: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(str(run.stdout))
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
      } catch {
        payload = null
      }
      // No JSON means the script never reached its own report (usage error, python missing,
      // the route already busy) - hand back the raw run so the reason is visible.
      if (!payload) return { ...run, ok: false, args, targetNote }
      return {
        ...payload,
        targetNote,
        exitCode: run.exitCode,
        exitMeaning: run.exitMeaning,
        ...(str(run.stderr).trim() ? { stderr: run.stderr } : {}),
      }
    },
  },
  // --- fan-out: one task list -> N visible chats on N accounts -------------------------
  // The owner's ask (2026-09-04): "if I start a single chat and tell it to do something that
  // involves checking or linting six or seven planes, can it orchestrate those chats into other
  // accounts and manage them?" Before this the honest answer was "by hand, in ~20 round trips, and
  // the two tools that look like the answer are refused". These three wrap orchestrator/fan_out.py
  // exactly the way move_chat wraps migrate_chat: every rail lives in the script.
  {
    name: 'fan_out',
    description:
      "MUTATES: DISSEMINATE one task list into N VISIBLE Claude Desktop chats, ONE ACCOUNT EACH, and track them as a group — the path for \"lint/check these seven planes in parallel on other accounts\" (owner ask, 2026-09-04). Each task is {cwd, prompt, title?}. Accounts are ranked by REAL room (the fill ceiling minus the account's peak across 5-hour/weekly/binding; an unknown or stale reading is never room), OPEN desktop instances first, one task per account by default (`per_account` raises the cap; spread, never dump). The calling chat's own account is EXCLUDED by default (`exclude_self: false` to allow it). Each chat is spawned through the app's own claude://code/new deeplink into a RUNNING app — trust pre-written, composer submitted, bypass set at birth — so it is a real chat in a sidebar, never headless; spawns run ONE AT A TIME (~30-90 s each) because two lanes driving two windows at once is how text lands in the wrong pane, so budget minutes, not seconds. Closed instances are used only with `open_closed: true` (opening an app is the last resort). A task whose exact prompt already runs somewhere in the fleet is refused as a duplicate (`force` is a PERSON's word to insist); tasks in the SAME call may share a prompt on purpose. A task no account can take is reported UNASSIGNED, never dropped. Returns the group id plus one member per task (instance, sessionId, state: spawned / spawned-unconfirmed / refused / unassigned, why). Then fan_out_status reads them and fan_out_send steers them. `dry_run: true` returns the plan and spawns nothing. This is a person's act and does not need the tray icon. A PROBE OR DRILL FAN-OUT MUST BE DELETED AFTERWARDS (owner rule, 2026-09-04: a ping or account-identification chat is never left in the account): fan_out_delete {group}.",
    inputSchema: S(
      {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: "The group's label for this member (optional).",
              },
              cwd: { type: 'string', description: 'Absolute folder the chat starts in.' },
              prompt: { type: 'string', description: "The chat's first message." },
            },
            required: ['cwd', 'prompt'],
            additionalProperties: false,
          },
          description: 'One entry per chat to start. Same prompt across entries is fine.',
        },
        group: {
          type: 'string',
          description: 'A name for the group (optional; the id is generated).',
        },
        per_account: {
          type: 'number',
          description: 'Max chats per account in this fan-out. Default 1.',
        },
        only: {
          type: 'array',
          items: { type: ['string', 'number'] },
          description: 'Restrict targets to these instances (number, name, label or email).',
        },
        exclude: {
          type: 'array',
          items: { type: ['string', 'number'] },
          description: 'Never target these instances (number, name, label or email).',
        },
        exclude_self: {
          type: 'boolean',
          description:
            'Default true: the instance THIS process runs as is left out (when its identity is exact). false = allow it.',
        },
        open_closed: {
          type: 'boolean',
          description: 'Allow opening closed instances when running ones run out. Default false.',
        },
        force: {
          type: 'boolean',
          description:
            "A person's word: start a task even though an identical chat already exists.",
        },
        dry_run: { type: 'boolean', description: 'Plan only: rank, assign, spawn nothing.' },
      },
      ['tasks'],
    ),
    run: async (a) => {
      const rawTasks = Array.isArray(a.tasks) ? a.tasks : []
      if (rawTasks.length === 0) throw new Error('tasks is required: at least one {cwd, prompt}')
      const tasks = rawTasks.map((t, i) => {
        const task = (t ?? {}) as Record<string, unknown>
        const cwd = str(task.cwd ?? task.folder).trim()
        const prompt = str(task.prompt).trim()
        if (!cwd) throw new Error(`task ${i} has no cwd`)
        if (!prompt) throw new Error(`task ${i} has no prompt`)
        const title = str(task.title).trim()
        return { ...(title ? { title } : {}), folder: cwd, prompt }
      })
      const groupName = str(a.group).trim()
      const spec = JSON.stringify({ ...(groupName ? { group: groupName } : {}), tasks })
      const args = ['--spec', specArg(spec), '--json']
      const perAccount = Number(a.per_account)
      if (Number.isFinite(perAccount) && perAccount > 1)
        args.push('--per-account', String(Math.floor(perAccount)))
      for (const ref of Array.isArray(a.only) ? a.only : [])
        args.push('--only', String((await resolveRef(ref)).num))
      const excludes: string[] = []
      for (const ref of Array.isArray(a.exclude) ? a.exclude : [])
        excludes.push(String((await resolveRef(ref)).num))
      let selfNote: string
      if (a.exclude_self === false) {
        selfNote = 'self not excluded (exclude_self: false)'
      } else {
        // The caller's own account is the one it is trying to spare, so it is left out — but
        // only on a PROVEN identity: excluding a guessed number could remove the wrong account
        // while the real one takes the load.
        try {
          const self = await selfIdentity()
          if (
            self.instance &&
            self.confidence === 'exact' &&
            !self.warning &&
            self.instance.kind === 'desktop'
          ) {
            excludes.push(String(self.instance.num))
            selfNote = `excluded self = ${instanceLabel(self.instance)}`
          } else {
            // say the REAL reason (review 2026-09-05: this used to say "not exact" for every
            // branch, including an exact answer that was simply a CLI or Codex instance)
            const why = !self.instance
              ? 'no numbered instance matched this process'
              : self.confidence !== 'exact'
                ? `identity is only ${self.confidence}`
                : self.warning
                  ? `identity carries a warning: ${self.warning}`
                  : `${instanceLabel(self.instance)} is a ${self.instance.kind} instance, which cannot host desktop chats anyway`
            selfNote = `self NOT excluded: ${why} (${self.summary}); pass exclude explicitly if that matters`
          }
        } catch (e) {
          selfNote = `self NOT excluded: identity lookup failed (${e instanceof Error ? e.message : String(e)})`
        }
      }
      for (const n of new Set(excludes)) args.push('--exclude', n)
      if (a.open_closed === true) args.push('--open-closed')
      if (a.force === true) args.push('--force')
      if (a.dry_run === true) args.push('--dry-run')
      // one spawn can take ~4 minutes worst case (trust modal, six submit attempts); a dry run
      // only ranks and plans
      const timeoutMs =
        a.dry_run === true ? 180_000 : Math.min(60 * 60_000, 90_000 + tasks.length * 240_000)
      try {
        return { ...(await runFanOut(args, timeoutMs)), selfNote }
      } finally {
        // a spec that travelled as a temp file is ours to remove once the script has read it
        // (review 2026-09-05: nothing else ever deleted it)
        const specPath = args[1]
        if (specPath !== spec) {
          try {
            unlinkSync(specPath)
          } catch {
            /* already gone, or never written */
          }
        }
      }
    },
  },
  {
    name: 'fan_out_status',
    description:
      "READ-ONLY: where every chat of a fan_out group stands — per member: instance, sessionId, the gate's verdict as one word (working / idle / stalled / finished / crashed, or the spawn state for a member that never got a session), how long it has been quiet, its cause, and its LAST WORDS (the last assistant text, capped) so a manager chat can read seven results without seven tail_session calls. `group` is the id or name from fan_out (a unique id prefix works); omitted = the most recent group. Also lists the follow-ups already sent to the group.",
    inputSchema: S({
      group: {
        type: 'string',
        description: 'Group id, name, or unique id prefix. Default: latest.',
      },
    }),
    run: async (a) => {
      const args = ['status']
      const group = str(a.group).trim()
      if (group) args.push(group)
      args.push('--json')
      return runFanOut(args, 180_000)
    },
  },
  {
    name: 'fan_out_send',
    description:
      "MUTATES: deliver ONE follow-up message into every chat of a fan_out group (or just the `only` session ids) — the steering half of managing a fan-out. THE PEER PIPE IS NOT USED: a spawned chat nobody has clicked never drains peer messages (measured 2026-09-04), so each member's IDLE engine is stopped first (a working or stuck one refuses and that member is skipped with the reason) and the daemon's message route then types the text into the app's OWN composer, which boots the chat and is verified from the transcript. A member whose app has not yet written its sidebar record cannot be reached this way and says so. A HELD chat is skipped and named; `force` is a PERSON's word past a hold. Deliveries are sequential and each waits for the chat to move, so budget ~1-3 minutes per member. Returns per-member delivered / route / detail / engine; the group record keeps every send.",
    inputSchema: S(
      {
        group: { type: 'string', description: 'Group id, name, or unique id prefix.' },
        text: { type: 'string', description: 'The message to deliver into each chat.' },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids to deliver to (default: every member with a session).',
        },
        force: { type: 'boolean', description: "A person's word: deliver past a hold." },
      },
      ['group', 'text'],
    ),
    run: async (a) => {
      const group = str(a.group).trim()
      const text = str(a.text).trim()
      if (!group)
        throw new Error('group is required (fan_out_status with no group shows the latest)')
      if (!text) throw new Error('text is required')
      const args = ['send', group, '--text', text]
      const only = Array.isArray(a.only) ? a.only.map(str).filter((s) => s.trim()) : []
      for (const sid of only) args.push('--only', sid.trim())
      if (a.force === true) args.push('--force')
      args.push('--json')
      return runFanOut(args, 20 * 60_000)
    },
  },
  {
    name: 'fan_out_delete',
    description:
      "MUTATES: DELETE every chat of a fan_out group from the account it lives in — the cleanup a probe or drill fan-out owes (owner rule, 2026-09-04: \"all ping requests or account identification requests must be deleted after they are created and not left in the account\"). Per member, delete_chat.py: an IDLE engine is stopped first (a working or stuck one refuses and that member is reported), an undo copy of the meta record(s) and transcript is taken into orchestrator/state/trash/<sessionId>/, then the running app's OWN Delete control is driven (row menu Delete + the app's confirm button, both by label), then the record and the transcript are removed everywhere, and the result is VERIFIED (dossier empty, transcript gone) — anything left is named, never claimed. A HELD chat is skipped; `force` is a PERSON's word past a hold. `orchestrator_run delete_chat --undo <sessionId>` restores one from its undo copy.",
    inputSchema: S(
      {
        group: { type: 'string', description: 'Group id, name, or unique id prefix.' },
        force: { type: 'boolean', description: "A person's word: delete past a hold." },
      },
      ['group'],
    ),
    run: async (a) => {
      const group = str(a.group).trim()
      if (!group)
        throw new Error('group is required (fan_out_status with no group shows the latest)')
      const args = ['delete', group]
      if (a.force === true) args.push('--force')
      args.push('--json')
      return runFanOut(args, 15 * 60_000)
    },
  },
  {
    name: 'archive_desktop_chat',
    description:
      'MUTATES: archive (archived=true, the default) or unarchive a chat in the Claude DESKTOP app by flipping its per-profile metadata flag. Caveat the caller must relay: for an instance whose app is RUNNING, the change appears only after that instance next restarts (a running app may even re-save the old state); for closed instances it is reliable. The AgentHydra done-mark is the immediate in-AgentHydra signal either way.',
    inputSchema: S({ session_id: { type: 'string' }, archived: { type: 'boolean' } }, [
      'session_id',
    ]),
    run: (a) =>
      api(`/api/sessions/${encodeURIComponent(str(a.session_id))}/desktop-archive`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ archived: a.archived }),
      }),
  },
  // --- self-update ------------------------------------------------------------------
  {
    name: 'check_update',
    description: 'Check whether a AgentHydra update is available (git-based).',
    inputSchema: S(),
    run: () => api('/api/update'),
  },

  // --- the orchestrator ------------------------------------------------------------
  // The Python toolbox under orchestrator/ decides what SHOULD happen to a chat; the daemon runs
  // it on request (server/src/orchestrator.ts). One MCP surface for the whole fleet - an agent
  // no longer has to be told "you have to use both" (owner, 2026-09-03).
  {
    name: 'orchestrator_menu',
    description:
      "READ-ONLY: the orchestrator's own menu - every script it has, grouped OBSERVE (reads only) / ACT (behind the rails) / the loop / the tray switch - plus where the toolbox lives and whether python answers. Read this once before orchestrator_run; the script names here are the only ones it accepts. PREFER `actions` OVER `menu`: it is the same list as DATA, one row per script with its kind (observe/mutate), summary, guards and what its exit codes mean, so nothing has to parse the prose. `actions: null` means it could NOT be read, and `actionsError` says why - it never means the toolbox has no scripts.",
    inputSchema: S(),
    run: () => api('/api/orchestrator'),
  },
  {
    name: 'orchestrator_run',
    description:
      "Run ONE orchestrator script by its menu name (`chats`, `migrate_chat`, `dossier`, `audit_twins`, `archive_chat`, `census`, ...) with its own arguments, exactly as `python orch.py <script> ...` would. OBSERVE scripts are read-only; ACT scripts MUTATE, and they keep every rail they have on the command line: NOTHING ACTS WITHOUT THE TRAY ICON (orchestrator_switch {action:'armed'} tells you), a live chat is never moved or archived, every attempt is counted, and `--force` is a PERSON'S word for one act - pass it only when the human asked for that act. TWO SCRIPTS ARE HAND-RUN AND DO NOT NEED THE ICON: `migrate_chat` and `chats --move-to` (the icon gates the unattended lanes, not a person's own move) - so for a targeted move do NOT arm first: arming resumes `saturate`, which wakes dormant chats, and a chat with a live engine cannot move until it has been quiet 300s. Pass `--idle-wait 330` with `--stop-idle` and the command sleeps out that window itself instead of you retrying on a guess (a working or stuck engine still refuses in a second). Returns stdout, stderr, the exit code and what the driver's codes mean (0 ok · 2 something failed · 3 refused/unknown/not armed · 1 daemon failure); a script's own codes are in its `--help`, which you can run here too (args: ['--help']). Long scripts get `timeout_secs` (default 600, max 3600).",
    inputSchema: S(
      {
        script: {
          type: 'string',
          description: 'A menu name from orchestrator_menu, e.g. "chats" or "migrate_chat".',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for that script, one per element, no shell quoting.',
        },
        timeout_secs: { type: 'number' },
      },
      ['script'],
    ),
    run: async (a) =>
      api('/api/orchestrator/run', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          script: a.script,
          args: Array.isArray(a.args) ? a.args : [],
          timeoutMs: a.timeout_secs != null ? Number(a.timeout_secs) * 1000 : undefined,
        }),
      }),
  },
  {
    name: 'orchestrator_loop',
    description:
      "THE LOOP. Default is DRY: walk the whole orchestration - census, waiting scan, accounts and usage bands, the sweep's four lanes, naming, reconcile, the judgment queue - and print what it WOULD do, touching nothing. This is where stalled chats, holds, collisions, hand-offs and pending deliveries are reported. STOP AND INVESTIGATE if its census sanity rail fails or the plan says INCOMPLETE: a read failed, so every lane is a lower bound. `live: true` MUTATES - the same walk with the acting lanes armed (identical to `sweep --all --yes`), which still does nothing unless the tray icon is up.",
    inputSchema: S({
      live: { type: 'boolean', description: 'Act instead of plan. Default false (dry).' },
      json: { type: 'boolean', description: 'Machine-readable plan (dry only).' },
    }),
    run: async (a) => {
      const args: string[] = []
      if (a.live === true) args.push('--live')
      else if (a.json === true) args.push('--json')
      return api('/api/orchestrator/run', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          script: 'loop',
          args,
          timeoutMs: a.live === true ? 30 * 60_000 : undefined,
        }),
      })
    },
  },
  {
    name: 'orchestrator_switch',
    description:
      "THE TRAY-ICON SWITCH (owner order, 2026-09-01: nothing acts without the status-bar icon, so the owner can always terminate it). `armed` is READ-ONLY and is the FIRST thing to check before expecting any act to land: a disarmed fleet looks exactly like a healthy quiet one. The rest MUTATE the switch: `arm` puts the icon on screen PAUSED (registered, nothing acts yet), `arm_now` arms and starts the lanes, `resume` throws the switch on, `pause` stops the lanes but keeps the icon and dashboard up, `disarm` closes the icon (everything stops). Arm only when the human's message is their hand on the switch; never to make an unattended act possible on your own initiative.",
    inputSchema: S(
      {
        action: {
          type: 'string',
          enum: ['armed', 'arm', 'arm_now', 'resume', 'pause', 'disarm'],
        },
      },
      ['action'],
    ),
    run: async (a) => {
      const action = str(a.action)
      const argv: Record<string, string[]> = {
        armed: ['armed'],
        arm: ['arm'],
        arm_now: ['arm', '--now'],
        resume: ['resume'],
        pause: ['pause'],
        disarm: ['disarm'],
      }
      const words = argv[action]
      if (!words) throw new Error(`action must be one of ${Object.keys(argv).join(', ')}`)
      const [script, ...args] = words
      return api('/api/orchestrator/run', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ script, args, timeoutMs: 120_000 }),
      })
    },
  },
]

export const SERVER_INFO = { name: 'agenthydra', version: VERSION }

/**
 * STANDING INSTRUCTIONS, handed to the model in the MCP `initialize` handshake, before it calls
 * anything.
 *
 * WHY THIS EXISTS. A tool description is only read once the model has already decided to call that
 * tool, which is useless for the behaviour that matters here: checking your quota BEFORE the
 * expensive thing, and saving your work BEFORE you are cut off. Neither is discoverable from a
 * tool list. Without this block those rules had to be typed into a human's prompt every session,
 * and the one session where nobody typed them is the session that runs out of quota mid-task.
 *
 * WHY IT IS THIS SHORT. It is in context for the entire session, on every request, so every line
 * is rent. Rules only, no explanation, no API shapes (docs/AI_USAGE_SELFCHECK.md holds the
 * reasoning). If a line would not change what an agent DOES, it does not belong here.
 */
export const SERVER_INSTRUCTIONS = `AgentHydra manages every Claude/Codex account on this machine and knows what each has left.

CHECK YOUR OWN QUOTA BEFORE HEAVY WORK, unprompted: check_my_usage {} works out which account
you are and reads it (~300ms, no quota, works with the app closed). Then act on the answer:
- advice.shouldOffload true -> WRITE YOUR CONTEXT, FINDINGS AND NEXT STEPS TO A FILE NOW. An
  agent that runs out mid-task dies holding everything it had not saved.
- advice.safeToFanOut false -> shrink or postpone the fan-out. Gate on CURRENT + PROJECTED cost:
  a fan-out cannot be recalled once launched, solo work can be stopped at any tool call.
- A percentage decides nothing alone; usage_budget {} gives exhaustsBeforeReset, branch on that.
- The weekly (all-models) % is the binding cap, except on Pro, where the 5-hour window usually
  binds first. Switching model does not dodge the shared weekly bucket.
- severity 'unknown' or a failed read is NOT "plenty left". Never fan out on an unverified read.

NEVER QUOTE AN UNATTRIBUTED PERCENTAGE: name the instance. If identity.warning is present, say
so. A human who tells you your instance number OVERRULES the detection; the config files on this
machine are exactly what lie about it.

list_usage {} surveys every account; route heavy work by instance number. Mutating tools say
MUTATES:; never run /login for a human.

THE ORCHESTRATOR IS INSIDE THIS SERVER (orchestrator_menu/run/loop/switch); nothing there acts
unless the tray icon is up: orchestrator_switch {action:"armed"} first. One-call paths needing
no icon: move_chat {chat, from, to} moves a chat between accounts; fan_out {tasks:[{cwd, prompt}]}
spreads a task list over OTHER accounts as VISIBLE desktop chats, one each, then fan_out_status {}
reads every member's verdict and last words and fan_out_send {group, text} steers them all.
add_queue_item and launch_terminal_session are REFUSED here (no chat nobody can see).
ANY PROBE CHAT YOU CREATE (a ping, a which-account check, a drill) MUST BE DELETED AFTERWARDS,
never left in the account: fan_out_delete {group}, or orchestrator_run delete_chat <chat>.`

/** The stdio loop, callable from main.ts's `--mcp` subcommand (the compiled exe's MCP mode). */
export function runMcp(): Promise<void> {
  return runMcpStdio({ serverInfo: SERVER_INFO, tools: TOOLS, instructions: SERVER_INSTRUCTIONS })
}

// Only run the stdio loop when this file is the entry point (`bun run mcp`), not when a test
// imports TOOLS/daemonBase — Bun sets import.meta.main false for module imports.
if (import.meta.main) {
  await runMcp()
}
