import { streamSSE } from 'hono/streaming'
import { clearCliInstanceAccountAssociations } from '../core/cli-instances'
import { coerceQueueItem, db, runOutcome } from '../db'
import {
  cancelItem,
  dispatchItem,
  getRunEvents,
  isActive,
  isSessionActive,
  type RunMessage,
  subscribeRun,
} from '../dispatch'
import { headlessRunsAllowed, NO_HEADLESS_REASON } from '../headless-policy'
import { app } from '../http-app'
import { resolveRunAsRef } from '../instance-sessions'
import { clearMonitorForAccount } from '../monitor'
import { applyNewChatDefaults } from '../new-chat-defaults'
import { invalidEnum, jsonBody, VALID_EFFORTS, VALID_PERMISSION_MODES } from '../route-helpers'
import { schedulerState, setSchedulerSettings } from '../scheduler'
import { desktopHomeFor } from '../session-launch'
import { runCost } from '../session-usage'
import { type Account, AMBIENT_RUN_AS, type QueueItem } from '../types'
import { dropCachedUsage } from '../usage'
import { dropUsageHistory } from '../usage-history'

/** Row status values that exist. Kept local: nothing outside this module's accounts/queue/scheduler
 *  routes needs it. NOT every value here is PATCH-able by a caller — see the status handling in the
 *  PATCH route below (AH-13): only 'canceled', and only from 'queued'. */
const VALID_QUEUE_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'unverified',
  'failed',
  'rate_limited',
  'overloaded',
  'canceled',
])

/**
 * Fields the RUNNER alone may set — spawn/finalize bookkeeping (dispatch.ts). A client naming one
 * of these in a PATCH body now gets a 400 that names the field, rather than the old silent no-op:
 * none of these were ever in the `allow` coercion map below, so a forged pid/exit_code/started_at
 * simply vanished with no signal anything was rejected (AH-13).
 */
const RUNNER_OWNED_FIELDS = [
  'pid',
  'started_at',
  'finished_at',
  'exit_code',
  'retry_attempts',
  'import_state',
  'import_error',
  'import_to',
  'import_title',
  'allow_headless',
] as const

/**
 * Fields that define WHAT a run executes — the spec dispatch.ts reads at spawn time (buildArgv,
 * account/instance resolution). Editable while an item is only PLANNED (queued, not yet dispatched);
 * locked once the row is active or recovering, because the in-memory runner already captured the old
 * values — a PATCH here would leave the persisted row describing a different run than the one
 * actually executing or being reattached (AH-13).
 */
const IDENTITY_FIELDS = [
  'session_id',
  'cwd',
  'prompt',
  'model',
  'effort',
  'permission_mode',
  'account_id',
  'instance_ref',
  'new_chat',
  'fork',
] as const

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

function listAccounts(): Account[] {
  return db
    .query<
      { id: string; label: string; auth_type: string; secret: string; created_at: number },
      []
    >('select * from accounts order by created_at asc')
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      auth_type: r.auth_type as Account['auth_type'],
      secret_masked: maskSecret(r.secret),
      created_at: r.created_at,
    }))
}

/** Accounts, the dispatch queue, its live SSE stream, and the scheduler. See index.ts for the
 *  app-wide middleware these routes run behind. */
/**
 * Cost of ONE queued run.
 *
 * Not stored, and deliberately: a run is a time window on a session that already has per-turn usage
 * in its transcript, so the honest number is the one computed by re-reading that window. Storing it
 * would add a second figure that can disagree with the session's own.
 */
app.get('/api/queue/:id/cost', async (c) => {
  const id = c.req.param('id')
  const item = db.query<QueueItem, [string]>('select * from queue_items where id = ?').get(id)
  if (!item) return c.json({ error: 'run not found' }, 404)
  return c.json(await runCost(coerceQueueItem(item)))
})

// --- accounts ---------------------------------------------------------------
app.get('/api/accounts', (c) => c.json(listAccounts()))
app.post('/api/accounts', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (
    !body ||
    typeof body.label !== 'string' ||
    !body.label.trim() ||
    typeof body.secret !== 'string' ||
    !body.secret ||
    (body.auth_type !== 'oauth_token' && body.auth_type !== 'api_key')
  ) {
    return c.json({ error: 'label, auth_type (oauth_token|api_key), and secret are required' }, 400)
  }
  const id = crypto.randomUUID()
  db.query(
    'insert into accounts (id, label, auth_type, secret, created_at) values (?, ?, ?, ?, ?)',
  ).run(id, body.label, body.auth_type, body.secret, Date.now())
  return c.json(listAccounts().find((a) => a.id === id))
})
// Deleting an account means deleting everything keyed to it. Only queue_items.account_id is a real
// foreign key (on delete set null); the rest live in files or in tables sqlite won't cascade into,
// so each has to be swept by hand or it outlives the account — a CLI instance badge naming an
// account that's gone, a usage reading served for it, a monitor opt-out waiting to be re-applied.
app.delete('/api/accounts/:id', (c) => {
  const id = c.req.param('id')
  db.query('delete from accounts where id = ?').run(id)
  clearCliInstanceAccountAssociations(id) // cli-instances.json (no FK reaches a file)
  clearMonitorForAccount(id) // monitor_accounts (a table, but no FK)
  dropCachedUsage(`acct:${id}`) // usage-cache.json — same key usage-service.ts writes
  dropUsageHistory(`acct:${id}`) // usage-history.json, capped per key but not per key COUNT
  return c.json({ ok: true })
})

// --- queue ------------------------------------------------------------------
app.get('/api/queue', (c) =>
  c.json(
    db
      .query<QueueItem, []>('select * from queue_items order by position asc, created_at asc')
      .all()
      .map(coerceQueueItem),
  ),
)
app.post('/api/queue', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (
    !body ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    typeof body.cwd !== 'string' ||
    !body.cwd.trim() ||
    typeof body.prompt !== 'string' ||
    !body.prompt.trim()
  ) {
    return c.json({ error: 'title, cwd, and prompt are required' }, 400)
  }
  if ('new_chat' in body && typeof body.new_chat !== 'boolean')
    return c.json({ error: 'new_chat must be a boolean' }, 400)
  if ('fork' in body && typeof body.fork !== 'boolean')
    return c.json({ error: 'fork must be a boolean' }, 400)
  if (body.session_id != null && (typeof body.session_id !== 'string' || !body.session_id.trim()))
    return c.json({ error: 'session_id must be a non-empty string' }, 400)
  for (const field of ['model', 'account_id', 'instance_ref'] as const) {
    if (body[field] != null && typeof body[field] !== 'string')
      return c.json({ error: `${field} must be a string or null` }, 400)
  }
  if (
    typeof body.account_id === 'string' &&
    !db.query('select 1 from accounts where id = ?').get(body.account_id)
  )
    return c.json({ error: `unknown account '${body.account_id}'` }, 400)
  const id = crypto.randomUUID()
  const sessionId = body.new_chat ? (body.session_id ?? crypto.randomUUID()) : body.session_id
  if (!sessionId)
    return c.json({ error: 'session_id is required when resuming an existing session' }, 400)
  // SURFACE PURITY, refused early with a readable error (owner law 2026-08-26, hardened same
  // day: "much more programmatic guardrails, so it can't make mistakes"). A thread that lives in
  // a desktop sidebar is NEVER continued headless — a queued `--resume` of it is exactly the
  // cross-open the owner banned. dispatch.ts enforces the same rule at the spawn chokepoint, so
  // this route check is the friendly message rather than the enforcement; `force` records the
  // owner's deliberate override ON THE ROW (allow_headless) so the chokepoint honours it too.
  // Checked for EVERY row, new_chat included. A new chat normally mints its own id and sails
  // through, but this route accepts a caller-supplied id even when new_chat is true, and the
  // runner then passes it as `--session-id` — so exempting new_chat let
  // `{new_chat: true, session_id: <an existing desktop chat>}` write headless turns into that
  // chat. The question is about the ID, never about the caller's label for the request.
  // NO HEADLESS (owner law 2026-08-27), refused at the point of ASKING rather than only at the
  // point of running. The chokepoint in dispatch.ts is still the enforcement and still refuses
  // every one of these; without this the route would happily accept the row and hand back an id,
  // and the caller would find out only when it failed later. Queueing work into something that
  // cannot run it is a dead end with a receipt. The two paragraphs above describe the narrower
  // check this replaces, whose `force` escape is also gone: an override that defeats "never" is
  // the old behaviour behind a flag.
  if (!headlessRunsAllowed()) return c.json({ error: NO_HEADLESS_REASON }, 409)
  const allowHeadless = body.force === true
  if (!allowHeadless && (await desktopHomeFor(sessionId)))
    return c.json(
      {
        error:
          'surface-violation: this thread lives in the desktop app — continue it there (native delivery), never headless. force:true is the owner-only escape.',
      },
      409,
    )
  if (
    body.not_before != null &&
    (typeof body.not_before !== 'string' || Number.isNaN(Date.parse(body.not_before)))
  ) {
    return c.json({ error: 'not_before must be an ISO timestamp' }, 400)
  }
  const enumError =
    invalidEnum(body.permission_mode, VALID_PERMISSION_MODES, 'permission_mode') ??
    invalidEnum(body.effort, VALID_EFFORTS, 'effort')
  if (enumError) return c.json({ error: enumError }, 400)
  // normalize to UTC ISO so the scheduler's lexicographic compare is always sound
  const notBefore = body.not_before ? new Date(Date.parse(body.not_before)).toISOString() : null
  // Run-as resolution (resolveRunAsRef documents the precedence). A caller that names NEITHER an
  // instance nor an account is not asking for the ambient CLI login — it simply hasn't said, and for
  // a resume the right answer is knowable: the desktop instance this chat actually belongs to.
  // Without this, a resume of an instance's chat goes out on a DIFFERENT account's credentials,
  // which is how "You've hit your weekly limit" shows up for an account nowhere near its limit.
  // Resolved once, HERE, so the choice is STORED on the row: visible on the card, editable, and
  // carried forward into an auto-resume (monitor.ts copies instance_ref).
  const instanceRef = resolveRunAsRef(body, sessionId)
  // Owner rule 2026-08-30 (new-chat-defaults.ts): a NEW chat that names no model starts on
  // Opus + the ultracode keyword; explicit choices pass through untouched. Applied HERE at
  // storage so the queue row shows exactly what will run.
  if (body.ultracode !== undefined && typeof body.ultracode !== 'boolean')
    return c.json({ error: 'ultracode must be a boolean' }, 400)
  // Same strictness as ultracode (review-confirmed asymmetry): a non-string model is a caller
  // bug, and silently defaulting it to opus would hide that the intended value was dropped.
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string')
    return c.json({ error: 'model must be a string' }, 400)
  const newChatSpec = applyNewChatDefaults({
    newChat: body.new_chat === true,
    model: typeof body.model === 'string' ? body.model : null,
    prompt: body.prompt,
    ultracode: body.ultracode,
  })
  const posRow = db
    .query<{ m: number | null }, []>('select max(position) as m from queue_items')
    .get()
  const position = (posRow?.m ?? 0) + 1
  db.query(
    `insert into queue_items
       (id, session_id, title, cwd, prompt, model, effort, permission_mode, account_id, instance_ref, new_chat, fork, status, position, not_before, created_at, allow_headless)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    body.title,
    body.cwd,
    newChatSpec.prompt,
    newChatSpec.model,
    body.effort ?? null,
    body.permission_mode ?? null,
    body.account_id ?? null,
    instanceRef,
    body.new_chat ? 1 : 0,
    body.fork ? 1 : 0,
    position,
    notBefore,
    Date.now(),
    allowHeadless ? 1 : 0,
  )
  return c.json(coerceQueueItem(db.query('select * from queue_items where id = ?').get(id)))
})
app.patch('/api/queue/:id', async (c) => {
  const id = c.req.param('id')
  const existing = db
    .query<{ status: string }, [string]>('select * from queue_items where id = ?')
    .get(id)
  if (!existing) return c.json({ error: 'queue item not found' }, 404)
  const body = await jsonBody(c)
  // AH-13: never even look at a runner-owned field's value — name it and refuse outright.
  const forbidden = RUNNER_OWNED_FIELDS.filter((f) => f in body)
  if (forbidden.length)
    return c.json(
      {
        error: `${forbidden.join(', ')} ${forbidden.length > 1 ? 'are' : 'is'} runner-owned and cannot be set via PATCH`,
      },
      400,
    )
  // reject (don't silently coerce) the two fields where a bad value corrupts the item:
  // a cleared schedule dispatches early, a "null" session id reaches the CLI as --resume null
  if (
    'not_before' in body &&
    body.not_before != null &&
    (typeof body.not_before !== 'string' || Number.isNaN(Date.parse(body.not_before)))
  ) {
    return c.json({ error: 'not_before must be an ISO timestamp' }, 400)
  }
  if ('session_id' in body && (typeof body.session_id !== 'string' || !body.session_id.trim())) {
    return c.json({ error: 'session_id must be a non-empty string' }, 400)
  }
  for (const field of ['title', 'cwd', 'prompt'] as const) {
    if (field in body && (typeof body[field] !== 'string' || !(body[field] as string).trim()))
      return c.json({ error: `${field} must be a non-empty string` }, 400)
  }
  for (const field of ['model', 'account_id', 'instance_ref'] as const) {
    if (field in body && body[field] != null && typeof body[field] !== 'string')
      return c.json({ error: `${field} must be a string or null` }, 400)
  }
  // AH-13: status is runner-owned except for ONE client-initiated transition — canceling a PENDING
  // item. Every other value (running/completed/unverified/failed/rate_limited/overloaded, or
  // 'canceled' on a row that isn't 'queued') is written only by dispatch.ts as a run actually
  // progresses; accepting them here let a caller forge a completed/running history, or PATCH a
  // status the in-memory runner disagrees with. Canceling an ACTIVE run has its own guarded path
  // (POST /api/queue/:id/cancel -> dispatch.ts cancelItem, which kills the process); this is
  // deliberately narrower and does not duplicate it.
  if ('status' in body) {
    if (typeof body.status !== 'string' || !VALID_QUEUE_STATUSES.has(body.status))
      return c.json(
        { error: `status must be one of: ${[...VALID_QUEUE_STATUSES].join(', ')}` },
        400,
      )
    if (body.status !== 'canceled')
      return c.json(
        { error: "status can only be set to 'canceled' via PATCH; other values are runner-owned" },
        400,
      )
    if (existing.status !== 'queued')
      return c.json(
        {
          error: `cannot cancel via PATCH: item is '${existing.status}', not 'queued' — use POST /api/queue/:id/cancel for an active run`,
        },
        409,
      )
  }
  // AH-13: identity fields describe WHAT the run executes. Once dispatch.ts has captured them — the
  // row is active (isActive() sees a live tail) OR its status is still 'running' (the boot window
  // before reattachRuns() re-populates `active`, see boot-state.ts isDispatchReady) — an edit here
  // would silently desync the persisted row from the run that is actually executing or recovering.
  if (isActive(id) || existing.status === 'running') {
    const lockedFields = IDENTITY_FIELDS.filter((f) => f in body)
    if (lockedFields.length)
      return c.json(
        { error: `cannot edit ${lockedFields.join(', ')}: item is active or recovering` },
        409,
      )
  }
  if ('position' in body && (typeof body.position !== 'number' || !Number.isFinite(body.position)))
    return c.json({ error: 'position must be a finite number' }, 400)
  for (const field of ['new_chat', 'fork'] as const) {
    if (field in body && typeof body[field] !== 'boolean')
      return c.json({ error: `${field} must be a boolean` }, 400)
  }
  if (
    typeof body.account_id === 'string' &&
    !db.query('select 1 from accounts where id = ?').get(body.account_id)
  )
    return c.json({ error: `unknown account '${body.account_id}'` }, 400)
  // Same server-side enum guard as POST: never patch a garbage permission_mode/effort into a row
  // (permission_mode reaches `claude --permission-mode <v>`). Only checked when the field is present.
  const patchEnumError =
    ('permission_mode' in body
      ? invalidEnum(body.permission_mode, VALID_PERMISSION_MODES, 'permission_mode')
      : null) ?? ('effort' in body ? invalidEnum(body.effort, VALID_EFFORTS, 'effort') : null)
  if (patchEnumError) return c.json({ error: patchEnumError }, 400)
  const allow: Record<string, (v: any) => unknown> = {
    session_id: String,
    title: String,
    cwd: String,
    prompt: String,
    model: (v) => (v == null ? null : String(v)),
    effort: (v) => (v == null ? null : String(v)),
    permission_mode: (v) => (v == null ? null : String(v)),
    account_id: (v) => (v == null ? null : String(v)),
    // An edit is always an explicit choice, so there is nothing to auto-resolve here — but the
    // picker still speaks the sentinel, and storing it verbatim would fail the run at launch
    // ("run-as instance reference is malformed"). Unpin instead.
    instance_ref: (v) => (v == null || v === AMBIENT_RUN_AS ? null : String(v)),
    status: String,
    position: (v) => Math.trunc(Number(v)),
    // normalized to UTC ISO (unparseable → null); scheduler compares these as text
    not_before: (v) => {
      if (v == null) return null
      const ms = Date.parse(String(v))
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null
    },
    new_chat: (v) => (v ? 1 : 0),
    fork: (v) => (v ? 1 : 0),
  }
  const fields: string[] = []
  const values: unknown[] = []
  for (const [k, coerce] of Object.entries(allow)) {
    if (k in body) {
      fields.push(`${k} = ?`)
      values.push(coerce(body[k]))
    }
  }
  if (fields.length) {
    values.push(id)
    db.query(`update queue_items set ${fields.join(', ')} where id = ?`).run(...(values as any[]))
    // The new-chat defaults hold on the PATCH door too (review-confirmed backdoor: flipping
    // new_chat true on a defaults-skipped resume row silently started a brand-new chat
    // outside Opus+ultracode). Applied to the EFFECTIVE row after the update, so a patch that
    // also sets model/prompt is respected as the explicit choice it is.
    if (body.new_chat === true) {
      const row = db
        .query<{ model: string | null; prompt: string }, [string]>(
          'select model, prompt from queue_items where id = ?',
        )
        .get(id)
      if (row) {
        const spec = applyNewChatDefaults({
          newChat: true,
          model: row.model,
          prompt: row.prompt,
        })
        if (spec.model !== row.model || spec.prompt !== row.prompt)
          db.query('update queue_items set model = ?, prompt = ? where id = ?').run(
            spec.model,
            spec.prompt,
            id,
          )
      }
    }
  }
  return c.json(coerceQueueItem(db.query('select * from queue_items where id = ?').get(id)))
})
app.delete('/api/queue/:id', (c) => {
  const id = c.req.param('id')
  // AH-13: isActive() alone misses the boot window before reattachRuns() re-populates `active` — a
  // row whose status is still 'running' at that point is exactly as live (or as recovering-in-place)
  // as one already in the map, and deleting it out from under a reattach would orphan its runner.
  const row = db
    .query<{ status: string }, [string]>('select status from queue_items where id = ?')
    .get(id)
  if (isActive(id) || row?.status === 'running')
    return c.json({ error: 'cannot delete a running item; cancel it first' }, 409)
  db.query('delete from queue_items where id = ?').run(id)
  return c.json({ ok: true })
})
app.post('/api/queue/:id/run', (c) => {
  const id = c.req.param('id')
  const row = db.query('select * from queue_items where id = ?').get(id)
  if (!row) return c.json({ error: 'queue item not found' }, 404)
  if (isActive(id)) return c.json({ error: 'already running' }, 409)
  const item = coerceQueueItem(row)
  if (isSessionActive(item.session_id))
    return c.json({ error: 'another run is already active for this session' }, 409)
  void dispatchItem(item)
  return c.json({ ok: true, started: true })
})
// Manual bulk drain: dispatch every currently-due queued item at once. Deliberately
// ignores the scheduler's enabled/spacing/max_concurrent limits (same semantics as
// pressing Run on each card) but honors the per-session run lock; items whose session
// is (or just became) busy stay queued and are reported as skipped.
app.post('/api/queue/run-due', (c) => {
  const due = db
    .query<QueueItem, [string]>(
      `select * from queue_items
       where status = 'queued' and (not_before is null or not_before <= ?)
       order by position asc, created_at asc`,
    )
    .all(new Date().toISOString())
  let started = 0
  let skipped = 0
  for (const row of due) {
    const item = coerceQueueItem(row)
    // dispatchItem registers the session synchronously before its first await, so a
    // second due item for the same session correctly lands in the skipped bucket
    if (isActive(item.id) || isSessionActive(item.session_id)) {
      skipped++
      continue
    }
    void dispatchItem(item)
    started++
  }
  return c.json({ ok: true, started, skipped })
})
app.post('/api/queue/:id/cancel', (c) => c.json({ ok: cancelItem(c.req.param('id')) }))
// A run's events PLUS how it ended. The events alone cannot say whether the run finished, died or
// was killed — an agent reading a truncated-looking log has no way to tell a short answer from a
// crash — and the daemon already knows, because the runner reports the child's exit code.
app.get('/api/queue/:id/events', (c) => {
  const id = c.req.param('id')
  const item = db.query<QueueItem, [string]>('select * from queue_items where id = ?').get(id)
  if (!item) return c.json({ error: 'run not found' }, 404)
  return c.json({ outcome: runOutcome(coerceQueueItem(item)), events: getRunEvents(id) })
})

// --- live run stream (SSE) --------------------------------------------------
app.get('/api/queue/:id/stream', (c) => {
  const id = c.req.param('id')
  return streamSSE(c, async (stream) => {
    const buffer: RunMessage[] = []
    let closed = false
    const unsub = subscribeRun(id, (m) => buffer.push(m))
    stream.onAbort(() => {
      closed = true
      unsub()
    })
    // backlog first, deduped against anything the subscription also captured
    const seen = new Set<number>()
    for (const ev of getRunEvents(id)) {
      seen.add(ev.id)
      await stream.writeSSE({ data: JSON.stringify({ type: 'event', data: ev }) })
    }
    let ticks = 0
    while (!closed) {
      while (buffer.length) {
        const m = buffer.shift()!
        if (m.type === 'event' && seen.has(m.data.id)) continue
        if (m.type === 'event') seen.add(m.data.id)
        await stream.writeSSE({ data: JSON.stringify(m) })
      }
      await stream.sleep(300)
      if (++ticks % 50 === 0) await stream.writeSSE({ data: '', event: 'ping' })
    }
  })
})

// --- scheduler --------------------------------------------------------------
app.get('/api/scheduler', (c) => c.json(schedulerState()))
app.post('/api/scheduler', async (c) => {
  const body = await jsonBody(c)
  return c.json(
    setSchedulerSettings({
      spacing_seconds: typeof body.spacing_seconds === 'number' ? body.spacing_seconds : undefined,
      poll_seconds: typeof body.poll_seconds === 'number' ? body.poll_seconds : undefined,
      max_concurrent: typeof body.max_concurrent === 'number' ? body.max_concurrent : undefined,
      tomorrow_time: typeof body.tomorrow_time === 'string' ? body.tomorrow_time : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    }),
  )
})
