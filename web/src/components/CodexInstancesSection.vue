<script setup lang="ts">
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  EllipsisVertical,
  Funnel,
  LogIn,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import CliInstanceNameDialog from '@/components/CliInstanceNameDialog.vue'
import DeleteCliInstanceDialog from '@/components/DeleteCliInstanceDialog.vue'
import ExpandArea from '@/components/ExpandArea.vue'
import InstanceNumber from '@/components/InstanceNumber.vue'
import UsageBadge from '@/components/UsageBadge.vue'
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
import { useCodexInstances } from '@/composables/useCodexInstances'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { useSortable } from '@/composables/useSortable'
import { useUiPrefs } from '@/composables/useUiPrefs'
import { useUsage } from '@/composables/useUsage'
import type { CodexInstance } from '@/lib/api'
import type { InstanceFacts } from '@/lib/instance-filter'

const props = defineProps<{
  desktopEnabled: boolean
  cliEnabled: boolean
}>()

const {
  instances,
  loading,
  busyIds,
  refresh,
  startPolling,
  stopPolling,
  create,
  launchCli,
  login,
  openDesktop,
  focusDesktop,
  quitDesktop,
  rename,
  remove,
  redeemResetCredit,
} = useCodexInstances()
const { t } = useI18n()
// Persisted collapse state, alongside the other two tables' (composables/useUiPrefs.ts).
const { codexOpen: open } = useUiPrefs()
const isBusy = (instance: CodexInstance) => busyIds.value.has(instance.id)

// Quota shares the app-wide usage store, keyed `codex:<id>` — so the Codex rows reuse the same
// chip, the same cache, the same superseded-window rule as every other provider's rows.
const { snapshotFor, isChecking, checkCodex, setSnapshot } = useUsage()
const usageFor = (instance: CodexInstance) => snapshotFor(`codex:${instance.id}`)
const isCheckingUsage = (instance: CodexInstance) => isChecking(`codex:${instance.id}`)
const onCheckUsage = (instance: CodexInstance) => checkCodex(instance.id)

// Mirrors the server's own redeem guard (core/codex-account.ts's codexResetGuard) against the
// already-cached snapshot, so the button can disable itself instead of round-tripping just to
// learn the redeem would be refused. Only disables on a CONCRETE refusal (a known credit count of
// zero, or a known busiest-window % under the threshold) — an unchecked/stale snapshot leaves the
// button enabled and lets the server give the real answer.
const CODEX_RESET_EXHAUSTED_PERCENT = 100
function redeemDisabledReason(instance: CodexInstance): string | null {
  const snap = usageFor(instance)
  if (!snap) return null
  const available = snap.resetCredits ?? null
  if (available !== null && available <= 0) return t('codexInstances.redeemNoCredits')
  const pcts = [snap.session?.pct, snap.weekAll?.pct].filter(
    (p): p is number => typeof p === 'number',
  )
  const worst = pcts.length > 0 ? Math.max(...pcts) : null
  if (worst === null || worst >= CODEX_RESET_EXHAUSTED_PERCENT) return null
  return t('codexInstances.redeemNotExhausted', { pct: Math.round(worst) })
}

async function onRedeemResetCredit(instance: CodexInstance) {
  const result = await redeemResetCredit(instance.id)
  if (result?.ok) {
    if (result.usage) setSnapshot(`codex:${instance.id}`, result.usage)
    toast.success(result.message || t('codexInstances.toastRedeemed'))
  } else {
    toast.error(result?.message ?? t('codexInstances.toastRedeemFailed'))
  }
}

const { sortedRows, toggleSort, indicatorFor } = useSortable(
  () => instances.value,
  [
    {
      key: 'status',
      accessor: (instance: CodexInstance) =>
        `${props.desktopEnabled && instance.isDesktopRunning ? '0' : '1'}:${props.cliEnabled && instance.loggedIn ? '0' : '1'}`,
    },
    { key: 'name', accessor: (instance: CodexInstance) => instance.name },
    {
      key: 'account',
      accessor: (instance: CodexInstance) =>
        instance.account?.email ?? instance.account?.name ?? undefined,
    },
    {
      key: 'plan',
      accessor: (instance: CodexInstance) => instance.account?.planLabel ?? undefined,
    },
    { key: 'codexHome', accessor: (instance: CodexInstance) => instance.codexHome },
  ],
)

// --- filter -------------------------------------------------------------------------------------
// The tab's filter is tab-wide (composables/useInstanceFilter.ts), and a Codex row is an account
// like any other: it has a desktop profile that is open or shut, a plan, and a quota reading. It
// runs AFTER the sort — it removes or greys rows, it never reorders them.
const { dimmed: filterDimmed, visible: filterVisible } = useInstanceFilter()

/** `open` is left UNKNOWN when the Codex desktop surface is switched off in Settings: the column
 *  is not on screen then, and "closed" would be a claim about a profile this view is not even
 *  reporting on. An unknown fact never sets a row aside (see lib/instance-filter.ts). */
const filterFacts = (instance: CodexInstance): InstanceFacts => ({
  usage: usageFor(instance),
  open: props.desktopEnabled ? instance.isDesktopRunning : null,
  plan: instance.account?.planLabel ?? null,
  signedIn: instance.loggedIn,
})

const visibleRows = computed(() => filterVisible(sortedRows.value, filterFacts))
/** Rows this table dropped for the filter — said out loud in the heading, or a row that quietly
 *  stopped being listed reads as a bug rather than as the filter working. */
const hiddenByFilter = computed(() => sortedRows.value.length - visibleRows.value.length)
/** There ARE Codex instances, the filter just took all of them. */
const allHiddenByFilter = computed(
  () => instances.value.length > 0 && visibleRows.value.length === 0,
)

const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
async function onCreate(name: string) {
  creating.value = true
  createError.value = null
  try {
    const result = await create(name)
    if (result?.ok) {
      createOpen.value = false
      toast.success(t('codexInstances.toastCreated'))
    } else createError.value = result?.message ?? t('codexInstances.toastCreateFailed')
  } finally {
    creating.value = false
  }
}

const renameOpen = ref(false)
const renameTarget = ref<CodexInstance | null>(null)
const renaming = ref(false)
const renameError = ref<string | null>(null)
function openRename(instance: CodexInstance) {
  renameTarget.value = instance
  renameError.value = null
  renameOpen.value = true
}
async function onRename(name: string) {
  const target = renameTarget.value
  if (!target) return
  renaming.value = true
  try {
    const result = await rename(target.id, name)
    if (result?.ok) {
      renameOpen.value = false
      toast.success(t('codexInstances.toastRenamed'))
    } else renameError.value = result?.message ?? t('codexInstances.toastRenameFailed')
  } finally {
    renaming.value = false
  }
}

const deleteOpen = ref(false)
const deleteTarget = ref<CodexInstance | null>(null)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
function openDelete(instance: CodexInstance) {
  deleteTarget.value = instance
  deleteError.value = null
  deleteOpen.value = true
}
async function onDelete(name: string) {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    const result = await remove(target.id, name)
    if (result?.ok) {
      deleteOpen.value = false
      toast.success(t('codexInstances.toastDeleted'))
    } else deleteError.value = result?.message ?? t('codexInstances.toastDeleteFailed')
  } finally {
    deleting.value = false
  }
}

async function onLaunchCli(instance: CodexInstance) {
  const result = await launchCli(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastCliLaunched'))
  else toast.error(result?.message ?? t('codexInstances.toastCliLaunchFailed'))
}

async function onLogin(instance: CodexInstance) {
  const result = await login(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastLoginOpened'))
  else toast.error(result?.message ?? t('codexInstances.toastLoginFailed'))
}

async function onOpenDesktop(instance: CodexInstance) {
  const result = await openDesktop(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastDesktopOpened'))
  else toast.error(result?.message ?? t('codexInstances.toastDesktopOpenFailed'))
}

async function onFocusDesktop(instance: CodexInstance) {
  const result = await focusDesktop(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastDesktopFocused'))
  else toast.error(result?.message ?? t('codexInstances.toastDesktopFocusFailed'))
}

/** Copy the bare number — same behavior as the Claude tables' menus (see InstancesView). */
function copyInstanceNumber(num: number) {
  navigator.clipboard?.writeText(String(num)).catch(() => {})
  toast.success(t('instances.toastNumberCopied', { num }))
}

/** Copy the ChatGPT address this CODEX_HOME is signed in with — the same click the Claude table's
 *  account column has, so "click the account, get the address" is one habit across the whole tab
 *  rather than a Claude-only trick. Silent no-op with nothing resolved; the cell is only a button
 *  when there is an address behind it. */
function copyAccountEmail(instance: CodexInstance) {
  const email = instance.account?.email?.trim()
  if (!email) return
  navigator.clipboard?.writeText(email).catch(() => {})
  toast.success(t('instances.toastEmailCopied', { email }))
}
async function onQuitDesktop(instance: CodexInstance) {
  const result = await quitDesktop(instance.id)
  if (result?.ok) toast.success(t('codexInstances.toastDesktopQuit'))
  else toast.error(result?.message ?? t('codexInstances.toastDesktopQuitFailed'))
}

onMounted(startPolling)
onUnmounted(stopPolling)
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-2 p-3">
      <button
        type="button"
        class="flex items-center gap-2 rounded-md text-sm font-semibold transition-colors hover:text-muted-foreground"
        :aria-expanded="open"
        @click="open = !open"
      >
        <AppWindow class="size-4" />
        {{ $t('codexInstances.title') }}
        <!-- "x of y" once the filter is hiding rows, so the count never silently disagrees with
             the number of Codex instances that exist. -->
        <span class="text-muted-foreground">
          ({{
            hiddenByFilter > 0
              ? $t('codexInstances.countOfTotal', { shown: visibleRows.length, total: instances.length })
              : instances.length
          }})
        </span>
        <span v-if="hiddenByFilter > 0" class="text-xs font-normal text-muted-foreground">
          {{ $t('instances.filterHiddenCount', { count: hiddenByFilter }) }}
        </span>
        <ChevronDown
          class="size-4 text-muted-foreground transition-transform duration-200"
          :class="open ? '' : '-rotate-90'"
        />
      </button>
      <div class="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          :disabled="loading"
          :aria-label="$t('codexInstances.refresh')"
          @click="refresh()"
        >
          <RefreshCw :class="loading ? 'animate-spin' : ''" />
        </Button>
        <Button size="sm" :aria-label="$t('codexInstances.createInstance')" @click="createOpen = true">
          <Plus /> {{ $t('codexInstances.createInstance') }}
        </Button>
      </div>
    </div>

    <!-- ExpandArea, not the kit's ExpandTransition: its permanent overflow clip would break this
         table's `sticky top-0` header. See ExpandArea.vue. -->
    <ExpandArea :open="open">
    <Table>
      <TableHeader class="sticky top-0 z-10 bg-card">
        <TableRow>
          <TableHead class="cursor-pointer select-none" @click="toggleSort('status')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('codexInstances.colStatus') }}
              <ArrowUp v-if="indicatorFor('status') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('status') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="cursor-pointer select-none" @click="toggleSort('name')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('codexInstances.colName') }}
              <ArrowUp v-if="indicatorFor('name') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('name') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="cursor-pointer select-none" @click="toggleSort('account')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('codexInstances.colAccount') }}
              <ArrowUp v-if="indicatorFor('account') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('account') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead>{{ $t('codexInstances.colUsage') }}</TableHead>
          <TableHead class="cursor-pointer select-none" @click="toggleSort('plan')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('codexInstances.colPlan') }}
              <ArrowUp v-if="indicatorFor('plan') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('plan') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="cursor-pointer select-none" @click="toggleSort('codexHome')">
            <span class="inline-flex items-center gap-0.5">
              {{ $t('codexInstances.colHome') }}
              <ArrowUp v-if="indicatorFor('codexHome') === 'asc'" class="size-3" />
              <ArrowDown v-else-if="indicatorFor('codexHome') === 'desc'" class="size-3" />
            </span>
          </TableHead>
          <TableHead class="text-right">{{ $t('codexInstances.colActions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody v-if="instances.length === 0">
        <TableEmpty v-if="!loading" :colspan="7">
          <div class="flex flex-col items-center gap-1 text-center">
            <AppWindow class="mb-1 size-6 opacity-40" />
            <p class="font-medium text-foreground">{{ $t('codexInstances.empty') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('codexInstances.emptyHint') }}</p>
          </div>
        </TableEmpty>
        <TableRow v-for="i in 2" v-else :key="i">
          <TableCell><Skeleton class="size-2 rounded-full" /></TableCell>
          <TableCell><Skeleton class="h-4 w-28" /></TableCell>
          <TableCell><Skeleton class="h-4 w-36" /></TableCell>
          <TableCell><Skeleton class="h-5 w-10" /></TableCell>
          <TableCell><Skeleton class="h-5 w-12" /></TableCell>
          <TableCell><Skeleton class="h-3 w-48" /></TableCell>
          <TableCell><div class="flex justify-end"><Skeleton class="h-6 w-20" /></div></TableCell>
        </TableRow>
      </TableBody>
      <TableBody v-else-if="allHiddenByFilter">
        <TableEmpty :colspan="7">
          <div class="flex flex-col items-center gap-1 text-center">
            <Funnel class="mb-1 size-6 opacity-40" />
            <p class="font-medium text-foreground">{{ $t('instances.filterAllHidden') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('instances.filterAllHiddenHint') }}</p>
          </div>
        </TableEmpty>
      </TableBody>
      <TableBody v-else>
        <TableRow
          v-for="instance in visibleRows"
          :key="instance.id"
          class="transition-opacity duration-200"
          :class="filterDimmed(filterFacts(instance)) ? 'opacity-25 hover:bg-transparent' : ''"
        >
          <TableCell>
            <div class="flex items-center gap-2 text-xs">
              <span
                v-if="desktopEnabled"
                class="inline-block size-2 rounded-full"
                :class="instance.isDesktopRunning ? 'bg-success' : 'bg-muted-foreground/40'"
              />
              <span
                v-if="desktopEnabled"
                :class="instance.isDesktopRunning ? 'text-foreground' : 'text-muted-foreground'"
              >
                {{
                  instance.isDesktopRunning
                    ? $t('codexInstances.desktopRunning')
                    : $t('codexInstances.desktopStopped')
                }}
              </span>
              <span
                v-if="cliEnabled"
                class="text-muted-foreground"
                :title="instance.loggedIn ? $t('codexInstances.loggedIn') : $t('codexInstances.loggedOut')"
              >
                <template v-if="desktopEnabled">·</template>
                {{
                  instance.loggedIn
                    ? $t('codexInstances.loggedInShort')
                    : $t('codexInstances.loggedOutShort')
                }}
              </span>
            </div>
          </TableCell>
          <TableCell class="font-medium">
            <!-- Codex instances share ONE number sequence with the Claude Desktop and CLI tables,
                 so `#7` here can never be a different `#7` there. Same chip for the same reason. -->
            <div class="flex items-center gap-1.5">
              <InstanceNumber :num="instance.num" />
              <span>{{ instance.name }}</span>
            </div>
          </TableCell>
          <!-- Which ChatGPT account this CODEX_HOME is signed into. The name/email come straight
               off the list payload (the server resolves them from auth.json), so this fills in on
               first paint with no per-row request. -->
          <TableCell class="max-w-[16rem] text-xs">
            <template v-if="instance.account?.email || instance.account?.name">
              <!-- A button only when there IS an address to copy: with a name and no email the
                   cell is text, because a control that silently does nothing is worse than none. -->
              <component
                :is="instance.account.email ? 'button' : 'div'"
                :type="instance.account.email ? 'button' : undefined"
                class="block w-full truncate text-left font-medium"
                :class="
                  instance.account.email
                    ? 'cursor-pointer transition-colors hover:text-primary'
                    : undefined
                "
                :title="
                  instance.account.email ? $t('instances.accountCopyHint') : undefined
                "
                :aria-label="
                  instance.account.email
                    ? $t('instances.copyAccountEmailAria', { email: instance.account.email })
                    : undefined
                "
                @click="copyAccountEmail(instance)"
              >
                {{ instance.account.name ?? instance.account.email }}
              </component>
              <div
                v-if="instance.account.name && instance.account.email"
                class="truncate text-[0.625rem] text-muted-foreground"
              >
                {{ instance.account.email }}
              </div>
            </template>
            <span v-else class="text-muted-foreground">
              {{
                instance.account?.authMode === 'apikey'
                  ? $t('codexInstances.authApiKey')
                  : $t('codexInstances.loggedOutShort')
              }}
            </span>
          </TableCell>
          <TableCell>
            <UsageBadge
              :snapshot="usageFor(instance)"
              :checking="isCheckingUsage(instance)"
              :usage-key="`codex:${instance.id}`"
              @check="onCheckUsage(instance)"
            />
          </TableCell>
          <TableCell>
            <!-- Plan, from `plan_type`. The live check prefers ChatGPT's server-computed value over
                 the id_token's mint-time claim, so a lapsed or upgraded plan cannot linger here. -->
            <Badge v-if="instance.account?.planLabel" variant="outline">
              {{ instance.account.planLabel }}
            </Badge>
            <span v-else class="text-xs text-muted-foreground">—</span>
          </TableCell>
          <TableCell class="mono max-w-[28rem] truncate text-[0.625rem] text-muted-foreground">
            {{ instance.codexHome }}
          </TableCell>
          <TableCell>
            <!-- A DISCOVERED row (the default install, or a Codex Desktop running from a profile we
                 didn't create) has no store entry, so every mutating action would fail with "not
                 found". It is listed to be READ — identity, plan, quota — and says so instead of
                 offering buttons that cannot work. -->
            <div v-if="instance.isExternal" class="flex items-center justify-end">
              <span class="text-[0.625rem] text-muted-foreground">
                {{ $t('codexInstances.externalHint') }}
              </span>
            </div>
            <div v-else class="flex items-center justify-end gap-1">
              <Button
                v-if="desktopEnabled && !instance.isDesktopRunning"
                variant="outline"
                size="sm"
                :disabled="isBusy(instance)"
                @click="onOpenDesktop(instance)"
              >
                <Play /> {{ $t('codexInstances.openDesktop') }}
              </Button>
              <Button
                v-else-if="desktopEnabled"
                variant="outline"
                size="sm"
                :disabled="isBusy(instance)"
                @click="onFocusDesktop(instance)"
              >
                <!-- Same running dot as the Claude table's Focus button, for the same reason: this
                     button only exists while the desktop app is up, and the dot says so where the
                     eye already is. -->
                <span class="relative inline-flex">
                  <AppWindow />
                  <span
                    class="absolute -right-1 -top-1 size-1.5 rounded-full bg-success ring-2 ring-background animate-pulse"
                  />
                </span>
                {{ $t('codexInstances.focusDesktop') }}
              </Button>
              <Button
                v-else-if="cliEnabled"
                variant="outline"
                size="sm"
                :disabled="isBusy(instance)"
                @click="onLaunchCli(instance)"
              >
                <Terminal /> {{ $t('codexInstances.launchCli') }}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="$t('codexInstances.moreActions')">
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="max-w-52">
                  <!-- Which instance this menu belongs to, by number — see InstancesView. -->
                  <DropdownMenuLabel class="flex items-center justify-between gap-2 py-1">
                    <span class="font-mono text-xs">{{
                      $t('instances.numberMenuLabel', { num: instance.num })
                    }}</span>
                    <button
                      type="button"
                      class="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      :aria-label="$t('instances.copyNumber')"
                      @click.stop="copyInstanceNumber(instance.num)"
                    >
                      <Copy class="size-3.5" />
                    </button>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    v-if="desktopEnabled"
                    :disabled="!instance.isDesktopRunning || isBusy(instance)"
                    @click="onQuitDesktop(instance)"
                  >
                    <Square /> {{ $t('codexInstances.quitDesktop') }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator v-if="desktopEnabled && cliEnabled" />
                  <DropdownMenuItem
                    v-if="cliEnabled"
                    :disabled="isBusy(instance)"
                    @click="onLaunchCli(instance)"
                  >
                    <Terminal /> {{ $t('codexInstances.launchCli') }}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    v-if="cliEnabled"
                    :disabled="isBusy(instance)"
                    @click="onLogin(instance)"
                  >
                    <LogIn /> {{ $t('codexInstances.login') }}
                  </DropdownMenuItem>
                  <!-- Only for a signed-in ChatGPT login: an API-key auth has no ChatGPT
                       subscription and so no bankable reset credits. Disabled (with a title
                       explaining why) when the cached usage already shows the redeem would be
                       refused; the click still round-trips to the server otherwise, which gives
                       the authoritative answer when the cache is stale or empty. -->
                  <DropdownMenuItem
                    v-if="instance.account?.authMode === 'chatgpt'"
                    :disabled="isBusy(instance) || !!redeemDisabledReason(instance)"
                    :title="redeemDisabledReason(instance) ?? undefined"
                    @click="onRedeemResetCredit(instance)"
                  >
                    <RotateCcw /> {{ $t('codexInstances.redeemResetCredit') }}
                  </DropdownMenuItem>
                  <DropdownMenuItem :disabled="isBusy(instance)" @click="openRename(instance)">
                    <Pencil /> {{ $t('codexInstances.rename') }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    :disabled="instance.isDesktopRunning || isBusy(instance)"
                    @click="openDelete(instance)"
                  >
                    <Trash2 /> {{ $t('codexInstances.delete') }}
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
      namespace="codexInstances"
      mode="create"
      :submitting="creating"
      :error-message="createError"
      @submit="onCreate"
    />
    <CliInstanceNameDialog
      v-model:open="renameOpen"
      namespace="codexInstances"
      mode="rename"
      :current-name="renameTarget?.name ?? null"
      :submitting="renaming"
      :error-message="renameError"
      @submit="onRename"
    />
    <DeleteCliInstanceDialog
      v-model:open="deleteOpen"
      namespace="codexInstances"
      :instance-name="deleteTarget?.name ?? null"
      :submitting="deleting"
      :error-message="deleteError"
      @confirm="onDelete"
    />
  </div>
</template>
