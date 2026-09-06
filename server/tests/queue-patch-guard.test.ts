// AH-13: PATCH /api/queue/:id used to accept a caller-forged `status` (including 'running' and
// 'completed') and let identity fields (cwd/prompt/model/…) be edited on a row that was already
// active or being recovered on boot, silently desyncing the persisted row from what dispatch.ts's
// in-memory runner actually captured at spawn time. This file locks in the guarded replacement:
// status can only move queued -> canceled via PATCH (an active run still cancels through the
// dedicated POST /api/queue/:id/cancel path), runner-owned bookkeeping fields are refused outright,
// and identity fields lock once a row's status is 'running' (isActive() OR the boot-recovery window
// before reattachRuns() repopulates the in-memory `active` map — both read the same DB column).
//
// Routes are exercised through the real registrations (routes/queue.ts's side-effecting import,
// no listening port) but dispatched on a PRIVATE Hono copied from the shared app, never on the
// shared app itself - see `http` below. The sqlite db is the suite's isolated scratch file
// (tests/setup.ts preload), so rows are inserted directly, same pattern as dispatch.test.ts's
// makeItem.

import { beforeEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { app } from '../src/http-app'
import '../src/routes/queue'
import { db } from '../src/db'

// Hono builds its router on the first request and refuses new routes after that, and `app` in
// http-app.ts is ONE object for the whole bun test process. The first file to call app.request()
// therefore freezes it for every file that loads a routes/*.ts module after it: this file did, and
// session-locator-multi-store.test.ts, importing routes/sessions later in the serial order, died at
// import with "Can not add a route since the matcher is already built". route('/', app) copies the
// routes registered so far into a fresh app with its own router, so the shared one stays open.
const http = new Hono().route('/', app)

let counter = 0
function insertItem(overrides: { status?: string; cwd?: string } = {}) {
  const id = `qpg-${++counter}`
  const sessionId = `qpg-sess-${counter}`
  db.query(
    `insert into queue_items (id, session_id, title, cwd, prompt, new_chat, fork, status, position, created_at)
     values (?, ?, 'test item', ?, 'hello', 0, 0, ?, 0, ?)`,
  ).run(id, sessionId, overrides.cwd ?? '/tmp/repo', overrides.status ?? 'queued', Date.now())
  return id
}

function rowOf(id: string) {
  return db.query('select * from queue_items where id = ?').get(id) as Record<string, unknown>
}

async function patch(id: string, body: Record<string, unknown>) {
  const res = await http.request(`/api/queue/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  db.query('delete from queue_items').run()
})

test('a forged status of running or completed is rejected, not written', async () => {
  const id = insertItem()
  for (const status of ['running', 'completed']) {
    const { status: httpStatus, json } = await patch(id, { status })
    expect(httpStatus).toBeGreaterThanOrEqual(400)
    expect(httpStatus).toBeLessThan(500)
    expect(String(json.error)).toContain('runner-owned')
  }
  expect(rowOf(id).status).toBe('queued') // untouched
})

test('a runner-owned field is rejected with a 4xx naming the field', async () => {
  const id = insertItem()
  const { status, json } = await patch(id, { exit_code: 0, pid: 4242 })
  expect(status).toBeGreaterThanOrEqual(400)
  expect(status).toBeLessThan(500)
  expect(String(json.error)).toContain('exit_code')
  expect(String(json.error)).toContain('pid')
  const row = rowOf(id)
  expect(row.exit_code).toBeNull()
  expect(row.pid).toBeNull()
})

test('an identity field is rejected with the field named when the item is active/recovering', async () => {
  // status: 'running' with no in-memory `active` entry stands in for BOTH cases the guard covers:
  // a genuinely active run, and the boot window before reattachRuns() repopulates `active` — the
  // route only ever consults the DB column plus isActive(), and this exercises the DB half.
  const id = insertItem({ status: 'running' })
  const { status, json } = await patch(id, { cwd: '/somewhere/else' })
  expect(status).toBe(409)
  expect(String(json.error)).toContain('cwd')
  expect(String(json.error)).toContain('active or recovering')
  expect(rowOf(id).cwd).toBe('/tmp/repo') // untouched — the persisted spec still matches the runner
})

test('an allowed presentation edit succeeds even on an active row', async () => {
  const id = insertItem({ status: 'running' })
  const { status, json } = await patch(id, { title: 'renamed while running' })
  expect(status).toBe(200)
  expect(json.title).toBe('renamed while running')
  expect(rowOf(id).title).toBe('renamed while running')
})

test('canceling a pending item succeeds through the explicit status transition', async () => {
  const id = insertItem() // queued
  const { status, json } = await patch(id, { status: 'canceled' })
  expect(status).toBe(200)
  expect(json.status).toBe('canceled')
  expect(rowOf(id).status).toBe('canceled')
})

test('canceling via PATCH is refused once the item is no longer queued', async () => {
  const id = insertItem({ status: 'running' })
  const { status, json } = await patch(id, { status: 'canceled' })
  expect(status).toBe(409)
  expect(String(json.error)).toContain('/api/queue/:id/cancel')
  expect(rowOf(id).status).toBe('running') // untouched
})

test('DELETE refuses a row that is still marked active', async () => {
  const id = insertItem({ status: 'running' })
  const res = await http.request(`/api/queue/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(409)
  expect(rowOf(id)).toBeTruthy() // not deleted
})

test('DELETE succeeds for a pending (queued) item', async () => {
  const id = insertItem()
  const res = await http.request(`/api/queue/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(rowOf(id)).toBeNull() // sqlite's .get() answers null, not undefined, for no match
})
