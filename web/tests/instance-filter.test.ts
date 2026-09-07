// web/src/lib/instance-filter.ts — the rule behind "show me the rows I'm after".
//
// The quota half has its own suite (usage-filter.test.ts). What is pinned here is everything the
// other two facets added, and every one of them is a careless rewrite away from breaking:
//
//  * the three facets are OR-ed, so picking two narrows the table rather than cancelling out;
//  * an UNKNOWN fact never sets a row aside — the rule that keeps a CLI login (no window) in the
//    table when you filter by status, and keeps an instance whose account is still resolving from
//    blinking out of it and back;
//  * an EMPTY plan selection means every plan, never no plans;
//  * the plan selection survives a round trip through the shared-prefs mirror, which carries
//    strings and not lists;
//  * the options list keeps offering a plan that is SELECTED but no longer present, or the filter
//    becomes one you cannot undo from the flyout that set it.
import { expect, test } from 'bun:test'
import type { UsageSnapshot } from '../src/lib/api'
import {
  decodePlans,
  encodePlans,
  type InstanceFilterRule,
  isEmptyInstanceRule,
  matchesInstanceFilter,
  planOptions,
} from '../src/lib/instance-filter'
import { DEFAULT_USAGE_THRESHOLD } from '../src/lib/usage-filter'

const limit = (pct: number) => ({ pct, resets: 'Aug 6, 4:59am' })
const snap = (parts: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  account: null,
  session: null,
  weekAll: null,
  weekModel: null,
  capturedAt: '2026-08-05T12:00:00.000Z',
  ...parts,
})

/** Nothing selected in any facet: the filter switched on and told to look at nothing. */
const NOTHING: InstanceFilterRule = { status: 'all', plans: [], usage: null }
const rule = (parts: Partial<InstanceFilterRule> = {}): InstanceFilterRule => ({
  ...NOTHING,
  ...parts,
})

test('a rule with nothing selected matches nothing, and says so', () => {
  expect(isEmptyInstanceRule(NOTHING)).toBe(true)
  expect(matchesInstanceFilter({ open: false, plan: 'Pro', usage: snap() }, NOTHING)).toBe(false)
  // A quota rule whose windows are both off is just as empty — it is present, it measures nothing.
  expect(isEmptyInstanceRule(rule({ usage: { week: null, session: null } }))).toBe(true)
  expect(isEmptyInstanceRule(rule({ status: 'open' }))).toBe(false)
  expect(isEmptyInstanceRule(rule({ plans: ['Pro'] }))).toBe(false)
})

test('status keeps the half you asked for', () => {
  const open = { open: true }
  const closed = { open: false }
  expect(matchesInstanceFilter(open, rule({ status: 'open' }))).toBe(false)
  expect(matchesInstanceFilter(closed, rule({ status: 'open' }))).toBe(true)
  expect(matchesInstanceFilter(open, rule({ status: 'closed' }))).toBe(true)
  expect(matchesInstanceFilter(closed, rule({ status: 'closed' }))).toBe(false)
})

test('a row with NO open/closed state is never set aside by status', () => {
  // An unlinked CLI login is a config dir, not an app: it is neither open nor shut. Treating that
  // as "closed" would empty the CLI table the moment anyone asked for the open accounts.
  for (const status of ['open', 'closed'] as const) {
    expect(matchesInstanceFilter({}, rule({ status }))).toBe(false)
    expect(matchesInstanceFilter({ open: null }, rule({ status }))).toBe(false)
  }
})

test('an empty plan selection is EVERY plan, not none', () => {
  expect(matchesInstanceFilter({ plan: 'Pro' }, rule({ plans: [] }))).toBe(false)
  expect(matchesInstanceFilter({ plan: null }, rule({ plans: [] }))).toBe(false)
})

test('plan keeps only what is picked, and never judges an unresolved one', () => {
  const picked = rule({ plans: ['Max 20×', 'Pro'] })
  expect(matchesInstanceFilter({ plan: 'Max 20×' }, picked)).toBe(false)
  expect(matchesInstanceFilter({ plan: 'Pro' }, picked)).toBe(false)
  expect(matchesInstanceFilter({ plan: 'Free' }, picked)).toBe(true)
  // Still resolving: an account's plan arrives a beat after the row does, and hiding it in between
  // makes rows blink out of the table and back on every refresh.
  expect(matchesInstanceFilter({ plan: null }, picked)).toBe(false)
  expect(matchesInstanceFilter({}, picked)).toBe(false)
})

test('the facets are OR-ed: any one of them is enough to set a row aside', () => {
  const both = rule({ status: 'open', plans: ['Pro'] })
  expect(matchesInstanceFilter({ open: true, plan: 'Pro' }, both)).toBe(false)
  // Right plan, wrong state — and vice versa. AND would keep both of these.
  expect(matchesInstanceFilter({ open: false, plan: 'Pro' }, both)).toBe(true)
  expect(matchesInstanceFilter({ open: true, plan: 'Free' }, both)).toBe(true)
})

test('quota still applies, and only when the rule carries it', () => {
  const spent = { open: true, plan: 'Pro', usage: snap({ weekAll: limit(91) }) }
  const withQuota = rule({ usage: { week: DEFAULT_USAGE_THRESHOLD, session: null } })
  expect(matchesInstanceFilter(spent, withQuota)).toBe(true)
  // `usage: null` is process mode — the percentages are not on screen, so nothing is filtered on
  // them, however spent the account is.
  expect(matchesInstanceFilter(spent, rule())).toBe(false)
})

test('a plan selection round-trips through the shared-prefs mirror', () => {
  const plans = ['Max 20×', 'Pro', 'Free']
  expect(decodePlans(encodePlans(plans))).toEqual(plans)
  // The mirror hands back whatever is in a file on disk, which may be nothing at all.
  expect(decodePlans('')).toEqual([])
  expect(decodePlans(undefined)).toEqual([])
  expect(decodePlans(null)).toEqual([])
  expect(decodePlans(42)).toEqual([])
  // A blank entry would be a plan label no row can carry — i.e. a filter that empties every table
  // with nothing in the UI to explain it. Duplicates collapse because the selection is a set.
  expect(decodePlans('Pro\n\n  \nPro\nFree')).toEqual(['Pro', 'Free'])
})

test('encoding drops the TAIL rather than exceeding the mirror value cap', () => {
  // A truncated last entry would decode as a plan nobody has, which reads as "hide everything".
  const long = Array.from({ length: 40 }, (_, i) => `Plan number ${i}`)
  const encoded = encodePlans(long)
  expect(encoded.length).toBeLessThanOrEqual(256)
  expect(decodePlans(encoded)).toEqual(long.slice(0, decodePlans(encoded).length))
  expect(decodePlans(encoded).every((plan) => long.includes(plan))).toBe(true)
})

test('a SELECTED plan stays on the options list after it leaves the tables', () => {
  // Quit the only Max instance and the label vanishes from every row — but it is still what is
  // hiding them, so the flyout has to keep offering it or the filter cannot be undone there.
  expect(planOptions([null, 'Pro', 'Pro', undefined], ['Max 20×'])).toEqual(['Max 20×', 'Pro'])
  // Blanks never become options, and the list is sorted so it does not reshuffle as rows resolve.
  expect(planOptions(['Pro', 'Free', null], [])).toEqual(['Free', 'Pro'])
})

// --- signed out ---------------------------------------------------------------------------------
//
// The bug, reported by the owner 2026-09-06: "when the filters are on, for, like, say, quota
// usage, logged out accounts are still showing because they all show zero and zero." A signed-out
// instance reports 0% and 0%, every facet reads that as a fresh account with the whole week ahead
// of it, and so the two rows that can run nothing at all sat at the top of a filtered table.

test('a SIGNED OUT row is set aside by a quota filter, though it reads 0% and 0%', () => {
  const zeroes = snap({ session: limit(0), weekAll: limit(0) })
  const overEighty = rule({ usage: { week: DEFAULT_USAGE_THRESHOLD, session: null } })
  // The reading itself does not trip the rule - that is exactly why this was invisible.
  expect(matchesInstanceFilter({ usage: zeroes, signedIn: true }, overEighty)).toBe(false)
  expect(matchesInstanceFilter({ usage: zeroes, signedIn: false }, overEighty)).toBe(true)
})

test('being signed out sets a row aside under ANY active facet, not just quota', () => {
  for (const active of [
    rule({ status: 'open' }),
    rule({ plans: ['Max 20×'] }),
    rule({ usage: { week: DEFAULT_USAGE_THRESHOLD, session: null } }),
  ])
    expect(matchesInstanceFilter({ signedIn: false, open: true, plan: 'Max 20×' }, active)).toBe(
      true,
    )
})

test('with the filter asking for NOTHING, a signed-out row stays: off is off', () => {
  expect(matchesInstanceFilter({ signedIn: false }, NOTHING)).toBe(false)
})

test('signed-in state UNKNOWN still never sets a row aside', () => {
  // The rule at the top of instance-filter.ts, unchanged: only a definite false counts. A row
  // whose login state has not been read yet must not blink out of the table and back.
  const overEighty = rule({ usage: { week: DEFAULT_USAGE_THRESHOLD, session: null } })
  const fresh = snap({ weekAll: limit(10) })
  expect(matchesInstanceFilter({ usage: fresh, signedIn: null }, overEighty)).toBe(false)
  expect(matchesInstanceFilter({ usage: fresh }, overEighty)).toBe(false)
})

test('a signed-IN account with headroom is still kept - the fix hides one thing, not the table', () => {
  const fresh = snap({ session: limit(3), weekAll: limit(12) })
  const overEighty = rule({ usage: { week: DEFAULT_USAGE_THRESHOLD, session: 50 } })
  expect(matchesInstanceFilter({ usage: fresh, signedIn: true }, overEighty)).toBe(false)
})
