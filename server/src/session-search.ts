// Advanced session BODY search: streams each transcript JSONL file line-by-line (constant
// memory even for gigantic files) instead of buffering it whole, unlike sessions.ts's scanMeta()
// (bounded 12MB tail read) or transcript.ts's readTailBytes() (bounded byte-tail read). Kept in
// its own module so the fast/simple metadata list path (sessions.ts, GET /api/sessions) stays
// completely untouched; this is a separate, slower, opt-in code path.
import safeRegex from 'safe-regex2'
import { readForeignSession } from './foreign-sessions'
import { listHermesSearchEvents } from './hermes-sessions'
import { instanceSessionMap } from './instance-sessions'
import { listOpenCodeSearchEvents } from './opencode-sessions'
import {
  isRefreshing,
  refreshSearchIndex,
  searchIndexCandidates,
  searchIndexCoverage,
} from './search-index'
import { dedupeKey } from './session-locator'
import { eventToTailEventsForSource, listTranscriptFiles, type TranscriptFile } from './transcript'
import type { SessionSearchResponse, SessionSearchResult, SessionSource } from './types'

export type { SessionSearchResponse, SessionSearchResult }

export interface SearchOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  /** Scope to one instance dir name, "default", or "other"; same semantics as listSessions(). */
  instance?: string
  /** Scope to one provider. Omitted means all supported stores. */
  source?: SessionSource
  /** Max sessions returned, newest-first. */
  limit?: number
  /** Max snippets collected per session before moving on. */
  perFileLimit?: number
  /** Wall-clock budget for the whole search; returns partial results past this, never hangs. */
  budgetMs?: number
  /**
   * Which path to take.
   *
   * 'auto' (the default) uses the conversation index when it can answer and is warm, and the
   * streaming scan otherwise. 'scan' forces the exhaustive path: every byte of every transcript,
   * tool output included. That is the escape hatch for the index's two real limits, so it is a
   * parameter rather than a hidden heuristic.
   */
  mode?: 'auto' | 'scan'
}

const DEFAULT_LIMIT = 50
const DEFAULT_PER_FILE_LIMIT = 5
const DEFAULT_BUDGET_MS = 7000
const CONCURRENCY = 6
const SNIPPET_LEN = 160
const MAX_REGEX_LENGTH = 200

/**
 * Which physical store each result came from, keyed by object identity rather than a public field.
 *
 * `SessionSearchResult` deliberately carries no store/path info — session-locator.ts's whole point
 * is that a raw filesystem or database path is never a public identifier — so this is the one place
 * that identity survives for internal use (sortByActivity, below). Set once at construction, read
 * once per request; nothing here is ever serialized into a response.
 */
const resultStoreKey = new WeakMap<SessionSearchResult, string>()

function compact(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function snippetAround(text: string, index: number, len: number): string {
  const t = compact(text)
  // recompute the match index against the compacted string is unreliable, so just center
  // a window on the original index, clamped to the compacted length
  const half = Math.floor(len / 2)
  const start = Math.max(0, Math.min(index, t.length) - half)
  const end = Math.min(t.length, start + len)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < t.length ? '…' : ''
  return `${prefix}${t.slice(start, end)}${suffix}`
}

type Matcher = (haystack: string) => number // returns match index, or -1

function buildMatcher(opts: SearchOptions): Matcher {
  const { query, regex, caseSensitive } = opts
  if (regex) {
    // A deadline cannot interrupt a synchronous RegExp.exec once catastrophic backtracking has
    // started. Reject structurally unsafe (or unreasonable) patterns before compiling; the
    // wall-clock budget below then bounds the ordinary multi-file work around each match.
    if (query.length > MAX_REGEX_LENGTH)
      throw new Error(`regular expression must be at most ${MAX_REGEX_LENGTH} characters`)
    if (!safeRegex(query)) throw new Error('unsafe regular expression')
    const re = new RegExp(query, caseSensitive ? '' : 'i')
    return (haystack: string) => {
      const m = re.exec(haystack)
      return m ? m.index : -1
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  return (haystack: string) => {
    const h = caseSensitive ? haystack : haystack.toLowerCase()
    return h.indexOf(needle)
  }
}

/** Streams a file's lines with constant memory via Bun's native ReadableStream, decoding and
 *  splitting on '\n' manually (mirrors dispatch.ts's `for await (const chunk of proc.stdout)`
 *  pump idiom, different source, same shape). Never buffers the whole file into memory.
 *
 *  Exported because session-usage.ts needs the same constant-memory read over a single transcript
 *  (the largest on a real machine is ~40 MB, which is not a thing to hold in the daemon's heap). */
export async function* streamLines(path: string): AsyncGenerator<string> {
  const stream = Bun.file(path).stream()
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      idx = buf.indexOf('\n')
    }
  }
  buf += decoder.decode()
  if (buf) yield buf
}

/** Extracts the displayable text for one parsed JSONL event (same filter used for the
 *  transcript view, via the provider-aware event converter), so body search matches what's shown,
 *  not raw JSON noise like tool-call ids or base64. */
function displayableText(tf: TranscriptFile, ev: any): string[] {
  const tes = eventToTailEventsForSource(tf.source, ev)
  return tes.map((e) => e.text).filter(Boolean)
}

/** One file's outcome. `stoppedEarly` means the wall-clock budget ran out PART-WAY THROUGH this
 *  file, so its match count is an undercount and a miss proves nothing — the caller has to be able
 *  to say so rather than reporting a confident zero. */
interface FileSearchOutcome {
  hit: SessionSearchResult | null
  stoppedEarly: boolean
}

/** Exported for the unit test: this is where the deadline is actually noticed, and the flag it
 *  raises is what stops an empty result from being read as "the text is not on this machine". */
/** A foreign store is not JSONL, and streaming it line by line found NOTHING — every line failed
 *  JSON.parse and was skipped, so a Cursor or Zed conversation containing the query reported a
 *  confident zero. Those rows were already in this sweep (only OpenCode is excluded above), so the
 *  miss was silent: the session was listed, searched, and declared clean. Ask its adapter instead,
 *  exactly as the transcript view and the exporter already do. */
function searchForeignFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
): FileSearchOutcome {
  let matchCount = 0
  const snippets: string[] = []
  try {
    for (const ev of readForeignSession(tf.tool ?? '', tf.path)) {
      const idx = matcher(ev.text)
      if (idx === -1) continue
      matchCount++
      if (snippets.length < perFileLimit) snippets.push(snippetAround(ev.text, idx, SNIPPET_LEN))
    }
  } catch {
    return { hit: null, stoppedEarly: false }
  }
  // No deadline check: an adapter reads a whole conversation in one call, so there is no
  // part-way point to stop at and nothing to under-report. `stoppedEarly` stays false because it
  // means "this file's count is an undercount", which here it never is.
  if (matchCount === 0) return { hit: null, stoppedEarly: false }
  const hit: SessionSearchResult = {
    session_id: tf.session_id,
    source: tf.source,
    cwd: tf.cwd || tf.project,
    project: tf.project,
    match_count: matchCount,
    truncated: snippets.length < matchCount,
    snippets,
  }
  resultStoreKey.set(hit, dedupeKey(tf))
  return { stoppedEarly: false, hit }
}

/** One line's contribution to a file search: the cwd it revealed (if any, first-hit-wins so the
 *  caller only adopts it when it doesn't already have one), how many matches it added, and the
 *  snippets worth keeping. Pulled out of searchOneFile so the per-line parse/match branching
 *  doesn't live inside the streaming loop. */
function matchSearchLine(
  rawLine: string,
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
  snippetsSoFar: number,
): { cwd: string | null; matches: number; snippets: string[] } | null {
  const line = rawLine.trim()
  if (!line) return null
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  const cwd =
    (typeof ev?.cwd === 'string' && ev.cwd) ||
    (typeof ev?.payload?.cwd === 'string' && ev.payload.cwd) ||
    null

  const snippets: string[] = []
  let matches = 0
  for (const text of displayableText(tf, ev)) {
    const idx = matcher(text)
    if (idx === -1) continue
    matches++
    if (snippetsSoFar + snippets.length < perFileLimit)
      snippets.push(snippetAround(text, idx, SNIPPET_LEN))
    break // one match counted per event line is enough signal; avoid double-counting blocks
  }
  return { cwd, matches, snippets }
}

export async function searchOneFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
  deadline: number,
): Promise<FileSearchOutcome> {
  if (tf.source === 'foreign') return searchForeignFile(tf, matcher, perFileLimit)

  let matchCount = 0
  const snippets: string[] = []
  let cwd = ''
  let stoppedEarly = false

  try {
    for await (const rawLine of streamLines(tf.path)) {
      if (performance.now() > deadline) {
        stoppedEarly = true
        break
      }
      const result = matchSearchLine(rawLine, tf, matcher, perFileLimit, snippets.length)
      if (!result) continue
      if (!cwd && result.cwd) cwd = result.cwd
      matchCount += result.matches
      snippets.push(...result.snippets)
      if (snippets.length >= perFileLimit && matchCount >= perFileLimit * 4) break // this file is clearly a hit; stop early
    }
  } catch {
    return { hit: null, stoppedEarly } // unreadable/vanished file, skip silently, best-effort
  }

  if (matchCount === 0) return { hit: null, stoppedEarly }
  const hit: SessionSearchResult = {
    session_id: tf.session_id,
    source: tf.source,
    cwd: cwd || tf.project,
    project: tf.project,
    match_count: matchCount,
    truncated: snippets.length < matchCount,
    snippets,
  }
  resultStoreKey.set(hit, dedupeKey(tf))
  return { stoppedEarly, hit }
}

/**
 * OpenCode-format stores, plural (audit AH-34): Kilo, MiMo Code and IcodeMate each keep their own
 * database in this same schema, and reading only the default one made every other product's
 * sessions unsearchable even though they were indexed and listed just fine. Same shape as
 * searchHermes below — build the store set from what the transcript index already resolved, then
 * loop each store's own reader — because a database is not a file this loop can stream.
 *
 * The internal `found` map is keyed by dedupeKey, not the bare session id (audit AH-35): two of
 * these stores can share a session id (Kilo and MiMo Code are both `source: 'opencode'`), and a
 * bare-id key would let the second store's events silently merge into the first's result.
 */
function searchOpenCode(
  matcher: Matcher,
  perFileLimit: number,
  limit: number,
): SessionSearchResult[] {
  const stores = new Map<string, string>() // dbPath -> tool (e.g. 'opencode', 'kilo', 'mimocode')
  for (const f of listTranscriptFiles())
    if (f.source === 'opencode') stores.set(f.path, f.tool ?? 'opencode')

  const found = new Map<string, SessionSearchResult>()
  for (const [dbPath, tool] of stores) {
    for (const event of listOpenCodeSearchEvents(dbPath)) {
      const idx = matcher(event.text)
      if (idx === -1) continue
      const key = dedupeKey({
        source: 'opencode',
        tool,
        path: dbPath,
        session_id: event.session_id,
      })
      let result = found.get(key)
      if (!result) {
        if (found.size >= limit) continue
        result = {
          session_id: event.session_id,
          source: 'opencode',
          cwd: event.cwd,
          project: event.project,
          match_count: 0,
          truncated: false,
          snippets: [],
        }
        found.set(key, result)
        resultStoreKey.set(result, key)
      }
      result.match_count++
      if (result.snippets.length < perFileLimit)
        result.snippets.push(snippetAround(event.text, idx, SNIPPET_LEN))
      result.truncated = result.snippets.length < result.match_count
    }
  }
  return [...found.values()]
}

/**
 * Hermes, same shape as searchOpenCode above but over every store this machine has, not just one —
 * a Hermes profile is a wholly separate database, so its sessions turn up nowhere in a single-path
 * lookup. Reuses the paths and profile groupings the transcript index already resolved rather than
 * re-walking the filesystem a second time to find the same stores.
 */
function searchHermes(
  matcher: Matcher,
  perFileLimit: number,
  limit: number,
): SessionSearchResult[] {
  // dbPath -> profile grouping (TranscriptFile.project) + product identity (TranscriptFile.tool)
  const stores = new Map<string, { project: string; tool: string }>()
  for (const f of listTranscriptFiles())
    if (f.source === 'hermes') stores.set(f.path, { project: f.project, tool: f.tool ?? 'hermes' })

  const found = new Map<string, SessionSearchResult>()
  for (const [dbPath, { project, tool }] of stores) {
    for (const event of listHermesSearchEvents(dbPath, project)) {
      const idx = matcher(event.text)
      if (idx === -1) continue
      // Two Hermes profiles both report tool: 'hermes' (session-locator.ts) — the database path is
      // what actually distinguishes them, which is exactly what dedupeKey's storeKey resolves to
      // for a database-backed format. A bare session-id key would merge them (audit AH-35).
      const key = dedupeKey({ source: 'hermes', tool, path: dbPath, session_id: event.session_id })
      let result = found.get(key)
      if (!result) {
        if (found.size >= limit) continue
        result = {
          session_id: event.session_id,
          source: 'hermes',
          cwd: event.cwd,
          project: event.project,
          match_count: 0,
          truncated: false,
          snippets: [],
        }
        found.set(key, result)
        resultStoreKey.set(result, key)
      }
      result.match_count++
      if (result.snippets.length < perFileLimit)
        result.snippets.push(snippetAround(event.text, idx, SNIPPET_LEN))
      result.truncated = result.snippets.length < result.match_count
    }
  }
  return [...found.values()]
}

/** A tiny fixed-size worker pool: runs `items` through `fn` with at most `concurrency` in
 *  flight at once, so many small files don't serialize needlessly while large ones stream. */
async function pooledMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/** Nothing searched, nothing found — the shape a blank query answers with. */
const EMPTY_RESPONSE: SessionSearchResponse = {
  results: [],
  searched: 'scan',
  conversationOnly: false,
  budgetExhausted: false,
  limitReached: false,
  filesSearched: 0,
  filesTotal: 0,
  budgetMs: 0,
}

/**
 * How much of the store the index must already cover before it is allowed to answer.
 *
 * Below this the index would return a confident, complete-looking answer drawn from a fraction of
 * the sessions, which is precisely the failure the budget flag exists to prevent. A cold or
 * half-built index therefore stands aside and lets the scan answer while it finishes in the
 * background.
 */
const INDEX_READY_RATIO = 0.98

/** One pass of background indexing per search attempt, bounded so it never competes for long with
 *  the search that triggered it. Successive searches walk the backlog down. */
const INDEX_REFRESH_BUDGET_MS = 20_000

function warmIndexInBackground(files: TranscriptFile[]) {
  if (isRefreshing()) return
  void refreshSearchIndex(files, { budgetMs: INDEX_REFRESH_BUDGET_MS })
}

/** Newest-active first, the order both paths return results in.
 *
 *  Keyed by dedupeKey, not `${source}:${session_id}` (audit AH-35): two stores sharing a format and
 *  a session id (Kilo/MiMo Code, or two Hermes profiles) would otherwise look up each other's
 *  mtime. `resultStoreKey` carries the identity each result was built with; a result missing from
 *  it (should not happen) just sorts as if it had no activity, rather than borrowing a stranger's. */
function sortByActivity(results: SessionSearchResult[]): SessionSearchResult[] {
  const activity = new Map(listTranscriptFiles().map((file) => [dedupeKey(file), file.mtime_ms]))
  const activityOf = (r: SessionSearchResult) => {
    const key = resultStoreKey.get(r)
    return key !== undefined ? (activity.get(key) ?? 0) : 0
  }
  return results.sort((a, b) => activityOf(b) - activityOf(a))
}

/**
 * Streams every transcript's BODY content looking for `query`, newest files first. Constant
 * memory per file (streamLines), a small worker pool for cross-file concurrency, a per-file
 * early-exit once a file is clearly a match, and an overall wall-clock budget so a huge
 * history or a slow regex returns partial results instead of hanging the request.
 *
 * RETURNS A RESPONSE, NOT A BARE ARRAY, because the budget above makes "no matches" and "gave up
 * after 7 seconds" indistinguishable otherwise. An agent that reads an empty array as proof the
 * text does not exist anywhere is worse off than one that was never given the search at all, so
 * every caller now gets `budgetExhausted` and the file counts behind it.
 */
/** Every transcript file in scope for this search, OpenCode and Hermes excluded (each is searched
 *  separately — see `searchOpenCode`/`searchHermes` — because neither is a file this loop can
 *  stream), newest-first. */
function resolveSearchFiles(opts: SearchOptions): TranscriptFile[] {
  let files = listTranscriptFiles().filter(
    (file) => file.source !== 'opencode' && file.source !== 'hermes',
  )
  if (opts.source) files = files.filter((file) => file.source === opts.source)
  if (opts.instance) {
    const imap = instanceSessionMap()
    files = files.filter((f) =>
      opts.instance === 'other'
        ? f.source === 'claude' && !imap.has(f.session_id)
        : f.source === 'claude' && imap.get(f.session_id) === opts.instance,
    )
  }
  return files.slice().sort((a, b) => b.mtime_ms - a.mtime_ms)
}

/**
 * The fast path: let the conversation index say WHICH sessions, then read only those. Split out of
 * searchSessionBodies, which otherwise had this whole block ahead of (and at the same nesting
 * level as) the scan loop below. Returns null when the index isn't ready or the mode forces a
 * scan, meaning the caller must fall through to searchViaScan — exactly like the original `if`
 * that fell out the bottom without returning.
 *
 * The index holds no text of its own, so snippets and match counts still come from the real
 * transcripts. That keeps one source of truth for what a match looks like, and it is why the
 * index is 12 MB rather than 12 MB plus a copy of everything it covers.
 *
 * Narrowing by the substring matcher afterwards is deliberate, not redundant: the index matches
 * words case-insensitively, so it OVER-selects relative to a substring search, and running the
 * real matcher over the candidates keeps the answer identical in shape to what a scan would say.
 */
async function searchViaIndex(
  opts: SearchOptions,
  query: string,
  matcher: Matcher,
  files: TranscriptFile[],
  found: SessionSearchResult[],
  limit: number,
  perFileLimit: number,
  deadline: number,
  budgetMs: number,
): Promise<SessionSearchResponse | null> {
  if ((opts.mode ?? 'auto') !== 'auto' || files.length === 0) return null
  const coverage = searchIndexCoverage(files)
  const ready = coverage.covered / files.length >= INDEX_READY_RATIO
  if (!ready) warmIndexInBackground(files)
  const candidates = ready
    ? searchIndexCandidates(query, { regex: opts.regex, source: opts.source })
    : null
  if (!candidates) return null

  const hits = files
    .filter((f) => candidates.has(dedupeKey(f)))
    .slice(0, Math.max(0, limit - found.length))
  const outcomes = await pooledMap(hits, CONCURRENCY, (tf) =>
    searchOneFile(tf, matcher, perFileLimit, deadline),
  )
  let ranOut = false
  for (const o of outcomes) {
    if (o.stoppedEarly) ranOut = true
    if (o.hit) found.push(o.hit)
  }
  return {
    results: sortByActivity(found).slice(0, limit),
    searched: 'index',
    // The honest caveat: complete over what was SAID, silent about tool output.
    conversationOnly: true,
    budgetExhausted: ranOut,
    limitReached: candidates.size > hits.length,
    // The index covered every session; `hits.length` is only how many transcripts had to be
    // re-read for snippets. Reporting the smaller number here would tell an agent the search
    // reached 5 of 1,359 sessions, which is the opposite of what happened.
    filesSearched: files.length,
    filesTotal: files.length,
    budgetMs,
  }
}

/** The slow path: a newest-first batch scan over every file in scope, stopping once `limit` is
 *  hit or the clock runs out. Split out of searchSessionBodies for the same reason as
 *  searchViaIndex — this was the other half sitting at the same nesting level. */
async function searchViaScan(
  files: TranscriptFile[],
  matcher: Matcher,
  found: SessionSearchResult[],
  limit: number,
  perFileLimit: number,
  deadline: number,
  budgetMs: number,
): Promise<SessionSearchResponse> {
  // Process in newest-first batches so we can stop dispatching more work once `limit` is hit,
  // without giving up the pool's cross-file concurrency within each batch.
  const batchSize = CONCURRENCY * 3
  let fileFound = 0
  let filesSearched = 0
  let stoppedMidFile = false
  let outOfTime = false
  let limitReached = false
  for (let start = 0; start < files.length; start += batchSize) {
    // Deadline first: hitting the CAP is a different answer from running out of TIME, and the
    // caller reports them differently ("your limit" vs "results may be incomplete").
    if (performance.now() > deadline) {
      outOfTime = true
      break
    }
    if (fileFound >= limit) {
      limitReached = true
      break
    }
    const batch = files.slice(start, start + batchSize)
    const results = await pooledMap(batch, CONCURRENCY, (tf) =>
      searchOneFile(tf, matcher, perFileLimit, deadline),
    )
    filesSearched += batch.length
    for (const r of results) {
      if (r.stoppedEarly) stoppedMidFile = true
      if (r.hit) {
        found.push(r.hit)
        fileFound++
      }
    }
  }

  const sorted = sortByActivity(found)
  // Trimming to `limit` here is also a cap: OpenCode's rows are collected outside the file loop, so
  // the list can exceed the limit without the loop ever having noticed.
  if (sorted.length > limit) limitReached = true
  return {
    results: sorted.slice(0, limit),
    searched: 'scan',
    conversationOnly: false,
    // Either a file was abandoned part-way through, or whole batches were never opened because the
    // clock ran out. Both mean a miss is not evidence of absence. Files left unopened because the
    // LIMIT was hit are a different thing entirely, and are reported as `limitReached`.
    budgetExhausted: stoppedMidFile || outOfTime,
    limitReached,
    filesSearched,
    filesTotal: files.length,
    budgetMs,
  }
}

export async function searchSessionBodies(opts: SearchOptions): Promise<SessionSearchResponse> {
  const query = opts.query.trim()
  if (!query) return EMPTY_RESPONSE

  const matcher = buildMatcher(opts)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const perFileLimit = opts.perFileLimit ?? DEFAULT_PER_FILE_LIMIT
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const deadline = performance.now() + budgetMs

  const files = resolveSearchFiles(opts)

  const found: SessionSearchResult[] = []
  const includeOpenCode = (!opts.source || opts.source === 'opencode') && !opts.instance
  if (includeOpenCode) found.push(...searchOpenCode(matcher, perFileLimit, limit))
  const includeHermes = (!opts.source || opts.source === 'hermes') && !opts.instance
  if (includeHermes) found.push(...searchHermes(matcher, perFileLimit, limit))

  const indexResult = await searchViaIndex(
    opts,
    query,
    matcher,
    files,
    found,
    limit,
    perFileLimit,
    deadline,
    budgetMs,
  )
  if (indexResult) return indexResult

  return searchViaScan(files, matcher, found, limit, perFileLimit, deadline, budgetMs)
}
