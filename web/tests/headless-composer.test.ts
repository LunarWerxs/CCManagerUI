// AH-12 — headless queueing/dispatch is permanently refused (server/src/headless-policy.ts,
// headlessRunsAllowed() hardcoded false), so the controls that used to create or dispatch a queue
// item (Queue Builder's create flow, Run / Run Due, the composer's "queue behind a busy session"
// promise) are gone or disabled in favor of the one path that still works: delivering a message
// straight into a session's own desktop chat (server/src/routes/session-message.ts). This covers
// the two pieces of that fix with a checkable contract:
//   1. HEADLESS_QUEUEING_ENABLED (web/src/lib/headless.ts) is the single flag every disabled
//      control reads — flipping it back on without also restoring dispatch would silently
//      re-expose controls that 409, so this pins it to false.
//   2. sendSessionMessage (web/src/lib/api.ts) surfaces the SERVER's real refusal text on every
//      failure shape the route can produce — including a busy chat's honest refusal, and the one
//      case that is NOT a thrown fetch error (a 200 response with `ok:false`, the "typed, but the
//      transcript did not grow" soft-fail) — which is exactly the "unavailability text instead of
//      a Send that will 409" behavior AH-12 asks for in SessionComposer.
import { describe, expect, test } from 'bun:test'
import { sendSessionMessage } from '../src/lib/api'
import { HEADLESS_QUEUEING_ENABLED } from '../src/lib/headless'

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

describe('AH-12: headless queueing stays off', () => {
  test('the flag every disabled control reads is false', () => {
    // Not a tautology: this is what QueueBuilder/QueueView/QueueItemCard/SessionComposer branch
    // on to decide whether to render a working control or an honest refusal. If headless-policy.ts
    // is ever un-hardcoded, this constant (and every UI branch reading it) has to move with it.
    expect(HEADLESS_QUEUEING_ENABLED).toBe(false)
  })
})

describe('AH-12: sendSessionMessage surfaces the real refusal text', () => {
  test('a busy chat (422 "composer refused") throws with the server message, not a bare failure', async () => {
    const originalFetch = globalThis.fetch
    try {
      setFetch(async () =>
        jsonResponse({ ok: false, error: 'composer refused: pane reports busy, aborting' }, 422),
      )
      let thrown: unknown
      try {
        await sendSessionMessage('sess-1', 'hello')
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('composer refused: pane reports busy, aborting')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a soft-fail 200 (typed, but the transcript never grew) still throws — ok:false is not success', async () => {
    const originalFetch = globalThis.fetch
    try {
      setFetch(async () =>
        jsonResponse(
          {
            ok: false,
            typed: true,
            delivered: false,
            detail: 'typed, but the transcript did not grow within 120s',
          },
          200,
        ),
      )
      let thrown: unknown
      try {
        await sendSessionMessage('sess-1', 'hello')
      } catch (e) {
        thrown = e
      }
      // The one shape j() would NOT throw on by itself (2xx status) — sendSessionMessage has to
      // check `ok` itself, or a stalled delivery would read as a successful send.
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('typed, but the transcript did not grow within 120s')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a real delivery resolves without throwing', async () => {
    const originalFetch = globalThis.fetch
    try {
      setFetch(async () =>
        jsonResponse({ ok: true, typed: true, delivered: true, detail: 'delivered' }, 200),
      )
      const result = await sendSessionMessage('sess-1', 'hello')
      expect(result.detail).toBe('delivered')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
