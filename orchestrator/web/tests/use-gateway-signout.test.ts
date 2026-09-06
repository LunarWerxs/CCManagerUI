import { beforeEach, expect, test } from 'bun:test'
import { __resetGatewayForTests, useGateway } from '../src/composables/useGateway'
import { __setFetchForTests } from '../src/lib/api'

// AH-26 (remote half): signOut() used to reload the page unconditionally, so a rejected
// /api/auth/logout(-all) call reloaded anyway - the user saw a fresh sign-in-looking page while
// the session cookie never actually cleared. Note: `window` is not defined in this bun:test
// environment (no DOM), which is exactly why only the FAILURE path is exercised here - it must
// never reach `window.location.reload()`, so its absence is not a problem for this test.

beforeEach(() => __resetGatewayForTests())

test('a rejected sign-out surfaces a message instead of pretending to have signed out', async () => {
  __setFetchForTests(
    async () =>
      new Response(JSON.stringify({ error: 'gateway unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
  )

  const gateway = useGateway()
  expect(gateway.signOutError.value).toBeNull()

  // Would throw from window.location.reload() if the fix regressed and the rejection were
  // swallowed on the way to a "success" reload - it isn't reached, so this must resolve cleanly.
  await gateway.signOut(false)

  expect(gateway.signOutError.value).not.toBeNull()
  expect(gateway.signOutError.value).toContain('gateway unreachable')
})

test('sign-out everywhere failure is reported the same way', async () => {
  __setFetchForTests(async () => {
    throw new TypeError('fetch failed')
  })

  const gateway = useGateway()
  await gateway.signOut(true)

  expect(gateway.signOutError.value).toBe('fetch failed')
})
