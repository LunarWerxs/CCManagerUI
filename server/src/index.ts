import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join, relative } from 'node:path'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { warmAnalyticsInBackground } from './analytics'
import {
  autoUpdateEnabled,
  getAutoUpdateIntervalSecs,
  lastUpdateCheck,
  loadAutoUpdateSettings,
  recordUpdateCheck,
  setAutoUpdateEnabled,
  setAutoUpdateHooks,
  setAutoUpdateIntervalSecs,
  startAutoUpdate,
  stopAutoUpdate,
} from './auto-update'
import { startAutomationStampSweep } from './automation-stamp-sweep'
import { markDispatchReady } from './boot-state'
import { disarmBootWatchdog, renewBootWatchdog } from './boot-watchdog'
import {
  APP_ROOT,
  appEnv,
  CONFIG_DIR,
  DATA_DIR,
  DATA_DIR_NOTICE,
  DB_PATH,
  HOST,
  IS_COMPILED,
  noAutoOpen,
  PORT,
  PORTABLE_WINDOW_SIZE,
  SERVICE_NAME,
  VERSION,
  WEB_DIST_CANDIDATES,
} from './config'
import {
  buildAuthorizeUrl,
  disable,
  enable,
  flushPending,
  handleCallback,
  initConnections,
  logout,
  pullNow,
  pushNow,
  syncStatus,
  updateAppearance,
} from './connections'
import { createChatGptContextPack } from './context-pack'
import { migrateCliInstanceConfigDirs, reconcileCliInstanceDirs } from './core/cli-instances'
import { reconcileCodexInstanceDirs } from './core/codex-instances'
import { readUiPrefs, writeUiPrefs } from './core/ui-prefs'
import { getSetting, setSetting } from './db'
import { buildDetachedSpawn } from './detached-spawn.mjs'
import { activeCount, reattachRuns, startImportSweep, startRetrySweep } from './dispatch'
import { findFreePort } from './find-free-port.mjs'
import { cleanupStaleUpdateArtifacts } from './github-updater'
import { app } from './http-app'
import {
  clearInstanceInfo,
  findLiveInstance,
  readInstanceInfo,
  singleInstanceProbeAttempts,
  updateInstanceInfo,
  writeInstanceInfo,
} from './instance'
import { initFileLogging } from './log-file.mjs'
import { createLoopbackGuard, isLoopbackOrigin } from './loopback-guard.mjs'
import { startMonitor } from './monitor'
import { sendOsNotification } from './notify-os'
import {
  getNotificationSettings,
  type NotificationSettingsPatch,
  setNotificationSettings,
} from './notify-settings'
import { openUi } from './open-ui'
import { setOrchestratorDaemonUrl } from './orchestrator'
import { openPortableWindow } from './portable-window.mjs'
import { startPriceCatalog } from './price-catalog'
import { getProviderSettings, setProviderSettings } from './provider-settings'
import { buildRelaunchArgv } from './relaunch-argv.mjs'
import {
  acknowledgeResetEvents,
  listResetEvents,
  sendTestNotification,
  startResetWatch,
} from './reset-watch'
import { jsonBody } from './route-helpers'
import { warmSessionScanCache } from './sessions'
import { isRelaunchSuccessor, RELAUNCH_FLAG, skipSingleInstanceGuard } from './single-instance'
import { resolveEditor } from './transcript-open'
import { startTrayHostIfMissing } from './tray-host'
import { updateProgress } from './update-progress'
import { applyUpdate, checkForUpdate } from './updater'
import { getUsageSettings, setUsageSettings, startUsageRefresh } from './usage-refresh'
import { checkUsageForCliInstance, checkUsageForDesktop } from './usage-service'
import { WINDOW_SIZE_HINT_PARAM, windowSizeHintFor } from './window-size'

// Persist console output to <CONFIG_DIR>/logs/daemon.log BEFORE anything else can throw, so the
// crash reason logged just below actually survives the process (the tray runs us with a hidden
// console, so without this the output would vanish). Best-effort; never throws. Shared LunarWerx
// server-lib (./log-file.mjs); the config dir comes from CONFIG_DIR (config.ts), passed in
// explicitly since the shared lib is app-agnostic and has no built-in default.
initFileLogging(CONFIG_DIR)

// Last-resort crash handlers: an unhandled throw/rejection anywhere in the daemon logs what
// happened and exits non-zero instead of dying silently (or, for a rejection, limping on in an
// unknown state). The tray's health watchdog then sees the daemon go unresponsive and relaunches
// it; the console.error here is teed to daemon.log (above), so the reason is on disk even after
// the process is gone. process.exit is safe here; the daemon already exits deliberately in its
// own clean-shutdown paths below (unlike ReDesign, whose entry avoids it for undici's sake).
process.on('uncaughtException', (err) => {
  console.error('[agenthydra] uncaught exception:', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[agenthydra] unhandled rejection:', reason)
  process.exit(1)
})

// --- portable mode (server/src/db.ts settings table; see server/src/portable-window.mjs) ---
function portableModeEnabled(): boolean {
  return getSetting('portable_mode') === '1'
}
function setPortableMode(value: boolean): void {
  setSetting('portable_mode', value ? '1' : '0')
  updateInstanceInfo({ portableMode: value })
}

// --- hide tray icon (server/src/db.ts settings table; read live by misc/AgentHydra-Tray.ps1) ---
function hideTrayIconEnabled(): boolean {
  return getSetting('hide_tray_icon') === '1'
}
function setHideTrayIcon(value: boolean): void {
  setSetting('hide_tray_icon', value ? '1' : '0')
  updateInstanceInfo({ hideTrayIcon: value })
}

// AH-11: the loopback API holds session-scoped data and mutating routes, so the plain
// any-loopback-port check both isLoopbackOrigin() and the guard's default mode use is too loose —
// per the Fetch spec a page on ANY local port is "same-site" (a site ignores the port), so a dev
// server, a preview, or another local daemon's page qualifies too. allowedApiOrigins is the exact
// allowlist: this daemon's own origin (both host spellings, since browsers treat 127.0.0.1 and
// localhost as different origins on the same port) plus AGENTHYDRA_DEV_ORIGINS. It starts empty
// and is populated once boundPort is known (below, well before Bun.serve starts accepting
// requests); both callbacks below read it lazily per-request via the closure/thunk, never a value
// captured at wiring time.
let allowedApiOrigins: string[] = []
function computeAllowedApiOrigins(port: number): string[] {
  const own = readInstanceInfo()?.url ?? `http://127.0.0.1:${port}`
  const origins = new Set<string>([own])
  try {
    const u = new URL(own)
    if (u.hostname === '127.0.0.1')
      origins.add(`${u.protocol}//localhost${u.port ? `:${u.port}` : ''}`)
    else if (u.hostname === 'localhost')
      origins.add(`${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`)
  } catch {
    // own origin unparseable (shouldn't happen) — skip the alt-host spelling
  }
  for (const dev of (process.env.AGENTHYDRA_DEV_ORIGINS ?? '').split(',')) {
    const trimmed = dev.trim()
    if (trimmed) origins.add(trimmed)
  }
  return [...origins]
}

// CORS narrowed to the exact allowlist above (defense-in-depth for cross-origin READABILITY); the
// actual cross-site protection is loopbackGuard below, which rejects the REQUEST — see
// loopback-guard.mjs for why a CORS allowlist alone is insufficient (the "simple request"
// write-CSRF bypasses it).
app.use(
  '/api/*',
  cors({ origin: (origin) => (origin && allowedApiOrigins.includes(origin) ? origin : '') }),
)
// Reject browser cross-site requests to the loopback API (drive-by CSRF → RCE), in the opt-in
// exact-origin mode (AH-11): a present Origin must be in allowedApiOrigins, not merely loopback.
// Runs after cors so preflight OPTIONS is answered by cors; applies to every /api/* verb. NOT
// applied to /oauth/* (those are legitimate cross-site top-level navigations returning from the
// OAuth provider).
app.use('/api/*', createLoopbackGuard({ allowedOrigins: () => allowedApiOrigins }))
// No API route needs a multi-megabyte body. Bound parser memory even for a deliberate local/MCP
// misuse; the provenance guard runs first so a rejected browser origin is never allowed to stream.
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'request body exceeds 2 MiB' }, 413),
  }),
)

// --- health (also the single-instance probe: body.service must equal SERVICE_NAME) ---
// `dataDir`/`dbPath` are here for one reason: a daemon started from a checkout and the installed
// one used to open DIFFERENT sqlite files, and every forensic session that hit it wasted its time
// reading the wrong database with total confidence. They resolve to one place now, and this states
// which place, so the question is answered by looking rather than by inferring from `distribution`.
// `dataDirNotice` is non-null only when a second, unused state directory is still sitting there.
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    distribution: IS_COMPILED ? 'compiled' : 'source',
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    dataDirNotice: DATA_DIR_NOTICE,
    ts: Date.now(),
  }),
)

// --- self-update (source: git engine; compiled: GitHub Releases — see server/src/updater.ts) --
app.get('/api/update', async (c) => {
  // fresh: this is the route a PERSON hits by clicking "Check for updates", and the honest answer
  // to that is a live check. checkForUpdate caches for 5 minutes, and the background tick keeps
  // that cache warm (it runs at boot and on a timer), so without fresh the click that matters most
  // is exactly the one most likely to be served a stale "you're up to date" - a release published
  // in the last five minutes stays invisible to the user who just asked to be told about it, with
  // nothing on screen admitting the answer is cached. The background loop and /api/update/available
  // still use the cache, so this costs one extra API call per deliberate human action, not a poll.
  const status = await checkForUpdate({ fresh: true })
  // Feed the passive hint with this REAL check, not just the background tick's. Otherwise opening
  // Settings could tell you an update exists while the dot beside it stayed dark for hours.
  recordUpdateCheck(status)
  return c.json({
    ...status,
    // Informational: which mechanism is live. Both compiled + source support check/apply now, so
    // the UI drives the same controls for either; this just lets a caller distinguish them.
    distribution: IS_COMPILED ? 'compiled' : 'source',
    autoUpdate: { enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() },
  })
})
/**
 * The last BACKGROUND check's answer — a plain memory read, no network, no git.
 *
 * Deliberately separate from GET /api/update, which performs a real check: this one is cheap enough
 * for the whole app to poll on a timer, which is what lets an "update available" hint live outside
 * the Settings screen. Before it existed, the only code that ever asked was SettingsView's
 * onMounted, so a user who never opened Settings was never told an update existed.
 *
 * `checked: false` means the first background tick has not landed yet (the loop's first run is one
 * interval out, so a cold boot spends no network on it) — the UI shows nothing rather than
 * asserting "up to date" on the strength of never having looked.
 */
app.get('/api/update/available', (c) => {
  const last = lastUpdateCheck()
  if (!last) return c.json({ checked: false, updateAvailable: false })
  return c.json({
    checked: true,
    checkedAt: last.at,
    updateAvailable: last.status.ok && last.status.updateAvailable,
    canApply: last.status.canApply,
    currentVersion: last.status.currentVersion,
    latestVersion: last.status.remoteCommit,
    reason: last.status.reason,
    autoApply: autoUpdateEnabled(),
  })
})
// Where a running apply currently is (see server/src/update-progress.ts). A plain memory read, so
// the UI can poll it every second while its POST /api/update/apply is still in flight — that
// request covers minutes of real work and used to report nothing until it finished.
app.get('/api/update/progress', (c) => c.json(updateProgress()))
app.post('/api/update/apply', async (c) => {
  const result = await applyUpdate()
  // A compiled apply swapped the binary on disk; the running process is still the OLD one, so it
  // MUST relaunch for the update to take effect (a source apply leaves the daemon to be restarted
  // manually — restartGuidance in the UI — matching its historical behavior).
  //
  // The delay is the whole point, and 250ms was too short. relaunchDaemon exits the process 800ms
  // after IT is called, so at 250ms the socket carrying this very response died about a second
  // after the response was written — and a client that had not finished reading by then saw the
  // request fail on an update that had in fact succeeded. That is the "clicked update, it just span
  // forever" report: the work was done in a few seconds and the news never arrived.
  //
  // Three seconds costs a user nothing (the app is about to restart under them either way) and is
  // far more time than a loopback response needs to flush. The client also recovers on its own now
  // by polling /api/health (composables/useUpdates.ts) — belt and braces, because this end of it
  // can only ever be a race that is made unlikely, never one that is closed.
  if (IS_COMPILED && result.ok && result.restartRequired) {
    setTimeout(() => relaunchDaemon(), 3000)
  }
  return c.json(result)
})

// --- auto-update settings (background loop; see server/src/auto-update.ts) -------------------
app.get('/api/update/settings', (c) =>
  c.json({ enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() }),
)
app.post('/api/update/settings', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.enabled === 'boolean') setAutoUpdateEnabled(body.enabled)
  if (typeof body.intervalSecs === 'number') setAutoUpdateIntervalSecs(body.intervalSecs)
  return c.json({ enabled: autoUpdateEnabled(), intervalSecs: getAutoUpdateIntervalSecs() })
})

// --- app settings (portable mode, hide tray icon, usage auto-refresh; see server/src/db.ts) ------
const appSettings = () => ({
  portableMode: portableModeEnabled(),
  hideTrayIcon: hideTrayIconEnabled(),
  transcriptEditor: getSetting('transcript_editor'),
  transcriptEditorResolved: resolveEditor(
    process.platform,
    getSetting('transcript_editor'),
    process.env,
    existsSync,
  ),
  ...getUsageSettings(),
  ...getProviderSettings(),
  // Notification settings ride the same envelope as every other app setting so the web app keeps
  // ONE settings round-trip. The SMTP password is not in here by construction — the DTO carries
  // `notifySmtpPassSet` instead (see notify-settings.ts).
  ...getNotificationSettings(),
})
// Cross-window UI preferences (see core/ui-prefs.ts). Deliberately NOT folded into /api/settings:
// these are a mirror of the browser's own localStorage, written on every toggle, and they must be
// served identically by the quick-instances daemon — which has no settings surface at all.
app.get('/api/ui-prefs', (c) => c.json({ prefs: readUiPrefs() }))
app.post('/api/ui-prefs', async (c) => c.json({ prefs: writeUiPrefs(await jsonBody(c)) }))
app.get('/api/settings', (c) => c.json(appSettings()))
app.post('/api/settings', async (c) => {
  const body = await jsonBody(c)
  if (typeof body.portableMode === 'boolean') setPortableMode(body.portableMode)
  if (typeof body.hideTrayIcon === 'boolean') setHideTrayIcon(body.hideTrayIcon)
  if (typeof body.transcriptEditor === 'string')
    setSetting('transcript_editor', body.transcriptEditor.trim())
  // setUsageSettings re-arms the background timer, so flipping autoRefresh takes effect immediately
  // (no daemon restart).
  setUsageSettings({
    autoRefresh: typeof body.autoRefresh === 'boolean' ? body.autoRefresh : undefined,
    autoRefreshIntervalMin:
      typeof body.autoRefreshIntervalMin === 'number' ? body.autoRefreshIntervalMin : undefined,
    showDesktopInstances:
      typeof body.showDesktopInstances === 'boolean' ? body.showDesktopInstances : undefined,
    showCliInstances:
      typeof body.showCliInstances === 'boolean' ? body.showCliInstances : undefined,
  })
  setProviderSettings({
    codexDesktopEnabled:
      typeof body.codexDesktopEnabled === 'boolean' ? body.codexDesktopEnabled : undefined,
    codexCliEnabled: typeof body.codexCliEnabled === 'boolean' ? body.codexCliEnabled : undefined,
    chatGptHandoffEnabled:
      typeof body.chatGptHandoffEnabled === 'boolean' ? body.chatGptHandoffEnabled : undefined,
  })
  // Notifications: whitelisted field by field, same as the blocks above. setNotificationSettings
  // ignores anything absent, so a patch touching one toggle leaves the rest (and the stored SMTP
  // password) alone.
  setNotificationSettings(notificationPatch(body))
  return c.json(appSettings())
})

// --- reset notifications (server/src/reset-watch.ts) ---------------------------------------------

/** Narrow an untyped request body to the notification patch, dropping anything mistyped. Split out
 *  of the settings handler because the same shape is accepted on the dedicated route below. */
function notificationPatch(body: Record<string, unknown>): NotificationSettingsPatch {
  const b = (k: string) => (typeof body[k] === 'boolean' ? (body[k] as boolean) : undefined)
  const n = (k: string) =>
    typeof body[k] === 'number' && Number.isFinite(body[k]) ? (body[k] as number) : undefined
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
  return {
    notifyEnabled: b('notifyEnabled'),
    notifySessionReset: b('notifySessionReset'),
    notifyWeeklyReset: b('notifyWeeklyReset'),
    notifyMinPct: n('notifyMinPct'),
    notifySessionMaxWeeklyPct: n('notifySessionMaxWeeklyPct'),
    notifyDesktop: b('notifyDesktop'),
    notifyPersistent: b('notifyPersistent'),
    notifyPersistentIntervalMin: n('notifyPersistentIntervalMin'),
    notifyPersistentMaxRepeats: n('notifyPersistentMaxRepeats'),
    notifyEmail: b('notifyEmail'),
    notifyEmailTo: s('notifyEmailTo'),
    notifyEmailFrom: s('notifyEmailFrom'),
    notifySmtpHost: s('notifySmtpHost'),
    notifySmtpPort: n('notifySmtpPort'),
    notifySmtpSecure: b('notifySmtpSecure'),
    notifySmtpUser: s('notifySmtpUser'),
    notifySmtpPass: s('notifySmtpPass'),
  }
}

/** Open reset events (newest first) — what the UI polls to raise its in-app toast. */
app.get('/api/notifications/events', (c) => c.json(listResetEvents()))

/** Acknowledge one event, or every open one when `id` is omitted. Acking stops persistent repeats. */
app.post('/api/notifications/ack', async (c) => {
  const body = await jsonBody(c)
  const id = typeof body.id === 'string' && body.id ? body.id : undefined
  return c.json(acknowledgeResetEvents(id))
})

/** Fire a test notification through the configured channels. Without this, verifying an SMTP
 *  config or a muted Windows toast would mean waiting up to five hours for a real reset. */
app.post('/api/notifications/test', async (c) => c.json(await sendTestNotification()))

// Manual handoff only: create a bounded local context attachment, then the browser opens ChatGPT
// and the user chooses what to send. No ChatGPT credentials, cookies, prompts, or responses cross
// this API.
app.post('/api/chatgpt/context-pack', async (c) => {
  if (!getProviderSettings().chatGptHandoffEnabled)
    return c.json({ error: 'ChatGPT handoff is disabled in Settings → Providers.' }, 403)
  const body = await jsonBody(c)
  if (typeof body.cwd !== 'string' || !body.cwd.trim())
    return c.json({ error: 'cwd is required' }, 400)
  if (typeof body.task !== 'string' || !body.task.trim())
    return c.json({ error: 'task is required' }, 400)
  try {
    return c.json(createChatGptContextPack(body.cwd, body.task))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

// --- "Sign in with Connections" + settings-sync (see server/src/connections.ts) ----------------
// Loopback-only daemon: no auth gate, no session cookie; "signed in" simply means the daemon
// holds a refresh token. Login/callback are full-page navigations (not /api), matching the
// family pattern (DevWebUI).
app.get('/oauth/login', async (c) => {
  try {
    const origin = new URL(c.req.url).origin
    if (!isLoopbackOrigin(origin)) return c.redirect('/?connect=failed')
    const url = await buildAuthorizeUrl(origin)
    return c.redirect(url)
  } catch {
    return c.redirect('/?connect=failed')
  }
})
app.get('/oauth/callback', async (c) => {
  const origin = new URL(c.req.url).origin
  if (!isLoopbackOrigin(origin)) return c.redirect('/?connect=failed')
  const code = c.req.query('code')
  const stateTok = c.req.query('state')
  let ok = false
  if (code && stateTok) {
    try {
      ok = await handleCallback(origin, code, stateTok)
    } catch {
      ok = false
    }
  }
  // If sync was already enabled before this sign-in, converge now that we have a token: pull the
  // remote doc (applying it) OR seed the store from local if the remote is empty. Runs in the
  // background so the redirect never waits on the network.
  if (ok && syncStatus().enabled) void enable().catch(() => {})
  return c.redirect(ok ? '/?connected=1' : '/?connect=failed')
})

/** Run a sync op and turn any failure into an inline `{ ok:false, error }` (HTTP 200,
 *  non-fatal; the daemon keeps using local settings and the UI surfaces the reason). */
async function guardSync<T extends object>(
  c: import('hono').Context,
  run: () => Promise<T>,
): Promise<Response> {
  try {
    return c.json(await run())
  } catch (e) {
    const err = e as { code?: string; message?: string }
    const code = err.code ?? (err.message === 'not_signed_in' ? 'not_signed_in' : 'sync_failed')
    return c.json({ ok: false, error: code })
  }
}
app.get('/api/settings/sync', (c) => c.json(syncStatus()))
app.put('/api/settings/sync', async (c) => {
  const b = (await jsonBody(c)) as {
    enabled?: boolean
    forget?: boolean
    appearance?: Record<string, unknown>
  }
  return guardSync(c, async () => {
    if (b.enabled === true) {
      const { status } = await enable(b.appearance)
      return status
    }
    if (b.enabled === false) return disable(b.forget === true)
    if (b.appearance && typeof b.appearance === 'object') await updateAppearance(b.appearance)
    return syncStatus()
  })
})
app.post('/api/settings/sync/pull', (c) =>
  guardSync(c, async () => {
    await pullNow()
    return syncStatus()
  }),
)
app.post('/api/settings/sync/push', (c) =>
  guardSync(c, async () => {
    await pushNow()
    return syncStatus()
  }),
)
app.post('/api/settings/sync/logout', async (c) => {
  await logout()
  return c.json({ ok: true })
})

// --- feature routes (see server/src/routes/*.ts for each group) ------------------
// Dynamic `import()`, not a static one: each module registers its routes as top-level
// module-scope statements (no wrapping function — see http-app.ts for why), and a dynamic
// import is the one way to run that module code at this EXACT point in the boot sequence.
// A static `import` is hoisted above everything in this file, which would register every
// route group here before the health/settings/notifications/oauth-sync routes above ever
// run — reordering registration in a router where relative order has already mattered once
// (see the MUST-STAY-ABOVE comments in routes/sessions.ts). Awaited in sequence so the
// original file's registration order is reproduced exactly, group by group.
await import('./routes/sessions')
await import('./routes/analytics')
await import('./routes/queue')
await import('./routes/incidents')
await import('./routes/instances')
await import('./routes/usage')
await import('./routes/monitor-fleet')
await import('./routes/desktop-sessions')
await import('./routes/session-message')

// --- portable window (opens this daemon's own UI in a chromeless app window) -------------------
app.post('/api/portable-window', async (c) => {
  // readInstanceInfo() is populated at boot (writeInstanceInfo below) before the server starts
  // accepting requests, so it always reflects the port we actually bound; PORT is just a
  // last-resort fallback for an unusual boot order.
  const url = readInstanceInfo()?.url ?? `http://${HOST}:${PORT}`
  const profileDir = join(CONFIG_DIR, 'portable-profile')
  // First-run size only — openPortableWindow yields to the profile's saved placement once the
  // user has resized the window themselves (see PORTABLE_WINDOW_SIZE in config.ts). A forwarded
  // --app launch (a window already open on this profile) ignores --window-size AND the saved
  // placement, so also tag the URL with the size this window should have and the page corrects
  // itself with resizeTo (web/src/lib/window-size-hint.ts). The query string is not part of
  // Chromium's placement key; a URL that won't parse just goes out un-hinted.
  let target = url
  try {
    const hint = windowSizeHintFor(profileDir, url, PORTABLE_WINDOW_SIZE)
    if (hint) {
      const u = new URL(url)
      u.searchParams.set(WINDOW_SIZE_HINT_PARAM, hint)
      target = u.toString()
    }
  } catch {
    // unparseable base URL: open it un-hinted rather than fail the route
  }
  return c.json(await openPortableWindow(target, { profileDir, initialSize: PORTABLE_WINDOW_SIZE }))
})

// --- full-shutdown sentinel (web-UI "Shut down") -----------------------------
// A marker file the PowerShell tray host polls (misc/Tray-Host.ps1 watch timer) so a user "Shut
// down" from the web UI tears the WHOLE app down — window + daemon + tray icon — instead of the
// watchdog reviving the daemon. Lives beside runtime.json in CONFIG_DIR (matches the tray's
// SentinelFile = <cmHome>\shutdown.request). Written ONLY for a UI-source shutdown that lacks the
// tray's session token (the tray's own Restart/Quit carry it, so they don't trip this). Cleared on
// boot so a stale one from a hard-killed run never causes a spurious quit. Best-effort throughout.
const SHUTDOWN_REQUEST_FILE = join(CONFIG_DIR, 'shutdown.request')
function writeShutdownRequest(): void {
  try {
    writeFileSync(SHUTDOWN_REQUEST_FILE, JSON.stringify({ ts: Date.now() }), { mode: 0o600 })
  } catch {
    /* best-effort: a tray that misses the sentinel still has its own Quit */
  }
}
function clearShutdownRequest(): void {
  try {
    rmSync(SHUTDOWN_REQUEST_FILE, { force: true })
  } catch {
    /* best-effort */
  }
}

// --- graceful shutdown (tray Quit calls this before falling back to taskkill) ---
const SHUTDOWN_TOKEN = appEnv('SHUTDOWN_TOKEN')
async function flushConnectionsBeforeExit(): Promise<void> {
  await Promise.race([
    flushPending().catch((error) => {
      console.error(
        `[agenthydra] final settings sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
  ])
}

app.post('/api/shutdown', (c) => {
  const trayHeader = c.req.header('x-agenthydra-shutdown-token') ?? ''
  const uiSource = c.req.header('x-agenthydra-shutdown-source') === 'ui'
  // The tray's Restart/Quit carry the session token (source=ui + token). A user "Shut down" from
  // the web UI is source=ui WITHOUT the token — allowed, and it drops the sentinel so the tray
  // tears the whole app down rather than reviving the daemon. A non-UI request must still bear the
  // token (or be rejected). Harmless when no tray is running: nobody polls the sentinel, and the
  // next boot clears it.
  const tokenOk = !!SHUTDOWN_TOKEN && trayHeader === SHUTDOWN_TOKEN
  if (!uiSource && !tokenOk) return c.json({ error: 'forbidden' }, 403)
  if (uiSource && !tokenOk) writeShutdownRequest()
  setTimeout(async () => {
    await flushConnectionsBeforeExit()
    clearInstanceInfo()
    stopAutoUpdate()
    process.exit(0)
  }, 150)
  return c.json({ ok: true })
})

// --- serve the built SPA (single-process / production) ----------------------
const embeddedWeb = (
  globalThis as {
    __AGENTHYDRA_EMBEDDED_WEB__?: Readonly<Record<string, string>>
  }
).__AGENTHYDRA_EMBEDDED_WEB__
const dist = WEB_DIST_CANDIDATES.find((p) => existsSync(p))
if (embeddedWeb) {
  app.get('/*', async (c) => {
    let pathname = decodeURIComponent(new URL(c.req.url).pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const lastSeg = pathname.slice(pathname.lastIndexOf('/') + 1)
    const isAsset = pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(lastSeg)
    const embeddedPath = embeddedWeb[pathname]
    if (embeddedPath) {
      return new Response(Bun.file(embeddedPath), {
        headers: {
          'cache-control': pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      })
    }
    if (isAsset) return c.text('not found', 404, { 'cache-control': 'no-store' })
    return new Response(Bun.file(embeddedWeb['/index.html']!), {
      headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' },
    })
  })
} else if (dist) {
  const root = relative(process.cwd(), dist).replaceAll('\\', '/') || '.'
  app.use('/assets/*', serveStatic({ root }))
  // a stale hashed chunk must 404, not fall through to index.html (wrong MIME → module load error)
  app.get('/assets/*', (c) => c.text('not found', 404, { 'cache-control': 'no-store' }))
  // root-level public files (favicon.svg/.ico, …) must resolve as real files; without this the
  // SPA fallback below answers the browser's favicon request with index.html and the tab icon
  // (and the header logo, which uses the same asset) never loads.
  app.use('/*', serveStatic({ root }))
  app.get('/*', serveStatic({ path: `${root}/index.html` }))
}

/** True if something is already listening on `port` on `host` (non-intrusive TCP probe). Local to
 *  index.ts rather than editing the kit's find-free-port.mjs; shape follows DevWebUI's ports.ts. */
function isPortListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (v: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(300)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    try {
      sock.connect(port, host)
    } catch {
      done(false)
    }
  })
}

/** Poll until `port` is free (the predecessor released it), up to timeoutMs. Used by the
 *  auto-update relaunch: a daemon respawned with AGENTHYDRA_RELAUNCH=1 waits for its predecessor
 *  to free the preferred port so it rebinds the SAME port instead of hopping. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortListening(port, HOST))) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

// --- boot: single-instance guard, port hop, publish runtime pointer ---------
// The dev launcher (AGENTHYDRA_PORT_FIXED) and the auto-update successor
// (AGENTHYDRA_RELAUNCH) are exempt; see skipSingleInstanceGuard for why, and
// single-instance.test.ts for the regression guard on the relaunch exemption.
const releaseDoubleClick =
  (globalThis as { __AGENTHYDRA_RELEASE_BUILD__?: boolean }).__AGENTHYDRA_RELEASE_BUILD__ ===
    true &&
  !isRelaunchSuccessor() &&
  !appEnv('SHUTDOWN_TOKEN')

if (!skipSingleInstanceGuard()) {
  // Re-probe (3 attempts, 2s each) rather than trusting ONE 1s probe. This decides whether to
  // become a second daemon, so a false "nothing running" is expensive and self-concealing: we
  // then wait out waitForPortFree, hop to PORT+1, and overwrite runtime.json — two live daemons,
  // the pointer aimed at the newer one, and open tabs stranded on the older. That is exactly what
  // the field logs show (paired starts ~6.4s apart == one 1s probe + the 5s waitForPortFree,
  // then the hop). A stale pointer with nothing listening still resolves in well under a second
  // (connections are refused instantly), so this costs a genuine cold start almost nothing.
  // Attempts are chosen from the pointer rather than fixed at 3: a pointer whose process is gone
  // is a tombstone, and re-probing it only buys 500ms of setTimeout on the boot right after a
  // crash. See singleInstanceProbeAttempts in instance.ts.
  const live = await findLiveInstance(2000, singleInstanceProbeAttempts(3))
  if (live) {
    console.log(
      `\n  AgentHydra is already running  →  ${live.url}\n  Not starting a second instance.\n`,
    )
    if (releaseDoubleClick && !noAutoOpen()) openUi(live.url)
    process.exit(0)
  }
}
// A daemon relaunched by the auto-updater (AGENTHYDRA_RELAUNCH=1) waits for its predecessor to
// free the preferred port BEFORE probing/binding, so it rebinds the SAME port (an open browser
// tab's SSE then reconnects seamlessly instead of the daemon hopping to a port the tab can't reach).
if (isRelaunchSuccessor()) await waitForPortFree(PORT, 8000)
// Probe the SAME interface the server binds (HOST); the wildcard probe misses a
// squatter that holds only 127.0.0.1 (e.g. wrangler dev's workerd on 8787).
// A tray "Restart"/"Rebuild & Restart" spawns the successor while the predecessor is still
// tearing down: its /api/health probe already fails (so the single-instance guard passes) yet
// the socket lingers for a few seconds. Without the wait the successor hops to PORT+1 and every
// open tab on the old port starts erroring; the "crashes on relaunch" symptom. A genuine
// squatter (some other app on the port) just costs this one bounded wait, then we hop as before.
let boundPort = PORT
if (process.env.AGENTHYDRA_PORT_FIXED !== '1') {
  if (await isPortListening(PORT, HOST)) await waitForPortFree(PORT, 5000)
  boundPort = await findFreePort(PORT, 50, HOST)
}

writeInstanceInfo(boundPort, {
  portableMode: portableModeEnabled(),
  hideTrayIcon: hideTrayIconEnabled(),
})
// Every toolbox child this daemon spawns is told THIS daemon's URL (audit AH-04): the bound
// port, not the configured one, so a hop off a busy 7787 does not leave the Python side talking
// to whatever answers there. See orchestratorChildEnv.
setOrchestratorDaemonUrl(readInstanceInfo()?.url ?? `http://127.0.0.1:${boundPort}`)
// AH-11: now that boundPort (and the runtime pointer) are known, resolve the exact-origin
// allowlist the cors() and loopbackGuard() callbacks above read on every request. This runs well
// before Bun.serve() starts accepting connections, so no request can observe the empty initial []
// declared above.
allowedApiOrigins = computeAllowedApiOrigins(boundPort)
// Say ONCE that this build has no tray icon. The single-file .exe carries no misc\ sidecar, so
// misc\lunarwerx-tray.exe cannot exist and no tray icon can ever appear whatever the in-app
// setting says (release.yml's asset table states this, but only on the Releases page - the .exe
// is the bigger, more obvious download and nothing at the moment of RUNNING it admits the
// difference). The build is also --windows-hide-console, so a console.log here reaches nobody;
// an OS toast is the only channel that actually lands. Gated three ways so it stays quiet:
// IS_COMPILED is false in every dev and test run, so this is a true no-op under `bun test`;
// isRelaunchSuccessor() skips the auto-update hop, which happens every few days; and the settings
// flag means a person who knows and doesn't care is told exactly once, never again.
if (IS_COMPILED && !isRelaunchSuccessor() && !existsSync(join(APP_ROOT, 'misc'))) {
  if (getSetting('no_tray_build_notified') !== '1') {
    setSetting('no_tray_build_notified', '1')
    void sendOsNotification({
      title: 'AgentHydra has no tray icon in this build',
      body: 'This is the single-file .exe. For the tray icon and the auto-restart supervisor, download the .zip release instead.',
    })
  }
}
// The other half of the same story: this build HAS the tray toolkit and nothing started it. The
// release ZIP says "double-click AgentHydra.exe", install.ps1's shortcut used to point at the exe,
// and neither launches misc\lunarwerx-tray.exe - so the daemon ran, the UI opened, and the tray
// icon never appeared on a machine that did everything it was told (owner's PC, 2026-09-03). The
// host is built to be started second: it finds this daemon and attaches (onStrayDaemon: attach).
// Fire-and-forget after the port is published, because the host's first act is to look for us
// there; see tray-host.ts for the decision and why a probe failure can only ever mean "skip".
void startTrayHostIfMissing({
  appRoot: APP_ROOT,
  compiled: IS_COMPILED,
  hideTray: hideTrayIconEnabled,
})
  .then((r) => {
    if (r.start) console.log(`[agenthydra] started the tray host (${r.exe}) - nothing else had`)
    // Say WHY when a compiled build with the toolkit present did not start it. The first live
    // relaunch under this code (2026-09-03) skipped correctly - the old host had survived and the
    // probe found it - and the silence still read as "the tray is gone" to the person checking the
    // log. A skip that names its reason is a skip nobody has to investigate.
    else if (r.reason === 'already-running' || r.reason === 'hidden-by-setting')
      console.log(`[agenthydra] tray host not started: ${r.reason}`)
  })
  .catch((err) => console.error('[agenthydra] tray host start failed:', err))
// Clear any stale full-shutdown sentinel left by a previous (possibly hard-killed) run, so a
// leftover file can't make the tray quit the instant it next polls. The tray clears it at its own
// startup too; this covers a daemon started without the tray (dev).
clearShutdownRequest()
process.on('exit', () => clearInstanceInfo())
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    await flushConnectionsBeforeExit()
    clearInstanceInfo()
    stopAutoUpdate()
    process.exit(0)
  })

const moved = boundPort !== PORT ? `  (port ${PORT} was busy)` : ''
console.log(`[agenthydra] http://${HOST}:${boundPort}${moved}`)
console.log(`[agenthydra] state: ${DB_PATH}`)
// Loud on purpose. This line only prints when a second state directory exists, and the whole cost
// of that situation is someone not knowing about it (see resolveDataDir in config.ts).
if (DATA_DIR_NOTICE) console.warn(`[agenthydra] WARNING: ${DATA_DIR_NOTICE}`)

// --- Connections cloud sync (opt-in; see server/src/connections.ts) ---------
// Load the persisted session/sync state into memory before the server starts accepting requests.
initConnections()

// Restart the daemon so a freshly-applied update takes over. The tray is a bare supervisor that
// never relaunches us, so the daemon must relaunch ITSELF: spawn a DETACHED copy of this exact
// launch command (AGENTHYDRA_RELAUNCH=1 so the successor waits for our port), then gracefully
// shut THIS daemon down to free the port. Shared by the auto-update loop AND the manual
// /api/update/apply route (a compiled apply swapped the binary on disk — process.execPath now
// points at the NEW exe, so respawning it boots the updated build). Returns false (no shutdown)
// if the successor couldn't be spawned, so we never exit without one.
function relaunchDaemon(): boolean {
  try {
    // In a compiled binary process.argv is ['bun', '<virtual embedded path>', ...realArgs] — a
    // placeholder pair, NOT respawnable. The shared kit builder handles that, pins the port we are
    // actually SERVING on (never the preferred one), and keeps the argv a fixed point so it cannot
    // grow by two tokens on every update. No `command` here: main.ts's daemon mode takes no verb.
    const relaunchArgv = buildRelaunchArgv(process.argv, {
      execPath: process.execPath,
      isCompiled: IS_COMPILED,
      boundPort,
      relaunchFlag: RELAUNCH_FLAG,
    })
    // Through buildDetachedSpawn, not a plain spawn. `detached: true` is NOT a process-tree escape
    // on Windows — the shared primitive's own header says so, and that is the reason it exists.
    // Left as a plain spawn the successor stays inside THIS process's tree for the whole ~800ms
    // handoff, so a tray Quit (`taskkill /T /F`) landing in that window kills the outgoing daemon
    // AND its replacement, leaving the user with none. That hand-off is also why the relaunch
    // signal and the port ride as FLAGS above: WMI does not carry our environment block.
    // hideWindow: the successor is a CONSOLE program (bun), and WMI's default STARTUPINFO gives
    // it a VISIBLE console on the owner's desktop at every auto-update - the recurring mystery
    // "command prompt that says starting" (found live 2026-08-30). Same ShowWindow=0 mechanism
    // the dispatch runner's WMI launch verified on 2026-07-15; closing such a stray console
    // would also CTRL_CLOSE_EVENT-kill the daemon living in it.
    const plan = buildDetachedSpawn(process.platform, relaunchArgv, { hideWindow: true })
    const child = spawn(plan.argv[0] as string, plan.argv.slice(1), {
      cwd: process.cwd(),
      detached: plan.detached,
      stdio: 'ignore',
      windowsHide: true,
      // boundPort, NOT PORT. PORT is the port this daemon PREFERRED (config/env); boundPort is the
      // one it is actually serving on, and they diverge for every daemon that has ever hopped. The
      // successor uses this value for BOTH of its jobs, so handing it the preferred port breaks both:
      // waitForPortFree() waits out its full 8s on a port the predecessor never held (nothing is
      // going to release it), and findFreePort() then binds that port instead of the one the user's
      // open tab is on — so a healthy daemon moves out from under the tab and its SSE stream dies.
      // Passing boundPort makes the wait apply to the socket actually being released and keeps the
      // daemon on ONE port across updates, which is the whole point of the handoff.
      env: { ...process.env, AGENTHYDRA_RELAUNCH: '1', PORT: String(boundPort) },
    })
    child.unref()
  } catch (e) {
    console.error('[agenthydra] relaunch failed to spawn; staying on the running version.', e)
    return false
  }
  console.log('[agenthydra] update applied, relaunching the daemon…')
  setTimeout(async () => {
    await flushConnectionsBeforeExit()
    clearInstanceInfo()
    stopAutoUpdate()
    process.exit(0)
  }, 800) // let the successor start, then free the port
  return true
}

// --- auto-update loop (opt-in; see server/src/auto-update.ts) ---------------
// Prime the runtime flags from persisted settings now; the timer itself only starts after boot
// (startAutoUpdate below), one interval out, so a fresh launch is never interrupted.
loadAutoUpdateSettings()
setAutoUpdateHooks({
  // Don't auto-update (which relaunches the daemon) while dispatch runs are in flight.
  hasActiveRuns: () => activeCount() > 0,
  relaunch: relaunchDaemon,
})

// A compiled build's self-updater renames the old exe + web/dist aside during a swap; sweep any
// such leftovers from a previous update now (best-effort, compiled-only). See github-updater.ts.
if (IS_COMPILED) cleanupStaleUpdateArtifacts()

// --- reattach in-flight dispatch runs (they OUTLIVE the daemon; see dispatch.ts) --------------
// A tray Quit / auto-update relaunch / crash leaves detached `claude` runs still executing. Recover
// them now: rebuild each run's events from its on-disk log and resume tailing to completion, so the
// UI shows them live again and their final status is recorded instead of being stuck 'running'.
// The scheduler/monitor auto-dispatchers stay parked (boot-state.ts) until this settles, so they
// can't double-dispatch a surviving run's session before it's back in the `active` map.
// ⛔ ON A DEADLINE, because this call is what un-parks the scheduler and the monitor. If it never
// settles - one hung child process is enough - markDispatchReady() never runs, every automatic
// tick returns immediately for the life of the daemon, and NOTHING reports it: no throw, no exit,
// /api/health still green, the manual "Run now" path still working. A silent permanent stall is
// worse than a crash, because a crash gets restarted. After the deadline we un-park anyway: the
// cost of that is a possible double-dispatch of one surviving run, against the certainty of no
// automation at all.
const REATTACH_DEADLINE_MS = 120_000
renewBootWatchdog('queue-recovery')
void Promise.race([
  reattachRuns(),
  new Promise<void>((r) =>
    setTimeout(() => {
      console.error(
        `[agenthydra] reattachRuns did not settle within ${REATTACH_DEADLINE_MS}ms - starting auto-dispatch anyway rather than leaving it parked forever`,
      )
      r()
    }, REATTACH_DEADLINE_MS).unref?.(),
  ),
]).finally(markDispatchReady)

startAutoUpdate()

// --- transient-overload retry sweep (ALWAYS ON; see server/src/dispatch.ts) --------------------
// Re-fires runs that died on a 529 once their few-second backoff elapses. Not behind the scheduler
// or monitor switches on purpose: those govern hours-scale autonomy ("run my queue", "prompt my
// sessions while I sleep"), whereas this just finishes the run the user started by hand seconds
// ago and which died on someone else's server hiccup.
startRetrySweep()

// --- desktop delivery sweep (ALWAYS ON; see server/src/dispatch.ts) ---------------------------
// Finishes landing migrated/handed-off chats in their target instance's app. The import refuses a
// target that is not running (firing it at a closed instance would BOOT that account), so a run
// that finishes while the owner is asleep used to reach a console.error and vanish. Now it stays
// pending and lands when that app is next open, or gives up after a day and says why.
startImportSweep()

// --- auto-resume monitor loop (opt-in; OFF by default; see server/src/monitor.ts) -------------
// The poll loop always runs; each tick is a no-op unless `monitor_enabled` is set. It watches for
// dispatch runs that stopped 'rate_limited' (their QUOTA is spent — a 529 is handled by the retry
// sweep above, not here), gates each on the weekly cap via checkUsage, and schedules a
// `claude --resume` for just after the 5-hour reset.
startMonitor()
// Keeps every imported chat's bypassPermissions stamp true on disk across the running app's
// re-saves, so the app's next boot makes it permanent - the durable half of the migrate fix.
// See automation-stamp-sweep.ts for why the per-import watcher alone could not do this.
startAutomationStampSweep()

// --- background usage refresh (ON by default; see server/src/usage-refresh.ts) -----------------
// A check is now a ~300ms HTTPS GET against the quota endpoint, not a `claude` spawn, and reading
// your quota does not consume it — so keeping the numbers warm costs essentially nothing. Toggle in
// Settings → Usage.
startUsageRefresh()

// --- one-time repair: CLI config dirs still naming the pre-rebrand config root ------------------
// See migrateCliInstanceConfigDirs. A no-op on every install except one carried across the
// ccmanagerui → agenthydra rename, where it is what makes an existing CLI login readable again.
{
  const migrated = migrateCliInstanceConfigDirs()
  if (migrated.length)
    console.log(`[cli-instances] repointed ${migrated.length} config dir(s) to ${CONFIG_DIR}`)
}

// --- registry health: say out loud what the disk and the registries disagree about --------------
// Read-only. Before writes were guarded (core/json-store.ts) a registry could be overwritten as
// empty, leaving every login dir it described as an unexplained folder; this is how such damage
// surfaces instead of staying invisible. Nothing is repaired here - which orphan is a lost identity
// and which is a leftover is the owner's call - so it prints and moves on.
for (const [label, report] of [
  ['cli-instances', reconcileCliInstanceDirs()],
  ['codex-instances', reconcileCodexInstanceDirs()],
] as const) {
  if (report.registry === 'corrupt' || report.registry === 'unreadable')
    console.error(
      `[${label}] registry is ${report.registry}: no changes will be accepted until it is repaired (the file has not been touched)`,
    )
  if (report.orphanDirs.length)
    console.warn(
      `[${label}] ${report.orphanDirs.length} directory(ies) under the instances root that no record claims: ${report.orphanDirs.join(', ')}`,
    )
  if (report.missingDirs.length)
    console.warn(
      `[${label}] ${report.missingDirs.length} record(s) whose directory is gone: ${report.missingDirs.map((r) => `${r.name} (${r.id})`).join(', ')}`,
    )
}

// --- reset notifications (ON by default; see server/src/reset-watch.ts) ------------------------
// The sweep above keeps the numbers warm; this turns the EDGE — a 5-hour or weekly window rolling
// over — into a native OS notification. `recheck` is injected rather than imported so reset-watch
// never imports usage-service (which imports back into the usage stack).
startResetWatch({
  recheck: async (key) => {
    if (key.startsWith('desktop:')) {
      await checkUsageForDesktop(key.slice('desktop:'.length))
      return
    }
    if (key.startsWith('cli:')) await checkUsageForCliInstance(key.slice('cli:'.length))
  },
})

// Explicit serve, NOT Bun's implicit `export default { fetch }` sugar: the implicit form only
// auto-serves when THIS file is the process entrypoint, and the compiled binary reaches the daemon
// via main.ts's dynamic import (where the default export would be silently inert — verified: the
// daemon "booted", logged its URL, and listened on nothing).
renewBootWatchdog('listen')
const server = Bun.serve({
  port: boundPort,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 255,
})
// Boot reached a live, listening port - the failure mode this watchdog exists for (a hang before
// this line) is no longer possible. Everything after here (price catalog, session-scan warm,
// analytics) is a deliberate background continuation, not boot proper - see the comments below on
// why those are placed after serve() rather than before it.
disarmBootWatchdog()

// --- prices (see server/src/price-catalog.ts) --------------------------------------------------
// Synchronous cache read, then a deferred download if that cache is stale. Placed BEFORE the
// analytics warm so a restart prices its first scan from last run's catalog rather than from the
// build's table, and never awaited: a daemon that cannot reach the network still prices every
// model it shipped knowing about.
startPriceCatalog()

// --- warm the sessions list (see server/src/sessions.ts warmSessionScanCache) ------------------
// Deliberately AFTER Bun.serve: parsing transcripts is the slowest thing this daemon does, and the
// point is to overlap it with the browser starting up rather than to delay listening on the port.
// .catch, not `void`: this is unawaited and runs AFTER the port is bound, so an unhandled rejection
// here takes the daemon down in the worst possible shape — the port reads as claimed, then nothing
// ever serves it. Warming is purely an optimization (the list still builds on demand), so any
// failure must degrade to a cold first request, never to a dead process.
//
// The watchdog is already disarmed by this point (it stands down once listening, above) - this
// renew is a documented no-op, kept so 'session-scan' still shows up as a named boot phase rather
// than silently missing one, and so it stays correct if warming is ever moved ahead of serve().
renewBootWatchdog('session-scan')
warmSessionScanCache()
  .catch((error) => {
    console.error('[agenthydra] session-scan warm failed; the list will build on demand:', error)
  })
  // Analytics AFTER the list warm, not alongside it. Both read the same transcripts, and the list
  // is what the user is waiting for; racing them would slow the visible thing to speed up a tab
  // nobody has opened yet. Fire-and-forget by design (see warmAnalyticsInBackground).
  .finally(() => warmAnalyticsInBackground())

if (releaseDoubleClick && !noAutoOpen()) {
  const url = `http://127.0.0.1:${server.port}/`
  if (!openUi(url))
    console.error(`[agenthydra] Could not open a browser automatically. Open ${url} manually.`)
}

export type App = typeof app
