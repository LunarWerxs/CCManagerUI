import { describe, expect, test } from 'bun:test'
import type { GatewayStatus } from '../src/lib/api'
import { tunnelBadgeFor } from '../src/lib/tunnelBadge'

// AH-26 (remote half): StatusPills used to check `tunnel === 'off'` before a recorded
// tunnelError, so a refused/failed-to-start tunnel (ORCH_NO_TUNNEL, tunnelStartProblem - both set
// `tunnel:'off'` alongside a reason, see server/src/remote.ts's startRemote) rendered the same
// calm "tunnel off · loopback only" badge as a tunnel nobody ever asked for. Pulled the decision
// into tunnelBadgeFor() so it's tested here without mounting the component.

function remote(overrides: Partial<GatewayStatus['remote']> = {}): GatewayStatus['remote'] {
  return {
    tunnel: 'off',
    tunnelUrl: null,
    tunnelError: null,
    stableUrl: null,
    relayError: null,
    oauthCallback: 'ready',
    ...overrides,
  }
}

describe('tunnelBadgeFor', () => {
  test('off with no recorded reason is the plain, intentional badge', () => {
    const badge = tunnelBadgeFor(remote({ tunnel: 'off', tunnelError: null }))
    expect(badge.kind).toBe('off')
    expect(badge.variant).toBe('secondary')
    expect(badge.text).toContain('loopback only')
  })

  test('off WITH a recorded reason (ORCH_NO_TUNNEL / a config refusal) is distinct and destructive', () => {
    const badge = tunnelBadgeFor(
      remote({ tunnel: 'off', tunnelError: 'ORCH_NO_TUNNEL=1 - serving loopback only' }),
    )
    expect(badge.kind).toBe('off-error')
    expect(badge.variant).toBe('destructive')
    expect(badge.text).toContain('ORCH_NO_TUNNEL=1')
    expect(badge.title).toBe('ORCH_NO_TUNNEL=1 - serving loopback only')
  })

  // The connector-dies-after-readiness case (tunnel.ts's onError): `tunnel` stays 'quick'/'named'
  // (remote.ts never resets it to 'off'), only tunnelUrl/tunnelError change.
  test('a live tunnel kind with a recorded error reads as failed, not off', () => {
    const badge = tunnelBadgeFor(
      remote({
        tunnel: 'quick',
        tunnelUrl: null,
        tunnelError:
          'cloudflared exited unexpectedly (code 1) after the tunnel was ready - remote access is down',
      }),
    )
    expect(badge.kind).toBe('failed')
    expect(badge.variant).toBe('destructive')
  })

  test('no error and not off yet is the neutral starting state', () => {
    const badge = tunnelBadgeFor(remote({ tunnel: 'quick', tunnelUrl: null, tunnelError: null }))
    expect(badge.kind).toBe('starting')
    expect(badge.variant).toBe('secondary')
  })
})
