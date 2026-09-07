// web/src/composables/useInstanceFilter.ts — the Instances tab's "show me the rows I'm after".
//
// The reactive, persisted half of lib/instance-filter.ts (which is where the rule itself lives, and
// which composes lib/usage-filter.ts for the quota half). Three facets, OR-ed: whether the app is
// OPEN, which PLAN the account is on, and how much QUOTA is left.
//
// It began as the quota filter alone and grew the other two, which is why the storage keys below
// still spell `usageFilter`: renaming them would reset every existing threshold and switch for no
// gain, and a preference key is a wire format, not a label. The same reasoning already keeps the
// weekly threshold under `.threshold` rather than `.weekThreshold`.
//
// Four deliberate design points:
//
// * ONLY THE QUOTA FACET IS GATED ON USAGE MODE. Quota filtering reshapes a view of percentages, so
//   in process mode — where those columns are not on screen and the numbers behind them are not
//   either — it stands down rather than dimming rows against figures the user cannot see. Status
//   and plan are true in both modes, so they act in both, and the toolbar control is therefore
//   visible in both.
// * DIM is the default and HIDE is opt-in, because dimming is lossless: the row is still there to
//   check. Hiding is the stronger tool for someone running many accounts, so every table says how
//   many rows it dropped rather than silently coming up short.
// * EACH QUOTA WINDOW IS ITS OWN SWITCH AND ITS OWN THRESHOLD (see lib/usage-filter.ts): "80%
//   weekly, and also 50% of the 5-hour" is two lines for two questions.
// * AN UNKNOWN FACT NEVER SETS A ROW ASIDE (see lib/instance-filter.ts) — an unresolved plan or a
//   row with no window to be open is not a "no".
//
// Module-scope singleton + useStorage, matching useUsageMode.ts: the desktop table, the CLI table,
// the Codex table, the toolbar flyout and the compact quick window all read this, and a
// per-component ref would let them disagree.

import { useStorage } from '@vueuse/core'
import { computed } from 'vue'
import {
  decodePlans,
  encodePlans,
  type InstanceFacts,
  type InstanceFilterRule,
  isEmptyInstanceRule,
  matchesInstanceFilter,
  STATUS_FILTERS,
  type StatusFilter,
} from '@/lib/instance-filter'
import {
  clampThreshold,
  DEFAULT_USAGE_THRESHOLD,
  isEmptyRule,
  USAGE_FILTER_KEY as KEY,
  type UsageFilterRule,
} from '@/lib/usage-filter'
import { registerSharedPref } from './useSharedPrefs'
import { useUsageMode } from './useUsageMode'

// The carry-over from the old single-threshold `scope2` shape runs in main.ts, before any of this
// module is evaluated — see migrateLegacyUsageFilterScope in lib/usage-filter.ts for why it cannot
// live here (useStorage writes its default on first read, which would erase the "never set" signal).

/** Off until asked for: a fresh install should show every instance it found. */
const enabled = useStorage(`${KEY}.enabled`, false)
/** false = dim the matching rows (default), true = drop them from the table. */
const hideMatches = useStorage(`${KEY}.hide`, false)

/** Open / closed / either. `'all'` is the facet off, and is the default: a filter that has never
 *  been configured must not decide for you which half of the machine you meant. */
const statusFilter = useStorage<StatusFilter>(`${KEY}.status`, 'all')

/** The selected plan labels, line-delimited (see encodePlans — the shared-prefs mirror carries
 *  strings, not lists). Empty is "every plan", never "no plans". */
const plansRaw = useStorage(`${KEY}.plans`, '')

/** The weekly cap — the Usage column, the one that decides whether an account is worth starting on
 *  at all, so it is the window that is on by default. Key kept as `.threshold` (not renamed to
 *  `.weekThreshold`): it has always meant the weekly line for everyone whose scope was the default,
 *  and a rename would reset their number for no gain. */
const weekEnabled = useStorage(`${KEY}.week`, true)
const weekThreshold = useStorage(`${KEY}.threshold`, DEFAULT_USAGE_THRESHOLD)

/** The 5-hour session window. Opt-in: it comes back the same day, so filtering on it by default had
 *  accounts dropping out of the table and back in over an afternoon. */
const sessionEnabled = useStorage(`${KEY}.session`, false)
const sessionThreshold = useStorage(`${KEY}.sessionThreshold`, DEFAULT_USAGE_THRESHOLD)

// Every switch, threshold and selection above is ALSO mirrored through the daemon, because the
// quick-instances window can be served from a different PORT and browser storage is scoped per
// origin — so without this, "the filter I set in the full manager" would not follow you into the
// compact window when it runs standalone. See composables/useSharedPrefs.ts for the
// server-wins-on-hydrate rule, and for why `allowed` is declared on the one enum here.
registerSharedPref(`${KEY}.enabled`, enabled)
registerSharedPref(`${KEY}.hide`, hideMatches)
registerSharedPref(`${KEY}.status`, statusFilter, STATUS_FILTERS)
registerSharedPref(`${KEY}.plans`, plansRaw)
registerSharedPref(`${KEY}.week`, weekEnabled)
registerSharedPref(`${KEY}.threshold`, weekThreshold)
registerSharedPref(`${KEY}.session`, sessionEnabled)
registerSharedPref(`${KEY}.sessionThreshold`, sessionThreshold)

export function useInstanceFilter() {
  // No clock needed: nothing here counts down, it only compares percentages.
  const { usageMode } = useUsageMode()

  /** The selected plan labels, as a set the UI can read and write directly. */
  const plans = computed<string[]>({
    get: () => decodePlans(plansRaw.value),
    set: (next) => {
      plansRaw.value = encodePlans(next)
    },
  })

  /** The quota windows AS CONFIGURED, whether or not usage mode currently lets them act. The
   *  flyout renders from this so a threshold you set does not appear to reset itself when you flip
   *  back to the process columns. */
  const quotaRule = computed<UsageFilterRule>(() => ({
    week: weekEnabled.value ? weekThreshold.value : null,
    session: sessionEnabled.value ? sessionThreshold.value : null,
  }))

  /** The whole rule as the tables act on it — the quota half dropped in process mode, where those
   *  percentages are not on screen to be filtered against. */
  const rule = computed<InstanceFilterRule>(() => ({
    status: statusFilter.value,
    plans: plans.value,
    usage: usageMode.value ? quotaRule.value : null,
  }))

  /** The filter is doing something to the tables right now. */
  const active = computed(() => enabled.value && !isEmptyInstanceRule(rule.value))

  /** On, but nothing selected in ANY facet — the flyout says so rather than leaving a switched-on
   *  filter that visibly does nothing. Read from the CONFIGURED rule, not the acting one, so
   *  process mode does not report a weekly threshold that is merely standing down as "nothing
   *  selected". */
  const noRule = computed(
    () =>
      enabled.value &&
      statusFilter.value === 'all' &&
      plans.value.length === 0 &&
      isEmptyRule(quotaRule.value),
  )

  /** Does this row match the filter? False whenever the filter isn't active, so callers can use it
   *  as the single condition rather than repeating the `active &&` themselves. */
  function matches(facts: InstanceFacts): boolean {
    if (!active.value) return false
    return matchesInstanceFilter(facts, rule.value)
  }

  /** Row should be greyed out but stay in the table. */
  function dimmed(facts: InstanceFacts): boolean {
    return !hideMatches.value && matches(facts)
  }

  /** Row should be dropped from the table entirely. */
  function hidden(facts: InstanceFacts): boolean {
    return hideMatches.value && matches(facts)
  }

  /** Drop the hidden rows from a list. Sort first, then filter — the filter removes rows, it
   *  never reorders them. Takes a readonly array because that is what useSortable hands back. */
  function visible<T>(rows: readonly T[], factsOf: (row: T) => InstanceFacts): readonly T[] {
    if (!active.value || !hideMatches.value) return rows
    return rows.filter((row) => !matches(factsOf(row)))
  }

  return {
    enabled,
    hideMatches,
    statusFilter,
    plans,
    weekEnabled,
    weekThreshold,
    sessionEnabled,
    sessionThreshold,
    quotaRule,
    rule,
    active,
    noRule,
    /** Whether the quota facet is allowed to act at all right now (see the header). The flyout
     *  uses it to say so instead of offering thresholds that quietly do nothing. */
    quotaApplies: usageMode,
    matches,
    dimmed,
    hidden,
    visible,
    /** Add or remove one plan from the selection. A toggle, not an append: the selection is a set,
     *  and every control that writes it is a two-state button. */
    togglePlan: (plan: string) => {
      const current = plans.value
      plans.value = current.includes(plan) ? current.filter((p) => p !== plan) : [...current, plan]
    },
    /** Back to "every plan". */
    clearPlans: () => {
      plans.value = []
    },
    /** Writes go through the clamp so a typed "800" or "" can't persist an unreachable threshold. */
    setWeekThreshold: (value: unknown) => {
      weekThreshold.value = clampThreshold(value, weekThreshold.value)
    },
    setSessionThreshold: (value: unknown) => {
      sessionThreshold.value = clampThreshold(value, sessionThreshold.value)
    },
  }
}
