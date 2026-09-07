<script setup lang="ts">
// CLI Instances: the table of CLI logins that DON'T belong to a desktop instance yet.
// A "CLI instance" is an isolated CLAUDE_CONFIG_DIR the daemon can run a real `claude` against (as
// opposed to a Claude Desktop profile).
//
// This table used to list every CLI instance. It no longer does: once one is LINKED to a desktop
// instance it is the same Anthropic account signed in twice, so it moves UP onto that account's row
// in InstancesView and disappears from here. Listing it in both places was the half-measure that
// made the "unified per-account view" not actually unified. Full lifecycle (create / rename /
// associate / delete) still lives here; the account row carries launch / sign-in / unlink.
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  EllipsisVertical,
  Funnel,
  Link2,
  LogIn,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AssociateCliInstanceDialog from '@/components/AssociateCliInstanceDialog.vue'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteCliInstanceDialog from '@/components/DeleteCliInstanceDialog.vue'
import ExpandArea from '@/components/ExpandArea.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import LinkCliInstanceDialog from '@/components/LinkCliInstanceDialog.vue'
import UsageBadge from '@/components/UsageBadge.vue'
import UsageBar from '@/components/UsageBar.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { useCliInstances } from '@/composables/useCliInstances'
import { useData } from '@/composables/useData'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { useInstances } from '@/composables/useInstances'
import { useSortable } from '@/composables/useSortable'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import { useUsageMode } from '@/composables/useUsageMode'
import type { CliInstance } from '@/lib/api'
import { bindingWeeklyPct, usageReasonMessageKey } from '@/lib/usage'
import {
  msUntilReset,
  resetLabel,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  waitSeverity,
  windowRemainingPct,
} from '@/lib/usage-reset'

const {
  cliInstances,
  loading,
  busyIds,
  startPolling,
  stopPolling,
  refreshCliInstances,
  create,
  launch,
  login,
  rename,
  associate,
  linkDesktop,
  remove,
  checkUsage,
} = useCliInstances()
const { snapshotFor, isChecking, checkCli, reasonFor } = useUsage()
const { accounts, refreshAccounts } = useData()
// The desktop instances are the link targets. useInstances is a module singleton already loaded by
// InstancesView above us, so this is a read of the same list, not a second fetch.
const { instances: desktopInstances } = useInstances()

const { t } = useI18n()

const usageKey = (inst: CliInstance) => `cli:${inst.id}`
const usageFor = (inst: CliInstance) => snapshotFor(usageKey(inst))

// Usage mode is a TAB-WIDE mode, not a per-table one (see composables/useUsageMode.ts): the toolbar
// toggle up in InstancesView flips this table too, because "how much quota is left" is a question
// you ask of every instance at once. Here the swap trades the config-dir column — the least useful
// thing on screen when you're asking about quota — for the two reset countdowns.
const { usageMode, now } = useUsageMode(true)
const sessionResetFor = (inst: CliInstance) => resetLabel(usageFor(inst)?.session, now.value)
const weeklyResetFor = (inst: CliInstance) => resetLabel(usageFor(inst)?.weekAll, now.value)
// One number per window drives the bar's length; the WEEKLY one also drives its colour, and the
// 5-hour bar is drawn `neutral` — see InstancesView and UsageBar's UsageBarVariant.
const sessionRemaining = (inst: CliInstance) =>
  windowRemainingPct(usageFor(inst)?.session, SESSION_WINDOW_MS, now.value) ?? 0
const weeklyRemaining = (inst: CliInstance) =>
  windowRemainingPct(usageFor(inst)?.weekAll, WEEK_WINDOW_MS, now.value) ?? 0
const weeklyWait = (inst: CliInstance) => waitSeverity(weeklyRemaining(inst))

/**
 * ONLY the UNLINKED CLI instances live in this table.
 *
 * A CLI instance that has been linked to a desktop instance is the same Anthropic account signed in
 * twice, so it belongs to that account, not to a separate list. It is rendered on its desktop
 * instance's row up in InstancesView (that row IS the account) and is deliberately NOT repeated
 * here — showing it in both places is duplication, not a unified view. "Unlink" on the account row
 * sends it back down here.
 *
 * "Unlinked" also covers a CLI instance whose associatedDesktopDir no longer matches any CURRENTLY
 * existing desktop instance — a ghost link. removeInstance() clears the link server-side when its
 * desktop instance is deleted (core/lifecycle.ts), but checking desktopInstances here too is a
 * frontend backstop: if that cleanup were ever bypassed, a CLI instance pointing at a vanished
 * desktop dir would otherwise stay "linked" forever — hidden from this table with no row left to
 * show it, and so unmanageable. Comparing against the live desktop list guarantees it always
 * surfaces somewhere.
 */
const unlinkedCliInstances = computed(() => {
  const desktopDirs = new Set(desktopInstances.value.map((i) => i.dir))
  return cliInstances.value.filter(
    (c) => !c.associatedDesktopDir || !desktopDirs.has(c.associatedDesktopDir),
  )
})
/** How many moved up onto a desktop instance's row (so the header can explain the shortfall). */
const linkedCount = computed(() => cliInstances.value.length - unlinkedCliInstances.value.length)

const { sortedRows, toggleSort, indicatorFor } = useSortable(
  () => unlinkedCliInstances.value,
  [
    { key: 'loggedIn', accessor: (i: CliInstance) => i.loggedIn },
    { key: 'name', accessor: (i: CliInstance) => i.name },
    { key: 'account', accessor: (i: CliInstance) => i.associatedAccountLabel ?? null },
    { key: 'configDir', accessor: (i: CliInstance) => i.configDir },
    // Usage-mode columns — by time remaining, so "soonest reset first" is what a sort gives you.
    {
      key: 'session',
      accessor: (i: CliInstance) => msUntilReset(usageFor(i)?.session, now.value) ?? undefined,
    },
    {
      key: 'weekly',
      accessor: (i: CliInstance) => msUntilReset(usageFor(i)?.weekAll, now.value) ?? undefined,
    },
    {
      key: 'usage',
      accessor: (i: CliInstance) => {
        const snap = usageFor(i)
        return snap ? (bindingWeeklyPct(snap) ?? undefined) : undefined
      },
    },
    { key: 'usageSession', accessor: (i: CliInstance) => usageFor(i)?.session?.pct ?? undefined },
  ],
)

// The filter is tab-wide too (composables/useInstanceFilter.ts): "show me the rows I'm after" is
// asked of every table at once, so a CLI login over the quota threshold is set aside here on
// exactly the same terms as a desktop instance up above.
const { dimmed: filterDimmed, visible: filterVisible } = useInstanceFilter()

/**
 * What one CLI row is, as far as the filter is concerned.
 *
 * `open` is deliberately absent, not `false`: an unlinked CLI login is a CLAUDE_CONFIG_DIR, not an
 * app, so it is never open OR closed, and the filter's "an unknown fact never sets a row aside"
 * rule leaves this table alone when you filter by status. Claiming `false` would empty it the
 * moment someone asked for the open accounts. Its plan is unknown for the same kind of reason —
 * a CLI login carries no account record of its own; the linked ones live on their desktop row,
 * which has the plan.
 */
const filterFacts = (inst: CliInstance) => ({ usage: usageFor(inst), signedIn: inst.loggedIn })

const visibleRows = computed(() => filterVisible(sortedRows.value, filterFacts))
/** Rows this table dropped for the filter — said out loud in the heading beside the count. */
const hiddenByFilter = computed(() => sortedRows.value.length - visibleRows.value.length)
/** There ARE unlinked CLI instances, the filter just took all of them. */
const allHiddenByFilter = computed(
  () => unlinkedCliInstances.value.length > 0 && visibleRows.value.length === 0,
)

/**
 * The heading's parenthetical. "x of y" whenever this table is showing fewer rows than there are
 * CLI instances — for either reason, a linked one that moved up onto its account row or one the
 * usage filter set aside. A bare "(0)" read as "you have no CLI instances" to someone who could
 * plainly see one elsewhere, which is the whole reason this says the total.
 */
const headingCount = computed(() =>
  visibleRows.value.length === cliInstances.value.length
    ? String(cliInstances.value.length)
    : t('cliInstances.countOfTotal', {
        shown: visibleRows.value.length,
        total: cliInstances.value.length,
      }),
)

function isBusy(inst: CliInstance): boolean {
  return busyIds.value.has(inst.id)
}

// Persisted collapse state, matching the Instances table's own (composables/useUiPrefs.ts).
const { cliOpen } = useUiPrefs()

// --- create ---
const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
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
      toast.success(t('cliInstances.toastCreated'))
      createOpen.value = false
    } else {
      createError.value = result?.message ?? t('cliInstances.toastCreateFailed')
    }
  } finally {
    creating.value = false
  }
}

// --- rename ---
const renameOpen = ref(false)
const renameTarget = ref<CliInstance | null>(null)
const renaming = ref(false)
const renameError = ref<string | null>(null)
function openRenameDialog(inst: CliInstance) {
  renameTarget.value = inst
  renameError.value = null
  renameOpen.value = true
}
async function onRenameSubmit(name: string) {
  const inst = renameTarget.value
  if (!inst) return
  renaming.value = true
  renameError.value = null
  try {
    const result = await rename(inst.id, name)
    if (result?.ok) {
      toast.success(t('cliInstances.toastRenamed'))
      renameOpen.value = false
      renameTarget.value = null
    } else {
      renameError.value = result?.message ?? t('cliInstances.toastRenameFailed')
    }
  } finally {
    renaming.value = false
  }
}

// --- associate ---
const associateOpen = ref(false)
const associateTarget = ref<CliInstance | null>(null)
const associating = ref(false)
const associateError = ref<string | null>(null)
function openAssociateDialog(inst: CliInstance) {
  associateTarget.value = inst
  associateError.value = null
  associateOpen.value = true
  void refreshAccounts()
}
async function onAssociateSubmit(accountId: string | null) {
  const inst = associateTarget.value
  if (!inst) return
  associating.value = true
  associateError.value = null
  try {
    const result = await associate(inst.id, accountId)
    if (result?.ok) {
      toast.success(t('cliInstances.toastAssociated'))
      associateOpen.value = false
      associateTarget.value = null
    } else {
      associateError.value = result?.message ?? t('cliInstances.toastAssociateFailed')
    }
  } finally {
    associating.value = false
  }
}

// --- link to a desktop instance ---
const linkOpen = ref(false)
const linkTarget = ref<CliInstance | null>(null)
const linking = ref(false)
const linkError = ref<string | null>(null)
function openLinkDialog(inst: CliInstance) {
  linkTarget.value = inst
  linkError.value = null
  linkOpen.value = true
}
async function onLinkSubmit(desktopDir: string | null) {
  const inst = linkTarget.value
  if (!inst) return
  linking.value = true
  linkError.value = null
  try {
    const result = await linkDesktop(inst.id, desktopDir)
    if (result?.ok) {
      toast.success(desktopDir ? t('cliInstances.toastLinked') : t('cliInstances.toastUnlinked'))
      linkOpen.value = false
      linkTarget.value = null
    } else {
      linkError.value = result?.message ?? t('cliInstances.toastLinkFailed')
    }
  } finally {
    linking.value = false
  }
}

// --- delete ---
const deleteOpen = ref(false)
const deleteTarget = ref<CliInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
function openDeleteDialog(inst: CliInstance) {
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
    const result = await remove(inst.id, confirmName)
    if (result?.ok) {
      toast.success(t('cliInstances.toastDeleted'))
      deleteOpen.value = false
      deleteTarget.value = null
    } else {
      deleteError.value = result?.message ?? t('cliInstances.toastDeleteFailed')
    }
  } finally {
    deleting.value = false
  }
}

// --- launch / login / check usage ---
async function onLaunch(inst: CliInstance) {
  const result = await launch(inst.id)
  if (result?.ok) toast.success(t('cliInstances.toastLaunched'))
  else toast.error(result?.message ?? t('cliInstances.toastLaunchFailed'))
}
/** Copy the bare number — same behavior as the desktop table's menu (see InstancesView). */
function copyInstanceNumber(num: number) {
  navigator.clipboard?.writeText(String(num)).catch(() => {})
  toast.success(t('instances.toastNumberCopied', { num }))
}
async function onLogin(inst: CliInstance) {
  const result = await login(inst.id)
  if (result?.ok) toast.success(t('cliInstances.toastLoginOpened'))
  else toast.error(result?.message ?? t('cliInstances.toastLoginFailed'))
}
async function onCheckUsage(inst: CliInstance) {
  const ok = await checkUsage(inst.id)
  if (!ok) {
    toast.error(t('cliInstances.toastUsageCheckFailed'))
    return
  }
  // The API call itself can succeed while still coming back with no usable numbers (no
  // login yet, no associated account, or the probe returned nothing). A manual click should
  // never go silent; a real result just updates the cell instead.
  const reasonKey = usageReasonMessageKey(reasonFor(usageKey(inst)))
  if (reasonKey) toast.error(t(reasonKey))
}
// The popover's inline "Check now" fires the same underlying probe as the kebab action, via
// useUsage.checkCli directly. checkUsage() above additionally refreshes the list (so
// lastUsageCheck / other fields stay current), which the popover doesn't need on its own.
async function onCheckUsageFromPopover(inst: CliInstance) {
  const ok = await checkCli(inst.id)
  if (!ok) {
    toast.error(t('cliInstances.toastUsageCheckFailed'))
  } else {
    const reasonKey = usageReasonMessageKey(reasonFor(usageKey(inst)))
    if (reasonKey) toast.error(t(reasonKey))
  }
  void refreshCliInstances({ silent: true })
}

const associateAccountOptions = computed(() => accounts.value)

onMounted(startPolling)
onUnmounted(stopPolling)
</script>

<template>
  <!-- No border-t: the parent (InstancesView) separates its two tables with space instead. That
       hairline sat flush against the desktop table's last row, so the two tables read as one. -->
  <div>
    <!-- Borderless toolbar, same as the Instances one above it — the table header below draws the
         only line this heading needs. -->
    <div class="flex flex-wrap items-center justify-between gap-2 p-3">
      <!-- Heading doubles as the collapse trigger, mirroring the Instances table above. -->
      <button
        type="button"
        class="flex items-center gap-2 rounded-md text-sm font-semibold transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        :aria-expanded="cliOpen"
        @click="cliOpen = !cliOpen"
      >
        <Terminal class="size-4" />
        {{ $t('cliInstances.title') }}
        <!-- "(0)" on its own read as "you have no CLI instances" to someone who could see one in
             the quick-instances window — the linked ones are simply rendered on their account row
             instead. Saying "0 of 1" makes the shortfall self-explanatory even while collapsed,
             which is when the chips below are hidden. (See headingCount: the usage filter can now
             cause the same shortfall, and it reads the same way.) -->
        <span class="text-muted-foreground">({{ headingCount }})</span>
        <!-- Linked ones aren't missing, they've moved up onto their account's row. Say so, or their
             absence from this count reads as a bug. -->
        <span v-if="linkedCount > 0" class="text-xs font-normal text-muted-foreground">
          {{ $t('cliInstances.linkedElsewhere', { count: linkedCount }) }}
        </span>
        <span v-if="hiddenByFilter > 0" class="text-xs font-normal text-muted-foreground">
          {{ $t('instances.filterHiddenCount', { count: hiddenByFilter }) }}
        </span>
        <ChevronDown
          class="size-4 text-muted-foreground transition-transform duration-200"
          :class="cliOpen ? '' : '-rotate-90'"
        />
      </button>
      <div class="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          :disabled="loading"
          :aria-label="$t('cliInstances.refresh')"
          :title="$t('cliInstances.refresh')"
          @click="refreshCliInstances()"
        >
          <RefreshCw :class="loading ? 'animate-spin' : ''" />
        </Button>
        <!-- Plus at rest, label on hover/focus — same expanding pill as Instances and New run. -->
        <Button
          size="sm"
          class="group/create gap-0 overflow-hidden transition-all"
          :aria-label="$t('cliInstances.createInstance')"
          @click="openCreateDialog"
        >
          <Plus class="shrink-0" />
          <span
            class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/create:ml-1.5 group-hover/create:max-w-[9rem] group-hover/create:opacity-100 group-focus-visible/create:ml-1.5 group-focus-visible/create:max-w-[9rem] group-focus-visible/create:opacity-100"
          >{{ $t('cliInstances.createInstance') }}</span>
        </Button>
      </div>
    </div>

    <!-- ExpandArea rather than the kit's ExpandTransition, for the same reason as the Instances
         table: a permanently overflow-hidden wrapper would break this table's `sticky top-0`
         header. ExpandArea only clips while the transition is actually running. -->
    <ExpandArea :open="cliOpen">
    <Table>
        <TableHeader class="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead class="w-10 cursor-pointer select-none" @click="toggleSort('loggedIn')">
              <span class="inline-flex items-center gap-0.5">
                ● <ArrowUp v-if="indicatorFor('loggedIn') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('loggedIn') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('name')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('cliInstances.colName') }}
                <ArrowUp v-if="indicatorFor('name') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('name') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="cursor-pointer select-none" @click="toggleSort('account')">
              <span class="inline-flex items-center gap-0.5">
                {{ $t('cliInstances.colAccount') }}
                <ArrowUp v-if="indicatorFor('account') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('account') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead
              v-if="!usageMode"
              class="cursor-pointer select-none"
              @click="toggleSort('configDir')"
            >
              <span class="inline-flex items-center gap-0.5">
                {{ $t('cliInstances.colConfigDir') }}
                <ArrowUp v-if="indicatorFor('configDir') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('configDir') === 'desc'" class="size-3" />
              </span>
            </TableHead>
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
                {{ $t('cliInstances.colUsage') }}
                <ArrowUp v-if="indicatorFor('usage') === 'asc'" class="size-3" />
                <ArrowDown v-else-if="indicatorFor('usage') === 'desc'" class="size-3" />
              </span>
            </TableHead>
            <TableHead class="text-right">{{ $t('cliInstances.colActions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <!-- visibleRows, not unlinkedCliInstances: with the usage filter set to hide, this table can
             be emptied while it still has rows to show, and a blank tbody explains nothing. -->
        <TableBody v-if="visibleRows.length === 0">
          <TableEmpty v-if="!loading" :colspan="usageMode ? 8 : 6">
            <div class="flex flex-col items-center gap-1 text-center">
              <component :is="allHiddenByFilter ? Funnel : Terminal" class="mb-1 size-6 opacity-40" />
              <p class="font-medium text-foreground">
                {{
                  allHiddenByFilter
                    ? $t('instances.filterAllHidden')
                    : linkedCount > 0
                      ? $t('cliInstances.allLinked')
                      : $t('cliInstances.empty')
                }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{
                  allHiddenByFilter
                    ? $t('instances.filterAllHiddenHint')
                    : linkedCount > 0
                      ? $t('cliInstances.allLinkedHint')
                      : $t('cliInstances.emptyHint')
                }}
              </p>
            </div>
          </TableEmpty>
          <TableRow v-for="i in 2" v-else :key="i">
            <TableCell><Skeleton class="size-2 rounded-full" /></TableCell>
            <TableCell><Skeleton class="h-4 w-28" /></TableCell>
            <TableCell><Skeleton class="h-5 w-20" /></TableCell>
            <TableCell v-if="!usageMode"><Skeleton class="h-3 w-32" /></TableCell>
            <template v-else>
              <TableCell><Skeleton class="h-8 w-16" /></TableCell>
              <TableCell><Skeleton class="h-8 w-16" /></TableCell>
              <TableCell><Skeleton class="h-5 w-14" /></TableCell>
            </template>
            <TableCell><Skeleton class="h-5 w-14" /></TableCell>
            <TableCell>
              <div class="flex justify-end"><Skeleton class="h-6 w-20" /></div>
            </TableCell>
          </TableRow>
        </TableBody>
        <TableBody v-else>
          <!-- Dimmed, never disabled, and inert to the pointer — same contract as the desktop table
               above: a filtered row is one you've set aside, not one you've lost access to, and it
               shouldn't light up every time the cursor crosses it. -->
          <TableRow
            v-for="inst in visibleRows"
            :key="inst.id"
            class="transition-opacity"
            :class="filterDimmed(filterFacts(inst)) ? 'opacity-25 hover:bg-transparent' : ''"
          >
            <TableCell>
              <span
                class="inline-block size-2 rounded-full"
                :class="inst.loggedIn ? 'bg-success' : 'bg-muted-foreground/40'"
                :title="inst.loggedIn ? $t('cliInstances.loggedIn') : $t('cliInstances.loggedOut')"
              />
            </TableCell>
            <TableCell class="font-medium">
              <!-- Same chip as the desktop table on purpose: the number comes from ONE sequence
                   spanning all three instance families, so it must look identical everywhere or
                   that guarantee stops being obvious. -->
              <div class="flex items-center gap-1.5">
                <InstanceNumber :num="inst.num" />
                <span>{{ inst.name }}</span>
              </div>
            </TableCell>
            <TableCell>
              <Badge v-if="inst.associatedAccountLabel" variant="outline">
                {{ inst.associatedAccountLabel }}
              </Badge>
              <span v-else class="text-xs text-muted-foreground">{{ $t('cliInstances.noAccount') }}</span>
            </TableCell>
            <TableCell
              v-if="!usageMode"
              class="mono max-w-[16rem] truncate text-[0.625rem] text-muted-foreground"
            >
              {{ inst.configDir }}
            </TableCell>
            <template v-else>
              <TableCell class="text-xs">
                <UsageBar
                  v-if="sessionResetFor(inst)"
                  :fill-pct="sessionRemaining(inst)"
                  variant="neutral"
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
                :checking="isChecking(usageKey(inst)) || isBusy(inst)"
                :usage-key="usageKey(inst)"
                @check="onCheckUsageFromPopover(inst)"
              />
            </TableCell>
            <TableCell>
              <UsageBadge
                :snapshot="usageFor(inst)"
                :checking="isChecking(usageKey(inst)) || isBusy(inst)"
                :usage-key="usageKey(inst)"
                @check="onCheckUsageFromPopover(inst)"
              />
            </TableCell>
            <TableCell>
              <div class="flex items-center justify-end gap-1">
                <Button variant="outline" size="sm" :disabled="isBusy(inst)" @click="onLaunch(inst)">
                  <Play /> {{ $t('cliInstances.launch') }}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      :aria-label="$t('cliInstances.moreActions')"
                    >
                      <EllipsisVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="max-w-56">
                    <!-- Which instance this menu belongs to, by number — see the desktop table's
                         menu for why an open kebab needs to say so. -->
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
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="onLogin(inst)">
                      <LogIn /> {{ $t('cliInstances.login') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="openLinkDialog(inst)">
                      <Monitor /> {{ $t('cliInstances.linkDesktop') }}
                    </DropdownMenuItem>
                    <!-- "Associate account" points a CLI instance at a LEGACY pasted credential.
                         With none saved (the norm now — accounts come from signing in instances),
                         the dialog is an empty dead end, so hide it until such a credential exists.
                         "Link to desktop instance" above is the primary path either way. -->
                    <DropdownMenuItem
                      v-if="associateAccountOptions.length > 0"
                      :disabled="isBusy(inst)"
                      @click="openAssociateDialog(inst)"
                    >
                      <Link2 /> {{ $t('cliInstances.associate') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="openRenameDialog(inst)">
                      <Pencil /> {{ $t('cliInstances.rename') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isBusy(inst)" @click="onCheckUsage(inst)">
                      <RefreshCw /> {{ $t('cliInstances.checkUsage') }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      :disabled="isBusy(inst)"
                      @click="openDeleteDialog(inst)"
                    >
                      <Trash2 /> {{ $t('cliInstances.delete') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ExpandArea>

    <CliInstanceNameDialog
      v-model:open="createOpen"
      mode="create"
      :submitting="creating"
      :error-message="createError"
      @submit="onCreateSubmit"
    />
    <CliInstanceNameDialog
      v-model:open="renameOpen"
      mode="rename"
      :current-name="renameTarget?.name ?? null"
      :submitting="renaming"
      :error-message="renameError"
      @submit="onRenameSubmit"
    />
    <AssociateCliInstanceDialog
      v-model:open="associateOpen"
      :instance-name="associateTarget?.name ?? null"
      :accounts="associateAccountOptions"
      :current-account-id="associateTarget?.associatedAccountId ?? null"
      :submitting="associating"
      :error-message="associateError"
      @submit="onAssociateSubmit"
    />
    <LinkCliInstanceDialog
      v-model:open="linkOpen"
      :instance-name="linkTarget?.name ?? null"
      :desktop-instances="desktopInstances"
      :current-desktop-dir="linkTarget?.associatedDesktopDir ?? null"
      :submitting="linking"
      :error-message="linkError"
      @submit="onLinkSubmit"
    />
    <DeleteCliInstanceDialog
      v-model:open="deleteOpen"
      :instance-name="deleteTarget?.name ?? null"
      :submitting="deleting"
      :error-message="deleteError"
      @confirm="onDeleteConfirm"
    />
  </div>
</template>
