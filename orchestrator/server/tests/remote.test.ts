import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { CONNECTIONS_OAUTH, type RemoteConfig } from '../src/config.ts'
import { OAUTH_CALLBACK_CAPABILITY } from '../src/relay.ts'
import {
  getOAuthCallback,
  getOAuthCallbackStatus,
  getRemoteStatus,
  isQuickTunnelOrigin,
  publishRemoteRoutes,
  startRemote,
} from '../src/remote.ts'

function cfg(): RemoteConfig {
  return { oauth: { ...CONNECTIONS_OAUTH } }
}

const fakeRelay = (
  answer: { ok: boolean; capabilities?: string[]; error?: string },
  status = 200,
): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input)
    expect(url).toBe('https://app.repoyeti.com/announce')
    return new Response(JSON.stringify({ ...answer, url: 'https://app.repoyeti.com/r/abc' }), {
      status,
    })
  }) as unknown as typeof fetch

describe('quick-tunnel origins', () => {
  test('only https *.trycloudflare.com counts', () => {
    expect(isQuickTunnelOrigin('https://blue-fox-cat.trycloudflare.com')).toBe(true)
    expect(isQuickTunnelOrigin('http://blue-fox-cat.trycloudflare.com')).toBe(false)
    expect(isQuickTunnelOrigin('https://orch.example.com')).toBe(false)
    expect(isQuickTunnelOrigin('not a url')).toBe(false)
  })

  test('a stable origin completes on its own /oauth/callback, no relay needed', () => {
    const c = cfg()
    expect(getOAuthCallback(c, 'http://127.0.0.1:7790')).toEqual({
      redirectUri: 'http://127.0.0.1:7790/oauth/callback',
    })
    expect(getOAuthCallback(c, 'https://orch.example.com')).toEqual({
      redirectUri: 'https://orch.example.com/oauth/callback',
    })
    expect(getOAuthCallbackStatus(c, 'https://orch.example.com')).toBe('ready')
  })
})

describe('publishRemoteRoutes', () => {
  test('a quick tunnel is login-ready only after the relay confirms the callback capability', async () => {
    const c = cfg()
    const origin = 'https://blue-fox-cat.trycloudflare.com'
    expect(getOAuthCallback(c, origin)).toBeNull()
    expect(getOAuthCallbackStatus(c, origin)).toBe('pending')

    await publishRemoteRoutes(
      c,
      origin,
      fakeRelay({ ok: true, capabilities: [OAUTH_CALLBACK_CAPABILITY] }),
      [],
    )
    expect(getOAuthCallbackStatus(c, origin)).toBe('ready')
    expect(getOAuthCallback(c, origin)).toEqual({
      redirectUri: CONNECTIONS_OAUTH.redirectUri,
      relayId: c.relay!.identity!.id,
    })
    const s = getRemoteStatus()
    expect(s.stableUrl).toBe('https://app.repoyeti.com/r/abc')
    expect(s.relayError).toBeNull()
    // The identity was minted and persisted onto the config.
    expect(c.relay?.identity?.id).toMatch(/^[a-f0-9]{32}$/)
  })

  test('a relay without the capability is incompatible, never ready', async () => {
    const c = cfg()
    const origin = 'https://red-owl.trycloudflare.com'
    await publishRemoteRoutes(c, origin, fakeRelay({ ok: true, capabilities: [] }), [])
    expect(getOAuthCallbackStatus(c, origin)).toBe('incompatible')
    expect(getOAuthCallback(c, origin)).toBeNull()
  })

  test("a failing relay ends failed after the retry ladder, with the relay's reason", async () => {
    const c = cfg()
    const origin = 'https://green-elk.trycloudflare.com'
    let calls = 0
    const failing: typeof fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ ok: false, error: 'bad signature' }), { status: 403 })
    }) as unknown as typeof fetch
    await publishRemoteRoutes(c, origin, failing, [0, 0])
    expect(calls).toBe(3)
    expect(getOAuthCallbackStatus(c, origin)).toBe('failed')
    expect(getRemoteStatus().relayError).toBe('bad signature')
    expect(getRemoteStatus().stableUrl).toBeNull()
  })

  test('an origin the relay never heard of stays pending, whatever was announced before', async () => {
    const c = cfg()
    await publishRemoteRoutes(
      c,
      'https://one.trycloudflare.com',
      fakeRelay({ ok: true, capabilities: [OAUTH_CALLBACK_CAPABILITY] }),
      [],
    )
    expect(getOAuthCallbackStatus(c, 'https://two.trycloudflare.com')).toBe('pending')
    expect(getOAuthCallback(c, 'https://two.trycloudflare.com')).toBeNull()
  })
})

// AH-19 (remote.ts level): startRemote's onError - fired when the cloudflared connector exits -
// bumps `generation` and clears tunnelUrl/stableUrl/oauthCallback so an announce already in
// flight for the now-dead tunnel can't land afterwards and resurrect a ready/stable state.
// tunnel.test.ts already proves the low-level connector callback (an exit after readiness is
// reported, not swallowed); nothing exercised THIS guard - the one that stops a late relay
// response from undoing that exit - until now. Injected the same way tunnel.ts's own tests do: a
// fake EventEmitter child via the `spawnFn` seam, never `mock.module('node:child_process')` (see
// tunnel.test.ts's header for why that mock leaks across files in the same `bun test` run).
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = () => true
}

function fakeSpawn(child: FakeChild): Parameters<typeof startRemote>[2] {
  return (() => child) as unknown as Parameters<typeof startRemote>[2]
}

describe('startRemote: a tunnel exit after readiness cannot be resurrected', () => {
  test('exit clears tunnel/stable state, and a late-resolving announce cannot bring it back', async () => {
    const originalFetch = globalThis.fetch
    const originalNoTunnel = process.env.ORCH_NO_TUNNEL
    let resolveAnnounce!: (res: Response) => void
    const pendingAnnounce = new Promise<Response>((resolve) => {
      resolveAnnounce = resolve
    })
    globalThis.fetch = (() => pendingAnnounce) as unknown as typeof fetch
    // tests/setup.ts sets ORCH_NO_TUNNEL=1 so a stray test can't open a real tunnel; this test's
    // connector is a fake spawnFn (no real process, no network), so it is safe to lift here.
    delete process.env.ORCH_NO_TUNNEL

    try {
      const c = cfg()
      const origin = 'https://amber-fox.trycloudflare.com'
      const child = new FakeChild()
      startRemote(c, 7793, fakeSpawn(child))

      // Ready: the connector reports its URL, which kicks off (but does not await) an announce
      // this test holds open via the still-pending fetch above.
      child.stdout.emit('data', Buffer.from(origin))
      expect(getRemoteStatus().tunnelUrl).toBe(origin)

      // The connector then dies on its own, well after it was ready.
      child.emit('exit', 1)
      const afterExit = getRemoteStatus()
      expect(afterExit.tunnelUrl).toBeNull()
      expect(afterExit.stableUrl).toBeNull()
      expect(afterExit.oauthCallback).toBe('failed')

      // Now let the in-flight announce resolve as a SUCCESS, capabilities and all - it must not
      // resurrect the ready/stable state the exit just cleared.
      resolveAnnounce(
        new Response(
          JSON.stringify({
            ok: true,
            url: 'https://app.repoyeti.com/r/zzz',
            capabilities: [OAUTH_CALLBACK_CAPABILITY],
          }),
          { status: 200 },
        ),
      )
      await new Promise((r) => setTimeout(r, 20)) // flush announce()'s res.json() + the continuation

      const afterLateAnnounce = getRemoteStatus()
      expect(afterLateAnnounce.tunnelUrl).toBeNull()
      expect(afterLateAnnounce.stableUrl).toBeNull()
      expect(afterLateAnnounce.oauthCallback).toBe('failed')
    } finally {
      globalThis.fetch = originalFetch
      if (originalNoTunnel === undefined) delete process.env.ORCH_NO_TUNNEL
      else process.env.ORCH_NO_TUNNEL = originalNoTunnel
    }
  })
})
