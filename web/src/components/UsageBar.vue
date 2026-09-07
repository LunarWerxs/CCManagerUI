<script setup lang="ts">
// The usage-mode table cell: a bar whose length and colour BOTH say the same thing.
//
//   SHORT + GREEN = the wait is nearly over
//   LONG  + RED   = you are stuck with this for days
//
// Pointing both channels the same way is what makes the column scannable without reading it. An
// earlier version coloured by burn and sized by time, which technically carried more data and in
// practice meant every bar had to be decoded individually — exactly what a table full of numbers
// already does.
//
// The burn percentage is not lost: it has its own column (Usage) and rides under each bar as a
// caption. It simply stops competing for the same visual channel.
//
// Colour is never the ONLY signal: it rides alongside a length and a text label, so a red-green
// colour-blind viewer loses nothing that isn't also written down.
import { computed } from 'vue'
import type { WaitSeverity } from '@/lib/usage-reset'

/**
 * A wait band, or `'neutral'` — a bar drawn in greys.
 *
 * The usage-mode row carries four quota cells, and when every one of them is coloured the row has
 * no emphasis left to give: four hues side by side average out to "busy", and the eye has to read
 * each one to find out which is the alarming one. The two 5-HOUR cells are the ones that give up
 * their colour, because a spent session comes back the same afternoon while a spent WEEK is the
 * reading that decides whether an account is worth starting on at all. So the week keeps the
 * colour, the session keeps its length and its number, and a red row means something again.
 */
export type UsageBarVariant = WaitSeverity | 'neutral'

const props = defineProps<{
  /** 0-100. Drives the bar's LENGTH. */
  fillPct: number
  /**
   * Drives the bar's COLOUR.
   *
   * `'neutral'` is a bar that keeps its LENGTH but spends no colour: greys, the same weight the
   * Plan chip carries. It exists because colour is a scarce channel across a whole row — see
   * UsageBarVariant below.
   */
  variant: UsageBarVariant
  /** What is written inside the bar — a countdown for a time window, a percentage for a plain one. */
  label: string
  /** Small caption under the bar (the burn percentage, or the model name). */
  caption?: string | null
  /** Spoken value for assistive tech, when the visible label is not the meter's own number. */
  ariaLabel?: string
}>()

const width = computed(() => Math.min(100, Math.max(0, Math.round(props.fillPct))))

// Track, fill and label are three weights of ONE hue, matching the usage chip beside them
// (badgeVariants: a /10 tint behind /20 in dark, with the label in the full colour). A solid fill
// was far louder than anything else in the row — the bar is a background reading, not an alert, and
// a table of solid red bars shouts over the chip that is actually carrying the number.
//
// The fill still has to separate from its own track, so it sits a few steps up rather than at the
// same tint: /10 track under a /35 fill reads clearly without going bright.
// The alphas are not eyeballed: they are the point where the neutral label clears WCAG AA (4.5:1)
// against the FILL, measured on this palette. Amber is the constraint — it is the lightest of the
// three hues, so a fill dense enough to look right in red washes the label out in warning. Raising
// these is the change that quietly breaks legibility on the one row that matters.
//
// `neutral` is the same two weights in the palette's own grey rather than a hue: it has to read as
// a deliberate absence of colour (a bar that is not telling you anything urgent), not as a fourth,
// even calmer severity. `muted-foreground` at these alphas is the ONE grey that separates from the
// track in both themes — `border` disappears into the row in dark, `muted` into the card in light.
const FILL: Record<string, string> = {
  success: 'bg-success/30 dark:bg-success/32',
  warning: 'bg-warning/30 dark:bg-warning/32',
  destructive: 'bg-destructive/35 dark:bg-destructive/45',
  neutral: 'bg-muted-foreground/25 dark:bg-muted-foreground/30',
}
const TRACK: Record<string, string> = {
  success: 'bg-success/10 dark:bg-success/20',
  warning: 'bg-warning/10 dark:bg-warning/20',
  destructive: 'bg-destructive/10 dark:bg-destructive/20',
  neutral: 'bg-muted-foreground/10 dark:bg-muted-foreground/15',
}
// The label is NEUTRAL, not the hue.
//
// The chip beside this can afford coloured text because it has one background; the bar has two, and
// the label sits wherever the fill happens to have reached. Red-on-red at a 45% fill is the case
// that fails: it is legible while the bar is short and washes out as the fill passes under it,
// which is exactly when the row matters most. A neutral label has the same contrast at 5% fill and
// at 100%, in both themes, for every hue. The colour identity is carried by the track and fill,
// which is the whole width of the bar.
const TEXT = 'text-foreground'
</script>

<template>
  <div class="min-w-[5rem] leading-tight">
    <!-- role="meter": a bar with its value drawn inside is a meter, and a screen reader should be
         given the number rather than "graphic". aria-valuetext carries the label when the visible
         text is a duration rather than the meter's own percentage. -->
    <!-- rounded-full, so it sits in the same visual family as the usage chip in the next column. -->
    <div
      class="relative h-5 w-full overflow-hidden rounded-full"
      :class="TRACK[props.variant]"
      role="meter"
      :aria-valuenow="width"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuetext="ariaLabel ?? label"
    >
      <div
        class="absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
        :class="FILL[props.variant]"
        :style="{ width: `${width}%` }"
      />
      <!-- One label, layered over the fill (see TEXT above for why it is neutral rather than the
           hue): no second copy, no "is it legible at 47%?", and no blend mode fighting the palette. -->
      <span
        class="absolute inset-0 flex items-center justify-center whitespace-nowrap px-1.5 text-[0.625rem] font-medium"
        :class="TEXT"
      >
        {{ label }}
      </span>
    </div>
    <div v-if="caption" class="mt-0.5 text-[0.6875rem] text-muted-foreground">
      {{ caption }}
    </div>
  </div>
</template>
