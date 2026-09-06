<script setup lang="ts">
// One row of the run queue. Split out of QueueView.vue when finished runs moved behind their own
// disclosure: the card renders identically in both groups, and the alternative was the same 80 lines
// of markup twice, drifting apart on the first edit.
import {
  Ban,
  ChevronDown,
  Clock,
  Cpu,
  FolderGit2,
  Gauge,
  Inbox,
  Pencil,
  Play,
  Trash2,
  UserCircle2,
} from '@lucide/vue'
import ExpandArea from '@/components/ExpandArea.vue'
import RunViewer from '@/components/RunViewer.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { QueueItem } from '@/lib/api'
import { baseName, formatRunAt } from '@/lib/format'
import { HEADLESS_QUEUEING_ENABLED } from '@/lib/headless'
import IconTooltip from '@/shell/IconTooltip.vue'

defineProps<{
  item: QueueItem
  expanded: boolean
  accountLabel: string | null
}>()

defineEmits<{
  toggle: []
  run: []
  cancel: []
  edit: []
  remove: []
}>()
</script>

<template>
  <div class="mb-2.5 overflow-hidden rounded-xl border border-border bg-card">
    <div class="flex items-start gap-3 p-3">
      <button
        class="mt-0.5 text-muted-foreground transition-transform hover:text-foreground"
        :class="expanded ? 'rotate-0' : '-rotate-90'"
        :title="$t('queue.toggleLiveOutput')"
        @click="$emit('toggle')"
      >
        <ChevronDown class="size-4" />
      </button>

      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <span class="truncate text-sm font-medium">{{ item.title }}</span>
          <StatusBadge :status="item.status" />
        </div>

        <p class="mt-1 line-clamp-2 text-xs text-muted-foreground">{{ item.prompt }}</p>

        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">
            <FolderGit2 /> {{ baseName(item.cwd) }}
          </Badge>
          <Badge v-if="item.not_before && item.status === 'queued'" variant="warning">
            <Clock /> {{ $t('queue.scheduledFor', { time: formatRunAt(item.not_before) }) }}
          </Badge>
          <!-- The run being over and the work being WHERE THE OWNER LOOKS are two different
               facts. A migrated or handed-off chat is delivered into a desktop instance's app
               only while that app is running, so a delivery can sit waiting (or be given up on)
               behind a row that reads 'completed' - which is exactly what used to be invisible. -->
          <Badge
            v-if="item.import_state === 'pending'"
            variant="warning"
            :title="item.import_error ?? undefined"
          >
            <Inbox /> {{ $t('queue.deliveryPending') }}
          </Badge>
          <Badge
            v-else-if="item.import_state === 'gave_up'"
            variant="destructive"
            :title="item.import_error ?? undefined"
          >
            <Inbox /> {{ $t('queue.deliveryFailed') }}
          </Badge>
          <Badge v-if="item.new_chat" variant="info">{{ $t('queue.newChat') }}</Badge>
          <Badge v-if="item.fork" variant="secondary">{{ $t('queue.fork') }}</Badge>
          <Badge v-if="item.model" variant="secondary">
            <Cpu /> {{ item.model }}
          </Badge>
          <Badge v-if="item.effort" variant="secondary">
            <Gauge /> {{ item.effort }}
          </Badge>
          <Badge v-if="accountLabel" variant="secondary">
            <UserCircle2 /> {{ accountLabel }}
          </Badge>
          <!-- -1 is OUR code for "the process vanished before it finished", never something claude
               reported, so it gets said in words instead of as a number nobody can look up. -->
          <Badge v-if="item.exit_code === -1" variant="secondary" :title="$t('queue.exitLostHint')">
            {{ $t('queue.exitLost') }}
          </Badge>
          <Badge v-else-if="item.exit_code !== null" variant="secondary">
            {{ $t('queue.exit') }} {{ item.exit_code }}
          </Badge>
        </div>
      </div>

      <div class="flex shrink-0 flex-col gap-1.5">
        <!-- AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts) — every run
             attempt fails moments after reporting "started" now, so Run is disabled with the real
             reason rather than left to fail predictably. Cancel is untouched: it stops a process
             that is genuinely active (a legacy row from before this policy, or one mid-shutdown),
             which has nothing to do with dispatch being refused. -->
        <IconTooltip
          v-if="item.status !== 'running' && !HEADLESS_QUEUEING_ENABLED"
          :label="$t('queue.run')"
          :description="$t('queue.runUnavailableHint')"
        >
          <Button size="sm" variant="outline" disabled>
            <Play /> {{ $t('queue.run') }}
          </Button>
        </IconTooltip>
        <Button
          v-else-if="item.status !== 'running'"
          size="sm"
          variant="outline"
          :title="$t('queue.runNow')"
          @click="$emit('run')"
        >
          <Play /> {{ $t('queue.run') }}
        </Button>
        <Button v-else size="sm" variant="outline" :title="$t('queue.cancel')" @click="$emit('cancel')">
          <Ban /> {{ $t('queue.stop') }}
        </Button>
        <div class="flex items-center justify-end gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            :title="$t('queue.edit')"
            :disabled="item.status === 'running'"
            @click="$emit('edit')"
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            :title="$t('queue.delete')"
            :disabled="item.status === 'running'"
            @click="$emit('remove')"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>

    <ExpandArea :open="expanded">
      <div class="h-72 border-t border-border bg-background/40">
        <RunViewer :item-id="item.id" />
      </div>
    </ExpandArea>
  </div>
</template>
