<script setup lang="ts">
import {
  AppWindow,
  BellRing,
  CalendarClock,
  ChevronDown,
  ClipboardCopy,
  Cloud,
  CloudCheck,
  CloudCog,
  CloudDownload,
  CloudOff,
  DatabaseZap,
  ExternalLink,
  EyeOff,
  FilePenLine,
  Gauge,
  LogOut,
  Mail,
  MessageCircleQuestion,
  Monitor,
  MonitorDown,
  Power,
  RefreshCw,
  Repeat,
  RotateCcw,
  SlidersHorizontal,
  Timer,
  User,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ProviderRows from '@/components/ProviderRows.vue'
import UsageRefreshRows from '@/components/UsageRefreshRows.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppSettings } from '@/composables/useAppSettings'
import { useData } from '@/composables/useData'
import { useMonitor } from '@/composables/useMonitor'
import { usePanels } from '@/composables/usePanels'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUpdates } from '@/composables/useUpdates'
import type { MonitorStateName, SearchIndexStatus, SyncStatus } from '@/lib/api'
import * as api from '@/lib/api'
import { type BadgeVariant, baseName, formatBytes } from '@/lib/format'
import { HEADLESS_QUEUEING_ENABLED } from '@/lib/headless'
import { composeSessionPathClipboard } from '@/lib/session-clipboard'
import { bindSignInNudgeStatus, nudgeOnSettingsChange } from '@/lib/sign-in-nudge'
import { useTheme } from '@/lib/theme'
import { useTooltipConfig } from '@/lib/tooltip-config'
import ExpandTransition from '@/shell/ExpandTransition.vue'
import InfoHint from '@/shell/InfoHint.vue'
import SettingsGroup from '@/shell/SettingsGroup.vue'
import SettingsRow from '@/shell/SettingsRow.vue'
import SettingsTabs from '@/shell/SettingsTabs.vue'

const { t } = useI18n()

// Settings is one scrolling page (the old General/Scheduler/Accounts tabs were merged —
// owner request: Accounts didn't warrant a tab, and Scheduler folded into the rest). A
// deep link (e.g. the composer's tomorrow-preset gear) now scrolls to a section instead of
// switching a tab. Section anchors are keyed by the old tab ids so callers didn't change.
// `accounts` is still read here — the auto-resume monitor's per-account overrides list them.
// Populated by useData's startPolling; nothing in this panel mutates them any more.
const { accounts, scheduler, refreshScheduler } = useData()
const { enabled: showTooltips } = useTooltipConfig()

const sectionEls = ref<Record<string, HTMLElement | null>>({})
function setSectionEl(id: string, el: unknown) {
  sectionEls.value[id] = el as { $el?: HTMLElement } | HTMLElement | null as HTMLElement | null
}

// General vs Automation (owner request 2026-08-25: the page got long and confusing, and the
// automation machinery — scheduler and auto-resume monitor — is a coherent chunk).
// Sections stay MOUNTED behind v-show per SettingsTabs' consumer rule, so open-watchers and
// deep-link section refs keep working on the hidden tab.
const settingsTab = ref<'general' | 'automation'>('general')
const settingsTabs = computed(() => [
  { id: 'general' as const, label: t('settings.tabGeneral') },
  { id: 'automation' as const, label: t('settings.tabAutomation') },
])
/** Section ids that live on the Automation tab — a deep link to one flips the tab first. */
const AUTOMATION_SECTIONS = new Set(['scheduler'])

// Which section is currently flashing after a deep link. A scroll alone lands you somewhere without
// saying WHERE — on a page of near-identical cards the arrival is ambiguous, so the target pulses
// briefly (see .settings-flash in style.css). Cleared on a timer, and re-armed if a second deep link
// arrives while the first is still running.
const flashSection = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined

const { settingsRequestedTab } = usePanels()
function consumeRequestedTab() {
  const req = settingsRequestedTab.value
  if (req) {
    // The target may live on the other tab — flip first, or scrollIntoView lands on a
    // display:none node and does nothing.
    settingsTab.value = AUTOMATION_SECTIONS.has(req) ? 'automation' : 'general'
    // Wait a tick so the section is laid out (view may be mounting fresh), then scroll to it.
    nextTick(() => {
      const el = sectionEls.value[req]
      const node = (el as { $el?: HTMLElement })?.$el ?? (el as HTMLElement | null)
      node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Re-armed from null so clicking the same deep link twice replays the animation; without the
      // reset the class never changes and the browser has no reason to run it again.
      flashSection.value = null
      clearTimeout(flashTimer)
      nextTick(() => {
        flashSection.value = req
        flashTimer = setTimeout(() => {
          flashSection.value = null
        }, 1900)
      })
    })
  }
  if (req !== null) settingsRequestedTab.value = null
}
onBeforeUnmount(() => clearTimeout(flashTimer))
watch(settingsRequestedTab, consumeRequestedTab)
onMounted(consumeRequestedTab)

// --- updates ---
const { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate, progressLabel } =
  useUpdates()
// No git remote (and no AGENTHYDRA_UPDATE_REPO) means there is nowhere to pull updates
// from: the no-source row explains it and the auto-update rows gray out.
const noUpdateSource = computed(() => !!updateStatus.value && !updateStatus.value.remote)
// The engine's `reason` is a terse internal string (e.g. "local changes must be committed or
// stashed before updating"). Shown directly as the row's description (not tucked behind an
// InfoHint icon) so "Update blocked" is never a dead end - the single most common cause (a
// dirty working tree, since the updater refuses to overwrite uncommitted local edits) is
// visible at a glance instead of requiring a hover.
const updateBlockedReason = computed(() => updateStatus.value?.reason ?? undefined)
const applyMessage = ref<string | null>(null)
const applyError = ref<string | null>(null)
const restartRequired = ref(false)

// The version number IS the update control now (owner request): it reads green when up to date,
// amber when an update is waiting, red when blocked / there is no update source. Its tooltip
// spells out the state, and clicking it re-checks (or applies a waiting update) — folding away the
// old always-visible "Up to date." / "Update available" / "Update blocked" status rows.
type UpdateState = 'checking' | 'up-to-date' | 'available' | 'blocked' | 'no-source' | 'unknown'
const updateState = computed<UpdateState>(() => {
  if (updateChecking.value || updateApplying.value) return 'checking'
  const s = updateStatus.value
  if (!s) return 'unknown'
  if (!s.remote) return 'no-source'
  if (s.updateAvailable) return s.canApply ? 'available' : 'blocked'
  return 'up-to-date'
})
const versionColorClass = computed(() => {
  switch (updateState.value) {
    case 'up-to-date':
      return 'text-success'
    case 'available':
      return 'text-warning'
    case 'blocked':
    case 'no-source':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
})
const versionTip = computed(() => {
  switch (updateState.value) {
    case 'checking':
      return t('settings.versionCheckingTip')
    case 'available':
      return t('settings.versionUpdateAvailableTip')
    case 'blocked':
      return updateBlockedReason.value
        ? `${t('settings.versionUpdateBlockedTip')} ${updateBlockedReason.value}`
        : t('settings.versionUpdateBlockedTip')
    case 'no-source':
      return `${t('settings.versionNoSourceTip')} ${t('settings.noUpdateSourceHint')}`
    default:
      return t('settings.versionUpToDateTip')
  }
})

onMounted(() => {
  checkForUpdate()
})

async function onCheckForUpdate() {
  applyMessage.value = null
  applyError.value = null
  await checkForUpdate()
}
async function onApplyUpdate() {
  applyMessage.value = null
  applyError.value = null
  try {
    const result = await applyUpdate()
    applyMessage.value = result.message
    restartRequired.value = result.restartRequired
  } catch (e) {
    applyError.value = e instanceof Error ? e.message : String(e)
  }
}
// One click, state-dependent: apply a waiting update, otherwise (re-)check for one.
async function onVersionClick() {
  if (updateChecking.value || updateApplying.value) return
  if (updateState.value === 'available') {
    await onApplyUpdate()
    return
  }
  await onCheckForUpdate()
}

// --- portable mode ---
const portableMode = ref(false)
const creatingInstanceShortcut = ref(false)
// --- hide tray icon ---
const hideTrayIcon = ref(false)

async function refreshSettings() {
  try {
    const s = await api.getSettings()
    portableMode.value = s.portableMode
    hideTrayIcon.value = s.hideTrayIcon
  } catch {
    /* keep last-known value on a failed refresh */
  }
}
onMounted(refreshSettings)

async function togglePortableMode(enabled: boolean) {
  try {
    const s = await api.updateSettings({ portableMode: enabled })
    portableMode.value = s.portableMode
  } catch {
    toast.error(t('settings.portableModeToastFailed'))
    return
  }
  if (!enabled) return
  try {
    const result = await api.openPortableWindow()
    if (result.ok) {
      toast.success(t('settings.portableModeToastOpened'))
    } else {
      toast.error(t('settings.portableModeToastNoBrowser'))
    }
  } catch {
    toast.error(t('settings.portableModeToastNoBrowser'))
  }
}

async function createQuickInstancesShortcut() {
  if (creatingInstanceShortcut.value) return
  creatingInstanceShortcut.value = true
  try {
    const result = await api.createInstanceModeShortcut()
    if (result.ok) {
      toast.success(t('settings.instanceModeShortcutCreated'))
    } else {
      toast.error(result.message ?? t('settings.instanceModeShortcutFailed'))
    }
  } catch {
    toast.error(t('settings.instanceModeShortcutFailed'))
  } finally {
    creatingInstanceShortcut.value = false
  }
}

async function toggleHideTrayIcon(enabled: boolean) {
  try {
    const s = await api.updateSettings({ hideTrayIcon: enabled })
    hideTrayIcon.value = s.hideTrayIcon
  } catch {
    toast.error(t('settings.hideTrayIconToastFailed'))
  }
}

// --- app settings this panel still owns ---------------------------------------------------------
// The usage auto-refresh rows and the provider/table switches moved into components of their own
// (UsageRefreshRows / ProviderRows) so the Instances toolbar can render the SAME controls where
// they apply; they read this composable directly. What is left here is everything with no better
// home than the settings panel.
const {
  transcriptEditor,
  transcriptEditorResolved,
  notifyEnabled,
  notifySessionReset,
  notifyWeeklyReset,
  notifyMinPct,
  notifySessionMaxWeeklyPct,
  notifyDesktop,
  notifyPersistent,
  notifyPersistentIntervalMin,
  notifyPersistentMaxRepeats,
  notifyEmail,
  notifyEmailTo,
  notifyEmailFrom,
  notifySmtpHost,
  notifySmtpPort,
  notifySmtpSecure,
  notifySmtpUser,
  notifySmtpPassSet,
  load: loadUsageSettings,
  update: updateAppSettings,
} = useAppSettings()
onMounted(loadUsageSettings)

// --- reset notifications (server/src/reset-watch.ts) --------------------------------------------
// Every control here auto-saves through the same round-trip as the rest of the panel. The SMTP
// password is the one exception to "the field shows what is stored": the server never returns it,
// so this field is always blank and an empty value on save means "keep the stored one".
async function patchNotifications(patch: api.AppSettingsPatch) {
  if (!(await updateAppSettings(patch))) toast.error(t('settings.usageToastFailed'))
}

const smtpPassDraft = ref('')
async function saveSmtpPass() {
  const value = smtpPassDraft.value
  if (!value) return
  smtpPassDraft.value = ''
  await patchNotifications({ notifySmtpPass: value })
}

const testingNotification = ref(false)
async function onTestNotification() {
  testingNotification.value = true
  try {
    const r = await api.sendTestNotification()
    if (!r.desktop.attempted && !r.email.attempted) {
      toast.info(t('notifications.testNothingEnabled'))
      return
    }
    if (r.desktop.attempted) {
      if (r.desktop.ok) toast.success(t('notifications.testDesktopOk'))
      else toast.error(t('notifications.testDesktopFailed', { error: r.desktop.error ?? '' }))
    }
    if (r.email.attempted) {
      if (r.email.ok) toast.success(t('notifications.testEmailOk'))
      else toast.error(t('notifications.testEmailFailed', { error: r.email.error ?? '' }))
    }
  } catch (err) {
    toast.error(
      t('notifications.testDesktopFailed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  } finally {
    testingNotification.value = false
  }
}

// --- transcript editor (server/src/transcript-open.ts): which editor "Open the session file"
// hands the .jsonl to, so it never hits Windows' unassociated-extension "Pick an app" dialog ---
// Collapsed by default: auto-detect is right for nearly everyone, so the path field is a
// destination you go looking for, not something the panel puts in front of you.
const editorOpen = ref(false)

// Appearance "Advanced" disclosure (mirrors the Scheduler group): tucks the tooltips toggle and
// the transcript-editor override away by default (owner request) so the section leads with the
// everyday choices.
const appearanceAdvancedOpen = ref(false)

// --- the search index, the one file we put on disk that nobody asked for ---------------------
// Shown with its real size and a delete button, because an index the user cannot see or remove is
// a very different promise from one they can. It rebuilds itself from the transcripts on the next
// search, so removing it costs time and nothing else.
const searchIndex = ref<SearchIndexStatus | null>(null)
const deletingSearchIndex = ref(false)

async function refreshSearchIndex() {
  try {
    searchIndex.value = await api.getSearchIndex()
  } catch {
    searchIndex.value = null // an unreachable daemon simply hides the row's detail
  }
}
onMounted(refreshSearchIndex)

async function removeSearchIndex() {
  deletingSearchIndex.value = true
  try {
    searchIndex.value = await api.deleteSearchIndex()
    toast.success(t('settings.searchIndexDeleted'))
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('settings.searchIndexDeleteFailed'))
  } finally {
    deletingSearchIndex.value = false
  }
}

// "Copy session file location" used to put a bare path on the clipboard. These decide what else
// goes with it; both default on, and with both off the result is byte-for-byte what it always was.
const { copyPathIncludeName, copyPathIncludePrompt, copyPathPrompt } = useUiPrefs()
const copyPathOpen = ref(false)
/** Shown live in the settings row, because the only honest way to describe a clipboard format is
 *  to display it. */
const copyPathPreview = computed(() =>
  composeSessionPathClipboard({
    path: 'C:\\Users\\you\\.claude\\projects\\my-repo\\a1b2c3d4.jsonl',
    title: 'Postal server connection setup',
    includeName: copyPathIncludeName.value,
    includePrompt: copyPathIncludePrompt.value,
    prompt: copyPathPrompt.value,
  }),
)

async function saveTranscriptEditor() {
  if (!(await updateAppSettings({ transcriptEditor: transcriptEditor.value.trim() })))
    toast.error(t('settings.transcriptEditorToastFailed'))
}
/** Back to auto-detect. Clearing the box by hand works too, but an explicit "unset this" is the
 *  only affordance that reads as reversible once a path is in there. */
async function resetTranscriptEditor() {
  transcriptEditor.value = ''
  await saveTranscriptEditor()
}
/** The typed override exists but is not what will run, i.e. the server discarded it as a dead path
 *  and fell back to auto-detect. Worth a warning: the field looks honoured but isn't. */
const editorOverrideIgnored = computed(() => {
  const typed = transcriptEditor.value.trim()
  return !!typed && !!transcriptEditorResolved.value && typed !== transcriptEditorResolved.value
})

// --- theme + cloud sync -----------------------
// The theme PICKER now lives as an icon in the settings panel header (App.vue); this composable
// stays here only so cloud sync can read/apply the theme (applyAppearance / currentAppearance).
const { mode: themeMode, setTheme } = useTheme()
const syncStatus = ref<SyncStatus>({
  ok: true,
  enabled: false,
  connected: false,
  name: null,
  email: null,
  picture: null,
  lastSyncedAt: null,
  version: 0,
  appearance: null,
})
const syncBusy = ref(false)
const syncError = ref<string | null>(null)
const confirmDisconnect = ref(false)
// Set right before applying a pulled appearance, so the theme watcher below doesn't turn
// right around and push the value it just received.
let applyingRemoteAppearance = false
let syncPushTimer: ReturnType<typeof setTimeout> | undefined

function currentAppearance(): Record<string, unknown> {
  return { theme: themeMode.value }
}
function applyAppearance(appearance: Record<string, unknown> | null | undefined) {
  if (!appearance) return
  const theme = appearance.theme
  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    applyingRemoteAppearance = true
    setTheme(theme)
    queueMicrotask(() => {
      applyingRemoteAppearance = false
    })
  }
}
function absorbSyncResult(res: api.SyncResult): api.SyncResult {
  if (res.ok) {
    syncStatus.value = res
    syncError.value = null
  } else {
    syncError.value = res.error
  }
  return res
}
async function refreshSyncStatus() {
  try {
    const s = await api.getSyncStatus()
    syncStatus.value = s
    syncError.value = null
  } catch {
    /* keep last-known value on a failed refresh */
  }
}
onMounted(refreshSyncStatus)

function goSignIn() {
  // New tab so the current app state isn't lost - the new tab lands on /?connected=1 after
  // auth; sync status here refreshes when the user returns to this tab.
  window.open('/oauth/login', '_blank', 'noopener')
}
function onWindowFocus() {
  if (!syncStatus.value.connected) void refreshSyncStatus()
}
onMounted(() => window.addEventListener('focus', onWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))

async function onToggleSyncEnable(enabled: boolean) {
  confirmDisconnect.value = false
  syncBusy.value = true
  try {
    if (enabled) {
      const res = await api.setSync({ enabled: true, appearance: currentAppearance() })
      absorbSyncResult(res)
      if (res.ok) applyAppearance(res.appearance)
    } else {
      absorbSyncResult(await api.setSync({ enabled: false }))
    }
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncBusy.value = false
  }
}
async function onSyncNow() {
  syncBusy.value = true
  try {
    const pulled = absorbSyncResult(await api.syncPull())
    if (pulled.ok) {
      applyAppearance(pulled.appearance)
      const pushed = absorbSyncResult(await api.syncPush())
      if (pushed.ok) toast.success(t('settings.cloudSyncSyncedToast'))
    }
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncBusy.value = false
  }
}
async function onDisconnect() {
  if (!confirmDisconnect.value) {
    confirmDisconnect.value = true
    return
  }
  confirmDisconnect.value = false
  syncBusy.value = true
  try {
    absorbSyncResult(await api.setSync({ enabled: false, forget: true }))
  } catch (e) {
    syncError.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncBusy.value = false
  }
}

const syncedLabel = computed(() => {
  const iso = syncStatus.value.lastSyncedAt
  if (!iso) return t('settings.cloudSyncNeverSynced')
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return t('settings.cloudSyncNeverSynced')
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 10) return t('settings.cloudSyncSyncedNow')
  const minutes = Math.round(seconds / 60)
  const hours = Math.round(minutes / 60)
  const when =
    seconds < 60
      ? t('settings.cloudSyncSecondsAgo', { n: seconds })
      : minutes < 60
        ? t('settings.cloudSyncMinutesAgo', { n: minutes })
        : t('settings.cloudSyncHoursAgo', { n: hours })
  return t('settings.cloudSyncSyncedAgo', { when })
})

// When the theme changes AND sync is enabled+connected, debounce and push - but never echo a
// value just applied from a pull/enable (applyingRemoteAppearance).
watch(themeMode, () => {
  if (applyingRemoteAppearance) return
  // NOT connected is the interesting case for the sign-in prompt, and it is exactly the branch the
  // push below discards. Someone who just changed an appearance setting is who "these follow you to
  // your other machines" is a true sentence for, and this is the same instant we WOULD have pushed
  // it. The engine says no to almost every one of these; see lib/sign-in-nudge.
  if (!syncStatus.value.connected) nudgeOnSettingsChange()
  if (!syncStatus.value.enabled || !syncStatus.value.connected) return
  clearTimeout(syncPushTimer)
  syncPushTimer = setTimeout(() => {
    void api.setSync({ appearance: currentAppearance() }).then(absorbSyncResult)
  }, 800)
})

// Point the prompt at the live connection state. Only the STATUS binds here - the session count
// starts at app boot (main.ts), because this view is lazy and an owner who never opens Settings
// would otherwise never accrue a session and never pass the prompt's gate.
bindSignInNudgeStatus(() => syncStatus.value.connected)

// --- auto-update ---
// Single toggle - no user-facing interval control (family-standard "Auto-update"). The check
// cadence is a fixed sensible default owned by the server (server/src/auto-update.ts); the old
// per-user interval setting is migrated/ignored gracefully server-side.
const autoUpdateEnabled = ref(false)

async function refreshAutoUpdateSettings() {
  try {
    const s = await api.getAutoUpdateSettings()
    autoUpdateEnabled.value = s.enabled
  } catch {
    /* keep last-known value on a failed refresh */
  }
}
onMounted(refreshAutoUpdateSettings)

async function toggleAutoUpdate(enabled: boolean) {
  try {
    const s = await api.updateAutoUpdateSettings({ enabled })
    autoUpdateEnabled.value = s.enabled
    toast.success(
      enabled ? t('settings.autoUpdateToastEnabled') : t('settings.autoUpdateToastDisabled'),
    )
  } catch {
    toast.error(t('settings.autoUpdateToastFailed'))
  }
}

// --- scheduler ---
const sched = reactive({
  spacing_seconds: 60,
  poll_seconds: 5,
  max_concurrent: 3,
  tomorrow_time: '09:00',
})
watch(
  scheduler,
  (s) => {
    if (s) {
      sched.spacing_seconds = s.spacing_seconds
      sched.poll_seconds = s.poll_seconds
      sched.max_concurrent = s.max_concurrent
      sched.tomorrow_time = s.tomorrow_time
    }
  },
  { immediate: true },
)

async function toggleScheduler(enabled: boolean) {
  try {
    await api.updateScheduler({ enabled })
  } catch {
    toast.error(t('settings.toastSchedulerFailed'))
  }
  await refreshScheduler()
}
async function saveScheduler() {
  try {
    await api.updateScheduler({
      spacing_seconds: Number(sched.spacing_seconds),
      poll_seconds: Number(sched.poll_seconds),
      max_concurrent: Number(sched.max_concurrent),
      tomorrow_time: sched.tomorrow_time,
    })
  } catch {
    toast.error(t('settings.toastSchedulerFailed'))
  }
  await refreshScheduler()
}

// progressive disclosure state
const schedAdvancedOpen = ref(false)
const monitorAdvancedOpen = ref(false)

// --- auto-resume monitor ---
const {
  settings: monitorSettings,
  status: monitorStatus,
  accounts: monitorAccountOverrides,
  refreshMonitor,
  updateMonitor,
  setMonitorAccount,
} = useMonitor()
onMounted(refreshMonitor)

const monitorMaxAttempts = ref(3)
const monitorResumeBufferMin = ref(10)
watch(
  monitorSettings,
  (s) => {
    if (s) {
      monitorMaxAttempts.value = s.maxAttempts
      monitorResumeBufferMin.value = s.resumeBufferMin
    }
  },
  { immediate: true },
)

async function toggleMonitorEnabled(enabled: boolean) {
  const ok = await updateMonitor({ enabled })
  if (ok) {
    toast.success(enabled ? t('settings.monitorToastEnabled') : t('settings.monitorToastDisabled'))
  } else {
    toast.error(t('settings.monitorToastFailed'))
  }
}
async function saveMonitorSettings() {
  const ok = await updateMonitor({
    maxAttempts: Number(monitorMaxAttempts.value),
    resumeBufferMin: Number(monitorResumeBufferMin.value),
  })
  if (!ok) toast.error(t('settings.monitorToastFailed'))
}
async function toggleMonitorAccount(accountId: string, enabled: boolean) {
  const ok = await setMonitorAccount(accountId, enabled)
  if (!ok) toast.error(t('settings.monitorToastFailed'))
}
function monitorAccountEnabled(accountId: string): boolean {
  return monitorAccountOverrides.value[accountId] ?? true
}

const MONITOR_STATE_VARIANT: Record<MonitorStateName, BadgeVariant> = {
  scheduled: 'info',
  blocked_weekly: 'warning',
  needs_human: 'destructive',
  done: 'secondary',
}
const MONITOR_STATE_LABEL_KEY: Record<MonitorStateName, string> = {
  scheduled: 'settings.monitorStateScheduled',
  blocked_weekly: 'settings.monitorStateBlockedWeekly',
  needs_human: 'settings.monitorStateNeedsHuman',
  done: 'settings.monitorStateDone',
}
function monitorStateVariant(state: MonitorStateName): BadgeVariant {
  return MONITOR_STATE_VARIANT[state] ?? 'secondary'
}
function monitorStateLabelKey(state: MonitorStateName): string {
  return MONITOR_STATE_LABEL_KEY[state] ?? 'settings.monitorStateScheduled'
}

// The panel's footer Save button. Everything auto-saves as it changes; this flushes
// the buffered forms (scheduler numbers, monitor numbers) and confirms the whole panel.
async function save() {
  await saveScheduler()
  await saveMonitorSettings()
  toast.success(t('settings.toastSaved'))
}
defineExpose({ save })
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 overflow-y-auto p-6">
    <!-- Two tabs: General, and Automation (scheduler + auto-resume monitor).
         Sections carry a ref so a deep link (composer's tomorrow gear → 'scheduler') can flip
         the tab and scroll straight to them. Both tabs stay MOUNTED (v-show) so watchers and
         deep-link refs keep working on the hidden one. -->
    <SettingsTabs v-model="settingsTab" :tabs="settingsTabs" />

    <div v-show="settingsTab === 'general'" class="space-y-6">

    <!-- appearance -->
    <SettingsGroup :label="$t('settings.appearance')">
      <!-- Theme + Shut down moved to icons in the settings panel header (App.vue). Show tooltips
           and the transcript-editor override moved into the "Advanced" disclosure at the bottom of
           this group (owner request), so Appearance leads with the everyday choices. -->
      <SettingsRow :icon="AppWindow" :label="$t('settings.portableModeLabel')">
        <template #info>
          <InfoHint :text="$t('settings.portableModeHint')" />
        </template>
        <template #control>
          <Switch :model-value="portableMode" @update:model-value="togglePortableMode" />
        </template>
      </SettingsRow>
      <SettingsRow :icon="MonitorDown" :label="$t('settings.instanceModeShortcutLabel')">
        <template #info>
          <InfoHint :text="$t('settings.instanceModeShortcutHint')" />
        </template>
        <template #control>
          <Button
            variant="outline"
            size="sm"
            :disabled="creatingInstanceShortcut"
            @click="createQuickInstancesShortcut"
          >
            <MonitorDown :class="creatingInstanceShortcut ? 'animate-pulse' : ''" />
            {{
              $t(
                creatingInstanceShortcut
                  ? 'settings.instanceModeShortcutCreating'
                  : 'settings.instanceModeShortcutCreate',
              )
            }}
          </Button>
        </template>
      </SettingsRow>
      <SettingsRow :icon="EyeOff" :label="$t('settings.hideTrayIconLabel')">
        <template #info>
          <InfoHint :text="$t('settings.hideTrayIconHint')" />
        </template>
        <template #control>
          <Switch :model-value="hideTrayIcon" @update:model-value="toggleHideTrayIcon" />
        </template>
      </SettingsRow>
      <!-- Advanced disclosure (mirrors the Scheduler group): tooltips toggle + transcript-editor
           override live here so the section leads with the everyday choices. -->
      <SettingsRow
        :icon="SlidersHorizontal"
        :label="$t('settings.advanced')"
        clickable
        @click="appearanceAdvancedOpen = !appearanceAdvancedOpen"
      >
        <template #control>
          <ChevronDown
            class="size-4 transition-transform duration-200"
            :class="appearanceAdvancedOpen ? 'rotate-180' : ''"
          />
        </template>
      </SettingsRow>
      <ExpandTransition :open="appearanceAdvancedOpen">
        <!-- divide-y restated on the direct wrapper: SettingsGroup draws its hairlines on the one
             div wrapping its slot, and ExpandTransition inserts wrappers of its own, so without
             this the rows inside render back-to-back with no separator. -->
        <div class="divide-y divide-border/60">
          <SettingsRow :icon="MessageCircleQuestion" :label="$t('settings.showTooltipsLabel')">
            <template #info>
              <InfoHint :text="$t('settings.showTooltipsHint')" />
            </template>
            <template #control>
              <Switch v-model="showTooltips" />
            </template>
          </SettingsRow>
          <!-- Transcript editor: auto-detect is right for nearly everyone (VS Code / Cursor /
               Notepad++ / Sublime), so the path field is a nested disclosure the row states the
               resolved editor and reveals the input only if you go looking for it. -->
          <SettingsRow
            :icon="FilePenLine"
            :label="$t('settings.transcriptEditorLabel')"
            clickable
            @click="editorOpen = !editorOpen"
          >
            <template #info>
              <InfoHint :text="$t('settings.transcriptEditorHint')" />
            </template>
            <template #control>
              <span
                class="max-w-44 truncate"
                :class="editorOverrideIgnored ? 'text-warning' : ''"
                :title="transcriptEditorResolved || undefined"
              >
                {{
                  transcriptEditorResolved
                    ? baseName(transcriptEditorResolved)
                    : $t('settings.transcriptEditorPlaceholder')
                }}
              </span>
              <Badge v-if="transcriptEditor.trim()" variant="secondary">
                {{ $t('settings.transcriptEditorCustomBadge') }}
              </Badge>
              <ChevronDown
                class="size-4 transition-transform duration-200"
                :class="editorOpen ? 'rotate-180' : ''"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="editorOpen">
            <div class="space-y-1.5 px-3.5 pb-3.5 pt-1">
              <Input
                v-model="transcriptEditor"
                type="text"
                :placeholder="$t('settings.transcriptEditorPlaceholder')"
                class="w-full font-mono text-xs"
                @change="saveTranscriptEditor"
              />
              <p
                class="text-[11px]"
                :class="editorOverrideIgnored ? 'text-warning' : 'text-muted-foreground'"
              >
                {{
                  editorOverrideIgnored
                    ? $t('settings.transcriptEditorNotFound', { editor: baseName(transcriptEditorResolved) })
                    : $t('settings.transcriptEditorResolved', { editor: baseName(transcriptEditorResolved) })
                }}
              </p>
              <Button
                v-if="transcriptEditor.trim()"
                variant="ghost"
                size="xs"
                @click="resetTranscriptEditor"
              >
                <RotateCcw /> {{ $t('settings.transcriptEditorReset') }}
              </Button>
            </div>
          </ExpandTransition>
          <!-- Copying a session's file location. The preview is the control that matters: a
               clipboard format described in prose is a format nobody can picture. -->
          <SettingsRow
            :icon="ClipboardCopy"
            :label="$t('settings.copyPathLabel')"
            clickable
            @click="copyPathOpen = !copyPathOpen"
          >
            <template #info>
              <InfoHint :text="$t('settings.copyPathHint')" />
            </template>
            <template #control>
              <ChevronDown
                class="size-4 transition-transform duration-200"
                :class="copyPathOpen ? 'rotate-180' : ''"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="copyPathOpen">
            <div class="space-y-3 px-3.5 pb-3.5 pt-1">
              <label class="flex items-center justify-between gap-3 text-sm">
                {{ $t('settings.copyPathIncludeNameLabel') }}
                <Switch v-model="copyPathIncludeName" />
              </label>
              <label class="flex items-center justify-between gap-3 text-sm">
                {{ $t('settings.copyPathIncludePromptLabel') }}
                <Switch v-model="copyPathIncludePrompt" />
              </label>
              <Input
                v-model="copyPathPrompt"
                type="text"
                :disabled="!copyPathIncludePrompt"
                :placeholder="$t('settings.copyPathPromptPlaceholder')"
                :aria-label="$t('settings.copyPathPromptLabel')"
                class="w-full text-xs"
              />
              <div>
                <p class="mb-1 text-[11px] text-muted-foreground">
                  {{ $t('settings.copyPathPreviewLabel') }}
                </p>
                <pre class="overflow-x-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{{ copyPathPreview }}</pre>
              </div>
            </div>
          </ExpandTransition>

          <!-- The search index is the one file AgentHydra puts on disk that the user did not ask
               for, so it says how big it is and offers to remove it. It rebuilds itself from the
               transcripts, which is why deleting is a plain button and not a confirmation dance. -->
          <SettingsRow :icon="DatabaseZap" :label="$t('settings.searchIndexLabel')">
            <template #info>
              <InfoHint :text="$t('settings.searchIndexHint')" />
            </template>
            <template #description>
              {{
                searchIndex && searchIndex.exists
                  ? $t('settings.searchIndexBuilt', {
                      size: formatBytes(searchIndex.sizeBytes),
                      n: searchIndex.sessions,
                    })
                  : $t('settings.searchIndexAbsent')
              }}
            </template>
            <template #control>
              <Button
                v-if="searchIndex?.exists"
                variant="outline"
                size="xs"
                :disabled="deletingSearchIndex"
                @click="removeSearchIndex"
              >
                {{ $t('settings.searchIndexDelete') }}
              </Button>
            </template>
          </SettingsRow>
        </div>
      </ExpandTransition>
    </SettingsGroup>

    <!-- provider surfaces: decide which installed tools and optional handoffs AgentHydra exposes -->
    <SettingsGroup
      :ref="(el: unknown) => setSectionEl('providers', el)"
      :class="flashSection === 'providers' ? 'settings-flash' : ''"
      :label="$t('settings.providersTitle')"
      :description="$t('settings.providersHint')"
    >
      <!-- The rows themselves live in components/ProviderRows.vue, because the Instances toolbar
           renders the same four table switches in a flyout (InstanceSectionsMenu.vue) where they
           take effect. One component, one behaviour — the two surfaces cannot drift. -->
      <ProviderRows />
    </SettingsGroup>

    <!-- usage: keep the quota numbers warm.
         Shared with the Instances tab's usage flyout for the same reason as Providers above — see
         components/UsageRefreshRows.vue. -->
    <SettingsGroup :label="$t('settings.usage')">
      <UsageRefreshRows />
    </SettingsGroup>

    <!-- notifications: the quota EDGE, not the number. See server/src/reset-watch.ts.
         Everything below the master switch is disclosed only when it is on - the whole group is
         several rows of nothing when notifications are off. -->
    <SettingsGroup :label="$t('notifications.title')">
      <SettingsRow :icon="BellRing" :label="$t('notifications.enabled')">
        <template #info>
          <InfoHint :text="$t('notifications.enabledHint')" />
        </template>
        <template #control>
          <Switch
            :model-value="notifyEnabled"
            @update:model-value="(v: boolean) => patchNotifications({ notifyEnabled: v })"
          />
        </template>
      </SettingsRow>
      <ExpandTransition :open="notifyEnabled">
        <div class="divide-y divide-border">
          <SettingsRow :icon="Timer" :label="$t('notifications.sessionReset')">
            <template #control>
              <Switch
                :model-value="notifySessionReset"
                @update:model-value="(v: boolean) => patchNotifications({ notifySessionReset: v })"
              />
            </template>
          </SettingsRow>
          <SettingsRow :icon="CalendarClock" :label="$t('notifications.weeklyReset')">
            <template #control>
              <Switch
                :model-value="notifyWeeklyReset"
                @update:model-value="(v: boolean) => patchNotifications({ notifyWeeklyReset: v })"
              />
            </template>
          </SettingsRow>
          <SettingsRow :icon="Gauge" :label="$t('notifications.minPct')">
            <template #info>
              <InfoHint :text="$t('notifications.minPctHint')" />
            </template>
            <template #control>
              <div class="flex items-center gap-1">
                <Input
                  class="h-7 w-16 text-right"
                  type="number"
                  min="0"
                  max="100"
                  :model-value="notifyMinPct"
                  @change="(e: Event) => patchNotifications({ notifyMinPct: Number((e.target as HTMLInputElement).value) })"
                />
                <span>%</span>
              </div>
            </template>
          </SettingsRow>
          <!-- Disabled when session resets are off entirely: there is nothing left for it to
               suppress, and a live-looking control that changes nothing is worse than a greyed one. -->
          <SettingsRow
            :icon="Gauge"
            :label="$t('notifications.sessionMaxWeeklyPct')"
            :disabled="!notifySessionReset"
          >
            <template #info>
              <InfoHint :text="$t('notifications.sessionMaxWeeklyPctHint')" />
            </template>
            <template #control>
              <div class="flex items-center gap-1">
                <Input
                  class="h-7 w-16 text-right"
                  type="number"
                  min="0"
                  max="100"
                  :disabled="!notifySessionReset"
                  :model-value="notifySessionMaxWeeklyPct"
                  @change="(e: Event) => patchNotifications({ notifySessionMaxWeeklyPct: Number((e.target as HTMLInputElement).value) })"
                />
                <span>%</span>
              </div>
            </template>
          </SettingsRow>
          <SettingsRow :icon="Monitor" :label="$t('notifications.desktop')">
            <template #info>
              <InfoHint :text="$t('notifications.desktopHint')" />
            </template>
            <template #control>
              <Switch
                :model-value="notifyDesktop"
                @update:model-value="(v: boolean) => patchNotifications({ notifyDesktop: v })"
              />
            </template>
          </SettingsRow>
          <SettingsRow :icon="Repeat" :label="$t('notifications.persistent')">
            <template #info>
              <InfoHint :text="$t('notifications.persistentHint')" />
            </template>
            <template #control>
              <Switch
                :model-value="notifyPersistent"
                @update:model-value="(v: boolean) => patchNotifications({ notifyPersistent: v })"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="notifyPersistent">
            <div class="divide-y divide-border">
              <SettingsRow :icon="Timer" :label="$t('notifications.persistentInterval')">
                <template #control>
                  <div class="flex items-center gap-1">
                    <Input
                      class="h-7 w-16 text-right"
                      type="number"
                      min="1"
                      max="1440"
                      :model-value="notifyPersistentIntervalMin"
                      @change="(e: Event) => patchNotifications({ notifyPersistentIntervalMin: Number((e.target as HTMLInputElement).value) })"
                    />
                    <span>{{ $t('notifications.minutes') }}</span>
                  </div>
                </template>
              </SettingsRow>
              <SettingsRow :icon="Repeat" :label="$t('notifications.persistentMaxRepeats')">
                <template #info>
                  <InfoHint :text="$t('notifications.persistentMaxRepeatsHint')" />
                </template>
                <template #control>
                  <div class="flex items-center gap-1">
                    <Input
                      class="h-7 w-16 text-right"
                      type="number"
                      min="0"
                      max="200"
                      :model-value="notifyPersistentMaxRepeats"
                      @change="(e: Event) => patchNotifications({ notifyPersistentMaxRepeats: Number((e.target as HTMLInputElement).value) })"
                    />
                    <span>{{ $t('notifications.reminders') }}</span>
                  </div>
                </template>
              </SettingsRow>
            </div>
          </ExpandTransition>
          <SettingsRow :icon="Mail" :label="$t('notifications.email')">
            <template #info>
              <InfoHint :text="$t('notifications.emailHint')" />
            </template>
            <template #control>
              <Switch
                :model-value="notifyEmail"
                @update:model-value="(v: boolean) => patchNotifications({ notifyEmail: v })"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="notifyEmail">
            <div class="divide-y divide-border">
              <SettingsRow :icon="Mail" :label="$t('notifications.emailTo')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    type="email"
                    :model-value="notifyEmailTo"
                    @change="(e: Event) => patchNotifications({ notifyEmailTo: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="Mail" :label="$t('notifications.emailFrom')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    type="email"
                    :model-value="notifyEmailFrom"
                    @change="(e: Event) => patchNotifications({ notifyEmailFrom: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="Cloud" :label="$t('notifications.smtpHost')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    :model-value="notifySmtpHost"
                    @change="(e: Event) => patchNotifications({ notifySmtpHost: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="Cloud" :label="$t('notifications.smtpPort')">
                <template #control>
                  <Input
                    class="h-7 w-20 text-right"
                    type="number"
                    min="1"
                    max="65535"
                    :model-value="notifySmtpPort"
                    @change="(e: Event) => patchNotifications({ notifySmtpPort: Number((e.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="CloudCheck" :label="$t('notifications.smtpSecure')">
                <template #info>
                  <InfoHint :text="$t('notifications.smtpSecureHint')" />
                </template>
                <template #control>
                  <Switch
                    :model-value="notifySmtpSecure"
                    @update:model-value="(v: boolean) => patchNotifications({ notifySmtpSecure: v })"
                  />
                </template>
              </SettingsRow>
              <SettingsRow :icon="User" :label="$t('notifications.smtpUser')">
                <template #control>
                  <Input
                    class="h-7 w-56"
                    :model-value="notifySmtpUser"
                    @change="(e: Event) => patchNotifications({ notifySmtpUser: (e.target as HTMLInputElement).value })"
                  />
                </template>
              </SettingsRow>
              <!-- Always blank: the server does not return the stored password, so there is
                   nothing to prefill. Saving an empty value keeps whatever is stored. -->
              <SettingsRow :icon="User" :label="$t('notifications.smtpPass')">
                <template #description>
                  <span v-if="notifySmtpPassSet">{{ $t('notifications.smtpPassStored') }}</span>
                </template>
                <template #control>
                  <Input
                    v-model="smtpPassDraft"
                    class="h-7 w-56"
                    type="password"
                    autocomplete="new-password"
                    @change="saveSmtpPass"
                  />
                </template>
              </SettingsRow>
            </div>
          </ExpandTransition>
          <SettingsRow :icon="BellRing" :label="$t('notifications.test')">
            <template #info>
              <InfoHint :text="$t('notifications.testHint')" />
            </template>
            <template #control>
              <Button
                size="xs"
                variant="outline"
                :disabled="testingNotification"
                @click="onTestNotification"
              >
                <RefreshCw v-if="testingNotification" class="animate-spin" />
                {{ testingNotification ? $t('notifications.testSending') : $t('notifications.test') }}
              </Button>
            </template>
          </SettingsRow>
        </div>
      </ExpandTransition>
    </SettingsGroup>

    <!-- updates.
         Deep-linkable, because the blue dot on the header's settings button is the only thing that
         says a new version exists and the dot itself explains nothing: clicking it now scrolls
         here and pulses this card, so the answer to "why is there a dot?" is the first thing you
         see instead of something you have to go hunting for down a long page. -->
    <SettingsGroup
      :ref="(el: unknown) => setSectionEl('updates', el)"
      :class="flashSection === 'updates' ? 'settings-flash' : ''"
      :label="$t('settings.updates')"
    >
      <!-- The version number IS the status indicator + control now (owner request): green = up to
           date, amber = update available (click to apply & restart), red = blocked / no update
           source. Hover spells out the exact state; clicking re-checks, or applies a waiting update.
           This folds away the old always-visible "Up to date." / "Update available" / "Update
           blocked" / "no source" status rows. -->
      <SettingsRow :icon="CloudDownload" :label="$t('settings.currentVersion')">
        <template #control>
          <Tooltip>
            <TooltipTrigger as-child>
              <!-- The colour lives on the version-number span, not the <button>: the kit's base
                   reset sets `button { color: inherit }` unlayered, which beats a `text-*` utility
                   on the button itself — and "the version number is green/red" is the literal ask. -->
              <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium tabular-nums transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-70"
                :disabled="updateApplying"
                @click="onVersionClick"
              >
                <RefreshCw
                  v-if="updateChecking || updateApplying"
                  class="size-3.5 animate-spin"
                  :class="versionColorClass"
                />
                <span :class="versionColorClass">{{ updateStatus?.currentVersion ?? '—' }}</span>
                <span v-if="updateStatus?.currentCommit" class="text-muted-foreground/80">
                  · {{ updateStatus.currentCommit.slice(0, 7) }}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ versionTip }}</TooltipContent>
          </Tooltip>
        </template>
      </SettingsRow>
      <!-- What the update is DOING, while it does it. The apply request covers minutes of real
           work (a ~100 MB download, or a pull + reinstall + rebuild), and until this existed the
           only feedback was a spinning icon — so a healthy slow update and a hung one looked
           identical. See composables/useUpdates.ts. -->
      <p
        v-if="updateApplying && progressLabel"
        class="px-3.5 pb-2.5 text-xs text-muted-foreground"
        aria-live="polite"
      >
        {{ progressLabel }}
      </p>
      <p v-if="applyMessage" class="px-3.5 pb-2.5 text-xs text-muted-foreground">
        {{ applyMessage }}
        <span v-if="restartRequired">{{ $t('settings.restartGuidance') }}</span>
      </p>
      <p v-if="applyError" class="px-3.5 pb-2.5 text-xs text-destructive">{{ applyError }}</p>

      <!-- the auto-update loop lives with the manual check: one Updates story, one group.
           Single toggle (family-standard "Auto-update" - no separate interval control; the
           daemon checks on a sensible fixed cadence internally). Grays out when there is no
           update source, since it could never fire. -->
      <SettingsRow :icon="CloudCog" :label="$t('settings.autoUpdate')">
        <template #info>
          <InfoHint :text="$t('settings.autoUpdateDescription')" />
        </template>
        <template #control>
          <Switch
            :model-value="autoUpdateEnabled"
            :disabled="noUpdateSource"
            @update:model-value="toggleAutoUpdate"
          />
        </template>
      </SettingsRow>
    </SettingsGroup>

    <!-- cloud sync -->
    <SettingsGroup :label="$t('settings.cloudSyncTitle')">
      <!-- not connected: sign-in CTA -->
      <div v-if="!syncStatus.connected" class="px-3.5 py-2.5">
        <Button variant="outline" class="w-full" @click="goSignIn">
          <Cloud class="text-sky-500" />
          {{ $t('settings.cloudSyncConnectButton') }}
          <ExternalLink class="opacity-70" />
        </Button>
      </div>

      <!-- connected: master toggle + status -->
      <template v-else>
        <SettingsRow :icon="CloudCheck" :label="$t('settings.cloudSyncEnableToggle')">
          <template #info>
            <InfoHint :text="$t('settings.cloudSyncHint')" />
          </template>
          <template #control>
            <Switch :model-value="syncStatus.enabled" @update:model-value="onToggleSyncEnable" />
          </template>
        </SettingsRow>
        <SettingsRow v-if="syncStatus.enabled" :label="syncStatus.name || syncStatus.email || ''">
          <template #icon>
            <img
              v-if="syncStatus.picture"
              :src="syncStatus.picture"
              alt=""
              class="size-[18px] shrink-0 rounded-full object-cover"
            />
            <User v-else class="size-[18px] shrink-0 text-muted-foreground" />
          </template>
          <template #control>
            <span class="text-[12px] text-muted-foreground">{{ syncedLabel }}</span>
            <Button variant="ghost" size="sm" :disabled="syncBusy" @click="onSyncNow">
              <RefreshCw :class="syncBusy ? 'animate-spin' : ''" />
              {{ syncBusy ? $t('settings.cloudSyncSyncing') : $t('settings.cloudSyncSyncNow') }}
            </Button>
          </template>
        </SettingsRow>
        <SettingsRow>
          <template #icon><LogOut class="size-[18px] shrink-0 text-muted-foreground" /></template>
          <template #label>
            {{ confirmDisconnect ? $t('settings.cloudSyncConfirmDisconnect') : $t('settings.cloudSyncDisconnect') }}
          </template>
          <template #control>
            <Button
              :variant="confirmDisconnect ? 'destructive' : 'ghost'"
              size="sm"
              :disabled="syncBusy"
              @click="onDisconnect"
              @blur="confirmDisconnect = false"
            >
              <CloudOff />
              {{ $t('settings.cloudSyncDisconnect') }}
            </Button>
          </template>
        </SettingsRow>
      </template>
      <p v-if="syncError" class="px-3.5 pb-2.5 text-xs text-destructive">{{ syncError }}</p>
    </SettingsGroup>

    </div>

    <div v-show="settingsTab === 'automation'" class="space-y-6">

    <!-- scheduler (deep-link target: the queue drawer's indicator, the header chip and the
         composer's tomorrow gear all scroll here).
         The ref sits on the GROUP, not on a wrapper div — within this tab's own space-y-6
         wrapper, groups must stay DIRECT children or they lose the margin between them, and
         the landing flash must scope to the one section asked for. -->
    <SettingsGroup
      :ref="(el) => setSectionEl('scheduler', el)"
      :label="$t('settings.scheduler')"
      :description="$t('settings.schedulerHint')"
      class="scroll-mt-4"
      :class="flashSection === 'scheduler' ? 'settings-flash' : ''"
    >
      <!-- AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts) — the scheduler
           exists solely to spawn those runs automatically, so it can never dispatch anything in
           this build. Say so up front and disable the controls below with that reason, rather than
           offer a toggle that would only fail moments after being flipped on. Mirrors QueueView /
           QueueBuilder's AH-12 fix, both reading the same HEADLESS_QUEUEING_ENABLED flag. -->
      <div v-if="!HEADLESS_QUEUEING_ENABLED" class="px-3.5 py-2.5 text-[11px] text-warning">
        {{ $t('settings.schedulerUnavailableHint') }}
      </div>
      <SettingsRow :icon="Power" :label="$t('settings.schedulerEnabledLabel')">
        <template #control>
          <span>
            {{ scheduler?.running_count ?? 0 }} {{ $t('settings.running') }} ·
            {{ scheduler?.queued_count ?? 0 }} {{ $t('settings.queued') }}
          </span>
          <Switch
            :model-value="scheduler?.enabled ?? false"
            :disabled="!HEADLESS_QUEUEING_ENABLED"
            :title="!HEADLESS_QUEUEING_ENABLED ? $t('settings.schedulerUnavailableHint') : undefined"
            @update:model-value="toggleScheduler"
          />
        </template>
      </SettingsRow>
      <!-- the composer's "Tomorrow …" quick option reads this time (its tiny gear lands here) -->
      <SettingsRow :icon="CalendarClock" :label="$t('settings.tomorrowTimeLabel')">
        <template #info>
          <InfoHint :text="$t('settings.tomorrowTimeHint')" />
        </template>
        <template #control>
          <Input
            v-model="sched.tomorrow_time"
            type="time"
            class="w-28"
            :disabled="!HEADLESS_QUEUEING_ENABLED"
            :title="!HEADLESS_QUEUEING_ENABLED ? $t('settings.schedulerUnavailableHint') : undefined"
            @change="saveScheduler"
          />
        </template>
      </SettingsRow>
      <SettingsRow
        :icon="SlidersHorizontal"
        :label="$t('settings.advanced')"
        clickable
        @click="schedAdvancedOpen = !schedAdvancedOpen"
      >
        <template #control>
          <ChevronDown
            class="size-4 transition-transform duration-200"
            :class="schedAdvancedOpen ? 'rotate-180' : ''"
          />
        </template>
      </SettingsRow>
      <ExpandTransition :open="schedAdvancedOpen">
        <div class="grid grid-cols-3 gap-3 px-3.5 pb-3.5 pt-2.5">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ $t('settings.spacingLabel') }}</label>
            <Input v-model="sched.spacing_seconds" type="number" :disabled="!HEADLESS_QUEUEING_ENABLED" />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ $t('settings.pollLabel') }}</label>
            <Input v-model="sched.poll_seconds" type="number" :disabled="!HEADLESS_QUEUEING_ENABLED" />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ $t('settings.maxConcurrentLabel') }}</label>
            <Input v-model="sched.max_concurrent" type="number" :disabled="!HEADLESS_QUEUEING_ENABLED" />
          </div>
        </div>
      </ExpandTransition>
    </SettingsGroup>


    <!-- auto-resume monitor -->
    <SettingsGroup :label="$t('settings.monitorTitle')" :description="$t('settings.monitorHint')">
      <SettingsRow :icon="RefreshCw" :label="$t('settings.monitorEnabledLabel')">
        <template #control>
          <Switch
            :model-value="monitorSettings?.enabled ?? false"
            @update:model-value="toggleMonitorEnabled"
          />
        </template>
      </SettingsRow>

      <!-- everything below only applies while the monitor is on: collapse it away when
           it's off instead of leaving dead knobs on screen (owner request) -->
      <ExpandTransition :open="monitorSettings?.enabled ?? false">
        <!-- divide-y is restated here for the same reason the scheduler deep link avoids a wrapper
             div: SettingsGroup draws its hairlines with divide-y on the one div that directly wraps
             its slot, and ExpandTransition inserts two divs of its own. Everything in this
             disclosure is therefore a single child to that container, so the per-account rows below
             rendered back-to-back with no separator while structurally identical rows got one. -->
        <div class="divide-y divide-border/60">
          <!-- the tuning numbers are advanced, mirroring the Scheduler group's disclosure -->
          <SettingsRow
            :icon="SlidersHorizontal"
            :label="$t('settings.advanced')"
            clickable
            @click="monitorAdvancedOpen = !monitorAdvancedOpen"
          >
            <template #control>
              <ChevronDown
                class="size-4 transition-transform duration-200"
                :class="monitorAdvancedOpen ? 'rotate-180' : ''"
              />
            </template>
          </SettingsRow>
          <ExpandTransition :open="monitorAdvancedOpen">
            <div class="grid grid-cols-2 gap-3 px-3.5 pb-3.5 pt-2.5">
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('settings.monitorMaxAttemptsLabel') }}</label>
                <Input v-model="monitorMaxAttempts" type="number" min="1" />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-muted-foreground">{{ $t('settings.monitorBufferLabel') }}</label>
                <Input v-model="monitorResumeBufferMin" type="number" min="0" />
              </div>
            </div>
          </ExpandTransition>

          <div v-if="monitorStatus.length === 0" class="px-3.5 py-2.5 text-xs italic text-muted-foreground">
            {{ $t('settings.monitorEmpty') }}
          </div>
          <div v-else class="flex flex-col gap-2 px-3.5 py-2.5">
            <div v-for="row in monitorStatus" :key="row.itemId" class="flex items-center gap-2 text-xs">
              <Badge :variant="monitorStateVariant(row.state)">{{ $t(monitorStateLabelKey(row.state)) }}</Badge>
              <!-- a stop we went and found on disk, vs one of our own runs we watched stop -->
              <Badge v-if="row.discovered" variant="outline" :title="$t('settings.monitorDiscoveredHint')">
                {{ $t('settings.monitorDiscovered') }}
              </Badge>
              <span class="min-w-0 flex-1 truncate text-foreground">{{ row.title ?? row.sessionId }}</span>
              <span v-if="row.message" class="max-w-[14rem] truncate text-muted-foreground">{{ row.message }}</span>
              <span class="shrink-0 text-muted-foreground">
                {{ $t('settings.monitorAttempts', { n: row.resumeAttempts }) }}
              </span>
            </div>
          </div>

          <template v-if="accounts.length > 0">
            <p class="px-3.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {{ $t('settings.monitorAccountOverridesLabel') }}
            </p>
            <SettingsRow v-for="a in accounts" :key="a.id" :label="a.label">
              <template #control>
                <Switch
                  :model-value="monitorAccountEnabled(a.id)"
                  @update:model-value="(v: boolean) => toggleMonitorAccount(a.id, v)"
                />
              </template>
            </SettingsRow>
          </template>
        </div>
      </ExpandTransition>
    </SettingsGroup>

    </div>

    <!-- No Accounts group here anymore. It listed only LEGACY pasted credentials, which are
         nobody's normal path since accounts arrived by signing an instance in, so for almost
         everyone it rendered as a section whose entire content was "no accounts yet" above a
         note telling you to go to the Instances tab. A settings section that exists to redirect
         you elsewhere is a dead end, not a setting (owner request). The per-account monitor
         overrides above still list accounts where they actually mean something, and DELETE
         /api/accounts stays for the rare leftover credential. -->
  </div>
</template>
