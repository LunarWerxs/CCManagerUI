// Shared types, imported by the Vue app via Eden for end-to-end typing.

// CodexInstance below references this type directly, so it is imported as well as re-exported
// (see the Codex re-export block further down).
import type { CodexAccount } from './core/codex-account'

// SessionSummary.limit_stop is this exact shape. It is DEFINED in rate-limit-signal.ts because the
// detector and the DTO must never drift, and that module is a zero-import leaf, so pulling it in
// here costs the web app's vue-tsc pass nothing.
import type { LimitStop } from './rate-limit-signal'
// Same reasoning: session-ending.ts imports only that leaf, so this stays free of Bun runtime.
import type { SessionEnding } from './session-ending'

export type { LimitStop, SessionEnding }

/** "Sync my settings with Connections" DTO, defined HERE (not re-exported from
 * ./connections.ts) because that module imports Bun-only runtime files (db.ts), which
 * must never be pulled into the web app's vue-tsc pass; ./connections.ts imports it back.
 * Status shape returned by every settings-sync endpoint (matches DevWebUI's SyncStatus). */
export interface SyncStatus {
  ok: true
  /** Sync is turned on (independent of whether a Connections credential exists). */
  enabled: boolean
  /** The daemon holds a Connections credential (owner is signed in). */
  connected: boolean
  /** Signed-in display name, or null when not connected (or a pre-name connection pending refresh). */
  name: string | null
  /** Privacy-relay email; third-party apps never receive the real inbox, shown only as a fallback. */
  email: string | null
  /** Avatar image URL from the IdP, or null when not granted/available. */
  picture: string | null
  /** ISO timestamp of the last successful sync, or null. */
  lastSyncedAt: string | null
  version: number
  /** Last-synced appearance blob (e.g. `{ theme }`) to apply locally, or null. */
  appearance: Record<string, unknown> | null
}
// The Codex/ChatGPT instance-account DTOs, defined next to their resolver for the same reason as
// the Claude ones below.
export type {
  CodexAccount,
  CodexAccountStatus,
  CodexAuthMode,
  CodexResetRedeemResult,
  CodexResetRedeemStatus,
} from './core/codex-account'
// Instance DTOs ("instance account" = which Anthropic account a Claude Desktop *instance*
// is logged into) are defined in ./core/shared.ts, re-exported here so the web app only
// ever imports types from this one module, same as every other DTO below.
export type {
  CMAccount,
  CMAccountStatus,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  InstanceColorKey,
  InstanceIconKey,
} from './core/shared'
// Value re-exports (the curated icon/color key sets + label cap) so the web app drives its
// icon/color pickers from the exact same source of truth the server validates against. These
// are pure literal constants; ./core/shared imports nothing runtime-heavy, so pulling them into
// the browser bundle is safe.
export { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS, INSTANCE_LABEL_MAX } from './core/shared'
/** Portable-window opener result (see ./portable-window.mjs), re-exported here so the web
 * app only ever imports types from this one module, same as every other DTO in this file. */
export type { PortableWindowResult } from './portable-window.mjs'
/** Self-updater DTOs (see ./updater-engine.mjs), re-exported here so the web app only
 * ever imports types from this one module, same as every other DTO in this file. */
export type { UpdateApplyResult, UpdateStatus } from './updater-engine.mjs'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AuthType = 'oauth_token' | 'api_key'
/** `instance_ref` value meaning "deliberately unpinned — run on the ambient CLI login". A stored
 *  null is ambiguous (it also means "nobody said"), and that ambiguity is what a resume must not
 *  inherit, so the explicit choice needs a value of its own. Never stored: the API turns it into
 *  null and skips the auto-resolve. */
export const AMBIENT_RUN_AS = 'ambient'
export type QueueStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  /** Exit 0, but no independent evidence the run actually produced anything (never-claim-landed
   *  doctrine: an exit code is the process's own self-report, not proof - see
   *  hasCompletionEvidence in dispatch.ts). Distinct from
   *  'completed' on purpose: a caller that filters on 'completed' must never see one of these by
   *  accident, and a desktop delivery must never fire on one. Distinct from 'failed' too - the run
   *  may well have worked; nobody has confirmed it either way. */
  | 'unverified'
  /** YOUR allowance is spent (session/weekly). Only time fixes it — monitor.ts resumes off this. */
  | 'rate_limited'
  /** ANTHROPIC'S servers were saturated (529). Nothing is wrong with the run; it is retried
   *  automatically a few times first, and only lands here if the overload outlasted the backoff.
   *  Deliberately NOT 'rate_limited': that would park a seconds-long blip against a 5-hour reset. */
  | 'overloaded'
  | 'canceled'
/** Whether a finished run has landed in its target desktop instance's app yet. Separate from
 *  QueueStatus on purpose: the RUN is over either way, and conflating "the work finished" with
 *  "you can see it" is exactly how a delivery goes missing without anything looking wrong. */
export type ImportState = 'pending' | 'done' | 'gave_up'
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

/**
 * A supported conversation store, named by the READER that understands it.
 *
 * Claude/Codex are JSONL; OpenCode and Hermes are each their own shared SQLite DB — two different
 * schemas, so two different readers. `foreign` is the fifth: one reader with a small adapter per
 * tool (Grok, Kimi, VS Code Copilot, Copilot CLI, Zed), which share no format with each other but do
 * share the one thing that matters here — a list of conversations that can be read, and no per-token
 * usage to account for. See server/src/foreign-sessions.ts.
 */
export type SessionSource = 'claude' | 'codex' | 'opencode' | 'hermes' | 'foreign'
export type SessionSourceScope = 'all' | SessionSource

export function isSessionSource(v: unknown): v is SessionSource {
  return v === 'claude' || v === 'codex' || v === 'opencode' || v === 'hermes' || v === 'foreign'
}

/** A session discovered in one of the supported local conversation stores. */
export interface SessionSummary {
  session_id: string
  source: SessionSource
  /** Which PRODUCT wrote it, as an agent-catalog.ts id ('claude-code', 'openclaude', 'traex', …).
   *  `source` is only the FORMAT, and forks share one. */
  tool: string
  /**
   * The opaque, versioned identity for THIS exact row (server/src/session-locator.ts) — source +
   * product + physical store, not just source + session_id.
   *
   * `source` + `session_id` alone cannot always tell two rows apart: two OpenCode-format products
   * (Kilo, MiMo Code) or two Hermes profiles can hold the same session id (audit AH-35). Every
   * session route accepts `?locator=` alongside the older `?source=`, and a caller that already has
   * this row — because it just listed it — should pass the locator back rather than source alone,
   * which resolves to "the first/newest match for that id+source" and can silently pick the wrong
   * product's session when two of them collide.
   */
  locator: string
  title: string
  cwd: string
  project: string
  git_branch: string | null
  message_count: number
  created_at: number | null
  last_activity_at: number
  last_role: 'user' | 'assistant' | null
  last_text_preview: string | null
  size_bytes: number
  transcript_path: string
  /** Live status pulled from our own queue, if this session is scheduled/running under us. */
  queue_status: QueueStatus | null
  /** Claude Desktop instance the session ran in: an `~/.claude-instances` dir name,
   *  "default" for the non-isolated install, or null for plain CLI / another provider. */
  instance: string | null
  /** Provider archive state: Claude Desktop metadata, Codex's archived rollouts folder, or
   *  OpenCode's archived timestamp. False when the provider carries no archive signal. */
  archived: boolean
  /** The user's own mark, stored in our `session_marks` table. Mark only: never filters a list. */
  done: boolean
  /**
   * How many subagent sessions this one spawned, counted through the whole chain below it.
   *
   * Only OpenCode reports any: it is the one store that keeps a subagent as a session row of its
   * own, so those rows are hidden from this list and folded into their parent's count instead (see
   * collapseSubagents in server/src/sessions.ts). Carried so the row can SAY it stands for a fan-out
   * — 45 of this machine's 92 OpenCode sessions are subagents, and hiding that many with nothing on
   * screen to account for them is how a fix reads as data loss.
   */
  subagent_count: number
  /**
   * AgentHydra queued work into this session, so it is ours rather than something typed by hand.
   *
   * Known exactly, not inferred: every dispatch passes the session id on the command line
   * (`--session-id` for a new chat, `--resume` for an existing one), so a `queue_items` row for
   * that id IS the fact. Nothing heuristic goes into it.
   */
  dispatched: boolean
  /**
   * Set when this conversation's own provider reported a QUOTA wall inside it — "You've hit your
   * weekly limit · resets 3am". Null means no trusted notice was found, which is not the same as
   * "never rate limited": only the CLI's own report counts as evidence, never model prose or tool
   * output, because matching the patterns against anything else marked every run that merely TALKED
   * about limits (see rate-limit-signal.ts).
   *
   * Claude only, today. Codex and OpenCode record an error but not one this detector is willing to
   * trust, and a false badge here is worse than a missing one.
   */
  limit_stop: LimitStop | null
  /**
   * WHERE this row's `title` came from — the answer to "why is this thread called that?".
   *
   * A title is derived from four different places and only one of them is a label a person chose,
   * so a surprising title is otherwise unattributable: the owner reported threads showing up named
   * "Watcher" with no account, instance or project by that name, and there was no way to ask the
   * app where the string came from. Now there is. See TITLE_SOURCES in server/src/sessions.ts.
   */
  title_source: TitleSource
  /** For `title_source: 'envelope'`, the tag whose name= attribute became the title (e.g.
   *  "scheduled-task"). Null for every other source. This is the field that names the culprit. */
  title_tag: string | null
  /**
   * How many transcripts on disk are THIS conversation, and which of them this row is.
   *
   * One chat routinely ends up in several files: interrupt it and resume, and the CLI opens a new
   * transcript that replays the history and carries on. Both files are real and neither contains
   * the other — measured across 36 such pairs here, every single older copy held turns the newer
   * one does not, and they were the user's own words, typically the last thing said before the
   * interrupt ("See you soon.", "skip domains4sale.uk,, do the rest"). So they are NOT folded away;
   * hiding one would delete something the person actually typed. They are labelled instead, so two
   * rows with the same title read as one conversation in two parts rather than as a mystery.
   *
   * `copy_count` is 1 for the ordinary case. Copies are numbered oldest first, so copy 1 is where
   * the conversation started.
   */
  copy_index: number
  copy_count: number
  /**
   * What ended this transcript — the answer to "why is this conversation in several pieces?".
   *
   * It is the last thing that happened in the file, and for a part that has a later copy it is
   * literally the cause of that copy existing. Measured on a real store, the superseded parts ended
   * 18x on the user pressing stop, 6x on a safety filter refusing the message, 3x on an ordinary
   * turn later picked back up, and 2x on a server overload. Never a mystery — the cause is written
   * in the file; the list simply had no way to say it.
   *
   * Claude only, for the same reason limit_stop is: the markers are the Claude CLI's own.
   */
  ended_because: SessionEnding | null
}

/**
 * The four places a session title can come from, worst-understood last.
 *
 *  · 'custom'    — a `custom-title` record: the saved title the writing app displays. Deliberately
 *                  NOT described as "a name you typed", because it cannot be told apart from one
 *                  the app generated — 453 of the newest 500 sessions on the machine this was
 *                  written against carry one, which no person sat and typed. What IS known is that
 *                  it is a deliberate label rather than an inference from the conversation.
 *  · 'ai'        — an `ai-title` record: the model summarising the conversation. A session can
 *                  carry both, with different text; the custom one wins because it is the one its
 *                  own app shows.
 *  · 'store'     — the provider handed us a title as a field (OpenCode's `session.title`, Codex
 *                  Desktop's `thread_name`, a foreign adapter's own label).
 *  · 'envelope'  — the first turn arrived wrapped in a pseudo-tag carrying a name attribute, e.g.
 *                  `<scheduled-task name="nightly-sweep">`, and THAT name became the title. This is
 *                  the surprising one: the string is chosen by whatever wrote the envelope, which
 *                  may be a scheduler, a hook or a harness the user never named.
 *  · 'message'   — the first thing said in the conversation, trimmed.
 *  · 'id'        — nothing else was available, so the session id stands in.
 */
export type TitleSource = 'custom' | 'ai' | 'store' | 'envelope' | 'message' | 'id'

/**
 * One folder that has conversations in it, across every store (server/src/sessions.ts listProjects).
 *
 * The index of the index. A session list only ever answers newest-N, so a caller asked about "all
 * my chat histories" has no way to learn what exists before querying it; a thousand sessions
 * collapse to a few dozen of these, which is small enough to read whole.
 */
export interface ProjectSummary {
  /** The working directory, decoded from the provider's project key when it has to be. */
  cwd: string
  /** The provider's own key for it, kept because that is what `project` on a session row holds. */
  project: string
  sessions: number
  /** How many of those came from each store, so "this repo is half Codex" is visible at a glance. */
  by_source: Record<SessionSource, number>
  first_activity_at: number
  last_activity_at: number
}

/**
 * What credentials a session printed into its own transcript (server/src/session-export.ts).
 *
 * `findings` is always redacted and there is no unredacted form of this type anywhere: the count is
 * meant to make you go and rotate a key, not to be a second place the key lives.
 */
export interface SessionSecretScan {
  session_id: string
  source: SessionSource
  /** How many recognisable secrets are in the transcript. */
  count: number
  /** Each one, redacted, with the turn it appeared in. Capped; `truncated` says when. */
  findings: Array<{ kind: string; redacted: string; turn: number; role: string }>
  truncated: boolean
}

/**
 * One coding agent, as found on this machine (server/src/agent-catalog.ts).
 *
 * Defined here rather than beside the scanner for the same reason SyncStatus is: agent-catalog.ts
 * imports node:fs, and nothing Bun-only may be pulled into the web app's type pass.
 */
export interface AgentPresence {
  /** Catalog id — 'claude-code', 'openclaude', 'traex', … */
  id: string
  name: string
  /** Who makes it. The axis the analytics provider filter offers. */
  vendor: string
  /** Absolute store roots that exist. Never empty: a tool with none is not reported at all. */
  roots: string[]
  /** Files under those roots, capped. */
  files: number
  /** The count hit the cap, so show it as "N+" rather than as an exact figure it is not. */
  truncated: boolean
  lastActivityAt: number | null
  /**
   * The reader that handles this tool's store, or null when we can find it but not read it.
   *
   * A null here is a real answer, not a placeholder: the tool is installed, we know where its
   * conversations are, and nobody has written the parser. Saying so beats omitting it, which would
   * read as "AgentHydra looked and found nothing".
   */
  format: SessionSource | null
  /** Why it is unreadable, when there is a specific reason: 'encrypted', 'credits', 'opt-in'. */
  note?: string
}

// --- the analytics tier (server/src/analytics.ts) ---------------------------
// DTOs only; the runtime module imports them back, same discipline as SyncStatus above.

/** How much of the store the background scan has reached. Every report carries it, because a chart
 *  from a half-warmed store looks identical to one from a complete store and means less. */
export interface AnalyticsCoverage {
  sessions: number
  total: number
  refreshing: boolean
  bytes: number
}

export interface SpendBucket {
  key: string
  weighted: number
  costUsd: number | null
  sessions: number
  turns: number
  /** Only populated where the split is meaningful (per model, per provider). */
  tokens?: TokenBreakdown
}

/**
 * Where the tokens actually went.
 *
 * Reported as four separate figures rather than one total because they cost wildly different
 * amounts: a cache read is a tenth of fresh input, a cache write carries a premium over it, and
 * output is several times either. A single "tokens used" number hides the one fact that explains a
 * bill, which is that most of a heavy user's volume is cache reads.
 *
 * `input` is UNCACHED input on every provider. Anthropic reports it that way; Codex counts cached
 * input inside its input figure, so it is subtracted out before it reaches here.
 */
export interface TokenBreakdown {
  /** Fresh prompt tokens: the ones actually processed. */
  input: number
  /** Prompt tokens served from cache, at roughly a tenth of the price. */
  cacheRead: number
  /** Tokens written INTO the cache, at a premium over fresh input. */
  cacheWrite: number
  /** Generated tokens, the expensive end. */
  output: number
  /** input + cacheRead + cacheWrite + output. */
  total: number
}

export interface SpendReport {
  from: string | null
  to: string | null
  totalCostUsd: number | null
  totalWeighted: number
  /** The four categories, summed across every counted session. */
  tokens: TokenBreakdown
  /** Per provider, so "I have Codex usage" is answerable at a glance. */
  byProvider: Array<{
    key: SessionSource
    tokens: TokenBreakdown
    sessions: number
    costUsd: number | null
  }>
  sessions: number
  byModel: SpendBucket[]
  byProject: SpendBucket[]
  byDay: SpendBucket[]
  byAccount: SpendBucket[]
  unpricedModels: string[]
  /** The date the prices behind every dollar figure here were last known good. */
  pricesAsOf: string
  /** 'catalog' = downloaded rates; 'bundled' = the table this build shipped with. */
  priceSource: 'catalog' | 'bundled'
  coverage: AnalyticsCoverage
}

export interface SessionHealthRow {
  session_id: string
  source: SessionSource
  project: string
  toolErrors: number
  toolErrorStreak: number
  edits: number
  compactions: number
}

export interface ActivityReport {
  /** 168 slots, Sunday 00:00 first. */
  hours: number[]
  tools: Array<{ key: string; count: number }>
  /** Engaged time, not wall clock: inter-turn gaps with each one capped. */
  agentMinutes: number
  health: SessionHealthRow[]
  coverage: AnalyticsCoverage
}

export interface ConcurrencyPoint {
  at: number
  sessions: number
}

export interface EditEntry {
  session_id: string
  source: SessionSource
  project: string
  path: string
  turn: number
  ts: number | null
}

/** What one queued run cost, computed from the turns inside its own window. Never stored. */
export interface RunCost {
  id: string
  session_id: string
  status: string
  startedAt: string | null
  finishedAt: string | null
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
    total: number
    turns: number
  }
  costUsd: number | null
  unpricedModels: string[]
  /** The date the prices behind every dollar figure here were last known good. */
  pricesAsOf: string
  status_reason: 'ok' | 'no-window' | 'source-unsupported' | 'unreadable'
}

/** How a session list treats provider archive state. 'hide' is the default because archived is the
 *  large majority of a real store, so including it buries live work; 'only' makes old work findable. */
export type ArchivedScope = 'hide' | 'include' | 'only'

/**
 * How a session list treats work AgentHydra queued.
 *
 * 'all' is the default and stays the default: this narrows a list on request, and is never applied
 * on its own initiative — the same rule `session_marks` carries.
 */
/**
 * How a session list treats conversations that hit a usage wall.
 *
 * 'all' is the default and stays the default, exactly as DispatchedScope does: this narrows a list
 * on request and is never applied on the app's own initiative. 'only' answers "what did I lose to
 * a limit?"; 'pending' narrows that further to the ones still sitting at the wall right now, which
 * is the actionable half — the rest already got resumed and are history.
 */
export type RateLimitScope = 'all' | 'only' | 'pending'

export function isRateLimitScope(v: unknown): v is RateLimitScope {
  return v === 'all' || v === 'only' || v === 'pending'
}

export type DispatchedScope = 'all' | 'queued' | 'manual'

export function isDispatchedScope(v: unknown): v is DispatchedScope {
  return v === 'all' || v === 'queued' || v === 'manual'
}

/** How far back a session list reaches, by last activity. '24h' is the default: the list is a
 *  "what am I working on" surface, and a store holding months of transcripts answers that question
 *  worse the further back it goes. 'all' restores the old unbounded behaviour. */
export type SessionPeriod = '24h' | '7d' | '30d' | 'all'

const PERIOD_MS: Record<Exclude<SessionPeriod, 'all'>, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
}

export function isSessionPeriod(v: unknown): v is SessionPeriod {
  return v === '24h' || v === '7d' || v === '30d' || v === 'all'
}

/** Epoch cutoff for a period, or null for 'all' (no cutoff). */
export function periodCutoffMs(period: SessionPeriod, now = Date.now()): number | null {
  return period === 'all' ? null : now - PERIOD_MS[period]
}

/**
 * One displayable turn from a transcript tail.
 *
 * `thinking` is the model's reasoning block. It is DROPPED unless the caller asks for it, which is
 * the long-standing default and stays that way: it is the bulkiest and least useful part of a
 * transcript to skim. See `TailOptions` in server/src/transcript.ts.
 */
export interface TailEvent {
  role: 'user' | 'assistant'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text: string
  tool_name: string | null
  timestamp: string | null
}

export interface TailResult {
  session_id: string
  source: SessionSource
  title: string
  cwd: string
  events: TailEvent[]
  error?: string
}

/** One session's hits from an advanced BODY search (server/src/session-search.ts). */
export interface SessionSearchResult {
  session_id: string
  source: SessionSource
  cwd: string
  project: string
  match_count: number
  /** True when match_count hit the per-file cap; there may be more matches not shown. */
  truncated: boolean
  snippets: string[]
}

/**
 * A whole body-search answer, hits plus how complete they are.
 *
 * The completeness is not a nicety. The search runs under a wall-clock budget and returns whatever
 * it has when the clock runs out, so a bare list of hits makes "this text appears nowhere" and "we
 * gave up after seven seconds" the same answer. That is a bad trade for a human and a worse one for
 * an agent, which will happily conclude the code it is looking for does not exist.
 */
/**
 * How one queued run ended.
 *
 * The daemon has GROUND TRUTH here: the runner writes `{"__dispatch":"exit","code":N}` and the
 * status is finalized from that exit code, so this is what the process actually did rather than an
 * inference from a transcript. It rides alongside a run's events because the events alone cannot
 * say whether the run finished, died, or was killed.
 */
export interface RunOutcome {
  id: string
  status: QueueStatus
  /** The child's exit code. -1 means the daemon lost the runner (machine slept, process killed)
   *  and finalized the run without ever seeing its exit marker. Null while still queued/running. */
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  /** Wall-clock run time in ms, when both ends are known. */
  duration_ms: number | null
  /** Transient-overload retries already spent on this item. */
  retry_attempts: number
  /** True for a terminal status that is not `completed`: the run stopped without finishing. */
  died: boolean
}

/** A run's recorded output plus how it ended. */
export interface RunEventsResult {
  outcome: RunOutcome
  events: RunEvent[]
}

/** Which code path produced a search answer. The two have genuinely different reach, so no caller
 *  is ever left guessing which one it got. */
export type SearchPath =
  /** The conversation index: complete and instant, but it covers what was SAID (human and
   *  assistant turns matched by word and phrase), not tool output and not arbitrary substrings. */
  | 'index'
  /** The streaming scan: every byte of every transcript, substring or regex, bounded by a
   *  wall-clock budget. Slower and reaches less of the store within that budget. */
  | 'scan'

/** State of the on-disk conversation index (server/src/search-index.ts). */
export interface SearchIndexStatus {
  exists: boolean
  sizeBytes: number
  /** Sessions currently held. */
  sessions: number
  builtAt: number | null
  refreshing: boolean
}

export interface SessionSearchResponse {
  results: SessionSearchResult[]
  /** Which path answered. 'index' is complete over conversation; 'scan' is bounded by budgetMs. */
  searched: SearchPath
  /** True when the index answered and therefore tool output was NOT searched. The caller should
   *  offer the exhaustive scan rather than implying the answer covers everything on disk. */
  conversationOnly: boolean
  /** The budget ran out: a transcript was abandoned mid-read, or whole files were never opened.
   *  A miss is NOT evidence of absence when this is true. */
  budgetExhausted: boolean
  /** The hit list was cut to `limit`. Not a timeout — searching longer would not add rows. */
  limitReached: boolean
  /** File-backed transcripts opened, out of how many were in scope. OpenCode and Hermes are
   *  excluded from both: each is one or more indexed SQLite stores, searched in full and not
   *  time-bounded. */
  filesSearched: number
  filesTotal: number
  /** The wall-clock budget that applied, so a caller can say "stopped after 7 s". */
  budgetMs: number
}

export interface Account {
  id: string
  label: string
  auth_type: AuthType
  /** Never returned in full; masked for display. */
  secret_masked: string
  created_at: number
}

export interface QueueItem {
  id: string
  session_id: string
  title: string
  cwd: string
  prompt: string
  model: string | null
  effort: EffortLevel | null
  permission_mode: PermissionMode | null
  account_id: string | null
  /** Run under an already-signed-in instance's login: 'desktop:<dir>' or 'cli:<id>'. The runner
   *  extracts that instance's OAuth token value-blind at spawn time (core/accounts.ts) — no
   *  pasted credential involved. Mutually exclusive with account_id in practice; when both are
   *  set the instance ref wins (dispatch-runner checks it first).
   *
   *  Null on a STORED row means "ambient CLI login". On a CREATE/PATCH body it means "not
   *  specified", which for a resume auto-resolves to the session's own desktop instance
   *  (instance-sessions.ts instanceRefForSession) — send AMBIENT_RUN_AS to opt out. */
  instance_ref: string | null
  new_chat: boolean
  fork: boolean
  status: QueueStatus
  pid: number | null
  position: number
  /** ISO timestamp; the scheduler won't auto-dispatch before this (manual Run ignores it). */
  not_before: string | null
  /** How many times a transient-overload (529) retry has already re-run this item. >0 with a
   *  not_before in the future means "waiting out a backoff", which the always-on retry sweep in
   *  dispatch.ts fires — no scheduler or monitor opt-in involved. */
  retry_attempts: number
  /** When set ('desktop:<dir>'), a run that COMPLETES is imported into that instance's desktop
   *  app as a visible chat (session-launch.ts importSessionToDesktop), titled import_title.
   *  This is how a migration or handoff lands on the user's screen without anyone polling.
   *  Optional (absent = null) so synthetic QueueItem literals — discovered rate-limit stops,
   *  test fixtures — stay valid; real DB rows always carry the columns post-migration. */
  import_to?: string | null
  import_title?: string | null
  /** How that delivery went. null = nothing to deliver; 'pending' = the always-on sweep in
   *  dispatch.ts is still trying (the target app was shut, or the session was live, when the run
   *  finished); 'done' = it is in the app; 'gave_up' = the deadline passed unreachable.
   *  `import_error` is the last refusal, kept so a give-up is explainable rather than mute. */
  import_state?: ImportState | null
  import_error?: string | null
  /** Deliberate SURFACE-PURITY override. dispatch.ts refuses to launch a headless run against a
   *  session that lives in a desktop app (owner law 2026-08-26: desktop stays desktop, and the
   *  reported failure was desktop chats becoming "a headless thing I couldn't see"). Only a
   *  caller that explicitly forced it sets this, so the refusal cannot be routed around by
   *  accident. Optional so synthetic QueueItem literals stay valid. */
  allow_headless?: boolean
  started_at: string | null
  finished_at: string | null
  exit_code: number | null
  created_at: number
}

export interface RunEvent {
  id: number
  queue_item_id: string
  seq: number
  ts: string
  role: 'user' | 'assistant' | 'system'
  kind: 'text' | 'tool_use' | 'tool_result' | 'meta'
  text: string
  tool_name: string | null
}

// --- failure incidents (server/src/incidents.ts) ------------------------------------------------
// Defined HERE rather than in incidents.ts, same reasoning as QueueItem above: incidents.ts imports
// db.ts (Bun-only runtime), which must never reach the web app's vue-tsc pass, so the DTO lives in
// this Bun-free module and incidents.ts imports it back.
export type IncidentState = 'open' | 'acked' | 'resolved'
export const INCIDENT_STATES: readonly IncidentState[] = ['open', 'acked', 'resolved']

export interface Incident {
  id: string
  scope: string
  key: string
  error_sig: string
  state: IncidentState
  failure_type: string
  first_seen_at: string
  last_seen_at: string
  acked_at: string | null
  resolved_at: string | null
  /** Occurrences folded into this incident, including the one that created it. */
  count: number
  /** Redacted, length-bounded error text. */
  error: string
  output_file: string | null
}

export interface SchedulerState {
  enabled: boolean
  running_count: number
  queued_count: number
  spacing_seconds: number
  poll_seconds: number
  max_concurrent: number
  /** "HH:MM" local time used by the composer's "Tomorrow …" quick option. */
  tomorrow_time: string
}

/** Portable-window setting: open the UI in a chromeless Chromium app window instead of a
 * browser tab (both the in-app toggle and the desktop tray launcher honor it). */
export interface PortableModeSettings {
  portableMode: boolean
  /** Hide the tray's NotifyIcon (the daemon keeps running; the tray keeps re-reading this
   *  live so re-enabling it here restores the icon without a restart). */
  hideTrayIcon: boolean
}

/** Transcript-file-open setting (server/src/transcript-open.ts). */
export interface TranscriptSettings {
  /** Absolute path to an editor; '' = auto-detect. */
  transcriptEditor: string
  /** Read-only echo: the editor that will ACTUALLY open a transcript, after auto-detect and after
   *  discarding an override that points at nothing. Derived, never stored; POST ignores it. Without
   *  showing this, a typo'd override is indistinguishable from a working one (the open silently
   *  no-ops), which is the whole reason a plain path field is safe to keep. */
  transcriptEditorResolved: string
}

// --- usage-check subsystem (Feature B) --------------------------------------
// These DTOs live HERE (the pure, web-safe types hub) rather than in server/src/usage.ts, so the
// Vue app's type-only import path never pulls a Bun-only module. The runtime `usage.ts` imports
// them back, same discipline as SyncStatus above.

/** Server-computed "how bad is this" for one limit. Only the API path supplies it; the text
 *  parser cannot (the `/usage` screen renders severity as color, which we never see). */
export type UsageSeverity = 'normal' | 'warning' | 'critical'

/** One limit line from `/usage`: a percent used and a human reset string. */
export interface UsageLimit {
  pct: number
  /** Human reset string ("Jul 19, 3:59am"), or '' when the window hasn't started. */
  resets: string
  /** ISO-8601 reset timestamp. Present on the API path only; the text screen prints no year, so
   *  the CLI path has to guess one (see parseResetTime). Prefer this when it is here. */
  resetsAt?: string | null
  severity?: UsageSeverity
}

/** Where a snapshot came from. 'api' is the fast direct read; 'cli' is the `claude -p` fallback. */
export type UsageSource = 'api' | 'cli'

/** A parsed snapshot of one account's quota at a moment in time. */
export interface UsageSnapshot {
  /** Account label/email if the caller knew it; the `/usage` text does not name the account. */
  account: string | null
  /** The 5-hour rolling session window. */
  session: UsageLimit | null
  /** The weekly all-models limit — the BINDING cap for pacing decisions. */
  weekAll: UsageLimit | null
  /** A per-model weekly sub-limit (e.g. "Fable"), when present. */
  weekModel: (UsageLimit & { label: string }) | null
  capturedAt: string
  /** Optional for back-compat with snapshots cached before the API path existed. */
  source?: UsageSource
  /** Codex-only: banked `/usage reset` credits available to redeem (`rate_limit_reset_credits.
   *  available_count` on the usage payload). Undefined for snapshots that predate this field or
   *  for providers with no such concept; null when the provider answered but reported none. */
  resetCredits?: number | null
}

/**
 * Why a usage check turned out the way it did — lets the UI explain a "—" instead of showing it
 * silently. 'ok' = real numbers; the rest are actionable no-data reasons.
 */
export type UsageReason =
  | 'ok'
  | 'logged_out' // desktop instance isn't signed in
  | 'no_token' // desktop instance signed in but no usable/decryptable token
  | 'not_logged_in' // CLI instance has no login and no associated account
  | 'check_failed' // the probe ran but returned no parseable usage
  | 'unknown'

/**
 * The actionable verdict derived from a snapshot — what an agent should DO about these numbers.
 *
 * This exists because the raw percentages are not self-interpreting: an AI (or a person) reading
 * "98%" still has to know that the weekly all-models bucket is the binding cap, that a 0% session
 * alongside it means nothing, and that the correct response is to write your working context to disk
 * BEFORE you get cut off mid-task. See usageAdvice() in server/src/usage.ts.
 */
export interface UsageAdvice {
  severity: 'unknown' | UsageSeverity
  /** The binding weekly all-models %, or null if unknown. */
  bindingPct: number | null
  /** True when the agent should save/offload its working context before doing more work. */
  shouldOffload: boolean
  /** True when a heavy multi-agent fan-out is a reasonable idea right now. */
  safeToFanOut: boolean
  advice: string
}

// --- quantifying the percentage ---------------------------------------------
// The usage endpoint reports a percentage and NOTHING else (limit_dollars / used_dollars /
// remaining_dollars are all null on a subscription; there are no token counts). A bare "98%" cannot
// tell an agent whether it can afford a task. These three DTOs turn it into something budgetable:
// a rate (UsageForecast), a countable spend (TokenSpend), and the two combined (UsageBudget).

/** One historical reading, kept so the % can be differentiated into a rate. */
export interface UsageSample {
  at: string
  sessionPct: number | null
  weekAllPct: number
  weekResetsAt: string | null
}

/** The percentage, differentiated. See server/src/usage-history.ts. */
export interface UsageForecast {
  /** Point-estimate burn, in percent per hour. Null = unmeasurable. NOTE: a value of 0 does NOT mean
   *  "idle" — the source percentage is an integer, so 0 means "slower than this span can resolve".
   *  Do not make decisions on this; use burnPctPerHourUpper. */
  burnPctPerHour: number | null
  /** The quantization-safe UPPER bound on the burn. Every derived figure below is computed from THIS,
   *  so the forecast errs pessimistic: a needless warning is cheap, a false "work freely" is not. */
  burnPctPerHourUpper: number | null
  remainingPct: number | null
  /** Hours until the cap is hit, in the WORST case consistent with the readings. Null = unmeasurable. */
  headroomHours: number | null
  /** ISO instant the cap is projected to be hit (worst case). Null = unmeasurable. */
  exhaustsAt: string | null
  hoursToReset: number | null
  /**
   * THE FIELD THAT DECIDES THINGS. False = the cap will not bite before it resets, so work freely no
   * matter how alarming the % looks. True = you will be cut off in `headroomHours`. Null = unknown.
   */
  exhaustsBeforeReset: boolean | null
  /** How many readings the forecast is based on (more = more trustworthy). */
  samples: number
}

/** Tokens actually spent, counted from the transcripts. See server/src/usage-tokens.ts. */
export interface TokenSpend {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** Plain sum of the four. Reported for transparency, but do NOT budget with it: a cached prefix is
   *  re-read on every turn, so this mostly measures (context size x turns), not cost. */
  raw: number
  /**
   * The unit to budget in: base-input-token EQUIVALENTS, i.e. the four counts converted to one scale
   * by their price ratios (cache read x0.1, cache write x1.25, output x5) and by the model's own
   * price (Opus ~5x Sonnet, Haiku ~0.27x). This is proportional to what actually burns quota.
   */
  weighted: number
  /** Assistant turns counted. */
  turns: number
  byModel: Record<string, ModelSpend>
}

/** One model's share of a {@link TokenSpend}. */
export interface ModelSpend {
  weighted: number
  output: number
  turns: number
  /** The raw counts, kept per model because a DOLLAR cost has to be computed at that model's own
   *  published rates (server/src/pricing.ts) — `weighted` deliberately collapses the models into
   *  one scale and cannot be turned back into money. */
  input: number
  cacheRead: number
  /** Cache WRITES, split by TTL: a 1-hour write costs 2x base input where a 5-minute write costs
   *  1.25x, so one combined figure cannot be priced correctly. Transcripts carry the split
   *  (`usage.cache_creation`); when they don't, the whole write lands on 5m (the default TTL). */
  cacheCreation5m: number
  cacheCreation1h: number
}

/** Why a session has no usage figure. 'ok' is the only state that carries numbers. */
export type SessionUsageStatus = 'ok' | 'source-unsupported' | 'unreadable'

/**
 * Tokens and dollars for ONE session, computed on demand by streaming that single transcript.
 * Nothing is stored: see server/src/session-usage.ts.
 */
export interface SessionUsage {
  session_id: string
  source: SessionSource
  status: SessionUsageStatus
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
    /** Plain sum of the four, i.e. every token the API charged for in this session. */
    total: number
    /** Assistant turns counted. */
    turns: number
  }
  /** USD at published list prices, or null when no model in the session has a published price.
   *  A non-null value alongside a non-empty `unpricedModels` is a LOWER BOUND. */
  costUsd: number | null
  pricedModels: string[]
  /** Model ids that carried tokens but have no published price — never guessed at. */
  unpricedModels: string[]
  /** The day the prices in force were last known good (ISO date) — the download date when a
   *  catalog is in force, this build's own constant otherwise. A stale figure must read stale. */
  pricesAsOf: string
}

/** How much to trust a token-derived number. */
export type BudgetConfidence = 'good' | 'rough' | 'none'

/**
 * The answer to "how much can I actually spend?", in tokens rather than percent.
 *
 * `tokensPerPercent` is MEASURED, not given: tokens/hour (from transcripts) divided by percent/hour
 * (from the usage history). Anthropic never tells us the real quota, so we infer its size from how
 * fast our own measurable spend moves the needle.
 */
export interface UsageBudget {
  forecast: UsageForecast
  /** Spend in the lookback window used to derive the rate. */
  spend: TokenSpend
  lookbackHours: number
  /** Weighted (cost-equivalent) tokens per hour over the lookback. */
  weightedPerHour: number | null
  /** Empirically-derived size of 1% of the weekly quota, in weighted tokens. */
  weightedPerPercent: number | null
  /** Estimated weighted tokens left before the weekly cap. */
  remainingWeighted: number | null
  /**
   * THE PRACTICAL QUANTITY. Roughly how many more assistant turns fit in the remaining quota, at the
   * average cost of your recent turns. An agent can reason about turns; it cannot easily predict its
   * own raw token totals. Null when there's nothing to derive it from.
   */
  remainingTurns: number | null
  /** Average weighted cost of one recent assistant turn (what remainingTurns divides by). */
  weightedPerTurn: number | null
  confidence: BudgetConfidence
  /** Why the confidence is what it is, and what would make it wrong. Always populated. */
  caveat: string
}

/** Response of a usage-check route: the snapshot + whether it came from cache + its cache key. */
export interface UsageCheckResult {
  snapshot: UsageSnapshot
  cached: boolean
  key: string
  /** Why the result is what it is (esp. for a no-data snapshot). Optional for back-compat. */
  reason?: UsageReason
  /** What to do about these numbers. Attached by the routes so an MCP caller never re-derives it. */
  advice?: UsageAdvice
}

// --- CLI instances (Feature A) ----------------------------------------------

/** A CLI instance: a `CLAUDE_CONFIG_DIR` associated with an account, logged in once. */
export interface CliInstance {
  /** Permanent short handle (`#7`), shared with desktop + Codex instances in one sequence. See
   *  core/instance-numbers.ts. Re-derived from the registry on every hydrate; the copy that ends
   *  up in the store file is a mirror, never the source of truth. */
  num: number
  id: string
  name: string
  configDir: string
  associatedAccountId: string | null
  associatedAccountLabel: string | null
  /**
   * The DESKTOP instance this CLI login belongs to (an `~/.claude-instances` dir). A desktop app
   * and a CLI login are two independent auth stores, but in practice they are the SAME Anthropic
   * account used for two different purposes — so linking them lets the UI group them as one account
   * and lets each act as the other's usage-check fallback. Null = not linked.
   */
  associatedDesktopDir: string | null
  /** Display label of the linked desktop instance, cached for rendering. */
  associatedDesktopLabel: string | null
  loggedIn: boolean
  lastUsageCheck: UsageSnapshot | null
  createdAt: number
}

/** An isolated Codex CLI + Desktop login rooted at its own CODEX_HOME. */
export interface CodexInstance {
  /** Permanent short handle (`#7`), shared with the Claude desktop + CLI instances in one
   *  sequence. See core/instance-numbers.ts. */
  num: number
  id: string
  name: string
  codexHome: string
  loggedIn: boolean
  /**
   * Which ChatGPT account this CODEX_HOME is signed into. Attached EAGERLY on every list, unlike
   * the Claude side's lazily-resolved `CMInstance.account`: a CODEX_HOME's auth.json is plain JSON,
   * so the local read is a file read plus a base64 decode rather than a safeStorage/DPAPI round
   * trip. Carries the last-known plan from the token's claims; the live usage call refreshes it.
   * Null only when the store row could not be read at all.
   */
  account: CodexAccount | null
  /** Electron/Chromium profile isolated from both the regular app and the other instances. */
  desktopUserDataDir: string
  isDesktopRunning: boolean
  desktopPid: number | null
  /**
   * True for a row this app did NOT create: the default Codex install, or a Codex Desktop found
   * running from a profile outside our instances root. They are listed because they are real
   * accounts doing real work, and mirror `CMInstance.isExternal` on the Claude side — but they have
   * no store row, so they cannot be renamed or deleted.
   */
  isExternal: boolean
  /** True for the ONE default (non-isolated) Codex install. Always external; never deletable. */
  isDefault: boolean
  /** Epoch ms; 0 for a discovered row, which has no creation record of ours. */
  createdAt: number
}

/** Provider/surface visibility plus opt-in integrations. */
export interface ProviderSettings {
  codexDesktopEnabled: boolean
  codexCliEnabled: boolean
  chatGptHandoffEnabled: boolean
}

/** Bounded, secret-screened repository context returned for a manual ChatGPT handoff. */
export interface ChatGptContextPack {
  filename: string
  content: string
  prompt: string
  includedFiles: string[]
  omittedFiles: number
  estimatedTokens: number
  truncated: boolean
  warnings: string[]
}

// --- usage settings ----------------------------------------------------------

/** Auto-refresh + section-visibility settings (persisted in the db `settings` table). */
export interface UsageSettings {
  /** Periodically re-check every checkable instance in the background. ON by default: the direct
   *  API read costs ~300ms and no quota, so there is no reason to make the user click. */
  autoRefresh: boolean
  /** Minutes between auto-refresh sweeps. */
  autoRefreshIntervalMin: number
  /** Show the desktop-instances table (for people who only use the CLI). */
  showDesktopInstances: boolean
  /** Show the CLI-instances table (for people who only use the desktop app). */
  showCliInstances: boolean
}

// --- reset notifications -----------------------------------------------------
// "Tell me the moment my quota comes back." The percentages already flow through the usage sweep;
// these types are about turning the EDGE (a window rolling over) into something that reaches the
// user while the app is in the tray and they're looking at something else.

/** Which quota window rolled over. */
export type ResetKind = 'session' | 'weekAll'

/**
 * One detected reset, kept until acknowledged.
 *
 * It outlives the process on purpose (persisted to disk): a reset that fires at 3am while the
 * daemon is restarting for an auto-update would otherwise be lost, which is the one case the whole
 * feature exists for. `repeats` is what persistent ("annoying") mode counts.
 */
export interface ResetEvent {
  id: string
  /** Usage-cache key of the instance whose window reset (`desktop:<dir>` / `cli:<id>`). */
  key: string
  /** Human label for the instance, resolved when the event was raised. */
  label: string
  kind: ResetKind
  /** ISO instant the window was scheduled to reset at. */
  resetAt: string
  /** ISO instant we noticed. Later than `resetAt` by however long the detection lagged. */
  detectedAt: string
  /** The percentage that was in use just before the rollover — the "you were at 97%" in the copy. */
  previousPct: number | null
  /** The percentage read after it. Usually near 0; null when the post-reset read had no numbers. */
  currentPct: number | null
  acknowledged: boolean
  /** How many times it has been re-raised by persistent mode (0 = only the original). */
  repeats: number
  /** ISO instant of the most recent delivery — what the repeat interval is measured from. */
  lastNotifiedAt: string
}

/** Per-channel outcome of one delivery attempt, so the UI can say WHICH channel failed. */
export interface NotifyDeliveryResult {
  desktop: { attempted: boolean; ok: boolean; error?: string }
  email: { attempted: boolean; ok: boolean; error?: string }
}

/** Notification settings (persisted in the db `settings` table; the SMTP password is sealed). */
export interface NotificationSettings {
  /** Master switch for reset notifications. */
  notifyEnabled: boolean
  /** Notify when the 5-hour session window rolls over. */
  notifySessionReset: boolean
  /** Notify when the weekly (all-models) window rolls over. */
  notifyWeeklyReset: boolean
  /** Suppress a reset whose pre-reset usage was below this. 0 = notify on every reset. */
  notifyMinPct: number
  /**
   * Suppress a 5-HOUR reset when the same account's WEEKLY cap is still at or above this.
   *
   * A session window coming back does not make an account usable if the weekly all-models cap is
   * still spent — the account stays blocked, so the toast is pure noise. This is the same judgement
   * the Instances tab's usage filter makes when it sets a row aside (see lib/usage-filter.ts, same
   * default of 80), applied to notifications: an account outside the filter should not be paging
   * you about a window that changes nothing.
   *
   * Only gates `session` events; a WEEKLY reset is always the one that actually unblocks an account
   * and is never suppressed by this. 100 keeps only the fully-exhausted case suppressed; to silence
   * session resets outright, turn off notifySessionReset.
   */
  notifySessionMaxWeeklyPct: number
  /** Raise a native OS notification (Windows toast / macOS / notify-send). */
  notifyDesktop: boolean
  /** Persistent ("annoying") mode: keep re-raising until acknowledged. */
  notifyPersistent: boolean
  /** Minutes between repeats in persistent mode. */
  notifyPersistentIntervalMin: number
  /** Stop after this many repeats (0 = never stop until acknowledged). */
  notifyPersistentMaxRepeats: number
  /** Also send an email. */
  notifyEmail: boolean
  notifyEmailTo: string
  notifyEmailFrom: string
  notifySmtpHost: string
  notifySmtpPort: number
  /** true = implicit TLS (465); false = plaintext connect + STARTTLS (587/25). */
  notifySmtpSecure: boolean
  notifySmtpUser: string
  /** Read-only echo: whether a password is stored. The password itself never leaves the server. */
  notifySmtpPassSet: boolean
}

// --- auto-resume monitor (Feature E) ----------------------------------------

export type MonitorStateName = 'scheduled' | 'blocked_weekly' | 'needs_human' | 'done'

export interface MonitorSettings {
  /** Master switch (OFF by default — it auto-prompts sessions while you sleep). */
  enabled: boolean
  /** Resume a session at most this many times before marking it "needs human". */
  maxAttempts: number
  /** Minutes of slack added after the detected 5-hour reset before firing the resume. */
  resumeBufferMin: number
  /** The locked resume prompt (a code-constant default; advanced override). */
  resumePrompt: string
}

/** One tracked rate-limited stop and the state of its (possible) auto-resume. */
export interface MonitorStatusRow {
  itemId: string
  sessionId: string
  accountId: string | null
  title: string | null
  state: MonitorStateName
  message: string | null
  resumeAttempts: number
  resumeItemId: string | null
  updatedAt: string
  /** True when the monitor FOUND this session sitting at a limit on disk rather than watching a run
   *  of its own stop (rate-limit-discovery.ts) — i.e. a session started outside the app entirely.
   *  Surfaced so a stop the app went looking for never reads as one the user queued. */
  discovered: boolean
}

/** The whole monitor view for the UI: settings + tracked stops + per-account overrides. */
export interface MonitorView {
  settings: MonitorSettings
  status: MonitorStatusRow[]
  /** account_id → enabled (absent = follows the global switch). */
  accounts: Record<string, boolean>
}
