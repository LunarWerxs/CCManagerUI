// web/src/composables/useUiPrefs.ts — the remembered layout choices no other composable owns.
//
// These used to be declared inside the components that read them, which was fine while
// localStorage was the only place they lived. It stops being fine the moment they are mirrored
// through the daemon (composables/useSharedPrefs.ts): a registration is keyed, so only the FIRST
// mount's ref is ever the mirrored one, and a view behind a tab unmounts the moment you switch
// away — after which that ref is detached and every later change to the preference goes nowhere.
// Module scope is what makes "one ref per preference, for the life of the window" true, the same
// reasoning composables/useUsageMode.ts and useInstanceFilter.ts already carry.
//
// Why mirror them at all: the full daemon HOPS to 7788/7789/… whenever its preferred port is busy,
// and a browser scopes localStorage to scheme+host+PORT. Every hop is therefore a new origin with
// an empty cache, and a preference that lives only in the browser is a preference the app forgets
// on those launches — not a rare case on a machine that runs the daemon alongside other things.
//
// What is deliberately NOT here: the theme (owned by the shared kit under its own un-namespaced
// key, which the daemon's store does not accept and should not), and the locale (written by the
// kit's i18n factory with no ref to mirror, and English is the only catalog that ships today).

import { useStorage } from '@vueuse/core'
import { watch } from 'vue'
import {
  APP_VIEW_KEY,
  APP_VIEWS,
  type AppView,
  createTabView,
  parseAppView,
  tabStorage,
} from '@/lib/app-view'
import { registerSharedPref } from './useSharedPrefs'

export { APP_VIEWS, type AppView } from '@/lib/app-view'

// --- which tab you were on --------------------------------------------------------------------
// The app is a long-lived tray window that gets reloaded for all sorts of incidental reasons (an
// update, a restart, a stray F5), and landing back on Sessions every time undid whatever you were
// in the middle of looking at.
//
// Unlike everything else in this file it is NOT one value shared by every window — two windows on
// two different tabs is a normal way to use the app, and this used to be impossible. The rule, and
// why the two storages differ, is in lib/app-view.ts; here it is only wired up.

/** Where a BRAND-NEW window opens: localStorage, mirrored through the daemon. Written by every
 *  window, read by none after first paint. Validated on read, not trusted — a stale or hand-edited
 *  value must fall back rather than render a tab that no longer exists, and the same set is handed
 *  to the mirror, which has to make the same guarantee about what the daemon's store gives back. */
const storedView = useStorage<AppView>(APP_VIEW_KEY, 'sessions', undefined, {
  // No cross-window listener. That listener IS the bug: same origin, so a click in one window was
  // pushed into the other one live. This key is a memory for next time, not a channel between
  // windows, and the daemon mirror below is how it reaches a window on a different port.
  listenToStorageChanges: false,
  serializer: {
    read: (raw) => parseAppView(raw) ?? 'sessions',
    write: (v) => v,
  },
})

/** Where THIS window is, which is what the shell's tabs bind to. */
const view = createTabView(storedView, tabStorage())

// --- Instances: which tables are expanded -------------------------------------------------------
// Someone who runs only CLI logins collapses the other table once and expects it to stay that way.

const desktopOpen = useStorage('agenthydra.instances.desktopOpen', true)
const cliOpen = useStorage('agenthydra.instances.cliOpen', true)
const codexOpen = useStorage('agenthydra.instances.codexOpen', true)

// --- Sessions: transcript verbosity, search case, sidebar width ---------------------------------

/** Verbose mode: also show tool_use / tool_result events (off = responses only). */
const showTools = useStorage('agenthydra.sessions.showTools', false)
/** Show the model's reasoning blocks. Off by default, and deliberately so: they are the bulkiest
 *  part of a transcript and the least useful part to skim. */
const showThinking = useStorage('agenthydra.sessions.showThinking', false)
/** Only what a person typed. The tail's turn window is applied AFTER this filter on the daemon, so
 *  turning it on genuinely reaches back through a long session rather than thinning 40 turns. */
const humanOnly = useStorage('agenthydra.sessions.humanOnly', false)
/** Tighter bubbles and smaller type — the same turns, more of them on screen. Purely visual, so it
 *  never re-fetches. */
const compactTranscript = useStorage('agenthydra.sessions.compact', false)
/** Case sensitivity for the opt-in body search. */
const advancedCaseSensitive = useStorage('agenthydra.sessions.advancedCaseSensitive', false)

// --- "Copy session file location": what actually lands on the clipboard -------------------------
//
// The bare path is what this action always copied, and on its own it is not much use for the thing
// people do next, which is hand the session to another agent and ask it to carry on. These two add
// the missing halves of that: what the conversation was CALLED, and the sentence to start with.
// Both default ON — a setting you have to go and find is a setting that does nothing — and turning
// both off restores the original path-only behaviour exactly.

/** Put the session's title on the clipboard above the path. */
const copyPathIncludeName = useStorage('agenthydra.sessions.copyPathIncludeName', true)
/** Put a prompt on the clipboard, so the paste is something you can send rather than a file path. */
const copyPathIncludePrompt = useStorage('agenthydra.sessions.copyPathIncludePrompt', true)
/** The prompt itself. Free text, so it carries no allowed-value list when it is registered below. */
const copyPathPrompt = useStorage('agenthydra.sessions.copyPathPrompt', 'Resume where we left off')

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 560
export const SIDEBAR_DEFAULT = 340
export const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))

const sidebarWidth = useStorage('agenthydra.sessions.sidebarWidth', SIDEBAR_DEFAULT)
sidebarWidth.value = clampWidth(sidebarWidth.value)
// Clamped on every write, not just the first read: the drag already clamps its own arithmetic, but
// a width arriving from the daemon's store (or from a hand-edited file) has been through neither.
// Converges in one step, so it cannot loop.
watch(sidebarWidth, (w) => {
  const bounded = clampWidth(w)
  if (bounded !== w) sidebarWidth.value = bounded
})

// Mirrored through the daemon, at module scope, for the reasons in the header.
registerSharedPref(APP_VIEW_KEY, storedView, APP_VIEWS)
registerSharedPref('agenthydra.instances.desktopOpen', desktopOpen)
registerSharedPref('agenthydra.instances.cliOpen', cliOpen)
registerSharedPref('agenthydra.instances.codexOpen', codexOpen)
registerSharedPref('agenthydra.sessions.showTools', showTools)
registerSharedPref('agenthydra.sessions.showThinking', showThinking)
registerSharedPref('agenthydra.sessions.humanOnly', humanOnly)
registerSharedPref('agenthydra.sessions.compact', compactTranscript)
registerSharedPref('agenthydra.sessions.advancedCaseSensitive', advancedCaseSensitive)
registerSharedPref('agenthydra.sessions.sidebarWidth', sidebarWidth)
registerSharedPref('agenthydra.sessions.copyPathIncludeName', copyPathIncludeName)
registerSharedPref('agenthydra.sessions.copyPathIncludePrompt', copyPathIncludePrompt)
registerSharedPref('agenthydra.sessions.copyPathPrompt', copyPathPrompt)

/** The shared, persisted layout state. Singletons — every caller gets the same refs. */
export function useUiPrefs() {
  return {
    view,
    desktopOpen,
    cliOpen,
    codexOpen,
    showTools,
    showThinking,
    humanOnly,
    compactTranscript,
    advancedCaseSensitive,
    sidebarWidth,
    copyPathIncludeName,
    copyPathIncludePrompt,
    copyPathPrompt,
  }
}
