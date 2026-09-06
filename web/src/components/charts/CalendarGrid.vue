<script setup lang="ts">
// The calendar heatmap: one square per DAY, weeks as columns, so a year of work reads as a shape.
//
// WHY IT EXISTS BESIDE HourGrid. That one answers "what time of day do I work" by collapsing every
// date into a 7x24 hour-of-week grid — the calendar is thrown away, so it cannot answer "when" over
// months at all. Both are useful and they are different questions, so this is a second grain on the
// same panel rather than a replacement: hour-of-week for the daily rhythm, calendar for the arc of
// a project.
//
// SAME VISUAL RULES AS HourGrid, deliberately: sequential, ONE hue, encoded as opacity over
// --viz-seq so the ramp is monotonic by construction and cannot cross a hue boundary, with a faint
// track under every cell so a quiet day reads as EMPTY rather than as missing. A rainbow would
// imply categories; these cells differ only in magnitude.
//
// CELLS SIZED FROM THE CONTAINER, like HourGrid, but from the WEEK COUNT rather than a fixed 24 —
// a fortnight and three years both have to fill the same card without overflowing it.
import { useElementSize } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ChartTip from '@/components/charts/ChartTip.vue'

const props = defineProps<{
  /** One entry per day that had activity, keyed `YYYY-MM-DD`. Days between are filled in here, so
   *  the caller passes only what it has and gaps still render as empty squares rather than closing
   *  up — a week off is part of the answer to "when does the work happen". */
  days: { key: string; value: number }[]
  /** Formats a value for the hover card, so the same grid works in either unit. */
  format: (n: number) => string
  /** What the value IS, for the hover card's row label ("Tokens", "Cost"). */
  valueLabel: string
}>()

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']
const LABEL_W = 28
const GAP = 3

const wrap = ref<HTMLElement | null>(null)
const { width } = useElementSize(wrap)

/** Every day from the first with data to the last, gaps included, each stamped with its column
 *  (weeks since the start) and row (day of week). Empty input yields an empty grid rather than a
 *  fabricated range. */
const cells = computed(() => {
  const byKey = new Map(props.days.map((d) => [d.key, d.value]))
  const keys = [...byKey.keys()].sort()
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (!first || !last) return []

  const start = new Date(`${first}T00:00:00`)
  // Back up to the Sunday on or before the first day, so every column is a whole week and the rows
  // line up with the day labels.
  start.setDate(start.getDate() - start.getDay())
  const end = new Date(`${last}T00:00:00`)

  const out: { key: string; value: number; col: number; row: number; date: Date }[] = []
  const cursor = new Date(start)
  let col = 0
  while (cursor <= end) {
    const row = cursor.getDay()
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
      cursor.getDate(),
    ).padStart(2, '0')}`
    out.push({ key, value: byKey.get(key) ?? 0, col, row, date: new Date(cursor) })
    if (row === 6) col++
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
})

const weeks = computed(() => (cells.value.at(-1)?.col ?? 0) + 1)

/**
 * Cell edge, derived from the space available and the number of weeks in range.
 *
 * Clamped at both ends for the same reasons HourGrid clamps: below 4px a square stops being
 * visible at all, and above 18px a short range becomes a wall of chunky blocks rather than a
 * calendar. Between those it fills, so a fortnight and three years both look deliberate.
 */
const cell = computed(() => {
  const usable = Math.max(0, (width.value || 720) - LABEL_W - GAP) - GAP * (weeks.value - 1)
  return Math.max(4, Math.min(18, Math.floor(usable / Math.max(1, weeks.value))))
})
const gridWidth = computed(() => weeks.value * cell.value + GAP * (weeks.value - 1))

/** Month ticks along the top: the column where each new month first appears. Only labelled when
 *  there is room for the text, otherwise the axis turns into overlapping noise. */
const monthTicks = computed(() => {
  const out: { col: number; label: string }[] = []
  let seen = ''
  for (const c of cells.value) {
    const stamp = `${c.date.getFullYear()}-${c.date.getMonth()}`
    if (stamp === seen) continue
    seen = stamp
    out.push({
      col: c.col,
      label: c.date.toLocaleDateString(undefined, { month: 'short' }),
    })
  }
  // Roughly 26px of text per label; drop every other one (then every third, …) until they fit.
  const step = Math.max(1, Math.ceil(26 / (cell.value + GAP)))
  return out.filter((_, i) => i % step === 0)
})

const { t } = useI18n()
const max = computed(() => Math.max(1, ...cells.value.map((c) => c.value)))
const hover = ref<string | null>(null)
const tip = ref({ x: 0, y: 0 })
const hovered = computed(() => cells.value.find((c) => c.key === hover.value) ?? null)

const tipRows = computed(() => {
  const c = hovered.value
  if (!c) return []
  const grand = cells.value.reduce((n, x) => n + x.value, 0)
  return [
    { label: props.valueLabel, value: props.format(c.value) },
    {
      label: t('analytics.tipShareOfWindow'),
      value:
        grand > 0 ? `${((c.value / grand) * 100).toFixed(c.value / grand < 0.001 ? 2 : 1)}%` : '0%',
    },
  ]
})

const tipTitle = computed(() =>
  hovered.value
    ? hovered.value.date.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '',
)

/** Floor at a faint tint so a day with the smallest bit of work still reads as not-empty. */
const intensity = (v: number) => (v === 0 ? 0 : 0.15 + 0.85 * (v / max.value))

/** The accessible name for one cell — the rich hover card is a mouse affordance, this is what a
 *  screen reader gets, so the grid is not mouse-only. */
const cellLabel = (c: { date: Date; value: number }) =>
  `${c.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${props.format(c.value)}`

function onEnter(key: string, e: MouseEvent) {
  hover.value = key
  tip.value = { x: e.clientX, y: e.clientY }
}
</script>

<template>
  <div ref="wrap" class="w-full">
    <div v-if="cells.length === 0" class="py-6 text-center text-[11px] text-muted-foreground">
      {{ $t('analytics.editsNone') }}
    </div>
    <div v-else :style="{ width: `${LABEL_W + GAP + gridWidth}px` }">
      <!-- month axis -->
      <div class="flex" :style="{ gap: `${GAP}px`, marginBottom: `${GAP}px` }">
        <span class="shrink-0" :style="{ width: `${LABEL_W}px` }"></span>
        <div class="relative h-3" :style="{ width: `${gridWidth}px` }">
          <span
            v-for="m in monthTicks"
            :key="`${m.col}-${m.label}`"
            class="absolute top-0 text-[10px] text-muted-foreground"
            :style="{ left: `${m.col * (cell + GAP)}px` }"
          >{{ m.label }}</span>
        </div>
      </div>
      <!-- seven rows, one per weekday; columns are weeks -->
      <div
        v-for="(label, row) in DAY_LABELS"
        :key="`row-${row}`"
        class="flex items-center"
        :style="{ gap: `${GAP}px`, marginBottom: `${GAP}px` }"
      >
        <span
          class="shrink-0 text-[10px] text-muted-foreground"
          :style="{ width: `${LABEL_W}px` }"
        >{{ label }}</span>
        <div class="relative" :style="{ width: `${gridWidth}px`, height: `${cell}px` }">
          <div
            v-for="c in cells.filter((x) => x.row === row)"
            :key="c.key"
            class="absolute top-0 rounded-[2px] bg-muted"
            :class="hover === c.key ? 'ring-1 ring-foreground/40' : ''"
            :style="{
              left: `${c.col * (cell + GAP)}px`,
              width: `${cell}px`,
              height: `${cell}px`,
            }"
            :aria-label="cellLabel(c)"
            @mouseenter="onEnter(c.key, $event)"
            @mousemove="tip = { x: $event.clientX, y: $event.clientY }"
            @mouseleave="hover = null"
          >
            <div
              class="size-full rounded-[2px]"
              :style="{ background: 'var(--viz-seq)', opacity: intensity(c.value) }"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <ChartTip v-if="hovered" :x="tip.x" :y="tip.y" :title="tipTitle" :rows="tipRows" />
</template>
