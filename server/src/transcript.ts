import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { stat as statAsync } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { extraRootsWithFormat } from './agent-catalog'
import {
  CLAUDE_PROJECTS_ROOT,
  CODEX_ARCHIVED_SESSIONS_ROOT,
  CODEX_SESSION_INDEX_PATH,
  CODEX_SESSIONS_ROOT,
  OPENCODE_DB_PATH,
} from './config'
import {
  type ForeignSession,
  listForeignSessions,
  listForeignSessionsAsync,
  readForeignSession,
} from './foreign-sessions'
import {
  type HermesStore,
  listHermesSessions,
  listHermesStores,
  readHermesSession,
} from './hermes-sessions'
import { listOpenCodeSessions, readOpenCodeSession } from './opencode-sessions'
import {
  type ContinuationLink,
  pruneContinuationHeadCache,
  readContinuationLink,
  resolveContinuations,
  supersededSessions,
} from './session-continuations'
import { dedupeKey, makeLocator, matchesLocator, parseLocator } from './session-locator'
import type { SessionSource, TailEvent, TailResult } from './types'

// --- cwd folder-name encoding (forward only; reverse is lossy) --------------

/** Mirror Claude Code's project-folder key: non [A-Za-z0-9_-] chars collapse to '-'. */
export function encodeCwdKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9_-]/g, '-')
}

/** Best-effort reverse of a project folder name back to a path (only used if no cwd on events). */
export function decodeProjectKey(key: string): string {
  // e.g. "C--Projects-MyApp" -> "C:\Projects\MyApp" (heuristic)
  const m = key.match(/^([A-Za-z])--(.*)$/)
  if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`
  return key.replace(/-/g, '/')
}

// --- transcript file index (TTL-cached) -------------------------------------

export interface TranscriptFile {
  session_id: string
  source: SessionSource
  path: string
  project: string
  mtime_ms: number
  size_bytes: number
  archived: boolean
  /** OpenCode already stores these as indexed columns, so metadata scans need not re-derive them. */
  title?: string
  cwd?: string
  created_at?: number | null
  /**
   * The OTHER files carrying this same session id.
   *
   * In practice one case: a rollout briefly visible in both the live and archived roots while a move
   * settles. Deliberately NOT the conversation's subagent rollouts — those replay a session-wide
   * token counter, so treating them as extra files to add multiplied Codex spend by 53x before this
   * was understood. A total must take the LARGEST of these, never their sum; see
   * server/src/analytics.ts.
   */
  siblingPaths?: string[]
  /**
   * Which PRODUCT wrote this, as an agent-catalog.ts id.
   *
   * `source` is the FORMAT — which reader can parse the file — and several products share one.
   * OpenClaude forked Claude Code and kept its JSONL, so its sessions are `source: 'claude'` and
   * would otherwise be indistinguishable from Claude Code's on screen. This is the field that says
   * which tool the user actually ran.
   */
  tool?: string
  /**
   * The session that spawned this one, when the store records a subagent as a session of its own.
   *
   * Set by the OpenCode reader, which is the only store that keeps its subagents as sibling rows in
   * the same table rather than as nested files: Claude's are folded into the parent by
   * {@link claudeParentId} and Codex's are dropped by `isSubagent` before they ever reach the index.
   *
   * A row carrying this stays in the index ON PURPOSE. It is a real session — its own messages, its
   * own model, its own tokens (1.74M of them on this machine, a sixth of all OpenCode spend), and
   * analytics reads it by id like any other, so dropping it here would delete that money from every
   * total. It is filtered out one layer up, where the list of CONVERSATIONS is built.
   */
  parentId?: string | null
  /**
   * The session that CONTINUED this one, when a compaction moved the conversation into a new file.
   *
   * Claude Code does not keep writing to a transcript it has compacted: it opens a new file with a
   * new session id and carries on, so one conversation becomes two, three, four transcripts that an
   * index keyed on session id has no way to tell apart from separate chats. This is that link, and
   * the session list uses it to show the conversation once. See server/src/session-continuations.ts.
   *
   * The row stays in the index. It is a real transcript holding real turns and real spend, and
   * analytics reads it by id like any other; it is folded together only where CONVERSATIONS are
   * listed, which is the same treatment subagents get.
   */
  supersededBy?: string
  /**
   * The opaque, versioned session-locator.ts identity for THIS row: `source` + product identity
   * + physical store, never just source + session_id.
   *
   * `source` is a FORMAT and `session_id` alone is not unique across it — two OpenCode-format
   * products (Kilo, MiMo Code) or two Hermes profiles can hold the same session id (audit AH-35).
   * This is what every route, the done-mark key and the index's own de-dup now key on instead, so a
   * caller that already knows which exact row it means (because it just listed it) can say so
   * rather than falling back to the first match for `source` alone. Always set by finishIndex.
   */
  locator?: string
}

let cache: { at: number; files: TranscriptFile[] } | null = null
/**
 * How long a snapshot is trusted before a background sweep is started.
 *
 * This has to be LONGER THAN A SWEEP TAKES, or the snapshot is already stale when it lands and the
 * next request starts another one — the daemon then rebuilds forever. That is not hypothetical: at
 * the old 2 s, against a store of ~23,000 transcripts where a sweep measures ~9 s, the index was
 * being rebuilt continuously and each rebuild blocked the event loop, so `/api/health` — a route
 * that reads nothing — answered in 6.6 s. Opening a chat took 16-23 s regardless of its size,
 * because the wait was the queue, not the file.
 *
 * Two other things keep that from coming back: {@link finishIndex} stamps the snapshot when the
 * sweep FINISHES (stamping the start is what made a 2 s window unsatisfiable), and background
 * revalidation goes through {@link startIndexBuild}, which is async and never blocks a request.
 *
 * There is a ceiling as well as a floor, and it is the web app's 12 s session-list poll. Set this
 * ABOVE that interval and the poll which notices the snapshot is stale lands only every OTHER tick,
 * so a new or renamed session waits two full cycles to appear rather than one. Ten seconds sits
 * between the two bounds: ~10x a warm sweep, and just under the poll that consumes it.
 */
const TTL_MS = 10_000

export interface CodexRolloutIdentity {
  sessionId: string
  isSubagent: boolean
}

/**
 * Codex writes one rollout per execution thread, including every spawned subagent. The filename
 * suffix and payload.id identify that rollout, while payload.session_id identifies the user-owned
 * chat all of those threads belong to. Only the top-level rollout is the conversation shown by
 * Codex itself; indexing child rollouts produces dozens of overlapping rows with the same title.
 */
export function codexRolloutIdentity(event: unknown, fallbackId: string): CodexRolloutIdentity {
  const payload =
    event &&
    typeof event === 'object' &&
    (event as any).type === 'session_meta' &&
    (event as any).payload &&
    typeof (event as any).payload === 'object'
      ? (event as any).payload
      : null
  const sessionId =
    typeof payload?.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : fallbackId
  const isSubagent =
    payload?.thread_source === 'subagent' ||
    !!(payload?.source && typeof payload.source === 'object' && payload.source.subagent)
  return { sessionId, isSubagent }
}

const codexIdentityCache = new Map<string, CodexRolloutIdentity>()

export interface CodexSessionIndexEntry {
  title: string
  updatedAt: number | null
}

/** Parse Codex Desktop's append-style sidebar index. Later rows win when a title is regenerated or
 * renamed, while malformed/incomplete rows are ignored so an active write cannot break browsing. */
export function parseCodexSessionIndex(text: string): Map<string, CodexSessionIndexEntry> {
  const entries = new Map<string, CodexSessionIndexEntry>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row?.id !== 'string' || typeof row?.thread_name !== 'string') continue
    const id = row.id.trim()
    const title = row.thread_name.trim()
    if (!id || !title) continue
    const timestamp = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN
    entries.set(id, {
      title,
      updatedAt: Number.isNaN(timestamp) ? null : timestamp,
    })
  }
  return entries
}

let codexSessionIndexCache:
  | {
      mtimeMs: number
      size: number
      entries: Map<string, CodexSessionIndexEntry>
    }
  | undefined

function readCodexSessionIndex(): Map<string, CodexSessionIndexEntry> {
  try {
    const stat = statSync(CODEX_SESSION_INDEX_PATH)
    if (
      codexSessionIndexCache?.mtimeMs === stat.mtimeMs &&
      codexSessionIndexCache.size === stat.size
    )
      return codexSessionIndexCache.entries
    const entries = parseCodexSessionIndex(readFileSync(CODEX_SESSION_INDEX_PATH, 'utf8'))
    codexSessionIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries }
    return entries
  } catch {
    return new Map()
  }
}

/** Read only the first JSONL record. Session metadata can be tens of KB because it includes base
 * instructions, while the rollout itself can be many MB; loading the whole file here would make
 * every session-list refresh unnecessarily expensive. */
function readCodexRolloutIdentity(path: string, fallbackId: string): CodexRolloutIdentity {
  const cached = codexIdentityCache.get(path)
  if (cached) return cached

  const chunks: Buffer[] = []
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let total = 0
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    while (total < 1024 * 1024) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      const newline = chunk.subarray(0, read).indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)))
        break
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)))
      total += read
    }
  } catch {
    // Active rollouts can move to the archive between discovery and this read.
    return { sessionId: fallbackId, isSubagent: false }
  } finally {
    if (fd !== null) closeSync(fd)
  }

  let event: unknown = null
  try {
    event = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())
  } catch {
    // A just-created or legacy malformed rollout still remains discoverable by its filename.
  }
  const identity = codexRolloutIdentity(event, fallbackId)
  // Do not pin a failed/incomplete first-line read forever; the next index refresh may see it after
  // Codex has finished writing the session_meta record.
  if (event) codexIdentityCache.set(path, identity)
  return identity
}

/**
 * Async twin of {@link readCodexRolloutIdentity}, for the non-blocking index build.
 *
 * Same contract and the same shared cache; the only difference is that it never holds the event
 * loop. The 64 KiB first slice is the overwhelmingly common case (a session_meta record is a few
 * KB); the 1 MiB retry matches the sync reader's ceiling for a pathological single-line head.
 */
async function readCodexRolloutIdentityAsync(
  path: string,
  fallbackId: string,
): Promise<CodexRolloutIdentity> {
  const cached = codexIdentityCache.get(path)
  if (cached) return cached

  let head = ''
  try {
    const file = Bun.file(path)
    head = await file.slice(0, 64 * 1024).text()
    if (!head.includes('\n') && file.size > 64 * 1024)
      head = await file.slice(0, 1024 * 1024).text()
  } catch {
    // Active rollouts can move to the archive between discovery and this read.
    return { sessionId: fallbackId, isSubagent: false }
  }

  const newline = head.indexOf('\n')
  let event: unknown = null
  try {
    event = JSON.parse((newline >= 0 ? head.slice(0, newline) : head).trim())
  } catch {
    // A just-created or legacy malformed rollout still remains discoverable by its filename.
  }
  const identity = codexRolloutIdentity(event, fallbackId)
  if (event) codexIdentityCache.set(path, identity)
  return identity
}

/** Bounded-concurrency map, local so this module stays free of a cycle back through sessions.ts. */
async function mapPool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!)
  })
  await Promise.all(workers)
  return out
}

/**
 * The one in-flight sweep, shared by every path that can start one.
 *
 * ONE guard, not two. The sync and async builders used to keep separate ones (`refreshing` here and
 * `indexBuild` down by ensureTranscriptIndex), which did not see each other — so a background
 * revalidate and a request-driven build could sweep the same store at the same time, each paying
 * the other's cost on top of its own.
 */
let indexBuild: Promise<TranscriptFile[]> | null = null

/**
 * Start a sweep unless one is already running, and hand back whichever is now in flight.
 *
 * Never rejects: a sweep that fails leaves the previous snapshot in place and the next caller tries
 * again, which is the same bargain the old catch made.
 */
function startIndexBuild(): Promise<TranscriptFile[]> {
  if (!indexBuild) {
    indexBuild = buildTranscriptIndexAsync()
      .catch(() => cache?.files ?? [])
      .finally(() => {
        indexBuild = null
      })
  }
  return indexBuild
}

let freshBuild: Promise<TranscriptFile[]> | null = null

/**
 * A sweep guaranteed to have STARTED after this call, for a caller that needs to know what is on
 * disk right now.
 *
 * {@link startIndexBuild} cannot answer that. It coalesces onto whatever is already running, which
 * is exactly right for "the snapshot is getting old" and exactly WRONG for a miss: a sweep that
 * began before the transcript was written enumerated a filesystem the new file was not in, so
 * joining it returns the same miss and then stamps the snapshot fresh for another full TTL. A
 * just-dispatched run would read as "transcript not found" long past the one sweep the miss path is
 * meant to cost.
 *
 * So this WAITS OUT any in-flight sweep and then starts its own. Concurrent callers still share one
 * — the point is that the sweep began after they asked, not that each gets a private one.
 */
function startFreshIndexBuild(): Promise<TranscriptFile[]> {
  if (freshBuild) return freshBuild
  const running = indexBuild
  freshBuild = (running ? running.then(noop, noop) : Promise.resolve())
    .then(() => startIndexBuild())
    .finally(() => {
      freshBuild = null
    })
  return freshBuild
}

function noop(): void {}

/**
 * The store's file index: every transcript's id, mtime and size.
 *
 * Served stale-while-revalidate, because building it is the one cost in this app that scales with
 * how much history you have KEPT rather than with what you asked to see: it globs the whole store
 * and stats every file (measured: 145 ms warm / 414 ms cold for 1,255 transcripts, and ~9 s at
 * 23,000). Paying that inside a request put a folder-sized tax on every poll. Callers now get the
 * last snapshot immediately and a fresh sweep runs just after, so request latency tracks the number
 * of rows asked for, not the size of ~/.claude.
 *
 * `force` is for the two callers that cannot tolerate a stale answer — looking up a session that
 * ISN'T in the snapshot, which is exactly what a just-created transcript looks like.
 */
export function listTranscriptFiles(force = false): TranscriptFile[] {
  const now = performance.now()
  if (!force && cache) {
    // The ASYNC builder, and this is the whole point. Revalidating through the SYNC one — which is
    // what the setTimeout here used to do — held the event loop for the entire sweep, so the
    // "background" refresh was really a full stop for every request in flight. Measured: an
    // /api/health that reads nothing answered in 6.6 s while one of these ran.
    if (now - cache.at >= TTL_MS) void startIndexBuild()
    return cache.files
  }
  return buildTranscriptIndex()
}

let lastMissSweepAt = Number.NEGATIVE_INFINITY

/**
 * How long after one miss-driven sweep before another may start.
 *
 * Separate from TTL_MS on purpose. This throttle exists for the id that will NEVER be found — a
 * deleted transcript the UI is still polling every 4 s — and its job is to stop that poll buying a
 * sweep apiece. It is deliberately shorter than TTL_MS because the sweep it gates is now async and
 * coalesced, so the cost of being wrong is CPU rather than a frozen daemon.
 */
const MISS_SWEEP_MS = 5_000

/** Whether a fresh miss-driven sweep is allowed to start, recording the decision when it is. */
function claimMissSweep(): boolean {
  const now = performance.now()
  if (cache && now - lastMissSweepAt < MISS_SWEEP_MS) return false
  lastMissSweepAt = now
  return true
}

/**
 * The index as seen after a miss, for a SYNCHRONOUS caller.
 *
 * It does NOT sweep. It cannot: the only sweep available to a sync function is the blocking one,
 * and this is the path a poll for a not-yet-indexed session takes every few seconds — which is how
 * the daemon used to freeze for the length of a whole-store scan several times a minute. So it
 * starts an async sweep and answers from the snapshot it has. A caller that genuinely needs the
 * just-created transcript in THIS call should be async and use {@link findTranscriptAsync}, which
 * can wait for that sweep without stopping the loop for everyone else.
 */
export function listTranscriptFilesAfterMiss(): TranscriptFile[] {
  if (claimMissSweep()) void startFreshIndexBuild()
  return cache?.files ?? buildTranscriptIndex()
}

/**
 * The index as seen after a miss, for a caller that can wait — and every caller that can, should.
 *
 * This is the honest version of the contract the sync one used to claim: a transcript created
 * moments ago really is worth re-globbing the store for, and awaiting the async builder gets that
 * answer without holding the event loop while it happens.
 *
 * A sweep ALREADY UNDER WAY is joined whether or not the throttle would allow a new one. It costs
 * nothing to await something that is running regardless, and refusing would answer "not found" for
 * a session the sweep two milliseconds from finishing is about to reveal. The throttle exists to
 * stop a poll for a session that will never exist from STARTING sweeps, which is a different thing.
 */
async function ensureTranscriptIndexAfterMiss(): Promise<TranscriptFile[]> {
  if (freshBuild) return freshBuild
  if (!claimMissSweep()) return cache?.files ?? []
  return startFreshIndexBuild()
}

/**
 * Every transcript root is created lazily by the CLI that owns it, so on a machine that has never
 * run Claude (or Codex, or archived a rollout) the folder simply is not there — and `scanSync`
 * answers a missing root by THROWING ENOENT rather than yielding nothing. An absent store is not an
 * error, it is an empty one.
 *
 * This is load-bearing, not defensive dressing: the index is warmed at startup from an unawaited
 * call, so the throw surfaced as an unhandled rejection and killed the daemon before it could serve
 * /api/health. A fresh install saw a process that exited instead of an empty Sessions list. The
 * release smoke job caught it on all three OSes; nothing on a developer machine can, because every
 * developer machine has the folders.
 *
 * Materialized inside the try because the iterator throws lazily: the ENOENT arrives on first
 * advance, not at the scanSync call, so wrapping only the call would catch nothing.
 */
function scanRootSync(glob: Bun.Glob, cwd: string): string[] {
  try {
    // `dot: true` because a real store hides transcripts behind a dot directory: Cowork's sandbox
    // keeps the run's own Claude Code home at `local_<id>/.claude/projects/...`, and the default
    // scan silently skipped every one of them. Found by the store audit, not by reading this line.
    return [...glob.scanSync({ cwd, onlyFiles: true, dot: true })]
  } catch {
    return []
  }
}

/** Async twin of {@link scanRootSync}, with the same "a missing root is an empty one" contract.
 *  The iterator throws lazily too, so the `for await` has to be INSIDE the try. */
async function scanRootAsync(glob: Bun.Glob, cwd: string): Promise<string[]> {
  const out: string[] = []
  try {
    // See scanRootSync: a dot directory can hold real transcripts.
    for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: true })) out.push(rel)
  } catch {
    return out
  }
  return out
}

/**
 * Every JSONL under a Claude store, not just the top level.
 *
 * WHY IT IS NOT ONE LEVEL DEEP ANY MORE. A Task-tool subagent gets its OWN transcript, at
 * `<project>/<parent-session>/subagents/agent-<id>.jsonl` (one level deeper again for workflows),
 * carrying its parent's session id and its own `usage` blocks. Those are separate API calls and
 * separate money. Measured on this machine: 1,229 top-level transcripts hold 64.5 BILLION tokens
 * and 16,552 subagent transcripts hold another 89.8 billion, so the old glob was showing 42% of
 * real Claude spend and calling it the total.
 *
 * They are still not session ROWS — a subagent is an implementation detail of the turn that spawned
 * it, and listing thousands of them would bury the conversations. They attach to their parent as
 * siblings, which only a total ever reads. See claudeParentId.
 */
const CLAUDE_TRANSCRIPT_GLOB = '**/*.jsonl'
const CODEX_ROLLOUT_GLOB = '**/rollout-*.jsonl'
/** How many files the async build stats/reads at once. Wide enough to keep the disk busy, bounded
 *  so a huge store cannot open thousands of handles at once. */
const INDEX_SCAN_WIDTH = 24

/** One claude-format store to scan: where it is, how its files are laid out, and whose it is. */
interface ClaudeStore {
  root: string
  tool: string
  glob: string
  idFrom: 'basename' | 'parent-dir'
  idPrefix: string
  /** When set, only this filename is a session; everything else attaches to the nearest ancestor
   *  directory whose name starts with idPrefix. See AgentTool.sessionFile. */
  sessionFile: string
}

/** `<project>/<session-id>.jsonl` — Claude Code's own layout, and every fork's. */
const CLAUDE_STORE_DEFAULTS = {
  glob: CLAUDE_TRANSCRIPT_GLOB,
  idFrom: 'basename' as const,
  idPrefix: '',
  sessionFile: '',
}

/**
 * The session id in a matched path.
 *
 * Two rules because two layouts exist. Claude Code names the FILE after the session, so the
 * basename is the id. Cowork writes every run to a fixed `audit.jsonl` inside a directory named
 * after the session, so the id is that directory — reading the basename there would give every
 * Cowork session the id "audit" and collapse the whole store into one row.
 */
function claudeSessionId(rel: string, store: ClaudeStore): string {
  const parts = rel.split(/[\\/]/)
  const raw =
    store.idFrom === 'parent-dir'
      ? (parts[parts.length - 2] ?? '')
      : (parts[parts.length - 1] ?? '').replace(/\.jsonl$/, '')
  return store.idPrefix && raw.startsWith(store.idPrefix) ? raw.slice(store.idPrefix.length) : raw
}

/**
 * The session a nested transcript belongs to, or null when the path IS a session's own transcript.
 *
 * Claude Code nests a subagent under the session that spawned it, so the parent id is simply the
 * directory below the project. Returning null for a two-segment path is what keeps a real session a
 * row rather than a sibling of itself.
 */
export function claudeParentId(rel: string, store: ClaudeStore): string | null {
  const parts = rel.split(/[\\/]/)
  const name = parts[parts.length - 1] ?? ''

  // A store that NAMES its session file (Cowork) decides by name, not by depth: its runs sit at
  // several depths, and each run directory also contains a whole Claude Code home of its own —
  // the CLI's transcript and that session's subagents/ tree, which are the same run's spend.
  if (store.sessionFile) {
    const owner = lastIndexStartingWith(parts, store.idPrefix)
    if (owner < 0) return null
    // The session file, directly inside the run's own directory, IS the session.
    if (name === store.sessionFile && owner === parts.length - 2) return null
    const raw = parts[owner] as string
    return raw.startsWith(store.idPrefix) ? raw.slice(store.idPrefix.length) : raw
  }

  // `<project>/<session>.jsonl` is a session; anything deeper is a subagent of parts[1].
  if (parts.length <= 2) return null
  return parts[1] ?? null
}

/** Index of the last path segment beginning with `prefix`, or -1. An empty prefix matches nothing,
 *  which is what keeps this out of the default layout's way. */
function lastIndexStartingWith(parts: string[], prefix: string): number {
  if (!prefix) return -1
  for (let i = parts.length - 1; i >= 0; i--) if ((parts[i] ?? '').startsWith(prefix)) return i
  return -1
}

function claudeRecord(rel: string, mtimeMs: number, sizeBytes: number, store: ClaudeStore) {
  return {
    session_id: claudeSessionId(rel, store),
    source: 'claude' as const,
    path: join(store.root, rel),
    project: rel.split(/[\\/]/)[0] ?? store.tool,
    mtime_ms: mtimeMs,
    size_bytes: sizeBytes,
    archived: false,
    tool: store.tool,
  }
}

/**
 * A nested transcript whose owning session does not exist becomes a session itself.
 *
 * Found by the store audit rather than by reasoning: some Cowork runs write the sandbox's own
 * Claude Code transcript but never an `audit.jsonl`, so attaching their files to an owner that is
 * not there would drop the run entirely. Nothing may be silently unowned — either it belongs to a
 * session or it IS one.
 */
function promoteOrphans(
  files: TranscriptFile[],
  children: Map<string, string[]>,
  pending: Array<{
    parentId: string
    rel: string
    store: ClaudeStore
    mtimeMs: number
    size: number
  }>,
): void {
  const known = new Set(files.map((f) => f.session_id))
  for (const c of pending) {
    if (known.has(c.parentId)) {
      rememberChild(children, c.parentId, join(c.store.root, c.rel))
      continue
    }
    const orphan = { ...c.store, idFrom: 'basename' as const, idPrefix: '' }
    files.push(claudeRecord(c.rel, c.mtimeMs, c.size, orphan))
  }
}

/** Every claude-format store on this machine: Claude Code's own, then the catalog's. */
function claudeStores(): ClaudeStore[] {
  const stores: ClaudeStore[] = [
    { root: CLAUDE_PROJECTS_ROOT, tool: 'claude-code', ...CLAUDE_STORE_DEFAULTS },
  ]
  for (const r of extraRootsWithFormat('claude')) {
    stores.push({
      root: r.root,
      tool: r.tool.id,
      glob: r.tool.glob ?? CLAUDE_STORE_DEFAULTS.glob,
      idFrom: r.tool.idFrom ?? CLAUDE_STORE_DEFAULTS.idFrom,
      idPrefix: r.tool.idPrefix ?? CLAUDE_STORE_DEFAULTS.idPrefix,
      sessionFile: r.tool.sessionFile ?? CLAUDE_STORE_DEFAULTS.sessionFile,
    })
  }
  return stores
}

/** The rollout uuid embedded in the filename — the identity fallback when the first record does
 *  not parse (a rollout still being written, or a legacy shape). */
function codexFallbackId(rel: string): string {
  const name = basename(rel).replace(/\.jsonl$/, '')
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? name
}

function codexRecord(
  root: string,
  rel: string,
  archived: boolean,
  mtimeMs: number,
  sizeBytes: number,
  identity: CodexRolloutIdentity,
  indexed: CodexSessionIndexEntry | undefined,
  tool = 'codex',
): TranscriptFile {
  return {
    session_id: identity.sessionId,
    source: 'codex',
    path: join(root, rel),
    project: tool,
    mtime_ms: Math.max(mtimeMs, indexed?.updatedAt ?? 0),
    size_bytes: sizeBytes,
    archived,
    title: indexed?.title,
    tool,
  }
}

function openCodeRecords(dbPath: string = OPENCODE_DB_PATH, tool = 'opencode'): TranscriptFile[] {
  return listOpenCodeSessions(dbPath).map((session) => ({
    session_id: session.session_id,
    source: 'opencode' as const,
    path: dbPath,
    project: session.project,
    mtime_ms: session.last_activity_at,
    size_bytes: session.size_bytes,
    archived: session.archived,
    title: session.title,
    cwd: session.cwd,
    created_at: session.created_at,
    parentId: session.parent_id,
    tool,
  }))
}

/** One Hermes store's sessions, as index rows. `store.profile` is carried through as `project` and
 *  as the `tool` catalog id stays `hermes` regardless of profile — a profile is a second database,
 *  not a second product. */
function hermesRecords(store: HermesStore, tool = 'hermes'): TranscriptFile[] {
  return listHermesSessions(store.dbPath, store.profile).map((session) => ({
    session_id: session.session_id,
    source: 'hermes' as const,
    path: store.dbPath,
    project: session.project,
    mtime_ms: session.last_activity_at,
    size_bytes: session.size_bytes,
    archived: session.archived,
    title: session.title,
    cwd: session.cwd,
    created_at: session.created_at,
    parentId: session.parent_id,
    tool,
  }))
}

/**
 * The stores from the catalog that are NOT one of the three built-ins.
 *
 * Each is read with the reader its format names, because that is what "same format" means: an
 * OpenClaude transcript is a Claude Code transcript, a TraeX rollout is a Codex rollout, and Kilo
 * is OpenCode's SQLite under another filename. If one of those claims turns out to be wrong the
 * store simply parses to nothing — the reader either finds records or it does not, and either way
 * the three original stores are untouched.
 */
function foreignRow(s: ForeignSession, toolId: string): TranscriptFile {
  return {
    session_id: s.session_id,
    source: 'foreign',
    path: s.path,
    project: s.project,
    mtime_ms: s.last_activity_at,
    size_bytes: s.size_bytes,
    archived: s.archived,
    title: s.title,
    cwd: s.cwd,
    created_at: s.created_at,
    tool: toolId,
  }
}

/**
 * Every foreign store's sessions, without holding the event loop.
 *
 * The sync version below is still right for a sync caller, but this is the one the whole-store
 * sweep uses. A VS Code store has to be JSON-parsed in full to be listed at all, which measured
 * 5.2 s cold — a single unbroken block inside the "async" builder, which froze the daemon for about
 * six seconds on the first sweep after launch until the adapter learned to yield.
 */
async function foreignRecordsAsync(): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = []
  for (const r of extraRootsWithFormat('foreign'))
    for (const s of await listForeignSessionsAsync(r.tool.id, r.root))
      out.push(foreignRow(s, r.tool.id))
  return out
}

/** Every foreign store's sessions, as index rows. One adapter per tool; see foreign-sessions.ts. */
function foreignRecords(): TranscriptFile[] {
  const out: TranscriptFile[] = []
  for (const r of extraRootsWithFormat('foreign')) {
    for (const s of listForeignSessions(r.tool.id, r.root)) {
      out.push({
        session_id: s.session_id,
        source: 'foreign',
        path: s.path,
        project: s.project,
        mtime_ms: s.last_activity_at,
        size_bytes: s.size_bytes,
        archived: s.archived,
        title: s.title,
        cwd: s.cwd,
        created_at: s.created_at,
        tool: r.tool.id,
      })
    }
  }
  return out
}

function extraStoreRecords(): {
  codex: Array<{ root: string; tool: string; archived: boolean }>
  openCodeFiles: TranscriptFile[]
  hermesFiles: TranscriptFile[]
} {
  const codex = extraRootsWithFormat('codex').map((r) => ({
    root: r.root,
    tool: r.tool.id,
    archived: r.archived,
  }))
  const openCodeFiles: TranscriptFile[] = []
  for (const r of extraRootsWithFormat('opencode')) {
    if (!r.tool.dbName) continue
    try {
      openCodeFiles.push(...openCodeRecords(join(r.root, r.tool.dbName), r.tool.id))
    } catch {
      // A store whose schema is not actually OpenCode's contributes nothing, which is the whole
      // safety story for a speculative entry.
    }
  }
  // Hermes' own profiles (a second, third… database under the SAME catalog root) are not
  // themselves catalog rows, so they are not something extraRootsWithFormat can hand back — they
  // are found by listHermesStores, one root at a time.
  const hermesFiles: TranscriptFile[] = []
  for (const r of extraRootsWithFormat('hermes')) {
    if (!r.tool.dbName) continue
    try {
      for (const store of listHermesStores(r.root, r.tool.dbName))
        hermesFiles.push(...hermesRecords(store, r.tool.id))
    } catch {
      // A store whose schema is not actually Hermes' contributes nothing, same safety story as above.
    }
  }
  return { codex, openCodeFiles, hermesFiles }
}

/** A moved JSONL can briefly appear in both active and archived roots while filesystem caches
 *  settle. Source + id is the identity; newest wins, matching findTranscript's old behavior. */
/**
 * One row per session, keeping the newest file as its face — and REMEMBERING the rest.
 *
 * The dedupe is what makes the session list a list of conversations rather than of files, and it
 * has to stay. What it must not do is destroy the fact that the others existed: Codex writes a
 * rollout per execution thread, so a conversation is routinely hundreds of files. What those extra
 * files are NOT is extra spend: Codex's token counter is session-wide and every thread replays the
 * whole counter into its own file, so a total that adds them multiplies it (measured: 11.9B tokens
 * reported as 637B). Subagent rollouts are therefore not carried here at all. `siblingPaths` exists
 * for the genuine case — the same rollout appearing in both the live and archived roots while a move
 * settles — and server/src/analytics.ts takes the LARGEST of them rather than the sum, so even that
 * cannot double count.
 */
/** One session can spawn thousands of subagents; capped so a runaway fan-out cannot put an
 *  unbounded array on an index row. */
const MAX_CHILD_PATHS = 4000

function rememberChild(map: Map<string, string[]>, sessionId: string, path: string): void {
  const list = map.get(sessionId)
  if (!list) {
    map.set(sessionId, [path])
    return
  }
  if (list.length < MAX_CHILD_PATHS) list.push(path)
}

function finishIndex(
  files: TranscriptFile[],
  /** Claude subagent transcripts, by the session that spawned them. Their spend is the parent's. */
  claudeChildren?: Map<string, string[]>,
): TranscriptFile[] {
  const unique = new Map<string, TranscriptFile>()
  const siblings = new Map<string, string[]>()
  for (const file of files) {
    // source + PRODUCT + STORE, not just source + session_id (audit AH-35): a bare source+id key
    // collapsed two OpenCode-format products (Kilo, MiMo Code) holding the same session id into one
    // row, keeping only the newer. dedupeKey still merges the genuine same-store case this dedup
    // exists for — a Codex rollout briefly visible in both the live and archived roots while a move
    // settles — because storeKeyOf treats codex's live+archived roots as one family. See
    // session-locator.ts.
    const key = dedupeKey(file)
    const paths = siblings.get(key)
    if (paths) paths.push(file.path)
    else siblings.set(key, [file.path])
    const previous = unique.get(key)
    if (!previous || file.mtime_ms >= previous.mtime_ms) unique.set(key, file)
  }
  const result: TranscriptFile[] = [...unique.values()].map((file): TranscriptFile => {
    const key = dedupeKey(file)
    // Only the OTHERS: `path` is already read by every caller, and listing it twice would double
    // that file's tokens.
    const rest = (siblings.get(key) ?? []).filter((p) => p !== file.path)
    // A Claude session's subagent transcripts are separate API calls and separate money, so they
    // join the files a total must read. Safe to ADD here, unlike Codex's rollouts, because every
    // record carries its own request id and the usage parser charges a request once.
    if (file.source === 'claude')
      for (const p of claudeChildren?.get(file.session_id) ?? []) if (p !== file.path) rest.push(p)
    const withSiblings = rest.length ? { ...file, siblingPaths: rest } : file
    // Computed once per sweep, not on demand: every row gets a stable public identity whether or
    // not a caller ever asks for it, so a session found through the plain list is immediately
    // addressable by locator (see routes/sessions.ts and web/src/lib/api.ts).
    return { ...withSiblings, locator: makeLocator(file) }
  })
  // A map lookup and nothing else. Working out WHICH session continued which means reading whole
  // transcripts, so that happens between sweeps (see resolveContinuations); this only applies what
  // is already known.
  const superseded = supersededSessions()
  if (superseded.size)
    for (let i = 0; i < result.length; i++) {
      const file = result[i] as TranscriptFile
      if (file.source !== 'claude') continue
      const by = superseded.get(file.session_id)
      if (by && by !== file.session_id) result[i] = { ...file, supersededBy: by }
    }
  // Stamped on COMPLETION, not on the timestamp the sweep started with. A sweep of a large store
  // runs for seconds, so a start-stamped snapshot is born older than any sane TTL and every caller
  // that checks freshness immediately asks for another sweep — the rebuild-forever loop this
  // module used to sit in. The age of a snapshot is how long ago it became TRUE, which is now.
  cache = { at: performance.now(), files: result }
  return result
}

function buildTranscriptIndex(): TranscriptFile[] {
  const files: TranscriptFile[] = []
  const extra = extraStoreRecords()
  const claudeChildren = new Map<string, string[]>()
  const pendingChildren: Array<{
    parentId: string
    rel: string
    store: ClaudeStore
    mtimeMs: number
    size: number
  }> = []
  for (const store of claudeStores()) {
    for (const rel of scanRootSync(new Bun.Glob(store.glob), store.root)) {
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(join(store.root, rel))
      } catch {
        continue
      }
      const parent = claudeParentId(rel, store)
      if (parent) {
        pendingChildren.push({ parentId: parent, rel, store, mtimeMs: st.mtimeMs, size: st.size })
        continue
      }
      files.push(claudeRecord(rel, st.mtimeMs, st.size, store))
    }
  }
  promoteOrphans(files, claudeChildren, pendingChildren)

  const codexSessionIndex = readCodexSessionIndex()
  const addCodexRoot = (root: string, archived: boolean, tool = 'codex') => {
    const glob = new Bun.Glob(CODEX_ROLLOUT_GLOB)
    for (const rel of scanRootSync(glob, root)) {
      const path = join(root, rel)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(path)
      } catch {
        continue
      }
      const identity = readCodexRolloutIdentity(path, codexFallbackId(rel))
      // Subagents are an implementation detail of their parent chat. Their visible user history is
      // a forked copy of that chat, so merging them would duplicate turns; the top-level rollout is
      // the complete user-facing conversation and is the only row Codex itself exposes.
      //
      // They are REMEMBERED rather than discarded, because a subagent burns its own tokens and the
      // parent rollout does not contain them. Dropping them outright made the analytics report a
      // fraction of real Codex spend: on this machine 4,716 of 4,860 archived rollouts are
      // subagents. See TranscriptFile.siblingPaths, which only a total ever reads.
      if (identity.isSubagent) continue
      files.push(
        codexRecord(
          root,
          rel,
          archived,
          st.mtimeMs,
          st.size,
          identity,
          codexSessionIndex.get(identity.sessionId),
          tool,
        ),
      )
    }
  }
  addCodexRoot(CODEX_SESSIONS_ROOT, false)
  addCodexRoot(CODEX_ARCHIVED_SESSIONS_ROOT, true)
  for (const r of extra.codex) addCodexRoot(r.root, r.archived, r.tool)

  files.push(...openCodeRecords())
  files.push(...extra.openCodeFiles)
  files.push(...extra.hermesFiles)
  files.push(...foreignRecords())
  return finishIndex(files, claudeChildren)
}

/**
 * The same index, built WITHOUT holding the event loop.
 *
 * This exists because the sync builder is not merely slow, it is *blocking*: globbing the store,
 * statting every transcript and reading the head of every Codex rollout measured 1,288 ms for 1,405
 * files on the author's machine. The daemon binds its port ~250 ms after launch, so a startup warm
 * that used the sync builder left the socket accepting connections while nothing could be answered
 * — the browser's very first GET sat in the queue for over a second, and moving the warm call after
 * `Bun.serve` (which it already was) could not help, because the block is inside the same turn.
 *
 * Correctness is identical: same globs, same records, same dedupe, same cache slot.
 */
async function buildTranscriptIndexAsync(): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = []
  const continuations: ContinuationLink[] = []

  const extra = extraStoreRecords()
  const claudeChildren = new Map<string, string[]>()
  const pendingChildren: Array<{
    parentId: string
    rel: string
    store: ClaudeStore
    mtimeMs: number
    size: number
  }> = []
  for (const store of claudeStores()) {
    const claudeRels = await scanRootAsync(new Bun.Glob(store.glob), store.root)
    const scanned = await mapPool(claudeRels, INDEX_SCAN_WIDTH, async (rel) => {
      try {
        const st = await statAsync(join(store.root, rel))
        return { rel, mtimeMs: st.mtimeMs, size: st.size }
      } catch {
        return null
      }
    })
    const tops: Array<{ record: TranscriptFile; mtimeMs: number; size: number }> = []
    for (const f of scanned) {
      if (!f) continue
      const parent = claudeParentId(f.rel, store)
      if (parent) {
        pendingChildren.push({ parentId: parent, ...f, store })
        continue
      }
      const record = claudeRecord(f.rel, f.mtimeMs, f.size, store)
      files.push(record)
      tops.push({ record, mtimeMs: f.mtimeMs, size: f.size })
    }
    // Through the same bounded pool as the stat scan, not one await at a time: this is a head read
    // per top-level transcript (~1,200 of them here) and it runs on every sweep. Cached against
    // mtime+size, so after the first pass it is a map lookup.
    const links = await mapPool(tops, INDEX_SCAN_WIDTH, async (t) => ({
      record: t.record,
      mtimeMs: t.mtimeMs,
      link: await readContinuationLink(t.record.path, t.mtimeMs, t.size),
    }))
    for (const l of links)
      if (l?.link)
        continuations.push({
          sessionId: l.record.session_id,
          logicalParentUuid: l.link,
          path: l.record.path,
          mtimeMs: l.mtimeMs,
        })
  }
  promoteOrphans(files, claudeChildren, pendingChildren)

  const codexSessionIndex = readCodexSessionIndex()
  for (const { root, archived, tool } of [
    { root: CODEX_SESSIONS_ROOT, archived: false, tool: 'codex' },
    { root: CODEX_ARCHIVED_SESSIONS_ROOT, archived: true, tool: 'codex' },
    ...extra.codex,
  ]) {
    const rels = await scanRootAsync(new Bun.Glob(CODEX_ROLLOUT_GLOB), root)
    const records = await mapPool(rels, INDEX_SCAN_WIDTH, async (rel) => {
      const path = join(root, rel)
      try {
        const st = await statAsync(path)
        const identity = await readCodexRolloutIdentityAsync(path, codexFallbackId(rel))
        // Same rule as the sync builder.
        if (identity.isSubagent) return null
        return codexRecord(
          root,
          rel,
          archived,
          st.mtimeMs,
          st.size,
          identity,
          codexSessionIndex.get(identity.sessionId),
          tool,
        )
      } catch {
        return null
      }
    })
    for (const record of records) if (record) files.push(record)
  }

  files.push(...openCodeRecords())
  files.push(...extra.openCodeFiles)
  files.push(...extra.hermesFiles)
  // The async listing, which yields while it parses. Everything above this line already yields;
  // this was the last synchronous block in the sweep, and the largest.
  files.push(...(await foreignRecordsAsync()))
  const built = finishIndex(files, claudeChildren)
  // The head cache tracks the store, not everything ever seen: a deleted transcript should not keep
  // its slot for the life of the daemon.
  pruneContinuationHeadCache(new Set(files.filter((f) => f.source === 'claude').map((f) => f.path)))
  // Deliberately NOT awaited. Working out which session continued which means reading whole
  // transcripts, which is the one thing this sweep must never do inline; the answers land in the
  // memo and the NEXT sweep applies them. A newly compacted conversation therefore merges a few
  // seconds after it first appears rather than instantly, which is the right way round.
  void resolveContinuations(continuations)
  return built
}

/**
 * The async, request-safe way to get the index — prefer this over {@link listTranscriptFiles} in
 * any caller that is already async.
 *
 * Keeps listTranscriptFiles's stale-while-revalidate contract (a caller holding a snapshot never
 * waits for the sweep) and adds coalescing: concurrent callers on a cold cache share ONE build
 * instead of each paying for their own, which is exactly the startup shape — the boot warm-up and
 * the first `/api/sessions` request arrive within milliseconds of each other.
 */
export async function ensureTranscriptIndex(force = false): Promise<TranscriptFile[]> {
  const now = performance.now()
  if (!force && cache && now - cache.at < TTL_MS) return cache.files
  const build = startIndexBuild()
  if (!force && cache) return cache.files
  return build
}

/**
 * Every row a lookup could mean, narrowed as far as the caller told us.
 *
 * A `locator` that parses AND has at least one exact match wins outright (audit AH-35: it is the
 * one identity that survives two products sharing a format), which is why it short-circuits before
 * the plain id/source filter even runs — falling through to that filter on a locator naming a row
 * that is not (yet) in this snapshot would silently answer with some OTHER session sharing the bare
 * id instead of "not here yet". A locator that fails to parse, or that matches nothing in THIS
 * snapshot, is treated exactly like no locator at all: the caller may be a step behind a sweep, and
 * a hard error over a stale query param would be the wrong failure mode for what is, from here, an
 * ordinary miss.
 */
const pickSession =
  (sessionId: string, source?: SessionSource, locator?: string) => (files: TranscriptFile[]) => {
    const parsed = parseLocator(locator)
    if (parsed) {
      const exact = files.filter((f) => matchesLocator(f, parsed))
      if (exact.length) return exact
    }
    return files.filter((f) => f.session_id === sessionId && (!source || f.source === source))
  }

/** newest wins if a session id appears under multiple project folders */
const newestOf = (matches: TranscriptFile[]): TranscriptFile | null =>
  matches.length === 0 ? null : matches.reduce((a, b) => (b.mtime_ms > a.mtime_ms ? b : a))

export function findTranscript(
  sessionId: string,
  source?: SessionSource,
  locator?: string,
): TranscriptFile | null {
  const pick = pickSession(sessionId, source, locator)
  // A miss is the one answer the snapshot can get wrong — a transcript created seconds ago is
  // absent from it — so a sweep is started. This cannot WAIT for it (see
  // listTranscriptFilesAfterMiss), which is why an async caller should prefer findTranscriptAsync.
  let matches = pick(listTranscriptFiles())
  if (matches.length === 0) matches = pick(listTranscriptFilesAfterMiss())
  return newestOf(matches)
}

/**
 * findTranscript for a caller that is already async — which is nearly all of them, and all the hot
 * ones.
 *
 * The difference is what a MISS costs. The sync version can only start a sweep and answer from the
 * snapshot it already had, so a session created moments ago reads as absent until some later poll.
 * This one waits for the sweep, and waiting is free here: the async builder yields, so the daemon
 * keeps answering everything else while it runs.
 */
export async function findTranscriptAsync(
  sessionId: string,
  source?: SessionSource,
  locator?: string,
): Promise<TranscriptFile | null> {
  const pick = pickSession(sessionId, source, locator)
  let matches = pick(await ensureTranscriptIndex())
  if (matches.length === 0) matches = pick(await ensureTranscriptIndexAfterMiss())
  return newestOf(matches)
}

// --- byte-tail reader --------------------------------------------------------

async function readTailBytes(path: string, maxBytes: number): Promise<string> {
  const file = Bun.file(path)
  const size = file.size
  const start = Math.max(0, size - maxBytes)
  const blob = start > 0 ? file.slice(start) : file
  return await blob.text()
}

// --- text helpers ------------------------------------------------------------

function compact(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : '',
      )
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

const CODEX_INJECTED_USER_BLOCK =
  /^\s*<(recommended_plugins|environment_context|app-context|permissions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|multi_agent_mode|turn_aborted)\b/i

/** Codex Desktop carries request/runtime context as user-role blocks. They are transport metadata,
 * not human turns, and must not become titles or transcript bubbles. */
export function isCodexInjectedUserText(text: string): boolean {
  return (
    CODEX_INJECTED_USER_BLOCK.test(text) ||
    // Codex may deliver a repository's AGENTS.md preamble as a user-role transport message even
    // though it came from the runtime, not the human. Without this guard it becomes the title.
    /^\s*#\s*AGENTS\.md instructions\b/i.test(text)
  )
}

/** {@link codexEventToTailEvents}'s `message` payload handler, split out (with the two handlers
 * below) so the dispatch table there can stay a flat lookup instead of an if/else chain. Same
 * role gate, same block filtering, same truncation. */
function codexMessageEvents(payload: any, timestamp: string | null): TailEvent[] {
  const role = payload.role
  if (role !== 'user' && role !== 'assistant') return []
  const out: TailEvent[] = []
  const blocks = Array.isArray(payload.content) ? payload.content : []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'input_text' && block.type !== 'output_text') continue
    if (typeof block.text !== 'string') continue
    if (role === 'user' && isCodexInjectedUserText(block.text)) continue
    const text = compact(block.text)
    if (!text) continue
    out.push({
      role,
      kind: 'text',
      text: truncate(text, 6000),
      tool_name: null,
      timestamp,
    })
  }
  return out
}

/** `function_call` / `custom_tool_call` payload handler for {@link codexEventToTailEvents}. */
function codexToolCallEvent(payload: any, timestamp: string | null): TailEvent[] {
  const input = compact(stringifyToolResult(payload.arguments ?? payload.input))
  return [
    {
      role: 'assistant',
      kind: 'tool_use',
      text: truncate(input, 1200),
      tool_name: payload.name ?? 'tool',
      timestamp,
    },
  ]
}

/** `function_call_output` / `custom_tool_call_output` payload handler for
 * {@link codexEventToTailEvents}. */
function codexToolResultEvent(payload: any, timestamp: string | null): TailEvent[] {
  const output = compact(stringifyToolResult(payload.output))
  return output
    ? [
        {
          role: 'user',
          kind: 'tool_result',
          text: truncate(output, 2000),
          tool_name: null,
          timestamp,
        },
      ]
    : []
}

const CODEX_PAYLOAD_HANDLERS: Record<
  string,
  (payload: any, timestamp: string | null) => TailEvent[]
> = {
  message: codexMessageEvents,
  function_call: codexToolCallEvent,
  custom_tool_call: codexToolCallEvent,
  function_call_output: codexToolResultEvent,
  custom_tool_call_output: codexToolResultEvent,
}

/** Convert one Codex rollout item. event_msg mirrors message text for live UI updates, so only
 * response_item is consumed; reading both would duplicate every visible turn. */
export function codexEventToTailEvents(ev: any): TailEvent[] {
  if (ev?.type !== 'response_item') return []
  const payload = ev?.payload
  const timestamp: string | null = typeof ev?.timestamp === 'string' ? ev.timestamp : null
  const handler = payload?.type ? CODEX_PAYLOAD_HANDLERS[payload.type] : undefined
  return handler ? handler(payload, timestamp) : []
}

/**
 * Bookkeeping the CLI writes into its own transcript that was never part of the conversation.
 *
 * Resuming a session whose last turn died on an API error makes `claude` repair the dangling tail
 * by appending a canned pair — user `isMeta: true` "Continue from where you left off." plus a
 * `<synthetic>` assistant "No response requested." — both stamped with the SAME millisecond,
 * because no model was ever called. Rendering them as real turns tells a story that never happened:
 * it reads as though we prompted the session and it refused, when the CLI was talking to itself
 * (mis-read exactly that way 2026-07-15; the run had in fact been sent nothing but "resume").
 *
 * The rate-limit notice is the ONE synthetic message worth keeping: it is also `<synthetic>` but
 * carries `isApiErrorMessage: true`, and it is the only thing on screen that explains why a session
 * stopped. Keep that; drop the self-talk.
 */
function isCliBookkeeping(ev: any): boolean {
  if (ev?.isMeta === true) return true
  return ev?.message?.model === '<synthetic>' && ev?.isApiErrorMessage !== true
}

/**
 * Plumbing the CLI wraps in pseudo-tags and stores as an ordinary user message: slash-command
 * invocations, hook output, bash echoes, the local-command caveat. It is addressed to the MODEL,
 * not written by the human, so it must never stand in for what a session is "about".
 *
 * Unlike the bookkeeping above, most of these carry no `isMeta` flag, so this tag scan is the only
 * thing that catches them. It is what keeps a `/usage` probe — a transcript holding nothing but a
 * caveat and a `<command-name>` line — from being listed as a real session (see sessions.ts).
 */
const COMMAND_WRAPPER =
  /^\s*<\/?(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b/i

export function isCommandWrapperText(text: string): boolean {
  return COMMAND_WRAPPER.test(text)
}

/**
 * Pull a readable label out of a turn that is real work wrapped in a pseudo-tag.
 *
 * Distinct from COMMAND_WRAPPER above, and the difference is the whole point: that list is
 * plumbing to be ignored outright, whereas a `<scheduled-task name="…">` turn IS the session's
 * actual prompt — it just arrives wearing an envelope. Dropping it would leave a genuine session
 * titled with its uuid; keeping it whole titled one "<scheduled-task name="studio-executor-parity-
 * sweep" file="C:\Users\…">".
 *
 * Prefers a `name` attribute (someone chose that string as a label) and otherwise falls back to the
 * body text. Anything that isn't a wrapped turn passes through untouched.
 */
export function unwrapTaggedText(text: string): string {
  return describeTaggedText(text).label
}

/**
 * {@link unwrapTaggedText}, but it also reports WHAT it did — which envelope it opened, if any.
 *
 * The label on its own cannot explain a surprising title. A `name` attribute is chosen by whatever
 * wrote the envelope, and that may be a scheduler, a hook or a harness the user never named: the
 * owner hit exactly this, reporting threads titled "Watcher" when no account, instance or project
 * of his was called that, and there was no way to ask the app where the string had come from.
 * `tag` is that answer, and the session list carries it to the UI as SessionSummary.title_tag.
 *
 * `envelope` is true ONLY when the name attribute won. A tag whose BODY became the label is not
 * carrying an externally chosen name — it is punctuation around the user's own words — so that
 * case is reported as ordinary message text and gets no "where did this come from?" affordance.
 */
export function describeTaggedText(text: string): {
  label: string
  envelope: boolean
  tag: string | null
} {
  const open = text.match(/^\s*<([a-z][\w-]*)\b([^>]*)>/i)
  if (!open) return { label: text, envelope: false, tag: null }
  const name = open[2].match(/\bname\s*=\s*"([^"]+)"/i)?.[1]
  if (name?.trim()) return { label: name.trim(), envelope: true, tag: open[1].toLowerCase() }
  const body = text
    .slice(open[0].length)
    .replace(new RegExp(`</${open[1]}\\s*>\\s*$`, 'i'), '')
    .trim()
  return { label: body || text, envelope: false, tag: null }
}

/** What a caller wants kept out of the raw stream. Every field defaults to the historical
 *  behaviour, so an unchanged caller gets an unchanged answer. */
export interface TailFilter {
  /** Emit `thinking` blocks as their own events instead of dropping them. Off by default: they are
   *  the bulkiest part of a transcript and the least useful part to skim. */
  thinking?: boolean
}

/**
 * THE hide-"thinking" filter. Turns one raw transcript JSONL event into zero or more
 * displayable TailEvents. Reused for both disk-tail reading and the live stream-json path,
 * so the rule lives in exactly one place (per the rebuild plan).
 *
 * Rules:
 *  - keep only user/assistant events
 *  - drop the CLI's own resume bookkeeping (see isCliBookkeeping)
 *  - drop `thinking` and `redacted_thinking` content blocks unless `filter.thinking` asks for them
 *  - assistant `text` -> text event
 *  - `tool_use` -> collapsed tool event (name + compact input)
 *  - user `tool_result` -> collapsed tool_result event
 *  - a plain-string user message -> text event
 */
/** One content-array block from a message, turned into its TailEvent (or none — a block that
 *  produces no visible text, or a thinking block dropped by the filter, is skipped). Split out of
 *  eventToTailEvents's `for` loop so each block kind is a flat branch here instead of nested two
 *  levels deep (array check, then loop, then this chain) inside that function. */
function blockToTailEvent(
  block: any,
  r: 'user' | 'assistant',
  ts: string | null,
  filter: TailFilter,
): TailEvent | null {
  if (!block || typeof block !== 'object') return null
  const bt = block.type
  if (bt === 'thinking' || bt === 'redacted_thinking') {
    // <- the filter. `redacted_thinking` carries an encrypted `data` field and no readable
    // text, so asking for thinking still shows nothing for it: there is nothing to show.
    if (!filter.thinking) return null
    const t = compact(typeof block.thinking === 'string' ? block.thinking : '')
    return t
      ? {
          role: 'assistant',
          kind: 'thinking',
          text: truncate(t, 6000),
          tool_name: null,
          timestamp: ts,
        }
      : null
  }
  if (bt === 'text' && typeof block.text === 'string') {
    const t = compact(block.text)
    return t
      ? { role: r, kind: 'text', text: truncate(t, 6000), tool_name: null, timestamp: ts }
      : null
  }
  if (bt === 'tool_use') {
    const input = block.input ? truncate(compact(JSON.stringify(block.input)), 1200) : ''
    return {
      role: 'assistant',
      kind: 'tool_use',
      text: input,
      tool_name: block.name ?? 'tool',
      timestamp: ts,
    }
  }
  if (bt === 'tool_result') {
    const t = compact(stringifyToolResult(block.content))
    return t
      ? {
          role: 'user',
          kind: 'tool_result',
          text: truncate(t, 2000),
          tool_name: null,
          timestamp: ts,
        }
      : null
  }
  return null
}

export function eventToTailEvents(ev: any, filter: TailFilter = {}): TailEvent[] {
  const message = ev?.message
  const role: string | undefined = message?.role ?? ev?.type
  const type: string | undefined = ev?.type
  if (type !== 'user' && type !== 'assistant' && role !== 'user' && role !== 'assistant') return []
  if (isCliBookkeeping(ev)) return []
  const r: 'user' | 'assistant' =
    role === 'assistant' || type === 'assistant' ? 'assistant' : 'user'
  const ts: string | null = ev?.timestamp ?? null
  const content = message?.content
  const out: TailEvent[] = []

  if (typeof content === 'string') {
    const t = compact(content)
    if (t)
      out.push({ role: r, kind: 'text', text: truncate(t, 6000), tool_name: null, timestamp: ts })
    return out
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      const te = blockToTailEvent(block, r, ts, filter)
      if (te) out.push(te)
    }
  }
  return out
}

export function eventToTailEventsForSource(
  source: SessionSource,
  ev: any,
  filter: TailFilter = {},
): TailEvent[] {
  return source === 'codex' ? codexEventToTailEvents(ev) : eventToTailEvents(ev, filter)
}

export interface TailOptions {
  limit?: number
  /** When true, drop tool_use/tool_result and only count text-bearing turns toward the limit. */
  textOnly?: boolean
  /** Include the model's reasoning blocks (see TailFilter). */
  thinking?: boolean
  /** Only what a person typed. The point of `limit` is a window of turns, so this has to be applied
   *  BEFORE the window is counted — filtering 40 mixed turns client-side yields a handful of human
   *  ones, which is not a readable session. */
  humanOnly?: boolean
  title?: string
  cwd?: string
}

/** The display filter, as one predicate, so the two source paths below cannot drift apart.
 *  Exported for server/tests/tail-filter.test.ts, which pins the rules rather than the callers. */
export function tailKeeper(opts: TailOptions): (e: TailEvent) => boolean {
  if (opts.humanOnly) return (e) => e.kind === 'text' && e.role === 'user'
  if (opts.textOnly) return (e) => e.kind === 'text' || e.kind === 'thinking'
  return () => true
}

/** Parse a raw transcript tail newest-line-first into up to `limit` filtered event groups, plus
 *  whatever cwd the scanned lines revealed. Pulled out of tailTranscript's default (non-foreign,
 *  non-opencode) path so the byte-tail parsing loop isn't nested inside the source-branch chain. */
function collectTailEventsFromRaw(
  raw: string,
  source: SessionSource,
  filter: TailFilter,
  keep: (e: TailEvent) => boolean,
  limit: number,
): { events: TailEvent[]; cwd: string } {
  const lines = raw.split('\n')
  const collected: TailEvent[][] = []
  let cwd = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof ev?.cwd === 'string') cwd = ev.cwd
    if (!cwd && typeof ev?.payload?.cwd === 'string') cwd = ev.payload.cwd
    const tes = eventToTailEventsForSource(source, ev, filter).filter(keep)
    if (tes.length === 0) continue
    collected.push(tes)
    if (collected.length >= limit) break
  }
  return { events: collected.reverse().flat(), cwd }
}

/** Read the last `limit` real turns of a session's transcript, thinking filtered out. */
export async function tailTranscript(
  sessionId: string,
  opts: TailOptions = {},
  source?: SessionSource,
  locator?: string,
): Promise<TailResult> {
  const limit = opts.limit ?? 40
  const keep = tailKeeper(opts)
  const filter: TailFilter = { thinking: opts.thinking ?? false }
  // Async: this is the endpoint the open chat polls every 4 s, and the one a just-dispatched run
  // hits before its transcript exists. The sync lookup would answer "not found" until some later
  // poll — or, before the sweep became async, freeze the daemon while it looked.
  const tf = await findTranscriptAsync(sessionId, source, locator)
  if (!tf) {
    return {
      session_id: sessionId,
      source: source ?? 'claude',
      title: opts.title ?? sessionId,
      cwd: opts.cwd ?? '',
      events: [],
      error: 'transcript not found',
    }
  }
  if (tf.source === 'foreign') {
    // Each adapter returns the whole conversation; these stores are small enough that a windowed
    // read would add a code path for no gain.
    const events = readForeignSession(tf.tool ?? '', tf.path)
      .filter(keep)
      .slice(-limit)
    return {
      session_id: sessionId,
      source: tf.source,
      title: opts.title ?? tf.title ?? sessionId,
      cwd: opts.cwd ?? tf.cwd ?? '',
      events,
    }
  }
  if (tf.source === 'hermes') {
    // Unlike readOpenCodeSession above, tf.path is passed through: a Hermes profile is a SEPARATE
    // database from the default store, so reading without it would silently answer from the wrong
    // one whenever more than one store exists.
    const content = readHermesSession(sessionId, tf.path)
    if (!content) {
      return {
        session_id: sessionId,
        source: tf.source,
        title: opts.title ?? tf.title ?? sessionId,
        cwd: opts.cwd ?? tf.cwd ?? '',
        events: [],
        error: 'transcript not found',
      }
    }
    const events = content.events.filter(keep).slice(-limit)
    return {
      session_id: sessionId,
      source: tf.source,
      title: opts.title ?? tf.title ?? sessionId,
      cwd: opts.cwd ?? tf.cwd ?? '',
      events,
    }
  }
  if (tf.source === 'opencode') {
    // tf.path is THE store (audit AH-34): Kilo, MiMo Code and IcodeMate are OpenCode-format
    // stores with their own databases, and discovery already put each row's database here.
    // Reading the default OpenCode database instead answered "transcript not found" for every
    // session those products had, and a colliding id would have shown the wrong product's chat.
    const content = readOpenCodeSession(sessionId, tf.path)
    if (!content) {
      return {
        session_id: sessionId,
        source: tf.source,
        title: opts.title ?? tf.title ?? sessionId,
        cwd: opts.cwd ?? tf.cwd ?? '',
        events: [],
        error: 'transcript not found',
      }
    }
    const events = content.events.filter(keep).slice(-limit)
    return {
      session_id: sessionId,
      source: tf.source,
      title: opts.title ?? tf.title ?? sessionId,
      cwd: opts.cwd ?? tf.cwd ?? '',
      events,
    }
  }
  const raw = await readTailBytes(tf.path, 6 * 1024 * 1024)
  const { events, cwd: rawCwd } = collectTailEventsFromRaw(raw, tf.source, filter, keep, limit)
  const title = opts.title || sessionId
  const cwd = opts.cwd || rawCwd
  return {
    session_id: sessionId,
    source: tf.source,
    title,
    cwd: cwd || decodeProjectKey(tf.project),
    events,
  }
}
