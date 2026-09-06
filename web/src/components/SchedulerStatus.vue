<script setup lang="ts">
// A persistent "is anything happening?" indicator for the header. Answers, at a glance and
// without opening the queue drawer: is the scheduler on, is a run executing right now, and
// when does the next scheduled item fire. Built for peace-of-mind ("I'm going to bed — will
// this actually run?"). Reads the same polled data the queue uses; a 1s local tick keeps the
// countdown live between polls.
import { CircleAlert, Loader2, PowerOff, SlidersHorizontal } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useData } from '@/composables/useData'
import { usePanels } from '@/composables/usePanels'
import * as api from '@/lib/api'
import IconTooltip from '@/shell/IconTooltip.vue'

const { t } = useI18n()
const { queue, scheduler, refreshScheduler, schedulerStatus } = useData()
// The header chip is the one place people SEE the scheduler state (especially "off"), so it is also
// where it gets switched. It used to deep-link into Settings → Scheduler, which is a strange trip
// for a single boolean: you left the screen you were on, a settings page scrolled and flashed a
// row at you, and the thing you actually wanted was one switch. The switch is here now; only the
// advanced tuning (spacing / poll / concurrency) still lives in Settings, and this links to it.
const { openSettingsTab } = usePanels()
const open = ref(false)
const toggling = ref(false)

async function setEnabled(next: boolean) {
  toggling.value = true
  try {
    await api.updateScheduler({ enabled: next })
    await refreshScheduler()
  } finally {
    toggling.value = false
  }
}

function openAdvanced() {
  open.value = false
  openSettingsTab('scheduler')
}

// Local clock so the "next in 4m 12s" text ticks every second, not only on the 2s queue poll.
const now = ref(Date.now())
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => window.clearInterval(timer))

const enabled = computed(() => !!scheduler.value?.enabled)
const runningCount = computed(() => queue.value.filter((q) => q.status === 'running').length)

const queued = computed(() => queue.value.filter((q) => q.status === 'queued'))
// A queued item is "due" when it has no not_before or its not_before has passed.
const dueNow = computed(
  () => queued.value.filter((q) => !q.not_before || Date.parse(q.not_before) <= now.value).length,
)
// Soonest future not_before across queued items (ms), or null when nothing is scheduled ahead.
const nextAtMs = computed<number | null>(() => {
  const future = queued.value
    .map((q) => (q.not_before ? Date.parse(q.not_before) : NaN))
    .filter((ms) => Number.isFinite(ms) && ms > now.value)
  return future.length ? Math.min(...future) : null
})

/** "5s" · "4m 12s" · "2h 05m" · "1d 3h" — compact, coarsens as it grows. */
function humanizeUntil(ms: number): string {
  const s = Math.max(0, Math.round((ms - now.value) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

// One of: unavailable (AH-20 — couldn't even read the scheduler's state) · off · running ·
// dispatching (due items waiting for the next poll) · countdown · idle
type State = 'unavailable' | 'off' | 'running' | 'dispatching' | 'countdown' | 'idle'
const state = computed<State>(() => {
  // Checked FIRST: `scheduler` is null both before the first poll lands and after every poll has
  // failed, and `!enabled.value` reads exactly like a real off switch either way — that is the
  // "outage renders as Scheduler off" bug. `unavailable` only turns true once the very first
  // fetch has actually rejected, so an ordinary not-yet-loaded moment never trips it.
  if (schedulerStatus.unavailable.value) return 'unavailable'
  if (!enabled.value) return 'off'
  if (runningCount.value > 0) return 'running'
  if (dueNow.value > 0) return 'dispatching'
  if (nextAtMs.value !== null) return 'countdown'
  return 'idle'
})

const label = computed(() => {
  switch (state.value) {
    case 'unavailable':
      return t('scheduler.unavailable')
    case 'off':
      return t('scheduler.off')
    case 'running':
      return t('scheduler.running', { n: runningCount.value })
    case 'dispatching':
      return t('scheduler.dispatching', { n: dueNow.value })
    case 'countdown':
      return t('scheduler.nextIn', { time: humanizeUntil(nextAtMs.value as number) })
    default:
      return t('scheduler.idle')
  }
})

const tooltip = computed(() => {
  if (state.value === 'unavailable') {
    return `${t('scheduler.unavailableHint', { reason: schedulerStatus.error.value ?? '' })} ${t('scheduler.clickToToggle')}`
  }
  return `${enabled.value ? t('scheduler.onTooltip') : t('scheduler.offTooltip')} ${t('scheduler.clickToToggle')}`
})

const queuedCount = computed(() => queued.value.length)

// green when actively working, dim-green when on-but-idle, amber when off OR unavailable so
// either one draws the eye.
const tone = computed(() => {
  if (state.value === 'off' || state.value === 'unavailable') return 'text-warning'
  if (state.value === 'idle') return 'text-success/70'
  return 'text-success'
})
</script>

<template>
  <!-- Popover INSIDE IconTooltip, wrapped in a plain <span>. Reversing the two puts the tooltip's
       PopperRoot between this trigger and its own root, which steals the anchor and leaves the
       content parked off-screen — see scripts/checks/reka-popper-root-inside-tooltip.mjs, which
       fails the build for exactly this nesting. -->
  <IconTooltip :label="label" :description="tooltip">
    <span class="inline-flex">
      <Popover v-model:open="open">
        <PopoverTrigger as-child>
          <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          :class="tone"
          :aria-label="label"
        >
          <Loader2 v-if="state === 'running'" class="size-3.5 animate-spin" />
          <CircleAlert v-else-if="state === 'unavailable'" class="size-3.5" />
          <span
            v-else-if="state !== 'off'"
            class="relative flex size-2"
          >
            <span
              v-if="state === 'dispatching' || state === 'countdown'"
              class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60"
            />
            <span class="relative inline-flex size-2 rounded-full bg-current" />
          </span>
          <PowerOff v-else class="size-3.5" />
          <span class="hidden tabular-nums sm:inline">{{ label }}</span>
        </button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-60 p-3">
          <p v-if="state === 'unavailable'" class="mb-2 text-[11px] text-warning">
            {{ $t('scheduler.unavailableHint', { reason: schedulerStatus.error ?? '' }) }}
          </p>
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-medium">{{ $t('scheduler.enabledLabel') }}</p>
              <p class="text-[11px] text-muted-foreground">
                {{ $t('scheduler.countsLine', { running: runningCount, queued: queuedCount }) }}
              </p>
            </div>
            <Switch
              :model-value="enabled"
              :disabled="toggling"
              :aria-label="$t('scheduler.enabledLabel')"
              @update:model-value="setEnabled"
            />
          </div>
          <!-- Only the rarely-touched numeric knobs still justify the trip to Settings. -->
          <Button variant="ghost" size="xs" class="mt-2 w-full justify-start" @click="openAdvanced()">
            <SlidersHorizontal class="size-3.5" /> {{ $t('scheduler.advancedLink') }}
          </Button>
        </PopoverContent>
      </Popover>
    </span>
  </IconTooltip>
</template>
