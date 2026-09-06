<script setup lang="ts">
import { safeTranscriptFilename } from '@agenthydra/server/filenames'
import {
  AlignJustify,
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Boxes,
  Brain,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ClipboardCopy,
  Clock,
  Coins,
  Copy,
  Download,
  FileSymlink,
  FileText,
  FolderGit2,
  GitBranch,
  GitFork,
  Globe,
  Hourglass,
  KeyRound,
  Layers,
  Link,
  ListTodo,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
  Wrench,
  X,
} from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { type ComponentPublicInstance, computed, ref, watch } from 'vue'
import SessionComposer, { type ComposerTarget } from '@/components/SessionComposer.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useBodySearch } from '@/composables/useBodySearch'
import { useData } from '@/composables/useData'
import { useDoneMarks } from '@/composables/useDoneMarks'
import { useMultiSelect } from '@/composables/useMultiSelect'
import { useOpenSession } from '@/composables/useOpenSession'
import { useResumeInTerminal } from '@/composables/useResumeInTerminal'
import { useSessionAccount } from '@/composables/useSessionAccount'
import { useSessionFileActions } from '@/composables/useSessionFileActions'
import { useSessionFilters } from '@/composables/useSessionFilters'
import { useSessionJump } from '@/composables/useSessionJump'
import { useSessionMigration } from '@/composables/useSessionMigration'
import { useSessionRowDisplay } from '@/composables/useSessionRowDisplay'
import { useSessionSecrets } from '@/composables/useSessionSecrets'
import { useSessionUsage } from '@/composables/useSessionUsage'
import { useShortcuts } from '@/composables/useShortcuts'
import { useTranscriptDisplay } from '@/composables/useTranscriptDisplay'
import { clampWidth, SIDEBAR_DEFAULT, useUiPrefs } from '@/composables/useUiPrefs'
import * as api from '@/lib/api'
import { baseName, shortId, timeAgo } from '@/lib/format'
import { groupByProject } from '@/lib/session-groups'
import { sessionShape } from '@/lib/session-shape'
import { cn } from '@/lib/utils'
import IconTooltip from '@/shell/IconTooltip.vue'

const {
  sessions,
  sessionsLoading,
  sessionsStatus,
  refreshSessions,
  queue,
  sessionInstanceFilter,
  sessionArchivedScope,
  sessionPeriod,
  sessionSourceFilter,
  sessionDispatchedScope,
  sessionRateLimitScope,
  sessionShapeScope,
} = useData()

// Verbose mode, the sidebar width and the body-search case flag are persisted AND mirrored through
// the daemon, so they live in composables/useUiPrefs.ts: this view unmounts whenever you switch
// tabs, and a mirrored ref owned by a component that unmounts stops being the mirrored one.
const {
  showTools,
  showThinking,
  humanOnly,
  compactTranscript,
  sidebarWidth,
  advancedCaseSensitive,
  copyPathIncludeName,
  copyPathIncludePrompt,
  copyPathPrompt,
} = useUiPrefs()

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {})
}

// --- the open session: which one, its live tail, and the layout that follows having one open -----
const {
  selectedId,
  selectedSource,
  selectedLocator,
  tail,
  tailLoading,
  chatEl,
  selected,
  loadTail,
  select,
  runningRunId,
  isExpanded,
  toggleExpand,
} = useOpenSession({ sessions, queue, showTools, showThinking, humanOnly })

const { loadUsage, usageSummary, usageDetail } = useSessionUsage({
  selectedId,
  selectedSource,
  selectedLocator,
})
// Cost moves only when the CLI writes turns, so refresh on the run's edges rather than on the
// 4-second tail poll (useOpenSession's own concern) — re-streaming a large transcript every tick to
// watch a number tick up is not worth it.
watch(runningRunId, (id, oldId) => {
  if (!!id !== !!oldId && selectedId.value) loadUsage()
})

const { secrets, secretsOpen, secretsDetail } = useSessionSecrets({
  selectedId,
  selectedSource,
  selectedLocator,
})

const {
  events,
  findTotal,
  findOpen,
  findQuery,
  findIndex,
  findInput,
  goToMatch,
  openFind,
  closeFind,
  copiedIdx,
  copyMessage,
} = useTranscriptDisplay({ tail, chatEl })

/** Whether the transcript is showing anything other than its default. Drives the pressed state on
 *  the controls button, so "why am I not seeing tool calls" is answerable at a glance. */
const displayFiltered = computed(
  () => showTools.value || showThinking.value || humanOnly.value || compactTranscript.value,
)

// Closing the session closes the find bar and the secrets dialog with it; a match count or a
// credential list against a transcript you can no longer see is just a wrong number on screen.
watch(selectedId, () => {
  closeFind()
  secretsOpen.value = false
})

/** The sidebar's own filter box, so Ctrl/Cmd+K can put the caret in it. */
const searchInput = ref<ComponentPublicInstance | null>(null)

// This view's own bindings, registered through the shared layer (composables/useShortcuts.ts) so
// they appear in the `?` sheet and disappear from it when the view unmounts.
//
// Ctrl/Cmd+F takes over the browser's own find, which is the right trade: the browser can only
// search the turns currently in the DOM anyway, and cannot show a count that means anything here.
useShortcuts([
  {
    keys: 'mod+f',
    labelKey: 'sessions.shortcutFind',
    groupKey: 'sessions.shortcutGroup',
    run: () => {
      if (selectedId.value) openFind()
    },
  },
  {
    keys: 'mod+k',
    labelKey: 'sessions.shortcutFilter',
    groupKey: 'sessions.shortcutGroup',
    run: () => searchInput.value?.$el?.focus?.(),
  },
  {
    keys: 'escape',
    labelKey: 'sessions.shortcutEscape',
    groupKey: 'sessions.shortcutGroup',
    run: () => {
      if (findOpen.value) closeFind()
      else if (selectedId.value) selectedId.value = null
    },
  },
])

// --- the sidebar's filter menu: named instances, scope labels, refetch-on-change wiring ----------
const {
  namedInstances,
  instanceLabelFor,
  filtersActive,
  sourceFilterLabel,
  rateLimitScopeLabel,
  instanceFilterLabel,
  archivedScopeLabel,
  periodLabel,
  dispatchedScopeLabel,
  shapeScopeLabel,
} = useSessionFilters({
  sessionInstanceFilter,
  sessionArchivedScope,
  sessionPeriod,
  sessionSourceFilter,
  sessionDispatchedScope,
  sessionRateLimitScope,
  sessionShapeScope,
  refreshSessions,
})

// --- per-row labels, badges and tooltips -----------------------------------------------------
const {
  titleOriginOf,
  titleIsUnattributed,
  limitTooltipOf,
  sourceLabel,
  rowSourceLabel,
  sourceBadgeClass,
  shapeLabel,
  shapeTitleOf,
  copyChipOf,
  copyWhyOf,
  activityOf,
  ACTIVITY_CLASS,
  ACTIVITY_LABEL,
} = useSessionRowDisplay()

const { doneCount, toggleDone, clearDoneMarks } = useDoneMarks({ sessions })
const { openFile, copyingFile, copyFile, copyFileLocation } = useSessionFileActions({
  copyPathIncludeName,
  copyPathIncludePrompt,
  copyPathPrompt,
})
const { resuming, resumeInTerminal } = useResumeInTerminal()

const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const shape = sessionShapeScope.value
  let rows = sessions.value
  // Applied in the browser, unlike the scopes the daemon owns, so it narrows the window that was
  // fetched rather than reaching further back. Said plainly in the menu, because "no marathons in
  // the last 24 hours" and "no marathons" are different answers.
  if (shape !== 'all') rows = rows.filter((s) => sessionShape(s) === shape)
  if (!q) return rows
  return rows.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.session_id.includes(q),
  )
})

/** An empty list under a bounded window is ambiguous: "nothing here" or "nothing here LATELY"?
 *  Say which, so a quiet day doesn't read as a broken list. */
const emptyBecauseOfPeriod = computed(
  () => sessionPeriod.value !== 'all' && !search.value.trim() && sessions.value.length === 0,
)

// --- sidebar: persisted drag-resize + animated collapse, auto-collapsing when narrow -------------
const RAIL_WIDTH = 44

const isWide = useMediaQuery('(min-width: 1024px)')
const collapsed = ref(!isWide.value)
watch(isWide, (wide) => {
  collapsed.value = !wide
})

const resizing = ref(false)
function startResize(e: PointerEvent) {
  const startX = e.clientX
  const startWidth = sidebarWidth.value
  resizing.value = true
  const onMove = (ev: PointerEvent) => {
    sidebarWidth.value = clampWidth(startWidth + ev.clientX - startX)
  }
  const onUp = () => {
    resizing.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// Never wider than the viewport allows (a 340px sidebar on a 390px phone would
// crush the transcript); the width transition animates the collapse toggle but is
// suspended during a drag so resizing tracks the pointer 1:1.
const asideStyle = computed(() => ({
  width: collapsed.value ? `${RAIL_WIDTH}px` : `min(${sidebarWidth.value}px, calc(100vw - 56px))`,
}))

// --- multi-select: pick several sessions, message them all at once - or move them ---------------
const {
  selectMode,
  checkedIds,
  sessionKey,
  isChecked,
  toggleSelectMode,
  checkAllFiltered,
  rowClick,
  checkedSessions,
  bulkCount,
  copyCheckedIds,
} = useMultiSelect({ filtered, selectedId, selectedSource, select, copy })

// --- migrate to another account, one session or the checked ones in bulk -------------------------
const {
  migrateTargets,
  runningTargets,
  closedTargets,
  migrating,
  loadMigrateTargets,
  migrateTo,
  bulkConfirm,
  askBulkMigrate,
  runBulkMigrate,
} = useSessionMigration({
  checkedSessions,
  clearChecked: () => {
    checkedIds.value = new Set()
  },
})

// --- which ACCOUNT the open chat is talking to ---------------------------------------------------
const { sessionAccount, openingInstance, openSessionInstance, copySessionAccountEmail } =
  useSessionAccount({ selected, instanceLabelFor })

// --- advanced (body) search: server-side, streams every transcript's raw content ------------------
const {
  advancedOpen,
  advancedQuery,
  advancedRegex,
  bodySearching,
  bodySearchActive,
  bodySearchQueryUsed,
  bodyResults,
  runBodySearch,
  bodySearchNotice,
  canSearchEverything,
  exitBodySearch,
  selectFromBodyResult,
} = useBodySearch({
  sessions,
  sessionInstanceFilter,
  sessionSourceFilter,
  advancedCaseSensitive,
  selectedId,
  selectedSource,
  selected,
  select,
  loadTail,
})

// --- jump to ONE session, asked from a dialog here or from another view ---------------------------
const { openFromBulkDialog } = useSessionJump({
  sessions,
  sessionPeriod,
  selectMode,
  toggleSelectMode,
  search,
  select,
  clearBulkConfirm: () => {
    bulkConfirm.value = null
  },
})

const composerTargets = computed<ComposerTarget[]>(() => {
  if (selectMode.value)
    return sessions.value
      .filter((s) => s.source === 'claude' && checkedIds.value.has(sessionKey(s)))
      .map((s) => ({
        session_id: s.session_id,
        title: s.title,
        cwd: s.cwd,
        instance: s.instance,
      }))
  const s = selected.value
  return s?.source === 'claude'
    ? [{ session_id: s.session_id, title: s.title, cwd: s.cwd, instance: s.instance }]
    : []
})

// Only the `claude` CLI can be handed a prompt, so Codex and OpenCode transcripts get no
// composer. Left at that the reply box simply is not there, which reads as a bug rather
// than a boundary, so name the source that owns the conversation instead.
// Deliberately not `!composerTargets.length`: in select mode an empty selection also
// empties that list, and the open session there may well be a Claude one.
const readOnlySource = computed(() => {
  if (selectMode.value) return null
  const s = selected.value
  return s && s.source !== 'claude' ? s.source : null
})

function onComposerSent(mode: 'now' | 'queued') {
  // the queue watcher above catches the status flip; this covers the first tokens
  if (mode === 'now' && selectedId.value) window.setTimeout(() => loadTail({ silent: true }), 1200)
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- sidebar: session list in its own scroll column; collapses to a slim rail with an
         animated width morph (the toggle button rides the sliding right edge) -->
    <!-- bg-sidebar, not transparent: the list is the recessed ground of the two-pane split. Without
         its own surface every region painted --background and the whole app read as one flat sheet,
         separated only by the hairline border. -->
    <aside
      class="relative min-h-0 shrink-0 overflow-hidden border-r border-border bg-sidebar"
      :class="resizing ? '' : 'transition-[width] duration-300 ease-in-out'"
      :style="asideStyle"
    >
      <IconTooltip :label="collapsed ? $t('sessions.expandSidebar') : $t('sessions.collapseSidebar')">
        <Button
          variant="ghost"
          size="icon"
          class="absolute right-2 top-3 z-10"
          @click="collapsed = !collapsed"
        >
          <PanelLeftOpen v-if="collapsed" />
          <PanelLeftClose v-else />
        </Button>
      </IconTooltip>

      <!-- expanded content keeps its full width while animating so it clips, not reflows -->
      <div
        class="flex h-full min-h-0 flex-col transition-opacity duration-200"
        :class="collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'"
        :style="{ width: `min(${sidebarWidth}px, calc(100vw - 56px))` }"
      >
        <div class="flex shrink-0 items-center gap-2 p-3 pr-11">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref="searchInput"
              v-model="search"
              :placeholder="$t('sessions.searchPlaceholder')"
              class="pl-8 pr-8"
            />
            <!-- Same popper-anchor rule as the instance filter below: the Popover root lives
                 INSIDE IconTooltip, so PopoverTrigger's PopperAnchor finds the popover's own
                 PopperRoot instead of the tooltip's. Wrapped around the tooltip, this popover was
                 unanchored too. It just failed quietly, because Popover isn't modal and so never
                 froze the page the way the filter menu did. -->
            <IconTooltip :label="$t('sessions.advancedSearch')" :description="$t('sessions.advancedSearchHint')">
              <span class="absolute right-2 top-1/2 inline-flex -translate-y-1/2">
                <Popover v-model:open="advancedOpen">
                  <PopoverTrigger as-child>
                    <button
                      type="button"
                      class="rounded text-muted-foreground transition-colors hover:text-foreground"
                      :aria-label="$t('sessions.advancedSearch')"
                      @click="advancedQuery = advancedQuery || search"
                    >
                      <SlidersHorizontal class="size-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-80 space-y-3 p-3">
                    <p class="text-xs font-semibold">{{ $t('sessions.advancedSearchTitle') }}</p>
                    <div class="space-y-1.5">
                      <label class="text-xs font-medium text-muted-foreground">
                        {{ $t('sessions.advancedSearchQueryLabel') }}
                      </label>
                      <Input
                        v-model="advancedQuery"
                        :placeholder="$t('sessions.advancedSearchQueryPlaceholder')"
                        class="font-mono text-xs"
                        @keydown.enter="runBodySearch"
                      />
                    </div>
                    <div class="flex items-center justify-between">
                      <IconTooltip :label="$t('sessions.regexMode')" :description="$t('sessions.regexModeHint')">
                        <span class="text-xs" tabindex="0">{{ $t('sessions.regexMode') }}</span>
                      </IconTooltip>
                      <Switch v-model="advancedRegex" size="sm" />
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="text-xs">{{ $t('sessions.caseSensitive') }}</span>
                      <Switch v-model="advancedCaseSensitive" size="sm" />
                    </div>
                    <Button
                      size="sm"
                      class="w-full"
                      :disabled="!advancedQuery.trim() || bodySearching"
                      @click="runBodySearch"
                    >
                      {{ bodySearching ? $t('sessions.searching') : $t('sessions.searchButton') }}
                    </Button>
                  </PopoverContent>
                </Popover>
              </span>
            </IconTooltip>
          </div>
          <!-- Every list control lives in this one ⋯ menu: the toolbar had grown a row of icon
               buttons and each new toggle pushed the search field narrower.
               The DropdownMenu root MUST live INSIDE IconTooltip's slot, never around it.
               reka anchors a popper by walking the COMPONENT tree for the nearest PopperRoot:
               DropdownMenuTrigger renders a MenuAnchor, which injects that nearest root. With the
               menu wrapped AROUND the tooltip, the nearest root was the TOOLTIP's, so the tooltip
               ate the anchor and the menu's own popper got none. floating-ui then left the content
               at its unpositioned `translate(0,-200%)`, i.e. off-screen above the viewport, while
               the modal menu still set `body { pointer-events: none }`. That is the "nothing opens
               and the whole app locks up" bug. Nesting the root here puts PopperRoot(menu) BETWEEN
               the tooltip's anchor and MenuAnchor, so each popper anchors to its own element.
               The <span> is the tooltip's own anchor element (as-child needs one real element). -->
          <IconTooltip
            :label="$t('sessions.listOptions')"
            :description="filtersActive ? $t('sessions.listOptionsActive') : $t('sessions.listOptionsHint')"
          >
            <span class="inline-flex">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button
                    type="button"
                    :class="cn(buttonVariants({ variant: filtersActive ? 'secondary' : 'outline', size: 'icon' }))"
                    :aria-label="$t('sessions.listOptions')"
                  >
                    <MoreHorizontal />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="max-w-56">
                  <DropdownMenuItem @select="refreshSessions">
                    <RefreshCw :class="sessionsLoading ? 'animate-spin' : ''" />
                    {{ $t('sessions.refresh') }}
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <!-- @select.prevent keeps the menu open so several toggles can be flipped in one
                       visit; reka closes the menu on select otherwise. -->
                  <DropdownMenuCheckboxItem
                    :model-value="selectMode"
                    @select.prevent
                    @update:model-value="toggleSelectMode"
                  >
                    <ListTodo />
                    {{ $t('sessions.multiSelect') }}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />

                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <MessagesSquare />
                      {{ $t('sessions.filterSource') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ sourceFilterLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionSourceFilter">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.sourceAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="claude">{{ $t('sessions.sourceClaude') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="codex">{{ $t('sessions.sourceCodex') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="opencode">{{ $t('sessions.sourceOpenCode') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="hermes">{{ $t('sessions.sourceHermes') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <DropdownMenuSub
                    :disabled="
                      sessionSourceFilter === 'codex' ||
                      sessionSourceFilter === 'opencode' ||
                      sessionSourceFilter === 'hermes'
                    "
                  >
                    <DropdownMenuSubTrigger>
                      <Boxes />
                      {{ $t('sessions.filterInstance') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ instanceFilterLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-80">
                      <DropdownMenuRadioGroup v-model="sessionInstanceFilter">
                        <DropdownMenuRadioItem value="">{{ $t('sessions.instanceAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="default">{{ $t('sessions.instanceDefault') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem v-for="i in namedInstances" :key="i.name" :value="i.name">{{ i.label }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="other">{{ $t('sessions.instanceOther') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- work we queued vs work you drove by hand. Known exactly rather than inferred:
                       every dispatch names the session id on the command line, so a queue row for
                       that id IS the fact. Never applied on our own initiative — 'all' is the
                       default and stays it. -->
                  <DropdownMenuSub :disabled="sessionSourceFilter === 'codex' || sessionSourceFilter === 'opencode'">
                    <DropdownMenuSubTrigger>
                      <ListTodo />
                      {{ $t('sessions.dispatched') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ dispatchedScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionDispatchedScope">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.dispatchedAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="queued">{{ $t('sessions.dispatchedQueued') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="manual">{{ $t('sessions.dispatchedManual') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- sessions a usage wall cut off. Server-side like the scopes above it, but
                       the verdict comes from the transcript parse rather than the mtime index, so
                       the first use after an upgrade is slow while the scan cache refills. -->
                  <DropdownMenuSub :disabled="sessionSourceFilter === 'codex' || sessionSourceFilter === 'opencode'">
                    <DropdownMenuSubTrigger>
                      <CircleAlert />
                      {{ $t('sessions.rateLimited') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ rateLimitScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-64">
                      <DropdownMenuRadioGroup v-model="sessionRateLimitScope">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.rateLimitedAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="only">{{ $t('sessions.rateLimitedOnly') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="pending">{{ $t('sessions.rateLimitedPending') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <p class="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                        {{ $t('sessions.rateLimitedNote') }}
                      </p>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- shape: derived in the browser from the two numbers already on every row, so
                       unlike the scopes around it this one narrows what was FETCHED rather than
                       reaching further back. The note in the submenu says so. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Hourglass />
                      {{ $t('sessions.shape') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ shapeScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-60">
                      <DropdownMenuRadioGroup v-model="sessionShapeScope">
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.shapeAll') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="quick">{{ $t('sessions.shapeQuick') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="standard">{{ $t('sessions.shapeStandard') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="deep">{{ $t('sessions.shapeDeep') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="marathon">{{ $t('sessions.shapeMarathon') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="automation">{{ $t('sessions.shapeAutomation') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <p class="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                        {{ $t('sessions.shapeNote') }}
                      </p>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- three-way rather than a checkbox: archived is the large majority of the store,
                       so "only" is the only practical way to go back and find one. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Archive />
                      {{ $t('sessions.archived') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ archivedScopeLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionArchivedScope">
                        <DropdownMenuRadioItem value="hide">{{ $t('sessions.archivedHide') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="include">{{ $t('sessions.archivedInclude') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="only">{{ $t('sessions.archivedOnly') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <!-- how far back the list reaches. Applied server-side before the newest-N cap,
                       so widening the window genuinely reaches further back rather than
                       reshuffling the same rows. -->
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <CalendarRange />
                      {{ $t('sessions.period') }}
                      <span class="ml-auto max-w-24 truncate pl-2 text-[11px] text-muted-foreground">
                        {{ periodLabel }}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent class="max-w-52">
                      <DropdownMenuRadioGroup v-model="sessionPeriod">
                        <DropdownMenuRadioItem value="24h">{{ $t('sessions.period24h') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="7d">{{ $t('sessions.period7d') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="30d">{{ $t('sessions.period30d') }}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="all">{{ $t('sessions.periodAll') }}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <template v-if="doneCount > 0">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem @select="clearDoneMarks">
                      <CircleSlash />
                      {{ $t('sessions.clearDoneMarks') }}
                      <span class="ml-auto pl-2 text-[11px] text-muted-foreground">
                        {{ $t('sessions.doneMarkCount', { n: doneCount }) }}
                      </span>
                    </DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </IconTooltip>
        </div>

        <div
          v-if="selectMode"
          class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs"
        >
          <span class="text-muted-foreground">{{ $t('sessions.selectedCount', { n: checkedIds.size }) }}</span>
          <Button variant="ghost" size="xs" @click="checkAllFiltered">{{ $t('sessions.selectAll') }}</Button>
          <Button
            variant="ghost"
            size="xs"
            :disabled="checkedIds.size === 0"
            @click="checkedIds = new Set()"
          >
            {{ $t('sessions.clearSelection') }}
          </Button>
        </div>

        <!-- body-search results header: appears in place of the normal list once a content
             search has been run; "back" restores the plain metadata-filtered list -->
        <div
          v-if="bodySearchActive"
          class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs"
        >
          <Button variant="ghost" size="xs" @click="exitBodySearch">
            <ArrowLeft class="size-3" /> {{ $t('sessions.backToSessionList') }}
          </Button>
          <span class="truncate text-muted-foreground">
            {{ $t('sessions.bodySearchResultsFor', { query: bodySearchQueryUsed }) }}
          </span>
        </div>
        <!-- say what was actually searched. An empty result means nothing until you know whether
             the search covered everything, gave up early, or only read the conversation -->
        <div
          v-if="bodySearchActive && bodySearchNotice"
          class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-warning/10 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          <span>{{ bodySearchNotice }}</span>
          <button
            v-if="canSearchEverything"
            class="font-medium text-foreground underline underline-offset-2 disabled:opacity-50"
            :disabled="bodySearching"
            @click="runBodySearch({ everything: true })"
          >
            {{ bodySearching ? $t('sessions.searching') : $t('sessions.searchEverything') }}
          </button>
        </div>

        <div class="scroll-slim min-h-0 flex-1 overflow-y-auto p-2">
          <!-- first-load skeletons so the list never looks blank -->
          <template v-if="sessionsLoading && sessions.length === 0 && !bodySearchActive">
            <div v-for="i in 6" :key="i" class="mb-1.5 px-3 py-2.5">
              <Skeleton class="h-4" :style="{ width: `${88 - (i % 3) * 16}%` }" />
              <div class="mt-2.5 flex items-center gap-2">
                <Skeleton class="h-3 w-16" />
                <Skeleton class="h-3 w-10" />
                <Skeleton class="h-3 w-12" />
              </div>
            </div>
          </template>

          <!-- content (body) search results -->
          <template v-else-if="bodySearchActive">
            <p v-if="bodyResults.length === 0" class="p-4 text-center text-xs text-muted-foreground">
              {{ $t('sessions.noBodyMatches') }}
            </p>
            <button
              v-for="r in bodyResults"
              :key="`${r.source}:${r.session_id}`"
              class="mb-1.5 w-full rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/50"
              @click="selectFromBodyResult(r)"
            >
              <div class="flex items-start justify-between gap-2">
                <span class="line-clamp-1 min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                  {{ baseName(r.cwd) }} · {{ shortId(r.session_id) }}
                </span>
                <Badge
                  variant="outline"
                  :class="['shrink-0 text-[10px]', sourceBadgeClass(r.source)]"
                >
                  {{ rowSourceLabel(r) }}
                </Badge>
                <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {{ $t('sessions.matchCount', { n: r.match_count }) }}
                </span>
              </div>
              <p
                v-for="(snippet, i) in r.snippets"
                :key="i"
                class="mt-1 line-clamp-2 text-xs text-muted-foreground"
              >
                {{ snippet }}
              </p>
              <p v-if="r.truncated" class="mt-1 text-[11px] text-muted-foreground/70">
                {{ r.match_count - r.snippets.length }} {{ $t('sessions.truncatedMatches') }}
              </p>
            </button>
          </template>

          <!-- AH-20: the FIRST session fetch failing is not the same fact as a genuinely empty
               list — show why, with a Retry, rather than the plain "no sessions" copy that would
               read as an empty account instead of an outage. -->
          <div
            v-else-if="filtered.length === 0 && sessionsStatus.unavailable"
            class="p-4 text-center text-xs text-muted-foreground"
          >
            <CircleAlert class="mx-auto mb-1.5 size-5 text-warning" />
            <p>{{ $t('sessions.unavailable', { reason: sessionsStatus.error }) }}</p>
            <button
              type="button"
              class="mt-1.5 font-medium text-primary hover:underline"
              @click="refreshSessions"
            >
              {{ $t('sessions.retry') }}
            </button>
          </div>

          <div v-else-if="filtered.length === 0" class="p-4 text-center text-xs text-muted-foreground">
            <p>{{ $t('sessions.noSessionsFound') }}</p>
            <!-- the window is the most likely reason, and it is invisible until you open the ⋯
                 menu; offer the widening instead of making the user go find it -->
            <button
              v-if="emptyBecauseOfPeriod"
              type="button"
              class="mt-1.5 font-medium text-primary hover:underline"
              @click="sessionPeriod = 'all'"
            >
              {{ $t('sessions.periodEmptyHint', { period: periodLabel }) }}
            </button>
          </div>

          <!-- a LATER poll failing must not blank a list that already has good (if aging) data —
               it stays on screen, just labelled stale. Non-modal: a state of the list, not a toast. -->
          <p
            v-if="sessionsStatus.stale"
            class="mb-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning"
          >
            {{ $t('sessions.staleHint', { reason: sessionsStatus.error }) }}
          </p>

          <template v-if="!bodySearchActive">
            <!-- Each row owns a ContextMenu so right-click acts on the row under the pointer without
                 first selecting it (selecting would load a transcript the user never asked for).
                 The menu content only mounts while open, so the per-row cost is a reka root, not a
                 rendered menu. -->
            <ContextMenu v-for="s in filtered" :key="`${s.source}:${s.session_id}`">
              <ContextMenuTrigger as-child>
                <button
                  class="mb-1.5 w-full rounded-lg border px-3 py-2.5 text-left transition-colors"
                  :class="[
                    // Selected is a RAISED GREY, not an accent tint. bg-primary/10 composited to a
                    // maroon (#352626) against the dark ground, which read as a colour wash rather
                    // than a selection. Ladder in the sidebar: rest → hover (accent/50) → selected.
                    (selectMode
                      ? isChecked(s)
                      : s.session_id === selectedId && s.source === selectedSource)
                      ? 'border-border bg-accent'
                      : 'border-transparent hover:border-border hover:bg-accent/50',
                    // done rows stay in place and stay readable; they just stop competing for the eye
                    s.done && s.session_id !== selectedId ? 'opacity-55' : '',
                  ]"
                  @click="rowClick(s, $event)"
                >
                  <div class="flex items-start justify-between gap-2">
                    <span
                      v-if="selectMode"
                      class="mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors"
                      :class="[
                        isChecked(s)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                        s.source !== 'claude' ? 'opacity-25' : '',
                      ]"
                    >
                      <Check v-if="isChecked(s)" class="size-3" />
                    </span>
                    <CircleCheck
                      v-else-if="s.done"
                      class="mt-0.5 size-3.5 shrink-0 text-success"
                      :aria-label="$t('sessions.done')"
                    />
                    <span
                      class="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug"
                      :class="s.done ? 'line-through decoration-muted-foreground/40' : ''"
                      :title="titleOriginOf(s)"
                    >{{ s.title }}<!--
                      A title nobody chose gets a mark, and only that case: the string came out of a
                      wrapper around the first message, so it may match nothing the user has named.
                      --><span
                        v-if="titleIsUnattributed(s)"
                        class="ml-1 align-middle text-[10px] font-normal text-muted-foreground/70"
                      >&lt;{{ s.title_tag }}&gt;</span></span>
                    <!-- the wall this conversation died at. `pending` is the actionable half —
                         nothing followed the notice, so it is still sitting there — and it is the
                         only one loud enough to earn the warning colour. -->
                    <!-- ONLY while the wall is still the bottom of the transcript. A session that
                         hit a limit in the past and carried on is not rate limited, and a badge
                         that stays on forever stops meaning "this one needs you" — which is the
                         only thing it is for. `pending` is exactly that: nothing followed the
                         notice. Ever-hit is still reachable, as a filter. -->
                    <Badge
                      v-if="s.limit_stop?.pending"
                      variant="outline"
                      :title="limitTooltipOf(s)"
                      class="shrink-0 border-warning/50 bg-warning/10 text-[10px] text-warning"
                    >
                      {{ $t('sessions.rateLimitedBadgePending') }}
                    </Badge>
                    <StatusBadge v-if="s.queue_status" :status="s.queue_status" />
                    <Badge
                      variant="outline"
                      :class="['shrink-0 text-[10px]', sourceBadgeClass(s.source)]"
                    >
                      {{ rowSourceLabel(s) }}
                    </Badge>
                  </div>
                  <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span class="inline-flex items-center gap-1"><FolderGit2 class="size-3" />{{ baseName(s.cwd) }}</span>
                    <span v-if="s.git_branch" class="inline-flex items-center gap-1"><GitBranch class="size-3" />{{ s.git_branch }}</span>
                    <span class="inline-flex items-center gap-1"><MessagesSquare class="size-3" />{{ s.message_count }}</span>
                    <!-- the dot rides the timestamp it is derived from, so "green" and "2m ago" are
                         obviously the same fact rather than two claims to reconcile -->
                    <span class="inline-flex items-center gap-1">
                      <span
                        class="size-1.5 shrink-0 rounded-full"
                        :class="ACTIVITY_CLASS[activityOf(s)]"
                        :title="$t(ACTIVITY_LABEL[activityOf(s)])"
                      ></span>
                      <Clock class="size-3" />{{ timeAgo(s.last_activity_at) }}
                    </span>
                    <!-- SIZE, not a name. It sat unlabelled next to the account chip, so on a row
                         whose account was unknown "Marathon" was the last word on the line and read
                         as one. The tooltip says what it is; the always-present chip below stops it
                         being last. -->
                    <span class="inline-flex items-center gap-1" :title="shapeTitleOf(s)">
                      <ListTodo v-if="s.dispatched" class="size-3" />
                      <Hourglass v-else class="size-3" />{{ shapeLabel(sessionShape(s)) }}
                    </span>
                    <!-- Always rendered for a Claude session, even when the answer is "we don't
                         know". A blank space where the account goes reads as a rendering gap; the
                         truth is that Claude Desktop wrote no record of which account ran it, and
                         only saying so distinguishes the two. -->
                    <span
                      v-if="s.source === 'claude'"
                      class="inline-flex items-center gap-1"
                      :class="s.instance ? '' : 'text-muted-foreground/60'"
                      :title="s.instance ? undefined : $t('sessions.instanceUnknownHint')"
                    >
                      <Boxes class="size-3" />{{ s.instance ? (s.instance === 'default' ? $t('sessions.instanceDefault') : instanceLabelFor(s.instance)) : $t('sessions.instanceUnknown') }}
                    </span>
                    <!-- one conversation, several transcripts. Deliberately a label and not a
                         fold: every older copy measured held turns the newer one did not, and they
                         were things the user typed, so hiding one would lose them. -->
                    <span
                      v-if="s.copy_count > 1"
                      class="inline-flex items-center gap-1"
                      :title="copyWhyOf(s)"
                    >
                      <Layers class="size-3" />{{ copyChipOf(s) }}
                    </span>
                    <!-- this row stands for a fan-out: the subagents are sessions in the provider's
                         own store, folded in here rather than listed as conversations of their own -->
                    <span
                      v-if="s.subagent_count > 0"
                      class="inline-flex items-center gap-1"
                      :title="$t('sessions.subagentsHint', { count: s.subagent_count })"
                    >
                      <GitFork class="size-3" />{{ $t('sessions.subagents', { count: s.subagent_count }) }}
                    </span>
                    <!-- only meaningful while archived rows are being shown at all -->
                    <span
                      v-if="s.archived"
                      class="inline-flex items-center gap-1 text-muted-foreground"
                    >
                      <Archive class="size-3" />{{ $t('sessions.archived') }}
                    </span>
                  </div>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent class="max-w-60">
                <!-- Bulk section: only when THIS row is one of several checked rows, so a
                     right-click on an unchecked row still acts on that row alone. -->
                <template v-if="selectMode && bulkCount > 1 && isChecked(s)">
                  <ContextMenuLabel class="text-xs text-muted-foreground">
                    {{ $t('sessions.selectedCount', { n: bulkCount }) }}
                  </ContextMenuLabel>
                  <ContextMenuItem @select="copyCheckedIds">
                    <Copy />
                    {{ $t('sessions.copyNIds', { n: bulkCount }) }}
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger @pointerenter="loadMigrateTargets(null)">
                      <ArrowRightLeft class="size-3.5" />
                      {{ $t('sessions.migrateBulkLabel', { n: bulkCount }) }}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem v-if="migrateTargets.length === 0" disabled>
                        {{ $t('sessions.migrateNoTargets') }}
                      </ContextMenuItem>
                      <template v-if="runningTargets.length">
                        <ContextMenuLabel class="text-xs text-muted-foreground">
                          {{ $t('sessions.migrateRunningGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in runningTargets"
                          :key="target.ref"
                          :disabled="migrating"
                          @select="askBulkMigrate(target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ target.name }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                      <template v-if="closedTargets.length">
                        <ContextMenuSeparator v-if="runningTargets.length" />
                        <ContextMenuLabel class="text-xs text-muted-foreground">
                          {{ $t('sessions.migrateClosedGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in closedTargets"
                          :key="target.ref"
                          :disabled="migrating"
                          @select="askBulkMigrate(target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ $t('sessions.migrateClosedMove', { name: target.name }) }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                </template>
                <ContextMenuItem @select="toggleDone(s)">
                  <CircleCheck v-if="!s.done" />
                  <CircleSlash v-else />
                  {{ s.done ? $t('sessions.markNotDone') : $t('sessions.markDone') }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem @select="select(s)">
                  <MessagesSquare />
                  {{ $t('sessions.openTranscript') }}
                </ContextMenuItem>
                <template v-if="s.source !== 'opencode'">
                  <ContextMenuItem @select="openFile(s)">
                    <FileSymlink />
                    {{ $t('sessions.openFile') }}
                  </ContextMenuItem>
                  <ContextMenuItem :disabled="copyingFile" @select="copyFile(s)">
                    <ClipboardCopy />
                    {{ $t('sessions.copyFile') }}
                  </ContextMenuItem>
                  <ContextMenuItem @select="copyFileLocation(s)">
                    <Copy />
                    {{ $t('sessions.copyFileLocation') }}
                  </ContextMenuItem>
                </template>
                <!-- Same migrate flyout the open chat's ⋯ menu has, reachable without first opening
                     the transcript. Claude only: it is the one provider with desktop instances. -->
                <template v-if="s.source === 'claude'">
                  <ContextMenuSeparator />
                  <ContextMenuSub>
                    <ContextMenuSubTrigger @pointerenter="loadMigrateTargets(s)">
                      <ArrowRightLeft class="size-3.5" />
                      {{ $t('sessions.migrateAccount') }}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem v-if="migrateTargets.length === 0" disabled>
                        {{ $t('sessions.migrateNoTargets') }}
                      </ContextMenuItem>
                      <template v-if="runningTargets.length">
                        <ContextMenuLabel class="text-xs text-muted-foreground">
                          {{ $t('sessions.migrateRunningGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in runningTargets"
                          :key="target.ref"
                          :disabled="migrating || target.isCurrent"
                          @select="migrateTo(s, target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ target.name }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                      <template v-if="closedTargets.length">
                        <ContextMenuSeparator v-if="runningTargets.length" />
                        <ContextMenuLabel class="text-xs text-muted-foreground">
                          {{ $t('sessions.migrateClosedGroup') }}
                        </ContextMenuLabel>
                        <ContextMenuItem
                          v-for="target in closedTargets"
                          :key="target.ref"
                          :disabled="migrating || target.isCurrent"
                          @select="migrateTo(s, target)"
                        >
                          <ArrowRightLeft class="size-3.5" />
                          <span class="flex flex-col">
                            <span>{{ $t('sessions.migrateClosedMove', { name: target.name }) }}</span>
                            <span v-if="target.account" class="text-xs text-muted-foreground">
                              {{ target.account }}
                            </span>
                          </span>
                        </ContextMenuItem>
                      </template>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                </template>
                <ContextMenuSeparator />
                <ContextMenuItem @select="copy(s.title)">
                  <Copy />
                  {{ $t('sessions.copyTitle') }}
                </ContextMenuItem>
                <ContextMenuItem @select="copy(s.cwd)">
                  <FolderGit2 />
                  {{ $t('sessions.copyCwd') }}
                </ContextMenuItem>
                <ContextMenuItem @select="copy(s.session_id)">
                  <Copy />
                  {{ $t('sessions.copySessionId') }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </template>
        </div>
      </div>

      <!-- drag-resize handle (double-click resets) -->
      <div
        v-show="!collapsed"
        class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors"
        :class="resizing ? 'bg-accent' : 'hover:bg-accent/60'"
        :title="$t('sessions.resizeSidebar')"
        @pointerdown.prevent="startResize"
        @dblclick="sidebarWidth = SIDEBAR_DEFAULT"
      />
    </aside>

    <!-- detail: its own scroll column, composer pinned at the bottom -->
    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div v-if="!selected" class="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        <div class="text-center">
          <MessagesSquare class="mx-auto mb-2 size-8 opacity-40" />
          {{
            selectMode
              ? composerTargets.length
                ? $t('sessions.composeToSelected', { n: composerTargets.length })
                : $t('sessions.selectSessionsHint')
              : $t('sessions.selectSessionPrompt')
          }}
        </div>
      </div>

      <template v-else>
        <!-- borderless header: title + meta on the left, tool toggle + actions on the right -->
        <div class="shrink-0 p-4 pb-3">
          <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div class="min-w-0">
              <h2 class="truncate text-base font-semibold">{{ selected.title }}</h2>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span class="font-mono">{{ shortId(selected.session_id) }}</span>
                <Badge
                  variant="outline"
                  :class="['text-[10px]', sourceBadgeClass(selected.source)]"
                >
                  {{ rowSourceLabel(selected) }}
                </Badge>
                <!-- Which account is having this conversation. Read-only here on purpose: the
                     acts (open it, copy its address) live in the ⋯ menu, so a metadata line stays
                     a metadata line. The hover carries the full address, because the chip shows
                     the handle and two accounts on different domains share a handle. -->
                <!-- Two different reasons there is no address, and they are not interchangeable:
                     the instance is not in the list at all, or it IS and has no resolved identity
                     (signed out, or still resolving). Saying the first when it is the second sends
                     you looking for a missing instance that is sitting right there. -->
                <IconTooltip
                  v-if="sessionAccount"
                  :label="$t('sessions.accountLabel')"
                  :description="
                    sessionAccount.email ??
                    (sessionAccount.instance
                      ? $t('sessions.accountAddressUnknown')
                      : $t('sessions.accountUnresolved'))
                  "
                >
                  <span class="inline-flex items-center gap-1">
                    <UserRound class="size-3" />{{ sessionAccount.name }}
                  </span>
                </IconTooltip>
                <span class="inline-flex items-center gap-1"><FolderGit2 class="size-3" />{{ selected.cwd }}</span>
                <span class="inline-flex items-center gap-1">
                  <MessagesSquare class="size-3" />{{ tail?.events.length ?? 0 }} {{ $t('sessions.turnsShown') }}
                </span>
                <IconTooltip
                  v-if="usageSummary"
                  :label="$t('sessions.usageLabel')"
                  :description="usageDetail"
                >
                  <span class="inline-flex items-center gap-1">
                    <Coins class="size-3" />{{ usageSummary }}
                  </span>
                </IconTooltip>
                <!-- only ever shown when there is something to say. A permanent "0 secrets" badge
                     would read as a clean bill of health, which this scan cannot give. -->
                <IconTooltip
                  v-if="secrets && secrets.count > 0"
                  :label="$t('sessions.secretsLabel')"
                  :description="secretsDetail"
                >
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-warning"
                    @click="secretsOpen = true"
                  >
                    <KeyRound class="size-3" />{{ $t('sessions.secretsCount', { n: secrets.count }) }}
                  </button>
                </IconTooltip>
              </div>
            </div>
            <!-- Four standalone controls, everything else behind ⋯ — the same treatment the list
                 toolbar got, for the same reason: this row had grown to nine icon buttons and, being
                 in a wrapping flex beside the title, it stole a line from the metadata on any narrow
                 window. What stays out is what you reach for mid-read (find), plus the two copies
                 you hand to another tool (path, session id), plus close. The rest are
                 once-per-session acts and cost one extra click. -->
            <div class="flex shrink-0 items-center gap-1.5">
              <IconTooltip
                :label="$t('sessions.findInSession')"
                :description="$t('sessions.findInSessionHint')"
              >
                <Button
                  :variant="findOpen ? 'secondary' : 'outline'"
                  size="sm"
                  :aria-label="$t('sessions.findInSession')"
                  @click="findOpen ? closeFind() : openFind()"
                >
                  <Search />
                </Button>
              </IconTooltip>
              <!-- Link, not Copy: it sits next to the copy-session-id button, and two identical
                   clipboard glyphs side by side are indistinguishable at icon size. -->
              <IconTooltip
                v-if="selected.source !== 'opencode'"
                :label="$t('sessions.copyFileLocation')"
                :description="$t('sessions.copyFileLocationHint')"
              >
                <Button
                  variant="outline"
                  size="sm"
                  :aria-label="$t('sessions.copyFileLocation')"
                  @click="copyFileLocation(selected)"
                >
                  <Link />
                </Button>
              </IconTooltip>
              <IconTooltip
                :label="$t('sessions.copySessionId')"
                :description="$t('sessions.copySessionIdHint')"
              >
                <Button variant="outline" size="sm" @click="copy(selected.session_id)">
                  <Copy /> {{ $t('sessions.id') }}
                </Button>
              </IconTooltip>
              <!-- Display toggles + every file action. The DropdownMenu root MUST live INSIDE
                   IconTooltip's slot, wrapped in an element the tooltip can anchor to — see
                   scripts/checks/reka-popper-root-inside-tooltip.mjs for what happens otherwise.
                   The trigger goes `secondary` while a display filter is on, so a transcript that
                   is hiding turns still says so from the collapsed toolbar. -->
              <IconTooltip
                :label="$t('sessions.chatOptions')"
                :description="displayFiltered ? $t('sessions.displayControlsActive') : $t('sessions.chatOptionsHint')"
              >
                <span class="inline-flex">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        :variant="displayFiltered ? 'secondary' : 'outline'"
                        size="sm"
                        :aria-label="$t('sessions.chatOptions')"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="max-w-72">
                      <!-- The menu leads with WHICH ACCOUNT this chat is talking to, and the two
                           things you want from that answer: its app, or its address. Every instance
                           runs a different Anthropic login, and until now the open transcript named
                           none of them — you had to go to the Instances tab and match by folder.
                           Same reason the instance tables' kebabs lead with the instance number:
                           an open menu detached from the thing it acts on is a menu you hesitate
                           over. -->
                      <template v-if="sessionAccount">
                        <DropdownMenuLabel class="flex items-center gap-2 py-1">
                          <UserRound class="size-3.5 shrink-0" />
                          <span class="truncate">{{ sessionAccount.name }}</span>
                        </DropdownMenuLabel>
                        <!-- Unresolvable is a real state, not a blank: the instance folder may be
                             gone, or the regular non-isolated install may simply not be running (it
                             only appears in the list while a process for it does). Say so rather
                             than offering two controls that cannot work. -->
                        <DropdownMenuItem v-if="!sessionAccount.instance" disabled>
                          <Boxes class="size-3.5" />{{ $t('sessions.accountUnresolved') }}
                        </DropdownMenuItem>
                        <template v-else>
                          <DropdownMenuItem
                            :disabled="openingInstance"
                            @select="openSessionInstance()"
                          >
                            <Boxes class="size-3.5" />
                            {{
                              sessionAccount.instance.isRunning
                                ? $t('sessions.focusAccountInstance')
                                : $t('sessions.openAccountInstance')
                            }}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            :disabled="!sessionAccount.email"
                            @select="copySessionAccountEmail()"
                          >
                            <Copy class="size-3.5" />{{ $t('sessions.copyAccountEmail') }}
                          </DropdownMenuItem>
                        </template>
                        <DropdownMenuSeparator />
                      </template>
                      <DropdownMenuLabel class="flex items-center gap-2">
                        <SlidersHorizontal class="size-3.5" />{{ $t('sessions.displayControls') }}
                      </DropdownMenuLabel>
                      <DropdownMenuCheckboxItem
                        :model-value="humanOnly"
                        @select.prevent
                        @update:model-value="humanOnly = $event"
                      >
                        <UserRound class="size-3.5" />{{ $t('sessions.humanOnly') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="showTools"
                        :disabled="humanOnly"
                        @select.prevent
                        @update:model-value="showTools = $event"
                      >
                        <Wrench class="size-3.5" />{{ $t('sessions.showToolActivity') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="showThinking"
                        :disabled="humanOnly"
                        @select.prevent
                        @update:model-value="showThinking = $event"
                      >
                        <Brain class="size-3.5" />{{ $t('sessions.showThinking') }}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        :model-value="compactTranscript"
                        @select.prevent
                        @update:model-value="compactTranscript = $event"
                      >
                        <AlignJustify class="size-3.5" />{{ $t('sessions.compactLayout') }}
                      </DropdownMenuCheckboxItem>

                      <template v-if="selected.source !== 'opencode'">
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel class="flex items-center gap-2">
                          <FileSymlink class="size-3.5" />{{ $t('sessions.fileActions') }}
                        </DropdownMenuLabel>
                        <DropdownMenuItem @select="openFile(selected)">
                          <FileSymlink />{{ $t('sessions.openFile') }}
                        </DropdownMenuItem>
                        <!-- one entry, three formats. The raw .jsonl is still here because it is
                             the only lossless one; the two readable exports are what you hand to a
                             person. -->
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Download class="size-3.5" />{{ $t('sessions.saveCopy') }}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem as-child>
                              <a
                                :href="
                                  api.sessionExportUrl(
                                    selected.session_id,
                                    selected.source,
                                    'markdown',
                                    false,
                                    selected.locator,
                                  )
                                "
                                download
                              >
                                <FileText />{{ $t('sessions.exportMarkdown') }}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem as-child>
                              <a
                                :href="
                                  api.sessionExportUrl(
                                    selected.session_id,
                                    selected.source,
                                    'html',
                                    false,
                                    selected.locator,
                                  )
                                "
                                download
                              >
                                <Globe />{{ $t('sessions.exportHtml') }}
                              </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem as-child>
                              <a
                                :href="api.sessionFileUrl(selected.session_id, selected.source)"
                                :download="safeTranscriptFilename(selected.title, selected.session_id)"
                              >
                                <FileSymlink />{{ $t('sessions.exportRaw') }}
                              </a>
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem :disabled="copyingFile" @select="copyFile(selected)">
                          <ClipboardCopy />{{ $t('sessions.copyFile') }}
                        </DropdownMenuItem>
                      </template>

                      <template v-if="selected.source === 'claude'">
                        <DropdownMenuSeparator />
                        <DropdownMenuItem :disabled="resuming" @select="resumeInTerminal(selected)">
                          <SquareTerminal />{{ $t('sessions.resumeTerminal') }}
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger @pointerenter="loadMigrateTargets(selected)">
                            <ArrowRightLeft class="size-3.5" />{{ $t('sessions.migrateAccount') }}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem v-if="migrateTargets.length === 0" disabled>
                              {{ $t('sessions.migrateNoTargets') }}
                            </DropdownMenuItem>
                            <!-- Two groups. Running instances take the chat as they stand; a closed
                                 one is started first (a deliberate click, so the "nothing opens an
                                 account on its own" rule holds), then the chat moves. -->
                            <template v-if="runningTargets.length">
                              <DropdownMenuItem disabled class="text-xs text-muted-foreground">
                                {{ $t('sessions.migrateRunningGroup') }}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                v-for="target in runningTargets"
                                :key="target.ref"
                                :disabled="migrating || target.isCurrent"
                                @select="migrateTo(selected, target)"
                              >
                                <ArrowRightLeft class="size-3.5" />
                                <span class="flex flex-col">
                                  <span>{{ target.name }}</span>
                                  <span v-if="target.account" class="text-xs text-muted-foreground">
                                    {{ target.account }}
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            </template>
                            <template v-if="closedTargets.length">
                              <DropdownMenuSeparator v-if="runningTargets.length" />
                              <DropdownMenuItem disabled class="text-xs text-muted-foreground">
                                {{ $t('sessions.migrateClosedGroup') }}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                v-for="target in closedTargets"
                                :key="target.ref"
                                :disabled="migrating || target.isCurrent"
                                @select="migrateTo(selected, target)"
                              >
                                <ArrowRightLeft class="size-3.5" />
                                <span class="flex flex-col">
                                  <span>{{ $t('sessions.migrateClosedMove', { name: target.name }) }}</span>
                                  <span v-if="target.account" class="text-xs text-muted-foreground">
                                    {{ target.account }}
                                  </span>
                                </span>
                              </DropdownMenuItem>
                            </template>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </template>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </IconTooltip>
              <!-- close the open transcript (back to the pick-a-session state); the queue
                   drawer moved to the single purple button in the app header -->
              <IconTooltip :label="$t('sessions.closeChat')">
                <Button
                  variant="outline"
                  size="sm"
                  :aria-label="$t('sessions.closeChat')"
                  @click="selectedId = null"
                >
                  <X />
                </Button>
              </IconTooltip>
            </div>
          </div>
        </div>

        <!-- find within the loaded transcript: client-side, so the count is exact for what is on
             screen and there is no request behind a keystroke -->
        <div
          v-if="findOpen"
          class="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-4 py-2"
        >
          <Search class="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref="findInput"
            v-model="findQuery"
            class="h-7 max-w-xs text-xs"
            :placeholder="$t('sessions.findPlaceholder')"
            :aria-label="$t('sessions.findInSession')"
            @keydown.enter.exact.prevent="goToMatch(findIndex + 1)"
            @keydown.enter.shift.prevent="goToMatch(findIndex - 1)"
            @keydown.esc.prevent="closeFind"
          />
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground">
            {{
              findQuery
                ? findTotal
                  ? $t('sessions.findPosition', { i: findIndex + 1, n: findTotal })
                  : $t('sessions.findNone')
                : ''
            }}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!findTotal"
            :aria-label="$t('sessions.findPrevious')"
            @click="goToMatch(findIndex - 1)"
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!findTotal"
            :aria-label="$t('sessions.findNext')"
            @click="goToMatch(findIndex + 1)"
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="ml-auto"
            :aria-label="$t('sessions.findClose')"
            @click="closeFind"
          >
            <X />
          </Button>
        </div>

        <!-- transcript, styled as a chat: user right / assistant left, tool events as log lines -->
        <div
          ref="chatEl"
          class="scroll-slim min-h-0 flex-1 overflow-y-auto"
          :class="compactTranscript && 'transcript-compact'"
        >
          <div class="mx-auto w-full max-w-3xl px-4 py-4">
            <template v-if="tailLoading">
              <div class="space-y-4">
                <div class="flex justify-end"><Skeleton class="h-9 w-2/5 rounded-2xl" /></div>
                <div class="flex"><Skeleton class="h-20 w-4/5 rounded-2xl" /></div>
                <div class="flex justify-end"><Skeleton class="h-9 w-1/3 rounded-2xl" /></div>
                <div class="flex"><Skeleton class="h-14 w-3/5 rounded-2xl" /></div>
              </div>
            </template>

            <p v-else-if="tail?.error" class="text-xs text-destructive">{{ tail.error }}</p>
            <p v-else-if="events.length === 0" class="text-xs text-muted-foreground">
              {{ $t('sessions.noDisplayableTurns') }}
            </p>

            <template v-else>
              <div
                v-for="(ev, i) in events"
                :key="i"
                class="group flex items-end gap-1.5"
                :class="[
                  i > 0 && events[i - 1].role === ev.role ? 'mt-1.5' : 'mt-4',
                  ev.kind === 'text' && ev.role === 'user' ? 'justify-end' : 'justify-start',
                ]"
              >
                <!-- user bubbles get their copy button on the left, assistant on the right;
                     hover-revealed, but always faintly visible on touch screens -->
                <Button
                  v-if="ev.kind === 'text' && ev.role === 'user'"
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
                  :title="$t('sessions.copyMessage')"
                  @click="copyMessage(i, ev.text)"
                >
                  <Check v-if="copiedIdx === i" class="text-success" />
                  <Copy v-else />
                </Button>

                <!-- tool activity and reasoning: a compact log line, not a bubble -->
                <div
                  v-if="ev.kind !== 'text'"
                  class="w-full min-w-0 rounded-md border-l-2 border-border bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground"
                  :class="ev.kind === 'thinking' ? 'italic' : 'font-mono'"
                >
                  <div class="mb-0.5 flex items-center gap-1 font-semibold not-italic">
                    <Brain v-if="ev.kind === 'thinking'" class="size-3" />
                    <Wrench v-else class="size-3" />
                    {{ ev.kind === 'thinking' ? $t('sessions.thinkingLabel') : ev.tool_name ?? ev.kind }}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="ml-auto opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
                      :title="$t('sessions.copyMessage')"
                      @click="copyMessage(i, ev.text)"
                    >
                      <Check v-if="copiedIdx === i" class="text-success" />
                      <Copy v-else />
                    </Button>
                  </div>
                  <!-- eslint-disable-next-line vue/no-v-html -- the text is HTML-escaped before
                       anything reads it (lib/markdown.ts), and lib/find.ts only ever adds <mark>
                       around already-escaped slices, so no tag here came from the transcript -->
                  <div
                    class="break-words"
                    :class="[
                      ev.pre ? 'whitespace-pre-wrap' : 'md',
                      ev.long && !isExpanded(i) ? 'max-h-48 overflow-hidden' : '',
                    ]"
                    v-html="ev.html"
                  ></div>
                  <button
                    v-if="ev.long"
                    class="mt-1 text-[11px] font-medium text-primary hover:underline"
                    @click="toggleExpand(i)"
                  >
                    {{ isExpanded(i) ? $t('sessions.showLess') : $t('sessions.showMore') }}
                  </button>
                </div>

                <!-- chat bubbles: user = raised grey, assistant = flatter muted. The user bubble was
                     bg-primary/15, which composited to #352626 — a maroon block behind every message
                     you sent, rather than a neutral raised surface. -->
                <div
                  v-else
                  class="min-w-0 max-w-[85%] rounded-2xl px-3.5 py-2 text-sm"
                  :class="ev.role === 'user' ? 'rounded-br-md bg-accent' : 'rounded-bl-md bg-muted/50'"
                >
                  <!-- eslint-disable-next-line vue/no-v-html -- see the note above -->
                  <div
                    class="break-words"
                    :class="[
                      ev.pre ? 'whitespace-pre-wrap' : 'md',
                      ev.long && !isExpanded(i) ? 'max-h-56 overflow-hidden' : '',
                    ]"
                    v-html="ev.html"
                  ></div>
                  <button
                    v-if="ev.long"
                    class="mt-1 text-[11px] font-medium text-primary hover:underline"
                    @click="toggleExpand(i)"
                  >
                    {{ isExpanded(i) ? $t('sessions.showLess') : $t('sessions.showMore') }}
                  </button>
                </div>

                <Button
                  v-if="ev.kind === 'text' && ev.role !== 'user'"
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-60"
                  :title="$t('sessions.copyMessage')"
                  @click="copyMessage(i, ev.text)"
                >
                  <Check v-if="copiedIdx === i" class="text-success" />
                  <Copy v-else />
                </Button>
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- chat-style input: messages the open session, or every checked one -->
      <SessionComposer
        v-if="composerTargets.length"
        class="shrink-0"
        :targets="composerTargets"
        @sent="onComposerSent"
      />
      <!-- ...and, where there can be no input, why -->
      <div v-else-if="readOnlySource" class="shrink-0 bg-background">
        <div
          class="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-3 text-xs text-muted-foreground"
        >
          <BookOpen class="size-3.5 shrink-0" />
          <span>{{ $t('sessions.readOnlySource', { source: sourceLabel(readOnlySource) }) }}</span>
        </div>
      </div>
    </section>

    <!-- the findings, redacted. There is no reveal control, and the daemon has no endpoint that
         could serve one: the transcript is already open one panel away, so revealing here would only
         add a second place credentials live. -->
    <!-- Bulk migrate confirmation: names the count and the destination, lists the chats, and makes
         the move a second deliberate click. -->
    <Dialog :open="bulkConfirm !== null" @update:open="(v) => { if (!v) bulkConfirm = null }">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {{ $t('sessions.migrateConfirmTitle', { n: bulkConfirm?.sessions.length ?? 0, name: bulkConfirm?.target.name ?? '' }) }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('sessions.migrateConfirmBody', { name: bulkConfirm?.target.name ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">{{ $t('sessions.dialogRowHint') }}</p>
        <!-- Grouped by project, largest group first, so the SHAPE of the move is visible before the
             click: three Connections chats and ten AgentHydra ones read differently from "13". -->
        <ul class="scroll-slim max-h-56 space-y-2 overflow-y-auto text-xs">
          <li v-for="g in groupByProject(bulkConfirm?.sessions ?? [])" :key="g.project">
            <div class="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
              <span class="truncate">{{ g.project }}</span>
              <span class="shrink-0">{{ $t('sessions.groupCount', { n: g.sessions.length }) }}</span>
            </div>
            <ul class="space-y-1">
              <li v-for="s in g.sessions" :key="s.session_id">
                <button
                  type="button"
                  class="w-full truncate rounded border border-border px-2 py-1 text-left hover:bg-accent"
                  @click="openFromBulkDialog(s)"
                >
                  {{ s.title }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" @click="bulkConfirm = null">{{ $t('sessions.migrateConfirmCancel') }}</Button>
          <Button :disabled="migrating || !bulkConfirm?.sessions.length" @click="runBulkMigrate">
            {{ $t('sessions.migrateConfirmSubmit', { n: bulkConfirm?.sessions.length ?? 0 }) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="secretsOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('sessions.secretsTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('sessions.secretsCaveat') }}</DialogDescription>
        </DialogHeader>
        <ul class="scroll-slim max-h-80 space-y-1 overflow-y-auto text-xs">
          <li
            v-for="(f, i) in secrets?.findings ?? []"
            :key="i"
            class="flex items-center gap-2 rounded border border-border px-2 py-1.5"
          >
            <Badge variant="outline" class="shrink-0 text-[10px]">{{ f.kind }}</Badge>
            <span class="min-w-0 flex-1 truncate font-mono">{{ f.redacted }}</span>
            <span class="shrink-0 text-muted-foreground">
              {{ $t('sessions.secretsTurn', { n: f.turn + 1 }) }}
            </span>
          </li>
        </ul>
        <p v-if="secrets?.truncated" class="text-xs text-muted-foreground">
          {{ $t('sessions.secretsTruncated', { n: secrets.count }) }}
        </p>
      </DialogContent>
    </Dialog>
  </div>
</template>
