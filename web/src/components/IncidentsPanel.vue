<script setup lang="ts">
// A repeated queue-run failure, grouped and deduped (server/src/incidents.ts). Collapsed by
// default behind an open-count badge - a quiet fleet should look quiet - and expands to a short
// list with ack/resolve, mirroring QueueView's "Show finished" disclosure.
import { ChevronDown, CircleAlert, TriangleAlert } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useData } from '@/composables/useData'
import type { Incident } from '@/lib/api'
import * as api from '@/lib/api'
import { baseName, timeAgo } from '@/lib/format'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const { incidents, incidentsStatus, refreshIncidents } = useData()

const expanded = ref(false)
// Newest activity first is already the server's own order (listIncidents); resolved incidents sort
// to the bottom within that so the list reads "what needs attention" before "what's done".
const sorted = computed(() =>
  [...incidents.value].sort((a, b) => {
    if ((a.state === 'resolved') !== (b.state === 'resolved'))
      return a.state === 'resolved' ? 1 : -1
    return 0
  }),
)
const openCount = computed(() => incidents.value.filter((i) => i.state !== 'resolved').length)

const busy = ref<string | null>(null)
async function ack(incident: Incident) {
  busy.value = incident.id
  try {
    await api.ackIncident(incident.id)
  } catch {
    toast.error(t('incidents.toastAckFailed'))
  }
  busy.value = null
  await refreshIncidents()
}
async function resolve(incident: Incident) {
  busy.value = incident.id
  try {
    await api.resolveIncident(incident.id)
  } catch {
    toast.error(t('incidents.toastResolveFailed'))
  }
  busy.value = null
  await refreshIncidents()
}

const STATE_VARIANT: Record<Incident['state'], 'warning' | 'secondary' | 'success'> = {
  open: 'warning',
  acked: 'secondary',
  resolved: 'success',
}
</script>

<template>
  <div
    v-if="incidents.length > 0 || incidentsStatus.unavailable"
    class="shrink-0 border-b border-border px-3 pt-2 pb-1"
  >
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="flex flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <ChevronDown
          class="size-3.5 transition-transform"
          :class="expanded ? 'rotate-0' : '-rotate-90'"
        />
        <TriangleAlert class="size-3.5" :class="openCount > 0 ? 'text-warning' : ''" />
        {{ t('incidents.title') }}
        <Badge v-if="openCount > 0" variant="warning">{{ t('incidents.openCount', { n: openCount }) }}</Badge>
        <InfoHint :text="t('incidents.whatIsIncidents')" />
      </button>
    </div>

    <!-- AH-20: the FIRST incidents fetch ever failed — there is nothing to show, so say that
         instead of silently rendering as "no incidents", the exact lie AH-20 was filed against.
         Mirrors QueueView's unavailable state: an icon, the server's own reason, and Retry. -->
    <div
      v-if="incidentsStatus.unavailable"
      class="mb-1.5 flex flex-col items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-2 text-center text-[11px] text-warning"
    >
      <CircleAlert class="size-4 opacity-70" />
      <p>{{ t('incidents.unavailable', { reason: incidentsStatus.error }) }}</p>
      <Button size="xs" variant="outline" @click="refreshIncidents()">{{ t('incidents.retry') }}</Button>
    </div>

    <!-- a LATER poll failed but we still have incidents on screen — keep showing them, just say
         they may be stale, same as the queue's staleHint. -->
    <p
      v-else-if="incidentsStatus.stale"
      class="mb-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning"
    >
      {{ t('incidents.staleHint', { reason: incidentsStatus.error }) }}
    </p>

    <div v-if="expanded" class="mb-1.5 flex flex-col gap-1.5">
      <div
        v-for="incident in sorted"
        :key="incident.id"
        class="rounded-lg border border-border bg-card p-2.5 text-xs"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-medium" :title="incident.key">{{ baseName(incident.key) }}</span>
              <Badge :variant="STATE_VARIANT[incident.state]">
                <template v-if="incident.state === 'open'">{{ t('incidents.stateOpen') }}</template>
                <template v-else-if="incident.state === 'acked'">{{ t('incidents.stateAcked') }}</template>
                <template v-else>{{ t('incidents.stateResolved') }}</template>
              </Badge>
              <Badge variant="outline">{{ t('incidents.occurrences', { n: incident.count }) }}</Badge>
            </div>
            <p class="mt-1 truncate text-muted-foreground" :title="incident.error">{{ incident.error }}</p>
            <p class="mt-0.5 text-[0.6875rem] text-muted-foreground/70">
              {{ t('incidents.lastSeen', { time: timeAgo(incident.last_seen_at) }) }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <IconTooltip v-if="incident.state === 'open'" :label="t('incidents.ack')">
              <Button
                size="xs"
                variant="outline"
                :disabled="busy === incident.id"
                @click="ack(incident)"
                >{{ t('incidents.ack') }}</Button
              >
            </IconTooltip>
            <Button
              v-if="incident.state !== 'resolved'"
              size="xs"
              variant="outline"
              :disabled="busy === incident.id"
              @click="resolve(incident)"
              >{{ t('incidents.resolve') }}</Button
            >
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
