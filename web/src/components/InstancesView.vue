<script setup lang="ts">
import {
  AppWindow,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Boxes,
  ChevronDown,
  Copy,
  Cpu,
  EllipsisVertical,
  FolderOpen,
  Funnel,
  Gauge,
  LogIn,
  LogOut,
  MonitorDown,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  Unlink,
  UserRound,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstancesSection from '@/components/CliInstancesSection.vue'
import CodexInstancesSection from '@/components/CodexInstancesSection.vue'
import CreateInstanceDialog from '@/components/CreateInstanceDialog.vue'
import DeleteInstanceDialog from '@/components/DeleteInstanceDialog.vue'
import EditInstanceDialog from '@/components/EditInstanceDialog.vue'
import ExpandArea from '@/components/ExpandArea.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import InstanceSectionsMenu from '@/components/InstanceSectionsMenu.vue'
import LogoutInstanceDialog from '@/components/LogoutInstanceDialog.vue'
import QuitExternalInstanceDialog from '@/components/QuitExternalInstanceDialog.vue'
import UsageBadge from '@/components/UsageBadge.vue'
import UsageBar from '@/components/UsageBar.vue'
import UsageFilterMenu from '@/components/UsageFilterMenu.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAppSettings } from '@/composables/useAppSettings'
import { useCliInstances } from '@/composables/useCliInstances'
import { useInstances } from '@/composables/useInstances'
import { useSortable } from '@/composables/useSortable'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageFilter } from '@/composables/useUsageFilter'
import { useUsageMode } from '@/composables/useUsageMode'
import type { CliInstance, CMDesktopInstall, CMInstance, SessionSummary } from '@/lib/api'
import {
  CLASSIC_DESKTOP_INSTALLER_URL,
  DESKTOP_DOWNLOAD_PAGE_URL,
  getDesktopInstall,
  getSessions,
  migrateSession,
} from '@/lib/api'
import { formatBytes, formatUptime } from '@/lib/format'
import {
  accountDisplayName,
  accountEmail,
  accountHandle,
  colorValue,
  displayName,
  iconComponent,
  labelDisagreesWithAccount,
  resolveColorKey,
  resolveIconKey,
} from '@/lib/instance-appearance'
import { groupByProject } from '@/lib/session-groups'
import { requestSessionJump } from '@/lib/session-jump'
import { useTooltipConfig } from '@/lib/tooltip-config'
import { bindingWeeklyPct, usageReasonMessageKey } from '@/lib/usage'
import { runUsageCatchup, selectUsageCatchup } from '@/lib/usage-catchup'
import {
  msUntilReset,
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '@/lib/usage-reset'
import IconTooltip from '@/shell/IconTooltip.vue'
import InfoHint from '@/shell/InfoHint.vue'

const {
  instances,
  loading,
  busyDirs,
  startPolling,
  stopPolling,
  refreshInstances,
  open,
  quit,
  focus,
  logout,
  revealFolder,
  createShortcut,
  create,
  remove,
  setAppearance,
} = useInstances()

const { t } = useI18n()
const { enabled: tooltipsEnabled } = useTooltipConfig()
const {
  snapshotFor,
  isChecking,
  checkDesktop,
  reasonFor,
  hydrated: usageHydrated,
  startPolling: startUsagePolling,
  stopPolling: stopUsagePolling,
} = useUsage()

const usageKeyFor = (inst: CMInstance) => `desktop:${inst.dir}`
const usageFor = (inst: CMInstance) => snapshotFor(usageKeyFor(inst))

// --- usage mode ---------------------------------------------------------------------------------
// One toolbar toggle swaps the PROCESS columns (PID / uptime / memory — "is it healthy?") for the
// QUOTA columns ("how much is left, and when does it come back?"). See composables/useUsageMode.ts
// for why it's a mode rather than a per-column picker. `now` is the shared clock every countdown
// cell in both tables formats against, so the whole tab ticks together.
const { usageMode, toggle: toggleUsageMode, now } = useUsageMode(true)

/** "2h 14m" left on a window, or null when there is no reset instant to count down to. */
function sessionResetFor(inst: CMInstance): string | null {
  return resetLabel(usageFor(inst)?.session, now.value)
}
function weeklyResetFor(inst: CMInstance): string | null {
  return resetLabel(usageFor(inst)?.weekAll, now.value)
}
// How much of each window is still to run. This ONE number drives both the bar's length and its
// colour (waitSeverity bands it as a fraction of its own window), so short+green = nearly back and
// long+red = most of the window still ahead — on a 5-hour session exactly as on a 7-day week.
function sessionRemaining(inst: CMInstance): number {
  return windowRemainingPct(usageFor(inst)?.session, SESSION_WINDOW_MS, now.value) ?? 0
}
function weeklyRemaining(inst: CMInstance): number {
  return windowRemainingPct(usageFor(inst)?.weekAll, WEEK_WINDOW_MS, now.value) ?? 0
}
function sessionWait(inst: CMInstance) {
  return waitSeverity(sessionRemaining(inst))
}
function weeklyWait(inst: CMInstance) {
  return waitSeverity(weeklyRemaining(inst))
}

const { sortedRows, toggleSort, indicatorFor } = useSortable(
  () => instances.value,
  [
    { key: 'running', accessor: (i: CMInstance) => i.isRunning },
    // sort by what the cell actually shows (the display label, falling back to folder name)
    { key: 'name', accessor: (i: CMInstance) => displayName(i) },
    // Sort by what the cell actually shows (see accountCellName).
    { key: 'account', accessor: (i: CMInstance) => accountCellName(i) },
    { key: 'pid', accessor: (i: CMInstance) => i.pid ?? undefined },
    { key: 'uptime', accessor: (i: CMInstance) => (i.isRunning ? i.startTime : null) },
    { key: 'memory', accessor: (i: CMInstance) => i.memoryBytes ?? undefined },
    // Usage-mode columns. Sorted by TIME REMAINING, not by the reset timestamp string: "soonest
    // reset first" is the ordering anyone asking this question wants, and it is stable as the
    // clock advances because every row shifts by the same amount.
    {
      key: 'session',
      accessor: (i: CMInstance) => msUntilReset(usageFor(i)?.session, now.value) ?? undefined,
    },
    {
      key: 'weekly',
      accessor: (i: CMInstance) => msUntilReset(usageFor(i)?.weekAll, now.value) ?? undefined,
    },
    {
      key: 'usage',
      accessor: (i: CMInstance) => {
        const snap = usageFor(i)
        return snap ? (bindingWeeklyPct(snap) ?? undefined) : undefined
      },
    },
    { key: 'usageSession', accessor: (i: CMInstance) => usageFor(i)?.session?.pct ?? undefined },
    { key: 'plan', accessor: (i: CMInstance) => i.account?.planLabel ?? undefined },
  ],
)

// --- usage filter ---------------------------------------------------------------------------
// "Set aside the accounts I've already spent" (composables/useUsageFilter.ts). It runs AFTER the
// sort — it removes or greys rows, it never reorders them — and only in usage mode, which is also
// the only mode where its toolbar control is on screen.
const { dimmed: filterDimmed, visible: filterVisible } = useUsageFilter()

const visibleRows = computed(() => filterVisible(sortedRows.value, usageFor))
/** How many rows the filter took out of this table — the heading has to say so, or an instance
 *  that quietly stopped being listed reads as a bug rather than as the filter working. */
const hiddenByFilter = computed(() => sortedRows.value.length - visibleRows.value.length)
/** Every row filtered away. The table is not empty (there ARE instances), so the empty state has to
 *  explain the filter rather than tell the user to create their first instance. */
const allHiddenByFilter = computed(
  () => instances.value.length > 0 && visibleRows.value.length === 0,
)

// Collapse state, persisted: someone who only uses the desktop app (or only the CLI) collapses the
// other table once and expects it to stay that way. Owned by composables/useUiPrefs.ts, which is
// where every preference that is also mirrored through the daemon lives.
const { desktopOpen } = useUiPrefs()

const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)

const deleteOpen = ref(false)
const deleteTarget = ref<CMInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

const editOpen = ref(false)
const editTarget = ref<CMInstance | null>(null)
const editing = ref(false)
const editError = ref<string | null>(null)

// The account cell identifies the LOGIN, so it shows the email handle and nothing else — see
// accountHandle for why it is no longer accountName. The account's own label is the last resort so
// a logged-out row still reads "(not logged in)" instead of collapsing to "Resolving…".
function accountCellName(inst: CMInstance): string | null {
  return accountHandle(inst.account) ?? inst.account?.label ?? null
}

// The hover reveal: the full address, plus the Anthropic profile name when the account has one and
// it isn't just the handle again, and the line saying the cell copies. This is where the friendly
// name went — it is still one hover away, it just no longer competes with the handle for the same
// slot, which is what made the column unreadable (some rows a person's name, some rows an email
// fragment, no way to tell).
function accountTitle(inst: CMInstance): string | undefined {
  const email = accountEmail(inst.account)
  if (!email) return undefined
  const profile = inst.account?.name?.trim()
  const head =
    profile && profile !== accountHandle(inst.account)
      ? t('instances.accountTitleWithProfile', { email, profile })
      : email
  return `${head}\n${t('instances.accountCopyHint')}`
}

/**
 * Copy the account's FULL address, not the handle the cell shows.
 *
 * The handle is a display compromise — it fits the column — but it is not an identifier you can
 * paste anywhere: two accounts on different domains render the same chip. So the cell shows the
 * short form and hands over the long one, the same split the tooltip already made.
 *
 * A row with no resolved email is not clickable at all (see the template), so there is no silent
 * no-op: a signed-out account's label ("(not logged in)") must never reach the clipboard looking
 * like an address.
 */
function copyAccountEmail(inst: CMInstance) {
  const email = accountEmail(inst.account)
  if (!email) return
  navigator.clipboard?.writeText(email).catch(() => {})
  toast.success(t('instances.toastEmailCopied', { email }))
}

function accountBadgeVariant(inst: CMInstance) {
  switch (inst.account?.status) {
    case 'live':
      return 'success' as const
    case 'cache':
    case 'offline':
      return 'warning' as const
    case 'loggedout':
      return 'outline' as const
    default:
      return 'ghost' as const
  }
}

async function handleRefresh() {
  // fresh: bypass the server's 5-minute detection cache so installing the classic build and
  // hitting Refresh actually clears the warning banner below.
  // force: re-resolve every account live. Accounts resolve themselves now, so this button is the
  // one way left to say "that identity is stale, go ask again" (e.g. after a plan upgrade).
  await Promise.all([
    refreshInstances({ force: true, resolve: 'full' }),
    refreshDesktopInstall(true),
  ])
}

async function onCheckUsage(inst: CMInstance) {
  const ok = await checkDesktop(inst.dir)
  if (!ok) {
    toast.error(t('instances.toastUsageCheckFailed'))
    return
  }
  // The API call itself can succeed while still coming back with no usable numbers (not
  // signed in, no usage-capable token, or the probe returned nothing). A manual click should
  // never go silent, so surface the reason; a real result just updates the cell.
  const reasonKey = usageReasonMessageKey(reasonFor(usageKeyFor(inst)))
  if (reasonKey) toast.error(t(reasonKey))
}

// Which tables to show, and the CLI instances (so "refresh all" covers them too, not just desktop).
const {
  showDesktopInstances,
  showCliInstances,
  codexDesktopEnabled,
  codexCliEnabled,
  load: loadAppSettings,
} = useAppSettings()
const {
  cliInstances,
  checkUsage: checkCliUsage,
  create: createCli,
  launch: launchCli,
  login: loginCli,
  linkDesktop: linkCliDesktop,
  remove: removeCli,
} = useCliInstances()
onMounted(loadAppSettings)

// --- unified per-account view -------------------------------------------------------------------
// A desktop instance and the CLI instance linked to it are the SAME Anthropic account, signed in
// twice (Electron safeStorage vs a CLAUDE_CONFIG_DIR). So the desktop row IS the account row: it
// shows its CLI login inline and can act on it, instead of making you cross-reference two tables to
// see that "4claude the app" and "4claude the CLI" are one quota.
//
// Returns an ARRAY (0 or 1) rather than an object, purely so the template can `v-for` over it and
// get a properly-typed local binding — Vue has no `v-let`, and this avoids `!` assertions.
function linkedClis(dir: string): CliInstance[] {
  return cliInstances.value.filter((c) => c.associatedDesktopDir === dir)
}
/** The 0-or-1 linked CLI login as a nullable, for `v-if` branching in the actions menu. */
function linkedCliFor(dir: string): CliInstance | null {
  return linkedClis(dir)[0] ?? null
}

async function onLaunchCli(cli: CliInstance) {
  const result = await launchCli(cli.id)
  if (result?.ok) toast.success(t('instances.toastCliLaunched'))
  else toast.error(result?.message ?? t('instances.toastCliLaunchFailed'))
}
async function onLoginCli(cli: CliInstance) {
  const result = await loginCli(cli.id)
  if (result?.ok) toast.success(t('instances.toastCliLoginOpened'))
  else toast.error(result?.message ?? t('instances.toastCliLoginFailed'))
}
/** Send a linked CLI instance back down to the CLI table (where rename/delete/associate live). */
async function onUnlinkCli(cli: CliInstance) {
  const result = await linkCliDesktop(cli.id, null)
  if (result?.ok) toast.success(t('instances.toastCliUnlinked'))
  else toast.error(result?.message ?? t('instances.toastCliUnlinkFailed'))
}

// "Sign in CLI" on a row with NO linked CLI login yet: create one on demand, link it to this
// desktop instance, then open the /login terminal — the same three building blocks the CLI table
// uses, chained. The busy-set guards a double-click: two concurrent create+link chains for one row
// would orphan a CLI instance (the second link silently steals the association from the first).
const cliSignInBusy = ref(new Set<string>())
async function onSignInCli(inst: CMInstance) {
  if (cliSignInBusy.value.has(inst.dir)) return
  cliSignInBusy.value = new Set(cliSignInBusy.value).add(inst.dir)
  try {
    const cliName = `${displayName(inst)} (CLI)`
    const created = await createCli(cliName)
    const id = created?.ok ? (created.data?.id as string | undefined) : undefined
    if (!id) {
      toast.error(created?.message ?? t('instances.toastCliCreateFailed'))
      return
    }
    const linked = await linkCliDesktop(id, inst.dir)
    if (!linked?.ok) {
      // The link failed, so this CLI instance was created but never linked — leaving it behind
      // would orphan it in the CLI Instances table. Clean it up (confirmName mirrors the trim
      // createCliInstance applies to the name server-side) so a failed chain leaves no residue.
      await removeCli(id, cliName.trim())
      toast.error(linked?.message ?? t('instances.toastCliCreateFailed'))
      return
    }
    const result = await loginCli(id)
    if (result?.ok) toast.success(t('instances.toastCliLoginOpened'))
    else toast.error(result?.message ?? t('instances.toastCliLoginFailed'))
  } finally {
    const next = new Set(cliSignInBusy.value)
    next.delete(inst.dir)
    cliSignInBusy.value = next
  }
}

// Check every instance's usage concurrently — desktop AND CLI. Each check is a single ~300ms read of
// the quota endpoint (not a `claude` spawn), and the endpoint is neither rate-limited nor
// quota-consuming, so there is no reason to serialize. The user is waiting on this click, so it fans
// out rather than staggering the way the background sweep does.
const refreshingAllUsage = ref(false)
async function onRefreshAllUsage() {
  if (refreshingAllUsage.value) return
  refreshingAllUsage.value = true
  try {
    await Promise.all([
      ...(showDesktopInstances.value ? instances.value.map((i) => checkDesktop(i.dir)) : []),
      ...(showCliInstances.value ? cliInstances.value.map((i) => checkCliUsage(i.id)) : []),
    ])
  } finally {
    refreshingAllUsage.value = false
  }
}

// --- cold-start usage: catch up the readings that have aged out, a couple at a time -------------
// The background usage poll only HYDRATES from the server's cache (a plain read), so something has
// to decide when a real probe is due. This used to be "every instance, right now, all at once" —
// one unbounded Promise.all the moment the lists arrived. Measured 2026-08-07 on a 15-instance
// install: 14 simultaneous probes at t+0.5s, slowest 8.8s, on every open of the app.
//
// That was over-correcting for a cache that is actually warm. The server persists its usage cache
// to disk and re-sweeps on a timer, so an opening window already has numbers on screen; the only
// rows worth a probe are the ones whose reading has aged past USAGE_CATCHUP_MAX_AGE_MS (plus any
// that have no reading at all, which is the genuinely blank cell). Those go out two at a time with
// a stagger — see lib/usage-catchup.ts for the whole rationale.
//
// Desktop and CLI lists arrive on independent polls (and Settings can hide either), so each gets
// its own one-shot guard and watches its show-flag too: a single shared flag, or watching only the
// list, would skip whichever became ready second.
//
// `hydrated` is in the guard because the decision READS the cache: running before the first
// /api/usage/cache response lands would see every snapshot as missing and probe everything, which
// is the exact herd this replaced.
const didInitialDesktopUsage = ref(false)
const didInitialCliUsage = ref(false)
// Aborts both catch-ups if the tab is left while they are still trickling through the queue.
const catchupSignal = { aborted: false }
watch(
  [instances, showDesktopInstances, usageHydrated],
  ([list, show, ready]) => {
    if (didInitialDesktopUsage.value || !show || !ready || list.length === 0) return
    didInitialDesktopUsage.value = true
    const due = selectUsageCatchup(list as CMInstance[], usageFor)
    if (due.length) {
      void runUsageCatchup(due, (i) => checkDesktop(i.dir), { signal: catchupSignal })
    }
  },
  { immediate: true },
)
watch(
  [cliInstances, showCliInstances, usageHydrated],
  ([list, show, ready]) => {
    if (didInitialCliUsage.value || !show || !ready || list.length === 0) return
    didInitialCliUsage.value = true
    const due = selectUsageCatchup(
      list as CliInstance[],
      (i) =>
        // A CLI row carries its own last reading in the list payload; fall back to the shared cache
        // for one that hasn't been folded in yet.
        snapshotFor(`cli:${i.id}`) ?? i.lastUsageCheck,
    )
    if (due.length) {
      void runUsageCatchup(due, (i) => checkCliUsage(i.id), { signal: catchupSignal })
    }
  },
  { immediate: true },
)

async function onOpen(inst: CMInstance) {
  const result = await open(inst.dir)
  if (result?.ok) {
    toast.success(t('instances.toastOpened'))
    // A successful isolated launch is live proof the install is manageable — re-check so a stale
    // "MSIX-only / not installed" banner clears itself instead of waiting on a manual Refresh.
    if (desktopWarning.value) void refreshDesktopInstall(true)
  }
  // Prefer the server's failure message — it explains the MSIX-only case (same convention
  // as the create dialog surfacing result.message).
  else toast.error(result?.message ?? t('instances.toastOpenFailed'))
}

// Quit: the External row is the user's REAL Claude Desktop (maybe mid-conversation) — route it
// through an explicit confirmation dialog; the server independently refuses it without the flag.
const quitExternalOpen = ref(false)
const quitExternalTarget = ref<CMInstance | null>(null)
const quittingExternal = ref(false)
async function onQuit(inst: CMInstance) {
  if (inst.isExternal) {
    quitExternalTarget.value = inst
    quitExternalOpen.value = true
    return
  }
  const ok = await quit(inst.dir)
  if (ok) toast.success(t('instances.toastQuit'))
  else toast.error(t('instances.toastQuitFailed'))
}
async function onQuitExternalConfirm() {
  const inst = quitExternalTarget.value
  if (!inst) return
  quittingExternal.value = true
  try {
    const ok = await quit(inst.dir, { confirmExternal: true })
    if (ok) toast.success(t('instances.toastQuit'))
    else toast.error(t('instances.toastQuitFailed'))
  } finally {
    quittingExternal.value = false
    quitExternalOpen.value = false
    quitExternalTarget.value = null
  }
}
// --- log out: confirmed, and never while the app is running -------------------------------------
const logoutOpen = ref(false)
const logoutTarget = ref<CMInstance | null>(null)
const loggingOut = ref(false)
function openLogoutDialog(inst: CMInstance) {
  logoutTarget.value = inst
  logoutOpen.value = true
}
async function onLogoutConfirm() {
  const inst = logoutTarget.value
  if (!inst) return
  loggingOut.value = true
  try {
    const result = await logout(inst.dir)
    // The server's own message is the useful one on failure: it explains the running-instance
    // refusal, which is the case a person will actually hit.
    if (result?.ok) toast.success(result.message ?? t('instances.toastLoggedOut'))
    else toast.error(result?.message ?? t('instances.toastLogoutFailed'))
  } finally {
    loggingOut.value = false
    logoutOpen.value = false
    logoutTarget.value = null
  }
}

async function onFocus(inst: CMInstance) {
  if (!inst.isRunning || isBusy(inst)) return
  const result = await focus(inst.dir)
  if (result?.ok) toast.success(t('instances.toastFocused'))
  else toast.error(result?.message ?? t('instances.toastFocusFailed'))
}
/** Copy the bare number (not `#7`) — it is what gets pasted straight into an MCP `instance:` arg or
 *  typed at an agent, and both forms resolve anyway. The toast confirms the value because the whole
 *  point of the number is being able to quote it later with confidence. */
function copyInstanceNumber(num: number) {
  navigator.clipboard?.writeText(String(num)).catch(() => {})
  toast.success(t('instances.toastNumberCopied', { num }))
}
async function onRevealFolder(inst: CMInstance) {
  const result = await revealFolder(inst.dir)
  if (!result?.ok) toast.error(result?.message ?? t('instances.toastRevealFailed'))
}
async function onCreateShortcut(inst: CMInstance) {
  if (isBusy(inst)) return
  const result = await createShortcut(inst.dir)
  if (result?.ok) toast.success(t('instances.toastShortcutCreated'))
  // Prefer the server's message — it explains the MSIX-only case, same as onOpen.
  else toast.error(result?.message ?? t('instances.toastShortcutFailed'))
}

function openCreateDialog() {
  createError.value = null
  createOpen.value = true
}
async function onCreateSubmit(name: string) {
  creating.value = true
  createError.value = null
  try {
    const result = await create(name)
    if (result?.ok) {
      toast.success(t('instances.toastCreated'))
      createOpen.value = false
      if (result.needsBrowserDance) toast.info(t('instances.browserDanceBody'))
      // Same self-heal as onOpen: a successful create disproves a stale "not manageable" verdict.
      if (desktopWarning.value) void refreshDesktopInstall(true)
    } else {
      createError.value = result?.message ?? t('instances.toastCreateFailed')
    }
  } finally {
    creating.value = false
  }
}

/**
 * Clear the stored label so the row is named after the account again.
 *
 * `setAppearance` with `label: null` is exactly what the edit dialog sends for an empty field, so
 * this is the same write, just without making the user open a dialog to delete text. Icon and
 * colour are passed through unchanged: they are a separate choice and clearing the name is not a
 * reason to lose the glyph.
 */
async function onUseAccountName(inst: CMInstance) {
  const next = accountDisplayName(inst.account)
  if (!next) return
  const result = await setAppearance(inst.dir, {
    label: null,
    icon: inst.icon,
    color: inst.color,
  })
  if (result?.ok) toast.success(t('instances.toastUsingAccountName', { name: next }))
  else toast.error(result?.message ?? t('instances.toastSaveFailed'))
}

function openEditDialog(inst: CMInstance) {
  editTarget.value = inst
  editError.value = null
  editOpen.value = true
}
/**
 * Persist an appearance edit AS IT HAPPENS, leaving the dialog open.
 *
 * No success toast: this fires on every debounced keystroke, so a toast per change would be a
 * stream of confetti for something the user can already see happening in the row behind the
 * dialog. A FAILURE still has to be said out loud, though — silence there would read as "saved".
 */
async function onEditApply(payload: {
  label: string | null
  icon: CMInstance['icon']
  color: CMInstance['color']
}) {
  const inst = editTarget.value
  if (!inst) return
  editing.value = true
  editError.value = null
  try {
    const result = await setAppearance(inst.dir, payload)
    if (!result?.ok) editError.value = result?.message ?? t('instances.toastSaveFailed')
  } finally {
    editing.value = false
  }
}
/** Closing is not a save (each edit already persisted); it just drops the target. */
function onEditClosed(isOpen: boolean) {
  if (isOpen) return
  editTarget.value = null
  editError.value = null
}

// --- right-click is the kebab -------------------------------------------------------------------
// One menu per row, opened by the ⋮ button OR by right-clicking anywhere on the row (owner ask,
// 2026-09-03: "right click on the instance ... or click the three little dots to trigger the exact
// same effect"). Controlled `open` on the row's DropdownMenu keyed by dir: the kebab's own click
// reports through update:open, and a right-click on another row moves the key, closing this one.
const rowMenuOpen = ref<string | null>(null)

// --- move every active chat on one instance to another -----------------------------------------
// The instance-level version of the session list's migrate: every chat on this account that is
// not archived and not marked done, moved to one other account in one confirmed action. Done rows
// are skipped because the server refuses them as superseded, so leaving them in would trade one
// confirmation for a column of error toasts. A closed destination is opened first: the import has
// to land in a running app, and the rule that nothing opens an account on its own is satisfied by
// the click that chose it.
const moveAll = ref<{ from: CMInstance; to: CMInstance; sessions: SessionSummary[] } | null>(null)
const moveAllBusy = ref(false)
// The same name the table shows: label, else the account's name, else the folder. `label ?? name`
// skipped the middle step and offered "5claude" for the row everyone knows as apebrain.
const instLabel = (i: CMInstance) => displayName(i)
function moveTargets(from: CMInstance): CMInstance[] {
  return instances.value
    .filter((i) => i.dir !== from.dir)
    .sort(
      (a, b) =>
        Number(b.isRunning) - Number(a.isRunning) || instLabel(a).localeCompare(instLabel(b)),
    )
}
// A closed destination is NOT started: the server lands each chat straight in that instance's
// store, settings intact, and the app finds them there when it next starts. That is the whole
// point of moving to a closed account, and it is the one landing that needs no restart afterwards.
async function prepareMoveAll(from: CMInstance, to: CMInstance) {
  // One count at a time. The submenu item is disabled while busy, but a second click can still
  // arrive through a reopened menu, and two overlapping counts share one toast id - the first's
  // dismiss then races the second's loading toast and one of them is left on screen (seen live).
  if (moveAllBusy.value) return
  rowMenuOpen.value = null
  moveAllBusy.value = true
  const id = `move-all-${from.dir}`
  try {
    toast.loading(t('instances.moveChatsCounting'), { id })
    // `instance` is matched server-side against the instance NAME a session's desktop entry records
    // (the same field the session list's isCurrent compares), over all time, live rows only.
    const rows = await getSessions(1000, from.name, 'hide', 'all', 'claude')
    const sessions = rows.filter((s) => !s.done && !s.archived)
    toast.dismiss(id)
    if (sessions.length === 0) {
      toast.info(t('instances.moveChatsNone', { from: instLabel(from) }))
      return
    }
    moveAll.value = { from, to, sessions }
  } catch {
    toast.error(t('instances.moveChatsFailed', { from: instLabel(from) }), { id })
  } finally {
    moveAllBusy.value = false
  }
}
async function runMoveAll() {
  const job = moveAll.value
  if (!job) return
  moveAll.value = null
  moveAllBusy.value = true
  const id = `move-all-${job.from.dir}`
  const ref = `desktop:${job.to.dir}`
  let ok = 0
  const failed: string[] = []
  try {
    // Serial on purpose: each migrate may stop a live run and wait for it, and the desktop app
    // takes imports one at a time anyway.
    for (const [i, s] of job.sessions.entries()) {
      toast.loading(t('instances.moveChatsProgress', { done: i + 1, n: job.sessions.length }), {
        id,
      })
      try {
        // The row's title IS the current title (same listing the server reads), restated as the
        // server's required title decision. A chat whose title is generic is refused by name below.
        const r = await migrateSession(s.session_id, ref, { confirmTitle: s.title })
        if (r.ok) ok++
        else failed.push(`${s.title}: ${r.error ?? 'failed'}`)
      } catch (e) {
        failed.push(`${s.title}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    moveAllBusy.value = false
  }
  if (failed.length) console.warn('[agenthydra] move all chats: some could not be moved', failed)
  const summary = t('instances.moveChatsDone', {
    ok,
    n: job.sessions.length,
    to: instLabel(job.to),
  })
  // Say WHY, not "see the console": the first refusal's own words, and an error rather than a
  // warning when nothing moved at all (sixteen 400s once read as a warning with a zero in it).
  if (failed.length)
    (ok === 0 ? toast.error : toast.warning)(
      `${summary} ${t('instances.moveChatsSomeFailed', { failed: failed.length })} ${failed[0] ?? ''}`,
      {
        id,
      },
    )
  else toast.success(summary, { id })
}

/** A chat in the move list, clicked: close the dialog and land on that chat in Sessions, filtered
 *  to it and selected. The tab switch happens in App.vue; the select happens in SessionsView. */
function openChatFromMoveDialog(s: SessionSummary) {
  moveAll.value = null
  requestSessionJump(s)
}

function openDeleteDialog(inst: CMInstance) {
  deleteTarget.value = inst
  deleteError.value = null
  deleteOpen.value = true
}
async function onDeleteConfirm(confirmName: string) {
  const inst = deleteTarget.value
  if (!inst) return
  deleting.value = true
  deleteError.value = null
  try {
    const result = await remove(inst.dir, confirmName)
    if (result?.ok) {
      toast.success(t('instances.toastDeleted'))
      deleteOpen.value = false
      deleteTarget.value = null
    } else {
      deleteError.value = result?.message ?? t('instances.toastDeleteFailed')
    }
  } finally {
    deleting.value = false
  }
}

function isBusy(inst: CMInstance): boolean {
  // Also busy while a "Sign in CLI" create+link chain is in flight for this row: without this,
  // Delete/Quit on the same row weren't disabled during the chain, so a race could still delete
  // the desktop instance out from under a CLI instance that's about to be linked to it — a ghost
  // in the making even with the create+link double-click guard in place.
  return busyDirs.value.has(inst.dir) || cliSignInBusy.value.has(inst.dir)
}

// Windows ships two Claude Desktop builds; only the classic (Squirrel .exe) one can be
// launched with an isolated profile. Warn when this machine has only the MSIX package
// (or nothing at all) — see server/src/core/desktop-install.ts.
const desktopInstall = ref<CMDesktopInstall | null>(null)
const desktopWarning = computed<{ titleKey: string; bodyKey: string } | null>(() => {
  const d = desktopInstall.value
  if (d?.platform !== 'win32' || d.manageable) return null
  return d.msixDetected
    ? { titleKey: 'instances.desktopMsixTitle', bodyKey: 'instances.desktopMsixBody' }
    : { titleKey: 'instances.desktopNoneTitle', bodyKey: 'instances.desktopNoneBody' }
})

async function refreshDesktopInstall(fresh = false) {
  try {
    desktopInstall.value = await getDesktopInstall({ fresh })
  } catch {
    // Best-effort — keep the last known state (no banner when it never resolved).
  }
}

// While the warning banner is up, re-verify the verdict every 60s (fresh, bypassing the server's
// 5-minute cache): the banner's own instruction is "install the classic build", and following it
// used to leave the stale banner pinned until a manual Refresh. No banner → no polling cost.
let desktopInstallTimer: number | null = null

onMounted(() => {
  startPolling()
  startUsagePolling()
  refreshDesktopInstall()
  desktopInstallTimer = window.setInterval(() => {
    if (desktopWarning.value) void refreshDesktopInstall(true)
  }, 60_000)
})
onUnmounted(() => {
  stopPolling()
  stopUsagePolling()
  // Leaving the tab cancels whatever is still trickling through the catch-up queue: those probes
  // exist to fill in THIS table, and a tab you have navigated away from has no business holding a
  // slow queue of network requests open behind you.
  catchupSignal.aborted = true
  if (desktopInstallTimer !== null) window.clearInterval(desktopInstallTimer)
})
</script>

<template>
  <div class="flex min-h-full flex-col">
    <!-- Borderless toolbar, matching Sessions/Queue and the app header (App.vue): the sticky table
         header right below already draws a line there, and two rules a row apart was one of them
         doing nothing but adding weight. -->
    <div class="flex flex-wrap items-center justify-between gap-2 p-3">
      <!-- The heading doubles as the collapse trigger: someone who lives in the CLI wants this
           table out of the way, and vice versa. Disabled as a trigger when the table is hidden
           outright (Settings → Providers), where there is nothing to collapse. -->
      <button
        type="button"
        class="flex items-center gap-2 rounded-md text-sm font-semibold transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        :disabled="!showDesktopInstances"
        :aria-expanded="desktopOpen"
        @click="desktopOpen = !desktopOpen"
      >
        <Boxes class="size-4" />
        {{ $t('instances.title') }}
        <!-- "x of y" once the usage filter is hiding rows, so the count never silently disagrees
             with the number of instances that exist (same convention as the CLI table's own
             linked-elsewhere shortfall). -->
        <span v-if="showDesktopInstances" class="text-muted-foreground">
          ({{
            hiddenByFilter > 0
              ? $t('instances.countOfTotal', { shown: visibleRows.length, total: instances.length })
              : instances.length
          }})
        </span>
        <span
          v-if="showDesktopInstances && hiddenByFilter > 0"
          class="text-xs font-normal text-muted-foreground"
        >
          {{ $t('instances.usageFilterHiddenCount', { count: hiddenByFilter }) }}
        </span>
        <ChevronDown
          v-if="showDesktopInstances"
          class="size-4 text-muted-foreground transition-transform duration-200"
          :class="desktopOpen ? '' : '-rotate-90'"
        />
      </button>
      <div class="flex flex-wrap items-center gap-1.5">
        <!-- Usage mode: swaps the process columns for the quota ones across the whole tab. Pressed
             (secondary) while on, so the toolbar itself says which set of columns you're looking
             at — the glyph flips too, from a stopwatch (quota/time-to-reset) to a chip (process). -->
        <IconTooltip
          :label="usageMode ? $t('instances.usageModeOff') : $t('instances.usageModeOn')"
          :description="$t('instances.usageModeHint')"
        >
          <Button
            :variant="usageMode ? 'secondary' : 'outline'"
            size="icon"
            :aria-pressed="usageMode"
            :aria-label="usageMode ? $t('instances.usageModeOff') : $t('instances.usageModeOn')"
            @click="toggleUsageMode"
          >
            <component :is="usageMode ? Cpu : Timer" />
          </Button>
        </IconTooltip>
        <!-- The usage filter appears WITH the quota columns and disappears with them, because that
             is exactly when it is allowed to act (see composables/useUsageFilter.ts): a dimmed or
             short table always has the control that explains it visible in the same toolbar. -->
        <UsageFilterMenu v-if="usageMode" />
        <!-- Which tables this tab draws. Settings still has these switches; this is the copy that
             is one click from the gap where a hidden table used to be. -->
        <InstanceSectionsMenu />
        <IconTooltip :label="$t('instances.refresh')" :description="$t('instances.refreshHint')">
          <Button
            variant="outline"
            size="icon"
            :disabled="loading"
            :aria-label="$t('instances.refresh')"
            @click="handleRefresh"
          >
            <RefreshCw :class="loading ? 'animate-spin' : ''" />
          </Button>
        </IconTooltip>
        <IconTooltip
          :label="$t('instances.refreshAllUsage')"
          :description="$t('instances.refreshAllUsageHint')"
        >
          <Button
            variant="outline"
            size="icon"
            :disabled="refreshingAllUsage || (instances.length === 0 && cliInstances.length === 0)"
            :aria-label="$t('instances.refreshAllUsage')"
            @click="onRefreshAllUsage"
          >
            <Gauge :class="refreshingAllUsage ? 'animate-pulse' : ''" />
          </Button>
        </IconTooltip>
        <!-- Plus at rest, label on hover/focus: the toolbar's other controls are already icon-only,
             and a lone labelled button set the row's width for a phrase you only need once.
             Same expanding-pill mechanics as the queue drawer's New run. -->
        <Button
          v-if="showDesktopInstances"
          size="sm"
          class="group/create gap-0 overflow-hidden transition-all"
          :aria-label="$t('instances.createInstance')"
          @click="openCreateDialog"
        >
          <Plus class="shrink-0" />
          <span
            class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/create:ml-1.5 group-hover/create:max-w-[9rem] group-hover/create:opacity-100 group-focus-visible/create:ml-1.5 group-focus-visible/create:max-w-[9rem] group-focus-visible/create:opacity-100"
          >{{ $t('instances.createInstance') }}</span>
        </Button>
      </div>
    </div>

    <div
      v-if="desktopWarning"
      class="flex items-start gap-2 border-b border-border bg-warning/10 px-3 py-2"
    >
      <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
      <div class="min-w-0 text-sm">
        <p class="font-medium text-warning">{{ $t(desktopWarning.titleKey) }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ $t(desktopWarning.bodyKey) }}</p>
        <p class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a
            :href="CLASSIC_DESKTOP_INSTALLER_URL"
            target="_blank"
            rel="noreferrer"
            class="font-medium text-warning underline underline-offset-2"
          >
            {{ $t('instances.desktopWarnDownload') }}
          </a>
          <a
            :href="DESKTOP_DOWNLOAD_PAGE_URL"
            target="_blank"
            rel="noreferrer"
            class="text-muted-foreground underline underline-offset-2"
          >
            {{ $t('instances.desktopWarnAllDownloads') }}
          </a>
        </p>
      </div>
    </div>

    <!-- gap-10, not a divider: the two tables used to abut with a hairline between them, which read
         as one continuous table whose last rows happened to have different columns. A flex gap only
         applies BETWEEN children, so hiding either table leaves no orphan space behind it. -->
    <div class="flex flex-col gap-10">
      <!-- Both tables are hideable (Settings → Providers): plenty of people use only the desktop app,
           or only the CLI, and shouldn't have to look at an empty table for the other. -->
      <!-- ExpandArea, not the kit's ExpandTransition: this table's header is `sticky top-0`, and
           a wrapper with a permanent `overflow: hidden` becomes the scrollport sticky resolves
           against, so the header would silently stop sticking. ExpandArea only clips WHILE the
           transition runs, which is the one moment nothing is being scrolled anyway. -->
      <ExpandArea :open="showDesktopInstances && desktopOpen">
      <Table>
        <TableHeader class="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead
              class="w-10 cursor-pointer select-none"
              :title="tooltipsEnabled ? $t('instances.sortByStatus') : undefined"
              @click="toggleSort('running')"
            >
              <span class="inline-flex items-center gap-0.5">
                ● <ArrowUp v-if="indicatorFor('running') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('running') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <!-- Both header hints exist because these two columns were the source of a real "where
                 do these names even come from?" — one row's Name can be a label you typed, the
                 next row's the account it is signed into, the next its folder, and nothing said
                 which. The rule is now written down where the question gets asked. -->
            <TableHead class="cursor-pointer select-none" @click="toggleSort('name')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colName') }}
                <InfoHint :text="$t('instances.colNameHint')" @click.stop />
                <ArrowUp v-if="indicatorFor('name') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('name') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('account')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colAccount') }}
                <InfoHint :text="$t('instances.colAccountHint')" @click.stop />
                <ArrowUp v-if="indicatorFor('account') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('account') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <!-- Process columns (default mode) … -->
            <template v-if="!usageMode">
              <TableHead class="cursor-pointer select-none" @click="toggleSort('pid')">
                <span class="inline-flex items-center gap-0.5">
                  {{ $t('instances.colPid') }}
                  <ArrowUp v-if="indicatorFor('pid') === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="indicatorFor('pid') === 'desc'" class="size-3" />
                </span>
              </TableHead>
              <TableHead class="cursor-pointer select-none" @click="toggleSort('uptime')">
                <span class="inline-flex items-center gap-0.5">
                  {{ $t('instances.colUptime') }}
                  <ArrowUp v-if="indicatorFor('uptime') === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="indicatorFor('uptime') === 'desc'" class="size-3" />
                </span>
              </TableHead>
              <TableHead class="cursor-pointer select-none" @click="toggleSort('memory')">
                <span class="inline-flex items-center gap-0.5">
                  {{ $t('instances.colMemory') }}
                  <ArrowUp v-if="indicatorFor('memory') === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="indicatorFor('memory') === 'desc'" class="size-3" />
                </span>
              </TableHead>
            </template>
            <!-- … swapped one-for-one for the quota columns in usage mode, so the table keeps its
                 shape and only its subject changes. -->
            <template v-else>
              <TableHead class="cursor-pointer select-none" @click="toggleSort('session')">
                <span class="inline-flex items-center gap-0.5">
                  {{ $t('instances.colSession') }}
                  <ArrowUp v-if="indicatorFor('session') === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="indicatorFor('session') === 'desc'" class="size-3" />
                </span>
              </TableHead>
              <TableHead class="cursor-pointer select-none" @click="toggleSort('weekly')">
                <span class="inline-flex items-center gap-0.5">
                  {{ $t('instances.colWeekly') }}
                  <ArrowUp v-if="indicatorFor('weekly') === 'asc'" class="size-3" />
                  <ArrowDown v-else-if="indicatorFor('weekly') === 'desc'" class="size-3" />
                </span>
              </TableHead>
            </template>
            <TableHead
              v-if="usageMode"
              class="cursor-pointer select-none"
              @click="toggleSort('usageSession')"
            >
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colUsageSession') }}
                <ArrowUp v-if="indicatorFor('usageSession') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('usageSession') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('usage')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colUsage') }}
                <ArrowUp v-if="indicatorFor('usage') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('usage') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('plan')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('instances.colPlan') }}
                <ArrowUp v-if="indicatorFor('plan') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('plan') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="text-right">{{ $t('instances.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <!-- visibleRows, not instances: with "hide" on, the filter can empty a table that still has
             instances in it. Keying the empty branch off the rows actually rendered is what stops
             that landing as a blank tbody with no explanation. -->
        <TableBody v-if="visibleRows.length === 0" class="[&>tr]:transition-colors [&>tr]:duration-200">
          <!-- Usage mode swaps three process columns for two quota ones and adds the 5-hour
               usage chip, which lands back on nine either way. Kept as an expression rather than a
               literal so a future column change cannot silently desync the span from the header. -->
          <TableEmpty v-if="!loading" :colspan="usageMode ? 9 : 9">
            <div class="flex flex-col items-center gap-1 text-center">
              <component :is="allHiddenByFilter ? Funnel : Boxes" class="mb-1 size-6 opacity-40" />
              <p class="font-medium text-foreground">
                {{
                  allHiddenByFilter
                    ? $t('instances.usageFilterAllHidden')
                    : $t('instances.empty')
                }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{
                  allHiddenByFilter
                    ? $t('instances.usageFilterAllHiddenHint')
                    : $t('instances.emptyHint')
                }}
              </p>
            </div>
          </TableEmpty>
          <!-- first-load skeleton rows so the table never looks blank -->
          <TableRow v-for="i in 4" v-else :key="i">
            <TableCell><Skeleton class="size-2 rounded-full" /></TableCell>
            <TableCell>
              <Skeleton class="h-4" :style="{ width: `${9 - (i % 3) * 2}rem` }" />
              <Skeleton class="mt-1.5 h-3 w-44" />
            </TableCell>
            <TableCell><Skeleton class="h-5 w-24" /></TableCell>
            <template v-if="!usageMode">
              <TableCell><Skeleton class="h-3 w-10" /></TableCell>
              <TableCell><Skeleton class="h-3 w-12" /></TableCell>
              <TableCell><Skeleton class="h-3 w-14" /></TableCell>
            </template>
            <template v-else>
              <TableCell><Skeleton class="h-8 w-20" /></TableCell>
              <TableCell><Skeleton class="h-8 w-20" /></TableCell>
              <TableCell><Skeleton class="h-5 w-14" /></TableCell>
            </template>
            <TableCell><Skeleton class="h-5 w-14" /></TableCell>
            <TableCell><Skeleton class="h-5 w-16" /></TableCell>
            <TableCell>
              <div class="flex justify-end"><Skeleton class="h-6 w-20" /></div>
            </TableCell>
          </TableRow>
        </TableBody>
        <TransitionGroup
          v-else
          tag="tbody"
          name="row-fade"
          data-slot="table-body"
          class="[&_tr:last-child]:border-0 [&>tr]:transition-colors [&>tr]:duration-200"
        >
          <!-- Dimmed, not disabled: a filtered-out instance is one you've decided against for now,
               not one you can't touch — every action on the row still works. It does not react to
               the pointer at all, though (no lift on hover, and `hover:bg-transparent` overrides the
               kit row's own hover tint via tailwind-merge): a row that brightens as you sweep past
               it keeps pulling the eye back to the accounts you just told it to set aside, which is
               the opposite of what the filter is for. -->
          <TableRow
            v-for="inst in visibleRows"
            :key="inst.dir"
            class="transition-opacity"
            :class="filterDimmed(usageFor(inst)) ? 'opacity-25 hover:bg-transparent' : ''"
            @contextmenu.prevent="rowMenuOpen = inst.dir"
          >
            <TableCell>
              <!-- per-instance icon (replaces the old status dot); the chosen glyph + color are
                   its identity, and a small pulsing badge on the top-right marks the active state -->
              <span
                class="relative inline-flex size-5 items-center justify-center"
                :title="inst.isRunning ? $t('instances.running') : $t('instances.stopped')"
              >
                <component
                  :is="iconComponent(resolveIconKey(inst))"
                  class="size-[18px]"
                  :style="{ color: colorValue(resolveColorKey(inst)) }"
                  :class="inst.isRunning ? '' : 'opacity-40'"
                />
                <span
                  v-if="inst.isRunning"
                  class="absolute -right-1 -top-1 size-2 rounded-full bg-success ring-2 ring-background animate-pulse"
                />
              </span>
            </TableCell>
            <TableCell class="font-medium">
              <!-- The folder used to sit under the name as a permanent mono sub-line, which made
                   every row two lines tall to show a path nobody reads at rest. It moved into the
                   tooltip, where it is one hover away and costs no height. The tooltip is on EVERY
                   row now, not just running ones, because the folder is what it is really for; the
                   focus hint rides along as the description when clicking would actually focus. -->
              <div class="flex items-center gap-1.5">
                <!-- The permanent number sits BEFORE the name because the name is the untrustworthy
                     half: a profile signed into a different account than the folder it was named
                     after keeps showing the old name, and the number never drifts. -->
                <InstanceNumber :num="inst.num" />
                <IconTooltip
                  :label="inst.dir"
                  :description="inst.isRunning ? $t('instances.focusHint') : undefined"
                >
                  <button
                    v-if="inst.isRunning"
                    type="button"
                    class="cursor-pointer text-left hover:underline"
                    :disabled="isBusy(inst)"
                    @click="onFocus(inst)"
                  >
                    {{ displayName(inst) }}
                  </button>
                  <span v-else class="cursor-default">{{ displayName(inst) }}</span>
                </IconTooltip>
                <Badge v-if="inst.isExternal" variant="outline">{{ $t('instances.external') }}</Badge>
                <!-- The name you typed no longer matches the account this profile is signed into.
                     A label overrides everything and nothing ever re-checked one, so a row goes on
                     being named after an account it left — which is how a folder called `4claude`
                     ends up labelled "3claude". The marker only reports the disagreement; the ⋯
                     menu is where you resolve it, because the override is still yours to keep. -->
                <IconTooltip
                  v-if="labelDisagreesWithAccount(inst)"
                  :label="$t('instances.labelStale')"
                  :description="
                    $t('instances.labelStaleHint', {
                      label: inst.label ?? '',
                      account: accountDisplayName(inst.account) ?? '',
                    })
                  "
                >
                  <span
                    class="inline-flex items-center"
                    :aria-label="$t('instances.labelStale')"
                  >
                    <TriangleAlert class="size-3.5 text-warning" />
                  </span>
                </IconTooltip>
                <!-- A linked CLI login used to be visible NOWHERE on the row — its only trace was
                     the "CLI instances (0 of 1)" shortfall in the table below, which reads as
                     something hiding a row rather than as "it moved up here". An icon costs no row
                     height (the reason the old mono sub-line was removed) and answers "which of
                     these accounts owns the missing CLI login?" at a glance. Indicator only: the
                     actions stay in the ⋯ menu so a stray click can't launch a terminal. -->
                <IconTooltip
                  v-for="cli in linkedClis(inst.dir)"
                  :key="`cli-badge-${cli.id}`"
                  :label="$t('instances.linkedCliTooltip', { name: cli.name })"
                  :description="
                    cli.loggedIn
                      ? $t('instances.linkedCliSignedIn')
                      : $t('instances.linkedCliSignedOut')
                  "
                >
                  <span
                    class="inline-flex items-center"
                    :aria-label="$t('instances.linkedCliBadge')"
                  >
                    <Terminal
                      class="size-3.5"
                      :class="cli.loggedIn ? 'text-muted-foreground' : 'text-warning'"
                    />
                  </span>
                </IconTooltip>
              </div>
              <!-- No inline CLI sub-line here either: it made one row taller than the rest and
                   only ever showed for whichever account happened to be linked. The linked CLI
                   login's ACTIONS (and CLI sign-in for rows without one) live in the actions menu,
                   where EVERY row gets them without cluttering the table; only the badge above,
                   which is what makes the link discoverable at all, sits on the row. -->
            </TableCell>
            <TableCell>
              <!-- No "Resolve" button: every instance resolves itself (see
                   useInstances.autoResolveAccounts), so a missing account is a moment, not a
                   state you act on. The cell shows the account's EMAIL HANDLE — one rule for every
                   row, so this column can be compared down the table; the full address and the
                   Anthropic profile name are one hover away, and the plan/tier is its own column.
                   A logged-out instance still lands here as a badge — its account.label reads
                   "(not logged in)".

                   Clicking it copies the FULL address (the cell only has room for the handle, and
                   the handle is not something you can paste at anything). Only a row with a
                   resolved email becomes a button: a signed-out row has a badge to show and
                   nothing to copy, and a button that does nothing is worse than plain text. -->
              <Badge
                v-if="accountCellName(inst)"
                :as="accountEmail(inst.account) ? 'button' : undefined"
                :type="accountEmail(inst.account) ? 'button' : undefined"
                :variant="accountBadgeVariant(inst)"
                :title="accountTitle(inst)"
                :aria-label="
                  accountEmail(inst.account)
                    ? $t('instances.copyAccountEmailAria', { email: accountEmail(inst.account) })
                    : undefined
                "
                :class="
                  accountEmail(inst.account)
                    ? 'cursor-pointer transition-colors hover:brightness-110'
                    : accountTitle(inst)
                      ? 'cursor-help'
                      : undefined
                "
                @click="copyAccountEmail(inst)"
              >
                {{ accountCellName(inst) }}
              </Badge>
              <span v-else class="text-xs text-muted-foreground">
                {{ $t('instances.resolving') }}
              </span>
            </TableCell>
            <template v-if="!usageMode">
              <TableCell class="mono text-xs text-muted-foreground">{{ inst.pid ?? '—' }}</TableCell>
              <TableCell class="text-xs text-muted-foreground">
                {{ inst.isRunning ? formatUptime(inst.startTime) : '—' }}
              </TableCell>
              <TableCell class="text-xs text-muted-foreground">{{ formatBytes(inst.memoryBytes) }}</TableCell>
            </template>
            <template v-else>
              <!-- A bar, not a bare number: the point of usage mode is scanning ten rows at once
                   for the ones up against a wall, and ten integers all look alike until you read
                   each one. The number stays inside the bar (91 vs 96 is the whole decision), and
                   the countdown under it says when the number stops mattering. -->
              <TableCell class="text-xs">
                <UsageBar
                  v-if="sessionResetFor(inst)"
                  :fill-pct="sessionRemaining(inst)"
                  :variant="sessionWait(inst)"
                  :label="sessionResetFor(inst) ?? ''"
                  :aria-label="$t('instances.resetsIn', { when: sessionResetFor(inst) })"
                />
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
              <TableCell class="text-xs">
                <UsageBar
                  v-if="weeklyResetFor(inst)"
                  :fill-pct="weeklyRemaining(inst)"
                  :variant="weeklyWait(inst)"
                  :label="weeklyResetFor(inst) ?? ''"
                  :aria-label="$t('instances.resetsIn', { when: weeklyResetFor(inst) })"
                />
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
            </template>
            <TableCell v-if="usageMode">
              <UsageBadge
                scope="session"
                :snapshot="usageFor(inst)"
                :checking="isChecking(usageKeyFor(inst))"
                :usage-key="usageKeyFor(inst)"
                @check="onCheckUsage(inst)"
              />
            </TableCell>
            <TableCell>
              <UsageBadge
                :snapshot="usageFor(inst)"
                :checking="isChecking(usageKeyFor(inst))"
                :usage-key="usageKeyFor(inst)"
                @check="onCheckUsage(inst)"
              />
            </TableCell>
            <TableCell>
              <!-- Plan / account type ("Max 20×", "Pro", "Free"), pulled out of the account cell
                   so it reads at a glance and sorts on its own. `account.planLabel` is computed
                   server-side (resolvePlanLabel) so a generic rate-limit tier never leaks here. -->
              <Badge v-if="inst.account?.planLabel" variant="outline">
                {{ inst.account.planLabel }}
              </Badge>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </TableCell>
            <TableCell>
              <div class="flex items-center justify-end gap-1">
                <Button
                  v-if="!inst.isRunning"
                  variant="outline"
                  size="sm"
                  :disabled="isBusy(inst)"
                  @click="onOpen(inst)"
                >
                  <Play /> {{ $t('instances.open') }}
                </Button>
                <!-- running: the primary action is Focus (bring the window forward); Quit moves
                     under the kebab so the common action is one click and the destructive one is deliberate -->
                <!-- The same pulsing green dot the status glyph carries, on the button that only
                     exists while the instance is running. The Actions column is where the eye ends
                     up (it is where you click), and "Open" vs "Focus" is a quiet way to encode
                     running-ness — the dot says it the same way the left of the row already does,
                     so the two cannot be read as different states. -->
                <Button v-else variant="outline" size="sm" :disabled="isBusy(inst)" @click="onFocus(inst)">
                  <span class="relative inline-flex">
                    <AppWindow />
                    <span
                      class="absolute -right-1 -top-1 size-1.5 rounded-full bg-success ring-2 ring-background animate-pulse"
                    />
                  </span>
                  {{ $t('instances.focusShort') }}
                </Button>

                <DropdownMenu
                  :open="rowMenuOpen === inst.dir"
                  @update:open="(v) => (rowMenuOpen = v ? inst.dir : null)"
                >
                  <!-- No tooltip wrapper here: the kebab is self-explanatory, and nesting a
                       TooltipTrigger around the DropdownMenuTrigger swallowed the click so the
                       menu never opened (and the zero-delay tooltip was intrusive). aria-label
                       keeps it accessible. -->
                  <DropdownMenuTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :aria-label="$t('instances.moreActions')"
                    >
                      <EllipsisVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <!-- w-56: without it the menu inherits the tiny kebab trigger's width and
                       "Create desktop shortcut" wraps/clips; a fixed width fits it on one line -->
                  <DropdownMenuContent align="end" class="max-w-56">
                    <!-- The menu leads with WHICH instance it belongs to, by number. On a table of
                         fourteen near-identically named rows, an open kebab menu is otherwise
                         detached from the row it came from — and "Delete" is the wrong item to be
                         unsure about. Copying it here is one click from every row's menu. -->
                    <DropdownMenuLabel class="flex items-center justify-between gap-2 py-1">
                      <span class="font-mono text-xs">{{
                        $t('instances.numberMenuLabel', { num: inst.num })
                      }}</span>
                      <button
                        type="button"
                        class="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        :aria-label="$t('instances.copyNumber')"
                        @click.stop="copyInstanceNumber(inst.num)"
                      >
                        <Copy class="size-3.5" />
                      </button>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <!-- Quit lives here now (the row's primary button is Focus when running);
                         disabled unless running, mirroring the old Focus item's guard -->
                    <DropdownMenuItem
                      :disabled="!inst.isRunning || isBusy(inst)"
                      @click="onQuit(inst)"
                    >
                      <Square /> {{ $t('instances.quit') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="onRevealFolder(inst)">
                      <FolderOpen /> {{ $t('instances.openFolder') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="onCreateShortcut(inst)">
                      <MonitorDown /> {{ $t('instances.createShortcut') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      :disabled="isChecking(usageKeyFor(inst))"
                      @click="onCheckUsage(inst)"
                    >
                      <Gauge /> {{ $t('instances.checkUsage') }}
                    </DropdownMenuItem>
                    <!-- Every active chat on this account, moved to one other account. Running
                         destinations first; a closed one says it will be started. -->
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger :disabled="moveAllBusy">
                        <ArrowRightLeft /> {{ $t('instances.moveChats') }}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent class="max-w-64">
                        <DropdownMenuItem v-if="moveTargets(inst).length === 0" disabled>
                          {{ $t('instances.moveChatsNoTargets') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-for="to in moveTargets(inst)"
                          :key="to.dir"
                          :disabled="moveAllBusy"
                          @click="prepareMoveAll(inst, to)"
                        >
                          <ArrowRightLeft />
                          <span class="flex flex-col">
                            <span>{{ instLabel(to) }}</span>
                            <span class="text-xs text-muted-foreground">
                              {{ to.isRunning ? $t('instances.running') : $t('instances.moveChatsClosedLands') }}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <!-- CLI section, on EVERY row: a desktop instance and its CLI login are the
                         same Anthropic account signed in twice. With a linked CLI instance the
                         items act on it (Launch / Sign in + Unlink); without one, "Add a CLI
                         login…" creates + links one on demand and opens the /login terminal. That
                         item is worded as a CREATE, not as a sign-in: it used to share the exact
                         label of the plain sign-in above, so clicking it silently produced a new
                         managed instance and the only visible consequence was the CLI table below
                         quietly reading "0 of 1". -->
                    <DropdownMenuSeparator />
                    <template v-if="linkedCliFor(inst.dir)">
                      <template v-for="cli in linkedClis(inst.dir)" :key="`cli-${cli.id}`">
                        <DropdownMenuItem v-if="cli.loggedIn" @click="onLaunchCli(cli)">
                          <Terminal /> {{ $t('instances.launchCli') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem v-else @click="onLoginCli(cli)">
                          <LogIn /> {{ $t('instances.loginCli') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @click="onUnlinkCli(cli)">
                          <Unlink /> {{ $t('instances.unlinkCli') }}
                        </DropdownMenuItem>
                      </template>
                    </template>
                    <DropdownMenuItem
                      v-else
                      :disabled="cliSignInBusy.has(inst.dir)"
                      @click="onSignInCli(inst)"
                    >
                      <LogIn /> {{ $t('instances.addCli') }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <!-- Edit (name + icon + color) is pure UI metadata, so it stays enabled even
                         while the instance runs (unlike Delete, which touches the folder) -->
                    <!-- Drop the typed name and let the row be called after the account again.
                         Offered on every labelled row, not only the mismatched ones, because "go
                         back to the account name" is a thing you want on purpose — but it is the
                         mismatched rows the warning marker sends here. -->
                    <DropdownMenuItem
                      v-if="inst.label"
                      :disabled="isBusy(inst) || !accountDisplayName(inst.account)"
                      @click="onUseAccountName(inst)"
                    >
                      <UserRound /> {{ $t('instances.useAccountName') }}
                    </DropdownMenuItem>
                    <!-- Sign this profile out. Disabled while it is RUNNING, because the server
                         refuses it then anyway (Claude Desktop holds config.json open and would
                         undo or corrupt the write) - better to say so on the item than to let the
                         click produce an error toast. -->
                    <DropdownMenuItem
                      :disabled="inst.isRunning || isBusy(inst)"
                      @click="openLogoutDialog(inst)"
                    >
                      <LogOut /> {{ $t('instances.logout') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      :disabled="isBusy(inst)"
                      @click="openEditDialog(inst)"
                    >
                      <Pencil /> {{ $t('instances.edit') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      :disabled="inst.isRunning || isBusy(inst)"
                      @click="openDeleteDialog(inst)"
                    >
                      <Trash2 /> {{ $t('instances.delete') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        </TransitionGroup>
      </Table>
      </ExpandArea>

      <CliInstancesSection v-if="showCliInstances" />
      <CodexInstancesSection
        v-if="codexDesktopEnabled || codexCliEnabled"
        :desktop-enabled="codexDesktopEnabled"
        :cli-enabled="codexCliEnabled"
      />
    </div>

    <!-- "Move all chats" confirmation: the count, both accounts, the list, and a second click. -->
    <Dialog :open="moveAll !== null" @update:open="(v) => { if (!v) moveAll = null }">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {{ $t('instances.moveChatsConfirmTitle', { n: moveAll?.sessions.length ?? 0, from: moveAll ? instLabel(moveAll.from) : '', to: moveAll ? instLabel(moveAll.to) : '' }) }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('instances.moveChatsConfirmBody', { from: moveAll ? instLabel(moveAll.from) : '', to: moveAll ? instLabel(moveAll.to) : '' }) }}
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">{{ $t('instances.moveChatsRowHint') }}</p>
        <!-- Grouped by project, largest group first, so the SHAPE of the move is visible before the
             click. Each row opens that chat in Sessions (filtered to it, selected). -->
        <ul class="scroll-slim max-h-56 space-y-2 overflow-y-auto text-xs">
          <li v-for="g in groupByProject(moveAll?.sessions ?? [])" :key="g.project">
            <div class="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
              <span class="truncate">{{ g.project }}</span>
              <span class="shrink-0">{{ $t('instances.moveChatsGroupCount', { n: g.sessions.length }) }}</span>
            </div>
            <ul class="space-y-1">
              <li v-for="s in g.sessions" :key="s.session_id">
                <button
                  type="button"
                  class="w-full truncate rounded border border-border px-2 py-1 text-left hover:bg-accent"
                  @click="openChatFromMoveDialog(s)"
                >
                  {{ s.title }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" @click="moveAll = null">{{ $t('instances.moveChatsCancel') }}</Button>
          <Button :disabled="moveAllBusy || !moveAll?.sessions.length" @click="runMoveAll">
            {{ $t('instances.moveChatsConfirmSubmit', { n: moveAll?.sessions.length ?? 0 }) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <CreateInstanceDialog
      v-model:open="createOpen"
      :submitting="creating"
      :error-message="createError"
      @submit="onCreateSubmit"
    />
    <DeleteInstanceDialog
      v-model:open="deleteOpen"
      :instance-name="deleteTarget?.name ?? null"
      :submitting="deleting"
      :error-message="deleteError"
      @confirm="onDeleteConfirm"
    />
    <QuitExternalInstanceDialog
      v-model:open="quitExternalOpen"
      :instance-name="quitExternalTarget ? displayName(quitExternalTarget) : null"
      :submitting="quittingExternal"
      @confirm="onQuitExternalConfirm"
    />
    <!-- instance-name is the placeholder for an empty name field, so it shows the ACCOUNT name
         where there is one rather than the folder: an empty field means "name it after the
         account" (displayName), and the placeholder should show what leaving it empty
         actually gets you. The folder name is the fallback, same as displayName's. -->
    <LogoutInstanceDialog
      v-model:open="logoutOpen"
      :instance-name="logoutTarget ? displayName(logoutTarget) : null"
      :account-email="accountEmail(logoutTarget?.account)"
      :submitting="loggingOut"
      @confirm="onLogoutConfirm"
    />
    <EditInstanceDialog
      v-model:open="editOpen"
      :instance-name="accountDisplayName(editTarget?.account) ?? editTarget?.name ?? null"
      :dir="editTarget?.dir ?? null"
      :current-label="editTarget?.label ?? null"
      :current-icon="editTarget?.icon ?? null"
      :current-color="editTarget?.color ?? null"
      :submitting="editing"
      :error-message="editError"
      @apply="onEditApply"
      @update:open="onEditClosed"
    />
  </div>
</template>

<style scoped>
.row-fade-enter-active,
.row-fade-leave-active {
  transition:
    opacity 200ms ease,
    transform 200ms ease;
}
.row-fade-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.row-fade-leave-to {
  opacity: 0;
}
.row-fade-leave-active {
  position: relative;
}
.row-fade-move {
  transition: transform 200ms ease;
}
</style>
