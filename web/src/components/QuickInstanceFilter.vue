<script setup lang="ts">
// The quick-instances window's filter — the compact sibling of InstanceFilterMenu.vue.
//
// Same STATE and same RULE: both read composables/useInstanceFilter.ts, which is a module singleton
// over lib/instance-filter.ts, so "open accounts on Max, under 80% weekly" means one thing in this
// app and there is exactly one implementation of it. Both also render the same UsageFilterWindow
// control, so the thresholds cannot drift into two behaviours. What differs is only what a compact
// window can afford to show: no auto-refresh rows (this window never starts a sweep — it reads the
// daemon's cache), and no tooltip-wrapped trigger.
//
// EVERY FACET THE SHARED STATE HAS MUST BE REACHABLE HERE. That is not tidiness: this window
// applies the same rule, so a facet it could not show would dim or drop rows with no visible
// control that explains them — the one outcome the whole filter is built to avoid.
//
// English inline and marked i18n-ignore, matching QuickInstancesApp.vue: quick mode deliberately
// does not install vue-i18n, so that it does not download or initialize the full catalog during a
// one-click launch. That is also why UsageFilterWindow takes its captions as props.
//
// The state this reads is mirrored through the daemon (composables/useSharedPrefs.ts), which is the
// point of the whole exercise: this window is often served from a DIFFERENT PORT than the full
// manager, so browser localStorage alone would forget the filter every time it ran standalone.
import { Funnel } from '@lucide/vue'
import { computed } from 'vue'
import UsageFilterWindow from '@/components/UsageFilterWindow.vue'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { planOptions, STATUS_FILTERS, type StatusFilter } from '@/lib/instance-filter'
import { cn } from '@/lib/utils'
import ExpandTransition from '@/shell/ExpandTransition.vue'

const {
  enabled,
  hideMatches,
  statusFilter,
  plans,
  togglePlan,
  clearPlans,
  weekEnabled,
  weekThreshold,
  sessionEnabled,
  sessionThreshold,
  quotaRule,
  quotaApplies,
  noRule,
  setWeekThreshold,
  setSessionThreshold,
} = useInstanceFilter()

const props = withDefaults(
  defineProps<{
    /** How many rows the filter is currently keeping out of the tables, so a short list never looks
     *  like a discovery failure. Supplied by the parent, which owns the row lists. */
    hiddenCount?: number
    /** Plan labels the window can see right now; the menu folds in whatever is selected. */
    presentPlans?: readonly (string | null | undefined)[]
  }>(),
  { hiddenCount: 0, presentPlans: () => [] },
)

const triggerVariant = computed(() => (enabled.value ? 'secondary' : 'outline'))

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'Any',
  open: 'Open',
  closed: 'Closed',
}

const options = computed(() => planOptions(props.presentPlans, plans.value))

/** The rule, compact enough for a toolbar button — one part per active facet. Mirrors the wording
 *  of the full manager's chip: a bare percentage is the weekly cap, the 5-hour line carries a "5h"
 *  tag, and plans collapse to a count past the first. */
const triggerLabel = computed(() => {
  const parts: string[] = []
  if (statusFilter.value !== 'all') parts.push(STATUS_LABEL[statusFilter.value])
  const picked = plans.value
  if (picked.length === 1) parts.push(picked[0])
  else if (picked.length > 1) parts.push(`${picked.length} plans`)
  if (quotaApplies.value) {
    const { week, session } = quotaRule.value
    if (week != null && session != null) parts.push(`${week}% · ${session}% 5h`)
    else if (session != null) parts.push(`${session}% 5h`)
    else if (week != null) parts.push(`${week}%`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'off'
})

const CAPTION = 'text-[11px] font-semibold uppercase tracking-wider text-primary'
const CARD = 'rounded-md border border-border bg-background/60'
const presetLabel = (pct: number) => `${pct}%`
</script>

<template>
  <!-- i18n-ignore -->
  <Popover>
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(buttonVariants({ variant: triggerVariant, size: enabled ? 'sm' : 'icon-sm' }))"
        aria-label="Filter instances"
        title="Narrow the list to the accounts you're after"
      >
        <Funnel />
        <span v-if="enabled" class="tabular-nums">{{ triggerLabel }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 p-0">
      <div class="space-y-3 px-3 py-3">
        <header class="space-y-1.5">
          <h2 class="text-sm font-semibold text-foreground">Filter</h2>
          <div class="flex items-center gap-3">
            <span class="min-w-0 flex-1 text-[13px] text-foreground">Filter instances</span>
            <Switch v-model="enabled" />
          </div>
          <p class="text-[11px] leading-snug text-muted-foreground">
            By whether the app is open, which plan it is on, and how much quota is left. A fact that
            is not known yet — an unresolved plan, a login with no window — never sets a row aside.
          </p>
        </header>

        <!-- Everything below is dead weight while the filter is off — collapse it rather than
             leaving choices you can make and controls that do nothing. -->
        <ExpandTransition :open="enabled">
          <div class="space-y-3">
            <section class="space-y-1.5">
              <h3 :class="CAPTION">Status</h3>
              <div :class="cn(CARD, 'grid grid-cols-3 gap-1 px-2.5 py-2')">
                <Button
                  v-for="value in STATUS_FILTERS"
                  :key="value"
                  :variant="statusFilter === value ? 'default' : 'outline'"
                  size="xs"
                  :aria-pressed="statusFilter === value"
                  @click="statusFilter = value"
                >
                  {{ STATUS_LABEL[value] }}
                </Button>
              </div>
            </section>

            <section class="space-y-1.5">
              <h3 :class="CAPTION">Plan</h3>
              <div :class="cn(CARD, 'px-2.5 py-2')">
                <div v-if="options.length > 0" class="flex flex-wrap gap-1">
                  <Button
                    :variant="plans.length === 0 ? 'default' : 'outline'"
                    size="xs"
                    :aria-pressed="plans.length === 0"
                    @click="clearPlans()"
                  >
                    Any plan
                  </Button>
                  <Button
                    v-for="plan in options"
                    :key="plan"
                    :variant="plans.includes(plan) ? 'default' : 'outline'"
                    size="xs"
                    :aria-pressed="plans.includes(plan)"
                    @click="togglePlan(plan)"
                  >
                    {{ plan }}
                  </Button>
                </div>
                <p v-else class="text-[11px] leading-snug text-muted-foreground">
                  No plans read yet. They appear here as accounts resolve.
                </p>
              </div>
            </section>

            <section class="space-y-1.5">
              <h3 :class="CAPTION">Quota windows</h3>
              <UsageFilterWindow
                v-model="weekEnabled"
                label="Weekly usage"
                hint="The all-models weekly cap — the number that decides whether an account is worth starting on at all."
                threshold-label="Weekly threshold, percent"
                threshold-caption="Set aside at"
                :preset-label="presetLabel"
                :threshold="weekThreshold"
                @update:threshold="setWeekThreshold"
              />
              <UsageFilterWindow
                v-model="sessionEnabled"
                label="5-hour session"
                hint="The rolling session window — whether an account is usable right now, rather than at all this week."
                threshold-label="Session threshold, percent"
                threshold-caption="Set aside at"
                :preset-label="presetLabel"
                :threshold="sessionThreshold"
                @update:threshold="setSessionThreshold"
              />
              <!-- Quota needs the percentages on screen to filter against, so it stands down with
                   them. Said in place, because a threshold that silently stopped applying is
                   exactly what reads as a bug. -->
              <ExpandTransition :open="!quotaApplies">
                <p
                  class="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
                >
                  Quota filtering waits for the usage badges — turn them on with the stopwatch
                  button.
                </p>
              </ExpandTransition>
              <ExpandTransition :open="quotaApplies && !weekEnabled && !sessionEnabled">
                <p class="px-0.5 text-[11px] leading-snug text-muted-foreground">
                  Both quota windows are off, so quota is not part of the filter.
                </p>
              </ExpandTransition>
            </section>

            <!-- On with nothing chosen anywhere is a reachable state rather than a disabled switch,
                 so it has to say so — otherwise the only symptom is a list that never reacted. -->
            <ExpandTransition :open="noRule">
              <p
                class="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
              >
                The filter is on but nothing is selected. Pick a status, a plan, or a quota window.
              </p>
            </ExpandTransition>

            <section class="space-y-1.5">
              <h3 :class="CAPTION">Display</h3>
              <div :class="cn(CARD, 'flex items-center gap-3 px-2.5 py-1.5')">
                <span class="min-w-0 flex-1 text-[13px] text-foreground">Hide instead of dim</span>
                <Switch v-model="hideMatches" />
              </div>
              <p v-if="hideMatches && props.hiddenCount" class="text-[11px] text-muted-foreground">
                {{ props.hiddenCount }} hidden by this filter.
              </p>
            </section>
          </div>
        </ExpandTransition>
      </div>
    </PopoverContent>
  </Popover>
</template>
