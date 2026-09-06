import { resolveAccount } from '../core/accounts'
import { detectDesktopInstall } from '../core/desktop-install'
import { setInstanceMeta } from '../core/instance-meta'
import { createInstanceModeShortcut } from '../core/instance-mode-shortcut'
import {
  instanceForConfigDir,
  listAllInstances,
  resolveInstance,
  resolveInstanceError,
} from '../core/instance-ref'
import {
  focusInstance,
  listInstances,
  openInstance,
  quitInstance,
  revealInstanceFolder,
} from '../core/instances'
import { createInstance, removeInstance } from '../core/lifecycle'
import { INSTANCE_COLOR_KEYS, INSTANCE_ICON_KEYS } from '../core/shared'
import { createInstanceShortcut } from '../core/shortcut'
import { app } from '../http-app'
import {
  cancelOrchestratorOperation,
  getOrchestratorOperation,
  listOrchestratorOperations,
  orchestratorStatus,
  runOriginAllowed,
  startOrchestratorOperation,
} from '../orchestrator'
import { jsonBody } from '../route-helpers'

/** Multi-instance (isolated Claude Desktop instances), instance-number lookups, and the
 *  orchestrator control routes. See index.ts for the app-wide middleware these routes run
 *  behind. */
// --- multi-instance (isolated Claude Desktop instances) --------------------
// "instance account" = which Anthropic account a Desktop *instance* is logged into (resolved
// by decrypting its local safeStorage token cache); distinct from the sqlite `accounts` table
// above (Anthropic auth secrets for queue dispatch). Never touches that table.
app.get('/api/instances', async (c) => {
  return c.json(await listInstances())
})

// --- instance numbers -------------------------------------------------------
// The whole fleet under ONE numbering, flattened across desktop / CLI / Codex. This is what makes
// "check instance 7" a sentence a human can say and a tool can act on: every other identifier an
// instance has is either a file path or a uuid. Kept at its own top-level path rather than under
// /api/instances/* so it can never be mistaken for (or shadowed by) a `:dir` route.
app.get('/api/instance-numbers', async (c) => c.json(await listAllInstances()))

// Resolve one reference — a number, a `#N`, a dir/id, an explicit `kind:id` ref, or an unambiguous
// name. 404 carries a reason, because "no such number" and "that number's instance was deleted"
// call for different fixes.
app.get('/api/instance-numbers/resolve', async (c) => {
  const ref = c.req.query('ref') ?? ''
  const hit = await resolveInstance(ref)
  if (hit) return c.json(hit)
  return c.json({ error: await resolveInstanceError(ref) }, 404)
})

// Reverse lookup: which instance owns this credential dir. Answers "which one am I?" for an agent
// that knows only its own CLAUDE_CONFIG_DIR / CODEX_HOME. Null (200) for the plain ~/.claude login,
// which is a real answer — it belongs to no managed instance — not an error.
app.get('/api/instance-numbers/whoami', async (c) => {
  const configDir = c.req.query('configDir') ?? ''
  return c.json(await instanceForConfigDir(configDir))
})
// Which Claude Desktop build is installed; the Instances tab warns when only the MSIX
// package is present (not launchable with --user-data-dir; see core/desktop-install.ts).
app.get('/api/desktop-install', async (c) => {
  const fresh = c.req.query('fresh')
  return c.json(await detectDesktopInstall({ fresh: fresh === '1' || fresh === 'true' }))
})
app.get('/api/instances/:dir/account', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const noNetwork = c.req.query('noNetwork')
  const account = await resolveAccount(dir, {
    noNetwork: noNetwork === '1' || noNetwork === 'true',
  })
  return c.json(account)
})
app.post('/api/instances/:dir/open', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await openInstance(dir))
})
app.post('/api/instances/:dir/quit', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await jsonBody(c)
  // Quitting the DEFAULT (non-isolated) Claude Desktop — the user's real chats — needs an explicit
  // opt-in from the caller (the UI shows a confirmation first); quitInstance refuses it otherwise.
  // Mirrors the delete route's confirmName pattern one section below.
  return c.json(await quitInstance(dir, { confirmExternal: body.confirmExternal === true }))
})
app.post('/api/instances/:dir/focus', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await focusInstance(dir))
})
app.post('/api/instances/:dir/reveal', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await revealInstanceFolder(dir))
})
// Create a desktop launcher (.lnk on Windows) that opens THIS instance directly with its
// isolated --user-data-dir; see core/shortcut.ts. Runs on the daemon's machine, matching the
// loopback posture of /open and /reveal.
app.post('/api/instances/:dir/shortcut', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  return c.json(await createInstanceShortcut(dir))
})
// One-click shortcut for the lightweight instance-only launcher. Unlike the per-instance shortcut
// above, this opens the chooser and does not launch Claude until the user selects an account.
app.post('/api/instance-mode/shortcut', async (c) => {
  return c.json(await createInstanceModeShortcut())
})

// --- the orchestrator ----------------------------------------------------------------
// The Python toolbox under orchestrator/ (see server/src/orchestrator.ts). GET is the menu and a
// health read; POST runs one script by its menu name. The scripts keep their own rails - nothing
// acts without the tray icon, a live chat is never moved - so this is a hand on the same keyboard,
// not a way around them. Loopback-only like every other route here.
app.get('/api/orchestrator', async (c) => c.json(await orchestratorStatus()))
app.post('/api/orchestrator/run', async (c) => {
  // Exact-origin only (or no Origin at all): the shared guard above lets a page on another
  // LOOPBACK PORT through as "same-site", and this route runs any script with any argv.
  if (!runOriginAllowed(c.req.header('origin'), c.req.url))
    return c.json(
      { ok: false, error: 'orchestrator/run accepts only same-origin or non-browser requests' },
      403,
    )
  const body = await jsonBody(c)
  // Durable operations (audit AH-09). An `X-Idempotency-Key` header (or body.idempotencyKey)
  // makes a retry of the same request - after a dropped connection, say - return the ORIGINAL
  // operation rather than start a second act. `async: true` answers at once with the id, for a
  // caller that would rather poll than hold a 30-minute connection open.
  const headerKey = c.req.header('x-idempotency-key')
  const idempotencyKey =
    (typeof headerKey === 'string' && headerKey.trim()) ||
    (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) ||
    null
  const started = startOrchestratorOperation(
    { script: body.script, args: body.args, timeoutMs: body.timeoutMs },
    { idempotencyKey },
  )
  if (body.async === true)
    return c.json(
      { ok: true, operationId: started.op.id, status: started.op.status, reused: started.reused },
      202,
    )
  const op = await started.promise
  const result = op.result ?? { ok: false, error: 'operation finished without a result' }
  // 409 = that script is already running through this route; 400 = the request itself is wrong.
  return c.json(
    { ...result, operationId: op.id, operationStatus: op.status, reused: started.reused },
    'error' in result ? (result.busy ? 409 : 400) : 200,
  )
})
// The operations behind that route: poll one, list recent ones, cancel a running one. Same
// origin rule as run: this is control over acts, not a read of the fleet.
app.get('/api/orchestrator/operations', (c) => c.json({ operations: listOrchestratorOperations() }))
app.get('/api/orchestrator/operations/:id', (c) => {
  const op = getOrchestratorOperation(c.req.param('id'))
  return op ? c.json(op) : c.json({ ok: false, error: 'no such operation' }, 404)
})
app.post('/api/orchestrator/operations/:id/cancel', (c) => {
  if (!runOriginAllowed(c.req.header('origin'), c.req.url))
    return c.json(
      {
        ok: false,
        error: 'orchestrator operations accept only same-origin or non-browser requests',
      },
      403,
    )
  const r = cancelOrchestratorOperation(c.req.param('id'))
  return c.json(r, r.ok ? 200 : 404)
})
app.delete('/api/instances/:dir', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await jsonBody(c)
  const confirmName = typeof body.confirmName === 'string' ? body.confirmName : undefined
  return c.json(await removeInstance(dir, { confirmName }))
})
// Update an instance's UI metadata: display label (renaming is now a pure relabel — it never
// touches the on-disk folder, so it works while the instance is running), plus icon + color.
// A field present in the body is applied (null clears it to the default); an absent field is
// left unchanged. Values are sanitized/validated in core/instance-meta.ts.
app.post('/api/instances/:dir/meta', async (c) => {
  const dir = decodeURIComponent(c.req.param('dir'))
  const body = await jsonBody(c)

  const patch: Parameters<typeof setInstanceMeta>[1] = {}
  if ('label' in body) patch.label = typeof body.label === 'string' ? body.label : null
  if ('icon' in body) {
    patch.icon =
      typeof body.icon === 'string' && (INSTANCE_ICON_KEYS as readonly string[]).includes(body.icon)
        ? (body.icon as (typeof INSTANCE_ICON_KEYS)[number])
        : null
  }
  if ('color' in body) {
    patch.color =
      typeof body.color === 'string' &&
      (INSTANCE_COLOR_KEYS as readonly string[]).includes(body.color)
        ? (body.color as (typeof INSTANCE_COLOR_KEYS)[number])
        : null
  }

  const meta = setInstanceMeta(dir, patch)
  return c.json({ ok: true, action: 'meta', dir, message: 'updated', data: meta })
})
app.post('/api/instances', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'name is required' }, 400)
  }
  return c.json(await createInstance(body.name))
})
