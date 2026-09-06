// server/src/analytics.ts — per-session totals, computed once and kept.
//
// WHY THIS COSTS ALMOST NOTHING TO STORE, which is the whole reason it is allowed to exist. The
// scanner already opens every transcript and reads every line to build the session list; it works
// out the title and the message count and throws the rest away. This keeps a handful of TOTALS per
// session instead: tokens per model, a sparse day and hour histogram, tool counts, and four
// counters. About 600 bytes a session, so a five-thousand-session store is a couple of megabytes.
//
// IT IS NOT THE FULL-TEXT INDEX, and must not become it. Nothing here stores a single word of a
// message. Every field is a number or a key that came from a tool name, a model id or a date. If a
// future field needs message text to be useful, it belongs in that other decision, not this one.
//
// WHY A SEPARATE PASS FROM THE LIST SCANNER. `parseMeta` reads the last 12 MB of a transcript,
// which is the right trade for a title and a preview and the wrong one for a total: a session's
// spend is the whole file. This streams the file end to end, like server/src/session-usage.ts does
// for one session on demand, and runs as a background warm so nobody waits for it.
//
// THE ONE APPROXIMATION, stated plainly because it shows up in a chart: a session's cost is exact,
// and its cost ON A GIVEN DAY is apportioned across the days it touched in proportion to the
// weighted tokens spent on each. For a session that ran inside one day (the common case) that is
// exact. For one spanning midnight it splits the session's own total the same way the tokens split,
// which is the closest thing to the truth that a per-model price table can give without storing a
// price-weighted figure per day per model.
//
// AND THAT APPROXIMATION IS NOW WHAT SCOPES A TIME PERIOD TOO (see windowShare). It used to be
// applied per SESSION, on `last_ts`, so a session whose final turn landed inside the window
// contributed its whole life and one that ended a day earlier contributed nothing — not even the
// part that WAS inside. Every panel now takes the same day-proportioned slice, so the headline, the
// per-model split and the day chart cannot disagree about how much of a session belongs in view.
// The residual limit is resolution: a stored row knows which DAY its tokens were spent on and not
// which hour, so a sub-day window ("last 24 hours") is answered at day granularity — it covers the
// days those 24 hours touch. No arrangement of this data can do better; the old rule was not more
// precise, only differently wrong.

import { db } from './db'
import { readHermesUsage } from './hermes-sessions'
import { instanceSessionMap } from './instance-sessions'
import { readOpenCodeUsage } from './opencode-sessions'
import { priceSource, pricesAsOf, priceTokens } from './pricing'
import { streamLines } from './session-search'
import { decodeProjectKey, listTranscriptFiles, type TranscriptFile } from './transcript'
import type {
  ActivityReport,
  AnalyticsCoverage,
  ConcurrencyPoint,
  EditEntry,
  ModelSpend,
  SessionSource,
  SpendBucket,
  SpendReport,
  TokenBreakdown,
} from './types'
import { addTurn, type CodexTurn, CodexUsageReader, openCodeSpend } from './usage-foreign'
import { accumulateUsageLine, emptySpend, newUsageSeen } from './usage-tokens'

/**
 * Bumped when the extracted shape changes, which forces every row to be recomputed.
 *
 * 2: Codex and OpenCode totals. Version 1 stored zero for both, and the freshness check is
 *    (mtime, size) — neither of which moves when the PARSER changes — so every one of those
 *    sessions would have kept its empty row forever. Caught by shipping it: the live daemon
 *    reported one Codex session where the store has 136.
 * 3: Every rollout in a Codex conversation, not just the newest. Codex writes one file per
 *    execution thread and the transcript index keeps one ROW per conversation, so the totals were
 *    reading a single file out of hundreds. On this machine that was 5,283 rollouts collapsing to
 *    146, and the reported Codex spend was a fraction of the real figure.
 * 4: Codex turns that spend before their rollout names a model are attributed to that rollout's
 *    model instead of to a placeholder id. 2,067 of 4,860 rollouts here do this, and the 331B
 *    tokens involved were landing under a fake model called "codex" that no price table matches.
 * 5: Version 3 was WRONG and this undoes it. Codex's `total_token_usage` is a session-wide counter
 *    that every execution thread replays into its own rollout file, so summing a conversation's
 *    files multiplies its spend by the number of threads. It reported 637B tokens where the store
 *    holds 11.9B, a 53x overcount, and named Codex the largest provider on this machine when it is
 *    the second. A conversation is now the LARGEST of its rollouts, never the sum.
 * 6: One Claude API response is charged once. Claude Code writes a transcript record per CONTENT
 *    BLOCK and stamps the same complete usage object on each, so summing records charged a reply
 *    with two tool calls three times: 148.8B tokens reported here against a real 64.6B, 57% high.
 * 7: Claude subagent transcripts are counted. A Task subagent writes its own file nested under the
 *    session that spawned it and makes its own API calls; the index globbed one level deep, so
 *    16,552 files holding 89.8B tokens were invisible against the top level's 64.5B. The freshness
 *    check is (mtime, size) and neither moves when a session merely GAINS sibling files, so only a
 *    version bump forces the recount.
 */
export const ANALYTICS_VERSION = 7

/**
 * Gaps longer than this are not work, they are a lunch break with the window left open.
 *
 * "Agent-minutes" has to mean something, and wall-clock span does not: a session opened at 09:00
 * and touched again at 17:00 spans eight hours of which maybe twenty minutes were real. Summing
 * inter-turn gaps with each one capped gives a figure that tracks engaged time, and the cap is what
 * stops one overnight pause from dwarfing everything else in the chart.
 */
const ACTIVE_GAP_CAP_MS = 5 * 60_000

/** Tools whose use means a file changed. `MultiEdit` is gone from current CLIs but old transcripts
 *  still carry it, and a feed that silently skipped those would be wrong about history. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor'])
/** Where each of them keeps the path. Checked in order; the first present wins. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

/** How many edits one session may contribute to the feed. The feed is a recent-activity surface,
 *  not a version history, and an unbounded list would be the one field here that grows without a
 *  ceiling. */
const MAX_EDITS_PER_SESSION = 40

export interface SessionEdit {
  path: string
  /** Index of the turn that made the change, so the UI can open the transcript at it. */
  turn: number
  ts: number | null
}

export interface SessionAnalytics {
  /** Per-model token totals, the same shape server/src/usage-tokens.ts produces. */
  tokens: Record<string, ModelSpend>
  /** YYYY-MM-DD (local) -> weighted tokens spent that day. */
  days: Record<string, number>
  /** Hour of week, 0 = Sunday 00:00, 167 = Saturday 23:00 -> turns. */
  hours: Record<string, number>
  /** Tool name -> times used. */
  tools: Record<string, number>
  toolErrors: number
  /** Longest run of consecutive failing tool results. A streak is the signal that something was
   *  actually stuck, which a raw count of scattered failures is not. */
  toolErrorStreak: number
  editCount: number
  /** Lines the session ADDED and REMOVED across its edits, counted off the tool inputs. A rough but
   *  honest measure of how much code a chat actually moved — "40 edits" says nothing about whether
   *  they were typo fixes or a rewrite. Both are zero for a session that only read. */
  linesAdded: number
  linesRemoved: number
  /** Distinct files the session touched, which `editCount` (a count of EDIT CALLS) is not. */
  filesTouched: Set<string>
  edits: SessionEdit[]
  compactions: number
  /** Engaged time, in milliseconds. See ACTIVE_GAP_CAP_MS. */
  activeMs: number
  firstTs: number | null
  lastTs: number | null
  /** A cost the PROVIDER computed itself (OpenCode does). Null when nobody but us can price it. */
  providerCostUsd: number | null
}

function emptyAnalytics(): SessionAnalytics {
  return {
    tokens: {},
    days: {},
    hours: {},
    tools: {},
    toolErrors: 0,
    toolErrorStreak: 0,
    editCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: new Set<string>(),
    edits: [],
    compactions: 0,
    activeMs: 0,
    firstTs: null,
    lastTs: null,
    providerCostUsd: null,
  }
}

/** Local date key. Local, not UTC: a chart of "what did I spend on Tuesday" has to agree with the
 *  reader's own calendar, and the daemon runs on the reader's machine. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 0 = Sunday 00:00 … 167 = Saturday 23:00. */
function hourKey(ms: number): number {
  const d = new Date(ms)
  return d.getDay() * 24 + d.getHours()
}

/**
 * Lines an edit added and removed, off the tool's own input.
 *
 * The edit tools carry the text they are replacing: `old_string`/`new_string` for Edit,
 * `content` for Write, `new_source` for a notebook cell. Counting newlines in each is a cheap,
 * local approximation of a diff — it cannot know that a rewritten line is one removed and one
 * added rather than a change, so treat these as a MAGNITUDE of churn rather than as `git diff`.
 * Nothing is read from disk and no diff is computed; this is arithmetic on strings already in
 * the transcript.
 */
function countEditLines(input: unknown, out: SessionAnalytics): void {
  if (!input || typeof input !== 'object') return
  const rec = input as Record<string, unknown>
  const lines = (v: unknown) => (typeof v === 'string' && v ? v.split('\n').length : 0)
  // A whole-file write has no "old" side in the input, so it counts as pure addition — which is
  // what it is from the transcript's point of view.
  out.linesRemoved += lines(rec.old_string)
  out.linesAdded += lines(rec.new_string) + lines(rec.content) + lines(rec.new_source)
}

function firstPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/**
 * OpenCode has already totalled its own session: the numbers are columns on its row, not events in
 * a log, so there is nothing to stream. See openCodeSpend for why `reasoning` is kept out of
 * `output` rather than added to it.
 */
function scanOpenCodeAnalytics(
  sessionId: string | undefined,
  /** The store's database - the row's own, not the default OpenCode one: Kilo, MiMo Code and
   *  IcodeMate are separate OpenCode-format databases (audit AH-34). */
  path: string,
  out: SessionAnalytics,
): SessionAnalytics {
  const row = sessionId ? readOpenCodeUsage(sessionId, path) : null
  if (row) {
    const spend = openCodeSpend(row)
    out.tokens = spend.byModel
    out.providerCostUsd = spend.costUsd
    // No per-turn timestamps exist, so the session's own clock places it on the day chart. That
    // puts a session's whole spend on the day it last ran rather than spreading it, which for a
    // provider that records no turn times is the only honest placement.
    const at = typeof row.time_updated === 'number' ? row.time_updated : null
    if (at) {
      out.firstTs = at
      out.lastTs = at
      const weighted = Object.values(spend.byModel).reduce((n, m) => n + m.weighted, 0)
      out.days[dayKey(at)] = weighted
      out.hours[String(hourKey(at))] = 1
    }
  }
  return out
}

/**
 * Hermes has already totalled its own session, by model, in `session_model_usage` — nothing to
 * stream, same as OpenCode above. `providerCostUsd` is deliberately left null: unlike OpenCode's own
 * passthrough cost, Hermes' totals are priced through THIS repo's catalog (foldSpendRow's generic
 * `priceTokens` pass, in server/src/pricing.ts) so a model the catalog has no price for is flagged
 * unpriced rather than taken on Hermes' own estimated/actual cost for a provider we cannot verify.
 * See the header of server/src/hermes-sessions.ts.
 */
function scanHermesAnalytics(
  sessionId: string | undefined,
  dbPath: string,
  out: SessionAnalytics,
): SessionAnalytics {
  const rows = sessionId ? readHermesUsage(sessionId, dbPath) : []
  if (rows.length === 0) return out
  let latestMs = 0
  for (const row of rows) {
    addTurn(out.tokens, row.model, {
      input: row.input_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      output: row.output_tokens,
    })
    const m = out.tokens[row.model]
    // addTurn counts one call per invocation; corrected to the real API call count so "N replies"
    // does not read as 1 for a session that made hundreds — the same fix openCodeSpend applies.
    if (m) m.turns = Math.max(1, row.api_call_count)
    if (row.last_seen_ms !== null && row.last_seen_ms > latestMs) latestMs = row.last_seen_ms
  }
  // No per-turn timestamps exist below the model-usage aggregate, so — like OpenCode — the
  // session's own clock places its whole spend on one day rather than spreading it across turns
  // that were never individually timed.
  if (latestMs > 0) {
    out.firstTs = latestMs
    out.lastTs = latestMs
    const weighted = Object.values(out.tokens).reduce((n, m) => n + m.weighted, 0)
    out.days[dayKey(latestMs)] = weighted
    out.hours[String(hourKey(latestMs))] = 1
  }
  return out
}

type TranscriptEventForAnalytics = {
  type?: string
  isCompactSummary?: boolean
  timestamp?: string
  message?: { role?: string; content?: unknown }
}

type AnalyticsContentBlock = {
  type?: string
  name?: string
  input?: unknown
  is_error?: boolean
}

/**
 * Fold one content block (a tool_use or tool_result entry) into `out`/the running error streak.
 * Pure aside from mutating `out`'s counters/collections — split out of
 * applyTranscriptEventToAnalytics, which was carrying this branch inline inside its own loop.
 *
 * Returns the streak to carry into the next block (matching the original inline reassignment of
 * `nextStreak`).
 */
function foldContentBlock(
  block: unknown,
  nextTurn: number,
  atMs: number | null,
  streak: number,
  out: SessionAnalytics,
): number {
  if (!block || typeof block !== 'object') return streak
  const b = block as AnalyticsContentBlock
  if (b.type === 'tool_use') {
    const name = typeof b.name === 'string' && b.name ? b.name : 'tool'
    out.tools[name] = (out.tools[name] ?? 0) + 1
    if (EDIT_TOOLS.has(name)) {
      const p = firstPath(b.input)
      if (p) {
        out.editCount++
        out.filesTouched.add(p)
        countEditLines(b.input, out)
        if (out.edits.length < MAX_EDITS_PER_SESSION)
          out.edits.push({ path: p, turn: nextTurn, ts: atMs })
      }
    }
    return streak
  }
  if (b.type === 'tool_result') {
    if (b.is_error === true) {
      const nextStreak = streak + 1
      if (nextStreak > out.toolErrorStreak) out.toolErrorStreak = nextStreak
      out.toolErrors++
      return nextStreak
    }
    return 0
  }
  return streak
}

/**
 * Fold one parsed transcript event (an assistant/tool message) into `out`, given the running
 * turn index and tool-error streak. Pure aside from mutating `out`'s counters/collections — no
 * I/O, no awaits — so it can run synchronously wherever the line-parsing loop reaches it.
 *
 * Returns the next `{ turn, streak }` when the event carried message content (matching the
 * original inline `turn++`), or null when it did not (matching the original inline `continue`,
 * which left `turn`/`streak` untouched for that line).
 */
function applyTranscriptEventToAnalytics(
  ev: TranscriptEventForAnalytics,
  turn: number,
  streak: number,
  out: SessionAnalytics,
): { turn: number; streak: number } | null {
  if (ev.isCompactSummary === true) out.compactions++
  const content = ev.message?.content
  if (!Array.isArray(content)) return null
  const nextTurn = turn + 1
  const at = ev.timestamp ? Date.parse(ev.timestamp) : Number.NaN
  const atMs = Number.isFinite(at) ? at : null
  let nextStreak = streak

  for (const block of content) {
    nextStreak = foldContentBlock(block, nextTurn, atMs, nextStreak, out)
  }
  return { turn: nextTurn, streak: nextStreak }
}

/**
 * Read one transcript end to end and total it up.
 *
 * Streamed, never held whole: these files reach hundreds of megabytes, and this runs over every one
 * of them. The usage arithmetic is delegated to accumulateUsageLine so there is exactly one parser
 * for what a turn cost; everything else here is counting.
 */
export async function scanSessionAnalytics(
  path: string,
  source: SessionSource,
  sessionId?: string,
  /** Other files belonging to the same session. Codex writes one rollout per execution thread and
   *  each carries its own token counter, so a total that reads only `path` reports a fraction of
   *  the truth. See TranscriptFile.siblingPaths. */
  siblingPaths: string[] = [],
): Promise<SessionAnalytics> {
  const out = emptyAnalytics()
  // OpenCode has already totalled its own session: the numbers are columns on its row, not events
  // in a log, so there is nothing to stream. See openCodeSpend for why `reasoning` is kept out of
  // `output` rather than added to it.
  if (source === 'opencode') return scanOpenCodeAnalytics(sessionId, path, out)
  if (source === 'hermes') return scanHermesAnalytics(sessionId, path, out)
  // Not one of these stores records what a turn cost — Copilot bills credits and never writes a
  // token count, and Grok, Kimi and Zed simply do not persist one. So a foreign session is listed
  // and readable and contributes nothing to the spend charts. A zero would claim it was free.
  if (source === 'foreign') return out
  if (source === 'codex') return scanCodexAnalytics([path, ...siblingPaths], out)

  const spend = emptySpend()
  // One API response is one charge, however many transcript records Claude Code split it across.
  // See newUsageSeen: without this a session's tokens read ~2.3x high.
  const seen = newUsageSeen()
  let lastWeighted = 0
  let prevTs: number | null = null
  let turn = -1
  let streak = 0

  // The session's own transcript FIRST, then every subagent it spawned. A Task subagent makes its
  // own API calls into its own file, and those files hold 89.8B tokens against the top level's
  // 64.5B on this machine — leaving them out reported 42% of real Claude spend as the total.
  // Summing is safe here in a way it is not for Codex: every record carries its own request id and
  // `seen` is shared across the files, so nothing can be charged twice.
  for await (const raw of streamSessionLines(path, siblingPaths)) {
    const line = raw.trim()
    if (!line) continue

    // The usage pass first, and on the RAW line: it has its own cheap pre-filter and its own
    // JSON.parse, and letting it skip the ~90% of lines with no `"usage"` in them is most of why
    // this is fast enough to run over a whole store.
    const ts = accumulateUsageLine(spend, line, 0, seen)
    if (ts !== null) {
      const weighted = spend.weighted - lastWeighted
      lastWeighted = spend.weighted
      const day = dayKey(ts)
      out.days[day] = (out.days[day] ?? 0) + weighted
      const hour = String(hourKey(ts))
      out.hours[hour] = (out.hours[hour] ?? 0) + 1
      if (out.firstTs === null) out.firstTs = ts
      out.lastTs = ts
      if (prevTs !== null && ts > prevTs) out.activeMs += Math.min(ts - prevTs, ACTIVE_GAP_CAP_MS)
      prevTs = ts
    }

    // Everything below needs the parsed event. Skip lines that cannot carry one rather than
    // parsing every line twice. A subagent's tool use IS the parent's work and counts; its edits
    // are attributed to the parent's turn index, which is the only turn a reader can jump to.
    if (
      !line.includes('"tool_use"') &&
      !line.includes('"tool_result"') &&
      !line.includes('Compact')
    )
      continue
    let ev: TranscriptEventForAnalytics
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const next = applyTranscriptEventToAnalytics(ev, turn, streak, out)
    if (next) {
      turn = next.turn
      streak = next.streak
    }
  }

  out.tokens = spend.byModel
  return out
}

/**
 * Every line of a session: its own transcript, then each of the extra files it owns.
 *
 * One generator rather than a loop per file so the scan body stays a single pass over "lines of
 * this session". A file that vanished (Claude Code prunes old subagent transcripts) is skipped;
 * losing the whole session over one missing child would be a far larger error than the child.
 */
async function* streamSessionLines(path: string, siblingPaths: string[]): AsyncGenerator<string> {
  for await (const line of streamLines(path)) yield line
  for (const extra of siblingPaths) {
    try {
      for await (const line of streamLines(extra)) yield line
    } catch {
      // gone between the index build and now
    }
  }
}

/**
 * Codex rollouts: the same totals, from a completely different log.
 *
 * Separate from the Claude walk above rather than bolted into it, because almost nothing is shared.
 * Codex announces its model in `turn_context`, reports usage as a running cumulative in
 * `token_count`, files tool calls under `response_item` shapes of its own, and has no notion of a
 * `tool_result.is_error` block at all. Forcing one loop to serve both would be a function with two
 * unrelated halves and a flag.
 */
/**
 * A Codex conversation's totals: the LARGEST of its rollouts, never the sum of them.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT, because it was made here and shipped. Codex writes one
 * rollout file per execution thread, and it looks exactly like each file carries that thread's own
 * spend — so summing them looks like the fix for an undercount. It is not. `total_token_usage` is a
 * SESSION-WIDE running total that every thread writes into its own file, so each rollout replays
 * the whole conversation's counter from the beginning.
 *
 * Measured, not reasoned: in one real conversation the main rollout and three subagent rollouts all
 * open at exactly `18558 input / 11008 cached / 480 output`, and three subagents that ran inside a
 * nine-minute window each record 5,090 counter events climbing to 552 MILLION tokens. No nine-minute
 * thread makes five thousand API calls. They are one counter seen four times. Summing 679 files
 * turned a 700M-token conversation into 92.9B, and the store total from 11.9B into 637B.
 *
 * So: read each file, keep the one that reached the highest total, discard the rest. Across 109
 * conversations that is the main rollout 107 times; the two exceptions are conversations whose main
 * rollout stopped being written before a subagent did, and taking the maximum gets those right too.
 */
async function scanCodexAnalytics(
  paths: string[],
  out: SessionAnalytics,
): Promise<SessionAnalytics> {
  let best: SessionAnalytics | null = null
  let bestTotal = -1
  for (const path of paths) {
    const one = emptyAnalytics()
    // Per FILE. Codex moves rollouts between `sessions/` and `archived_sessions/` while the daemon
    // is scanning, so one vanishing mid-read is expected rather than exceptional.
    try {
      await scanOneCodexRollout(path, one)
    } catch {
      continue
    }
    let total = 0
    for (const s of Object.values(one.tokens))
      total += s.input + s.cacheRead + s.cacheCreation5m + s.output
    if (total > bestTotal) {
      bestTotal = total
      best = one
    }
  }
  if (best) {
    // providerCostUsd is set by the OpenCode path only and is null here; everything else on `out`
    // is still the empty shell this was handed.
    Object.assign(out, best, { providerCostUsd: out.providerCostUsd })
  }
  return out
}

/**
 * Fold one dated Codex usage turn into `out`'s day/hour/activity charts and returns the new
 * `prevTs` for the caller's activity-gap tracking. Pure aside from mutating `out` — no I/O, no
 * awaits — split out of scanOneCodexRollout's per-line loop where it was inline before.
 */
function applyCodexTurnToAnalytics(
  t: CodexTurn,
  out: SessionAnalytics,
  prevTs: number | null,
): number | null {
  if (t.ts === null) return prevTs
  const day = dayKey(t.ts)
  // Weighted so the day chart apportions a Codex session the same way it does a Claude one.
  out.days[day] =
    (out.days[day] ?? 0) + t.input + t.cacheRead * 0.1 + t.cacheWrite * 1.25 + t.output * 5
  const hour = String(hourKey(t.ts))
  out.hours[hour] = (out.hours[hour] ?? 0) + 1
  if (out.firstTs === null || t.ts < out.firstTs) out.firstTs = t.ts
  if (out.lastTs === null || t.ts > out.lastTs) out.lastTs = t.ts
  if (prevTs !== null && t.ts > prevTs) out.activeMs += Math.min(t.ts - prevTs, ACTIVE_GAP_CAP_MS)
  return t.ts
}

/**
 * Record one Codex tool-call response item into `out.tools`/`out.edits`, mirroring the
 * `tool_use` handling in applyTranscriptEventToAnalytics for the Claude format. Pure aside from
 * mutating `out` — split out of scanOneCodexRollout's per-line loop where it was inline before.
 */
function recordCodexToolCall(
  payload: { type?: string; name?: string; arguments?: unknown; call_id?: string },
  turn: number,
  lastTs: number | null,
  out: SessionAnalytics,
): void {
  // Codex has TWO call shapes and both are tool use: `function_call` for a declared tool, and
  // `custom_tool_call` for its sandbox (`exec`, `wait`). Counting only the first missed the two
  // most-used tools in a real rollout entirely.
  //
  // NOTE ON EDITS: no edit is recorded for Codex, deliberately. Its file changes happen INSIDE
  // the `exec` sandbox as free-form code rather than as a tool call with a path argument, so
  // there is nothing structured to read. Guessing a path out of a code string would produce a
  // feed that is wrong in ways nobody could check, which is worse than one that is empty.
  if (
    !(payload.type === 'function_call' || payload.type === 'custom_tool_call') ||
    typeof payload.name !== 'string'
  )
    return
  const name = payload.name || 'tool'
  out.tools[name] = (out.tools[name] ?? 0) + 1
  if (!(EDIT_TOOLS.has(name) || /apply_patch|edit_file|write_file/i.test(name))) return
  let input: unknown = payload.arguments
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      input = null
    }
  }
  const p = firstPath(input)
  if (p) {
    out.editCount++
    out.filesTouched.add(p)
    countEditLines(input, out)
    if (out.edits.length < MAX_EDITS_PER_SESSION) out.edits.push({ path: p, turn, ts: lastTs })
  }
}

async function scanOneCodexRollout(path: string, out: SessionAnalytics): Promise<SessionAnalytics> {
  const paths = [path]
  let turn = -1
  // Turns that spent tokens before their rollout named a model (see CodexTurn.model). Held rather
  // than dropped or guessed: they are real spend, and the file usually names its model a few lines
  // later, at which point they are attributed to it retroactively. Anything still unattributed
  // when the conversation ends falls back to the model the REST of the conversation used, which is
  // a fact about this conversation rather than an invented id.
  let unattributed: Array<{
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
  }> = []
  const attribute = (model: string) => {
    for (const t of unattributed) addTurn(out.tokens, model, t)
    unattributed = []
  }

  for (const path of paths) {
    const reader = new CodexUsageReader()
    let prevTs: number | null = null
    for await (const raw of streamLines(path)) {
      const line = raw.trim()
      if (!line) continue
      let ev: {
        type?: string
        timestamp?: string
        payload?: { type?: string; name?: string; arguments?: unknown; call_id?: string }
      }
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }

      const t = reader.push(ev)
      if (t) {
        // The day/hour/activity work below is model-independent, so an unnamed turn still lands
        // on the charts at full weight — only its per-model row waits.
        if (t.model === null) unattributed.push(t)
        else {
          attribute(t.model)
          addTurn(out.tokens, t.model, t)
        }
        prevTs = applyCodexTurnToAnalytics(t, out, prevTs)
      }

      const payload = ev.payload
      if (!payload) continue
      // Codex logs a compaction as its own top-level event type rather than a flag on a turn.
      if (ev.type === 'compacted') out.compactions++
      if (ev.type !== 'response_item') continue
      turn++
      recordCodexToolCall(payload, turn, out.lastTs, out)
    }
  }
  // Whatever else this rollout established, applied to the turns that named no model themselves.
  // `codex` only when NOTHING in the file ever did — a genuinely unknown model, reported as
  // unpriced rather than dressed up as one we could bill.
  if (unattributed.length) attribute(dominantModel(out.tokens) ?? 'codex')
  return out
}

/** The model carrying the most weighted spend so far, or null when none has any. Weighted rather
 *  than raw tokens so a model that only ever read cache cannot outvote the one doing the work. */
function dominantModel(tokens: Record<string, ModelSpend>): string | null {
  let best: string | null = null
  let bestWeight = -1
  for (const [model, spend] of Object.entries(tokens)) {
    if (spend.weighted > bestWeight) {
      best = model
      bestWeight = spend.weighted
    }
  }
  return best
}

// --- persistence -------------------------------------------------------------------------------
// Stored on session_scan_cache, keyed by the same (path, mtime, size) revision the list scanner
// uses, so a transcript that gains a turn invalidates its analytics along with its title. That is
// why there is no separate staleness bookkeeping here: there is only one notion of "this row
// describes this file as it is now", and it already existed.

interface AnalyticsRow {
  cache_key: string
  session_id: string
  source: string
  project: string
  cwd: string
  analytics_at: number | null
  analytics_version: number | null
  tokens_json: string | null
  days_json: string | null
  hours_json: string | null
  tools_json: string | null
  tool_errors: number | null
  tool_error_streak: number | null
  edit_count: number | null
  compactions: number | null
  active_ms: number | null
  first_ts: number | null
  last_ts: number | null
  provider_cost_usd: number | null
}

const selectRows = db.query<AnalyticsRow, []>(
  'select cache_key, session_id, source, project, cwd, analytics_at, analytics_version, ' +
    'tokens_json, days_json, hours_json, tools_json, tool_errors, tool_error_streak, ' +
    'edit_count, compactions, active_ms, first_ts, last_ts, provider_cost_usd ' +
    'from session_scan_cache ' +
    'where analytics_at is not null',
)

/**
 * The permanent per-session record (db.ts session_stats). Upsert on a stable session key, never a
 * file key: one row per conversation for its whole life.
 *
 * `first_seen_at` is written only on INSERT (the excluded value is ignored on conflict), so it keeps
 * meaning "when this machine first saw this chat" rather than drifting forward on every rescan.
 */
const upsertPermanentStats = db.query(
  'insert into session_stats (session_key, session_id, source, tool, project, cwd, title, ' +
    'instance, first_ts, last_ts, turns, input_tokens, cache_read, cache_write, output_tokens, ' +
    'weighted, cost_usd, active_ms, tool_calls, tool_errors, compactions, edit_count, ' +
    'files_touched, lines_added, lines_removed, size_bytes, tokens_json, days_json, ' +
    'first_seen_at, last_scanned_at, gone_at) ' +
    'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null) ' +
    'on conflict(session_key) do update set ' +
    'tool = excluded.tool, project = excluded.project, cwd = excluded.cwd, title = excluded.title, ' +
    'instance = coalesce(excluded.instance, session_stats.instance), ' +
    'first_ts = excluded.first_ts, last_ts = excluded.last_ts, turns = excluded.turns, ' +
    'input_tokens = excluded.input_tokens, cache_read = excluded.cache_read, ' +
    'cache_write = excluded.cache_write, output_tokens = excluded.output_tokens, ' +
    'weighted = excluded.weighted, cost_usd = excluded.cost_usd, active_ms = excluded.active_ms, ' +
    'tool_calls = excluded.tool_calls, tool_errors = excluded.tool_errors, ' +
    'compactions = excluded.compactions, edit_count = excluded.edit_count, ' +
    'files_touched = excluded.files_touched, lines_added = excluded.lines_added, ' +
    'lines_removed = excluded.lines_removed, size_bytes = excluded.size_bytes, ' +
    'tokens_json = excluded.tokens_json, days_json = excluded.days_json, ' +
    'last_scanned_at = excluded.last_scanned_at, gone_at = null',
)

/** The permanent rows whose transcript is gone — the history the cache can no longer hold. Read
 *  back into spendReport so a total does not shrink when a file is deleted. */
const selectGoneStats = db.query<
  {
    session_key: string
    session_id: string
    source: string
    project: string | null
    cwd: string | null
    tokens_json: string | null
    days_json: string | null
    edit_count: number | null
    active_ms: number | null
    first_ts: number | null
    last_ts: number | null
    last_scanned_at: number | null
  },
  []
>(
  'select session_key, session_id, source, project, cwd, tokens_json, days_json, edit_count, ' +
    'active_ms, first_ts, last_ts, last_scanned_at from session_stats where gone_at is not null',
)

/** Stamp a session as no longer on disk, keeping every number it ever had. Called by the prune in
 *  sessions.ts INSTEAD of forgetting the chat. */
export const markSessionGone = db.query(
  'update session_stats set gone_at = ? where session_key = ? and gone_at is null',
)

const upsertAnalytics = db.query(
  'update session_scan_cache set analytics_at = ?, analytics_version = ?, ' +
    'analytics_mtime_ms = ?, analytics_size_bytes = ?, provider_cost_usd = ?, session_id = ?, ' +
    'source = ?, project = ?, tokens_json = ?, days_json = ?, hours_json = ?, tools_json = ?, ' +
    'tool_errors = ?, tool_error_streak = ?, edit_count = ?, compactions = ?, active_ms = ?, ' +
    'first_ts = ?, last_ts = ? where cache_key = ?',
)

/**
 * A placeholder row, so analytics can be stored for a transcript the LIST scanner has not parsed yet
 * (the two warms run independently, and the list only warms the newest few hundred).
 *
 * `mtime_ms` and `size_bytes` are -1 ON PURPOSE. The list scanner validates its own cache by
 * comparing those against the file on disk, so an impossible pair guarantees it treats this row as
 * stale and re-parses. Writing the REAL pair here looked harmless and was not: the row satisfied the
 * list's freshness check, so the list read this placeholder as a finished parse with a uuid for a
 * title and zero substantive turns — and a session with zero substantive turns is DROPPED from the
 * list. Analytics would have silently deleted sessions from the sessions view.
 */
const insertShell = db.query(
  'insert into session_scan_cache (cache_key, path, mtime_ms, size_bytes, title, cwd, git_branch, ' +
    'message_count, created_at, last_activity_at, last_role, last_text_preview, ' +
    'substantive_turns, scanned_at) values (?, ?, -1, -1, ?, ?, null, 0, null, ?, null, null, 0, ?) ' +
    'on conflict(cache_key) do nothing',
)

const deleteEdits = db.query('delete from session_edits where cache_key = ?')
const insertEdit = db.query(
  'insert into session_edits (cache_key, session_id, source, project, path, turn, ts) ' +
    'values (?, ?, ?, ?, ?, ?, ?)',
)

/** Matches the key server/src/sessions.ts builds; kept in step by the test that pins both. */
export function analyticsCacheKey(tf: TranscriptFile): string {
  return `${tf.source}:${tf.session_id}:${tf.path}`
}

const selectRevision = db.query<
  {
    analytics_mtime_ms: number | null
    analytics_size_bytes: number | null
    analytics_at: number | null
    analytics_version: number | null
  },
  [string]
>(
  'select analytics_mtime_ms, analytics_size_bytes, analytics_at, analytics_version ' +
    'from session_scan_cache where cache_key = ?',
)

/** Compared against the ANALYTICS stamp, never the list scanner's: the two are written by different
 *  passes, and reading the other one's stamp would make each rescan whenever the other ran. */
function needsScan(tf: TranscriptFile): boolean {
  const row = selectRevision.get(analyticsCacheKey(tf))
  if (!row) return true
  if (row.analytics_at === null || row.analytics_version !== ANALYTICS_VERSION) return true
  return row.analytics_mtime_ms !== tf.mtime_ms || row.analytics_size_bytes !== tf.size_bytes
}

function persist(tf: TranscriptFile, a: SessionAnalytics): void {
  const key = analyticsCacheKey(tf)
  // The list scanner owns this row and may not have written it yet (analytics can warm first on a
  // cold store), so a placeholder carries the not-null columns until the real parse fills them in.
  // Its revision is hard-coded to (-1, -1) in the statement itself: see the comment on insertShell
  // for why writing the file's real mtime and size here silently deleted sessions from the list.
  insertShell.run(key, tf.path, tf.session_id, tf.cwd ?? '', tf.mtime_ms, Date.now())
  db.transaction(() => {
    upsertAnalytics.run(
      Date.now(),
      ANALYTICS_VERSION,
      tf.mtime_ms,
      tf.size_bytes,
      a.providerCostUsd,
      tf.session_id,
      tf.source,
      tf.project,
      JSON.stringify(a.tokens),
      JSON.stringify(a.days),
      JSON.stringify(a.hours),
      JSON.stringify(a.tools),
      a.toolErrors,
      a.toolErrorStreak,
      a.editCount,
      a.compactions,
      a.activeMs,
      a.firstTs,
      a.lastTs,
      key,
    )
    deleteEdits.run(key)
    for (const e of a.edits)
      insertEdit.run(
        key,
        tf.session_id,
        tf.source,
        tf.cwd || decodeProjectKey(tf.project),
        e.path,
        e.turn,
        e.ts,
      )
    recordPermanentStats(tf, a)
  })()
}

/**
 * Mirror this scan into the PERMANENT record (see the session_stats table in db.ts).
 *
 * The row above is a cache keyed to a file revision and is deleted the moment the transcript is —
 * which, with Claude Code's 30-day cleanup, is how a year of history became one month of it. This
 * write is the copy that survives. It is an upsert on a stable per-session key rather than on the
 * file's cache key, so a session that gains turns updates its own row instead of accumulating one
 * per revision, and `first_seen_at` records when this machine FIRST saw the chat even after the
 * transcript is long gone.
 *
 * `gone_at` is explicitly cleared here: a transcript that comes back (restored from an archive, or
 * a store remounted) is present again, and a row still flagged as gone would keep saying otherwise.
 */
function recordPermanentStats(tf: TranscriptFile, a: SessionAnalytics): void {
  const totals = emptyTokens()
  for (const spend of Object.values(a.tokens)) addTokens(totals, spend)
  const weighted = Object.values(a.tokens).reduce((n, m) => n + m.weighted, 0)
  const turns = Object.values(a.tokens).reduce((n, m) => n + m.turns, 0)
  const priced = priceTokens(a.tokens, a.lastTs ?? Date.now())
  const cost = a.providerCostUsd ?? priced.costUsd
  const toolCalls = Object.values(a.tools).reduce((n, v) => n + v, 0)
  upsertPermanentStats.run(
    `${tf.source}:${tf.session_id}`,
    tf.session_id,
    tf.source,
    tf.tool ?? null,
    tf.project ?? null,
    tf.cwd || decodeProjectKey(tf.project),
    tf.title ?? null,
    // Which desktop instance (and therefore which ACCOUNT) ran it. The single most perishable fact
    // here: once the transcript is gone nothing else on this machine remembers who paid for it.
    instanceSessionMap().get(tf.session_id) ?? null,
    a.firstTs,
    a.lastTs,
    turns,
    totals.input,
    totals.cacheRead,
    totals.cacheWrite,
    totals.output,
    weighted,
    cost,
    a.activeMs,
    toolCalls,
    a.toolErrors,
    a.compactions,
    a.editCount,
    a.filesTouched.size,
    a.linesAdded,
    a.linesRemoved,
    tf.size_bytes ?? null,
    JSON.stringify(a.tokens),
    JSON.stringify(a.days),
    Date.now(),
    Date.now(),
  )
}

/**
 * The global cap on the edits feed.
 *
 * Every other field here is bounded per session, so the store grows with the number of sessions and
 * nothing else. Edits are the one list, so they get a ceiling of their own: the feed answers "what
 * has been touched lately", and ten thousand rows is far more than that question needs.
 */
const MAX_EDIT_ROWS = 10_000

function pruneEdits(): void {
  try {
    db.run(
      'delete from session_edits where id not in (select id from session_edits order by ts desc, id desc limit ?)',
      [MAX_EDIT_ROWS],
    )
  } catch {
    // Housekeeping only. A store that grew past the cap is a much smaller problem than a warm-up
    // that aborts.
  }
}

export interface AnalyticsRefresh {
  scanned: number
  skipped: number
  /** Transcripts that could not be totalled. Reported rather than swallowed — see the catch below. */
  failed: number
  budgetExhausted: boolean
}

/**
 * Bring the stored totals up to date, newest transcript first, under a wall-clock budget.
 *
 * Newest-first because the charts are read from the recent end: a store that is only half-scanned
 * should be right about this week and missing last year, never the other way round. The budget is
 * what keeps this from monopolising a daemon that is also serving a UI.
 */
export async function refreshAnalytics(
  files: TranscriptFile[],
  opts: { budgetMs?: number; concurrency?: number } = {},
): Promise<AnalyticsRefresh> {
  const deadline = Date.now() + (opts.budgetMs ?? 60_000)
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const queue = [...files].sort((a, b) => b.mtime_ms - a.mtime_ms)
  let scanned = 0
  let skipped = 0
  let failed = 0
  let next = 0
  let budgetExhausted = false

  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= queue.length) return
      if (Date.now() > deadline) {
        budgetExhausted = true
        return
      }
      const tf = queue[i]
      if (!tf) return
      if (!needsScan(tf)) {
        skipped++
        continue
      }
      try {
        const a = await scanSessionAnalytics(tf.path, tf.source, tf.session_id, tf.siblingPaths)
        persist(tf, a)
        scanned++
      } catch (err) {
        // An unreadable or half-written transcript is skipped, not fatal: it will be retried on the
        // next refresh, by which point the writer has usually finished.
        //
        // COUNTED AND REPORTED, though, because a silent catch here hid a real bug during
        // development — a mismatched statement meant every single file failed, and the only symptom
        // was a warm that reported nothing and a table that stayed empty. A failure that happens to
        // EVERY file is not the transient case this catch is for, and `failed` is what makes the
        // difference visible.
        failed++
        if (process.env.AGENTHYDRA_DEBUG_ANALYTICS) console.error('[analytics]', err)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (scanned > 0) pruneEdits()
  return { scanned, skipped, failed, budgetExhausted }
}

let warming: Promise<void> | null = null

/** A pause between chunks, so a long warm leaves the disk to whatever the user is actually doing.
 *  Long enough to be polite, short enough that a full store still finishes within an hour. */
const WARM_CHUNK_GAP_MS = 3_000

/**
 * Warm in the background until the store is actually covered, one bounded chunk at a time.
 *
 * WHY IT LOOPS. This used to be a single 120-second burst, which covered a whole store back when
 * the scan read 1,229 Claude transcripts. It now also reads their 16,579 subagent transcripts, so
 * one burst reaches about a third of the store and then stops — leaving the analytics tab showing
 * a partial answer with no indication that anything would ever finish it, and a Rescan button the
 * user is expected to keep pressing.
 *
 * Chunked rather than one unbounded pass so a slow store cannot hold the daemon's I/O for an hour
 * without interruption, and it stops the moment a chunk makes no progress, which is the honest end
 * condition: either everything is scanned, or the remainder is failing and hammering it will not
 * help.
 */
export function warmAnalyticsInBackground(budgetMs = 120_000): void {
  if (warming) return
  warming = (async () => {
    try {
      for (;;) {
        const r = await refreshAnalytics(listTranscriptFiles(), { budgetMs })
        if (!r.budgetExhausted || r.scanned === 0) break
        await new Promise((resolve) => setTimeout(resolve, WARM_CHUNK_GAP_MS))
      }
    } catch {
      // Analytics are an addition; the rest of the daemon does not depend on them.
    } finally {
      warming = null
    }
  })()
}

// --- aggregates --------------------------------------------------------------------------------

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Which account dispatched a given session, when we dispatched it at all. */
function accountBySession(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const rows = db
      .query<{ session_id: string; label: string | null }, []>(
        "select q.session_id as session_id, coalesce(a.label, q.instance_ref, '') as label " +
          'from queue_items q left join accounts a on a.id = q.account_id',
      )
      .all()
    for (const r of rows) if (r.session_id && r.label) out.set(r.session_id, r.label)
  } catch {
    // A schema that does not carry these columns simply yields no account breakdown.
  }
  return out
}

/**
 * Drop the entries that are not models.
 *
 * The CLI attributes its own synthetic notices (an API error, a cancellation) to a pseudo-model
 * `<synthetic>`, which carries turns and no tokens. Left in, it shows up as a zero-dollar row in a
 * chart of models, where a reader has to work out that it is not one. The stored row keeps it,
 * because that is what the transcript said; only the report leaves it out.
 */
const NON_MODELS = new Set(['<synthetic>', 'unknown'])
function withoutNonModels(tokens: Record<string, ModelSpend>): Record<string, ModelSpend> {
  const out: Record<string, ModelSpend> = {}
  for (const [k, v] of Object.entries(tokens)) if (!NON_MODELS.has(k) || v.weighted > 0) out[k] = v
  return out
}

/**
 * Group projects case-insensitively, and remember the first spelling for display.
 *
 * Windows paths are case-insensitive, and the two sources these come from disagree about the drive
 * letter: `D:\NEWProjects\...` from a session's own cwd, `d:\NEWProjects\...` from the decoded store
 * folder. Grouping on the raw string put one project on the chart twice, which is exactly the kind
 * of mistake a chart makes look authoritative. Caught on real data, not in review.
 */
const projectDisplay = new Map<string, string>()
function projectKeyOf(path: string): string {
  const key = path.toLowerCase()
  if (!projectDisplay.has(key)) projectDisplay.set(key, path)
  return key
}

function addTo(
  map: Map<string, SpendBucket>,
  key: string,
  weighted: number,
  cost: number | null,
  /** Raw four-way split to fold in as well. Supplied by every caller that has one, so the UI's
   *  money/tokens switch can redraw the same chart in either unit instead of some panels going
   *  blank in one of the two modes. */
  tokens?: TokenBreakdown,
) {
  const b = map.get(key) ?? {
    key,
    weighted: 0,
    costUsd: cost === null ? null : 0,
    sessions: 0,
    turns: 0,
  }
  b.weighted += weighted
  if (cost !== null && b.costUsd !== null) b.costUsd += cost
  if (tokens) {
    if (!b.tokens) b.tokens = emptyTokens()
    const into = b.tokens
    into.input += tokens.input
    into.cacheRead += tokens.cacheRead
    into.cacheWrite += tokens.cacheWrite
    into.output += tokens.output
    into.total += tokens.total
  }
  map.set(key, b)
  return b
}

/**
 * How much of a session's work falls inside the requested window, as a fraction of its weighted
 * tokens.
 *
 * ⛔ WHY THIS EXISTS. The window used to be applied per SESSION, on `last_ts`: a session whose last
 * turn landed inside the window contributed its ENTIRE life to the totals, and one that ended a day
 * before it contributed nothing at all — including the part that WAS inside. So "last 7 days" on a
 * machine that runs marathon sessions was neither the last 7 days nor anything else you could name,
 * and it silently disagreed with the day chart drawn right below it, which was always day-accurate.
 *
 * The per-day weighted map is the only per-day fact a stored row has, so it is what scopes the
 * window: the share of a session's weighted tokens spent on days inside it. That is the SAME
 * approximation the day chart has always used for cost (documented at the top of this file), now
 * applied consistently instead of only in one panel.
 *
 * Returns null when the row carries no day data at all — an old row, or one whose turns had no
 * timestamps. Null means "cannot answer from days", and the caller falls back to the `last_ts` test
 * rather than dropping the session, because silently omitting real spend is worse than including a
 * little of it at the wrong end of a boundary.
 */
export function windowShare(days: Record<string, number>, sinceDay: string | null): number | null {
  if (sinceDay === null) return 1
  let total = 0
  let inWindow = 0
  for (const [day, weighted] of Object.entries(days)) {
    total += weighted
    if (day >= sinceDay) inWindow += weighted
  }
  if (total <= 0) return null
  return inWindow / total
}

/** One model's counts scaled by `share`. Turns are rounded because a turn is a count; the token
 *  figures are left fractional here and rounded once, at the point they are reported. */
export function scaleModelSpend(
  tokens: Record<string, ModelSpend>,
  share: number,
): Record<string, ModelSpend> {
  if (share >= 1) return tokens
  const out: Record<string, ModelSpend> = {}
  for (const [model, m] of Object.entries(tokens)) {
    out[model] = {
      weighted: m.weighted * share,
      output: m.output * share,
      turns: Math.round(m.turns * share),
      input: m.input * share,
      cacheRead: m.cacheRead * share,
      cacheCreation5m: m.cacheCreation5m * share,
      cacheCreation1h: m.cacheCreation1h * share,
    }
  }
  return out
}

/** Every category of one breakdown scaled by `share`, for the per-day apportionment. Rounded,
 *  because a token count is a count: the day rows are an approximation of WHEN the tokens were
 *  spent (see foldDaySpend), not a licence to report 1.7 of one. */
function scaleTokens(t: TokenBreakdown, share: number): TokenBreakdown {
  return {
    input: Math.round(t.input * share),
    cacheRead: Math.round(t.cacheRead * share),
    cacheWrite: Math.round(t.cacheWrite * share),
    output: Math.round(t.output * share),
    total: Math.round(t.total * share),
  }
}

/** The four categories, zeroed. */
function emptyTokens(): TokenBreakdown {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
}

/** Fold one model's counts into a running breakdown. The two cache-write TTL slots are summed:
 *  only Anthropic distinguishes them, and a reader asking "how much did I write to cache" wants
 *  one number. */
function addTokens(into: TokenBreakdown, m: ModelSpend): void {
  const write = m.cacheCreation5m + m.cacheCreation1h
  into.input += m.input
  into.cacheRead += m.cacheRead
  into.cacheWrite += write
  into.output += m.output
  into.total += m.input + m.cacheRead + write + m.output
}

const sortBuckets = (m: Map<string, SpendBucket>) =>
  [...m.values()].sort((a, b) => (b.costUsd ?? b.weighted) - (a.costUsd ?? a.weighted))

/**
 * The whole spend report in one pass over the stored rows.
 *
 * One pass rather than four queries because the rows are small and already in this process, and
 * because every breakdown has to agree with every other one: a "by project" total that does not sum
 * to the "by model" total is worse than either on its own.
 */
/** Mutable accumulators threaded through foldSpendRow, one instance per spendReport() call. */
interface SpendAccumulator {
  byModel: Map<string, SpendBucket>
  byProject: Map<string, SpendBucket>
  byDay: Map<string, SpendBucket>
  byAccount: Map<string, SpendBucket>
  byProvider: Map<
    SessionSource,
    { key: SessionSource; tokens: TokenBreakdown; sessions: number; costUsd: number | null }
  >
  unpriced: Set<string>
  tokenTotals: TokenBreakdown
  totalCost: number
  anyPriced: boolean
  totalWeighted: number
  sessions: number
  from: string | null
  to: string | null
}

/**
 * Fold one session's per-model spend into `acc.byModel`/`acc.tokenTotals`, returning the
 * session's total weighted tokens (needed by the caller for the project/account buckets).
 * Pure aside from mutating `acc` — split out of foldSpendRow, which was carrying this loop
 * inline, so the per-row function reads as a sequence of named folds instead of one block.
 *
 * When the PROVIDER priced the session, its models are priced too — split proportionally, the
 * same way the day chart splits a session across days. Without this, "cost by model" showed a
 * dash for every OpenCode model while "cost by provider" showed real money for the same
 * sessions, which is two answers to one question.
 */
function foldModelSpend(
  tokens: Record<string, ModelSpend>,
  hasOwnCost: boolean,
  sessionCost: number | null,
  at: number,
  acc: SpendAccumulator,
): number {
  const totalWeightedInSession = Object.values(tokens).reduce((n, m) => n + m.weighted, 0)
  let sessionWeighted = 0
  for (const [model, spend] of Object.entries(tokens)) {
    sessionWeighted += spend.weighted
    const share =
      hasOwnCost && totalWeightedInSession > 0 ? spend.weighted / totalWeightedInSession : 0
    const modelCost = hasOwnCost
      ? (sessionCost ?? 0) * share
      : priceTokens({ [model]: spend }, at).costUsd
    const b = addTo(acc.byModel, model, spend.weighted, modelCost)
    b.sessions++
    b.turns += spend.turns
    b.tokens = b.tokens ?? emptyTokens()
    addTokens(b.tokens, spend)
    addTokens(acc.tokenTotals, spend)
  }
  return sessionWeighted
}

/**
 * Fold one session's tokens/cost into `acc.byProvider`. Split out of foldSpendRow for the same
 * reason as foldModelSpend — "my statistics only show Claude" is exactly the question this
 * answers, and it is a self-contained accumulation over `tokens`.
 */
function foldProviderSpend(
  provider: SessionSource,
  tokens: Record<string, ModelSpend>,
  sessionCost: number | null,
  acc: SpendAccumulator,
): void {
  const pv = acc.byProvider.get(provider) ?? {
    key: provider,
    tokens: emptyTokens(),
    sessions: 0,
    costUsd: null as number | null,
  }
  for (const spend of Object.values(tokens)) addTokens(pv.tokens, spend)
  pv.sessions++
  if (sessionCost !== null) pv.costUsd = (pv.costUsd ?? 0) + sessionCost
  acc.byProvider.set(provider, pv)
}

/**
 * Fold one session's per-day split into `acc.byDay` (and the `from`/`to` range). Split out of
 * foldSpendRow — the one approximation documented at the top of this file: a session's cost is
 * split across the days it touched in proportion to the weighted tokens spent on each.
 */
function foldDaySpend(
  days: Record<string, number>,
  sessionCost: number | null,
  sessionTokens: TokenBreakdown,
  acc: SpendAccumulator,
): void {
  const dayTotal = Object.values(days).reduce((n, v) => n + v, 0)
  for (const [day, weighted] of Object.entries(days)) {
    const share = dayTotal > 0 ? weighted / dayTotal : 0
    // Raw tokens ride on the SAME share as the cost, for the same reason and with the same caveat:
    // a transcript records what a session spent, not what each of its days spent, so both are an
    // apportionment by the one thing that IS known per day (weighted tokens). Splitting them
    // differently would let the two series on one chart disagree about the same session.
    const db_ = addTo(
      acc.byDay,
      day,
      weighted,
      sessionCost === null ? null : sessionCost * share,
      scaleTokens(sessionTokens, share),
    )
    db_.sessions++
    if (acc.from === null || day < acc.from) acc.from = day
    if (acc.to === null || day > acc.to) acc.to = day
  }
}

/**
 * Fold one analytics_row into the running spendReport accumulators. Pure aside from mutating
 * `acc`'s maps/sets/totals — no I/O, no awaits — split out of spendReport's per-row loop where
 * it was inline before, so the loop itself stays a plain `for (const row of rows) foldSpendRow(...)`.
 */
function foldSpendRow(
  row: AnalyticsRow,
  since: number | null,
  sinceDay: string | null,
  accounts: Map<string, string>,
  acc: SpendAccumulator,
): void {
  if (row.analytics_version !== ANALYTICS_VERSION) return
  const allDays = parseJson<Record<string, number>>(row.days_json, {})

  // Scope the session to the window BEFORE anything is folded, by scaling its own token counts.
  // One multiplication point rather than one per panel: cost, weighted, the raw split, per model,
  // per provider, per project and per account all derive from `tokens` below, so they cannot end up
  // disagreeing about how much of this session belongs in the window. See windowShare.
  const share = windowShare(allDays, sinceDay)
  if (share === null) {
    // No day data to scope by — fall back to the old whole-session test rather than dropping it.
    if (since !== null && (row.last_ts ?? 0) < since) return
  } else if (share <= 0) {
    return
  }
  const scale = share ?? 1
  const tokens = scaleModelSpend(
    withoutNonModels(parseJson<Record<string, ModelSpend>>(row.tokens_json, {})),
    scale,
  )
  const days =
    sinceDay === null
      ? allDays
      : Object.fromEntries(Object.entries(allDays).filter(([day]) => day >= sinceDay))
  const modelKeys = Object.keys(tokens)
  if (modelKeys.length === 0) return
  acc.sessions++

  // Priced at the session's own newest turn, matching what the session header shows, so the two
  // surfaces cannot disagree about the same session.
  const at = row.last_ts ?? Date.now()
  const priced = priceTokens(tokens, at)
  // A cost the provider computed itself wins over our table: OpenCode routes to models this repo
  // has no prices for, and its own figure is the real one rather than a gap we would report as
  // unpriced. Only its models are then left out of the unpriced list, since they ARE priced.
  // Scaled by the same share as the tokens — it is a whole-session figure like they are.
  const ownCost = row.provider_cost_usd
  const hasOwnCost = typeof ownCost === 'number' && Number.isFinite(ownCost)
  if (!hasOwnCost) for (const m of priced.unpriced) acc.unpriced.add(m)
  const sessionCost = hasOwnCost ? (ownCost as number) * scale : priced.costUsd
  if (sessionCost !== null) {
    acc.totalCost += sessionCost
    acc.anyPriced = true
  }

  const sessionWeighted = foldModelSpend(tokens, hasOwnCost, sessionCost, at, acc)
  acc.totalWeighted += sessionWeighted

  // Per provider, because "my statistics only show Claude" is exactly the question this answers.
  const provider = (row.source as SessionSource) ?? 'claude'
  foldProviderSpend(provider, tokens, sessionCost, acc)

  // Decoded, not the raw key. A row whose scan never filled in `cwd` falls back to the transcript
  // store's own folder name (`d--NEWProjects-shared-Connections`), and leaving that undecoded put
  // the SAME project on the chart twice under two spellings — caught on real data, and the kind of
  // error a chart states with total confidence.
  const project = row.cwd || (row.project ? decodeProjectKey(row.project) : '') || 'unknown'
  // The session's own four-way split, folded into every bucket it belongs to so the money/tokens
  // switch can redraw project and account the same way it redraws model.
  const sessionTokens = emptyTokens()
  for (const spend of Object.values(tokens)) addTokens(sessionTokens, spend)

  const pb = addTo(
    acc.byProject,
    projectKeyOf(project),
    sessionWeighted,
    sessionCost,
    sessionTokens,
  )
  pb.sessions++

  const account = accounts.get(row.session_id)
  if (account) {
    const ab = addTo(acc.byAccount, account, sessionWeighted, sessionCost, sessionTokens)
    ab.sessions++
  }

  foldDaySpend(days, sessionCost, sessionTokens, acc)
}

export function spendReport(opts: { sinceMs?: number | null } = {}): SpendReport {
  const since = opts.sinceMs ?? null
  const rows = selectRows.all()
  const accounts = accountBySession()
  projectDisplay.clear()

  const acc: SpendAccumulator = {
    byModel: new Map<string, SpendBucket>(),
    byProject: new Map<string, SpendBucket>(),
    byDay: new Map<string, SpendBucket>(),
    byAccount: new Map<string, SpendBucket>(),
    byProvider: new Map<
      SessionSource,
      { key: SessionSource; tokens: TokenBreakdown; sessions: number; costUsd: number | null }
    >(),
    unpriced: new Set<string>(),
    tokenTotals: emptyTokens(),
    totalCost: 0,
    anyPriced: false,
    totalWeighted: 0,
    sessions: 0,
    from: null,
    to: null,
  }

  // The window as a LOCAL day key, because that is the resolution a stored row records (dayKey()).
  // Same clock the day buckets were written on, so the comparison is apples to apples.
  const sinceDay = since === null ? null : dayKey(since)
  for (const row of rows) foldSpendRow(row, since, sinceDay, accounts, acc)

  // …and the chats whose transcripts are GONE. Their cache rows were deleted with the files, so
  // without this the totals silently shrink as Claude Code's 30-day cleanup runs and "all time"
  // quietly becomes "the last month". The permanent record keeps their numbers (db.ts
  // session_stats); `gone_at is not null` is what makes double counting impossible, since the
  // prune stamps that flag and deletes the cache row in ONE transaction — a session is in exactly
  // one of the two sets, never both.
  for (const g of selectGoneStats.all()) {
    foldSpendRow(
      {
        cache_key: g.session_key,
        session_id: g.session_id,
        source: g.source,
        project: g.project ?? '',
        cwd: g.cwd ?? '',
        analytics_at: g.last_scanned_at,
        analytics_version: ANALYTICS_VERSION,
        tokens_json: g.tokens_json,
        days_json: g.days_json,
        hours_json: null,
        tools_json: null,
        tool_errors: 0,
        tool_error_streak: 0,
        edit_count: g.edit_count,
        compactions: 0,
        active_ms: g.active_ms,
        first_ts: g.first_ts,
        last_ts: g.last_ts,
        provider_cost_usd: null,
      },
      since,
      sinceDay,
      accounts,
      acc,
    )
  }

  return {
    from: acc.from,
    to: acc.to,
    totalCostUsd: acc.anyPriced ? acc.totalCost : null,
    totalWeighted: acc.totalWeighted,
    tokens: acc.tokenTotals,
    byProvider: [...acc.byProvider.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    sessions: acc.sessions,
    byModel: sortBuckets(acc.byModel),
    // Re-labelled with the spelling the reader will recognise, now that grouping is done.
    byProject: sortBuckets(acc.byProject)
      .slice(0, 25)
      .map((b) => ({ ...b, key: projectDisplay.get(b.key) ?? b.key })),
    byDay: [...acc.byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byAccount: sortBuckets(acc.byAccount),
    unpricedModels: [...acc.unpriced].sort(),
    // Where these dollars came from and how old that source is. A cost figure without its price
    // date is a number nobody can audit, and "downloaded" versus "shipped with the build" is the
    // difference between last week's rate card and this release's.
    pricesAsOf: pricesAsOf(),
    priceSource: priceSource(),
    coverage: analyticsCoverage(),
  }
}

export function activityReport(opts: { sinceMs?: number | null } = {}): ActivityReport {
  const since = opts.sinceMs ?? null
  const rows = selectRows.all()
  const hours = new Array<number>(168).fill(0)
  const tools = new Map<string, number>()
  let agentMs = 0
  const health: ActivityReport['health'] = []

  for (const row of rows) {
    if (row.analytics_version !== ANALYTICS_VERSION) continue
    if (since !== null && (row.last_ts ?? 0) < since) continue
    for (const [k, v] of Object.entries(parseJson<Record<string, number>>(row.hours_json, {}))) {
      const i = Number(k)
      if (Number.isInteger(i) && i >= 0 && i < 168) hours[i] = (hours[i] ?? 0) + v
    }
    for (const [k, v] of Object.entries(parseJson<Record<string, number>>(row.tools_json, {})))
      tools.set(k, (tools.get(k) ?? 0) + v)
    agentMs += row.active_ms ?? 0
    const toolErrors = row.tool_errors ?? 0
    const streak = row.tool_error_streak ?? 0
    const compactions = row.compactions ?? 0
    // Only sessions with something to say. A list of every session with zero problems is not a
    // health signal, it is the session list again.
    if (streak >= 3 || toolErrors >= 10 || compactions >= 1)
      health.push({
        session_id: row.session_id,
        source: (row.source as SessionSource) ?? 'claude',
        project: row.cwd || row.project || '',
        toolErrors,
        toolErrorStreak: streak,
        edits: row.edit_count ?? 0,
        compactions,
      })
  }

  health.sort(
    (a, b) =>
      b.toolErrorStreak - a.toolErrorStreak ||
      b.compactions - a.compactions ||
      b.toolErrors - a.toolErrors,
  )

  return {
    hours,
    tools: [...tools.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    agentMinutes: Math.round(agentMs / 60_000),
    health: health.slice(0, 50),
    coverage: analyticsCoverage(),
  }
}

/**
 * How many sessions were alive at the same time, bucketed.
 *
 * Built from the first and last turn of each session rather than from any stored timeline: two
 * numbers per session is all an overlap count needs, so this costs no storage at all.
 */
export function concurrencyReport(opts: {
  sinceMs?: number | null
  bucketMs?: number
}): ConcurrencyPoint[] {
  const bucket = opts.bucketMs ?? 60 * 60_000
  const since = opts.sinceMs ?? Date.now() - 7 * 24 * 60 * 60_000
  const rows = selectRows.all()
  const counts = new Map<number, number>()
  for (const row of rows) {
    if (row.analytics_version !== ANALYTICS_VERSION) continue
    const first = row.first_ts
    const last = row.last_ts
    if (first === null || last === null) continue
    if (last < since) continue
    const start = Math.max(first, since)
    for (let t = Math.floor(start / bucket) * bucket; t <= last; t += bucket)
      counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([at, sessions]) => ({ at, sessions }))
    .sort((a, b) => a.at - b.at)
}

/** The recent-edits feed, newest first, grouped by the caller. */
export function recentEdits(limit = 200): EditEntry[] {
  try {
    return db
      .query<EditEntry, [number]>(
        'select session_id, source, project, path, turn, ts from session_edits ' +
          'order by ts desc, id desc limit ?',
      )
      .all(Math.max(1, Math.min(limit, 1000)))
  } catch {
    return []
  }
}

export function analyticsCoverage(): AnalyticsCoverage {
  let sessions = 0
  let bytes = 0
  try {
    const row = db
      .query<{ n: number; b: number }, [number]>(
        "select count(*) as n, coalesce(sum(length(coalesce(tokens_json, '')) + " +
          "length(coalesce(days_json, '')) + length(coalesce(hours_json, '')) + " +
          "length(coalesce(tools_json, ''))), 0) as b from session_scan_cache " +
          'where analytics_at is not null and analytics_version = ?',
      )
      .get(ANALYTICS_VERSION)
    sessions = row?.n ?? 0
    bytes = row?.b ?? 0
  } catch {
    // A database that predates the migration reports nothing rather than throwing.
  }
  let total = 0
  try {
    total = listTranscriptFiles().length
  } catch {
    total = sessions
  }
  return { sessions, total, refreshing: warming !== null, bytes }
}

/** Forget every stored total. The next warm rebuilds them; nothing else depends on them. */
export function dropAnalytics(): boolean {
  try {
    db.run(
      'update session_scan_cache set analytics_at = null, analytics_version = null, ' +
        'tokens_json = null, days_json = null, hours_json = null, tools_json = null, ' +
        'tool_errors = null, tool_error_streak = null, edit_count = null, compactions = null, ' +
        'active_ms = null, first_ts = null, last_ts = null, provider_cost_usd = null, ' +
        'analytics_mtime_ms = null, ' +
        'analytics_size_bytes = null',
    )
    db.run('delete from session_edits')
    return true
  } catch {
    return false
  }
}
