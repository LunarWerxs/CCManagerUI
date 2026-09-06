// server/src/search-index.ts — the conversation index: find any session instantly, without
// putting a copy of your work on your disk.
//
// WHY THIS EXISTS, AND WHY IT IS SMALL. A content search streams every transcript and gives up
// after seven seconds, which on a real store (1,423 sessions, 4.4 GB) reaches about a fifth of it.
// A full-text index over the whole corpus was declined, correctly: it lands somewhere around
// 200 MB of second copies of files the user already has.
//
// Measured on that store, though, the corpus is not what it looks like:
//
//     tool results (file reads, greps, build logs) ... 343 MB   88%
//     assistant replies .............................. 24 MB    6%
//     human turns .................................... 22 MB    6%
//
// Nearly all of it is tool output: copies of files that are already on the disk, in a repo, under
// version control. Nobody searches a transcript for a grep result. They search it for a
// CONVERSATION they had. So this indexes conversation only, which measured 35 MB of text and, held
// CONTENTLESS (the index alone, no stored copy of the text), comes to ~12 MB on disk. That is
// 0.3% of the store it covers, smaller than the app's own binary, rebuildable from the transcripts
// at any moment, and deletable without losing a thing.
//
// THREE PROPERTIES IT MUST KEEP:
//
//   1. NEVER A DEPENDENCY. Missing, stale, corrupt or switched off, the streaming scan still
//      answers exactly as it did before. This file can be deleted mid-flight and search keeps
//      working, slower.
//   2. NEVER SILENTLY PARTIAL. The index covers conversation, not tool output, and matches whole
//      words rather than arbitrary substrings. Both are real limits, so every answer says which
//      path produced it and the caller can force the exhaustive scan.
//   3. NEVER IN THE WAY. Building it costs ~20 s the first time. That happens in the background,
//      never inside a request, and a search issued before it is ready simply takes the old path.
//
// One file, `search-index.db`, in the app's data dir, with journalling set to `delete` so it stays
// exactly one file: "you can delete it whenever you like" has to survive someone actually doing it.

import { Database, type Statement } from 'bun:sqlite'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import { dedupeKey } from './session-locator'
import type { SearchIndexStatus, SessionSource } from './types'

let indexPath = join(DATA_DIR, 'search-index.db')

/** Where the index lives. A function, not a constant, because the test drives it at a scratch
 *  path and the daemon must never be able to point at the wrong file by import order. */
export const searchIndexPath = (): string => indexPath

/** Bump to force a rebuild when the extraction or schema changes meaning. */
const SCHEMA_VERSION = 2

/**
 * A session's identity, store included (audit AH-35).
 *
 * Used to be `${source}:${sessionId}` alone, which collapses two different PRODUCTS that share a
 * format and a session id (Kilo and MiMo Code are both `source: 'opencode'`, two Hermes profiles
 * are both `tool: 'hermes'`) into one row — the second store indexed just overwrote the first's.
 * `dedupeKey` (session-locator.ts) is the one place that identity is computed everywhere else in
 * this codebase, so this index uses it too rather than inventing a second key format. Bumping
 * SCHEMA_VERSION above forces every row to be rebuilt under the new key rather than mixing old and
 * new formats silently.
 */
const docKey = (f: IndexableFile) => dedupeKey(f)

let db: Database | null = null
let openFailed = false

function open(): Database | null {
  if (db) return db
  if (openFailed) return null
  try {
    db = new Database(indexPath, { create: true })
    // One file, always: a WAL sidecar would make "just delete search-index.db" a corruption bug.
    db.exec('pragma journal_mode = delete')
    db.exec('pragma synchronous = normal')
    db.exec(`
      create table if not exists meta (k text primary key, v text not null);
      create table if not exists doc (
        rowid      integer primary key,
        key        text    not null unique,
        source     text    not null,
        path       text    not null,
        mtime_ms   real    not null,
        size_bytes integer not null
      );
    `)
    // contentless_delete=1 is what makes this incremental: a changed transcript can be dropped by
    // rowid and re-inserted without the index having kept the old text to hand back.
    db.exec(
      "create virtual table if not exists conv using fts5(body, tokenize='unicode61', content='', contentless_delete=1)",
    )
    const version = Number(
      (db.query('select v from meta where k = ?').get('schema') as { v?: string } | null)?.v ?? 0,
    )
    if (version !== SCHEMA_VERSION) {
      db.exec('delete from doc')
      db.exec('delete from conv')
      db.query('insert or replace into meta (k, v) values (?, ?)').run(
        'schema',
        String(SCHEMA_VERSION),
      )
    }
    return db
  } catch {
    // A corrupt or unwritable index is not an error the user should ever see: it just means the
    // scan answers instead.
    openFailed = true
    db = null
    return null
  }
}

/** Close and forget the handle, so the file can be replaced or deleted underneath us. */
function close() {
  try {
    db?.close()
  } catch {
    /* already gone */
  }
  db = null
}

/**
 * The searchable half of a transcript: what the person said and what the model said back.
 *
 * Tool results are deliberately dropped. They are 88% of the text and the least useful 88%: a
 * `tool_result` is a copy of a file the user already has, and indexing it is what turns a 12 MB
 * index into a 200 MB one.
 */
export function conversationText(jsonl: string): string {
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    if (line.charCodeAt(0) !== 123 /* '{' */) continue
    let ev: {
      type?: string
      message?: { content?: unknown }
    }
    try {
      ev = JSON.parse(line)
    } catch {
      continue // partial trailing write, or a record we do not understand
    }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue
    const content = ev.message?.content
    if (typeof content === 'string') {
      out.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      // `text` only: thinking is filtered out of the transcript view too, and tool_use/tool_result
      // are the bulk this index exists to skip.
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}

/**
 * Can this query be answered from the index at all?
 *
 * The index tokenises on word boundaries, so it finds words and phrases, not arbitrary substrings:
 * scanning for "indowsHi" matches `windowsHide` and the index does not. Rather than guess whether a
 * given query is "word-shaped" and be silently wrong, the rule is blunt and checkable: a regex
 * search never uses the index, and a plain search does. The response says which path ran, and the
 * caller can always demand the exhaustive one.
 */
export function queryUsableByIndex(query: string, regex: boolean | undefined): boolean {
  if (regex) return false
  return query.trim().length > 0
}

/** Turn a user's plain search into an FTS5 MATCH expression, safely.
 *
 *  Everything that is not a word character becomes a separator, and the whole thing is quoted as
 *  ONE phrase — so "rate limit" means the words adjacent in that order, which is what someone
 *  typing it into a search box means. Quoting also makes FTS5 operator syntax (`OR`, `NEAR`, `*`,
 *  `-`) inert rather than a parse error or a surprise. */
export function toMatchExpression(query: string): string | null {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
  if (words.length === 0) return null // nothing but punctuation: the index cannot help
  return `"${words.join(' ')}"`
}

export interface IndexRefreshResult {
  indexed: number
  removed: number
  /** Sessions still needing work when a budget cut the pass short. */
  remaining: number
  ms: number
}

/** Files the index should hold, as the caller already knows them. */
export interface IndexableFile {
  session_id: string
  source: SessionSource
  path: string
  mtime_ms: number
  size_bytes: number
  /** Product identity, forwarded to dedupeKey() so two products sharing `source` + session id
   *  (e.g. Kilo and MiMo Code, both `source: 'opencode'`) never collapse to one indexed row. */
  tool?: string
}

let refreshing = false

/** True while a background refresh is running, so callers do not queue a second one. */
export const isRefreshing = () => refreshing

/**
 * Bring the index in line with the files on disk, incrementally.
 *
 * A session is re-read only when its mtime or size moved, which after the first pass is a handful
 * of files rather than 1,211. `budgetMs` bounds one pass so a first build on a huge store makes
 * progress in slices instead of holding anything for a minute.
 */
interface StaleFileStatements {
  dropRow: Statement
  dropFts: Statement
  insertDoc: Statement
  insertFts: Statement
  nextRowId: () => number
}

/** Index (or reindex) one stale file, split out of refreshSearchIndex so the pass loop reads as
 *  the schedule and this reads as the per-file work. Never throws — an unreadable or
 *  unindexable file just stays stale and is retried on the next pass. */
async function indexOneStaleFile(
  f: IndexableFile,
  known: Map<string, { rowid: number; mtime_ms: number; size_bytes: number }>,
  stmts: StaleFileStatements,
  result: IndexRefreshResult,
): Promise<void> {
  const key = docKey(f)
  let text: string
  try {
    text = conversationText(await Bun.file(f.path).text())
  } catch {
    return // vanished or unreadable mid-pass; it stays stale and is retried next time
  }
  const existing = known.get(key)
  const rowid = existing?.rowid ?? stmts.nextRowId()
  try {
    if (existing) {
      stmts.dropFts.run(rowid)
      stmts.dropRow.run(rowid)
    }
    stmts.insertDoc.run(rowid, key, f.source, f.path, f.mtime_ms, f.size_bytes)
    stmts.insertFts.run(rowid, text)
    result.indexed++
  } catch {
    // One unindexable session must not abort the pass.
  }
}

export async function refreshSearchIndex(
  files: IndexableFile[],
  opts: { budgetMs?: number } = {},
): Promise<IndexRefreshResult> {
  const started = performance.now()
  const deadline = opts.budgetMs ? started + opts.budgetMs : Number.POSITIVE_INFINITY
  const result: IndexRefreshResult = { indexed: 0, removed: 0, remaining: 0, ms: 0 }
  const conn = open()
  if (!conn) return result

  refreshing = true
  try {
    const known = new Map<string, { rowid: number; mtime_ms: number; size_bytes: number }>()
    for (const row of conn
      .query('select rowid, key, mtime_ms, size_bytes from doc')
      .all() as Array<{ rowid: number; key: string; mtime_ms: number; size_bytes: number }>)
      known.set(row.key, row)

    const wanted = new Set<string>()
    const stale: IndexableFile[] = []
    for (const f of files) {
      const key = docKey(f)
      wanted.add(key)
      const have = known.get(key)
      if (!have || have.mtime_ms !== f.mtime_ms || have.size_bytes !== f.size_bytes) stale.push(f)
    }

    // Sessions the index holds that are no longer on disk.
    const dropRow = conn.query('delete from doc where rowid = ?')
    const dropFts = conn.query('delete from conv where rowid = ?')
    for (const [key, row] of known) {
      if (wanted.has(key)) continue
      dropRow.run(row.rowid)
      dropFts.run(row.rowid)
      result.removed++
    }

    const nextRowId = () =>
      Number(
        (conn.query('select coalesce(max(rowid), 0) + 1 as n from doc').get() as { n: number }).n,
      )
    const insertDoc = conn.query(
      'insert into doc (rowid, key, source, path, mtime_ms, size_bytes) values (?, ?, ?, ?, ?, ?)',
    )
    const insertFts = conn.query('insert into conv (rowid, body) values (?, ?)')

    // Newest first: if a budget cuts the pass short, the sessions someone is most likely to search
    // for are the ones already covered.
    stale.sort((a, b) => b.mtime_ms - a.mtime_ms)
    const stmts: StaleFileStatements = { dropRow, dropFts, insertDoc, insertFts, nextRowId }
    for (const [i, f] of stale.entries()) {
      if (performance.now() > deadline) {
        result.remaining = stale.length - i
        break
      }
      await indexOneStaleFile(f, known, stmts, result)
    }

    conn
      .query('insert or replace into meta (k, v) values (?, ?)')
      .run('built_at', String(Date.now()))
  } catch {
    // Any failure leaves whatever was already indexed in place; the scan covers the rest.
  } finally {
    refreshing = false
    result.ms = performance.now() - started
  }
  return result
}

/**
 * Session keys whose CONVERSATION matches, or null when the index cannot answer.
 *
 * Null is the important return: it means "ask the scanner", not "no matches". Every caller has to
 * keep those apart, which is the same distinction the search budget flag exists for.
 */
export function searchIndexCandidates(
  query: string,
  opts: { regex?: boolean; source?: SessionSource } = {},
): Set<string> | null {
  if (!queryUsableByIndex(query, opts.regex)) return null
  const match = toMatchExpression(query)
  if (!match) return null
  const conn = open()
  if (!conn) return null
  try {
    const rows = conn
      .query(
        opts.source
          ? 'select d.key as key from conv c join doc d on d.rowid = c.rowid where conv match ? and d.source = ?'
          : 'select d.key as key from conv c join doc d on d.rowid = c.rowid where conv match ?',
      )
      .all(...(opts.source ? [match, opts.source] : [match])) as Array<{ key: string }>
    return new Set(rows.map((r) => r.key))
  } catch {
    return null // malformed match expression or a damaged index: fall back, never throw
  }
}

/** How many of `files` the index already covers at their current mtime/size. */
export function searchIndexCoverage(files: IndexableFile[]): { covered: number; stale: number } {
  const conn = open()
  if (!conn) return { covered: 0, stale: files.length }
  try {
    const known = new Map<string, { mtime_ms: number; size_bytes: number }>()
    for (const row of conn.query('select key, mtime_ms, size_bytes from doc').all() as Array<{
      key: string
      mtime_ms: number
      size_bytes: number
    }>)
      known.set(row.key, row)
    let covered = 0
    for (const f of files) {
      const have = known.get(docKey(f))
      if (have && have.mtime_ms === f.mtime_ms && have.size_bytes === f.size_bytes) covered++
    }
    return { covered, stale: files.length - covered }
  } catch {
    return { covered: 0, stale: files.length }
  }
}

export function searchIndexStatus(): SearchIndexStatus {
  const exists = existsSync(indexPath)
  let sizeBytes = 0
  if (exists) {
    try {
      sizeBytes = statSync(indexPath).size
    } catch {
      /* raced with a delete */
    }
  }
  const conn = exists ? open() : null
  let sessions = 0
  let builtAt: number | null = null
  if (conn) {
    try {
      sessions = Number(
        (conn.query('select count(*) as n from doc').get() as { n: number } | null)?.n ?? 0,
      )
      const at = (conn.query('select v from meta where k = ?').get('built_at') as { v?: string })?.v
      builtAt = at ? Number(at) : null
    } catch {
      /* unreadable: report it as empty rather than failing the settings page */
    }
  }
  return { exists, sizeBytes, sessions, builtAt, refreshing }
}

/** Delete the index. It rebuilds itself from the transcripts, so this loses nothing but time. */
export function dropSearchIndex(): boolean {
  close()
  try {
    rmSync(indexPath, { force: true })
    openFailed = false
    return true
  } catch {
    return false
  }
}

/** Test seam: point the index at a scratch file and forget any open handle. */
export function setSearchIndexPathForTests(path: string) {
  close()
  openFailed = false
  indexPath = path
}
