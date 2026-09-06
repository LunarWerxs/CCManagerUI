import type { GatewayStatus } from './api'

export type TunnelBadgeKind = 'off-error' | 'off' | 'failed' | 'starting'

export interface TunnelBadge {
  kind: TunnelBadgeKind
  text: string
  variant: 'destructive' | 'secondary'
  title: string | null
}

/**
 * AH-26: `remote.tunnel === 'off'` covers two very different states - ORCH_NO_TUNNEL / a config
 * refusal (tunnelError set alongside it, see server/src/remote.ts's startRemote) versus nobody
 * ever having asked for a tunnel (no error). It also stays 'quick'/'named' - never reset to 'off'
 * - when a connector dies after it was ready (server/src/tunnel.ts), so that case already falls
 * through to the plain `tunnelError` branch below. Pulled out of StatusPills.vue's template so
 * this decision is unit-testable without mounting the component.
 */
export function tunnelBadgeFor(remote: GatewayStatus['remote']): TunnelBadge {
  if (remote.tunnel === 'off' && remote.tunnelError) {
    return {
      kind: 'off-error',
      text: `tunnel off - ${remote.tunnelError}`,
      variant: 'destructive',
      title: remote.tunnelError,
    }
  }
  if (remote.tunnel === 'off') {
    return { kind: 'off', text: 'tunnel off · loopback only', variant: 'secondary', title: null }
  }
  if (remote.tunnelError) {
    return {
      kind: 'failed',
      text: 'tunnel failed',
      variant: 'destructive',
      title: remote.tunnelError,
    }
  }
  return { kind: 'starting', text: 'tunnel starting…', variant: 'secondary', title: null }
}
