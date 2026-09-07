<script setup lang="ts">
// The Instances toolbar's filter flyout: "narrow these tables to the accounts I'm after", plus the
// auto-refresh knob that keeps the quota numbers it filters on current.
//
// Three facets, OR-ed (composables/useInstanceFilter.ts): whether the app is OPEN, which PLAN the
// account is on, and how much QUOTA is left. It began as the quota filter alone, which is why the
// component it renders per window is still called UsageFilterWindow and why the storage keys still
// spell `usageFilter` — a preference key is a wire format, not a label.
//
// Why it lives here rather than in Settings: a filter is only meaningful while you are looking at
// the rows it applies to. Buried in a settings panel it is a control you have to already know
// exists; sitting in the table's own toolbar it is discovered by anyone with more accounts than
// fits on a screen. The auto-refresh rows are the same rows Settings renders (UsageRefreshRows),
// not a copy — flipping either surface moves the other.
//
// Shown in BOTH column modes, unlike the usage filter it grew out of: status and plan are true
// whichever columns are on screen, so the control has to be reachable whichever they are. Only the
// QUOTA section stands down in process mode, and it says so in place rather than vanishing — a
// threshold that silently stopped applying is the thing that reads as a bug.
//
// Laid out as LABELLED SECTIONS over card-shaped groups rather than one run of hairline-divided
// rows. With three facets, two of them carrying a switch and a threshold, an undifferentiated list
// left the eye no way to tell which control belonged to which question; a card that visibly
// contains its own controls answers that before it has to be read.
import { Funnel } from '@lucide/vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UsageFilterWindow from '@/components/UsageFilterWindow.vue'
import UsageRefreshRows from '@/components/UsageRefreshRows.vue'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { planOptions, STATUS_FILTERS, type StatusFilter } from '@/lib/instance-filter'
import { cn } from '@/lib/utils'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

/**
 * The plan labels the tab can currently SEE, in any order and with the blanks left in — the menu
 * sorts them and folds in whatever is already selected (see planOptions, which is where the
 * "a selected plan stays listed even when nothing carries it" rule lives).
 */
const props = withDefaults(
  defineProps<{ presentPlans?: readonly (string | null | undefined)[] }>(),
  {
    presentPlans: () => [],
  },
)

const { t } = useI18n()
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

// The trigger carries the rule when the filter is on, so the toolbar says what the tables are doing
// without needing the flyout opened. `secondary` matches the pressed usage-mode toggle beside it,
// which is the established "this mode is on" signal in this toolbar.
const triggerVariant = computed(() => (enabled.value ? 'secondary' : 'outline'))

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'instances.filterStatusAny',
  open: 'instances.filterStatusOpen',
  closed: 'instances.filterStatusClosed',
}

/** Every plan the flyout offers: what is on screen now, plus what is selected. */
const options = computed(() => planOptions(props.presentPlans, plans.value))

/**
 * The rule, compact enough for a toolbar button: one part per ACTIVE facet, joined by a middot.
 *
 * The quota part keeps the shape it has always had — a bare percentage is the weekly cap, and the
 * 5-hour line carries a "5h" tag — so the common single-window case reads exactly as it did before
 * there were three facets. Plans collapse to a count past the first, because a toolbar button
 * cannot carry "Max 20× · Max 5× · Pro" and a button that wraps to two lines is worse than a
 * button that says "3 plans".
 */
const triggerLabel = computed(() => {
  const parts: string[] = []
  if (statusFilter.value !== 'all') parts.push(t(STATUS_LABEL[statusFilter.value]))
  const picked = plans.value
  if (picked.length === 1) parts.push(picked[0])
  else if (picked.length > 1) parts.push(t('instances.filterChipPlans', { count: picked.length }))
  // Quota is reported only while it is allowed to act, so the button never claims a threshold that
  // process mode has stood down.
  if (quotaApplies.value) {
    const { week, session } = quotaRule.value
    if (week != null && session != null) {
      parts.push(t('instances.filterChipBoth', { week, session }))
    } else if (session != null) {
      parts.push(t('instances.filterChipSession', { pct: session }))
    } else if (week != null) {
      parts.push(t('instances.filterChipWeek', { pct: week }))
    }
  }
  return parts.length > 0 ? parts.join(' · ') : t('instances.filterChipNone')
})

/** Section caption: uppercase, tracked, accent-coloured. Shared so they cannot drift. */
const CAPTION = 'text-[11px] font-semibold uppercase tracking-wider text-primary'
/** The frame every non-window card uses, so a switch row and a button row sit in the same box. */
const CARD = 'rounded-md border border-border bg-background/60'

/** UsageFilterWindow takes every string as a prop so the un-i18n'd quick window can render it too
 *  (see the note at the top of that component). This is the translated half of that contract. */
const presetLabel = (pct: number) => t('instances.filterThresholdValue', { pct })
</script>

<template>
  <!-- The Popover ROOT must sit INSIDE IconTooltip's slot, wrapped in a plain element: reka anchors
       a popper to the nearest PopperRoot in the component tree, so a tooltip wrapped AROUND the
       root steals the anchor and the content never positions. See
       scripts/checks/reka-popper-root-inside-tooltip.mjs for the full write-up. -->
  <IconTooltip :label="$t('instances.filterTitle')" :description="$t('instances.filterHint')">
    <span class="inline-flex">
      <Popover>
        <PopoverTrigger as-child>
          <button
            type="button"
            :class="cn(buttonVariants({ variant: triggerVariant, size: enabled ? 'default' : 'icon' }))"
            :aria-label="$t('instances.filterTitle')"
          >
            <Funnel />
            <span v-if="enabled" class="tabular-nums">{{ triggerLabel }}</span>
          </button>
        </PopoverTrigger>
        <!-- Wider than the default popover: two threshold cards, each with a four-up preset row,
             and the shared auto-refresh rows below them, whose label wraps under a narrow control
             column. 24rem is the width at which none of them has to fold. -->
        <PopoverContent align="end" class="w-96 p-0">
          <!-- No max height and no scroller: the flyout GROWS as sections open. A scrollbar here
               was worse than the height it saved — expanding a window moved the controls under the
               cursor, and the section you had just opened could land below the fold. -->
          <div class="space-y-3 px-3 py-3">
            <header class="space-y-1.5">
              <h2 class="text-sm font-semibold text-foreground">
                {{ $t('instances.filterTitle') }}
              </h2>
              <!-- The master switch sits at top level rather than inside a card: the cards below are
                   the things it turns on, and nesting it among them would make it look like one more
                   of them. -->
              <div class="flex items-center gap-3">
                <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
                  {{ $t('instances.filterEnable') }}
                  <InfoHint :text="$t('instances.filterHint')" />
                </span>
                <Switch v-model="enabled" />
              </div>
            </header>

            <!-- Everything below is dead weight while the filter is off — collapse it rather than
                 leaving choices you can make and controls that do nothing. -->
            <ExpandTransition :open="enabled">
              <div class="space-y-3">
                <!-- STATUS. A three-up segmented row rather than a switch, because the question has
                     three answers and "not filtering" is one of them: a two-state control would
                     have to encode "either" as off, which is the ambiguity that made the old quota
                     scope toggle unreadable. -->
                <section class="space-y-1.5">
                  <h3 :class="CAPTION">{{ $t('instances.filterStatusSection') }}</h3>
                  <div :class="cn(CARD, 'space-y-1.5 px-2.5 py-2')">
                    <div class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      {{ $t('instances.filterStatusHint') }}
                    </div>
                    <div class="grid grid-cols-3 gap-1">
                      <Button
                        v-for="value in STATUS_FILTERS"
                        :key="value"
                        :variant="statusFilter === value ? 'default' : 'outline'"
                        size="xs"
                        :aria-pressed="statusFilter === value"
                        @click="statusFilter = value"
                      >
                        {{ $t(STATUS_LABEL[value]) }}
                      </Button>
                    </div>
                  </div>
                </section>

                <!-- PLAN. Multi-select toggles, and "Any plan" is its own button rather than an
                     implied empty state: clearing a selection one chip at a time is how a filter
                     you cannot get back out of feels, even when you technically can. -->
                <section class="space-y-1.5">
                  <h3 :class="CAPTION">{{ $t('instances.filterPlanSection') }}</h3>
                  <div :class="cn(CARD, 'space-y-1.5 px-2.5 py-2')">
                    <span class="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                      {{ $t('instances.filterPlanHint') }}
                    </span>
                    <div v-if="options.length > 0" class="flex flex-wrap gap-1">
                      <Button
                        :variant="plans.length === 0 ? 'default' : 'outline'"
                        size="xs"
                        :aria-pressed="plans.length === 0"
                        @click="clearPlans()"
                      >
                        {{ $t('instances.filterPlanAll') }}
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
                      {{ $t('instances.filterPlanEmpty') }}
                    </p>
                  </div>
                </section>

                <section class="space-y-1.5">
                  <h3 :class="CAPTION">{{ $t('instances.filterWindows') }}</h3>
                  <!-- One card per quota window. Two windows and two thresholds, because "80% of
                       the week" and "50% of this 5-hour session" are different questions — see
                       lib/usage-filter.ts. -->
                  <UsageFilterWindow
                    v-model="weekEnabled"
                    :label="$t('instances.filterWeek')"
                    :hint="$t('instances.filterWeekHint')"
                    :threshold-label="$t('instances.filterWeekThresholdLabel')"
                    :threshold-caption="$t('instances.filterThreshold')"
                    :preset-label="presetLabel"
                    :threshold="weekThreshold"
                    @update:threshold="setWeekThreshold"
                  />
                  <UsageFilterWindow
                    v-model="sessionEnabled"
                    :label="$t('instances.filterSession')"
                    :hint="$t('instances.filterSessionHint')"
                    :threshold-label="$t('instances.filterSessionThresholdLabel')"
                    :threshold-caption="$t('instances.filterThreshold')"
                    :preset-label="presetLabel"
                    :threshold="sessionThreshold"
                    @update:threshold="setSessionThreshold"
                  />
                  <!-- Quota needs the percentages on screen to filter against, so in process mode
                       it stands down. Said in place, because a threshold that silently stopped
                       applying is exactly what reads as a bug. -->
                  <ExpandTransition :open="!quotaApplies">
                    <p
                      class="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
                    >
                      {{ $t('instances.filterQuotaNeedsUsageMode') }}
                    </p>
                  </ExpandTransition>
                  <ExpandTransition :open="quotaApplies && !weekEnabled && !sessionEnabled">
                    <p class="px-0.5 text-[11px] leading-snug text-muted-foreground">
                      {{ $t('instances.filterNoWindows') }}
                    </p>
                  </ExpandTransition>
                </section>

                <!-- On with nothing chosen anywhere is a reachable state rather than a disabled
                     switch, so it has to say so — otherwise the only symptom is a table that never
                     reacted. -->
                <ExpandTransition :open="noRule">
                  <p
                    class="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
                  >
                    {{ $t('instances.filterNothingSelected') }}
                  </p>
                </ExpandTransition>

                <section class="space-y-1.5">
                  <h3 :class="CAPTION">{{ $t('instances.filterDisplay') }}</h3>
                  <div :class="cn(CARD, 'flex items-center gap-3 px-2.5 py-1.5')">
                    <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
                      {{ $t('instances.filterHide') }}
                      <InfoHint :text="$t('instances.filterHideHint')" />
                    </span>
                    <Switch v-model="hideMatches" />
                  </div>
                </section>
              </div>
            </ExpandTransition>

            <section class="space-y-1.5">
              <h3 :class="CAPTION">{{ $t('instances.usageDataTitle') }}</h3>
              <!-- The same rows Settings shows, from one source (components/UsageRefreshRows.vue).
                   The numbers this filter compares are only as fresh as this setting keeps them, so
                   it is the one other control that belongs in this flyout. Its rows carry their own
                   padding, so the card supplies only the frame. -->
              <div class="divide-y divide-border/60 rounded-md border border-border bg-background/60">
                <UsageRefreshRows />
              </div>
            </section>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>
