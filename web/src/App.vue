<script setup lang="ts">
import {
  BarChart3,
  Boxes,
  ListChecks,
  MessagesSquare,
  Monitor,
  Moon,
  Power,
  Settings2,
  Sun,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import AnalyticsView from '@/components/AnalyticsView.vue'
import InstancesView from '@/components/InstancesView.vue'
import QueueBuilder from '@/components/QueueBuilder.vue'
import QueueView from '@/components/QueueView.vue'
import SchedulerStatus from '@/components/SchedulerStatus.vue'
import SessionsView from '@/components/SessionsView.vue'
import SettingsView from '@/components/SettingsView.vue'
import ShortcutSheet from '@/components/ShortcutSheet.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useData } from '@/composables/useData'
import { useNotifications } from '@/composables/useNotifications'
import { usePanels } from '@/composables/usePanels'
import { SHELL_BASE_MAX, SHELL_WIDE_MAX, useShellWidth } from '@/composables/useShellWidth'
import { openShortcutSheet, useShortcuts } from '@/composables/useShortcuts'
import { type AppView, useUiPrefs } from '@/composables/useUiPrefs'
import { useUpdates } from '@/composables/useUpdates'
import { shutdownApp } from '@/lib/api'
import { pendingSessionJump } from '@/lib/session-jump'
import { REBRAND_NOTICE_KEY } from '@/lib/storage-rebrand'
import { type ThemeMode, useTheme } from '@/lib/theme'
import { applyWindowSizeHint } from '@/lib/window-size-hint'
import SettingsPanel from '@/shell/SettingsPanel.vue'
import Sidebar from '@/shell/Sidebar.vue'
import { usePushPanel } from '@/shell/usePushPanel'

// A portable (--app) window forwarded into an already-running Chromium instance ignores
// --window-size and the saved placement; the daemon/tray tag its URL with the size it should
// be and we correct it here before first paint. No-op in a browser tab or on an un-hinted URL.
applyWindowSizeHint()

const { t } = useI18n()

const { queue, startPolling } = useData()
// Reset notifications. The NATIVE notification is raised by the daemon whether or not this window
// exists (that is the point of it); this mirror is so the news also lands in the app when you do
// happen to be looking at it, with the Acknowledge action that stops persistent mode repeating.
const { startPolling: startNotificationPolling } = useNotifications()

// Which tab you were on, remembered across reloads — and across the daemon landing on a different
// port, which is a different browser origin and therefore a different localStorage. Owned by
// composables/useUiPrefs.ts, which is where every mirrored layout preference lives.
const { view } = useUiPrefs()
// "Open this chat" asked from another view (the Instances move dialog lists chats; clicking one
// should land on its transcript). Switch the tab here; SessionsView takes the request when it
// mounts, or at once if it is already the view showing. See lib/session-jump.ts.
watch(pendingSessionJump, (j) => {
  if (j) view.value = 'sessions'
})

// The shell's own bindings — global, so they are on every view and lead the `?` sheet. Registered
// here rather than in each view because that is what makes them true everywhere.
useShortcuts([
  {
    keys: '?',
    labelKey: 'app.shortcutShowSheet',
    groupKey: 'app.shortcutGroupApp',
    run: openShortcutSheet,
  },
  {
    keys: 'mod+1',
    labelKey: 'app.shortcutSessions',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'sessions'
    },
  },
  {
    keys: 'mod+2',
    labelKey: 'app.shortcutInstances',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'instances'
    },
  },
  {
    keys: 'mod+3',
    labelKey: 'app.shortcutAnalytics',
    groupKey: 'app.shortcutGroupApp',
    run: () => {
      view.value = 'analytics'
    },
  },
])

// settings + queue share the right edge; usePanels keeps them mutually exclusive
const { settingsOpen, queueOpen, openSettingsTab } = usePanels()
// The passive "a newer version exists" signal — see the dot on the Settings button below.
const {
  updateAvailable,
  showUpdateDot,
  dismissUpdateDot,
  startAvailabilityPolling,
  stopAvailabilityPolling,
} = useUpdates()

/**
 * Opening Settings from the header button.
 *
 * With an update waiting this is a DEEP LINK rather than a plain toggle: the dot is the only
 * thing telling you a new version exists and it says nothing about what or why, so the click it
 * invites should land on the answer. openSettingsTab scrolls to the updates card and pulses it
 * (SettingsView's flashSection), and the dot goes quiet for the rest of this run — it has been
 * seen. Next launch it comes back, because the update is still there.
 *
 * With nothing waiting it stays an ordinary open/close toggle: deep-linking every click would
 * yank a user who just wanted the top of the page down to a card they did not ask for.
 */
function onSettingsButton() {
  // Already open: this click means CLOSE, whatever the dot says. Deep-linking here would make the
  // button stop closing the panel for as long as an update is pending, which is the button's
  // primary job.
  if (settingsOpen.value) {
    settingsOpen.value = false
    return
  }
  if (showUpdateDot.value) {
    dismissUpdateDot()
    openSettingsTab('updates')
    return
  }
  settingsOpen.value = true
}
const anyPanelOpen = computed(() => settingsOpen.value || queueOpen.value)
const { wide } = useShellWidth()
// widthPx drives the content shift, the --content-inset-right var, and both panels'
// rendered width below — one value so they can never disagree. shellMaxWidth makes the
// shift the panel's actual overlap with the centered shell (0 on a wide monitor).
const { side, containerStyle, widthPx } = usePushPanel(anyPanelOpen, {
  widthPx: 480,
  shellMaxWidth: () => (wide.value ? SHELL_WIDE_MAX : SHELL_BASE_MAX),
})
// The header shares the panel shift but must keep its own 16px (px-4) of breathing room
// on top of it; a bare containerStyle would put the buttons flush against the panel edge.
const headerStyle = computed(() =>
  containerStyle.value.paddingRight
    ? { paddingRight: `calc(${containerStyle.value.paddingRight} + 1rem)` }
    : {},
)

// Everything in Settings auto-saves; the footer button flushes the one buffered
// form (scheduler numbers) and gives the reassuring "saved" moment people expect.
// (Typed structurally, not via InstanceType<typeof SettingsView>: a type-position-only
// reference makes biome demote the import to type-only, unmounting the component.)
const settingsView = ref<{ save: () => Promise<void> } | null>(null)
function saveSettings() {
  settingsView.value?.save()
}

// --- settings-panel header controls: theme picker + shut down (moved out of the Appearance
// section into icons beside the panel's ✕, owner request) ---------------------------------------
const { mode: themeMode, isDark, setTheme } = useTheme()
// Reflect the ACTIVE theme in the trigger glyph: sun/moon for an explicit light/dark, a monitor
// for "follow the system".
const themeIcon = computed(() =>
  themeMode.value === 'system' ? Monitor : isDark.value ? Moon : Sun,
)

// Two-step so an errant click can't kill the app: first click arms (button turns red + tooltip
// changes), second confirms. Loses the armed state on blur, matching the cloud-sync disconnect.
const confirmShutdown = ref(false)
async function onShutdown() {
  if (!confirmShutdown.value) {
    confirmShutdown.value = true
    return
  }
  confirmShutdown.value = false
  toast(t('settings.shutdownToast'))
  try {
    await shutdownApp()
  } catch {
    // The daemon answers { ok } BEFORE it exits, so a rejection here is a genuine failure (not just
    // the socket dropping as it goes down).
    toast.error(t('settings.shutdownToastFailed'))
  }
}

const nav: { id: AppView; labelKey: string; icon: typeof MessagesSquare }[] = [
  { id: 'sessions', labelKey: 'app.tabSessions', icon: MessagesSquare },
  { id: 'instances', labelKey: 'app.tabInstances', icon: Boxes },
  { id: 'analytics', labelKey: 'app.tabAnalytics', icon: BarChart3 },
]

const runningCount = computed(() => queue.value.filter((q) => q.status === 'running').length)

// The "Sync my settings with Connections" sign-in (SettingsView.vue) opens /oauth/login in a
// NEW tab; that tab's SPA boots fresh here and lands back on ?connected=1 / ?connect=failed
// after the daemon's /oauth/callback redirect. Surface the outcome, open Settings so the
// result is visible, and strip the query param so a refresh doesn't re-trigger the toast.
function handleConnectRedirect() {
  const params = new URLSearchParams(window.location.search)
  const connected = params.get('connected')
  const failed = params.get('connect')
  if (!connected && !failed) return
  params.delete('connected')
  params.delete('connect')
  const query = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
  settingsOpen.value = true
  if (connected === '1') toast.success(t('settings.cloudSyncEnableToggle'))
  else if (failed === 'failed') toast.error(t('settings.cloudSyncConnectFailed'))
}

// One-time rename notice, shown only to installs that carried CC Manager UI state across (the
// carry-over in lib/storage-rebrand sets the flag). Cleared before the toast is raised, not after
// it is dismissed: an unread toast that survives a reload would follow the user around forever,
// and the same explanation lives permanently in the README and changelog.
function showRebrandNoticeOnce() {
  try {
    if (localStorage.getItem(REBRAND_NOTICE_KEY) !== '1') return
    localStorage.removeItem(REBRAND_NOTICE_KEY)
  } catch {
    return // storage blocked; the notice is not worth a broken mount
  }
  toast(t('app.rebrandTitle'), {
    description: t('app.rebrandBody'),
    duration: 30_000,
    action: {
      label: t('app.rebrandAction'),
      onClick: () =>
        window.open('https://github.com/LunarWerxs/AgentHydra/blob/main/CHANGELOG.md', '_blank'),
    },
  })
}

onMounted(startPolling)
onMounted(() => startNotificationPolling(t))
onMounted(handleConnectRedirect)
onMounted(showRebrandNoticeOnce)
// Reads the daemon's LAST background check — a memory read, no network from the daemon's side and
// nothing that delays boot. See composables/useUpdates.ts.
onMounted(startAvailabilityPolling)
onUnmounted(stopAvailabilityPolling)
</script>

<template>
  <!-- TooltipProvider: required ancestor for every kit Tooltip/InfoHint (mounted once, like ReDesign) -->
  <TooltipProvider :delay-duration="120">
  <!-- fixed-viewport shell, centered at a comfortable reading width: each view scrolls
       its own columns internally; the page itself never scrolls. Views that benefit from
       room (an open transcript) request the wide cap via useShellWidth and the whole
       shell — header included — animates out to meet them. -->
  <div
    class="mx-auto flex h-dvh w-full flex-col overflow-hidden border-x border-border transition-[max-width] duration-300 ease-in-out"
    :style="{ maxWidth: `${wide ? SHELL_WIDE_MAX : SHELL_BASE_MAX}px` }"
  >
    <!-- top bar (borderless: the content columns carry their own separators). Shares the
         push-panel padding shift with the main content, or an open drawer would cover the
         right-side buttons instead of nudging them over. -->
    <header
      class="flex shrink-0 items-center gap-3 bg-sidebar px-4 py-2 transition-[padding] duration-300 ease-in-out"
      :style="headerStyle"
    >
      <div class="flex items-center gap-2.5">
        <!-- the real brand mark (same asset as the favicon/tray icon), not a placeholder glyph -->
        <img src="/favicon.svg" alt="" class="size-8 rounded-lg" />
        <span class="hidden text-sm font-bold tracking-tight min-[480px]:inline">AgentHydra</span>
      </div>

      <!-- view tabs -->
      <nav class="ml-2 flex items-center gap-1">
        <Button
          v-for="n in nav"
          :key="n.id"
          :variant="view === n.id ? 'secondary' : 'ghost'"
          size="sm"
          :title="$t(n.labelKey)"
          @click="view = n.id"
        >
          <component :is="n.icon" />
          <span class="hidden sm:inline">{{ $t(n.labelKey) }}</span>
        </Button>
      </nav>

      <div class="ml-auto flex items-center gap-2">
        <!-- always-on "is it working?" indicator: scheduler state + live run / next-run -->
        <SchedulerStatus />
        <!-- New run lives inside the queue drawer's toolbar (QueueView) now, so the header
             carries just the queue toggle + settings. -->
        <!-- queue drawer toggle: stays available on every view. Brand-purple (primary)
             at rest; this is now the ONE queue button, so it carries the accent the
             old in-chat one had; secondary while the drawer is open (pressed state). -->
        <Button
          :variant="queueOpen ? 'secondary' : 'default'"
          size="sm"
          :title="$t('app.queue')"
          :aria-pressed="queueOpen"
          @click="queueOpen = !queueOpen"
        >
          <ListChecks />
          <span class="hidden sm:inline">{{ $t('app.queue') }}</span>
          <span
            v-if="runningCount > 0"
            class="ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-[0.625rem] font-semibold"
            :class="queueOpen ? 'bg-info/15 text-info' : 'bg-primary-foreground/25 text-primary-foreground'"
          >
            {{ runningCount }}
          </span>
        </Button>
        <!-- The update hint lives HERE, on the button that leads to the update controls, rather
             than as a banner or a toast. A newer version is not urgent — it does not want the
             screen — but it does have to be visible without going looking for it, and that was the
             whole failure: the only code that ever checked was the Settings screen's own onMounted,
             so a user who never opened Settings was never told. A dot on the door to the thing is
             the smallest signal that still reaches someone who isn't already there. -->
        <Button
          variant="ghost"
          size="icon-sm"
          class="relative"
          :title="updateAvailable ? $t('app.settingsUpdateAvailable') : $t('app.settings')"
          :aria-pressed="settingsOpen"
          @click="onSettingsButton"
        >
          <Settings2 />
          <span
            v-if="showUpdateDot"
            class="absolute right-0.5 top-0.5 size-2 rounded-full bg-info ring-2 ring-background"
          />
        </Button>
      </div>
    </header>

    <!-- main (pushes left when a right-docked panel overlaps the shell) -->
    <div class="min-h-0 flex-1 transition-[padding] duration-300 ease-in-out" :style="containerStyle">
      <main
        class="h-full min-h-0"
        :class="view === 'instances' ? 'overflow-y-auto scroll-slim' : ''"
      >
        <Transition name="view-fade" mode="out-in">
          <SessionsView v-if="view === 'sessions'" />
          <AnalyticsView v-else-if="view === 'analytics'" />
          <InstancesView v-else />
        </Transition>
      </main>
    </div>

    <QueueBuilder />

    <!-- queue: a push-in drawer so the list rides alongside whatever you're doing -->
    <Sidebar
      v-model:open="queueOpen"
      :side="side"
      :title="$t('queue.title')"
      :width-px="widthPx"
      body-class="flex min-h-0 flex-1 flex-col"
    >
      <QueueView />
    </Sidebar>

    <!-- settings: the shared push-in panel. Custom header carries the theme picker + shut-down
         icons beside the panel's ✕ (owner request). -->
    <SettingsPanel v-model:open="settingsOpen" :side="side" :title="$t('app.settings')" :width-px="widthPx">
      <template #header>
        <span class="text-xs font-semibold">{{ $t('app.settings') }}</span>
        <div class="ml-auto flex items-center gap-0.5">
          <!-- theme picker (moved out of the Appearance section) -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :title="$t('settings.themeLabel')">
                <component :is="themeIcon" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="max-w-44">
              <DropdownMenuRadioGroup
                :model-value="themeMode"
                @update:model-value="(v) => setTheme(v as ThemeMode)"
              >
                <DropdownMenuRadioItem value="light"><Sun /> {{ $t('settings.themeLight') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark"><Moon /> {{ $t('settings.themeDark') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system"><Monitor /> {{ $t('settings.themeSystem') }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <!-- shut down: closes the whole app (window + daemon + tray). Two-step to prevent a
               mis-click; see onShutdown. -->
          <Button
            variant="ghost"
            size="icon-sm"
            :title="confirmShutdown ? $t('settings.shutdownConfirmTooltip') : $t('settings.shutdownTooltip')"
            :class="confirmShutdown ? 'text-destructive' : ''"
            @click="onShutdown"
            @blur="confirmShutdown = false"
          >
            <Power />
          </Button>
        </div>
      </template>
      <SettingsView ref="settingsView" />
      <template #footer>
        <div class="flex justify-end">
          <Button size="sm" @click="saveSettings">{{ $t('settings.saveSettings') }}</Button>
        </div>
      </template>
    </SettingsPanel>

    <!-- close-button: vue-sonner defaults it OFF, which left every toast in the app dismissable
         only by waiting it out or clicking its body. The plain ones showed it worst — an
         "Auto-updates enabled" success toast carries no action button either, so it had no
         controls at all. The kit's wrapper (components/ui/sonner/Sonner.vue) already ships the
         close glyph and pins it top-right, so this is switching on a control that was built and
         never enabled, not adding one. -->
    <ShortcutSheet />
    <Toaster close-button />
  </div>
  </TooltipProvider>
</template>

<style scoped>
.view-fade-enter-active,
.view-fade-leave-active {
  transition: opacity 150ms ease;
}
.view-fade-enter-from,
.view-fade-leave-to {
  opacity: 0;
}
</style>
