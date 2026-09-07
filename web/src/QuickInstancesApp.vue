<script setup lang="ts">
import {
  AppWindow,
  Boxes,
  Focus,
  Gauge,
  Moon,
  Play,
  RefreshCw,
  Square,
  Sun,
  Terminal,
  X,
} from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import QuickInstanceFilter from '@/components/QuickInstanceFilter.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useInstanceFilter } from '@/composables/useInstanceFilter'
import { useUsageMode } from '@/composables/useUsageMode'
import type {
  CliInstance,
  CMActionResult,
  CMInstance,
  CodexInstance,
  UsageSnapshot,
} from '@/lib/api'
import {
  API_BASE,
  focusCodexDesktopInstance,
  focusInstance,
  getInstanceAccount,
  getUsageCache,
  launchCliInstance,
  launchCodexInstance,
  listCliInstances,
  listCodexInstances,
  listInstances,
  openCodexDesktopInstance,
  openInstance,
  quitCodexDesktopInstance,
  quitInstance,
} from '@/lib/api'
import { loginChanged } from '@/lib/instance-appearance'
import { useTheme } from '@/lib/theme'
import type { UsageScope } from '@/lib/usage'
import {
  isStaleSnap,
  usageBadgeVariant,
  usageCellLabel,
  usageCheckedAgo,
  usagePctFor,
} from '@/lib/usage'
import { applyWindowSizeHint } from '@/lib/window-size-hint'

// A second --app launch can be forwarded into an existing Chromium process, which ignores both
// --window-size and saved geometry. Honor the daemon's one-shot URL hint just like the full shell.
applyWindowSizeHint()

const claude = ref<CMInstance[]>([])
const claudeCli = ref<CliInstance[]>([])
const codex = ref<CodexInstance[]>([])
const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(new Set<string>())
const resolvingAccounts = ref(new Set<string>())
const usageSnapshots = ref(new Map<string, UsageSnapshot>())
const lightweightServer = ref(false)
const lastAccountResolveAt = new Map<string, number>()

const { isDark, toggle: toggleTheme } = useTheme()

// --- quota columns + the filter -----------------------------------------------------------------
// Both are the SAME shared singletons the full manager's Instances tab uses, not a private copy:
// composables/useUsageMode.ts and composables/useInstanceFilter.ts. So a filter set over there is
// already set here — and via composables/useSharedPrefs.ts that holds even when this window is
// served from its own port (a different browser origin, and therefore its own empty localStorage),
// which is exactly the case where it used to forget.
//
// `usageMode` gates the quota badges here the same way it swaps columns there. This window has no
// process columns to swap TO, so off simply means a plainer list — and it also stands the QUOTA
// facet of the filter down (see useInstanceFilter), since those percentages are then not on screen
// to be filtered against. The status and plan facets are true either way, so the filter button is
// always here: a filter quietly dimming rows with no visible control that explains it is the one
// outcome to avoid.
const { usageMode, toggle: toggleUsageMode } = useUsageMode()
const { dimmed, hidden, visible } = useInstanceFilter()

/** What one row is, as far as the filter is concerned — see lib/instance-filter.ts. A desktop
 *  instance knows all three facts; an unlinked CLI login has neither a window to be open nor an
 *  account record of its own, and an absent fact never sets a row aside. */
const factsForClaude = (instance: CMInstance) => ({
  usage: usageForClaude(instance),
  open: instance.isRunning,
  plan: instance.account?.planLabel ?? null,
})
const factsForClaudeCli = (instance: CliInstance) => ({ usage: usageForClaudeCli(instance) })
/** A Codex row's desktop profile is the thing that is open or shut, and its account carries the
 *  plan; quota is keyed the same way the full manager keys it. */
const factsForCodex = (instance: CodexInstance) => ({
  usage: usageSnapshots.value.get(`codex:${instance.id}`),
  open: instance.isDesktopRunning,
  plan: instance.account?.planLabel ?? null,
})

const sortedClaude = computed(() =>
  [...claude.value].sort(
    (a, b) =>
      Number(b.isRunning) - Number(a.isRunning) ||
      (a.label ?? a.name).localeCompare(b.label ?? b.name),
  ),
)
/**
 * ONLY the UNLINKED CLI logins get their own row here — the same rule the full manager's CLI table
 * uses (components/CliInstancesSection.vue unlinkedCliInstances).
 *
 * Without this the two windows disagreed about the same machine: the full manager folded a linked
 * CLI login onto its desktop instance's row and reported "CLI instances (0 of 1)", while this
 * window listed that identical login as a standalone "Claude CLI" row — so the same account
 * appeared once in one window and twice in the other, and the header totals could never be
 * reconciled. A linked login is the same Anthropic account signed in twice; it belongs to the
 * desktop row, which now carries a terminal badge for it.
 *
 * The `desktopDirs` check is the same ghost-link backstop as over there: a link pointing at a
 * desktop instance that no longer exists must resurface here rather than vanish from both views.
 */
const unlinkedClaudeCli = computed(() => {
  const desktopDirs = new Set(claude.value.map((i) => i.dir))
  return claudeCli.value.filter(
    (c) => !c.associatedDesktopDir || !desktopDirs.has(c.associatedDesktopDir),
  )
})
/** The linked ones, per desktop dir, for that row's badge. */
const linkedCliByDir = computed(() => {
  const byDir = new Map<string, CliInstance[]>()
  const desktopDirs = new Set(claude.value.map((i) => i.dir))
  for (const cli of claudeCli.value) {
    const dir = cli.associatedDesktopDir
    if (!dir || !desktopDirs.has(dir)) continue
    const list = byDir.get(dir)
    if (list) list.push(cli)
    else byDir.set(dir, [cli])
  }
  return byDir
})
function linkedClisFor(dir: string): CliInstance[] {
  return linkedCliByDir.value.get(dir) ?? []
}

const sortedClaudeCli = computed(() =>
  [...unlinkedClaudeCli.value].sort((a, b) => a.name.localeCompare(b.name)),
)

// Sort first, then filter: the filter REMOVES rows, it never reorders them.
const visibleClaude = computed(() => visible(sortedClaude.value, factsForClaude))
const visibleClaudeCli = computed(() => visible(sortedClaudeCli.value, factsForClaudeCli))

/** Rows the filter is holding back, so a short table never reads as a discovery failure. Counted
 *  across both Claude tables, which is how the flyout reports it. */
const hiddenCount = computed(
  () =>
    sortedClaude.value.filter((i) => hidden(factsForClaude(i))).length +
    sortedClaudeCli.value.filter((i) => hidden(factsForClaudeCli(i))).length +
    sortedCodex.value.filter((i) => hidden(factsForCodex(i))).length,
)
const sortedCodex = computed(() =>
  [...codex.value].sort(
    (a, b) =>
      Number(b.isDesktopRunning) - Number(a.isDesktopRunning) || a.name.localeCompare(b.name),
  ),
)
const visibleCodex = computed(() => visible(sortedCodex.value, factsForCodex))
// Counts ROWS, not records: a CLI login folded onto its desktop row is one instance shown once, so
// counting claudeCli in full would report a machine as having more instances than it has rows.
const total = computed(
  () => claude.value.length + unlinkedClaudeCli.value.length + codex.value.length,
)
/** The plan labels the filter flyout offers. Blanks are fine — planOptions drops them. */
const presentPlans = computed(() => [
  ...claude.value.map((i) => i.account?.planLabel),
  ...codex.value.map((i) => i.account?.planLabel),
])

function usageForClaude(instance: CMInstance): UsageSnapshot | undefined {
  return usageSnapshots.value.get(`desktop:${instance.dir}`)
}

function usageForClaudeCli(instance: CliInstance): UsageSnapshot | undefined {
  return instance.lastUsageCheck ?? usageSnapshots.value.get(`cli:${instance.id}`)
}

/**
 * Badge colour for one window's reading. Outline (neutral) whenever there is no CURRENT number —
 * never checked, checked-but-empty, or a window that has since reset. A missing reading is
 * unknown, not healthy and not spent, so it must not borrow either colour.
 *
 * The 5-HOUR window is neutral even when it does have a number, matching the full manager's chips
 * (components/UsageBadge.vue): a spent session refills the same afternoon, a spent week does not,
 * so the row spends its one colour on the week and the session keeps its number without shouting.
 */
function usageVariant(
  snapshot: UsageSnapshot | undefined,
  scope: UsageScope,
): 'success' | 'warning' | 'destructive' | 'outline' {
  if (scope === 'session') return 'outline'
  const pct = usagePctFor(snapshot, scope)
  return pct == null ? 'outline' : usageBadgeVariant(pct)
}

function usageTitle(snapshot: UsageSnapshot | undefined, scope: UsageScope): string {
  const window = scope === 'session' ? '5-hour session' : 'Weekly usage'
  if (usagePctFor(snapshot, scope) == null || !snapshot) {
    return `${window} has not been checked yet.`
  }
  return `${window} · checked ${usageCheckedAgo(snapshot.capturedAt)}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setBusy(key: string, value: boolean): void {
  const next = new Set(busy.value)
  if (value) next.add(key)
  else next.delete(key)
  busy.value = next
}

function setResolvingAccount(dir: string, value: boolean): void {
  const next = new Set(resolvingAccounts.value)
  if (value) next.add(dir)
  else next.delete(dir)
  resolvingAccounts.value = next
}

async function hydrateClaudeAccounts(rows: CMInstance[], force = false): Promise<void> {
  const now = Date.now()
  await Promise.all(
    rows.map(async (instance) => {
      const last = lastAccountResolveAt.get(instance.dir) ?? 0
      if (!force && !loginChanged(instance) && instance.account && now - last < 60_000) return
      setResolvingAccount(instance.dir, true)
      try {
        // Cache/local-token only: identity and plan appear without putting Anthropic network work
        // on the quick-launch path. The full manager refreshes this same identity cache.
        const account = await getInstanceAccount(instance.dir, { noNetwork: true })
        lastAccountResolveAt.set(instance.dir, Date.now())
        const index = claude.value.findIndex((row) => row.dir === instance.dir)
        if (index >= 0) {
          const next = claude.value.slice()
          next[index] = { ...next[index]!, account }
          claude.value = next
        }
      } catch {
        // Keep the row usable. Start/focus must never wait on optional identity metadata.
      } finally {
        setResolvingAccount(instance.dir, false)
      }
    }),
  )
}

async function refresh(silent = false): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  if (!silent) loading.value = true
  try {
    const [desktopRows, cliRows, codexRows, usageResult] = await Promise.all([
      listInstances(),
      listCliInstances(),
      listCodexInstances(),
      getUsageCache().catch(() => null),
    ])
    const previousAccounts = new Map(
      claude.value.map((instance) => [instance.dir, instance.account]),
    )
    claude.value = desktopRows.map((instance) => {
      // Carry a previously resolved identity forward (the list omits it) — unless the instance has
      // since been signed into a different account, in which case it is dropped rather than shown.
      const next = {
        ...instance,
        account: instance.account ?? previousAccounts.get(instance.dir) ?? null,
      }
      return loginChanged(next) ? { ...instance, account: instance.account ?? null } : next
    })
    claudeCli.value = cliRows
    codex.value = codexRows
    if (usageResult) usageSnapshots.value = new Map(Object.entries(usageResult.cache))
    error.value = null
    void hydrateClaudeAccounts(claude.value, !silent)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    refreshing.value = false
    loading.value = false
  }
}

async function act(
  key: string,
  label: string,
  action: () => Promise<CMActionResult>,
): Promise<void> {
  setBusy(key, true)
  notice.value = null
  try {
    const result = await action()
    if (!result.ok) throw new Error(result.message ?? `${label} failed.`)
    notice.value = result.message || `${label} completed.`
    await refresh(true)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    setBusy(key, false)
  }
}

// Click the account address to copy it — the same act the full manager's Instances tab offers on
// its account column, so "click the account, get the address" is one habit wherever the accounts
// are listed. This window has no toast layer at all (it is deliberately minimal, see the
// English-only note on the template), so the confirmation is the label turning into "Copied" for a
// moment — the same trick InstanceNumber uses for the number chip.
const copiedEmailDir = ref<string | null>(null)
let copiedEmailTimer: number | undefined
function copyEmail(dir: string, email: string): void {
  navigator.clipboard?.writeText(email).catch(() => {})
  copiedEmailDir.value = dir
  window.clearTimeout(copiedEmailTimer)
  copiedEmailTimer = window.setTimeout(() => {
    copiedEmailDir.value = null
  }, 1200)
}

function openClaude(instance: CMInstance): void {
  const key = `claude:${instance.dir}`
  void act(key, instance.isRunning ? 'Focus' : 'Start', () =>
    instance.isRunning ? focusInstance(instance.dir) : openInstance(instance.dir),
  )
}

function stopClaude(instance: CMInstance): void {
  if (
    instance.isExternal &&
    !window.confirm('Quit the external/default Claude Desktop window? Its open chats are real.')
  )
    return
  const key = `claude:${instance.dir}`
  void act(key, 'Stop', () => quitInstance(instance.dir, { confirmExternal: instance.isExternal }))
}

function launchClaudeCli(instance: CliInstance): void {
  void act(`claude-cli:${instance.id}`, 'Launch CLI', () => launchCliInstance(instance.id))
}

function openCodex(instance: CodexInstance): void {
  const key = `codex:${instance.id}`
  void act(key, instance.isDesktopRunning ? 'Focus' : 'Start', () =>
    instance.isDesktopRunning
      ? focusCodexDesktopInstance(instance.id)
      : openCodexDesktopInstance(instance.id),
  )
}

function stopCodex(instance: CodexInstance): void {
  void act(`codex:${instance.id}`, 'Stop', () => quitCodexDesktopInstance(instance.id))
}

function launchCodexCli(instance: CodexInstance): void {
  void act(`codex:${instance.id}`, 'Launch CLI', () => launchCodexInstance(instance.id))
}

let pollTimer: number | null = null
let lifetime: EventSource | null = null

async function connectLifetime(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/health`)
    const health = (await response.json()) as { mode?: string }
    lightweightServer.value = health.mode === 'instances'
    if (lightweightServer.value) {
      lifetime = new EventSource(`${API_BASE}/api/instance-mode/lifetime`)
    }
  } catch {
    // Listing calls below carry the actionable connection error; health is only capability
    // detection for disposable-server lifetime.
  }
}

async function closeWindow(): Promise<void> {
  if (lightweightServer.value) {
    await fetch(`${API_BASE}/api/instance-mode/shutdown`, { method: 'POST' }).catch(() => undefined)
  }
  window.close()
  notice.value = 'You can close this window.'
}

onMounted(() => {
  document.title = 'Quick Instances · AgentHydra'
  void connectLifetime()
  void refresh()
  pollTimer = window.setInterval(() => {
    if (!document.hidden) void refresh(true)
  }, 10_000)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  window.clearTimeout(copiedEmailTimer)
  lifetime?.close()
})
</script>

<template>
  <!-- Instance mode intentionally stays English-only so it does not download or initialize the
       full vue-i18n catalog during a one-click launch. -->
  <!-- i18n-ignore -->
  <div class="min-h-screen bg-background text-foreground">
    <header class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
      <div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Boxes class="size-5" />
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-semibold">Quick Instances</h1>
          <p class="truncate text-xs text-muted-foreground">
            Instance controls only · {{ total }} available<template v-if="hiddenCount">
              · {{ hiddenCount }} hidden by filter</template>
          </p>
        </div>
        <Button
          :variant="usageMode ? 'secondary' : 'ghost'"
          size="icon-sm"
          :title="usageMode ? 'Hide quota columns' : 'Show quota columns'"
          :aria-pressed="usageMode"
          @click="toggleUsageMode"
        >
          <Gauge />
        </Button>
        <QuickInstanceFilter :hidden-count="hiddenCount" :present-plans="presentPlans" />
        <Button
          variant="ghost"
          size="icon-sm"
          :title="isDark ? 'Use light theme' : 'Use dark theme'"
          @click="toggleTheme"
        >
          <Sun v-if="isDark" />
          <Moon v-else />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh instances"
          :disabled="refreshing"
          @click="refresh()"
        >
          <RefreshCw :class="{ 'animate-spin': refreshing }" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Close quick instances" @click="closeWindow">
          <X />
        </Button>
      </div>
    </header>

    <main class="mx-auto max-w-3xl space-y-4 p-4">
      <div
        v-if="error"
        class="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive"
      >
        <span>{{ error }}</span>
        <button class="shrink-0 text-xs underline underline-offset-2" @click="error = null">
          Dismiss
        </button>
      </div>
      <div
        v-else-if="notice"
        class="flex items-start justify-between gap-3 rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-sm"
      >
        <span>{{ notice }}</span>
        <button class="shrink-0 text-xs underline underline-offset-2" @click="notice = null">
          Dismiss
        </button>
      </div>

      <div v-if="loading" class="space-y-2" aria-label="Loading instances">
        <div v-for="row in 4" :key="row" class="h-16 animate-pulse rounded-xl bg-muted" />
      </div>

      <template v-else>
        <section class="overflow-hidden rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <AppWindow class="size-4 text-primary" />
            <h2 class="flex-1 text-sm font-medium">Claude Desktop</h2>
            <template v-if="usageMode">
              <span class="w-16 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                5h
              </span>
              <span class="w-16 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Week
              </span>
            </template>
            <div class="flex w-28 justify-end">
              <Badge variant="secondary">{{ claude.length }}</Badge>
            </div>
          </div>
          <div v-if="sortedClaude.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
            No Claude Desktop instances found.
          </div>
          <div
            v-else-if="visibleClaude.length === 0"
            class="px-4 py-6 text-center text-sm text-muted-foreground"
          >
            Every instance is set aside by the filter.
          </div>
          <div
            v-for="instance in visibleClaude"
            :key="instance.dir"
            class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0 transition-opacity"
            :class="dimmed(factsForClaude(instance)) ? 'opacity-25' : ''"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="instance.isRunning ? 'bg-emerald-500' : 'bg-muted-foreground/35'"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ instance.label ?? instance.name }}</span>
                <Badge v-if="instance.isExternal" variant="outline">External</Badge>
                <!-- Same badge as the full manager's Instances table: the CLI login folded onto
                     this row has to be visible SOMEWHERE, or folding it just looks like it went
                     missing. Amber when it still needs /login. -->
                <Terminal
                  v-for="cli in linkedClisFor(instance.dir)"
                  :key="`cli-badge-${cli.id}`"
                  class="size-3.5 shrink-0"
                  :class="cli.loggedIn ? 'text-muted-foreground' : 'text-warning'"
                  :aria-label="`Linked CLI login: ${cli.name}`"
                  :title="`Claude CLI: ${cli.name}${cli.loggedIn ? '' : ' — needs sign-in'}`"
                />
                <Badge
                  v-if="instance.account?.planLabel"
                  variant="secondary"
                  class="shrink-0"
                >
                  {{ instance.account.planLabel }}
                </Badge>
              </div>
              <p class="truncate text-xs text-muted-foreground">
                <template v-if="instance.account?.email">
                  <button
                    type="button"
                    class="cursor-pointer underline-offset-2 transition-colors hover:text-foreground hover:underline"
                    :title="`Click to copy ${instance.account.email}`"
                    :aria-label="`Copy the account address ${instance.account.email}`"
                    @click="copyEmail(instance.dir, instance.account.email)"
                  >{{ copiedEmailDir === instance.dir ? 'Copied' : instance.account.email }}</button>
                  ·
                </template>
                <template v-else-if="resolvingAccounts.has(instance.dir)">Account resolving… · </template>
                <template v-else>Account unavailable · </template>
                {{ instance.isRunning ? `Running · PID ${instance.pid ?? '—'}` : 'Stopped' }}
              </p>
            </div>
            <template v-if="usageMode">
              <div class="flex w-16 shrink-0 justify-center">
                <Badge
                  :variant="usageVariant(usageForClaude(instance), 'session')"
                  :class="isStaleSnap(usageForClaude(instance)) ? 'opacity-60' : ''"
                  :title="usageTitle(usageForClaude(instance), 'session')"
                >
                  {{ usageCellLabel(usageForClaude(instance), 'session') }}
                </Badge>
              </div>
              <div class="flex w-16 shrink-0 justify-center">
                <Badge
                  :variant="usageVariant(usageForClaude(instance), 'week')"
                  :class="isStaleSnap(usageForClaude(instance)) ? 'opacity-60' : ''"
                  :title="usageTitle(usageForClaude(instance), 'week')"
                >
                  {{ usageCellLabel(usageForClaude(instance), 'week') }}
                </Badge>
              </div>
            </template>
            <div class="flex w-28 shrink-0 justify-end gap-1">
              <Button
                size="sm"
                :variant="instance.isRunning ? 'secondary' : 'default'"
                :disabled="busy.has(`claude:${instance.dir}`)"
                @click="openClaude(instance)"
              >
                <Focus v-if="instance.isRunning" />
                <Play v-else />
                {{ instance.isRunning ? 'Focus' : 'Start' }}
              </Button>
              <Button
                v-if="instance.isRunning"
                variant="ghost"
                size="icon-sm"
                title="Stop instance"
                :disabled="busy.has(`claude:${instance.dir}`)"
                @click="stopClaude(instance)"
              >
                <Square />
              </Button>
            </div>
          </div>
        </section>

        <section v-if="sortedClaudeCli.length" class="overflow-hidden rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <Terminal class="size-4 text-primary" />
            <h2 class="flex-1 text-sm font-medium">Claude CLI</h2>
            <template v-if="usageMode">
              <span class="w-16 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                5h
              </span>
              <span class="w-16 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Week
              </span>
            </template>
            <div class="flex w-28 justify-end">
              <!-- The UNLINKED count, matching the rows actually rendered below. Using the raw
                   claudeCli length here would have promised a row that folding removed. -->
              <Badge variant="secondary">{{ sortedClaudeCli.length }}</Badge>
            </div>
          </div>
          <div
            v-if="visibleClaudeCli.length === 0"
            class="px-4 py-6 text-center text-sm text-muted-foreground"
          >
            Every CLI instance is set aside by the filter.
          </div>
          <div
            v-for="instance in visibleClaudeCli"
            :key="instance.id"
            class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0 transition-opacity"
            :class="dimmed(factsForClaudeCli(instance)) ? 'opacity-25' : ''"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="instance.loggedIn ? 'bg-emerald-500' : 'bg-amber-500'"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ instance.name }}</p>
              <p class="truncate text-xs text-muted-foreground">
                {{ instance.loggedIn ? 'Signed in' : 'Needs sign-in' }}
              </p>
            </div>
            <template v-if="usageMode">
              <div class="flex w-16 shrink-0 justify-center">
                <Badge
                  :variant="usageVariant(usageForClaudeCli(instance), 'session')"
                  :class="isStaleSnap(usageForClaudeCli(instance)) ? 'opacity-60' : ''"
                  :title="usageTitle(usageForClaudeCli(instance), 'session')"
                >
                  {{ usageCellLabel(usageForClaudeCli(instance), 'session') }}
                </Badge>
              </div>
              <div class="flex w-16 shrink-0 justify-center">
                <Badge
                  :variant="usageVariant(usageForClaudeCli(instance), 'week')"
                  :class="isStaleSnap(usageForClaudeCli(instance)) ? 'opacity-60' : ''"
                  :title="usageTitle(usageForClaudeCli(instance), 'week')"
                >
                  {{ usageCellLabel(usageForClaudeCli(instance), 'week') }}
                </Badge>
              </div>
            </template>
            <div class="flex w-28 shrink-0 justify-end">
              <Button
                size="sm"
                variant="secondary"
                :disabled="busy.has(`claude-cli:${instance.id}`)"
                @click="launchClaudeCli(instance)"
              >
                <Terminal /> Launch
              </Button>
            </div>
          </div>
        </section>

        <section class="overflow-hidden rounded-xl border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2.5">
            <Boxes class="size-4 text-primary" />
            <h2 class="text-sm font-medium">Codex</h2>
            <Badge variant="secondary" class="ml-auto">{{ codex.length }}</Badge>
          </div>
          <div v-if="sortedCodex.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">
            No Codex instances found.
          </div>
          <div
            v-else-if="visibleCodex.length === 0"
            class="px-4 py-6 text-center text-sm text-muted-foreground"
          >
            Every Codex instance is set aside by the filter.
          </div>
          <div
            v-for="instance in visibleCodex"
            :key="instance.id"
            class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0 transition-opacity"
            :class="dimmed(factsForCodex(instance)) ? 'opacity-25' : ''"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="instance.isDesktopRunning ? 'bg-emerald-500' : 'bg-muted-foreground/35'"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ instance.name }}</p>
              <p class="truncate text-xs text-muted-foreground">
                Desktop {{ instance.isDesktopRunning ? 'running' : 'stopped' }} · CLI
                {{ instance.loggedIn ? 'signed in' : 'not signed in' }}
              </p>
            </div>
            <Button
              size="sm"
              :variant="instance.isDesktopRunning ? 'secondary' : 'default'"
              :disabled="busy.has(`codex:${instance.id}`)"
              @click="openCodex(instance)"
            >
              <Focus v-if="instance.isDesktopRunning" />
              <Play v-else />
              {{ instance.isDesktopRunning ? 'Focus' : 'Start' }}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Launch Codex CLI"
              :disabled="busy.has(`codex:${instance.id}`)"
              @click="launchCodexCli(instance)"
            >
              <Terminal />
            </Button>
            <Button
              v-if="instance.isDesktopRunning"
              variant="ghost"
              size="icon-sm"
              title="Stop Codex Desktop"
              :disabled="busy.has(`codex:${instance.id}`)"
              @click="stopCodex(instance)"
            >
              <Square />
            </Button>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>
