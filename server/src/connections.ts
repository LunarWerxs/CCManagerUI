// ---------------------------------------------------------------------------
// "Sync my settings with Connections" — the daemon-side Backend-for-Frontend.
//
// AgentHydra is a single-user local daemon, so the daemon IS the BFF: it runs the
// OIDC login (Authorization Code + PKCE, public client — no secret), holds the
// owner's refresh token server-side, mints access tokens, and calls the Connections
// settings-sync store (studio.connections.icu/v1/app-data/{clientId}). The browser
// never holds a token.
//
// Mirrors DevWebUI's server/src/connections.ts (the family-standard shape) adapted to
// agenthydra's SQLite settings table (server/src/db.ts) instead of a separate JSON
// state file — the sync state (SDK session + sync prefs) rides one settings row,
// serialized as JSON, alongside every other agenthydra setting.
//
// The OAuth/refresh/identity machinery is the official SDK — @cnct/connect (the data
// locker store ships from the same package now): single-flight rotation-safe refresh,
// per-attempt redirect_uri, server-side revoke on forget, and id_token identity all come
// from the shared package. This module keeps only the agenthydra-specific parts: the
// settings-row persistence seam, the settings allowlist, and the sync plumbing.
//
// Because agenthydra is loopback-only (no tunnel / remote mode), there is NO auth gate
// and NO session cookie: "signed in" simply means the daemon holds a refresh token.
//
// Off by default: with sync disabled (the default), nothing here runs. What syncs is a
// small ALLOWLIST of portable scheduler prefs (PREF_KEYS) + the web's appearance blob
// (theme). Never machine-specific settings (portable_mode, hide_tray_icon) and never secrets.
//
// @cnct/connect is a regular dependency here (server/package.json) — dynamically imported
// below anyway, so a boot with sync untouched never pays for the SDK.
// ---------------------------------------------------------------------------
import type {
  ConnectClient,
  ConnectStore,
  SettingsSync,
  SettingsSyncStatus,
  TokenSet,
} from '@cnct/connect'
import { getSetting, setSetting } from './db'
import { unseal, wrapTokenStore } from './dpapi-seal.mjs'
import type { SyncStatus } from './types'

/** AgentHydra's own public "Sign in with Connections" OAuth client (PKCE — no secret).
 *  Its client_id doubles as the settings-sync store `appId`, so agenthydra's synced data
 *  is namespaced to itself. Self-registered once via @cnct/connect's registerApp() (RFC 7591
 *  dynamic client registration — no console needed); safe to embed (public client). */
const OAUTH = {
  issuer: 'https://accounts.connections.icu',
  clientId: '9ea648d3125f59743f7e1f651108bb42',
  scopes: ['openid', 'profile', 'email'],
}

/**
 * The ONLY settings keys that sync — portable preferences.
 *
 * Widened 2026-08-25 from four scheduler keys to thirty-odd. The old list was not a considered
 * boundary so much as the four keys that existed when it was written; everything added since
 * defaulted to not-synced without anyone deciding, which is why a user's notification setup,
 * display choices and every tuning threshold had to be re-entered per machine.
 *
 * The line that DID survive is in [`NEVER_SYNCED`]: secrets, this machine's identity, anything
 * naming a local path, and any switch that makes the app act on its own while nobody is watching.
 */
export const PREF_KEYS = [
  // Scheduler (the original four).
  'scheduler_enabled',
  'spacing_seconds',
  'poll_seconds',
  'max_concurrent',
  'tomorrow_time',
  // How you like the app to present itself. The old comment called these "machine-specific";
  // they are not — "don't show me a tray icon" is a preference about you, not about the PC.
  'portable_mode',
  'hide_tray_icon',
  'show_cli_instances',
  'show_desktop_instances',
  'usage_auto_refresh',
  'usage_refresh_interval_min',
  // Auto-resume monitor: its TUNING travels, its master switch does not (see NEVER_SYNCED).
  'monitor_max_attempts',
  'monitor_resume_buffer_min',
  // Keepalive TUNING travels while its master switch does not — the same split as the monitor
  // above. "Leave an account alone above 80% weekly" is a judgement about how you like to work.
  'keepalive_weekly_floor',
  // New-chat defaults (owner rule 2026-08-30: every automated new chat starts "Opus 5 Ultra
  // code" = model opus + the ultracode keyword). A doctrine about how chats start, identical
  // on every machine - it travels.
  'new_chat_model',
  'new_chat_ultracode',
  'monitor_resume_prompt',
  // Notifications, including the SMTP endpoint — but never its password, which lives in
  // NEVER_SYNCED. Telling you something is not the same as acting for you, so unlike the
  // unattended switches below these travel: a notification setup is tedious to re-enter and
  // useless until it is complete.
  'notify_enabled',
  'notify_desktop',
  'notify_persistent',
  'notify_min_pct',
  'notify_session_reset',
  'notify_weekly_reset',
  // Found by the classification guard below rather than by reading the file — which is the
  // whole argument for having it.
  'notify_persistent_interval_min',
  'notify_persistent_max_repeats',
  'notify_session_max_weekly_pct',
  'notify_email',
  'notify_email_from',
  'notify_email_to',
  'notify_smtp_host',
  'notify_smtp_port',
  'notify_smtp_secure',
  'notify_smtp_user',
] as const

/**
 * Every settings key that deliberately does NOT sync, with the reason it doesn't.
 *
 * Together with [`PREF_KEYS`] this must cover every key the app reads or writes;
 * `tests/connections-sync.test.ts` scans the source and fails naming any key that is in neither.
 * That check is the point of the list: a settings table keyed by plain strings has no type to
 * catch a new key, so without it "not synced" stays the silent default forever.
 */
export const NEVER_SYNCED = [
  // The sync state blob itself. Syncing it would be circular.
  'connections_sync',
  // A secret.
  'notify_smtp_pass',
  // This install's identity. Syncing would merge two machines into one in the ping counts.
  'app_install_id',
  'app_ping_reported',
  // '' means auto-detect; anything else is an ABSOLUTE PATH to an editor on this machine.
  'transcript_editor',
  // Which providers exist HERE. A laptop without the Codex desktop app should not be told it has
  // one because the desktop does.
  'provider_chatgpt_handoff',
  'provider_codex_cli',
  'provider_codex_desktop',
  // Unattended-action master switches. Both are off by default for the reason their own comments
  // in db.ts give — one auto-prompts your sessions while you sleep, the other reads everything
  // you are doing on a timer — and neither should turn itself on somewhere just because you
  // signed in there.
  //
  // `scheduler_enabled` is the honest exception: it is arguably the same kind of switch, and it
  // has been in PREF_KEYS since the day this file was written. It is left there deliberately
  // rather than quietly narrowed, because taking away sync someone already relies on is its own
  // surprise. Worth an explicit decision rather than a drive-by one.
  'monitor_enabled',
  // The 5-hour keepalive's master switch. The clearest case this list has: it SPENDS QUOTA on idle
  // accounts with nobody watching, and the accounts on one machine are not the accounts on another.
  // Turning it on here must never turn it on somewhere its owner has not looked.
  'keepalive_enabled',
  // Whether consoles appear on THIS screen. About this machine's desktop, not about a person.
  'terminal_windows_visible',
  // Whether this install has already said it has no tray icon. A fact about THIS COPY's packaging
  // (single-file .exe vs the .zip that carries misc\), not a preference about a person. Syncing it
  // would let a machine running the .zip silence the notice on a machine running the .exe, which
  // is the one place it actually needed to be said.
  'no_tray_build_notified',
] as const

// ── persisted state (db.ts settings table, key = 'connections_sync', JSON-serialized) ──────────
const SETTINGS_KEY = 'connections_sync'

interface ConnState {
  enabled?: boolean
  lastSyncedAt?: string
  version?: number
  appearance?: Record<string, unknown>
  identity?: { sub: string; email: string; name?: string; picture?: string }
  /** The @cnct/connect session entries (token set + in-flight PKCE), keyed by the SDK. */
  sdk?: Record<string, string>
}

let state: ConnState = {}
let loaded = false

function persist(): void {
  setSetting(SETTINGS_KEY, JSON.stringify(state))
}

// The SDK's persistence rides THIS module's state blob (one settings row for everything), via a
// ConnectStore adapter over the in-memory `state` — every set/remove goes through persist().
const stateStore: ConnectStore = {
  get: (key) => state.sdk?.[key] ?? null,
  set: (key, value) => {
    state.sdk ??= {}
    state.sdk[key] = value
    persist()
  },
  remove: (key) => {
    if (state.sdk && key in state.sdk) {
      delete state.sdk[key]
      persist()
    }
  },
}

/** Thrown when a sync/sign-in op is attempted but @cnct/connect never resolved. Surfaces
 *  as a normal guardSync error, not a boot crash. */
class SdkUnavailableError extends Error {
  code = 'sdk_unavailable'
  constructor(pkg: string, cause: unknown) {
    super(`${pkg} is not installed — Connections cloud sync is unavailable`)
    this.name = 'SdkUnavailableError'
    this.cause = cause
  }
}

let connectClient: ConnectClient | null = null
/** The lazily-built SDK client (after initConnections loads the persisted state). Dynamically
 *  imports @cnct/connect — never pulled in on a boot where sync is untouched. The constructor
 *  redirectUri is a placeholder — every real sign-in passes the live origin per attempt. */
async function connect(): Promise<ConnectClient> {
  if (connectClient) return connectClient
  let createConnect: typeof import('@cnct/connect').createConnect
  try {
    ;({ createConnect } = await import('@cnct/connect'))
  } catch (e) {
    throw new SdkUnavailableError('@cnct/connect', e)
  }
  connectClient = createConnect({
    clientId: OAUTH.clientId,
    issuer: OAUTH.issuer,
    scopes: OAUTH.scopes,
    redirectUri: 'http://127.0.0.1/oauth/callback',
    // Wrap the store so the persisted TokenSet (the durable refresh token) is DPAPI-sealed at
    // rest on Windows; the transient PKCE record and non-Windows hosts pass through unchanged.
    store: wrapTokenStore(stateStore, TOKEN_KEY),
    // Late-bound so a test harness's globalThis.fetch stub is honored even though the
    // client is memoized across calls (the SDK captures `fetch` at construction). Cast:
    // the SDK only CALLS it; Bun's `typeof fetch` also declares a `preconnect` member.
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
  })
  return connectClient
}

const TOKEN_KEY = `cnx.connect.tokens.${OAUTH.clientId}`

/** Load persisted sync state (incl. the credential) into memory. Call once at daemon boot. */
export function initConnections(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = getSetting(SETTINGS_KEY)
    state = raw ? (JSON.parse(raw) as ConnState) : {}
  } catch {
    state = {}
  }
}

/** True when the daemon holds a Connections credential (the owner has signed in). Synchronous —
 *  reads the SDK's token entry straight from the in-memory state. */
export function hasConnection(): boolean {
  const raw = state.sdk?.[TOKEN_KEY]
  if (!raw) return false
  const plain = unseal(raw) // DPAPI-sealed at rest → decrypt; legacy plaintext passes through
  if (!plain) return false
  try {
    const tokens = JSON.parse(plain) as TokenSet
    return Boolean(tokens.refreshToken || tokens.accessToken)
  } catch {
    return false
  }
}

/** Build the authorize URL for a sign-in that redirects back to `${origin}/oauth/callback`.
 *  The live loopback origin rides the SDK's per-attempt redirectUri override (the daemon may be
 *  reached as localhost, 127.0.0.1, or ::1). */
export async function buildAuthorizeUrl(origin: string): Promise<string> {
  const client = await connect()
  return client.signIn({ redirect: false, redirectUri: `${origin}/oauth/callback` })
}

/** Complete the OIDC callback: exchange the code, persist the session, capture identity. */
export async function handleCallback(
  origin: string,
  code: string,
  stateTok: string,
): Promise<boolean> {
  try {
    const callbackUrl = `${origin}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateTok)}`
    const client = await connect()
    const user = await client.handleCallback(callbackUrl)
    state.identity = {
      sub: user.sub,
      email: user.email ?? '',
      name: user.name ?? '',
      picture: user.picture ?? '',
    }
    persist()
    return true
  } catch {
    return false
  }
}

/** Backfill display identity (name/picture) for sessions created before those fields existed —
 *  best-effort, only when something is missing, piggybacking on calls that already network. */
async function backfillIdentity(): Promise<void> {
  if (state.identity?.name && state.identity?.picture) return
  try {
    const client = await connect()
    const user = await client.getUser()
    state.identity = {
      sub: user.sub,
      email: user.email ?? '',
      name: user.name ?? '',
      picture: user.picture ?? '',
    }
    persist()
  } catch {
    /* identity is best-effort; syncing works without it */
  }
}

// ── settings mapping (the allowlist) ─────────────────────────────────────────────
function collectPrefs(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PREF_KEYS) out[k] = getSetting(k)
  return out
}

/** Apply an allowlisted prefs blob onto the settings table. Ignores any key not on the
 *  allowlist, so a doc written by a newer/older app version can never inject arbitrary settings. */
function applyPrefs(prefs: Record<string, unknown> | undefined): boolean {
  if (!prefs || typeof prefs !== 'object') return false
  let applied = false
  for (const k of PREF_KEYS) {
    if (k in prefs && typeof prefs[k] === 'string') {
      setSetting(k, prefs[k] as string)
      applied = true
    }
  }
  return applied
}

// ── public sync API ───────────────────────────────────────────────────────────────
// SyncStatus (the status DTO every settings-sync endpoint returns) lives in ./types.ts so
// the web app can import it without pulling this Bun-only module into vue-tsc.

export function syncStatus(): SyncStatus {
  return {
    ok: true,
    enabled: state.enabled === true,
    connected: hasConnection(),
    name: state.identity?.name || null,
    email: state.identity?.email || null,
    picture: state.identity?.picture || null,
    lastSyncedAt: state.lastSyncedAt ?? null,
    version: state.version ?? 0,
    appearance: state.appearance ?? null,
  }
}

let settingsSync: SettingsSync | null = null
let lastApplied = false

function recordEngineStatus(status: SettingsSyncStatus): void {
  if (status.version !== null) state.version = status.version
  if (status.lastSyncedAt !== null) {
    state.lastSyncedAt = new Date(status.lastSyncedAt).toISOString()
  }
  if (status.version !== null || status.lastSyncedAt !== null) persist()
}

async function syncEngine(): Promise<SettingsSync> {
  if (settingsSync) return settingsSync
  let createSettingsSync: typeof import('@cnct/connect').createSettingsSync
  try {
    ;({ createSettingsSync } = await import('@cnct/connect'))
  } catch (e) {
    throw new SdkUnavailableError('@cnct/connect', e)
  }
  const client = await connect()
  settingsSync = createSettingsSync(client.locker(), {
    // Preserve the established document shape for existing users.
    keys: ['prefs', 'appearance'],
    read: () => ({
      prefs: collectPrefs(),
      ...(state.appearance ? { appearance: state.appearance } : {}),
    }),
    write: (patch) => {
      lastApplied = applyPrefs(
        patch.prefs && typeof patch.prefs === 'object'
          ? (patch.prefs as Record<string, unknown>)
          : undefined,
      )
      if (patch.appearance && typeof patch.appearance === 'object') {
        state.appearance = patch.appearance as Record<string, unknown>
      }
      persist()
    },
    onStatus: recordEngineStatus,
  })
  return settingsSync
}

function requireSuccess(status: SettingsSyncStatus): SettingsSyncStatus {
  if (status.state === 'synced') return status
  if (status.state === 'signed-out') {
    const error = new Error('not_signed_in') as Error & { code?: string }
    error.code = 'not_signed_in'
    throw error
  }
  throw status.error ?? new Error(`settings sync ended in ${status.state}`)
}

/** Flush the current allowlisted settings immediately. */
export async function pushNow(): Promise<void> {
  requireSuccess(await (await syncEngine()).flush())
  await backfillIdentity()
}

/** Pull remote settings and apply the allowlisted subset. Returns whether anything was applied. */
export async function pullNow(): Promise<{ applied: boolean; version: number }> {
  lastApplied = false
  const status = requireSuccess(await (await syncEngine()).pull())
  await backfillIdentity()
  return { applied: lastApplied, version: status.version ?? 0 }
}

/** Turn sync on: pull the remote doc (applying it) or seed the store from local if it's empty. */
export async function enable(
  appearance?: Record<string, unknown>,
): Promise<{ status: SyncStatus; applied: boolean }> {
  state.enabled = true
  if (appearance) state.appearance = appearance
  persist()
  let applied = false
  if (hasConnection()) {
    lastApplied = false
    requireSuccess(await (await syncEngine()).hydrate({ seedIfEmpty: true }))
    applied = lastApplied
    await backfillIdentity()
  }
  return { status: syncStatus(), applied }
}

/** Turn sync off. `forget` also disconnects — deletes the remote document, REVOKES the grant
 *  server-side (RFC 7009, so the refresh-token family is dead everywhere), and clears the session. */
export async function disable(forget = false): Promise<SyncStatus> {
  state.enabled = false
  settingsSync?.stop()
  if (forget) {
    if (hasConnection()) {
      try {
        await (settingsSync ?? (await syncEngine())).locker.delete()
      } catch {
        /* best-effort remote wipe */
      }
      try {
        const client = await connect()
        await client.signOut({ revoke: true })
      } catch {
        /* best-effort revoke — the local credential is cleared below regardless */
      }
    }
    state.identity = undefined
    state.appearance = undefined
    state.version = 0
    state.lastSyncedAt = undefined
    state.sdk = undefined
  }
  settingsSync = null
  persist()
  return syncStatus()
}

/** The web changed appearance; the SDK engine owns debounce/coalescing. */
export async function updateAppearance(appearance: Record<string, unknown>): Promise<void> {
  state.appearance = appearance
  persist()
  if (state.enabled && hasConnection()) (await syncEngine()).push()
}

/** Flush a pending debounce before daemon exit/relaunch. */
export async function flushPending(): Promise<void> {
  if (state.enabled && hasConnection()) {
    requireSuccess(await (await syncEngine()).flushAndStop({ timeoutMs: 5_000 }))
    await backfillIdentity()
  }
}

/** Sign out / disconnect fully (used by the logout route). */
export async function logout(): Promise<void> {
  await disable(true)
}
