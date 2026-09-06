import { expect, test } from 'bun:test'
import { collapseSubagents } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

function file(
  session_id: string,
  parentId: string | null = null,
  over: Partial<TranscriptFile> = {},
): TranscriptFile {
  return {
    session_id,
    source: 'opencode',
    path: 'C:/store/opencode.db',
    project: 'p1',
    mtime_ms: 1000,
    size_bytes: 10,
    archived: false,
    parentId,
    ...over,
  }
}

const ids = (files: TranscriptFile[]) => files.map((f) => f.session_id)

// The counts map is keyed source:storeKey:id (session-locator.ts's storeKeyOf), not bare
// source:id — audit AH-35 follow-up. `file()`'s default store is 'C:/store/opencode.db'.
const countKey = (id: string, path = 'C:/store/opencode.db', source = 'opencode') =>
  `${source}:${path}:${id}`

test('a subagent whose parent is present is not a row, and counts on its parent', () => {
  const { rows, counts } = collapseSubagents([file('parent'), file('child', 'parent')])
  expect(ids(rows)).toEqual(['parent'])
  expect(counts.get(countKey('parent'))).toBe(1)
})

test('a subagent whose parent is absent stays a row', () => {
  // Nothing may be silently unowned — either it belongs to a session or it IS one. A parent deleted
  // or pruned out of the store must not take its subagents off the screen with it.
  const { rows, counts } = collapseSubagents([file('orphan', 'gone')])
  expect(ids(rows)).toEqual(['orphan'])
  expect(counts.size).toBe(0)
})

test('nesting deeper than one level collapses to its root and counts there', () => {
  const { rows, counts } = collapseSubagents([
    file('root'),
    file('mid', 'root'),
    file('leaf', 'mid'),
  ])
  expect(ids(rows)).toEqual(['root'])
  // Both of them, on the row the user can actually see — crediting the immediate parent would put
  // the leaf's count on a row that is not in the list.
  expect(counts.get(countKey('root'))).toBe(2)
})

test('parentage is matched within a source, never across', () => {
  // A bare id colliding between two stores must not let one store's session hide another's.
  const { rows } = collapseSubagents([
    file('shared', null, { source: 'claude', path: 'a.jsonl' }),
    file('child', 'shared'),
  ])
  expect(ids(rows)).toEqual(['shared', 'child'])
})

test('a chain that never reaches a top-level session keeps every row', () => {
  // Corrupt parentage must not delete conversations from the list. Each of these sees a parent that
  // exists, so a single "does my parent exist" test would drop all of them and the user would watch
  // sessions disappear with nothing anywhere reporting why.
  expect(ids(collapseSubagents([file('loner', 'loner')]).rows)).toEqual(['loner'])
  expect(ids(collapseSubagents([file('a', 'b'), file('b', 'a')]).rows)).toEqual(['a', 'b'])
  expect(ids(collapseSubagents([file('x', 'y'), file('y', 'z'), file('z', 'x')]).rows)).toEqual([
    'x',
    'y',
    'z',
  ])
})

test('a subagent hanging off a cycle is kept, because a cycle owns nothing', () => {
  const { rows, counts } = collapseSubagents([file('a', 'b'), file('b', 'a'), file('leaf', 'a')])
  expect(ids(rows)).toEqual(['a', 'b', 'leaf'])
  expect(counts.size).toBe(0)
})

test('siblings all count on the one parent', () => {
  const { rows, counts } = collapseSubagents([
    file('parent'),
    file('c1', 'parent'),
    file('c2', 'parent'),
    file('c3', 'parent'),
  ])
  expect(ids(rows)).toEqual(['parent'])
  expect(counts.get(countKey('parent'))).toBe(3)
})

test("two stores sharing a tool and a session id do not steal each other's children or counts", () => {
  // Same bug class as sessionMarkKey: tool alone ('hermes' for both) is not enough to tell two
  // physical stores apart. Two Hermes-profile-shaped stores, same session id 'shared' in each,
  // each with its own child — before the storeKey-aware fix this collapsed to ONE 'shared' entry
  // in `byId`, so one store's child silently resolved to the OTHER store's parent, and both rows
  // reported the combined count instead of their own.
  const storeA = 'C:/hermes/profiles/a/state.db'
  const storeB = 'C:/hermes/profiles/b/state.db'
  const { rows, counts } = collapseSubagents([
    file('shared', null, { source: 'hermes', tool: 'hermes', path: storeA }),
    file('childA', 'shared', { source: 'hermes', tool: 'hermes', path: storeA }),
    file('shared', null, { source: 'hermes', tool: 'hermes', path: storeB }),
    file('childB', 'shared', { source: 'hermes', tool: 'hermes', path: storeB }),
  ])
  // Both top-level 'shared' rows survive, one per store; both children collapsed away.
  expect(ids(rows)).toEqual(['shared', 'shared'])
  expect(rows.map((r) => r.path)).toEqual([storeA, storeB])
  // Each store owns exactly its OWN child, not both.
  expect(counts.get(countKey('shared', storeA, 'hermes'))).toBe(1)
  expect(counts.get(countKey('shared', storeB, 'hermes'))).toBe(1)
})

test('an index with no parentage at all is returned untouched', () => {
  const input = [file('a'), file('b')]
  const { rows, counts } = collapseSubagents(input)
  expect(rows).toBe(input)
  expect(counts.size).toBe(0)
})
