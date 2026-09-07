// web/src/lib/usage-filter.ts — "is this instance too far into its quota to be worth using?"
//
// Pure derivation over a UsageSnapshot, in the same spirit as lib/usage.ts and lib/usage-reset.ts:
// nothing here touches Vue, the network or a clock, so the rule the tables act on is unit-testable
// on its own. The reactive, persisted knobs live in composables/useInstanceFilter.ts, which
// composes this with the status and plan facets (see lib/instance-filter.ts).
//
// The question the filter answers is "which accounts can I still work on", and there are two ways
// to be unable to: the WEEKLY cap (the Usage column) decides whether an account is worth starting
// on at all, and the 5-HOUR session decides whether it is usable *right now*. Those are different
// questions with different answers, so each window carries ITS OWN THRESHOLD and its own on/off —
// a rule is the OR of the windows it is measuring. That is what the old single-threshold `scope`
// tri-toggle could not express: "set it aside at 80% weekly, but also at 50% of the 5-hour window"
// needs two numbers, and 'either' only had one.
//
// The weekly window is on by default and the session window is opt-in, for the reason the tri-
// toggle defaulted to 'week': the 5-hour reading comes back the same day, so having it filter by
// default meant accounts dropping out and back in over an afternoon.
//
// The one thing this must never do is treat "no reading" as "over the limit". An instance that has
// never been checked (or came back empty) is UNKNOWN, not exhausted — dimming or hiding it would
// quietly remove a perfectly usable account from the table on the strength of a missing number.
// A reading whose window has since RESET counts as no reading for exactly the same reason: it is
// the strongest form of the trap, because the number it hides the account on is one that provably
// no longer applies (see isWindowSuperseded).

import type { UsageSnapshot } from '@/lib/api'
import { bindingWeeklyPct } from '@/lib/usage'
import { isWindowSuperseded } from '@/lib/usage-reset'

/**
 * Which quota windows the filter is measuring, and where each one's line sits.
 *
 * `null` means "this window is not part of the rule" — deliberately not `0`, which is a real and
 * very aggressive threshold (every known reading is at or above 0%).
 */
export interface UsageFilterRule {
  /** The weekly cap, i.e. the Usage column. */
  week: number | null
  /** The 5-hour session window. */
  session: number | null
}

/** Default threshold, in percent, for either window. 80 is the point where an account stops being
 *  somewhere you'd start new work — high enough not to fire constantly, low enough to leave
 *  headroom. */
export const DEFAULT_USAGE_THRESHOLD = 80

/** The one-click threshold choices offered in the filter flyout. */
export const USAGE_THRESHOLD_PRESETS = [50, 70, 80, 90] as const

/** Both readings this filter can compare against a threshold, `null` where the snapshot has no
 *  usable one (never checked, logged out, parse miss, or a window that has since reset). */
export function usageFilterReadings(
  snap: UsageSnapshot | null | undefined,
  now: Date = new Date(),
): { week: number | null; session: number | null } {
  if (!snap) return { week: null, session: null }
  return {
    week: isWindowSuperseded(snap.weekAll, now) ? null : bindingWeeklyPct(snap),
    session: isWindowSuperseded(snap.session, now) ? null : (snap.session?.pct ?? null),
  }
}

/**
 * Is this reading AT OR ABOVE its threshold?
 *
 * At-or-above, not strictly-above: a threshold of 80 is read as "80% is where I stop", so an
 * account sitting exactly on it belongs with the ones being set aside, not with the fresh ones.
 *
 * Always false for an unknown reading, and for a window the rule isn't measuring.
 */
function isOver(pct: number | null, threshold: number | null): boolean {
  if (pct == null || threshold == null) return false
  return pct >= threshold
}

/**
 * Does this snapshot trip the rule?
 *
 * OR, not AND: each window is its own reason an account is unusable, so tripping either one is
 * enough. Requiring both would mean an account with the whole week spent stays in the table
 * simply because its 5-hour window happens to have just rolled over.
 *
 * A rule measuring NO window matches nothing — which is the filter doing nothing, the honest
 * reading of "I turned off every window I asked it to check".
 */
export function matchesUsageFilter(
  snap: UsageSnapshot | null | undefined,
  rule: UsageFilterRule,
  now: Date = new Date(),
): boolean {
  const readings = usageFilterReadings(snap, now)
  return isOver(readings.week, rule.week) || isOver(readings.session, rule.session)
}

/** Is the rule measuring anything at all? A rule with every window off is the filter switched on
 *  but told to look at nothing, which the flyout says out loud rather than leaving a filter that
 *  visibly does nothing. */
export function isEmptyRule(rule: UsageFilterRule): boolean {
  return rule.week == null && rule.session == null
}

/**
 * Clamp a typed/pasted threshold into 0-100, keeping the previous value when the input is junk.
 *
 * An EMPTY box counts as junk, not as zero. `Number('')` is 0, so the obvious implementation turns
 * "select all, delete, type 85" into a threshold of 0 for the keystroke in between — which with
 * hiding on empties the table under the user's hands. `null`/`undefined` are junk for the same
 * reason: `Number(null)` is also 0, and the callers that can hand one over are reading a setting
 * that may simply not be there yet.
 */
export function clampThreshold(value: unknown, fallback = DEFAULT_USAGE_THRESHOLD): number {
  if (value == null) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, Math.round(n)))
}

// --- carry-over from the single-threshold shape -------------------------------------------------

/** Storage keys the filter persists under. Kept here beside the migration that has to write them
 *  from outside the composable — one spelling of each key, not two. */
export const USAGE_FILTER_KEY = 'agenthydra.instances.usageFilter'
const LEGACY_SCOPE_KEY = `${USAGE_FILTER_KEY}.scope2`

/**
 * The two-window rule that reproduces an old `scope` + single threshold exactly, so upgrading
 * doesn't silently re-point someone's filter at a different window. The old shared threshold
 * becomes BOTH thresholds, which is precisely what 'either' meant.
 */
export function ruleFromLegacyScope(scope: string | null, threshold: number): UsageFilterRule {
  if (scope === 'session') return { week: null, session: threshold }
  if (scope === 'either') return { week: threshold, session: threshold }
  return { week: threshold, session: null }
}

/**
 * Carry a stored `scope2` over to the per-window switches, once.
 *
 * Called from main.ts alongside migrateLegacyStorageKeys, and for the same reason: useStorage WRITES
 * its default the first time it is read, so a migration expressed in terms of those refs could never
 * tell "never set" from "just defaulted". Seeing the legacy key at all is the signal; removing it is
 * what makes this run once. Values go out in vueuse's own wire format (String() for booleans and
 * numbers alike) so composables/useInstanceFilter.ts reads back exactly what it would have written.
 *
 * A value already in the new shape WINS over the legacy key — same rule as the rebrand migration,
 * and for the same downgrade-then-upgrade case.
 */
export function migrateLegacyUsageFilterScope(store: Storage = localStorage): void {
  try {
    const scope = store.getItem(LEGACY_SCOPE_KEY)
    if (scope == null) return
    store.removeItem(LEGACY_SCOPE_KEY)
    if (store.getItem(`${USAGE_FILTER_KEY}.week`) != null) return
    const threshold = clampThreshold(store.getItem(`${USAGE_FILTER_KEY}.threshold`))
    const rule = ruleFromLegacyScope(scope, threshold)
    store.setItem(`${USAGE_FILTER_KEY}.week`, String(rule.week != null))
    store.setItem(`${USAGE_FILTER_KEY}.session`, String(rule.session != null))
    store.setItem(`${USAGE_FILTER_KEY}.sessionThreshold`, String(rule.session ?? threshold))
  } catch {
    /* private mode / disabled storage: the composable's defaults are a fine place to land */
  }
}
