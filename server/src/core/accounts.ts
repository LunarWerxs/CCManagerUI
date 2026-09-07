// server/src/core/accounts.ts — instance-account identity resolution (PLAN.md §2).
// Adapted from an internal LunarWerx tool's instance-account resolver: imports DTOs/tier/
// constants from ./shared (local, no cross-repo import) instead of ../../../shared/index;
// the identity cache resolves via paths.ts's accountsCacheFile()/appDataDir(), which are
// now wired to THIS app's CONFIG_DIR (~/.agenthydra/instances-cache.json).
//
// Resolves which Anthropic account an isolated Claude Desktop **instance** is logged into —
// distinct from this app's own sqlite `accounts` table (Anthropic auth secrets for queue
// dispatch, see server/src/db.ts). Referred to as "instance account" throughout to keep the
// two concepts unambiguous; this module never touches the sqlite accounts table.
//
//   1. Cheap pre-check: <instanceDir>/config.json -> lastKnownAccountUuid (logged in at all?).
//   2. Decrypt oauth:tokenCacheV2 (fallback oauth:tokenCache) via ../crypto, parse the grants
//      map (key "<acctUuid>:<orgUuid>:https://api.anthropic.com:<scopes>"), pick the grant
//      with the max expiresAt, and pull the token/subscriptionType/rateLimitTier/uuids out.
//   3. If noNetwork / expired / no token -> resolve from our own local identity cache
//      (instances-cache.json under appDataDir()), overlaid with anything we did manage to
//      decrypt locally (uuid/orgUuid/plan/tier) even without a network call.
//   4. Otherwise call the profile endpoint, map the response, write identity ONLY (never the
//      token) back to the cache, and return a 'live' result.
//
// Nothing in this file throws for expected failure conditions (missing/corrupt config.json,
// locked files, decrypt failure, network/timeout/401, malformed profile JSON) — every path
// returns a CMAccount instead.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decryptSafeStorage } from './crypto/index'
import { accountsCacheFile, appDataDir, normalizeInstancePath } from './paths'
import type { CMAccount, CMAccountCacheEntry } from './shared'
import { OAUTH_BETA_HEADER, PROFILE_API_URL, prettyTier, resolvePlanLabel } from './shared'

// ----------------------------------------------------------------------------
// Small internal helpers (all defensive — never throw out of this module)
// ----------------------------------------------------------------------------

function log(_level: 'info' | 'warn' | 'error', _message: string): void {
  // Placeholder for a future shared logger; kept as a no-op call site so call sites below
  // don't need to change when server/src wires up real logging. Never throws.
  try {
    // Intentionally silent by default — avoid noisy stdout in a desktop app daemon.
  } catch {
    /* logging must never break the caller */
  }
}

/** `planLabel` — NOT the raw pretty tier. Passing the tier here leaked the unmapped generic value
 *  into the Quick view's one-liner ("Michael <blogitech@gmail.com> · default_claude_ai") for every
 *  account whose tier is `default_claude_ai`; the label must show what the Plan column shows. */
function buildLabel(name: string | null, email: string | null, planLabel: string | null): string {
  let namePart: string | null = null
  if (name && email) namePart = `${name} <${email}>`
  else if (name) namePart = name
  else if (email) namePart = email

  if (namePart && planLabel) return `${namePart} · ${planLabel}`
  if (namePart) return namePart
  if (planLabel) return planLabel
  return '(unknown account)'
}

function newAccount(partial: Partial<CMAccount> & { status: CMAccount['status'] }): CMAccount {
  const plan = partial.plan ?? null
  const rateLimitTier = partial.rateLimitTier ?? null
  const orgType = partial.orgType ?? null
  return {
    status: partial.status,
    email: partial.email ?? null,
    name: partial.name ?? null,
    plan,
    rateLimitTier,
    orgType,
    // Derived here, at the single construction point, so every account (live/cache/offline)
    // carries the same display-ready value and no view has to reconcile the signals itself.
    planLabel: partial.planLabel ?? resolvePlanLabel(plan, rateLimitTier, orgType),
    accountUuid: partial.accountUuid ?? null,
    orgUuid: partial.orgUuid ?? null,
    orgName: partial.orgName ?? null,
    source: partial.source ?? partial.status,
    label: partial.label ?? '(unknown account)',
  }
}

// ----------------------------------------------------------------------------
// Identity cache (instances-cache.json under appDataDir()) — identity ONLY, never tokens.
// ----------------------------------------------------------------------------

type AccountsCacheFile = Record<string, CMAccountCacheEntry>

function readAccountsCache(): AccountsCacheFile {
  try {
    const file = accountsCacheFile()
    if (!existsSync(file)) return {}
    const raw = readFileSync(file, 'utf8')
    if (!raw?.trim()) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as AccountsCacheFile
    return {}
  } catch (err) {
    log('warn', `readAccountsCache: failed to load instances-cache.json: ${String(err)}`)
    return {}
  }
}

function writeAccountsCacheEntry(instanceDir: string, entry: CMAccountCacheEntry): boolean {
  try {
    const dir = appDataDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const cache = readAccountsCache()
    const key = normalizeInstancePath(instanceDir)

    // Defensively strip anything beyond the identity-only shape (never persist a token here).
    const safeEntry: CMAccountCacheEntry = {
      email: entry.email ?? null,
      name: entry.name ?? null,
      plan: entry.plan ?? null,
      rateLimitTier: entry.rateLimitTier ?? null,
      uuid: entry.uuid ?? null,
      orgUuid: entry.orgUuid ?? null,
      orgName: entry.orgName ?? null,
      orgType: entry.orgType ?? null,
      resolvedAt: entry.resolvedAt ?? new Date().toISOString(),
    }

    cache[key] = safeEntry

    const file = accountsCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (err) {
    log(
      'error',
      `writeAccountsCacheEntry: failed to write cache entry for '${instanceDir}': ${String(err)}`,
    )
    return false
  }
}

/** Drops one instance's cached identity (used when it turns out to describe a different account
 *  than the instance is signed into now). Best-effort — never throws. */
export function deleteAccountsCacheEntry(instanceDir: string): void {
  try {
    const cache = readAccountsCache()
    const key = normalizeInstancePath(instanceDir)
    if (!(key in cache)) return
    delete cache[key]
    const file = accountsCacheFile()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    log('warn', `deleteAccountsCacheEntry: failed for '${instanceDir}': ${String(err)}`)
  }
}

function accountFromCache(
  instanceDir: string,
  opts: {
    /** The account the instance is signed into RIGHT NOW (config.json's lastKnownAccountUuid).
     *  A cached identity carrying a DIFFERENT uuid is a previous login — see the guard below. */
    currentUuid?: string | null
    fallbackUuid?: string | null
    fallbackOrgUuid?: string | null
    fallbackPlan?: string | null
    fallbackTier?: string | null
  } = {},
): CMAccount {
  let entry: CMAccountCacheEntry | undefined
  try {
    const cache = readAccountsCache()
    const key = normalizeInstancePath(instanceDir)
    entry = cache[key]
  } catch (err) {
    log('warn', `accountFromCache: failed reading cache for '${instanceDir}': ${String(err)}`)
  }

  // Stale-login guard. The cache is keyed by instance DIR, but identity belongs to an ACCOUNT —
  // sign an instance out and back in as someone else and the dir is unchanged while everything
  // in the entry (email, name, plan, org) now describes the previous account. Without this check
  // that entry survives every offline/noNetwork/expired-token resolve, so the manager keeps
  // confidently displaying an email the instance hasn't been logged into for weeks. Showing no
  // identity until we can resolve the new one is strictly better than showing the wrong one.
  if (entry && opts.currentUuid && entry.uuid && entry.uuid !== opts.currentUuid) {
    log(
      'info',
      `accountFromCache: cached identity for '${instanceDir}' belongs to a different account — discarding.`,
    )
    deleteAccountsCacheEntry(instanceDir)
    entry = undefined
  }

  // "cache" only when we actually have a cached identity; otherwise "offline" — we resolved
  // nothing but (possibly) some locally-decrypted uuid/tier fragments.
  const status: CMAccount['status'] = entry ? 'cache' : 'offline'

  const email = entry?.email ?? null
  const name = entry?.name ?? null
  const plan = entry?.plan ?? opts.fallbackPlan ?? null
  const rawTier = entry?.rateLimitTier ?? opts.fallbackTier ?? null
  const accountUuid = entry?.uuid ?? opts.fallbackUuid ?? null
  const orgUuid = entry?.orgUuid ?? opts.fallbackOrgUuid ?? null
  const orgName = entry?.orgName ?? null
  // Only the cache can carry organization_type offline — the token cache's grants have no such
  // field. Its absence (never resolved live, or an entry written before 2026-08-07) is exactly
  // when resolvePlanLabel falls back to the older tier/plan evidence.
  const orgType = entry?.orgType ?? null

  const tier = prettyTier(rawTier)
  const planLabel = resolvePlanLabel(plan, tier, orgType)
  const label = buildLabel(name, email, planLabel)

  return newAccount({
    status,
    email,
    name,
    plan,
    rateLimitTier: tier,
    orgType,
    planLabel,
    accountUuid,
    orgUuid,
    orgName,
    source: status,
    label,
  })
}

// ----------------------------------------------------------------------------
// Token-cache grant parsing
// ----------------------------------------------------------------------------

interface Grant {
  token: string | null
  expiresAt: number
  subscriptionType: string | null
  rateLimitTier: string | null
  /** First segment of the grant key. NOT the account uuid — it is the OAuth CLIENT id, and it is
   *  the same constant across every instance and every account (verified 2026-08-02 across 10
   *  local instances: the full/CLI client and the profile-only client). Kept only so the parse is
   *  self-documenting; identity must come from config.json's lastKnownAccountUuid or the profile
   *  API, never from here. */
  clientId: string | null
  orgUuid: string | null
}

interface RawGrantValue {
  expiresAt?: number | string
  subscriptionType?: string
  rateLimitTier?: string
  token?: string
  accessToken?: string
}

/** Picks the grant with the max expiresAt out of the decrypted token-cache JSON's grants map.
 *  Grant keys look like "<accountUuid>:<orgUuid>:https://api.anthropic.com:<scopes...>" — split
 *  into at most 4 pieces so scopes (which may contain further colons/spaces) stay intact as the
 *  last piece. Never throws — malformed entries are skipped. */
function pickBestGrant(decryptedJson: string): Grant | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decryptedJson)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null

  let best: Grant | null = null

  for (const [grantKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawValue || typeof rawValue !== 'object') continue
    const value = rawValue as RawGrantValue

    let expiresAt = 0
    try {
      expiresAt =
        typeof value.expiresAt === 'number'
          ? value.expiresAt
          : typeof value.expiresAt === 'string'
            ? Number.parseInt(value.expiresAt, 10) || 0
            : 0
    } catch {
      expiresAt = 0
    }

    if (!best || expiresAt > best.expiresAt) {
      best = buildGrant(grantKey, value, expiresAt)
    }
  }

  return best
}

/** Builds a Grant from one decrypted grant-map entry. See pickBestGrant for the grantKey shape. */
function buildGrant(grantKey: string, value: RawGrantValue, expiresAt: number): Grant {
  const parts = grantKey.split(':')
  // parts[0] = OAuth client id (NOT the account — see Grant.clientId), parts[1] = orgUuid,
  // remainder (rejoined) = "https://api...:<scopes>"
  const clientId = parts.length >= 1 ? (parts[0] ?? null) : null
  const orgUuid = parts.length >= 2 ? (parts[1] ?? null) : null

  let token: string | null = null
  try {
    token = typeof value.token === 'string' ? value.token : (value.accessToken ?? null)
  } catch {
    token = null
  }

  return {
    token,
    expiresAt,
    subscriptionType: typeof value.subscriptionType === 'string' ? value.subscriptionType : null,
    rateLimitTier: typeof value.rateLimitTier === 'string' ? value.rateLimitTier : null,
    clientId,
    orgUuid,
  }
}

// ----------------------------------------------------------------------------
// Profile API
// ----------------------------------------------------------------------------

interface ProfileResponse {
  account?: {
    email?: string
    full_name?: string
    uuid?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
  }
  organization?: {
    uuid?: string
    name?: string
    rate_limit_tier?: string
    /** "claude_free" | "claude_pro" | "claude_max" | "claude_team…" | "claude_enterprise…" —
     *  the authoritative, always-current plan family (see shared.ts resolvePlanLabel). */
    organization_type?: string
    /** "none" | "stripe_subscription" | "google_play_subscription" | … — corroborates
     *  organization_type; "none" only ever appeared alongside "claude_free" in the 11-account
     *  sample. Not used for the label; kept documented so the next reader doesn't re-derive it. */
    billing_type?: string
    /** NOT a paid/unpaid signal: an owner-confirmed active Pro account reports "canceled" here
     *  (cancelled but still inside its paid period, organization_type still "claude_pro"). */
    subscription_status?: string
  }
}

async function fetchProfile(token: string): Promise<ProfileResponse | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(PROFILE_API_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        log('warn', `fetchProfile: profile API responded ${res.status}`)
        return null
      }
      const json = (await res.json()) as ProfileResponse
      return json
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    // Covers network errors, DNS failure, timeout/abort, malformed JSON, etc.
    log('warn', `fetchProfile: request failed: ${String(err)}`)
    return null
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface ResolveAccountOptions {
  /** If set, never calls the profile API — always resolves from local decryption + our own
   *  cache only (`?noNetwork=1`). */
  noNetwork?: boolean
}

/**
 * Decrypt an isolated desktop instance's OWN OAuth access token from its safeStorage token cache.
 *
 * IN-PROCESS ONLY: the token is handed straight to the immediate caller (to inject into a
 * `claude -p "/usage"` probe) and is NEVER persisted, cached, logged, or sent to the browser — same
 * value-blind discipline resolveAccount keeps. Returns null when the instance is logged out, the
 * cache can't be decrypted, no token is present, or the token has expired; the caller then treats
 * usage as "not available", never "0%". Never throws.
 *
 * This is what lets a usage check work for ANY logged-in desktop instance with NO separate dispatch
 * account and NO CLI login: the desktop app's `sk-ant-oat…` OAuth token is a valid
 * CLAUDE_CODE_OAUTH_TOKEN (verified 2026-07-14 — it drives `claude -p "/usage"` directly).
 */

/** Of a decrypted token-cache's grants map, the max-expiresAt grant that carries `user:inference`
 *  scope — see resolveInstanceToken for why scope, not just expiry, decides the winner here. */
function pickBestInferenceGrant(
  parsed: Record<string, unknown>,
): { token: string; expiresAt: number; scopes: string } | null {
  let best: { token: string; expiresAt: number; scopes: string } | null = null
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (!/user:inference/.test(key)) continue // only the usage-capable CLI grant
    if (!rawValue || typeof rawValue !== 'object') continue
    const v = rawValue as RawGrantValue
    const token = typeof v.token === 'string' ? v.token : (v.accessToken ?? null)
    if (typeof token !== 'string' || !token.trim()) continue
    const exp = typeof v.expiresAt === 'number' ? v.expiresAt : Number(v.expiresAt) || 0
    // The grant key is "<acctUuid>:<orgUuid>:https://api.anthropic.com:<scopes>" — the scope
    // list must be passed to `claude` as CLAUDE_CODE_OAUTH_SCOPES or /usage silently degrades
    // (see DEFAULT_OAUTH_SCOPES in usage.ts).
    const scopes = key.split('https://api.anthropic.com:')[1]?.trim() ?? ''
    if (!best || exp > best.expiresAt) best = { token, expiresAt: exp, scopes }
  }
  return best
}

/** Load and decrypt an instance's stored token cache blob, or null on any failure along the way
 *  (missing config, unreadable/malformed JSON, no cache field, decrypt failure). Pulled out of
 *  resolveInstanceToken so the file-read/parse/decrypt chain isn't inline in the main function. */
async function loadDecryptedTokenCache(instanceDir: string): Promise<string | null> {
  const configPath = path.join(instanceDir, 'config.json')
  if (!existsSync(configPath)) return null

  let config: Record<string, unknown> | null = null
  try {
    const raw = readFileSync(configPath, 'utf8')
    if (raw?.trim()) config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!config) return null

  const b64 =
    typeof config['oauth:tokenCacheV2'] === 'string' && config['oauth:tokenCacheV2']
      ? (config['oauth:tokenCacheV2'] as string)
      : typeof config['oauth:tokenCache'] === 'string' && config['oauth:tokenCache']
        ? (config['oauth:tokenCache'] as string)
        : null
  if (!b64) return null

  try {
    return await decryptSafeStorage(b64, instanceDir)
  } catch {
    return null
  }
}

export async function resolveInstanceToken(
  instanceDir: string,
): Promise<{ token: string; scopes: string } | null> {
  try {
    if (!instanceDir?.trim()) return null
    const decrypted = await loadDecryptedTokenCache(instanceDir)
    if (!decrypted) return null

    // Pick the grant that can actually read usage: the desktop app keeps TWO grants — a full CLI
    // grant (scopes include `user:inference`) and a profile-only grant (`user:profile`). They have
    // independent, rotating expiries, so picking by max-expiresAt (pickBestGrant, used for identity)
    // often lands on the profile-only grant, whose token runs `claude -p "/usage"` with exit 0 but
    // returns NO percentage block (identity scope can't fetch usage). So select by SCOPE here:
    // require `user:inference`, then take the max-expiresAt among those. Verified 2026-07-14 — the
    // profile grant yields no numbers; the inference grant yields the real weekly/session %.
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(decrypted) as Record<string, unknown>
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null

    const best = pickBestInferenceGrant(parsed)
    if (!best) return null
    // Skip an expired token rather than fire a doomed probe (expiresAt is epoch ms).
    if (best.expiresAt > 0 && best.expiresAt < Date.now()) return null
    return { token: best.token, scopes: best.scopes }
  } catch {
    return null
  }
}

/**
 * Read the OAuth access token a CLI login stored in its `CLAUDE_CONFIG_DIR`.
 *
 * The CLI side of the world is much simpler than the desktop side: `claude` writes
 * `<configDir>/.credentials.json` as PLAIN JSON — `{ claudeAiOauth: { accessToken, scopes, expiresAt,
 * … } }` — with no safeStorage/DPAPI layer to unwrap (verified 2026-07-14). So a CLI instance that
 * the user has `/login`'d once gives us a usage-capable token for free.
 *
 * Same value-blind, IN-PROCESS-ONLY discipline as resolveInstanceToken above: the token goes
 * straight to the immediate caller and is never persisted, cached, logged, or sent to the browser.
 * Returns null when the dir was never logged in, the file is unreadable/corrupt, no token is
 * present, or the token has expired. Never throws.
 *
 * We do NOT attempt a refresh with the stored refresh token: rotating it would invalidate the
 * user's real CLI login out from under them. An expired token simply falls back to the CLI spawn,
 * which refreshes its own credentials properly.
 */
export function resolveCliConfigDirToken(
  configDir: string,
): { token: string; scopes: string } | null {
  try {
    if (!configDir?.trim()) return null
    const credPath = path.join(configDir, '.credentials.json')
    if (!existsSync(credPath)) return null
    const raw = readFileSync(credPath, 'utf8')
    if (!raw?.trim()) return null
    const parsed = JSON.parse(raw) as { claudeAiOauth?: RawGrantValue & { scopes?: unknown } }
    const oauth = parsed?.claudeAiOauth
    if (!oauth || typeof oauth !== 'object') return null

    const token = typeof oauth.accessToken === 'string' ? oauth.accessToken : null
    if (!token?.trim()) return null

    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
    if (expiresAt > 0 && expiresAt < Date.now()) return null

    // `scopes` is an array here (the desktop grant key packs them into a string); normalize to the
    // space-separated form CLAUDE_CODE_OAUTH_SCOPES wants.
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((s): s is string => typeof s === 'string').join(' ')
      : typeof oauth.scopes === 'string'
        ? oauth.scopes
        : ''
    // A profile-only login cannot read usage (same trap as the desktop profile grant) — refuse it
    // here rather than fire a probe that returns exit 0 and no numbers.
    if (!scopes.includes('user:inference')) return null
    return { token, scopes }
  } catch {
    return null
  }
}

// Shared fallback path for resolveAccount's Step 3 (no usable token) and Step 4 (the profile
// call itself failed) — both resolve identity from the cache/config, never from a live call.
function fallbackAccountFromCache(
  instanceDir: string,
  lastKnownAccountUuid: string,
  bestGrant: Grant | null,
) {
  return accountFromCache(instanceDir, {
    currentUuid: lastKnownAccountUuid,
    fallbackUuid: lastKnownAccountUuid,
    fallbackOrgUuid: bestGrant?.orgUuid ?? null,
    fallbackPlan: bestGrant?.subscriptionType ?? null,
    fallbackTier: bestGrant?.rateLimitTier ?? null,
  })
}

// resolveAccount's Step 1: the cheap pre-check. Pulled out so its try/catch scores against
// this small function instead of resolveAccount's — see fallbackAccountFromCache above.
function loadAccountConfig(instanceDir: string): {
  config: Record<string, unknown> | null
  lastKnownAccountUuid: string | null
} {
  const configPath = path.join(instanceDir, 'config.json')
  let config: Record<string, unknown> | null = null
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      if (raw?.trim()) config = JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      log(
        'warn',
        `resolveAccount: failed to read/parse config.json at '${configPath}': ${String(err)}`,
      )
      config = null
    }
  }
  const lastKnownAccountUuid =
    config && typeof config.lastKnownAccountUuid === 'string' ? config.lastKnownAccountUuid : null
  return { config, lastKnownAccountUuid }
}

// resolveAccount's Step 2: decrypt the token cache (v2, falling back to v1) and pick the best
// grant out of it. Pulled out, see loadAccountConfig above.
async function resolveBestGrant(
  config: Record<string, unknown>,
  instanceDir: string,
): Promise<Grant | null> {
  let tokenCacheB64: string | null = null
  let usedV1 = false
  if (typeof config['oauth:tokenCacheV2'] === 'string' && config['oauth:tokenCacheV2']) {
    tokenCacheB64 = config['oauth:tokenCacheV2'] as string
  } else if (typeof config['oauth:tokenCache'] === 'string' && config['oauth:tokenCache']) {
    tokenCacheB64 = config['oauth:tokenCache'] as string
    usedV1 = true
  }
  if (!tokenCacheB64) {
    log(
      'info',
      `resolveAccount: no oauth token cache (v1 or v2) present in config.json for '${instanceDir}'.`,
    )
    return null
  }
  try {
    const decrypted = await decryptSafeStorage(tokenCacheB64, instanceDir)
    if (!decrypted) {
      log(
        'warn',
        `resolveAccount: could not decrypt token cache (${usedV1 ? 'v1' : 'v2'}) for '${instanceDir}'.`,
      )
      return null
    }
    return pickBestGrant(decrypted)
  } catch (err) {
    log('warn', `resolveAccount: decryptSafeStorage threw for '${instanceDir}': ${String(err)}`)
    return null
  }
}

// resolveAccount's Step 4 field derivation: plan/tier/label from a successful profile call.
// Pulled out, see loadAccountConfig above.
function deriveAccountFields(
  profile: NonNullable<Awaited<ReturnType<typeof fetchProfile>>>,
  bestGrant: Grant | null,
  lastKnownAccountUuid: string,
) {
  const email = profile.account?.email ?? null
  const fullName = profile.account?.full_name ?? null
  const accountUuid = profile.account?.uuid ?? lastKnownAccountUuid
  const orgUuid = profile.organization?.uuid ?? bestGrant?.orgUuid ?? null
  const orgName = profile.organization?.name ?? null
  // The plan family, and the only signal that is actually current: Anthropic recomputes
  // organization_type on every profile call. Everything else here is either a mint-time snapshot
  // (the grant) or entitlement history (has_claude_max/pro).
  const orgType = profile.organization?.organization_type ?? null

  // Tier: the ORGANIZATION's rate_limit_tier — same freshness as organization_type. The grant's
  // copy is only a gap-filler now, because it is demonstrably stale in both directions: a free
  // account still carrying `default_claude_max_20x` grants is what produced the "Max 20×" row
  // this replaces, and two paid accounts carry `max_5x` grants while their org says `max_20x`
  // (measured 2026-08-07 across 11 accounts; see resolvePlanLabel). The tier now only refines a
  // Max family into 5×/20×, so a generic `default_claude_ai` here is harmless.
  const rawTier = profile.organization?.rate_limit_tier ?? bestGrant?.rateLimitTier ?? null

  // Plan: the GRANT's subscriptionType. Kept as the offline/legacy fallback and as a DTO field,
  // but it no longer decides the label whenever orgType is known. has_claude_max/pro are
  // entitlement HISTORY — they stay true for an account that lapsed back to free (owner-confirmed
  // 2026-07-22) — so they are consulted only when there is no grant to ask.
  let plan = bestGrant?.subscriptionType ?? null
  if (!plan) {
    if (profile.account?.has_claude_max) plan = 'max'
    else if (profile.account?.has_claude_pro) plan = 'pro'
  }

  const tier = prettyTier(rawTier)
  const planLabel = resolvePlanLabel(plan, tier, orgType)
  const label = buildLabel(fullName, email, planLabel)
  return {
    email,
    fullName,
    accountUuid,
    orgUuid,
    orgName,
    orgType,
    rawTier,
    plan,
    tier,
    planLabel,
    label,
  }
}

// Write identity ONLY (never the token) to the cache — and only when the identity we just
// resolved is the account config.json says this instance is signed into. Caching an identity
// that contradicts lastKnownAccountUuid would be immediately discarded by the stale-login guard
// in accountFromCache on the next offline read, so the entry would only ever churn. Pulled out,
// see loadAccountConfig above.
function maybeCacheAccountIdentity(
  instanceDir: string,
  lastKnownAccountUuid: string,
  fields: ReturnType<typeof deriveAccountFields>,
): void {
  const { accountUuid, email, fullName, plan, rawTier, orgUuid, orgName, orgType } = fields
  if (!accountUuid || !lastKnownAccountUuid || accountUuid === lastKnownAccountUuid) {
    writeAccountsCacheEntry(instanceDir, {
      email,
      name: fullName,
      plan,
      rateLimitTier: rawTier,
      uuid: accountUuid,
      orgUuid,
      orgName,
      orgType,
      resolvedAt: new Date().toISOString(),
    })
  } else {
    log(
      'warn',
      `resolveAccount: profile identity (${accountUuid}) disagrees with config.json's lastKnownAccountUuid (${lastKnownAccountUuid}) for '${instanceDir}' — not caching.`,
    )
  }
}

/**
 * Resolves the real account identity (email/name/plan/rate-limit tier) that an isolated
 * Claude Desktop instance is logged into, with graceful offline/cache fallback. Never throws.
 */
export async function resolveAccount(
  instanceDir: string,
  options: ResolveAccountOptions = {},
): Promise<CMAccount> {
  try {
    if (!instanceDir?.trim()) {
      log('warn', 'resolveAccount: instanceDir is null/empty.')
      return newAccount({ status: 'unknown', label: '(not logged in / unreadable)' })
    }

    const { config, lastKnownAccountUuid } = loadAccountConfig(instanceDir)
    if (!config || !lastKnownAccountUuid) {
      log(
        'info',
        `resolveAccount: no config.json / lastKnownAccountUuid for '${instanceDir}' — logged out.`,
      )
      return newAccount({ status: 'loggedout', label: '(not logged in)' })
    }

    // noNetwork resolves BEFORE any token-cache decrypt: an observation read (the fleet polls
    // this once per instance) must not pay an OS-level safeStorage decrypt per call - found by
    // adversarial review of the first fleet-identity cut, where 18 instances paid it on every
    // /api/fleet read. The grant only feeds last-resort fallback fields (org/plan/tier) that
    // the identity cache normally supplies; a never-cached instance shows nulls until a live
    // resolve fills the cache, which is honest rather than expensive.
    if (options.noNetwork) {
      log(
        'info',
        `resolveAccount: resolving '${instanceDir}' from cache/offline (noNetwork requested).`,
      )
      return fallbackAccountFromCache(instanceDir, lastKnownAccountUuid, null)
    }

    const bestGrant = await resolveBestGrant(config, instanceDir)

    // ---- decide whether to go live or fall back ----------------------------------
    const nowMs = Date.now()
    const expiresAt = bestGrant?.expiresAt ?? 0
    const expired = expiresAt <= 0 || expiresAt < nowMs
    const token = bestGrant?.token ?? null
    const haveToken = Boolean(token?.trim())

    if (!haveToken || expired) {
      const reason = !haveToken ? 'no usable access token decrypted' : 'access token expired'
      log('info', `resolveAccount: resolving '${instanceDir}' from cache/offline (${reason}).`)
      return fallbackAccountFromCache(instanceDir, lastKnownAccountUuid, bestGrant)
    }

    // ---- live profile call --------------------------------------------------------
    const profile = await fetchProfile(token as string)
    // Token was only ever held in this local `token`/`bestGrant` binding; nothing persists it.

    if (!profile) {
      log('warn', `resolveAccount: profile API call failed for '${instanceDir}'.`)
      return fallbackAccountFromCache(instanceDir, lastKnownAccountUuid, bestGrant)
    }

    const fields = deriveAccountFields(profile, bestGrant, lastKnownAccountUuid)
    maybeCacheAccountIdentity(instanceDir, lastKnownAccountUuid, fields)
    log('info', `resolveAccount: resolved '${instanceDir}' live -> ${fields.label}`)

    return newAccount({
      status: 'live',
      email: fields.email,
      name: fields.fullName,
      plan: fields.plan,
      rateLimitTier: fields.tier,
      orgType: fields.orgType,
      planLabel: fields.planLabel,
      accountUuid: fields.accountUuid,
      orgUuid: fields.orgUuid,
      orgName: fields.orgName,
      source: 'live',
      label: fields.label,
    })
  } catch (err) {
    log('error', `resolveAccount: unexpected error for '${instanceDir}': ${String(err)}`)
    return newAccount({ status: 'unknown', label: '(not logged in / unreadable)' })
  }
}
