<script setup lang="ts">
import { ChevronDown, CircleAlert, ListPlus, Plus, Power, PowerOff, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IncidentsPanel from '@/components/IncidentsPanel.vue'
import QueueItemCard from '@/components/QueueItemCard.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useBuilder } from '@/composables/useBuilder'
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { useInstances } from '@/composables/useInstances'
import { usePanels } from '@/composables/usePanels'
import type { QueueItem } from '@/lib/api'
import * as api from '@/lib/api'
import { HEADLESS_QUEUEING_ENABLED } from '@/lib/headless'
import { displayName } from '@/lib/instance-appearance'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const { queue, queueLoaded, queueStatus, accounts, scheduler, refreshQueue } = useData()
const { openBuilder, openEditor } = useBuilder()
const { openSettingsTab } = usePanels()
// Run-as resolution mirrors QueueBuilder's accountOptions: an item pinned to a signed-in
// instance ('desktop:<dir>' / 'cli:<id>') resolves through these live lists; a bare uuid is the
// legacy sqlite accounts fallback. Refresh here too (silent) — these singletons only
// self-populate once the Instances tab has been opened, and the queue drawer can be the very
// first thing a user sees.
const { instances, refreshInstances } = useInstances()
const { cliInstances, refreshCliInstances } = useCliInstances()
onMounted(() => {
  void refreshInstances({ silent: true })
  void refreshCliInstances({ silent: true })
})
const expanded = ref<string | null>(null)

// What the state MEANS, then what clicking does. Mirrors SchedulerStatus's header chip, which
// says the same two things about the same setting.
const schedulerTooltip = computed(
  () =>
    `${scheduler.value?.enabled ? t('queue.schedulerOnHint') : t('queue.schedulerOffHint')} ${t('queue.schedulerClickHint')}`,
)

// A finished run is history, not a to-do. Left in the one flat list they crowd out the handful of
// items that still need something to happen, and the panel reads as a pile of work rather than a
// queue. Split by "is this still going to do something?" — everything else folds away behind a count.
// 'overloaded' belongs here: by the time a run reads it, the automatic retries are already spent
// (dispatch.ts), so nothing further will happen to it on its own.
const TERMINAL: QueueItem['status'][] = [
  'completed',
  'unverified',
  'failed',
  'canceled',
  'rate_limited',
  'overloaded',
]
const isFinished = (q: QueueItem) => TERMINAL.includes(q.status)

const active = computed(() => queue.value.filter((q) => !isFinished(q)))
const finished = computed(() => queue.value.filter(isFinished))
const showFinished = ref(false)

// Twenty runs finish overnight and the question in the morning is only ever "which ones died?".
// The daemon knows exactly, from each run's exit code, so this is a filter over ground truth rather
// than a guess: everything terminal that is not `completed`, whether it failed, was canceled, or
// stopped on a limit.
const diedOnly = ref(false)
const died = computed(() => finished.value.filter((q) => q.status !== 'completed'))
const finishedShown = computed(() => (diedOnly.value ? died.value : finished.value))

/** The login badge for a queue item: an instance-pinned item resolves through the live
 *  instance lists FIRST (desktop dir -> its displayName, cli id -> its name) — otherwise it
 *  would render with no account badge at all, since account_id is null on those items. Falls
 *  back to the legacy sqlite accounts lookup only when no instance_ref is set. A ref that no
 *  longer resolves (the instance/account was deleted) still gets a clearly-labeled badge rather
 *  than silently rendering blank. */
function accountLabel(item: QueueItem): string | null {
  const ref = item.instance_ref
  if (ref) {
    if (ref.startsWith('desktop:')) {
      const dir = ref.slice('desktop:'.length)
      const inst = instances.value.find((i) => i.dir === dir)
      return inst ? displayName(inst) : t('queue.deletedInstance')
    }
    if (ref.startsWith('cli:')) {
      const id = ref.slice('cli:'.length)
      const inst = cliInstances.value.find((c) => c.id === id)
      return inst ? inst.name : t('queue.deletedInstance')
    }
    return t('queue.deletedInstance')
  }
  if (!item.account_id) return null
  return accounts.value.find((a) => a.id === item.account_id)?.label ?? 'account'
}

function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}

/** AH-26: show the server's own error text when present — a bad cwd, a stale session id, a run
 *  the daemon refused — rather than a fixed generic toast that never says why. */
function actionErrorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

async function cancel(item: QueueItem) {
  try {
    await api.cancelQueueItem(item.id)
  } catch (e) {
    toast.error(actionErrorText(e, t('queue.toastCancelFailed')))
  }
  await refreshQueue()
}
async function remove(item: QueueItem) {
  try {
    await api.deleteQueueItem(item.id)
  } catch (e) {
    toast.error(actionErrorText(e, t('queue.toastDeleteFailed')))
  }
  await refreshQueue()
}

// --- clear finished ----------------------------------------------------------
// Two-click confirm rather than a dialog, matching Settings' Disconnect: the click is reversible in
// spirit (these runs are already over and re-queuing one is a click away) but it is still a bulk
// delete, so it should not fire on a stray click. The confirm resets on blur.
const confirmClear = ref(false)
const clearing = ref(false)
async function clearFinished() {
  if (!confirmClear.value) {
    confirmClear.value = true
    return
  }
  confirmClear.value = false
  clearing.value = true
  // No bulk endpoint exists, and a local daemon has no reason to grow one for this: the items are
  // deleted concurrently and each failure is counted rather than aborting the rest.
  const results = await Promise.all(
    finished.value.map((item) =>
      api
        .deleteQueueItem(item.id)
        .then(() => true)
        .catch(() => false),
    ),
  )
  clearing.value = false
  const failed = results.filter((ok) => !ok).length
  if (failed) toast.error(t('queue.toastClearFailed', { n: failed }))
  else toast.success(t('queue.toastCleared', { n: results.length }))
  // Collapse the section: leaving an empty "Finished (0)" disclosure open reads as a broken filter.
  showFinished.value = false
  diedOnly.value = false
  expanded.value = null
  await refreshQueue()
}
</script>

<template>
  <!-- rendered inside the queue drawer: the Sidebar header carries the title, this
       toolbar carries the count, scheduler state, and the new-run shortcut -->
  <div class="flex h-full min-h-0 flex-col">
    <IncidentsPanel />
    <div class="flex shrink-0 items-center justify-between gap-2 p-3">
      <!-- count what's still pending, not the all-time total: "7 items" over a queue of 6 finished
           runs and 1 live one described the history, not the work -->
      <div class="flex items-center gap-1.5 text-sm text-muted-foreground">
        {{ $t('queue.itemsCount', { n: active.length }) }}
        <InfoHint :text="$t('queue.whatIsQueue')" />
      </div>
      <div class="flex items-center gap-2">
        <!-- scheduler state at a glance: an icon (not a text pill), state + meaning on hover.
             A button, not a span: this indicator is where people NOTICE the scheduler is off, so
             it should also be the way to go fix it. Deep-links to Settings → Scheduler, which
             pulses on arrival so the landing spot is obvious. -->
        <IconTooltip
          :label="scheduler?.enabled ? $t('queue.schedulerOnLabel') : $t('queue.schedulerOffLabel')"
          :description="schedulerTooltip"
        >
          <button
            type="button"
            class="inline-flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            :class="scheduler?.enabled ? 'text-success' : 'text-muted-foreground'"
            :aria-label="scheduler?.enabled ? $t('queue.schedulerOnLabel') : $t('queue.schedulerOffLabel')"
            @click="openSettingsTab('scheduler')"
          >
            <Power v-if="scheduler?.enabled" class="size-3.5" />
            <PowerOff v-else class="size-3.5" />
          </button>
        </IconTooltip>
        <!-- AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts) — creating a
             new run always 409s and running/run-due always fail moments after "started", so the
             control that used to open the builder is a disabled, explained stand-in instead of a
             button that would work until you actually pressed it. -->
        <IconTooltip
          v-if="!HEADLESS_QUEUEING_ENABLED"
          :label="$t('queue.newRun')"
          :description="$t('queue.createUnavailableHint')"
        >
          <Button size="sm" disabled :aria-label="$t('queue.newRun')">
            <Plus /> {{ $t('queue.newRun') }}
          </Button>
        </IconTooltip>
        <Button v-else size="sm" :aria-label="$t('queue.newRun')" @click="openBuilder()">
          <Plus /> {{ $t('queue.newRun') }}
        </Button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <!-- AH-20: a rejected fetch is not the same fact as a queue with zero items — the empty-state
           CTA below used to render identically for both, so an outage read as "you have no queued
           work". Non-modal, not a toast: this is a state of the panel, not a one-off event. Shown
           whenever there is OLDER data still on screen but the latest poll failed. -->
      <p
        v-if="queueStatus.stale"
        class="mb-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning"
      >
        {{ $t('queue.staleHint', { reason: queueStatus.error }) }}
      </p>

      <!-- first-load skeletons so the queue never looks blank -->
      <template v-if="!queueLoaded && queue.length === 0">
        <div v-for="i in 3" :key="i" class="mb-2.5 rounded-xl border border-border bg-card p-3">
          <div class="flex items-start gap-3">
            <Skeleton class="mt-0.5 size-4" />
            <div class="min-w-0 flex-1">
              <Skeleton class="h-4" :style="{ width: `${70 - (i % 3) * 15}%` }" />
              <Skeleton class="mt-2 h-3 w-11/12" />
              <div class="mt-2.5 flex items-center gap-1.5">
                <Skeleton class="h-5 w-20" />
                <Skeleton class="h-5 w-14" />
                <Skeleton class="h-5 w-16" />
              </div>
            </div>
            <Skeleton class="h-6 w-16" />
          </div>
        </div>
      </template>

      <!-- the FIRST fetch failed and there is nothing to show — an error state with a Retry,
           never the "queue a run" empty-state CTA, which would claim there is genuinely no work. -->
      <div
        v-else-if="queue.length === 0 && queueStatus.unavailable"
        class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <CircleAlert class="size-8 text-warning opacity-70" />
        <p>{{ $t('queue.unavailable', { reason: queueStatus.error }) }}</p>
        <Button size="sm" variant="outline" @click="refreshQueue()">{{ $t('queue.retry') }}</Button>
      </div>

      <div
        v-else-if="queue.length === 0"
        class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground"
      >
        <ListPlus class="size-8 opacity-40" />
        <p>{{ $t('queue.empty') }}</p>
        <p v-if="!HEADLESS_QUEUEING_ENABLED" class="max-w-xs text-xs">
          {{ $t('queue.createUnavailableHint') }}
        </p>
        <Button v-else size="sm" variant="outline" @click="openBuilder()"
          ><ListPlus /> {{ $t('queue.queueARun') }}</Button
        >
      </div>

      <QueueItemCard
        v-for="item in active"
        :key="item.id"
        :item="item"
        :expanded="expanded === item.id"
        :account-label="accountLabel(item)"
        @toggle="toggle(item.id)"
        @cancel="cancel(item)"
        @edit="openEditor(item)"
        @remove="remove(item)"
      />

      <!-- nothing left to run, but the history is still there: say so rather than show the empty-queue
           call to action, which would read as "you have no runs at all" -->
      <p
        v-if="active.length === 0 && finished.length > 0"
        class="py-6 text-center text-sm text-muted-foreground"
      >
        {{ $t('queue.allDone') }}
      </p>

      <template v-if="finished.length > 0">
        <div class="mt-1 flex items-center gap-1">
          <button
            type="button"
            class="flex flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            :aria-expanded="showFinished"
            @click="showFinished = !showFinished"
          >
            <ChevronDown class="size-3.5 transition-transform" :class="showFinished ? 'rotate-0' : '-rotate-90'" />
            {{ showFinished ? $t('queue.hideFinished') : $t('queue.showFinished', { n: finished.length }) }}
          </button>
          <!-- Finished runs are history the queue accumulates forever; this is the only way to get
               rid of them short of deleting each card. Sits on the disclosure row so it is right
               where you are already looking when you go to check the pile. -->
          <Button
            :variant="confirmClear ? 'destructive' : 'ghost'"
            size="xs"
            :disabled="clearing"
            :title="$t('queue.clearFinishedTitle')"
            @click="clearFinished"
            @blur="confirmClear = false"
          >
            <Trash2 />
            {{ confirmClear ? $t('queue.clearFinishedConfirm') : $t('queue.clearFinished') }}
          </Button>
        </div>

        <!-- the morning question: which of last night's runs did not finish -->
        <div v-if="showFinished && died.length > 0" class="mt-1 flex items-center gap-2 px-1">
          <button
            type="button"
            class="rounded-md px-1.5 py-1 text-xs transition-colors"
            :class="diedOnly ? 'font-medium text-warning' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="diedOnly"
            @click="diedOnly = !diedOnly"
          >
            {{ diedOnly ? $t('queue.showAllFinished') : $t('queue.showDiedOnly', { n: died.length }) }}
          </button>
        </div>

        <div v-if="showFinished" class="mt-2">
          <QueueItemCard
            v-for="item in finishedShown"
            :key="item.id"
            :item="item"
            :expanded="expanded === item.id"
            :account-label="accountLabel(item)"
            @toggle="toggle(item.id)"
            @cancel="cancel(item)"
            @edit="openEditor(item)"
            @remove="remove(item)"
          />
        </div>
      </template>
    </div>
  </div>
</template>
