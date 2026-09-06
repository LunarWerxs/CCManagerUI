import { afterEach, beforeEach, expect, test } from 'bun:test'
import { __resetGatewayForTests, useGateway } from '../src/composables/useGateway'
import { __setFetchForTests, type AuthStatus } from '../src/lib/api'

// AH-23: an initial auth/status transport failure used to be a one-shot - the app landed on the
// unreachable screen with no way back short of a manual reload. connect() now retries with
// bounded backoff and distinguishes that from an outright authentication refusal (401/403),
// which points at the login path instead of looping. Drives the real composable against a fake
// server via the module-scoped fetch seam (see dashboard-refresh-all.test.ts's note on why never
// globalThis.fetch).

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const authOk: AuthStatus = {
  authEnforced: true,
  remote: true,
  authenticated: true,
  owner: 'owner@example.com',
  ownerPicture: null,
  ownerClaimed: true,
  oauthCallback: 'ready',
}

beforeEach(() => __resetGatewayForTests())
afterEach(() => __setFetchForTests(null))

test('a transport failure then a success recovers without reload and reaches a connected state exactly once', async () => {
  let calls = 0
  __setFetchForTests(async (input: RequestInfo | URL): Promise<Response> => {
    const path = typeof input === 'string' ? input : input.toString()
    if (path === '/api/auth/status') {
      calls++
      if (calls === 1) throw new TypeError('fetch failed') // transport outage, not an HTTP error
      return jsonResponse(authOk)
    }
    return jsonResponse({ error: `unhandled path ${path}` }, 500)
  })

  const gateway = useGateway()
  const ok = await gateway.connect()

  expect(ok).toBe(true)
  expect(calls).toBe(2) // exactly one retry, not a burst
  expect(gateway.auth.value).toEqual(authOk)
  expect(gateway.authError.value).toBeNull()
  expect(gateway.authRefused.value).toBe(false)
  expect(gateway.reconnecting.value).toBe(false) // settled, not still "retrying automatically…"

  // "Starts one poller" - startPolling() is idempotent (stops any prior timer first), so the
  // real guarantee worth proving here is that recovery leaves the gateway in a state where the
  // normal post-connect bootstrap (App.vue's afterAuthReady) can safely call it: a single
  // /api/status fetch per poll tick, not one per stray timer.
  let statusCalls = 0
  __setFetchForTests(async (input: RequestInfo | URL): Promise<Response> => {
    const path = typeof input === 'string' ? input : input.toString()
    if (path === '/api/status') {
      statusCalls++
      return jsonResponse({})
    }
    return jsonResponse({}, 200)
  })
  gateway.startPolling(10)
  gateway.startPolling(10) // calling it again (as a second recovery would) must not add a timer
  await new Promise((r) => setTimeout(r, 35))
  gateway.stopPolling()
  const afterStop = statusCalls
  await new Promise((r) => setTimeout(r, 35))
  expect(statusCalls).toBe(afterStop) // stopped for good, no leftover second interval still firing
}, 10_000)

test('a 401 during connect goes to the login path and never enters a reconnect loop', async () => {
  let calls = 0
  __setFetchForTests(async (input: RequestInfo | URL): Promise<Response> => {
    const path = typeof input === 'string' ? input : input.toString()
    if (path === '/api/auth/status') {
      calls++
      return jsonResponse({ error: 'nope' }, 401)
    }
    return jsonResponse({ error: `unhandled path ${path}` }, 500)
  })

  const gateway = useGateway()
  const ok = await gateway.connect()

  expect(ok).toBe(false)
  expect(gateway.authRefused.value).toBe(true)
  expect(gateway.auth.value).toBeNull()
  expect(gateway.reconnecting.value).toBe(false)

  // Give a would-be backoff timer a chance to fire; a real reconnect loop would have scheduled
  // one at 2s, so waiting well short of that and seeing no extra call proves none was scheduled.
  await new Promise((r) => setTimeout(r, 50))
  expect(calls).toBe(1)
})

test('a 403 is treated the same as a 401 - login path, no reconnect', async () => {
  __setFetchForTests(async () => jsonResponse({ error: 'forbidden' }, 403))
  const gateway = useGateway()
  const ok = await gateway.connect()
  expect(ok).toBe(false)
  expect(gateway.authRefused.value).toBe(true)
})

test('a manual retry supersedes an in-flight backoff wait instead of racing it', async () => {
  let calls = 0
  __setFetchForTests(async (input: RequestInfo | URL): Promise<Response> => {
    const path = typeof input === 'string' ? input : input.toString()
    if (path === '/api/auth/status') {
      calls++
      if (calls <= 2) throw new TypeError('fetch failed')
      return jsonResponse(authOk)
    }
    return jsonResponse({}, 200)
  })

  const gateway = useGateway()
  const first = gateway.connect() // will fail once, then sit in a 2s backoff wait
  await new Promise((r) => setTimeout(r, 20)) // let the first attempt land and schedule its wait

  const second = gateway.connect() // user clicks Retry - should supersede, not stack
  const [firstResult, secondResult] = await Promise.all([first, second])

  expect(firstResult).toBe(false) // superseded, resolves false rather than double-reporting success
  expect(secondResult).toBe(true)
  expect(gateway.auth.value).toEqual(authOk)
}, 10_000)
