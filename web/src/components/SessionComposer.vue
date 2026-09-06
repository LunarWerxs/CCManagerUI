<script setup lang="ts">
import { ExternalLink, SendHorizonal, UsersRound } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAppSettings } from '@/composables/useAppSettings'
import * as api from '@/lib/api'
import IconTooltip from '@/shell/IconTooltip.vue'

export interface ComposerTarget {
  session_id: string
  title: string
  cwd: string
  /** Desktop instance the session belongs to ("default" | instance dir name), when known. Kept
   *  on the type for callers that already pass it; no longer read here (see the header note on
   *  AH-12 below — delivery reuses the chat's own account, there is nothing left to override). */
  instance?: string | null
}

const props = defineProps<{ targets: ComposerTarget[] }>()
const emit = defineEmits<{ sent: [mode: 'now' | 'queued'] }>()

const { t } = useI18n()
const { chatGptHandoffEnabled, load: loadAppSettings } = useAppSettings()
onMounted(() => {
  void loadAppSettings()
})

const text = ref('')
const sending = ref(false)

const single = computed(() => (props.targets.length === 1 ? props.targets[0] : null))

const canSend = computed(() => !!text.value.trim() && props.targets.length > 0 && !sending.value)
const handingOff = ref(false)
const canHandoff = computed(() => !!text.value.trim() && !!single.value && !handingOff.value)

/** AH-26: show the server's real reason a send failed (bad cwd, stale session, a run the daemon
 *  refused) instead of reducing every failure to a bare count — the count alone gave no way to
 *  tell what to fix, and made a genuinely broken send look identical to a transient one.
 *
 *  AH-12: this is also what makes a BUSY target honest now. Delivery goes straight through
 *  server/src/routes/session-message.ts (the same route fan_out_send uses), which refuses a busy
 *  chat with its own real reason ("composer refused: ...") instead of silently degrading to a
 *  queue add — headless queueing is permanently off (server/src/headless-policy.ts), so there is
 *  no queue to degrade into any more. That real reason is exactly what surfaces here.
 */
function actionErrorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : t('composer.sendFailedFallback')
}

/**
 * Deliver the message into each target's own desktop chat — the one path that still works (AH-12).
 * This used to create a queue item first (`createFor` -> POST /api/queue) and, for an idle target,
 * also dispatch it (`runQueueItem`). Both endpoints refuse unconditionally now: AgentHydra never
 * runs a chat nobody can see (headless-policy.ts), so POST /api/queue 409s before it even looks at
 * the body. There is no more "send now" vs "queue for later" distinction to offer — sending IS the
 * only thing this control can do, and it always means "right now, into the chat itself".
 */
async function submit() {
  if (!canSend.value) return
  sending.value = true
  let sent = 0
  const failures: string[] = []
  try {
    for (const target of props.targets) {
      try {
        await api.sendSessionMessage(target.session_id, text.value)
        sent++
      } catch (e) {
        failures.push(actionErrorText(e))
      }
    }
  } finally {
    sending.value = false
  }
  if (failures.length) {
    // One failure: the real error text IS the actionable message. Several: lead with the first
    // real reason and still say how many others failed, rather than a bare count on its own.
    toast.error(
      failures.length === 1 ? failures[0] : t('composer.toastFailed', { n: failures.length }),
      failures.length > 1 ? { description: failures[0] } : undefined,
    )
  }
  // Nothing delivered: leave the prompt exactly as the user left it — clearing it here would
  // lose their message on a total failure.
  if (!sent) return

  text.value = ''
  toast.success(t('composer.toastSent', { n: sent }))
  emit('sent', 'now')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  submit()
}

function downloadContextPack(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function handoffToChatGpt() {
  const target = single.value
  if (!target || !canHandoff.value) return

  // Open synchronously from the user's click so popup blockers do not mistake the new tab for an
  // unsolicited async popup. The pack generation remains local; nothing is submitted for them.
  window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer')
  handingOff.value = true
  try {
    const pack = await api.createChatGptContextPack(target.cwd, text.value)
    downloadContextPack(pack.filename, pack.content)

    let copied = false
    try {
      await navigator.clipboard.writeText(pack.prompt)
      copied = true
    } catch {
      // The attachment carries the task too, so a denied clipboard does not lose the handoff.
    }
    toast.success(
      copied ? t('composer.chatGptReady') : t('composer.chatGptReadyWithoutClipboard'),
      {
        description:
          pack.warnings.length > 0
            ? pack.warnings.join(' ')
            : t('composer.chatGptAttachHint', { files: pack.includedFiles.length }),
      },
    )
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t('composer.chatGptHandoffFailed'))
  } finally {
    handingOff.value = false
  }
}
</script>

<template>
  <div class="bg-background">
    <div class="mx-auto w-full max-w-3xl px-4 py-3">
      <!-- multi-target banner -->
      <!-- count only: the joined titles always overflowed and truncated into noise -->
      <div
        v-if="targets.length > 1"
        class="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <UsersRound class="size-3.5 text-primary" />
        <span class="font-medium text-foreground">{{ $t('composer.sendingToN', { n: targets.length }) }}</span>
      </div>

      <!-- bg-input (solid), not bg-input/10: this wrapper IS the composer box, so it carries the
           same raised surface + outline as every other text field. The Textarea inside stays
           transparent. -->
      <div class="rounded-xl border border-border bg-input focus-within:border-ring">
        <Textarea
          v-model="text"
          class="max-h-48 min-h-12 border-0 bg-transparent px-3 pt-2.5 focus-visible:ring-0 dark:bg-transparent"
          :placeholder="
            targets.length > 1
              ? $t('composer.placeholderMulti', { n: targets.length })
              : $t('composer.placeholder')
          "
          @keydown="onKeydown"
        />

        <!-- AH-12: this used to be a row of override chips (model/effort/permission/account/cwd)
             plus a split Send/Queue button. Every one of those chips configured a queued `claude
             --resume` run, and queueing is permanently refused now (headless-policy.ts) — a chip
             nobody can act on is worse than no chip, so they're gone rather than left inert. What
             remains actually does something: hand off to ChatGPT, or send into the chat itself. -->
        <div class="@container/composer flex items-center justify-end gap-1 px-2 pb-2">
          <IconTooltip
            v-if="chatGptHandoffEnabled && single"
            :label="$t('composer.chatGptHandoff')"
            :description="$t('composer.chatGptHandoffHint')"
          >
            <Button
              variant="outline"
              size="sm"
              :disabled="!canHandoff"
              :aria-label="$t('composer.chatGptHandoff')"
              @click="handoffToChatGpt"
            >
              <ExternalLink />
              <span class="hidden @md/composer:inline">{{ $t('composer.chatGptHandoff') }}</span>
            </Button>
          </IconTooltip>

          <IconTooltip :label="$t('composer.send')" :description="$t('composer.sendHint')">
            <Button size="sm" :disabled="!canSend" :aria-label="$t('composer.send')" @click="submit">
              <SendHorizonal />
              <span class="hidden @md/composer:inline">{{ $t('composer.send') }}</span>
            </Button>
          </IconTooltip>
        </div>
      </div>
    </div>
  </div>
</template>
