// AH-20 / AH-26 — an outage must not render as an empty, healthy-looking account.
//
// useData.ts used to funnel every polling failure into one shared `lastError` ref that nothing
// ever read: a rejected fetch left `sessions`/`queue`/`scheduler` exactly as they were (often
// still empty, on a first load) with no signal that the fetch had failed at all, so "the store is
// empty" and "the store could not be reached" were indistinguishable on screen. The fix gives each
// resource its OWN error/lastSuccessAt, from which `unavailable` (first load failed — nothing to
// show) and `stale` (a later poll failed — show the old data, just say so) are derived.
//
// This drives the real composable against a patched globalThis.fetch (never mock.module — see
// CLAUDE.md), restoring the original in a `finally` for every test that touches it, the same way
// the existing fetch-patching composable tests in this repo do. State resets live in beforeEach,
// not inline in each test body — doing it inline defeats TS's control-flow narrowing on
// `ref.value` (a `= null` reset right before an `await` that mutates it elsewhere gets the read
// back typed as the literal `null`), the same reason request-generations.test.ts resets there too.
import { beforeEach, describe, expect, test } from 'bun:test'
import { useData } from '../src/composables/useData'
import { runQueueItem } from '../src/lib/api'

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

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status)
}

const { sessions, sessionsStatus, queue, queueStatus, refreshSessions, refreshQueue } = useData()

describe('per-resource poll status (AH-20)', () => {
  beforeEach(() => {
    sessions.value = []
    sessionsStatus.error.value = null
    sessionsStatus.lastSuccessAt.value = null
    queue.value = []
    queueStatus.error.value = null
    queueStatus.lastSuccessAt.value = null
  })

  test('a first-load queue failure is "unavailable" — the queue stays empty, not silently so', async () => {
    const originalFetch = globalThis.fetch
    try {
      setFetch(async () => errorResponse('daemon unreachable'))
      await refreshQueue()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(queue.value).toEqual([])
    expect(queueStatus.unavailable.value).toBe(true)
    expect(queueStatus.stale.value).toBe(false)
    expect(queueStatus.error.value).toBe('daemon unreachable')
  })

  test('a later queue failure keeps the prior items and marks them stale, never unavailable', async () => {
    const originalFetch = globalThis.fetch
    try {
      setFetch(async () => jsonResponse([{ id: 'a' }]))
      await refreshQueue()
      expect(queue.value).toHaveLength(1)
      expect(queueStatus.unavailable.value).toBe(false)

      setFetch(async () => errorResponse('timed out'))
      await refreshQueue()
    } finally {
      globalThis.fetch = originalFetch
    }

    // The old row is still there — a transient failure must never blank a screen that already
    // has good (if aging) data.
    expect(queue.value.map((q) => (q as { id: string }).id)).toEqual(['a'])
    expect(queueStatus.stale.value).toBe(true)
    expect(queueStatus.unavailable.value).toBe(false)
  })

  test('a queue error does not contaminate the sessions status, or vice versa', async () => {
    const originalFetch = globalThis.fetch
    try {
      setFetch(async () => errorResponse('queue broke'))
      await refreshQueue()
      expect(queueStatus.error.value).toBe('queue broke')
      expect(sessionsStatus.error.value).toBeNull()

      // A totally unrelated resource succeeding afterwards must not touch the queue's own error —
      // each resource owns its own status, unlike the shared `lastError` this replaced.
      setFetch(async () => jsonResponse([]))
      await refreshSessions()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(sessionsStatus.error.value).toBeNull()
    expect(queueStatus.error.value).toBe('queue broke')
    expect(sessions.value).toEqual([])
  })

  test("a failed run surfaces the server's own error text, not a generic message", async () => {
    const originalFetch = globalThis.fetch
    let thrown: unknown
    try {
      setFetch(async () => errorResponse('session no longer exists', 404))
      try {
        await runQueueItem('missing-id')
      } catch (e) {
        thrown = e
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    // This is the contract QueueView.run()/SessionComposer.submit() both rely on (their
    // actionErrorText() reads e.message) to show the real reason instead of a bare count.
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('session no longer exists')
  })
})
