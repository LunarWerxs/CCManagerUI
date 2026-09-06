/**
 * The remote runtime: open the tunnel, announce its address, and answer "which callback does a
 * login from THIS origin use?". Vendored from the relevant half of RepoYeti's src/runtime.ts.
 *
 * A Quick Tunnel origin (*.trycloudflare.com) cannot be a registered redirect URI - it rotates -
 * so its logins go through the relay: this module announces (id, origin) to the relay with the
 * gateway's Ed25519 identity, retrying 1s/3s/10s, and only once the relay confirms
 * `oauth-callback-v1` is the login route "ready". Loopback and a named tunnel complete directly.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_DIR,
  DEFAULT_PORT,
  ensureConfigDir,
  namedTunnel,
  type RelayIdentity,
  type RemoteConfig,
  relayBase,
  saveConfig,
  tunnelStartProblem,
} from './config.ts'
import {
  type AnnounceResult,
  announce,
  createRelayIdentity,
  OAUTH_CALLBACK_CAPABILITY,
  publicKeyFor,
} from './relay.ts'
import { startNamedTunnel, startTunnel, type TunnelHandle } from './tunnel.ts'

export type OAuthCallbackStatus = 'ready' | 'pending' | 'retrying' | 'failed' | 'incompatible'

interface OAuthCallbackRoute {
  origin: string
  redirectUri: string
  relayId: string
  status: 'ready' | 'retrying' | 'failed' | 'incompatible'
  error?: string
}

export interface RemoteStatus {
  tunnel: 'quick' | 'named' | 'off'
  tunnelUrl: string | null
  tunnelError: string | null
  /** The permanent address to hand out: the relay's /r/<id> for a Quick Tunnel, the hostname for a named one. */
  stableUrl: string | null
  relayError: string | null
  oauthCallback: OAuthCallbackStatus
}

const state: RemoteStatus = {
  tunnel: 'off',
  tunnelUrl: null,
  tunnelError: null,
  stableUrl: null,
  relayError: null,
  oauthCallback: 'pending',
}
let oauthCallbackRoute: OAuthCallbackRoute | null = null
let generation = 0
const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000]

export function isQuickTunnelOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.hostname.toLowerCase().endsWith('.trycloudflare.com')
  } catch {
    return false
  }
}

/** The gateway's relay keypair, minted and persisted on first need. */
export function ensureRelayIdentity(cfg: RemoteConfig): RelayIdentity {
  const existing = cfg.relay?.identity
  if (existing?.privateKey && /^[a-f0-9]{32}$/.test(existing.id)) {
    try {
      if (publicKeyFor(existing.privateKey) === existing.publicKey) return existing
    } catch {
      /* malformed - rotate below */
    }
  }
  if (existing)
    console.warn(
      '[orchestrator-remote] relay identity is incomplete or mismatched; rotating the stable address',
    )
  const identity = createRelayIdentity()
  cfg.relay = { ...cfg.relay, identity }
  try {
    saveConfig(cfg)
  } catch (err) {
    console.warn(`[orchestrator-remote] could not persist the relay identity: ${String(err)}`)
  }
  return identity
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function computeCallbackStatus(
  res: AnnounceResult,
  attempt: number,
  retryDelays: readonly number[],
): OAuthCallbackRoute['status'] {
  if (!res.ok) return attempt < retryDelays.length ? 'retrying' : 'failed'
  const compatible = res.capabilities?.includes(OAUTH_CALLBACK_CAPABILITY) ?? false
  return compatible ? 'ready' : 'incompatible'
}

function callbackRouteError(
  res: AnnounceResult,
  status: OAuthCallbackRoute['status'],
): string | undefined {
  if (res.ok)
    return status === 'incompatible'
      ? `relay does not support ${OAUTH_CALLBACK_CAPABILITY}`
      : undefined
  return res.error ?? 'announce failed'
}

/**
 * Records one announce attempt's outcome into the module state (oauthCallbackRoute + state) and
 * returns the resulting status, so the caller knows whether to retry.
 */
function recordAnnounceAttempt(
  cfg: RemoteConfig,
  origin: string,
  redirectUri: string,
  identity: RelayIdentity,
  callbackBase: string,
  res: AnnounceResult,
  attempt: number,
  retryDelays: readonly number[],
): OAuthCallbackRoute['status'] {
  const status = computeCallbackStatus(res, attempt, retryDelays)
  const error = callbackRouteError(res, status)
  oauthCallbackRoute = {
    origin,
    redirectUri,
    relayId: identity.id,
    status,
    ...(error ? { error } : {}),
  }
  state.oauthCallback = status
  state.relayError = error ?? null
  // The relay that answers the OAuth callback is the same one that serves /r/<id>, unless the
  // owner pointed `relay.url` elsewhere; the stable address is only claimed when it answered.
  state.stableUrl =
    res.ok && callbackBase === relayBase(cfg)
      ? (res.url ?? `${callbackBase}/r/${identity.id}`)
      : null
  writeStatusFile()
  return status
}

/**
 * Announce one freshly-created tunnel origin. Quick Tunnel: register the OAuth return route (and
 * with it the stable /r/<id> address). Named tunnel: the hostname IS the stable address, nothing
 * to announce. Only the newest call may update the module state - a stopped tunnel must not
 * become login-ready because its older announce finished last.
 */
export async function publishRemoteRoutes(
  cfg: RemoteConfig,
  origin: string,
  fetchImpl: typeof fetch = fetch,
  retryDelays: readonly number[] = RETRY_DELAYS_MS,
): Promise<void> {
  const gen = ++generation
  if (!isQuickTunnelOrigin(origin)) {
    oauthCallbackRoute = null
    state.stableUrl = origin
    state.relayError = null
    state.oauthCallback = 'ready'
    return
  }
  const redirectUri = cfg.oauth?.redirectUri
  if (!redirectUri) {
    oauthCallbackRoute = null
    state.oauthCallback = 'failed'
    state.relayError = 'no redirectUri configured'
    return
  }
  const callbackBase = new URL(redirectUri).origin
  const identity = ensureRelayIdentity(cfg)
  for (let attempt = 0; ; attempt++) {
    const res = await announce(callbackBase, identity, origin, fetchImpl)
    if (gen !== generation) return
    const status = recordAnnounceAttempt(
      cfg,
      origin,
      redirectUri,
      identity,
      callbackBase,
      res,
      attempt,
      retryDelays,
    )
    if (status !== 'retrying') {
      if (!res.ok) console.warn(`[orchestrator-remote] relay announce failed: ${res.error}`)
      return
    }
    await sleep(retryDelays[attempt]!)
    if (gen !== generation) return
  }
}

/** Exact callback for a login from `origin`, or null while a Quick Tunnel's announce is unavailable. */
export function getOAuthCallback(
  cfg: RemoteConfig,
  origin: string,
): { redirectUri: string; relayId?: string } | null {
  if (!isQuickTunnelOrigin(origin)) return { redirectUri: `${origin}/oauth/callback` }
  if (
    oauthCallbackRoute?.origin !== origin ||
    oauthCallbackRoute.redirectUri !== cfg.oauth?.redirectUri ||
    oauthCallbackRoute.status !== 'ready'
  ) {
    return null
  }
  return { redirectUri: oauthCallbackRoute.redirectUri, relayId: oauthCallbackRoute.relayId }
}

export function getOAuthCallbackStatus(cfg: RemoteConfig, origin: string): OAuthCallbackStatus {
  if (!isQuickTunnelOrigin(origin)) return 'ready'
  if (
    oauthCallbackRoute?.origin !== origin ||
    oauthCallbackRoute.redirectUri !== cfg.oauth?.redirectUri
  )
    return 'pending'
  return oauthCallbackRoute.status
}

export function getRemoteStatus(): RemoteStatus {
  return { ...state }
}

/** state/remote/status.json - so scripts/remote.py and the tray can print the address without asking the gateway. */
function writeStatusFile(port = DEFAULT_PORT): void {
  try {
    ensureConfigDir()
    writeFileSync(
      join(CONFIG_DIR, 'status.json'),
      JSON.stringify({ pid: process.pid, port, at: Date.now(), ...state }, null, 2),
    )
  } catch {
    /* informational only */
  }
}

/** Open the tunnel for `port`. Returns null (and says why) when no tunnel may be opened. */
export function startRemote(cfg: RemoteConfig, port: number): TunnelHandle | null {
  if (process.env.ORCH_NO_TUNNEL === '1') {
    state.tunnel = 'off'
    state.tunnelError = 'ORCH_NO_TUNNEL=1 - serving loopback only'
    writeStatusFile(port)
    console.log('[orchestrator-remote] tunnel OFF (ORCH_NO_TUNNEL=1); loopback only')
    return null
  }
  const problem = tunnelStartProblem(cfg)
  if (problem) {
    state.tunnel = 'off'
    state.tunnelError = `refusing to open a tunnel: ${problem === 'auth' ? 'sign-in is not configured, and a public URL with no auth is this machine on the open internet' : problem}`
    writeStatusFile(port)
    console.error(`[orchestrator-remote] ${state.tunnelError}`)
    return null
  }
  const onUrl = (url: string): void => {
    state.tunnelUrl = url
    state.tunnelError = null
    writeStatusFile(port)
    console.log(`[orchestrator-remote] tunnel up: ${url}`)
    void publishRemoteRoutes(cfg, url).then(() => {
      if (state.stableUrl) console.log(`[orchestrator-remote] stable address: ${state.stableUrl}`)
      if (state.relayError) console.warn(`[orchestrator-remote] relay: ${state.relayError}`)
      writeStatusFile(port)
    })
  }
  const onError = (message: string): void => {
    // Bump generation so an announce loop already in flight for the now-dead connector (started
    // by an earlier onUrl) can't land its result afterwards and resurrect a ready/stableUrl state
    // - see the `gen !== generation` guards in publishRemoteRoutes.
    generation++
    state.tunnelError = message
    state.tunnelUrl = null
    state.stableUrl = null
    state.oauthCallback = 'failed'
    writeStatusFile(port)
    console.error(`[orchestrator-remote] tunnel: ${message}`)
  }
  const named = namedTunnel(cfg)
  if (named) {
    state.tunnel = 'named'
    return startNamedTunnel(named.token, named.hostname, onUrl, onError)
  }
  state.tunnel = 'quick'
  return startTunnel(port, onUrl, onError)
}
