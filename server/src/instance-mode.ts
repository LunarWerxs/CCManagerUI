// Lightweight instance-only daemon.
//
// This entry intentionally does NOT import index.ts. That keeps sessions/transcripts, sqlite,
// queue dispatch/recovery, scheduler, monitor, usage refresh, Connections, and auto-update out of
// the process entirely. It serves only the small API needed to list/start/focus/stop managed
// Claude/Codex instances plus the same built web assets at the dedicated `/instances` path.
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { apiOriginAllowlist } from './api-origins'
import { disarmBootWatchdog, renewBootWatchdog } from './boot-watchdog'
import {
  HOST,
  INSTANCE_MODE_PORT,
  IS_COMPILED,
  noAutoOpen,
  VERSION,
  WEB_DIST_CANDIDATES,
} from './config'
import { launchCliInstance, listCliInstances } from './core/cli-instances'
import {
  focusCodexDesktopInstance,
  launchCodexInstance,
  listCodexInstances,
  openCodexDesktopInstance,
  quitCodexDesktopInstance,
} from './core/codex-instances'
import { focusInstance, listInstances, openInstance, quitInstance } from './core/instances'
import { findFreePort } from './find-free-port.mjs'
import { findLiveInstance } from './instance'
import {
  clearInstanceModeInfo,
  findLiveInstanceMode,
  INSTANCE_MODE_CONFIG_DIR,
  INSTANCE_MODE_SERVICE_NAME,
  writeInstanceModeInfo,
} from './instance-mode-instance'
import { tryAcquireInstanceModeStartupLock } from './instance-mode-lock'
import { instanceModeUrl, openInstanceModeWindow } from './instance-mode-window'
import { initFileLogging } from './log-file.mjs'
import { createLoopbackGuard } from './loopback-guard.mjs'
import { openUi } from './open-ui'

// Prefer an already-running full daemon: it exposes the same instance routes, so opening its
// `/instances` surface is even cheaper than keeping a second (albeit tiny) server process.
const full = await findLiveInstance(750, 2)
if (full) {
  if (!noAutoOpen()) await openInstanceModeWindow(full.url)
  process.exit(0)
}

// Re-running the quick launcher raises the existing compact window rather than duplicating its
// daemon. Its separate pointer means this never mistakes the full manager for quick mode.
const existing = await findLiveInstanceMode(750, 2)
if (existing) {
  if (!noAutoOpen()) {
    await openInstanceModeWindow(existing.url)
    // A detached Chromium hand-off can report a successful spawn even when an existing background
    // profile process swallows the app-window request. Give the quick UI time to attach, then fall
    // back to a normal tab when the existing daemon still reports no connected window.
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    try {
      const response = await fetch(`${existing.url}/api/instance-mode/status`, {
        signal: AbortSignal.timeout(1_000),
      })
      const status = (await response.json()) as { connectedWindows?: number }
      if (!status.connectedWindows) openUi(instanceModeUrl(existing.url))
    } catch {
      openUi(instanceModeUrl(existing.url))
    }
  }
  process.exit(0)
}

initFileLogging(INSTANCE_MODE_CONFIG_DIR)

// Claim the cold start after both live-pointer checks. A simultaneous launcher waits for the
// winner's pointer and exits; it never races the bind or opens a duplicate window.
let startupLock = tryAcquireInstanceModeStartupLock()
if (!startupLock) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const winner = await findLiveInstanceMode(250, 1)
    if (winner) process.exit(0)
    startupLock = tryAcquireInstanceModeStartupLock()
    if (startupLock) break
  }
}
if (!startupLock) throw new Error('timed out waiting for another instance-mode launcher')
process.on('exit', () => startupLock?.release())

process.on('uncaughtException', (error) => {
  console.error('[agenthydra:instances] uncaught exception:', error)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[agenthydra:instances] unhandled rejection:', reason)
  process.exit(1)
})

const app = new Hono()
// The exact-origin allowlist, the same one the main daemon uses (index.ts). AH-11 was closed
// there and NOT here, and this process is a second loopback HTTP API with exactly the same
// exposure: while it accepted any loopback origin, a page served by any other localhost port
// could drive instance create/open/quit from a browser. Found by adversarial verification of the
// AH-11 closure, 2026-09-06 - a fix applied at one call site while the finding named a class.
//
// Populated just below, immediately before Bun.serve, because the port is not known until
// findFreePort answers; both callbacks read the binding lazily per request, never a value
// captured at wiring time. A request with NO Origin (curl, the MCP client, the tray) still
// passes - the guard exists to stop BROWSER cross-site calls, not local tools.
let allowedApiOrigins: string[] = []
app.use(
  '/api/*',
  cors({ origin: (origin) => (origin && allowedApiOrigins.includes(origin) ? origin : '') }),
)
app.use('/api/*', createLoopbackGuard({ allowedOrigins: () => allowedApiOrigins }))
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: 'request body exceeds 64 KiB' }, 413),
  }),
)

let connectedWindows = 0
let idleExitTimer: ReturnType<typeof setTimeout> | null = null

function cancelIdleExit(): void {
  if (idleExitTimer) clearTimeout(idleExitTimer)
  idleExitTimer = null
}

function exitCleanly(): void {
  console.log('[agenthydra:instances] exiting')
  clearInstanceModeInfo()
  startupLock?.release()
  process.exit(0)
}

function scheduleIdleExit(delayMs: number): void {
  cancelIdleExit()
  idleExitTimer = setTimeout(() => {
    if (connectedWindows === 0) exitCleanly()
  }, delayMs)
}

app.get('/api/health', (c) => {
  // A re-launch probes health before its browser hand-off. Extend the no-client lease so the daemon
  // cannot expire in the narrow gap between that successful probe and the new SSE connection.
  if (connectedWindows === 0) scheduleIdleExit(120_000)
  return c.json({
    ok: true,
    service: INSTANCE_MODE_SERVICE_NAME,
    mode: 'instances',
    version: VERSION,
    distribution: IS_COMPILED ? 'compiled' : 'source',
    ts: Date.now(),
  })
})

app.get('/api/instances', async (c) => c.json(await listInstances()))
app.get('/api/instances/:dir/account', async (c) => {
  // Dynamic on purpose: account resolution is requested after the bare rows render, so safeStorage
  // and profile/cache machinery do not join the cold-start import graph.
  const { resolveAccount } = await import('./core/accounts')
  const dir = decodeURIComponent(c.req.param('dir'))
  const cached = await resolveAccount(dir, { noNetwork: true })
  // The cache-only path is what keeps quick-launch off the network, but it can't SEED the cache —
  // and it now (correctly) returns nothing for an instance that was re-logged into another
  // account, since the cached identity describes the previous one. Spend one live resolve in
  // exactly that case, so the quick panel self-heals instead of showing "Account unavailable"
  // forever while waiting for someone to open the full manager.
  if (cached.status === 'loggedout' || cached.email || cached.name) return c.json(cached)
  return c.json(await resolveAccount(dir))
})
app.get('/api/usage/cache', async (c) => {
  // Cached readings only: the quick daemon never starts a live quota sweep. Keeping cache access
  // dynamically imported also keeps it off the first-render path until the browser asks for it.
  const { allCachedUsage } = await import('./usage-cache')
  return c.json({ cache: allCachedUsage(), lastAutoRefreshAt: null })
})

// The SAME cross-window preferences the full daemon serves, backed by the same file (see
// core/ui-prefs.ts). This is the whole reason the store is server-side: this daemon binds a
// different PORT, so the window it opens gets a different browser origin and an empty
// localStorage. Without these two routes the quick window would forget the usage filter every
// time it ran standalone, which is exactly when someone is leaning on it most.
app.get('/api/ui-prefs', async (c) => {
  const { readUiPrefs } = await import('./core/ui-prefs')
  return c.json({ prefs: readUiPrefs() })
})
app.post('/api/ui-prefs', async (c) => {
  const { writeUiPrefs } = await import('./core/ui-prefs')
  const body = await c.req.json().catch(() => ({}))
  return c.json({ prefs: writeUiPrefs(body && typeof body === 'object' ? body : {}) })
})
app.post('/api/instances/:dir/open', async (c) =>
  c.json(await openInstance(decodeURIComponent(c.req.param('dir')))),
)
app.post('/api/instances/:dir/focus', async (c) =>
  c.json(await focusInstance(decodeURIComponent(c.req.param('dir')))),
)
app.post('/api/instances/:dir/quit', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await c.req.json().catch(() => ({}))
  return c.json(await quitInstance(dir, { confirmExternal: body.confirmExternal === true }))
})

app.get('/api/cli-instances', (c) => c.json(listCliInstances()))
app.post('/api/cli-instances/:id/launch', (c) => c.json(launchCliInstance(c.req.param('id'))))

app.get('/api/codex-instances', async (c) => c.json(await listCodexInstances()))
app.post('/api/codex-instances/:id/launch', (c) => c.json(launchCodexInstance(c.req.param('id'))))
app.post('/api/codex-instances/:id/desktop/open', async (c) =>
  c.json(await openCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/focus', async (c) =>
  c.json(await focusCodexDesktopInstance(c.req.param('id'))),
)
app.post('/api/codex-instances/:id/desktop/quit', async (c) =>
  c.json(await quitCodexDesktopInstance(c.req.param('id'))),
)

// The compact window holds one SSE connection for its lifetime. When the last window closes, give
// reloads/reconnects 30 seconds to come back, then retire the quick daemon automatically. A launch
// whose browser never opens also self-cleans after two minutes.
scheduleIdleExit(120_000)
app.get('/api/instance-mode/lifetime', (c) =>
  streamSSE(c, async (stream) => {
    let closed = false
    connectedWindows += 1
    console.log(`[agenthydra:instances] window connected (${connectedWindows})`)
    cancelIdleExit()
    stream.onAbort(() => {
      if (closed) return
      closed = true
      connectedWindows = Math.max(0, connectedWindows - 1)
      console.log(`[agenthydra:instances] window disconnected (${connectedWindows})`)
      if (connectedWindows === 0) scheduleIdleExit(30_000)
    })
    await stream.writeSSE({ event: 'ready', data: String(process.pid) })
    while (!closed) {
      await stream.sleep(15_000)
      if (!closed) await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
    }
  }),
)

app.get('/api/instance-mode/status', (c) => c.json({ connectedWindows }))

app.post('/api/instance-mode/shutdown', (c) => {
  setTimeout(exitCleanly, 100)
  return c.json({ ok: true })
})

// Serve the same build, whose tiny entrypoint dynamically selects QuickInstancesApp for this path.
const embeddedWeb = (
  globalThis as {
    __AGENTHYDRA_EMBEDDED_WEB__?: Readonly<Record<string, string>>
  }
).__AGENTHYDRA_EMBEDDED_WEB__
const dist = WEB_DIST_CANDIDATES.find((path) => existsSync(path))
if (embeddedWeb) {
  app.get('/*', async (c) => {
    let pathname = decodeURIComponent(new URL(c.req.url).pathname)
    if (pathname === '/' || pathname === '') pathname = '/index.html'
    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
    const isAsset = pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(lastSegment)
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
  app.get('/assets/*', (c) => c.text('not found', 404, { 'cache-control': 'no-store' }))
  app.use('/*', serveStatic({ root }))
  app.get('/*', serveStatic({ path: `${root}/index.html` }))
} else {
  app.get('/*', (c) =>
    c.html(
      '<main style="font:16px system-ui;padding:2rem"><h1>Quick Instances is not built yet</h1><p>Run <code>bun run build</code>, then launch instance mode again.</p></main>',
      503,
    ),
  )
}

// The port probe itself is a named failure mode this watchdog exists for (findFreePort retries up
// to 50 loopback binds; a hung one would otherwise wedge here silently) - renew right before it,
// then stand down the instant this process is actually listening. See ./boot-watchdog.ts.
renewBootWatchdog('listen')
const boundPort = await findFreePort(INSTANCE_MODE_PORT, 50, HOST)
// Fill the allowlist the cors() and guard callbacks above read on every request. This runs
// before Bun.serve accepts a single connection, so no request can observe the empty initial [].
allowedApiOrigins = apiOriginAllowlist(`http://${HOST}:${boundPort}`)
Bun.serve({ hostname: HOST, port: boundPort, fetch: app.fetch })
disarmBootWatchdog()
writeInstanceModeInfo(boundPort, { mode: 'instances' })
startupLock.release()
startupLock = null
process.on('exit', clearInstanceModeInfo)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, exitCleanly)

const url = `http://${HOST}:${boundPort}`
console.log(`[agenthydra:instances] ${url}/instances`)
if (!noAutoOpen()) {
  const result = await openInstanceModeWindow(url)
  console.log(
    `[agenthydra:instances] portable window: ${result.ok ? `opened with ${result.browser}` : result.reason}`,
  )
  setTimeout(() => {
    if (connectedWindows > 0) return
    console.warn(
      '[agenthydra:instances] portable window did not connect; opening a normal browser tab',
    )
    openUi(instanceModeUrl(url))
  }, 4_000)
}
