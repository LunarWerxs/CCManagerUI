<script setup lang="ts">
// What the page is standing on: the daemon (every fact comes from it), the Python data layer
// (every verdict is computed there), and the tunnel this page arrived through.
import { Check, Copy, Globe, Link2 } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { GatewayStatus } from '@/lib/api'
import { tunnelBadgeFor } from '@/lib/tunnelBadge'

const props = defineProps<{ status: GatewayStatus | null; error: string | null }>()
const copied = ref<string | null>(null)

const tunnelBadge = computed(() => (props.status ? tunnelBadgeFor(props.status.remote) : null))

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = text
    setTimeout(() => {
      if (copied.value === text) copied.value = null
    }, 1500)
  } catch {
    /* clipboard can be unavailable over plain http; the URL is still visible */
  }
}

const shortUrl = (u: string) => u.replace(/^https?:\/\//, '')
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5 text-xs">
    <Badge v-if="error" variant="destructive">gateway: {{ error }}</Badge>
    <template v-else-if="props.status">
      <Badge :variant="props.status.daemon.ok ? 'success' : 'destructive'">
        daemon {{ props.status.daemon.ok ? props.status.daemon.version || 'up' : 'UNREACHABLE' }}
      </Badge>
      <Badge :variant="props.status.dashboard.ok ? 'success' : 'warning'">
        data layer {{ props.status.dashboard.ok ? 'up' : 'starting…' }}
      </Badge>

      <template v-if="props.status.remote.stableUrl">
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="inline-flex h-5 items-center gap-1 rounded-full border border-border bg-input/20 px-2 font-medium hover:bg-muted"
              @click="copy(props.status.remote.stableUrl!)"
            >
              <Link2 class="size-3" />
              <span class="mono max-w-[16rem] truncate">{{ shortUrl(props.status.remote.stableUrl) }}</span>
              <Check v-if="copied === props.status.remote.stableUrl" class="size-3 text-success" />
              <Copy v-else class="size-3 opacity-60" />
            </button>
          </TooltipTrigger>
          <TooltipContent>The permanent address - it follows the tunnel wherever it moves. Click to copy.</TooltipContent>
        </Tooltip>
      </template>
      <template v-if="props.status.remote.tunnelUrl">
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="inline-flex h-5 items-center gap-1 rounded-full border border-border bg-input/20 px-2 font-medium hover:bg-muted"
              @click="copy(props.status.remote.tunnelUrl!)"
            >
              <Globe class="size-3" />
              <span class="mono max-w-[16rem] truncate">{{ shortUrl(props.status.remote.tunnelUrl) }}</span>
              <Check v-if="copied === props.status.remote.tunnelUrl" class="size-3 text-success" />
              <Copy v-else class="size-3 opacity-60" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {{ props.status.remote.tunnel === 'named' ? 'Named Cloudflare tunnel - stable.' : 'This run\'s Quick Tunnel address - it changes on every restart; prefer the permanent one.' }}
          </TooltipContent>
        </Tooltip>
      </template>
      <!-- AH-26: which badge a stalled tunnel gets (a recorded failure reason vs a plain,
           intentional "off") is decided by tunnelBadgeFor() - see src/lib/tunnelBadge.ts. -->
      <Badge v-else-if="tunnelBadge" :variant="tunnelBadge.variant" :title="tunnelBadge.title ?? undefined">
        {{ tunnelBadge.text }}
      </Badge>
      <Badge v-if="props.status.remote.relayError" variant="warning" :title="props.status.remote.relayError">relay: {{ props.status.remote.relayError }}</Badge>
    </template>
    <Badge v-else variant="secondary">connecting…</Badge>
  </div>
</template>
