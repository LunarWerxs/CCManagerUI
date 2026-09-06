<script setup lang="ts">
import { CalendarClock, ChevronDown, GitFork, Pencil, Plus, Sparkles, X } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SchedulePanel from '@/components/SchedulePanel.vue'
import SessionPicker from '@/components/SessionPicker.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useBuilder } from '@/composables/useBuilder'
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { useInstances } from '@/composables/useInstances'
import * as api from '@/lib/api'
import { EFFORTS, MODELS, PERMISSION_MODES } from '@/lib/format'
import { HEADLESS_QUEUEING_ENABLED } from '@/lib/headless'
import { displayName } from '@/lib/instance-appearance'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'

// open/prefill/editItem are module-scope state in useBuilder — any view can launch
// the dialog (header "New run", session resume, queue card Edit) without prop plumbing.
const { open, prefill, editItem } = useBuilder()
const emit = defineEmits<{ created: [] }>()

const { t } = useI18n()
const { accounts, refreshQueue } = useData()
// Run-as candidates are the instances the user has ALREADY signed in (Instances tab) — that's
// where accounts get added; the sqlite `accounts` rows are a legacy/headless fallback.
const { instances, refreshInstances } = useInstances()
const { cliInstances, refreshCliInstances } = useCliInstances()

const form = reactive({
  new_chat: false,
  session_ids: [] as string[],
  title: '',
  cwd: '',
  prompt: '',
  model: '',
  effort: '',
  permission_mode: '',
  account_id: '',
  fork: false,
  not_before_local: '',
})
const submitting = ref(false)
const error = ref<string | null>(null)
const advancedOpen = ref(false)

const editing = computed(() => !!editItem.value)
// Multi-select resume is a create-only convenience: editing acts on one existing item.
const multiSession = computed(() => !editing.value && !form.new_chat)
// AH-12: creating a NEW queue item always 409s (headless-policy.ts), whether it would resume an
// existing session or mint a fresh one — dispatch never gets far enough to care which. Editing an
// existing item is a plain PATCH (title/cwd/prompt/etc.) and stays real: it just can never be
// followed by a run. So the create form only renders while editing; a fresh "New run" open shows
// why instead.
const showCreateForm = computed(() => editing.value || HEADLESS_QUEUEING_ENABLED)

// Queue dispatch is intentionally Claude-only even though the Sessions tab can now browse other
// providers. Keep a dedicated source-scoped list so changing the Sessions provider filter cannot
// empty this picker or accidentally feed a Codex/OpenCode id to the Claude dispatcher.
const queueSessions = ref<api.SessionSummary[]>([])
const byId = computed(() => new Map(queueSessions.value.map((s) => [s.session_id, s])))

/** ISO (UTC) → the local wall-clock string a datetime-local input expects. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

// --- run at ------------------------------------------------------------------
// The form still stores a local wall-clock string (submit() converts it back to ISO); the shared
// panel just deals in ISO, so this is the one conversion point.
const runAtOpen = ref(false)
function setRunAt(iso: string) {
  form.not_before_local = toLocalInput(iso)
  runAtOpen.value = false
}
/** Empty is not "no value", it is a decision: run it whenever the scheduler gets to it. Say so
 *  rather than leaving the trigger blank. */
const runAtLabel = computed(() => {
  if (!form.not_before_local) return t('scheduler.scheduleNotSet')
  const ms = Date.parse(form.not_before_local)
  if (!Number.isFinite(ms)) return form.not_before_local
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
})

/** Raw run-as value seeded from an edit target (instance_ref/account_id) — see the watch below.
 *  Null outside of editing, or when the edited item runs Ambient. Remembered so accountOptions
 *  can tell "genuinely Ambient" apart from "was pinned to something that's since disappeared". */
const seededRunAsRef = ref<string | null>(null)

// keyed on [open, editItem] so switching straight from one card's Edit to another
// (or Edit → New run) re-prefills even while the dialog is already open
watch([open, editItem], ([isOpen]) => {
  if (!isOpen) return
  error.value = null
  advancedOpen.value = false
  // The run-as options come from the live instance lists, which only self-populate on the
  // Instances tab — refresh here so the picker is complete even if that tab was never opened.
  void refreshInstances()
  void refreshCliInstances({ silent: true })
  void api
    .getSessions(500, '', 'hide', 'all', 'claude')
    .then((rows) => {
      queueSessions.value = rows
    })
    .catch(() => {
      // The form still opens and reports any actual submit failure; a transient list refresh
      // should not discard a previously loaded picker.
    })
  const it = editItem.value
  if (it) {
    form.new_chat = it.new_chat
    form.session_ids = it.session_id ? [it.session_id] : []
    form.title = it.title
    form.cwd = it.cwd
    form.prompt = it.prompt
    form.model = it.model ?? ''
    form.effort = it.effort ?? ''
    form.permission_mode = it.permission_mode ?? ''
    // One picker field carries both shapes: a prefixed instance ref wins over a legacy account id.
    form.account_id = it.instance_ref ?? it.account_id ?? ''
    seededRunAsRef.value = form.account_id || null
    form.fork = it.fork
    form.not_before_local = toLocalInput(it.not_before)
    return
  }
  seededRunAsRef.value = null
  const p = prefill.value ?? {}
  form.new_chat = p.new_chat ?? false
  form.session_ids = p.session_id ? [p.session_id] : []
  form.title = p.title ?? ''
  form.cwd = p.cwd ?? ''
  form.prompt = form.new_chat ? '' : 'resume'
  form.model = ''
  form.effort = ''
  form.permission_mode = ''
  form.account_id = ''
  form.fork = false
  form.not_before_local = ''
})

// Select items may not carry an empty-string value (the machinery drops them — an ''-valued
// "Ambient" option silently never rendered, so you couldn't switch BACK to Ambient), so Ambient
// gets a sentinel; '' (the pristine default) and the sentinel both mean ambient at submit.
const AMBIENT = '__ambient__'

/**
 * The same rule, for the three Advanced dropdowns — and here it does not merely drop the option,
 * it THROWS.
 *
 * Observed in the running app 2026-07-18: each `<SelectItem value="">` logged "Unhandled error
 * during execution of setup function at <SelectItem value="">", and the throw took the rest of the
 * Advanced-options subtree with it — the Model/Effort/Permission triggers and everything after them
 * simply never mounted. It went unnoticed because the visible casualties were the very Selects
 * causing it, so Advanced just looked sparse rather than broken.
 *
 * Model/effort/permission still store '' for "default", so the sentinel is swapped in and out at
 * the binding rather than changing what submit() sends.
 */
const DEFAULT_OPT = '__default__'
type DefaultableField = 'model' | 'effort' | 'permission_mode'
function defaultableModel(key: DefaultableField) {
  return computed({
    get: () => form[key] || DEFAULT_OPT,
    set: (v: string) => {
      form[key] = v === DEFAULT_OPT ? '' : v
    },
  })
}
const modelChoice = defaultableModel('model')
const effortChoice = defaultableModel('effort')
const permissionChoice = defaultableModel('permission_mode')

// Run-as options, in preference order: Ambient, then every signed-in instance (Desktop rows are
// the account rows; a CLI instance LINKED to one is the same account and would be a duplicate
// entry, so only unlinked CLI logins appear), then any legacy pasted credentials. Instance values
// are prefixed ('desktop:<dir>' / 'cli:<id>'); a bare uuid is a sqlite accounts row.
const resolvedAccountOptions = computed<
  Array<{ value: string; label: string; disabled?: boolean }>
>(() => [
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
  ...accounts.value.map((a) => ({
    value: a.id,
    label: `${a.label} · ${a.auth_type === 'api_key' ? t('builder.accountAuthApiKey') : t('builder.accountAuthOauth')}`,
  })),
])

/** Strip the picker's internal prefix so a dead ref reads as what the user actually set up
 *  (a folder, an id) rather than leaking the 'desktop:'/'cli:' storage detail. */
function refDisplay(ref: string): string {
  if (ref.startsWith('desktop:')) return ref.slice('desktop:'.length)
  if (ref.startsWith('cli:')) return ref.slice('cli:'.length)
  return ref
}

// Editing an item whose pinned instance/account was since deleted: the seeded value has no
// matching entry above, so the Select would otherwise show nothing selected (reading as the
// Ambient placeholder) — and hitting Save then quietly switches the run to Ambient with no
// indication anything changed. Surface it instead: append a disabled option carrying the dead
// ref, so the picker shows exactly what's selected — and that it's gone — rather than going
// blank. (If the ref resolves after a later instance refresh, this entry is superseded by the
// real one above and disappears on its own.)
const accountOptions = computed(() => {
  const base = resolvedAccountOptions.value
  const ref = seededRunAsRef.value
  if (!ref || base.some((o) => o.value === ref)) return base
  return [
    ...base,
    {
      value: ref,
      label: t('builder.accountDeletedInstance', { ref: refDisplay(ref) }),
      disabled: true,
    },
  ]
})

const canSubmit = computed(() => {
  if (!form.prompt.trim()) return false
  if (form.new_chat) return !!form.title.trim() && !!form.cwd.trim()
  return form.session_ids.length > 0
})

/** For a resume item, fall back to the picked session's own title/cwd when not overridden. */
function resolveTitleCwd(sessionId: string): { title: string; cwd: string } {
  const s = byId.value.get(sessionId)
  // In single-select the override fields apply; in multi each session keeps its own.
  const singleOverride = form.session_ids.length === 1
  return {
    title: (singleOverride && form.title.trim()) || s?.title || t('builder.untitledRun'),
    cwd: (singleOverride && form.cwd.trim()) || s?.cwd || '',
  }
}

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  error.value = null
  const not_before = form.not_before_local ? new Date(form.not_before_local).toISOString() : null
  // Split the one picker value back into its two storage shapes (see accountOptions).
  const runAs = form.account_id === AMBIENT ? '' : form.account_id
  const isInstanceRef = runAs.startsWith('desktop:') || runAs.startsWith('cli:')
  const shared = {
    prompt: form.prompt,
    model: form.model || null,
    effort: (form.effort || null) as api.EffortLevel | null,
    permission_mode: (form.permission_mode || null) as api.PermissionMode | null,
    account_id: !runAs || isInstanceRef ? null : runAs,
    instance_ref: isInstanceRef ? runAs : null,
    not_before,
  }
  try {
    if (editItem.value) {
      await api.updateQueueItem(editItem.value.id, {
        ...shared,
        session_id: form.session_ids[0] || undefined,
        title: form.title.trim() || t('builder.untitledRun'),
        cwd: form.cwd.trim(),
        new_chat: form.new_chat,
        fork: form.fork,
      })
    } else if (form.new_chat) {
      await api.createQueueItem({
        ...shared,
        session_id: undefined,
        title: form.title.trim(),
        cwd: form.cwd.trim(),
        new_chat: true,
        fork: false,
      })
    } else {
      // resume: one queued run per selected session, each using its own title/cwd
      for (const id of form.session_ids) {
        const { title, cwd } = resolveTitleCwd(id)
        await api.createQueueItem({
          ...shared,
          session_id: id,
          title,
          cwd,
          new_chat: false,
          fork: form.fork,
        })
      }
    }
    await refreshQueue()
    emit('created')
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-[660px]">
      <DialogHeader>
        <DialogTitle>{{ editing ? $t('builder.editDialogTitle') : $t('builder.dialogTitle') }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <!-- AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts) — creating a
             NEW queue item 409s unconditionally, whatever it would resume or start. Editing an
             existing item is a plain PATCH and still works (it just can never be followed by a
             run), so the create form below only renders while editing an existing row. -->
        <div v-if="!showCreateForm" class="flex flex-col items-center gap-2 py-6 text-center">
          <CalendarClock class="size-8 text-muted-foreground opacity-40" />
          <p class="text-sm font-medium">{{ $t('builder.createUnavailableTitle') }}</p>
          <p class="max-w-sm text-xs text-muted-foreground">{{ $t('builder.createUnavailableBody') }}</p>
        </div>

        <!-- mode toggle: create-only. Editing an existing item never converts it to/from
             a from-scratch run, so the switch is hidden there (owner request). -->
        <div
          v-if="showCreateForm && !editing"
          class="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
        >
          <Sparkles class="size-4 text-primary" />
          <div class="flex-1">
            <div class="text-sm font-medium">{{ $t('builder.newChatTitle') }}</div>
            <div class="text-xs text-muted-foreground">{{ $t('builder.newChatHelper') }}</div>
          </div>
          <Switch v-model="form.new_chat" />
        </div>

        <!-- resume: searchable session picker (multi in create, single in edit) -->
        <div v-if="showCreateForm && !form.new_chat" class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.sessionToResumeLabel') }}</label>
          <SessionPicker
            v-model="form.session_ids"
            :multiple="multiSession"
            :sessions="queueSessions"
          />
        </div>

        <!-- new chat: title + cwd are the core inputs -->
        <div v-if="showCreateForm && form.new_chat" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.titleLabel') }}</label>
            <Input v-model="form.title" :placeholder="$t('builder.titlePlaceholder')" />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.cwdLabel') }}</label>
            <Input v-model="form.cwd" :placeholder="$t('builder.cwdPlaceholder')" class="font-mono text-xs" />
          </div>
        </div>

        <div v-if="showCreateForm" class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.promptLabel') }}</label>
          <Textarea v-model="form.prompt" class="max-h-56 min-h-24" :placeholder="$t('builder.promptPlaceholder')" />
        </div>

        <!-- Account stays in the core view (not Advanced): it's the "which login this run uses"
             choice and people want it up front. "Ambient" = whatever the CLI is already signed
             into; specific accounts are the instances signed in via the Instances tab. -->
        <div v-if="showCreateForm" class="space-y-1.5">
          <label class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {{ $t('builder.accountLabel') }}
            <InfoHint :text="$t('builder.accountHint')" />
          </label>
          <Select v-model="form.account_id">
            <SelectTrigger class="w-full"><SelectValue :placeholder="$t('builder.accountAmbient')" /></SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="o in accountOptions"
                :key="o.value"
                :value="o.value"
                :disabled="o.disabled"
              >{{ o.label }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Run at: the composer's flyout (In 5 hours / Tomorrow HH:MM / steppers / date picker),
             not the bare datetime-local box this used to be. Typing a full wall-clock date to say
             "in a few hours" was the long way round, and the composer had already solved it.

             Promoted out of Advanced for the same stated reason Account sits out here: WHEN a run
             happens is a decision people make up front, not a tuning knob you go looking for. -->
        <div v-if="showCreateForm" class="space-y-1.5">
          <label class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {{ $t('builder.runAtLabel') }}
            <InfoHint :text="$t('builder.runAtHint')" />
          </label>
          <div class="flex items-center gap-1.5">
            <Popover v-model:open="runAtOpen">
              <PopoverTrigger as-child>
                <Button variant="outline" size="sm" class="flex-1 justify-start font-normal">
                  <CalendarClock />
                  <span :class="form.not_before_local ? '' : 'text-muted-foreground'">
                    {{ runAtLabel }}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-64 p-3">
                <SchedulePanel
                  :confirm-label="$t('scheduler.scheduleUseTime')"
                  @pick="setRunAt"
                  @close="runAtOpen = false"
                />
              </PopoverContent>
            </Popover>
            <!-- unset is a real choice here (run as soon as the scheduler can), so it needs a
                 control; the composer has no equivalent because not scheduling means "send now" -->
            <Button
              v-if="form.not_before_local"
              variant="ghost"
              size="sm"
              :title="$t('scheduler.scheduleClear')"
              @click="form.not_before_local = ''"
            >
              <X />
            </Button>
          </div>
        </div>

        <!-- everything else is advanced: hidden by default so the common path stays short -->
        <button
          v-if="showCreateForm"
          type="button"
          class="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          @click="advancedOpen = !advancedOpen"
        >
          {{ $t('builder.advancedOptions') }}
          <ChevronDown class="size-4 transition-transform duration-200" :class="advancedOpen ? 'rotate-180' : ''" />
        </button>
        <ExpandTransition :open="showCreateForm && advancedOpen">
          <div class="space-y-4 pt-1">
            <!-- resume: optional title/cwd overrides (single select only) -->
            <div v-if="!form.new_chat && form.session_ids.length === 1" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.titleOverrideLabel') }}</label>
                <Input v-model="form.title" :placeholder="$t('builder.titleOverridePlaceholder')" />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.cwdOverrideLabel') }}</label>
                <Input v-model="form.cwd" :placeholder="$t('builder.cwdOverridePlaceholder')" class="font-mono text-xs" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.modelLabel') }}</label>
                <Select v-model="modelChoice">
                  <SelectTrigger class="w-full"><SelectValue :placeholder="$t('builder.defaultPlaceholder')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="DEFAULT_OPT">{{ $t('builder.defaultPlaceholder') }}</SelectItem>
                    <SelectItem v-for="o in MODELS.filter((o) => o.value)" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.effortLabel') }}</label>
                <Select v-model="effortChoice">
                  <SelectTrigger class="w-full"><SelectValue :placeholder="$t('builder.defaultPlaceholder')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="DEFAULT_OPT">{{ $t('builder.defaultPlaceholder') }}</SelectItem>
                    <SelectItem v-for="o in EFFORTS.filter((o) => o.value)" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('builder.permissionLabel') }}</label>
                <Select v-model="permissionChoice">
                  <SelectTrigger class="w-full"><SelectValue :placeholder="$t('builder.defaultPlaceholder')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="DEFAULT_OPT">{{ $t('builder.defaultPlaceholder') }}</SelectItem>
                    <SelectItem v-for="o in PERMISSION_MODES.filter((o) => o.value)" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <label v-if="!form.new_chat" class="flex cursor-pointer items-center gap-2.5 text-sm">
              <Switch v-model="form.fork" />
              <GitFork class="size-4 text-muted-foreground" />
              {{ $t('builder.forkLabel') }}
            </label>
          </div>
        </ExpandTransition>

        <p v-if="showCreateForm && error" class="text-xs text-destructive">{{ error }}</p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">
          {{ showCreateForm ? $t('builder.cancel') : $t('builder.close') }}
        </Button>
        <Button v-if="showCreateForm" :disabled="!canSubmit || submitting" @click="submit">
          <Pencil v-if="editing" /><Plus v-else />
          {{ editing ? $t('builder.saveChanges') : $t('builder.addToQueue') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
