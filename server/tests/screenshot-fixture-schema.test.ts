import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// scripts/screenshots/page-fixtures.js is evaluated as a browser script, not imported as a module
// (see its own header comment) — it replaces `window.fetch` before the SPA boots. To exercise it
// from a bun test we sandbox it behind a fake `window`, exactly the shape capture.mjs's injected
// page provides, then drive the `fetch` it installs the same way the app does.
function loadFixtureFetch(): typeof fetch {
  const src = readFileSync(
    join(import.meta.dir, '../../scripts/screenshots/page-fixtures.js'),
    'utf8',
  )
  const fakeWindow: { fetch: typeof fetch; EventSource?: unknown; __fixtureEscapes?: string[] } = {
    fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  }
  // This IS the thing under test: running the fixture the same way the browser does, with a fake
  // `window` standing in for the page's real one.
  const run = new Function('window', src)
  run(fakeWindow)
  return fakeWindow.fetch
}

// TitleSource, server/src/types.ts ~line 238.
const ALLOWED_TITLE_SOURCES = ['custom', 'ai', 'store', 'envelope', 'message', 'id']

// SessionSummary, server/src/types.ts ~lines 120-216 — every field below is required there (no `?`
// on any of them; the nullable ones are typed `T | null`, which is still a required property). This
// is AH-41: the fixture omitted `title_source`, session-labels.ts's i18n lookup threw on the
// missing key, and the built UI rendered no session list at all.
const REQUIRED_SESSION_FIELDS = [
  'session_id',
  'source',
  'tool',
  'locator',
  'title',
  'cwd',
  'project',
  'git_branch',
  'message_count',
  'created_at',
  'last_activity_at',
  'last_role',
  'last_text_preview',
  'size_bytes',
  'transcript_path',
  'queue_status',
  'instance',
  'archived',
  'done',
  'subagent_count',
  'dispatched',
  'limit_stop',
  'title_source',
  'title_tag',
  'copy_index',
  'copy_count',
  'ended_because',
] as const

test('every fixture session row carries every field SessionSummary requires', async () => {
  const fetchStub = loadFixtureFetch()
  const res = await fetchStub('http://fixture.test/api/sessions')
  const sessions = (await res.json()) as Record<string, unknown>[]
  expect(sessions.length).toBeGreaterThan(0)
  for (const row of sessions) {
    for (const field of REQUIRED_SESSION_FIELDS) {
      expect(row).toHaveProperty(field)
    }
    expect(ALLOWED_TITLE_SOURCES).toContain(row.title_source as string)
  }
})

test('a queue-create POST is refused, mirroring headlessRunsAllowed() === false', async () => {
  const fetchStub = loadFixtureFetch()
  const res = await fetchStub('http://fixture.test/api/queue', {
    method: 'POST',
    body: JSON.stringify({ title: 't', cwd: 'C:\\x', prompt: 'p' }),
  })
  expect(res.status).toBe(409)
  const body = (await res.json()) as { error: string }
  expect(body.error).toMatch(/no-headless/)
})
