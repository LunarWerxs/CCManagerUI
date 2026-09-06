// web/tests/api-session-locator.test.ts — audit AH-35: server/src/session-locator.ts identifies a
// session row by source + product + physical store, not source + id alone, because two products
// sharing a format (Kilo/MiMo Code, both `opencode`; two Hermes profiles) can hold the same session
// id. The client side of that fix is web/src/lib/api.ts sending `?locator=` alongside `?source=` on
// the calls that address one specific row — this locks in that every one of them does, and that
// omitting the locator (an older row, a synthetic fixture) still behaves exactly as before.
import { expect, test } from 'bun:test'
import {
  getSession,
  getSessionUsage,
  getTail,
  openSessionFile,
  sessionExportUrl,
  setSessionDone,
} from '../src/lib/api'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function setFetch(fn: FetchFn): void {
  globalThis.fetch = fn as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const LOCATOR = 'v1:WyJvcGVuY29kZSIsImtpbG8iLCJDOlxca2lsby5kYiIsInMxIl0'

async function capturedUrl(call: () => Promise<unknown>): Promise<string> {
  const original = globalThis.fetch
  let seen: string | undefined
  try {
    setFetch(async (input) => {
      seen = String(input)
      return jsonResponse({})
    })
    await call().catch(() => {})
  } finally {
    globalThis.fetch = original
  }
  if (!seen) throw new Error('fetch was never called')
  return seen
}

// --- export: a pure string builder, no fetch involved ------------------------------------------
test('sessionExportUrl adds &locator= when given one, and omits it otherwise', () => {
  const withLocator = sessionExportUrl('s1', 'opencode', 'markdown', false, LOCATOR)
  expect(withLocator).toContain(`&locator=${encodeURIComponent(LOCATOR)}`)
  expect(withLocator).toContain('source=opencode')

  const without = sessionExportUrl('s1', 'opencode', 'markdown')
  expect(without).not.toContain('locator=')
})

// --- tail ----------------------------------------------------------------------------------------
test('getTail sends locator on the tail request when the row has one', async () => {
  const url = await capturedUrl(() => getTail('s1', 'opencode', {}, LOCATOR))
  expect(url).toContain(`locator=${encodeURIComponent(LOCATOR)}`)
})

test('getTail omits locator entirely when none is given — old behavior, unchanged', async () => {
  const url = await capturedUrl(() => getTail('s1', 'opencode', {}))
  expect(url).not.toContain('locator=')
  expect(url).toContain('source=opencode')
})

// --- mark (done) -----------------------------------------------------------------------------
test('setSessionDone sends locator alongside source', async () => {
  const url = await capturedUrl(() => setSessionDone('s1', 'opencode', true, LOCATOR))
  expect(url).toContain(`locator=${encodeURIComponent(LOCATOR)}`)
})

test('setSessionDone with no locator matches the pre-locator URL shape', async () => {
  const url = await capturedUrl(() => setSessionDone('s1', 'opencode', true))
  expect(url).toBe('http://localhost:7787/api/sessions/s1/done?source=opencode')
})

// --- open ------------------------------------------------------------------------------------
test('openSessionFile sends locator alongside source', async () => {
  const url = await capturedUrl(() => openSessionFile('s1', 'opencode', LOCATOR))
  expect(url).toContain(`locator=${encodeURIComponent(LOCATOR)}`)
})

// --- a couple of the remaining single-row lookups, for the same contract ---------------------
test('getSession and getSessionUsage both thread the locator through', async () => {
  const sessionUrl = await capturedUrl(() => getSession('s1', 'opencode', LOCATOR))
  expect(sessionUrl).toContain(`locator=${encodeURIComponent(LOCATOR)}`)

  const usageUrl = await capturedUrl(() => getSessionUsage('s1', 'opencode', LOCATOR))
  expect(usageUrl).toContain(`locator=${encodeURIComponent(LOCATOR)}`)
})
