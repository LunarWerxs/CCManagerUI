// server/src/usage-tokens.ts — count the tokens you ACTUALLY spent, from the transcripts.
//
// WHY. The usage endpoint reports a percentage and nothing else: `limit_dollars`, `used_dollars` and
// `remaining_dollars` are all null on a subscription, and there are no token counts anywhere in the
// response. So "98%" is a percentage of a number Anthropic will not tell us. An agent asking "can I
// afford this task?" has no denominator to reason with.
//
// But Claude Code writes every assistant turn to `<CLAUDE_CONFIG_DIR>/projects/**/*.jsonl`, and each
// one carries its exact `usage` block (input / output / cache-read / cache-creation) and its model.
// Those are real, countable units. Summing them over a time window gives a tokens-per-hour rate.
//
// Combine that with the %-per-hour burn rate from usage-history.ts and the denominator falls out:
//
//     tokensPerPercent  =  tokens/hour  ÷  percent/hour
//     remainingTokens   =  remainingPct × tokensPerPercent
//
// That is the whole trick. We never learn Anthropic's real quota; we MEASURE it, in the only units an
// agent can actually budget in.
//
// HONEST LIMITS (surfaced on the result, never hidden):
//   - This sees Claude CODE transcripts on THIS machine only. Usage from the Claude Desktop app, the
//     web UI, or another machine still counts against the same %, but we cannot see its tokens. When
//     that happens the derived tokensPerPercent is an OVER-estimate (we attribute all the % movement
//     to the tokens we can see), so `remainingTokens` reads high. `coverage` says how much to trust it.
//   - The corpus is large (thousands of sessions, GBs). We therefore only scan files whose mtime
//     falls inside the window, which keeps a 5-hour lookback to a handful of files.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TokenSpend } from './types'

/** A Claude config dir's transcript root. */
const projectsDir = (configDir: string): string => join(configDir, 'projects')

/** The default (non-isolated) CLI login. */
export const defaultConfigDir = (): string => join(homedir(), '.claude')

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** Per-TTL breakdown of `cache_creation_input_tokens`. Only the dollar cost cares (a 1-hour
   *  write is 2x base input, a 5-minute write 1.25x); the quota weighting below treats both the
   *  same, which is why this never enters weighTurn. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// --- weighting: why a raw token SUM is a garbage metric ---------------------------------------
//
// Naively adding the four token counts produces an absurd number: a Claude Code turn re-reads its
// whole cached prefix every time, so `cache_read_input_tokens` is ~500k on EVERY turn. Summing that
// over a thousand turns "measures" hundreds of millions of tokens, which is really just
// (context size x turn count), not work done, and not what burns quota.
//
// Quota burn tracks COST, and the four kinds of token do not cost the same. So we convert everything
// into one unit -- "base-input-token equivalents" -- using the published price ratios. A cache read
// is a tenth of an input token; an output token is five times one.
//
// The absolute unit does not actually matter, because tokensPerPercent is CALIBRATED empirically
// (see usage-budget.ts) and a constant factor cancels out. What matters is that the unit is
// PROPORTIONAL to real cost, so the calibration stays stable as the mix of cache/output/model shifts.
// A raw sum is not proportional to cost, which is exactly why it had to go.
const W_INPUT = 1
const W_CACHE_CREATION = 1.25 // writing to the cache costs a premium
const W_CACHE_READ = 0.1 // reading from it is the cheap part
const W_OUTPUT = 5 // output is the expensive part

/** Price of a model relative to Sonnet (Opus ~5x, Haiku ~0.27x). Quota is shared across models, so a
 *  turn's weight must account for WHICH model spent it, or an Opus-heavy hour reads as cheap. */
function modelMultiplier(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('opus') || m.includes('fable')) return 5
  if (m.includes('haiku')) return 0.27
  return 1 // sonnet + anything unrecognized: the safe middle
}

/** One turn's cost in base-input-token equivalents. Exported for the test. */
export function weighTurn(usage: RawUsage, model: string): number {
  const raw =
    num(usage.input_tokens) * W_INPUT +
    num(usage.cache_creation_input_tokens) * W_CACHE_CREATION +
    num(usage.cache_read_input_tokens) * W_CACHE_READ +
    num(usage.output_tokens) * W_OUTPUT
  return raw * modelMultiplier(model)
}

/** A fresh, zeroed spend. A factory rather than a shared constant because callers ACCUMULATE into
 *  it — handing out one frozen object would have every caller adding to the same totals. */
export function emptySpend(): TokenSpend {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    raw: 0,
    weighted: 0,
    byModel: {},
    turns: 0,
  }
}

/**
 * Split one turn's cache WRITE by TTL. Current Claude Code writes carry `usage.cache_creation`
 * with the two buckets; older transcripts have only the combined `cache_creation_input_tokens`,
 * and 5 minutes is the default TTL, so that is where an unlabelled write is attributed. The two
 * always sum to the combined figure, which is what the top-level `cacheCreation` total reports.
 */
function splitCacheWrite(usage: RawUsage): { w5m: number; w1h: number } {
  const total = num(usage.cache_creation_input_tokens)
  const split = usage.cache_creation
  if (split) {
    const w5m = num(split.ephemeral_5m_input_tokens)
    const w1h = num(split.ephemeral_1h_input_tokens)
    if (w5m + w1h > 0) return { w5m, w1h }
  }
  return { w5m: total, w1h: 0 }
}

/**
 * Requests already counted, so one API response is charged once.
 *
 * WHY THIS IS NEEDED, measured on a real store rather than assumed. Claude Code does not write one
 * transcript record per assistant reply; it writes one PER CONTENT BLOCK, and stamps the same
 * complete `usage` object on every one of them. A reply that says something and then makes two tool
 * calls is three records, each claiming the full input, cache-read and output of the single request
 * that produced them. Summing records therefore charges that request three times.
 *
 * Across 1,230 transcripts here: 445,317 assistant records carry usage, but only 185,264 distinct
 * (message.id, requestId) pairs. A naive sum reports 148.8 BILLION tokens where the real figure is
 * 64.6 billion, an overcount of 56.6%. Of the 124,042 repeated keys, 4,997 out of a 5,000 sample are
 * byte-identical copies rather than a growing partial, so this is content-block fan-out and not
 * streaming.
 *
 * The map holds the output count applied for each request, which is what distinguishes the two
 * cases: an equal-or-smaller output is a duplicate and contributes nothing, while a larger one is a
 * streaming turn's final record and contributes only the difference.
 */
export type UsageSeen = Map<string, number>

export function newUsageSeen(): UsageSeen {
  return new Map()
}

/**
 * Fold ONE transcript line into `spend`, if it is an assistant turn carrying a usage block inside
 * the window. Returns that turn's timestamp when it counted a dated turn, else null.
 *
 * This is the single per-turn parser in the product: {@link sumTranscriptTokens} runs it over a
 * string and session-usage.ts runs it over a stream, so a whole-session cost and a quota window can
 * never disagree about what a turn spent.
 *
 * `sinceMs <= 0` means "no cutoff", which also lets an undated turn count — a whole-file sum wants
 * every turn, and a missing timestamp is not a reason to drop real spend from a total that has no
 * time window in the first place.
 *
 * A malformed line is skipped rather than aborting (transcripts are appended live, so the last
 * line can be a partial write).
 */
export function accumulateUsageLine(
  spend: TokenSpend,
  line: string,
  sinceMs: number,
  /** See {@link newUsageSeen}. Omit only where a caller genuinely wants every record counted. */
  seen?: UsageSeen,
): number | null {
  if (line?.charCodeAt(0) !== 123 /* '{' */) return null
  // Cheap pre-filter: skip the ~90% of lines that cannot contribute, before paying for JSON.parse.
  if (!line.includes('"usage"')) return null

  let rec: {
    type?: string
    timestamp?: string
    requestId?: string
    message?: { id?: string; model?: string; usage?: RawUsage }
  }
  try {
    rec = JSON.parse(line)
  } catch {
    return null // partial trailing write, or a line we don't understand
  }
  // Only an ASSISTANT turn spends quota. A user turn or tool result can carry a `usage` echo, and
  // counting those would double-count the same spend.
  if (rec.type !== 'assistant') return null
  const usage = rec.message?.usage
  if (!usage) return null
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : Number.NaN
  const dated = Number.isFinite(ts)
  if (sinceMs > 0 && (!dated || ts < sinceMs)) return null

  let input = num(usage.input_tokens)
  let output = num(usage.output_tokens)
  let cacheRead = num(usage.cache_read_input_tokens)
  let cacheCreation = num(usage.cache_creation_input_tokens)
  let { w5m, w1h } = splitCacheWrite(usage)
  const model = rec.message?.model ?? 'unknown'

  // ONE API RESPONSE, SEVERAL RECORDS. See newUsageSeen: Claude Code writes a transcript record per
  // content block and stamps the SAME complete usage object on every one, so a reply with text plus
  // two tool calls appears three times at full price. Counted once here.
  const key = rec.requestId ? `${rec.message?.id ?? ''}|${rec.requestId}` : ''
  if (seen && key) {
    const applied = seen.get(key)
    if (applied === undefined) {
      seen.set(key, output)
    } else if (output <= applied) {
      // Output has not grown, so this record is a repeat of one already counted.
      return null
    } else {
      // Output HAS grown: the finished form of a reply whose earlier record was a partial count.
      // Only the new output is new spend — a request's input side is charged once and does not
      // change between the partial record and the final one.
      seen.set(key, output)
      output -= applied
      input = 0
      cacheRead = 0
      cacheCreation = 0
      w5m = 0
      w1h = 0
    }
  }

  const weightedForModel =
    (input * W_INPUT +
      cacheCreation * W_CACHE_CREATION +
      cacheRead * W_CACHE_READ +
      output * W_OUTPUT) *
    modelMultiplier(model)

  spend.input += input
  spend.output += output
  spend.cacheRead += cacheRead
  spend.cacheCreation += cacheCreation
  spend.raw += input + output + cacheRead + cacheCreation
  spend.weighted += weightedForModel
  spend.turns += 1

  const m = spend.byModel[model] ?? {
    weighted: 0,
    output: 0,
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
  }
  m.weighted += weightedForModel
  m.output += output
  m.turns += 1
  m.input += input
  m.cacheRead += cacheRead
  m.cacheCreation5m += w5m
  m.cacheCreation1h += w1h
  spend.byModel[model] = m

  return dated ? ts : null
}

/**
 * Sum the token usage recorded in one transcript file for turns inside [since, now].
 *
 * Exported for the unit test.
 */
export function sumTranscriptTokens(
  text: string,
  sinceMs: number,
  /** Pass one across several files to also catch a resumed session that copied its parent's
   *  messages into a new transcript: the same request then appears in both, and was billed once. */
  seen: UsageSeen = newUsageSeen(),
): TokenSpend {
  const spend = emptySpend()
  for (const line of text.split('\n')) accumulateUsageLine(spend, line, sinceMs, seen)
  return spend
}

/** Add b into a fresh total. Exported for server/src/session-usage.ts's per-run windowing, which
 *  accumulates one turn at a time so it can drop the ones outside the run's window. */
export function mergeSpend(a: TokenSpend, b: TokenSpend): TokenSpend {
  const byModel = { ...a.byModel }
  for (const [model, m] of Object.entries(b.byModel)) {
    const cur = byModel[model] ?? {
      weighted: 0,
      output: 0,
      turns: 0,
      input: 0,
      cacheRead: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
    }
    byModel[model] = {
      weighted: cur.weighted + m.weighted,
      output: cur.output + m.output,
      turns: cur.turns + m.turns,
      input: cur.input + m.input,
      cacheRead: cur.cacheRead + m.cacheRead,
      cacheCreation5m: cur.cacheCreation5m + m.cacheCreation5m,
      cacheCreation1h: cur.cacheCreation1h + m.cacheCreation1h,
    }
  }
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    raw: a.raw + b.raw,
    weighted: a.weighted + b.weighted,
    turns: a.turns + b.turns,
    byModel,
  }
}

/** How deep under `projects/` the walk goes. A subagent transcript sits at
 *  `<project>/<parent-session>/subagents/agent-<id>.jsonl` (depth 3 from the root) and a
 *  workflow's descendants one or two levels under that; six is headroom, not a target, and it
 *  bounds the walk against a pathological tree. */
const RECENT_TRANSCRIPT_MAX_DEPTH = 6

/** Every *.jsonl under a transcripts root whose mtime is at/after `sinceMs`. The mtime filter is what
 *  keeps this cheap: the corpus is thousands of files and gigabytes, but a 5-hour window touches only
 *  the handful that were actually written to.
 *
 *  RECURSIVE, for the same reason transcript.ts's discovery is (audit AH-33): a Task-tool
 *  subagent writes its OWN transcript, nested under its parent's, carrying its own usage blocks -
 *  separate API calls and separate spend. The old two-level readdir never saw them, so a window in
 *  which the work was delegated reported no token activity at all and the budget's remaining-turn
 *  estimate came out optimistic. Reproduced with a nested-only 12-token fixture: raw 0, turns 0. */
function recentTranscripts(root: string, sinceMs: number): string[] {
  const hits: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // no transcripts here (never used, not logged in, or vanished mid-scan)
    }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < RECENT_TRANSCRIPT_MAX_DEPTH) walk(p, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        if (statSync(p).mtimeMs >= sinceMs) hits.push(p)
      } catch {
        // vanished mid-scan (a session being rotated); skip
      }
    }
  }
  walk(root, 0)
  return hits
}

/**
 * Total tokens spent since `since`, across the given Claude config dirs (default: the plain
 * `~/.claude` login). Reads only the transcripts touched inside the window.
 */
export function tokensSince(since: Date, configDirs: string[] = [defaultConfigDir()]): TokenSpend {
  const sinceMs = since.getTime()
  let spend = emptySpend()
  // Shared across every file in the window. A window is a handful of files, and a resumed session
  // copies its parent's messages into its own transcript, so the same request can appear in two of
  // them and was billed once.
  const seen = newUsageSeen()
  for (const dir of configDirs) {
    for (const file of recentTranscripts(projectsDir(dir), sinceMs)) {
      try {
        spend = mergeSpend(spend, sumTranscriptTokens(readFileSync(file, 'utf8'), sinceMs, seen))
      } catch {
        // unreadable/locked file: skip rather than fail the whole count
      }
    }
  }
  return spend
}

/**
 * The empirically-measured size of one percent of the weekly quota, in tokens.
 *
 * `tokensPerHour / burnPctPerHour`. Returns null when either input is missing or the burn is zero
 * (dividing by a zero burn is how you get an infinite, useless answer).
 */
export function tokensPerPercent(
  tokensPerHour: number | null,
  burnPctPerHour: number | null,
): number | null {
  if (tokensPerHour === null || burnPctPerHour === null) return null
  if (burnPctPerHour <= 0 || tokensPerHour <= 0) return null
  return tokensPerHour / burnPctPerHour
}
