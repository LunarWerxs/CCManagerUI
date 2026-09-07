// The dossier's one job is joining the stores by ANY id a chat has ever had. The fixture
// pins the shape that made the 2026-08-28 diagnosis slow: a chat that rolled through prior
// cliSessionIds, where a mark names a PRIOR id and the file is addressed by a third.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatDossier,
  chatMatches,
  collectChats,
  lineageIdsOf,
  listChats,
} from '../src/chat-dossier'

function fixtureRoot(): { dir: string; label: string } {
  const dir = join(tmpdir(), `dossier-fixture-${Math.random().toString(36).slice(2)}`)
  const store = join(dir, 'claude-code-sessions', 'org', 'user')
  mkdirSync(store, { recursive: true })
  writeFileSync(
    join(store, 'local_chat-one.json'),
    JSON.stringify({
      sessionId: 'local_chat-one',
      cliSessionId: 'current-id',
      priorCliSessionIds: ['prior-id-a', 'prior-id-b'],
      title: 'Rolling thread',
      cwd: 'D:\\somewhere',
      createdAt: 1000,
      lastActivityAt: 2000,
      isArchived: true,
      permissionMode: 'bypassPermissions',
    }),
  )
  writeFileSync(
    join(store, 'local_chat-two.json'),
    JSON.stringify({
      sessionId: 'local_chat-two',
      cliSessionId: 'other-id',
      title: 'Unrelated work',
      isArchived: false,
    }),
  )
  return { dir, label: 'fixture' }
}

describe('chat-dossier', () => {
  const root = fixtureRoot()

  test('collectChats reads lineage, archive flag and timestamps off disk', () => {
    const chats = collectChats([root])
    expect(chats.length).toBe(2)
    const one = chats.find((c) => c.title === 'Rolling thread')
    expect(one).toBeDefined()
    expect(one?.archived).toBe(true)
    expect(one?.priorCliSessionIds).toEqual(['prior-id-a', 'prior-id-b'])
    expect(one?.lastActivityAt).toBe(new Date(2000).toISOString())
  })

  test('a chat answers to its title, its current id, any PRIOR id, and its filename id', () => {
    const one = collectChats([root]).find((c) => c.title === 'Rolling thread')
    if (!one) throw new Error('fixture missing')
    expect(lineageIdsOf(one).sort()).toEqual(['chat-one', 'current-id', 'prior-id-a', 'prior-id-b'])
    for (const q of ['rolling', 'current-id', 'prior-id-b', 'chat-one', 'PRIOR-ID-A'])
      expect(chatMatches(one, q)).toBe(true)
    expect(chatMatches(one, 'other-id')).toBe(false)
  })

  test('the joins run on the WHOLE lineage, not just the current id', () => {
    const askedWith: string[][] = []
    const { matches } = chatDossier('prior-id-a', {
      roots: [root],
      markFor: (ids) => {
        askedWith.push(ids)
        return { done: true, updatedAt: 'ts' }
      },
      liveFor: () => null,
    })
    expect(matches.length).toBe(1)
    expect(matches[0]?.doneMark?.done).toBe(true)
    // The mark join was handed every id the chat ever had — the whole point of the module.
    expect(askedWith[0]?.sort()).toEqual(['chat-one', 'current-id', 'prior-id-a', 'prior-id-b'])
  })

  test('a blank-ish query still behaves: no match means an empty list, never a throw', () => {
    const { matches } = chatDossier('zzz-not-a-chat', { roots: [root] })
    expect(matches).toEqual([])
  })

  test('the archive flag is emitted under BOTH names, and they cannot disagree', () => {
    // The store calls it isArchived; this API has always called it archived. Reading the
    // documented name off the raw store returned undefined for all 206 chats on a real
    // account - "not archived" - when 205 were archived, and nothing errored (2026-09-06).
    for (const c of collectChats([root])) expect(c.isArchived).toBe(c.archived)
  })
})

describe('listChats', () => {
  const root = fixtureRoot()
  const opts = { roots: [root], liveIds: new Map<string, number>() }

  test('archived is hidden by default, matching move_chats', () => {
    const got = listChats({}, opts)
    expect(got.rows.map((r) => r.title)).toEqual(['Unrelated work'])
    expect(got.total).toBe(1)
  })

  test('counts describe the WHOLE account, never just the filtered page', () => {
    // ⛔ THE REGRESSION THIS EXISTS TO PREVENT. One unarchived row on a 206-chat account is
    // the normal case, and a caller that sees only that row concludes the account is empty -
    // which is exactly the wrong answer that motivated this tool. The counts must not move
    // when the archive scope does.
    const hidden = listChats({}, opts)
    const included = listChats({ archived: 'include' }, opts)
    const only = listChats({ archived: 'only' }, opts)
    for (const got of [hidden, included, only])
      expect(got.counts).toEqual({ all: 2, unarchived: 1, archived: 1, live: 0 })
    expect(included.rows.length).toBe(2)
    expect(only.rows.map((r) => r.title)).toEqual(['Rolling thread'])
  })

  test('live is read from the registry index and lands on the right chat, by ANY lineage id', () => {
    // 'prior-id-b' is a rolled-away id: a live engine registered under it still belongs to
    // this chat, and a move would still be refused for it.
    const got = listChats(
      { archived: 'include' },
      { roots: [root], liveIds: new Map([['prior-id-b', 4242]]) },
    )
    const rolling = got.rows.find((r) => r.title === 'Rolling thread')
    const other = got.rows.find((r) => r.title === 'Unrelated work')
    expect(rolling?.live).toBe(true)
    expect(rolling?.livePid).toBe(4242)
    expect(other?.live).toBe(false)
    expect(other?.livePid).toBe(null)
    expect(got.counts.live).toBe(1)
  })

  test('an unknown instance label returns nothing but names the labels that do exist', () => {
    const got = listChats({ instances: ['typo'], archived: 'include' }, opts)
    expect(got.rows).toEqual([])
    expect(got.counts.all).toBe(0)
    expect(got.instances).toEqual(['fixture'])
  })

  test('rows are newest-first, an UNDATED chat sorts last, and paging slices that order', () => {
    // 'Unrelated work' carries no lastActivityAt. The dossier's sort compares (x ?? ''), where
    // an empty string beats every real ISO timestamp - fine for a handful of query matches,
    // wrong for a list, where it would head the first page a caller reads with the chat we
    // know least about.
    const all = listChats({ archived: 'include' }, opts)
    expect(all.rows.map((r) => r.title)).toEqual(['Rolling thread', 'Unrelated work'])
    const page2 = listChats({ archived: 'include', limit: 1, offset: 1 }, opts)
    expect(page2.rows.map((r) => r.title)).toEqual(['Unrelated work'])
    // total is the match count, NOT the page size - a capped page must never read as the whole set.
    expect(page2.total).toBe(2)
  })
})
