<script setup lang="ts">
import {
  CalendarClock,
  ChevronDown,
  Cpu,
  ExternalLink,
  FolderGit2,
  Gauge,
  ListPlus,
  SendHorizonal,
  ShieldCheck,
  UserCircle2,
  UsersRound,
} from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import SchedulePanel from '@/components/SchedulePanel.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useAppSettings } from '@/composables/useAppSettings'
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { useInstances } from '@/composables/useInstances'
import { usePanels } from '@/composables/usePanels'
import * as api from '@/lib/api'
import { baseName, EFFORTS, MODELS, PERMISSION_MODES } from '@/lib/format'
import { displayName } from '@/lib/instance-appearance'
import IconTooltip from '@/shell/IconTooltip.vue'

export interface ComposerTarget {
  session_id: string
  title: string
  cwd: string
  /** Desktop instance the session belongs to ("default" | instance dir name), when known. Display
   *  only — the server resolves the run's actual credentials from the session id itself. */
  instance?: string | null
}

const props = defineProps<{ targets: ComposerTarget[] }>()
const emit = defineEmits<{ sent: [mode: 'now' | 'queued'] }>()

const { t } = useI18n()
const { queue, accounts, scheduler, refreshQueue } = useData()
const { instances, refreshInstances } = useInstances()
const { cliInstances, refreshCliInstances } = useCliInstances()
const { queueOpen } = usePanels()
const { chatGptHandoffEnabled, load: loadAppSettings } = useAppSettings()
onMounted(() => {
  void loadAppSettings()
  // Both lists are shared singletons that otherwise only populate on the Instances tab; the run-as
  // chip has to be able to name an account without that tab ever being opened.
  void refreshInstances({ silent: true })
  void refreshCliInstances({ silent: true })
})

const text = ref('')
const model = ref('')
const effort = ref('')
const permission = ref('')
const cwdOverride = ref('')
const sending = ref(false)

const single = computed(() => (props.targets.length === 1 ? props.targets[0] : null))

// the cwd override is a per-session choice — never let it silently follow a selection change
watch(
  () => single.value?.session_id,
  () => {
    cwdOverride.value = ''
  },
)

// A session with a RUNNING queue run can't take a second concurrent `claude --resume`
// against the same transcript — "send now" to it degrades to a plain queue add.
const runningIds = computed(
  () => new Set(queue.value.filter((q) => q.status === 'running').map((q) => q.session_id)),
)
const anyBusy = computed(() => props.targets.some((tg) => runningIds.value.has(tg.session_id)))

/**
 * The busy hint is a warning about the message you are TYPING — so it only shows while there is
 * one. Without the text gate it fired on your own message the instant you sent it: submit() awaits
 * refreshQueue(), and the server doesn't answer until dispatchItem has already written
 * status='running', so `anyBusy` flips true inside the very same click that sent it. The banner
 * then announced "your message will queue and start on its own" about a message that had just
 * started running immediately — reading as a flat lie when nothing had been running at all.
 *
 * Gating on `text` fixes it because submit() clears the text in the same synchronous stretch as the
 * refresh, so Vue renders both facts at once and the hint never appears for the message just sent.
 * (That ordering is load-bearing: clearing `text` earlier — say, optimistically before the awaits —
 * would let the flash back in.) It still shows in the case that is actually useful: typing a NEW
 * message while a run really is in flight.
 */
const showBusyHint = computed(() => anyBusy.value && !!text.value.trim())

// --- run-as -------------------------------------------------------------------
//
// Which login does this message go out under? It matters more here than anywhere else in the app:
// every desktop instance is a DIFFERENT Anthropic account, but all of them write transcripts to the
// same `~/.claude/projects` store, so a resume that doesn't say runs on whatever the ambient CLI
// login happens to be — a different account than the chat itself was talking to. That is how a
// weekly-limit wall shows up for an account sitting at 22%.
//
// AUTO ('' — the default) sends no run-as at all, which the server reads as "resolve it from the
// session" and pins the desktop instance the chat belongs to. The picker exists for the cases the
// session can't answer: a plain CLI transcript, or deliberately running someone else's login.
const AUTO = ''
/** Explicitly unpinned. Distinct from AUTO: null-on-the-wire already means "nobody said", so
 *  choosing the ambient CLI login on purpose needs a value the server can tell apart. */
const AMBIENT = api.AMBIENT_RUN_AS
const runAs = ref(AUTO)

/** The instance the AUTO option will resolve to, named the way the Sessions list names it. Only
 *  meaningful for a single target — a multi-send can span instances, and each one resolves on its
 *  own server-side. */
const autoInstanceLabel = computed(() => {
  const label = single.value?.instance
  if (!label) return null
  if (label === 'default') return t('sessions.instanceDefault')
  const inst = instances.value.find((i) => i.name === label)
  return inst ? displayName(inst) : label
})

const accountOptions = computed(() => [
  {
    value: AUTO,
    label: autoInstanceLabel.value
      ? t('composer.accountAutoNamed', { instance: autoInstanceLabel.value })
      : t('composer.accountAuto'),
  },
  { value: AMBIENT, label: t('builder.accountAmbient') },
  ...instances.value
    .filter((i) => i.account?.email)
    .map((i) => ({
      value: `desktop:${i.dir}`,
      label: `${displayName(i)} · ${t('builder.accountDesktopInstance')}`,
    })),
  ...cliInstances.value
    .filter((c) => c.loggedIn && !c.associatedDesktopDir)
    .map((c) => ({
      value: `cli:${c.id}`,
      label: `${c.name} · ${t('builder.accountCliInstance')}`,
    })),
  ...accounts.value.map((a) => ({ value: a.id, label: a.label })),
])

/** Split the one picker value into the two fields the API stores. AUTO sends NEITHER, which is what
 *  triggers the server-side resolve; anything else is an explicit choice and is sent as-is. */
const runAsFields = computed<{ account_id: string | null; instance_ref: string | null }>(() => {
  const v = runAs.value
  if (v === AUTO) return { account_id: null, instance_ref: null }
  if (v === AMBIENT || v.startsWith('desktop:') || v.startsWith('cli:'))
    return { account_id: null, instance_ref: v }
  return { account_id: v, instance_ref: null }
})

const canSend = computed(() => !!text.value.trim() && props.targets.length > 0 && !sending.value)
const handingOff = ref(false)
const canHandoff = computed(() => !!text.value.trim() && !!single.value && !handingOff.value)

// chips: label falls back to the dimension name while the value is "default"
const chipLabel = (value: string, options: { value: string; label: string }[], fallback: string) =>
  value ? (options.find((o) => o.value === value)?.label ?? value) : fallback

function titleFor(target: ComposerTarget): string {
  return target.title || text.value.trim().slice(0, 60)
}

function createFor(target: ComposerTarget, notBefore: string | null) {
  return api.createQueueItem({
    session_id: target.session_id,
    title: titleFor(target),
    cwd: (single.value ? cwdOverride.value.trim() : '') || target.cwd,
    prompt: text.value,
    model: model.value || null,
    effort: (effort.value || null) as api.EffortLevel | null,
    permission_mode: (permission.value || null) as api.PermissionMode | null,
    ...runAsFields.value,
    new_chat: false,
    fork: false,
    not_before: notBefore,
  })
}

/** AH-26: show the server's real reason a send failed (bad cwd, stale session, a run the daemon
 *  refused) instead of reducing every failure to a bare count — the count alone gave no way to
 *  tell what to fix, and made a genuinely broken send look identical to a transient one. */
function actionErrorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : t('composer.sendFailedFallback')
}

async function submit(mode: 'now' | 'queue', notBefore: string | null = null) {
  if (!canSend.value) return
  sending.value = true
  let started = 0
  let queued = 0
  const failures: string[] = []
  try {
    for (const target of props.targets) {
      let item: api.QueueItem
      try {
        item = await createFor(target, notBefore)
      } catch (e) {
        failures.push(actionErrorText(e))
        continue
      }
      if (mode === 'now' && !runningIds.value.has(target.session_id)) {
        try {
          await api.runQueueItem(item.id)
          started++
        } catch {
          // the server holds a per-session run lock (409 when a run raced us in) —
          // the item was still created, so it's queued, not failed
          queued++
        }
      } else {
        queued++
      }
    }
  } finally {
    sending.value = false
  }
  await refreshQueue()
  if (failures.length) {
    // One failure: the real error text IS the actionable message. Several: lead with the first
    // real reason and still say how many others failed, rather than a bare count on its own.
    toast.error(
      failures.length === 1 ? failures[0] : t('composer.toastFailed', { n: failures.length }),
      failures.length > 1 ? { description: failures[0] } : undefined,
    )
  }
  // Not confirmed (nothing started or queued): leave the prompt exactly as the user left it —
  // clearing it here would lose their message on a total failure.
  if (!started && !queued) return

  text.value = ''
  scheduleOpen.value = false
  const message =
    started && queued
      ? t('composer.toastMixed', { ran: started, queued })
      : started
        ? t('composer.toastStarted', { n: started })
        : t('composer.toastQueued', { n: queued })
  const idleQueued = queued > 0 && !scheduler.value?.enabled
  toast.success(message, {
    description: idleQueued ? t('composer.schedulerOffHint') : undefined,
    action: { label: t('composer.viewQueue'), onClick: () => (queueOpen.value = true) },
  })
  emit('sent', started ? 'now' : 'queued')
}

// --- queue-for-later popover --------------------------------------------------
// The controls live in SchedulePanel.vue (shared with the queue builder); all this surface owns is
// whether the popover is open. submit() clears it on a successful send.
const scheduleOpen = ref(false)

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  // Ctrl/Cmd+Enter always queues; plain Enter sends (busy targets self-queue in submit)
  submit(e.ctrlKey || e.metaKey ? 'queue' : 'now')
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
    const cwd = cwdOverride.value.trim() || target.cwd
    const pack = await api.createChatGptContextPack(cwd, text.value)
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
      <p v-if="showBusyHint" class="mb-2 text-xs text-warning">
        {{ scheduler?.enabled ? $t('composer.busyHintAuto') : $t('composer.busyHintManual') }}
      </p>

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

        <!-- Option chips (left) + actions (right), Claude-composer style.
             This composer only ever CONTINUES an existing session (createFor sends new_chat:false),
             so the run settings are overrides on top of what the chat already uses, and the common
             case is that none of them are set. A row of chips reading "Model · Effort ·
             Permissions" therefore spent its width naming dimensions rather than stating facts, and
             on a narrow pane it wrapped onto a second line. Each one is now an icon while it is at
             the default and only grows a label once you actually override it, so the row reads as
             "what did I change", with the rich tooltip carrying the name and the explanation. The
             new-chat surface (the queue builder) keeps its full labels — there, nothing is inherited
             and every dimension is a decision you are making.
             `@container/composer` so the compaction follows the PANE, not the viewport: the
             sessions sidebar is drag-resizable, so a wide window can still leave this box narrow. -->
        <div class="@container/composer flex flex-wrap items-center gap-1 px-2 pb-2">
          <!-- Every popper root sits INSIDE its IconTooltip, wrapped in a plain element for the
               tooltip to anchor to — see scripts/checks/reka-popper-root-inside-tooltip.mjs. -->
          <IconTooltip :label="$t('composer.chipModel')" :description="$t('composer.chipModelHint')">
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    :size="model ? 'xs' : 'icon-xs'"
                    :class="model ? 'text-foreground' : 'text-muted-foreground'"
                    :aria-label="$t('composer.chipModel')"
                  >
                    <Cpu />
                    <span v-if="model">{{ chipLabel(model, MODELS, $t('composer.chipModel')) }}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup v-model="model">
                    <DropdownMenuRadioItem value="">{{ $t('composer.clearOption') }}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem v-for="o in MODELS.filter((o) => o.value)" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>

          <IconTooltip :label="$t('composer.chipEffort')" :description="$t('composer.chipEffortHint')">
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    :size="effort ? 'xs' : 'icon-xs'"
                    :class="effort ? 'text-foreground' : 'text-muted-foreground'"
                    :aria-label="$t('composer.chipEffort')"
                  >
                    <Gauge />
                    <span v-if="effort">{{ chipLabel(effort, EFFORTS, $t('composer.chipEffort')) }}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup v-model="effort">
                    <DropdownMenuRadioItem value="">{{ $t('composer.clearOption') }}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem v-for="o in EFFORTS.filter((o) => o.value)" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>

          <IconTooltip :label="$t('composer.chipPermission')" :description="$t('composer.chipPermissionHint')">
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    :size="permission ? 'xs' : 'icon-xs'"
                    :class="permission ? 'text-foreground' : 'text-muted-foreground'"
                    :aria-label="$t('composer.chipPermission')"
                  >
                    <ShieldCheck />
                    <span v-if="permission">{{ chipLabel(permission, PERMISSION_MODES, $t('composer.chipPermission')) }}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup v-model="permission">
                    <DropdownMenuRadioItem value="">{{ $t('composer.clearOption') }}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem v-for="o in PERMISSION_MODES.filter((o) => o.value)" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>

          <!-- Run-as. Always shown (not gated on legacy accounts existing): which account a resume
               goes out under is the difference between it working and hitting someone else's wall,
               so it has to be visible and changeable even when every login is an instance. Unlike
               the three above it names a FACT rather than an override, so it keeps its label
               wherever there is room and only drops to the icon on a genuinely narrow pane. -->
          <IconTooltip :label="$t('composer.chipAccount')" :description="$t('composer.chipAccountHint')">
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="xs"
                    class="max-w-40"
                    :class="runAs ? 'text-foreground' : 'text-muted-foreground'"
                    :aria-label="$t('composer.chipAccount')"
                  >
                    <UserCircle2 />
                    <span class="hidden truncate @lg/composer:inline">
                      {{ runAs ? chipLabel(runAs, accountOptions, $t('composer.chipAccount')) : (autoInstanceLabel ?? $t('composer.chipAccount')) }}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" class="max-h-80 overflow-y-auto">
                  <DropdownMenuRadioGroup v-model="runAs">
                    <DropdownMenuRadioItem v-for="o in accountOptions" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>

          <!-- cwd override: single target only (multi always uses each session's own dir) -->
          <IconTooltip
            v-if="single"
            :label="$t('composer.cwdPopoverLabel')"
            :description="cwdOverride.trim() || single.cwd"
          >
            <span class="inline-flex">
              <Popover>
                <PopoverTrigger as-child>
                  <Button
                    variant="ghost"
                    size="xs"
                    class="max-w-40"
                    :class="cwdOverride.trim() ? 'text-foreground' : 'text-muted-foreground'"
                    :aria-label="$t('composer.cwdPopoverLabel')"
                  >
                    <FolderGit2 />
                    <span class="hidden truncate @lg/composer:inline">{{ baseName(cwdOverride.trim() || single.cwd) }}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" class="w-96 space-y-1.5 p-3">
                  <label class="text-xs font-medium text-muted-foreground">{{ $t('composer.cwdPopoverLabel') }}</label>
                  <Input v-model="cwdOverride" :placeholder="single.cwd" class="font-mono text-xs" />
                  <p class="text-[11px] text-muted-foreground">{{ $t('composer.cwdPopoverHint') }}</p>
                </PopoverContent>
              </Popover>
            </span>
          </IconTooltip>

          <!-- Action labels drop before the chips do: Send and Queue keep their position and their
               icons, so losing the word costs nothing, whereas a chip with no label AND no value
               would say nothing at all. -->
          <div class="ml-auto flex items-center gap-1">
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

            <!-- Queue: a SPLIT button, and which half is which is the point. "Queue" used to fire
                 immediately while the schedule popover hid behind a separate calendar icon, so
                 reaching for "queue this for 3am" landed on "queue it right now" — the two actions
                 looked equally primary and read the same. Now the labelled half opens the time
                 picker (the deliberate act), and the instant one is a menu item behind the chevron
                 (the shortcut). Same two actions, ranked. -->
            <div class="flex items-center">
              <IconTooltip
                :label="$t('composer.queue')"
                :description="$t('composer.queueForLater')"
              >
                <span class="inline-flex">
                  <Popover v-model:open="scheduleOpen">
                    <PopoverTrigger as-child>
                      <Button
                        variant="outline"
                        size="sm"
                        class="rounded-r-none border-r-0"
                        :disabled="!canSend"
                        :aria-label="$t('composer.queueForLater')"
                      >
                        <CalendarClock />
                        <span class="hidden @md/composer:inline">{{ $t('composer.queue') }}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" class="w-64 p-3">
                      <!-- The panel itself is shared with the queue builder (SchedulePanel.vue);
                           this surface's job is only to say what a picked time MEANS here: queue the
                           message currently in the box for then. -->
                      <SchedulePanel @pick="submit('queue', $event)" @close="scheduleOpen = false" />
                    </PopoverContent>
                  </Popover>
                </span>
              </IconTooltip>

              <IconTooltip :label="$t('composer.queueMoreHint')">
                <span class="inline-flex">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        class="rounded-l-none border-l"
                        :disabled="!canSend"
                        :aria-label="$t('composer.queueMoreHint')"
                      >
                        <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem :disabled="!canSend" @select="submit('queue')">
                        <ListPlus /> {{ $t('composer.queueNow') }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </IconTooltip>
            </div>

            <IconTooltip :label="$t('composer.send')" :description="$t('composer.sendHint')">
              <Button size="sm" :disabled="!canSend" :aria-label="$t('composer.send')" @click="submit('now')">
                <SendHorizonal />
                <span class="hidden @md/composer:inline">{{ $t('composer.send') }}</span>
              </Button>
            </IconTooltip>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
