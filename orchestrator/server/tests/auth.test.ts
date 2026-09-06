import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { handleComplete, handleLogin, ownerMatches, refusesRemoteClaim, txs } from '../src/auth.ts'
import { CONNECTIONS_OAUTH, type OAuthConfig } from '../src/config.ts'
import { sign } from '../src/signing.ts'

function oauth(extra: Partial<OAuthConfig> = {}): OAuthConfig {
  return { ...CONNECTIONS_OAUTH, ...extra }
}

const discovery = {
  authorization_endpoint: 'https://accounts.connections.icu/oauth/authorize',
  token_endpoint: 'https://accounts.connections.icu/oauth/token',
  jwks_uri: 'https://accounts.connections.icu/oauth/jwks',
}
const discoveryFetch: typeof fetch = (async (input: string | URL | Request) => {
  if (String(input).endsWith('/.well-known/openid-configuration')) return Response.json(discovery)
  throw new Error(`unexpected fetch ${String(input)}`)
}) as unknown as typeof fetch

describe('ownerMatches', () => {
  test('sub or email, case-insensitively for email, and nothing when no owner is set', () => {
    expect(ownerMatches(oauth(), 's', 'a@b.c')).toBe(false)
    expect(ownerMatches(oauth({ ownerSub: 's' }), 's', '')).toBe(true)
    expect(ownerMatches(oauth({ ownerEmail: 'A@B.c' }), 'x', 'a@b.C')).toBe(true)
    expect(ownerMatches(oauth({ ownerSub: 's' }), 'other', '')).toBe(false)
  })
})

describe('handleLogin', () => {
  test('redirects to the IdP with PKCE, the resolved redirect URI and a signed state that carries the origin', async () => {
    const app = new Hono()
    app.get('/oauth/login', (c) =>
      handleLogin(c, oauth(), {
        fetchImpl: discoveryFetch,
        resolveRedirect: async () => ({
          redirectUri: CONNECTIONS_OAUTH.redirectUri,
          relayId: '0123456789abcdef0123456789abcdef',
        }),
      }),
    )
    const res = await app.request('https://blue-fox.trycloudflare.com/oauth/login', {
      headers: { host: 'blue-fox.trycloudflare.com', 'x-forwarded-proto': 'https' },
    })
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin + to.pathname).toBe(discovery.authorization_endpoint)
    expect(to.searchParams.get('client_id')).toBe(CONNECTIONS_OAUTH.clientId)
    expect(to.searchParams.get('redirect_uri')).toBe(CONNECTIONS_OAUTH.redirectUri)
    expect(to.searchParams.get('code_challenge_method')).toBe('S256')
    expect(to.searchParams.get('scope')).toBe('openid profile email photo')
    const state = to.searchParams.get('state')!
    // The relay reads the FIRST segment of state as base64url JSON and needs `r` in it.
    const payload = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString()) as {
      o: string
      d: string
      r: string
      n: string
    }
    expect(payload.o).toBe('https://blue-fox.trycloudflare.com')
    expect(payload.d).toBe(CONNECTIONS_OAUTH.redirectUri)
    expect(payload.r).toBe('0123456789abcdef0123456789abcdef')
    expect(txs.has(payload.n)).toBe(true)
  })

  test('a loopback login without a resolver uses its own callback', async () => {
    const app = new Hono()
    app.get('/oauth/login', (c) => handleLogin(c, oauth(), { fetchImpl: discoveryFetch }))
    const res = await app.request('http://127.0.0.1:7790/oauth/login', {
      headers: { host: '127.0.0.1:7790' },
    })
    const to = new URL(res.headers.get('location')!)
    expect(to.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:7790/oauth/callback')
  })
})

describe('ownership can only be claimed at the machine', () => {
  // The takeover this closes: while an install is unclaimed, /oauth/login is necessarily outside
  // the auth gate (a sign-in cannot require a session), so any verified Connections account that
  // reached the public hostname would otherwise become the permanent owner - and the owner can
  // arm this machine's fleet automation from a phone. A URL is not a secret.
  test('an unclaimed install refuses a claim that arrived over the tunnel', () => {
    expect(refusesRemoteClaim(oauth(), true)).toBe(true)
  })

  test('the same sign-in at the keyboard is allowed to claim it', () => {
    expect(refusesRemoteClaim(oauth(), false)).toBe(false)
  })

  test('once claimed, a remote sign-in is ordinary again - the rule gates claiming, not logging in', () => {
    expect(refusesRemoteClaim(oauth({ ownerSub: 's' }), true)).toBe(false)
    expect(refusesRemoteClaim(oauth({ ownerEmail: 'a@b.c' }), true)).toBe(false)
  })
})

describe('handleLogin surfaces a retryable page instead of throwing', () => {
  // AH-23: discovery used to be unguarded - a rejected fetch escaped handleLogin as an uncaught
  // throw, which Hono turns into a bare 500 instead of the gateway's own bounded error page.
  test('a rejecting discovery fetch returns the retryable error page, not a throw', async () => {
    const app = new Hono()
    const rejectingFetch: typeof fetch = (async () => {
      throw new Error('network is down')
    }) as unknown as typeof fetch
    // A unique issuer per test bypasses auth.ts's module-level discovery cache, which is keyed by
    // issuer and shared across every test in this file - reusing CONNECTIONS_OAUTH.issuer here
    // would risk silently serving another test's already-cached (successful) discovery doc.
    app.get('/oauth/login', (c) =>
      handleLogin(c, oauth({ issuer: 'https://discovery-rejects.test' }), {
        fetchImpl: rejectingFetch,
      }),
    )

    const res = await app.request('http://127.0.0.1:7790/oauth/login')
    expect([502, 503]).toContain(res.status)
    const body = await res.text()
    expect(body.toLowerCase()).toContain('try again')
  })

  test('a discovery document missing authorization_endpoint also returns the retryable page', async () => {
    const app = new Hono()
    const incompleteFetch: typeof fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/.well-known/openid-configuration')) {
        return Response.json({ token_endpoint: discovery.token_endpoint })
      }
      throw new Error(`unexpected fetch ${String(input)}`)
    }) as unknown as typeof fetch
    app.get('/oauth/login', (c) =>
      handleLogin(c, oauth({ issuer: 'https://discovery-incomplete.test' }), {
        fetchImpl: incompleteFetch,
      }),
    )

    const res = await app.request('http://127.0.0.1:7790/oauth/login')
    expect([502, 503]).toContain(res.status)
  })
})

describe('handleComplete', () => {
  test('rejects a missing code, a tampered state, and an unknown transaction before touching the IdP', async () => {
    const app = new Hono()
    let idpCalls = 0
    const spy: typeof fetch = (async () => {
      idpCalls++
      return Response.json(discovery)
    }) as unknown as typeof fetch
    app.get('/oauth/finish', (c) => handleComplete(c, oauth(), { fetchImpl: spy }))

    expect((await app.request('http://127.0.0.1:7790/oauth/finish')).status).toBe(400)
    expect(
      (await app.request('http://127.0.0.1:7790/oauth/finish?code=x&state=garbage.garbage')).status,
    ).toBe(400)
    const orphan = sign(JSON.stringify({ n: 'never-issued', o: 'http://127.0.0.1:7790' }))
    expect(
      (
        await app.request(
          `http://127.0.0.1:7790/oauth/finish?code=x&state=${encodeURIComponent(orphan)}`,
        )
      ).status,
    ).toBe(400)
    expect(idpCalls).toBe(0)
  })
})
