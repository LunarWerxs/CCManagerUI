// server/tests/fleet-instances.test.ts - Piece 4 pinned: identity joining (list + no-network
// account resolve), signed-in detection, unknown-identity honesty, resolve-failure tolerance,
// and deterministic #num ordering. (Re-login staleness is pinned where it lives:
// accounts-stale-login.test.ts.)
import { expect, test } from 'bun:test'
import type { CMAccount, CMInstance } from '../src/core/shared'
import { fleetInstances } from '../src/fleet-instances'

function inst(over: Partial<CMInstance> & { num: number; dir: string }): CMInstance {
  return {
    name: over.dir.split(/[\\/]/).pop() ?? over.dir,
    isRunning: false,
    pid: null,
    startTime: null,
    sizeBytes: null,
    memoryBytes: null,
    account: null,
    loginUuid: null,
    isExternal: false,
    isDefault: false,
    label: null,
    icon: null,
    color: null,
    ...over,
  }
}

function acct(over: Partial<CMAccount>): CMAccount {
  return {
    status: 'cache',
    email: null,
    name: null,
    plan: null,
    rateLimitTier: null,
    orgType: null,
    planLabel: null,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'cache',
    label: '(test)',
    ...over,
  }
}

test('identity joins: email/plan attach, signedIn reflects loginUuid, ref is built', async () => {
  const rows = await fleetInstances({
    list: async () => [
      inst({ num: 7, dir: 'C:\\i\\work', loginUuid: 'uuid-1', isRunning: true, pid: 42 }),
    ],
    account: async () => acct({ email: 'a@b.c', planLabel: 'Max 20x', accountUuid: 'uuid-1' }),
  })
  const r = rows[0]
  expect(r?.num).toBe(7)
  expect(r?.ref).toBe('desktop:C:\\i\\work')
  expect(r?.signedIn).toBe(true)
  expect(r?.isRunning).toBe(true)
  expect(r?.pid).toBe(42)
  expect(r?.account?.email).toBe('a@b.c')
  expect(r?.account?.planLabel).toBe('Max 20x')
})

test('unknown identity is null, and a throwing resolver does not sink the list', async () => {
  const rows = await fleetInstances({
    list: async () => [
      inst({ num: 1, dir: 'C:\\i\\unknown' }),
      inst({ num: 2, dir: 'C:\\i\\boom' }),
    ],
    account: async (dir) => {
      if (dir.includes('boom')) throw new Error('resolver exploded')
      return acct({ email: null, accountUuid: null, status: 'unknown' })
    },
  })
  expect(rows.length).toBe(2)
  expect(rows[0]?.account).toBe(null)
  expect(rows[1]?.account).toBe(null)
  expect(rows[0]?.signedIn).toBe(false)
})

test('ordering is by permanent #num, repeatably', async () => {
  const list = async () => [
    inst({ num: 9, dir: 'C:\\i\\c' }),
    inst({ num: 2, dir: 'C:\\i\\a' }),
    inst({ num: 5, dir: 'C:\\i\\b' }),
  ]
  const account = async () => acct({})
  const order = (await fleetInstances({ list, account })).map((r) => r.num)
  expect(order).toEqual([2, 5, 9])
  expect((await fleetInstances({ list, account })).map((r) => r.num)).toEqual(order)
})

test('a pre-attached account on the instance row is used without a second resolve', async () => {
  let resolves = 0
  const rows = await fleetInstances({
    list: async () => [
      inst({
        num: 3,
        dir: 'C:\\i\\pre',
        loginUuid: 'u',
        account: acct({ email: 'pre@b.c', accountUuid: 'u' }),
      }),
    ],
    account: async () => {
      resolves++
      return acct({})
    },
  })
  expect(rows[0]?.account?.email).toBe('pre@b.c')
  expect(resolves).toBe(0)
})
