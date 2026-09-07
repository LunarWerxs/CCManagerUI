// server/src/core/instance-ref.ts — which account does this string mean?
//
// ⛔ WHY THIS FILE EXISTS AT ALL (2026-09-06). Every tool that acts on "an instance" - move_chat,
// move_chats, list_chats, the queue's instance_ref - funnels through this one rule, and until now
// it had NO unit coverage, because its only entry point awaited listAllInstances() and so could
// not run without this machine's real fleet behind it. The cost of that showed up the day the rule
// was finally probed: an account EMAIL, which move_chat's own description lists as an accepted
// spelling, fell through every branch and returned null. Null is indistinguishable from "that
// instance is gone", so the caller got a confident empty answer instead of an error.
//
// The rule is now a pure function over a list, and these pin the two properties that make a
// written-down identifier safe to act on: every documented spelling resolves, and an AMBIGUOUS one
// resolves to nothing rather than to whichever row happened to be first.
//
// Every name and address below is invented. The fleet this runs against is nobody's business but
// the machine's, and a fixture is the easiest place for a real one to end up in public by accident.
import { expect, test } from 'bun:test'
import { instanceRef } from '../src/core/instance-numbers'
import { pickInstance, type ResolvedInstance } from '../src/core/instance-ref'

const row = (parts: Partial<ResolvedInstance> & Pick<ResolvedInstance, 'num'>): ResolvedInstance =>
  ({
    kind: 'desktop',
    handle: `c:\\users\\someone\\.claude-instances\\i${parts.num}`,
    ref: instanceRef('desktop', `c:\\users\\someone\\.claude-instances\\i${parts.num}`),
    name: `name${parts.num}`,
    email: null,
    plan: null,
    ...parts,
  }) as ResolvedInstance

// Two rows on ONE account is an ordinary setup, not a corner case: a second desktop profile signed
// into the same login. It is why the human-typed spellings need the exactly-one rule.
const FLEET: ResolvedInstance[] = [
  row({ num: 3, name: 'ADA P LOVELACE', email: 'ada@example.com' }),
  row({ num: 11, name: 'Grace', email: 'grace@example.com' }),
  row({ num: 54, name: 'Grace', email: 'grace@example.com' }),
  row({ num: 13, name: 'Katherine', email: 'katherine@example.com' }),
]

test('a number resolves, in every spelling a person writes', () => {
  for (const input of [3, '3', ' #3 ']) expect(pickInstance(FLEET, input)?.num).toBe(3)
})

test('a number for an instance that is gone resolves to nothing, not to a neighbour', () => {
  expect(pickInstance(FLEET, 99)).toBe(null)
})

test('"7claude" is a NAME, never instance 7', () => {
  const named = [...FLEET, row({ num: 40, name: '7claude' })]
  expect(pickInstance(named, '7claude')?.num).toBe(40)
})

test('a ref and a bare dir both resolve, whatever the path is spelled like', () => {
  const target = FLEET[0] as ResolvedInstance
  for (const input of [target.ref, target.handle, target.handle.toUpperCase()])
    expect(pickInstance(FLEET, input)?.num).toBe(3)
})

test('an account EMAIL resolves - the spelling the tools document and a person actually knows', () => {
  expect(pickInstance(FLEET, 'ada@example.com')?.num).toBe(3)
  expect(pickInstance(FLEET, 'ADA@EXAMPLE.COM')?.num).toBe(3)
})

test('an ambiguous name or email resolves to NOTHING rather than to whichever row is first', () => {
  // #11 and #54 are one account on two profiles. Silently picking one would move a chat to an
  // account the caller did not name, and nothing downstream could tell that had happened.
  expect(pickInstance(FLEET, 'Grace')).toBe(null)
  expect(pickInstance(FLEET, 'grace@example.com')).toBe(null)
})

test('a name beats an email, and both lose to a number', () => {
  // One row's NAME is another row's email address: contrived, but the order has to be decided
  // somewhere, and "the more specific spelling wins" is the only defensible one.
  const odd = [
    row({ num: 1, name: 'x@y.com', email: 'a@b.com' }),
    row({ num: 2, email: 'x@y.com' }),
  ]
  expect(pickInstance(odd, 'x@y.com')?.num).toBe(1)
  expect(pickInstance(odd, 2)?.num).toBe(2)
})

test('junk resolves to nothing rather than to the first row', () => {
  for (const input of ['', '   ', null, undefined, {}, 0, -1, 'no-such-account@example.com'])
    expect(pickInstance(FLEET, input)).toBe(null)
})

test('a row with no email is never matched by an empty-ish query', () => {
  const anon = [row({ num: 8, name: 'anon', email: null })]
  expect(pickInstance(anon, '')).toBe(null)
})
