import { createApp } from 'vue'
import { hydrateSharedPrefs } from './composables/useSharedPrefs'
import { appModeForPath } from './lib/app-mode'
import { startSignInNudgeSession } from './lib/sign-in-nudge'
import { migrateLegacyStorageKeys } from './lib/storage-rebrand'
import { migrateLegacyUsageFilterScope } from './lib/usage-filter'
import './style.css'

// Before any component setup runs — useStorage reads its key once and keeps it.
migrateLegacyStorageKeys()
// After the rebrand pass, which is what puts a pre-AgentHydra `…usageFilter.scope2` under the name
// this one looks for. Ordering is the whole reason both live here rather than at their own module
// scope: the second would otherwise migrate a key the first has not moved yet.
migrateLegacyUsageFilterScope()

async function mountApp(): Promise<void> {
  if (appModeForPath(window.location.pathname) === 'instances') {
    const { default: QuickInstancesApp } = await import('./QuickInstancesApp.vue')
    createApp(QuickInstancesApp).mount('#app')
  } else {
    // Keep the full manager and its i18n/toast/component graph out of the quick-mode request. Vite
    // emits this branch as separate chunks, so `/instances` does not merely hide heavyweight UI —
    // the browser never downloads or initializes it.
    //
    // All three in ONE Promise.all: the toast stylesheet used to be awaited on its own line AFTER
    // this, which made a second serial round trip out of a request that has no dependency on the
    // first two. Nothing here needs anything else here.
    const [{ default: App }, { i18n }] = await Promise.all([
      import('./App.vue'),
      import('./i18n'),
      // vue-sonner v2 ships its toast styling separately. It is needed only by the full manager.
      import('vue-sonner/style.css'),
    ])
    createApp(App).use(i18n).mount('#app')
  }

  // Pull the cross-window preferences (usage mode + usage filter). AFTER the mount above, and it
  // has to be after: registration happens when composables/useInstanceFilter.ts and useUsageMode.ts
  // are first imported, which is part of loading the view chunk. Hoisted to module scope this would
  // run against an empty registry and silently apply nothing.
  //
  // Not awaited, either. Those refs are already painted from localStorage, so blocking first paint
  // on a round trip would trade a visible delay for a correction almost nobody needs; this lands a
  // beat later and fixes up the case that motivated it — the quick window running on its own port,
  // with its own empty storage. See composables/useSharedPrefs.ts.
  void hydrateSharedPrefs()
}

// Counts one session for the Connections sign-in prompt. Here, not in SettingsView, because that
// view is lazy: an owner who never opens Settings would never accrue a session and so could never
// pass the prompt's gate. Counting only - nothing is shown from this call.
startSignInNudgeSession({ appId: 'agenthydra', appName: 'AgentHydra' })

void mountApp()
