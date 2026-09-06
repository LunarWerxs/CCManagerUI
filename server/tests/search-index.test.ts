// server/tests/search-index.test.ts — the conversation index (server/src/search-index.ts).
//
// The index is an ACCELERATOR, never a source of truth, and every test here is really testing one
// of three promises: it holds conversation and not tool output (that is why it is 12 MB and not
// 200 MB), it stays in step with files that change, and it never answers when it cannot answer
// properly — a cold, damaged or unusable index returns null so the caller scans instead.
//
// Fixtures are hand-written JSONL in a temp dir: no real session data, no secrets.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  conversationText,
  dropSearchIndex,
  type IndexableFile,
  queryUsableByIndex,
  refreshSearchIndex,
  searchIndexCandidates,
  searchIndexCoverage,
  searchIndexPath,
  searchIndexStatus,
  setSearchIndexPathForTests,
  toMatchExpression,
} from '../src/search-index'
import { dedupeKey } from '../src/session-locator'

// The index keys rows by dedupeKey (audit AH-35), not a bare `${source}:${id}`. These fixtures
// never set `tool`, so it defaults to `source` and this resolves to the same identity every test
// below already expected — computed via the real function rather than a hand-typed string, so a
// future change to dedupeKey's shape cannot silently desync the assertions from the code.
const claudeKey = (id: string) => dedupeKey({ source: 'claude', session_id: id, path: '' })

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'agh-search-index-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  dropSearchIndex()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const turn = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({
    type: role,
    timestamp: '2026-08-13T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  })

const toolResult = (text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-08-13T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', content: text }] },
  })

let dir: string
beforeEach(() => {
  dir = scratch()
  setSearchIndexPathForTests(join(dir, 'index.db'))
})

/** Write a transcript and describe it the way the daemon's own file index would. */
function session(id: string, lines: string[]): IndexableFile {
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  const st = statSync(path)
  return { session_id: id, source: 'claude', path, mtime_ms: st.mtimeMs, size_bytes: st.size }
}

describe('conversationText', () => {
  test('keeps what was said', () => {
    const text = conversationText(
      [turn('user', 'where is the postcode validator'), turn('assistant', 'in checkout')].join(
        '\n',
      ),
    )
    expect(text).toContain('postcode validator')
    expect(text).toContain('in checkout')
  })

  // The entire size argument rests on this: tool output is 88% of the text, and skipping it is
  // what keeps the index at 12 MB instead of 200 MB.
  test('drops tool output, which is the whole reason the index is small', () => {
    const text = conversationText(
      [turn('user', 'run the tests'), toolResult('SECRET_TOOL_OUTPUT_MARKER all 214 passed')].join(
        '\n',
      ),
    )
    expect(text).toContain('run the tests')
    expect(text).not.toContain('SECRET_TOOL_OUTPUT_MARKER')
  })

  test('drops thinking blocks and survives malformed lines', () => {
    const text = conversationText(
      [
        '{not json',
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'PRIVATE_REASONING' },
              { type: 'text', text: 'the visible answer' },
            ],
          },
        }),
        JSON.stringify({ type: 'queue-operation', op: 'dequeue' }),
      ].join('\n'),
    )
    expect(text).toBe('the visible answer')
  })
})

describe('query translation', () => {
  test('a regex search never uses the index', () => {
    expect(queryUsableByIndex('^foo.*bar$', true)).toBe(false)
    expect(queryUsableByIndex('foo', false)).toBe(true)
  })

  test('a multi-word query becomes one phrase, so word order and adjacency still mean something', () => {
    expect(toMatchExpression('rate limit')).toBe('"rate limit"')
  })

  test('FTS operator syntax is quoted into inertness rather than parsed', () => {
    // Unquoted, each of these is an FTS5 operator and would either error or silently mean
    // something the user did not type.
    expect(toMatchExpression('foo OR bar')).toBe('"foo or bar"')
    expect(toMatchExpression('NEAR(a b)')).toBe('"near a b"')
    expect(toMatchExpression('-flag*')).toBe('"flag"')
  })

  test('a query of pure punctuation cannot be answered by the index', () => {
    expect(toMatchExpression('  ***  ')).toBeNull()
    expect(searchIndexCandidates('***')).toBeNull()
  })
})

describe('refresh and query', () => {
  test('indexes sessions and finds them by word and by phrase', async () => {
    const files = [
      session('a', [turn('user', 'the postcode validator accepts an empty value')]),
      session('b', [turn('assistant', 'I hit a rate limit and backed off')]),
      session('c', [turn('user', 'completely unrelated conversation')]),
    ]
    const r = await refreshSearchIndex(files)
    expect(r.indexed).toBe(3)

    expect(searchIndexCandidates('postcode')).toEqual(new Set([claudeKey('a')]))
    expect(searchIndexCandidates('rate limit')).toEqual(new Set([claudeKey('b')]))
    // A phrase means adjacency: these words exist but not in this order.
    expect(searchIndexCandidates('limit rate')).toEqual(new Set())
  })

  test('matching is case-insensitive, so the index over-selects and never under-selects', async () => {
    await refreshSearchIndex([session('a', [turn('user', 'WindowsHide must be set')])])
    expect(searchIndexCandidates('windowshide')).toEqual(new Set([claudeKey('a')]))
    expect(searchIndexCandidates('WINDOWSHIDE')).toEqual(new Set([claudeKey('a')]))
  })

  test('text inside a tool result is not findable, which is the documented limit', async () => {
    await refreshSearchIndex([
      session('a', [turn('user', 'run it'), toolResult('the needle is in here')]),
    ])
    expect(searchIndexCandidates('needle')).toEqual(new Set())
  })

  test('a changed transcript is re-indexed, and the old text stops matching', async () => {
    const first = session('a', [turn('user', 'original wording')])
    await refreshSearchIndex([first])
    expect(searchIndexCandidates('original')).toEqual(new Set([claudeKey('a')]))

    // Same session id, new content: what the daemon sees when a session is carried on.
    writeFileSync(first.path, `${turn('user', 'replacement wording')}\n`)
    const st = statSync(first.path)
    const changed: IndexableFile = { ...first, mtime_ms: st.mtimeMs, size_bytes: st.size }
    const r = await refreshSearchIndex([changed])
    expect(r.indexed).toBe(1)
    expect(searchIndexCandidates('replacement')).toEqual(new Set([claudeKey('a')]))
    expect(searchIndexCandidates('original')).toEqual(new Set()) // no stale ghost
  })

  test('an unchanged transcript is not re-read on the next pass', async () => {
    const files = [session('a', [turn('user', 'stable content')])]
    expect((await refreshSearchIndex(files)).indexed).toBe(1)
    expect((await refreshSearchIndex(files)).indexed).toBe(0)
  })

  test('a session that disappears is dropped from the index', async () => {
    const a = session('a', [turn('user', 'first')])
    const b = session('b', [turn('user', 'second')])
    await refreshSearchIndex([a, b])
    expect(searchIndexCandidates('second')).toEqual(new Set([claudeKey('b')]))

    const r = await refreshSearchIndex([a]) // b is gone from the store
    expect(r.removed).toBe(1)
    expect(searchIndexCandidates('second')).toEqual(new Set())
  })

  test('coverage reports what is current, so a stale index can stand aside', async () => {
    const a = session('a', [turn('user', 'hello')])
    const b = session('b', [turn('user', 'world')])
    await refreshSearchIndex([a])
    expect(searchIndexCoverage([a, b])).toEqual({ covered: 1, stale: 1 })
    await refreshSearchIndex([a, b])
    expect(searchIndexCoverage([a, b])).toEqual({ covered: 2, stale: 0 })
  })

  test('an unreadable transcript is skipped rather than failing the pass', async () => {
    const good = session('a', [turn('user', 'readable')])
    const missing: IndexableFile = {
      session_id: 'ghost',
      source: 'claude',
      path: join(dir, 'does-not-exist.jsonl'),
      mtime_ms: 1,
      size_bytes: 1,
    }
    const r = await refreshSearchIndex([good, missing])
    expect(r.indexed).toBe(1)
    expect(searchIndexCandidates('readable')).toEqual(new Set([claudeKey('a')]))
  })

  test('a budget stops a pass part-way and reports the backlog, newest first', async () => {
    const files = Array.from({ length: 40 }, (_, i) =>
      session(`s${i}`, [turn('user', `session number ${i}`)]),
    )
    const r = await refreshSearchIndex(files, { budgetMs: -1 }) // already expired
    expect(r.indexed).toBe(0)
    expect(r.remaining).toBe(40)
  })
})

describe('status and deletion', () => {
  test('status reports the file, and the file is exactly one file', async () => {
    await refreshSearchIndex([session('a', [turn('user', 'hello')])])
    const s = searchIndexStatus()
    expect(s.exists).toBe(true)
    expect(s.sessions).toBe(1)
    expect(s.sizeBytes).toBeGreaterThan(0)
    expect(s.builtAt).toBeGreaterThan(0)
    // A WAL sidecar would make "just delete the file" a corruption bug.
    expect(() => statSync(`${searchIndexPath()}-wal`)).toThrow()
  })

  test('deleting it leaves nothing behind, and it rebuilds from the transcripts', async () => {
    const files = [session('a', [turn('user', 'rebuildable')])]
    await refreshSearchIndex(files)
    expect(dropSearchIndex()).toBe(true)
    expect(searchIndexStatus().exists).toBe(false)
    expect(() => statSync(searchIndexPath())).toThrow()

    await refreshSearchIndex(files)
    expect(searchIndexCandidates('rebuildable')).toEqual(new Set([claudeKey('a')]))
  })

  test('an empty store gives an empty index, not an error', async () => {
    const r = await refreshSearchIndex([])
    expect(r.indexed).toBe(0)
    expect(searchIndexCoverage([])).toEqual({ covered: 0, stale: 0 })
  })
})
