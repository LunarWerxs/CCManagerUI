/**
 * "Sign in with Connections" - public OIDC relying party, vendored from RepoYeti's src/auth.ts
 * and trimmed to what a single-owner dashboard needs (no share links, no guests, no API tokens).
 *
 * The gateway only ever calls the IdP's PUBLIC URLs (discovered from
 * `<issuer>/.well-known/openid-configuration`) and verifies the returned id_token with the IdP's
 * PUBLIC JWKS (via `jose`). No shared secret, no coupling to the Connections repo.
 *
 * Flow (gateway-side PKCE; the phone never holds tokens):
 *   /oauth/login -> authorize with the exact registered redirect URI signed into `state` -> IdP ->
 *   the relay's /oauth/callback bounces `code`+`state` to this gateway's /oauth/finish (Quick Tunnel),
 *   or the IdP returns straight to /oauth/callback (loopback, named tunnel) -> token exchange with
 *   that same redirect URI -> verify id_token (JWKS) -> owner check -> signed session cookie.
 *
 * ACCESS POLICY: a request that arrived over the tunnel ALWAYS needs a signed-in owner. A loopback
 * request is open - the Python dashboard on the same machine is open on loopback too, and the
 * tunnel is the only thing this gateway adds. Local is guarded against browser CSRF separately.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { authEnforced, type OAuthConfig, type RemoteConfig } from './config.ts'
import { rotateKey, sign, unsign } from './signing.ts'

const COOKIE = 'orch_session'
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000
const TX_TTL_MS = 10 * 60 * 1000
const AUTH_FETCH_TIMEOUT_MS = 15_000
export const MAX_OAUTH_TRANSACTIONS = 256

export interface Session {
  sub: string
  email: string
  name?: string
  picture?: string
  exp: number
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AuthOptions {
  /** HMAC secret for the session cookie + state; defaults to the per-install key. */
  secret?: Buffer
  /** Called after a first-use ownership claim mutated `oauth.ownerSub`, so the host persists it. */
  onOwnerClaimed?: (oauth: OAuthConfig) => void
}

export interface HandleLoginOptions extends AuthOptions {
  fetchImpl?: FetchLike
  /** Resolve the exact registered callback for the browser-visible origin (relay for a Quick Tunnel). */
  resolveRedirect?: (origin: string) => Promise<{ redirectUri: string; relayId?: string }>
}

export interface HandleCompleteOptions extends AuthOptions {
  fetchImpl?: FetchLike
  /** Test seam: a JWKS resolver in place of createRemoteJWKSet. */
  jwksSet?: Parameters<typeof jwtVerify>[1]
}

export class OAuthCallbackUnavailableError extends Error {
  constructor(readonly reason: 'temporary' | 'failed' | 'incompatible') {
    super('Quick Tunnel OAuth callback is unavailable')
  }
}

// ── OIDC discovery + JWKS (cached) ─────────────────────────────────────────────
let discoveryCache: { issuer: string; doc: Record<string, string> } | null = null
function authFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS) })
}
async function discover(
  issuer: string,
  doFetch: FetchLike = authFetch,
): Promise<Record<string, string>> {
  const iss = issuer.replace(/\/$/, '')
  if (discoveryCache?.issuer === iss) return discoveryCache.doc
  const res = await doFetch(`${iss}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const doc = (await res.json()) as Record<string, string>
  discoveryCache = { issuer: iss, doc }
  return doc
}

let jwksCache: { uri: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null
function jwks(uri: string) {
  if (jwksCache?.uri !== uri) jwksCache = { uri, set: createRemoteJWKSet(new URL(uri)) }
  return jwksCache.set
}

// ── PKCE transactions ──────────────────────────────────────────────────────────
/** @internal exported for tests. */
export const txs = new Map<string, { verifier: string; ts: number }>()
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}
function gcTx(): void {
  const now = Date.now()
  for (const [k, v] of txs) if (now - v.ts > TX_TTL_MS) txs.delete(k)
  while (txs.size > MAX_OAUTH_TRANSACTIONS) {
    const oldest = txs.keys().next().value as string | undefined
    if (!oldest) break
    txs.delete(oldest)
  }
}

/**
 * True when this sign-in must NOT be allowed to claim the install: it arrived over the tunnel
 * and nobody owns this gateway yet. Split out so the rule is testable without forging a
 * verifiable id_token - the full handleComplete path cannot be exercised without a real JWT,
 * and a rule this load-bearing should not rest on an integration test that cannot reach it.
 */
export function refusesRemoteClaim(o: OAuthConfig, remote: boolean): boolean {
  return remote && !o.ownerSub && !o.ownerEmail
}

export function ownerMatches(o: OAuthConfig, sub: string, email: string): boolean {
  if (o.ownerSub && sub === o.ownerSub) return true
  if (o.ownerEmail && email && email.toLowerCase() === o.ownerEmail.toLowerCase()) return true
  return false
}

// ── request provenance ─────────────────────────────────────────────────────────
/** Proto as the CLIENT saw it: cloudflared terminates TLS and forwards plain http. */
function clientProto(c: Context): string {
  return (
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ||
    new URL(c.req.url).protocol.replace(':', '')
  )
}
function isHttps(c: Context): boolean {
  return clientProto(c) === 'https'
}
/** The gateway's public origin as the browser reached it - signed into state so the relay bounce
 *  and the post-login navigation stay bound to the initiating host. */
export function publicOrigin(c: Context): string {
  const u = new URL(c.req.url)
  u.protocol = `${clientProto(c)}:`
  return u.origin
}

/**
 * True when the request came in over the tunnel. Cloudflare adds these and a remote caller
 * cannot strip them; a loopback request has none. Only expose this gateway through cloudflared
 * (or another proxy that sets them) - behind a proxy that does not, remote would read as local.
 */
export function isRemoteRequest(c: Context): boolean {
  return !!(
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    c.req.header('x-forwarded-proto')
  )
}

// ── session cookie ─────────────────────────────────────────────────────────────
function setSession(c: Context, s: Session, opts?: AuthOptions): void {
  setCookie(c, COOKIE, sign(JSON.stringify(s), opts?.secret), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function readSession(c: Context, o: OAuthConfig, opts?: AuthOptions): Session | null {
  const raw = unsign(getCookie(c, COOKIE), opts?.secret)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Session
    if (!s.exp || s.exp < Date.now()) return null
    if (!ownerMatches(o, s.sub, s.email)) return null
    return s
  } catch {
    return null
  }
}

// ── the error page ─────────────────────────────────────────────────────────────
function errPage(
  message: string,
  action: { href: string; label: string } = { href: '/oauth/login', label: 'Try again' },
): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orchestrator - sign in</title>
<body style="margin:0;background:#0e0e12;color:#e6e6ea;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<div style="max-width:340px;text-align:center;padding:24px">
<div style="font-size:40px">🔒</div>
<h2 style="margin:12px 0 8px">Can't sign you in</h2>
<p style="color:#9a9aa6;font-size:14px;line-height:1.5">${message}</p>
<a href="${action.href}" style="display:inline-block;margin-top:14px;background:#f2b84b;color:#221a06;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:9px">${action.label}</a>
</div></body>`
}

// ── handlers ────────────────────────────────────────────────────────────────────
export async function handleLogin(
  c: Context,
  oauth: OAuthConfig,
  opts?: HandleLoginOptions,
): Promise<Response> {
  const origin = publicOrigin(c)
  let resolved: { redirectUri: string; relayId?: string }
  try {
    resolved = opts?.resolveRedirect
      ? await opts.resolveRedirect(origin)
      : { redirectUri: `${origin}/oauth/callback` }
  } catch (error) {
    if (error instanceof OAuthCallbackUnavailableError && error.reason === 'incompatible') {
      return c.html(
        errPage(
          'The relay needs updating before a Quick Tunnel sign-in can return here (missing oauth-callback-v1).',
          { href: '/', label: 'Back' },
        ),
        503,
      )
    }
    if (error instanceof OAuthCallbackUnavailableError && error.reason === 'failed') {
      return c.html(
        errPage(
          'Remote sign-in could not register its return route. Restart the gateway and try again.',
          { href: '/', label: 'Back' },
        ),
        503,
      )
    }
    return c.html(
      errPage('Remote sign-in is still preparing its return route. Try again in a few seconds.'),
      503,
    )
  }
  // AH-23: discovery reaches out to the IdP over the network, same as the redirect resolution
  // above - it used to be unguarded, so a rejected fetch (or a malformed discovery document)
  // escaped as an uncaught throw and Hono turned it into a bare 500 instead of the gateway's own
  // bounded, retryable error page.
  let doc: Record<string, string>
  try {
    doc = await discover(oauth.issuer, opts?.fetchImpl ?? authFetch)
    if (!doc.authorization_endpoint)
      throw new Error('discovery document has no authorization_endpoint')
  } catch (error) {
    console.error(`[orchestrator-remote] OIDC discovery failed: ${String(error)}`)
    return c.html(
      errPage(
        'Could not reach Connections to start sign-in. This is usually temporary - try again in a few seconds.',
      ),
      502,
    )
  }
  const { verifier, challenge } = pkce()
  const nonce = randomBytes(16).toString('base64url')
  txs.set(nonce, { verifier, ts: Date.now() })
  gcTx()
  const state = sign(
    JSON.stringify({
      n: nonce,
      o: origin,
      d: resolved.redirectUri,
      ...(resolved.relayId ? { r: resolved.relayId } : {}),
    }),
    opts?.secret,
  )
  const url = new URL(doc.authorization_endpoint!)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', oauth.clientId)
  url.searchParams.set('redirect_uri', resolved.redirectUri)
  url.searchParams.set('scope', oauth.scopes || 'openid profile email photo')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return c.redirect(url.toString())
}

interface TokenSet {
  id_token?: string
  access_token?: string
}

async function fetchDisplayProfile(
  doc: { userinfo_endpoint?: string },
  tok: TokenSet,
  fallbackEmail: string,
  doFetch: FetchLike,
): Promise<{ name: string; displayEmail: string; picture: string }> {
  let name = ''
  let displayEmail = fallbackEmail
  let picture = ''
  if (tok.access_token && doc.userinfo_endpoint) {
    try {
      const ui = await doFetch(doc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tok.access_token}` },
      })
      if (ui.ok) {
        const u = (await ui.json()) as { email?: string; name?: string; picture?: string }
        if (u.name) name = u.name
        if (u.email) displayEmail = u.email
        if (u.picture) picture = u.picture
      }
    } catch {
      /* best-effort - the login proceeds with sub only */
    }
  }
  return { name, displayEmail, picture }
}

/** Parses the signed `state` payload's JSON body into the nonce + redirect URI it carries. */
function parseStatePayload(sp: string): { nonce: string; stateRedirectUri: string } | null {
  try {
    const parsed = JSON.parse(sp) as { n?: string; o?: string; d?: string }
    return {
      nonce: String(parsed.n ?? ''),
      stateRedirectUri: String(parsed.d || `${String(parsed.o ?? '')}/oauth/callback`),
    }
  } catch {
    return null
  }
}

type TokenExchangeResult =
  | { ok: true; token: TokenSet }
  | { ok: false; status: ContentfulStatusCode; message: string }

/** Exchanges the authorization code for tokens, reporting the OAuth failure shape on the way out. */
async function exchangeAuthorizationCode(
  oauth: OAuthConfig,
  doc: { token_endpoint?: string },
  code: string,
  redirectUri: string,
  verifier: string,
  doFetch: FetchLike,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: oauth.clientId,
    code_verifier: verifier,
  })
  if (oauth.clientSecret) body.set('client_secret', oauth.clientSecret)
  const tr = await doFetch(doc.token_endpoint!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!tr.ok) {
    // The status + OAuth error code ARE the diagnosis (invalid_client / invalid_grant /
    // redirect_uri_mismatch). Log the PARSED error fields, not the raw body: this log is a
    // file the operator is told to read and would plausibly paste to an agent, and "an OAuth
    // error body never contains a credential" is an assumption about someone else's server,
    // not something we enforce. Falling back to the status alone is a fine diagnosis.
    const raw = await tr.text().catch(() => '')
    let detail = ''
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; error_description?: unknown }
      detail = [parsed.error, parsed.error_description]
        .filter((x) => typeof x === 'string')
        .join(': ')
        .slice(0, 200)
    } catch {
      detail = ''
    }
    console.error(
      `[orchestrator-remote] token exchange failed: HTTP ${tr.status}${detail ? ` ${detail}` : ' (no parseable error field)'}`,
    )
    return { ok: false, status: 502, message: 'Token exchange with Connections failed.' }
  }
  const token = (await tr.json()) as TokenSet
  if (!token.id_token) {
    return { ok: false, status: 502, message: 'Connections returned no identity token.' }
  }
  return { ok: true, token }
}

type OwnershipResult =
  | { ok: true }
  | {
      ok: false
      status: ContentfulStatusCode
      message: string
      action?: { href: string; label: string }
    }

// ⛔ FIRST-USE OWNERSHIP IS CLAIMABLE FROM THE MACHINE ONLY, NEVER OVER THE TUNNEL.
//
// Plain TOFU is a takeover waiting to happen here: until someone claims the install, ANY
// verified Connections account that reaches the public hostname becomes the permanent owner
// - and the owner can arm this machine's fleet automation from a phone. /oauth/login sits
// outside the auth gate by necessity (a sign-in cannot require a session), so "nobody knows
// the URL yet" was the only thing standing between a stranger and the switch. A URL is not
// a secret: it is in DNS, in certificate-transparency logs, in browser history, in any link
// ever pasted. Found by audit, 2026-09-03, on this very install while it sat unclaimed.
//
// Claiming from loopback means being at the keyboard, which is the same standard the rest
// of this system uses for "a person's word". After the claim, remote sign-in works normally
// for that identity.
function resolveOwnership(
  c: Context,
  oauth: OAuthConfig,
  sub: string,
  email: string,
  opts?: HandleCompleteOptions,
): OwnershipResult {
  if (!oauth.ownerSub && !oauth.ownerEmail && sub) {
    if (refusesRemoteClaim(oauth, isRemoteRequest(c))) {
      console.warn(
        `[orchestrator-remote] REFUSED a remote ownership claim by ${email || sub}: this install is unclaimed and may only be claimed from the machine itself`,
      )
      return {
        ok: false,
        status: 403,
        message:
          'This orchestrator has no owner yet, and ownership can only be claimed at the machine itself — not over the tunnel. Sign in once on that computer (http://127.0.0.1:7790), then come back here.',
        action: { href: '/', label: 'Back' },
      }
    }
    oauth.ownerSub = sub
    opts?.onOwnerClaimed?.(oauth)
    console.log(`[orchestrator-remote] ownership claimed by ${email || sub} (local sign-in)`)
  }
  if (!ownerMatches(oauth, sub, email)) {
    return {
      ok: false,
      status: 403,
      message: "This Connections account isn't the owner of this orchestrator.",
    }
  }
  return { ok: true }
}

/** Shared by /oauth/finish (relay return) and /oauth/callback (direct completion). */
export async function handleComplete(
  c: Context,
  oauth: OAuthConfig,
  opts?: HandleCompleteOptions,
): Promise<Response> {
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.html(errPage('Missing authorization code.'), 400)

  const sp = unsign(state, opts?.secret)
  if (!sp) return c.html(errPage('Invalid or tampered sign-in state.'), 400)
  const parsedState = parseStatePayload(sp)
  if (!parsedState) return c.html(errPage('Invalid sign-in state.'), 400)
  const { nonce, stateRedirectUri } = parsedState
  const tx = txs.get(nonce)
  if (!tx) return c.html(errPage('This sign-in link expired. Start again.'), 400)
  txs.delete(nonce)

  const doFetch: FetchLike = opts?.fetchImpl ?? authFetch
  try {
    const doc = await discover(oauth.issuer, doFetch)
    const exchange = await exchangeAuthorizationCode(
      oauth,
      doc,
      code,
      stateRedirectUri,
      tx.verifier,
      doFetch,
    )
    if (!exchange.ok) return c.html(errPage(exchange.message), exchange.status)
    const tok = exchange.token

    const keySet = opts?.jwksSet ?? jwks(doc.jwks_uri!)
    const { payload } = await jwtVerify(tok.id_token!, keySet, {
      issuer: oauth.issuer.replace(/\/$/, ''),
      audience: oauth.clientId,
    })
    const sub = String(payload.sub ?? '')
    const email = String((payload as { email?: string }).email ?? '')

    const ownership = resolveOwnership(c, oauth, sub, email, opts)
    if (!ownership.ok) return c.html(errPage(ownership.message, ownership.action), ownership.status)

    const { name, displayEmail, picture } = await fetchDisplayProfile(doc, tok, email, doFetch)
    setSession(
      c,
      { sub, email: displayEmail, name, picture, exp: Date.now() + SESSION_TTL_MS },
      opts,
    )
    return c.redirect('/')
  } catch (err) {
    console.error(`[orchestrator-remote] sign-in could not be verified: ${String(err)}`)
    return c.html(errPage("Couldn't verify your Connections sign-in."), 401)
  }
}

export function handleLogout(c: Context): Response {
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
}

/** Rotate the signing key: every device's cookie stops verifying at once. */
export function handleLogoutAll(c: Context): Response {
  rotateKey()
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
}

/** Public probes the sign-in screen itself relies on; everything else over the tunnel needs the owner. */
const PUBLIC_PATHS = new Set(['/api/auth/status', '/api/auth/me', '/api/health'])

export function authMiddleware(cfg: RemoteConfig) {
  // biome-ignore lint/suspicious/noConfusingVoidType: pass-through branches return next()
  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    if (!authEnforced(cfg)) return next()
    const path = new URL(c.req.url).pathname
    if (PUBLIC_PATHS.has(path)) return next()
    if (isRemoteRequest(c)) {
      if (readSession(c, cfg.oauth!)) return next()
      return c.body(null, 401)
    }
    return next()
  }
}
