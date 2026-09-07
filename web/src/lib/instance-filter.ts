// web/src/lib/instance-filter.ts — "which of these instances am I actually looking for?"
//
// The Instances tab's filter used to ask one question ("is this account's quota spent?", see
// lib/usage-filter.ts). It now asks three, because they are the three ways a row can fail to be
// the row you want:
//
//   * STATUS   — is the app open, or closed? "Open the ones I already have running" and "which of
//                these could I start?" are the two halves of a working morning.
//   * PLAN     — Max 20×, Pro, Free… Accounts on different plans are not interchangeable, so
//                "only my Max accounts" is a real question about a table of ten.
//   * QUOTA    — the original: the weekly cap and the 5-hour session, each with its own line.
//                Owned by lib/usage-filter.ts, which this composes rather than reimplements.
//
// Pure derivation, like its quota half: nothing here touches Vue, the network or a clock, so the
// rule every table acts on is unit-testable on its own. The reactive, persisted knobs live in
// composables/useInstanceFilter.ts.
//
// TWO RULES HOLD THE WHOLE THING TOGETHER, and both are inherited from the quota filter because
// they were right there and are right here:
//
//  1. THE FACETS ARE OR-ED. Each one is its own reason a row is not what you are looking for, so
//     tripping any of them sets the row aside. AND would mean "closed" cancels out "over quota",
//     which is not what a person picking two filters means.
//
//  1b. …EXCEPT that being SIGNED OUT is checked before any of them, because it is not a fourth
//     question about the account - it is whether there is an account to ask about. See
//     isSignedOutSetAside; a signed-out row reads as 0% quota, which every facet waves through.
//
//  2. AN UNKNOWN FACT NEVER SETS A ROW ASIDE. A CLI login has no window to be open or closed; a
//     desktop instance whose account is still resolving has no plan label yet. Filtering those out
//     would remove a perfectly good account from the table on the strength of a fact we do not
//     have — and in the plan case it would do it for the second or two after every refresh, so
//     rows would drop out and pop back while you looked at them. Unknown is UNKNOWN, never "no".

import type { UsageSnapshot } from '@/lib/api'
import { isEmptyRule, matchesUsageFilter, type UsageFilterRule } from '@/lib/usage-filter'

/** Which rows the status facet keeps. `'all'` is the facet switched off. */
export type StatusFilter = 'all' | 'open' | 'closed'

/** Every value `statusFilter` may hold — also the allow-list the shared-prefs mirror validates a
 *  stored value against, so a hand-edited prefs file cannot put the control in a state with no
 *  option selected. */
export const STATUS_FILTERS = ['all', 'open', 'closed'] as const

/**
 * One row, as far as the filter is concerned. Every table builds one of these per row rather than
 * handing over its own record type, so the rule below is written once and cannot learn what a
 * desktop instance is.
 */
export interface InstanceFacts {
  /** The quota reading, if this row has one. */
  usage?: UsageSnapshot | null
  /** `true` = its app is open, `false` = closed, `null`/absent = this KIND of row is never open or
   *  closed (an unlinked CLI login has no window), so the status facet must leave it alone. */
  open?: boolean | null
  /** The plan label this row shows ("Max 20×", "Pro", "Free"…), null while it is still unknown. */
  plan?: string | null
  /** Is anyone signed in on this row? `false` = signed out, `null`/absent = not known.
   *  See isSignedOutSetAside for why this one is not just another facet. */
  signedIn?: boolean | null
}

/** The whole filter in one value, so the tables and the flyout cannot drift on what it means. */
export interface InstanceFilterRule {
  status: StatusFilter
  /** Plan labels to KEEP. Empty = every plan, i.e. the facet switched off. */
  plans: readonly string[]
  /** The quota rule, or `null` when quota is not part of the rule right now — which is what
   *  process mode is: the percentages are not even on screen, so filtering on them would dim rows
   *  against numbers the user cannot see. */
  usage: UsageFilterRule | null
}

/**
 * Does being SIGNED OUT set this row aside?
 *
 * ⛔ NOT A FACET, AND DELIBERATELY NOT ONE. A facet is a question you ask ABOUT an account; this is
 * the prior question of whether there is an account to ask about. Every facet below reads a
 * signed-out row as a perfectly good one: its quota comes back 0% and 0%, which is not headroom but
 * the absence of a reading, and `isOver(0, 80)` is false, so "show me accounts under 80%" listed
 * the instances that cannot run anything at all, at the top, looking freshest. Its plan is null and
 * its status may well be "closed", so the other two facets wave it through too.
 *
 * So it is checked FIRST and against the whole rule: whenever the filter is asking for anything,
 * a row nobody is signed into is not an answer to it.
 *
 * `null`/absent is still UNKNOWN and still never sets a row aside - the rule at the top of this
 * file holds. Only a definite `false` counts. On the desktop side that comes from `loginUuid`,
 * which is null for a signed-out profile AND for a config.json too damaged to read; both are
 * genuinely "no account you can use right now", so both belong here.
 */
export function isSignedOutSetAside(
  signedIn: boolean | null | undefined,
  rule: InstanceFilterRule,
): boolean {
  return signedIn === false && !isEmptyInstanceRule(rule)
}

/** Does the STATUS facet set this row aside? False for a row with no open/closed state at all. */
export function isStatusSetAside(open: boolean | null | undefined, status: StatusFilter): boolean {
  if (status === 'all' || open == null) return false
  return status === 'open' ? !open : open
}

/** Does the PLAN facet set this row aside? False while the plan is unknown, and false when no plan
 *  is selected (an empty selection is "every plan", never "no plans"). */
export function isPlanSetAside(plan: string | null | undefined, plans: readonly string[]): boolean {
  if (plans.length === 0 || plan == null) return false
  return !plans.includes(plan)
}

/** Is the rule asking for anything at all? An empty rule is the filter switched on and told to
 *  look at nothing, which is the filter doing nothing. */
export function isEmptyInstanceRule(rule: InstanceFilterRule): boolean {
  const quotaOff = rule.usage == null || isEmptyRule(rule.usage)
  return rule.status === 'all' && rule.plans.length === 0 && quotaOff
}

/**
 * Does this row trip the rule — i.e. should it be dimmed or hidden?
 *
 * OR across the three facets (see the header). Each facet is checked by its own function above so
 * the "unknown never matches" rule is stated once per fact rather than woven into one condition.
 */
export function matchesInstanceFilter(
  facts: InstanceFacts,
  rule: InstanceFilterRule,
  now: Date = new Date(),
): boolean {
  // First, and against the whole rule rather than one facet: see isSignedOutSetAside.
  if (isSignedOutSetAside(facts.signedIn, rule)) return true
  if (isStatusSetAside(facts.open, rule.status)) return true
  if (isPlanSetAside(facts.plan, rule.plans)) return true
  return rule.usage != null && matchesUsageFilter(facts.usage, rule.usage, now)
}

// --- the plan selection, as a mirrorable string -------------------------------------------------
//
// Every other knob in this filter is a boolean, a number or a short enum, which is exactly what
// composables/useSharedPrefs.ts and server/src/core/ui-prefs.ts are built to carry (a flat string
// map, capped at 256 characters a value). A LIST is the one shape that does not fit, so it travels
// as a newline-joined string — not JSON, because a plan label can carry any punctuation it likes
// and a quoting bug in a preferences file would be silent.
//
// A newline cannot appear in a plan label (they come from resolvePlanLabel: "Max 20×", "Pro",
// "Free", "Team", "Enterprise", or a subscription-type passthrough), so joining on it is lossless.

/** How much of the selection can be persisted, in characters — the mirror's own per-value cap.
 *  Anything beyond it is dropped at ENCODE time, so what is stored is always a prefix of a real
 *  selection rather than a truncated last entry that decodes as a plan nobody has. */
const MAX_PLANS_LENGTH = 256

/** The selection, as one line-delimited string. Drops the tail rather than exceeding the cap. */
export function encodePlans(plans: readonly string[]): string {
  let out = ''
  for (const plan of plans) {
    const next = out ? `${out}\n${plan}` : plan
    if (next.length > MAX_PLANS_LENGTH) break
    out = next
  }
  return out
}

/** Read a stored selection back. Anything that is not a string, and every blank entry, is dropped:
 *  a blank would be a plan label no row can ever carry, i.e. a filter that hides the whole table
 *  with nothing in the UI to explain it. Duplicates are collapsed for the same reason the UI
 *  toggles rather than appends — the selection is a set. */
export function decodePlans(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  const seen = new Set<string>()
  for (const part of raw.split('\n')) {
    const plan = part.trim()
    if (plan) seen.add(plan)
  }
  return [...seen]
}

/**
 * The plan options a filter UI should offer: every label present in the tables right now, PLUS
 * whatever is currently selected.
 *
 * The second half is what stops the filter from becoming un-undoable. Select "Max 20×", then quit
 * that instance or let its account go unresolved, and the label disappears from the tables — so an
 * options list built only from the visible rows would drop the very control that is hiding them,
 * leaving a short table and no way to see why. A selected plan stays on the list until it is
 * unselected, whether or not anything carries it.
 */
export function planOptions(
  present: readonly (string | null | undefined)[],
  selected: readonly string[],
): string[] {
  const options = new Set<string>(selected)
  for (const plan of present) {
    if (plan) options.add(plan)
  }
  return [...options].sort((a, b) => a.localeCompare(b))
}
