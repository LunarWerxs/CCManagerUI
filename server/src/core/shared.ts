// server/src/core/shared.ts — DTO types + tier helper + constants for the multi-instance
// backend, adapted from an internal LunarWerx tool's `shared/` (dto.ts, tiers.ts,
// constants.ts) so `server/src/core/*` has no cross-repo imports (PLAN.md §2).
//
// NAMING: these "instance account" types describe which Anthropic account a Claude Desktop
// **instance** is logged into (resolved by decrypting its local safeStorage token cache) —
// this is a DIFFERENT concept from this app's own sqlite `accounts` table (Anthropic auth
// secrets used for queue dispatch, see server/src/db.ts / server/src/types.ts `Account`).
// Do not conflate the two; do not touch the sqlite `accounts` table from this module.

// ----------------------------------------------------------------------------
// Constants (from the internal tool's shared/constants.ts) — only the pieces core/* needs.
// ----------------------------------------------------------------------------

/** Instances live under `~/.claude-instances/<name>` on every OS. */
export const INSTANCES_DIR_NAME = '.claude-instances'

/** The default (non-isolated) Claude Desktop profile dir name — never deletable. */
export const DEFAULT_CLAUDE_DIR_NAME = 'Claude'

export const PROFILE_API_URL = 'https://api.anthropic.com/api/oauth/profile'

export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

// ----------------------------------------------------------------------------
// Tier helper (from the internal tool's shared/tiers.ts, verbatim behavior).
// ----------------------------------------------------------------------------

const KNOWN_TIERS: Record<string, string> = {
  default_claude_max_20x: 'Max 20×',
  default_claude_max_5x: 'Max 5×',
  default_claude_max: 'Max',
  default_claude_pro: 'Pro',
  default_claude_free: 'Free',
}

/** Maps a raw rate-limit tier string (e.g. "default_claude_max_20x") to a friendly display
 *  label (e.g. "Max 20×"). Returns the raw string unchanged if unrecognized, and passes
 *  through null/empty/whitespace-only input as-is. Never throws. */
export function prettyTier(tier: string | null | undefined): string | null {
  if (tier == null) return tier ?? null
  if (tier.trim() === '') return tier

  try {
    const known = KNOWN_TIERS[tier]
    if (known) return known

    if (/^default_claude_team/.test(tier)) return 'Team'
    if (/^default_claude_enterprise/.test(tier)) return 'Enterprise'

    const maxN = tier.match(/^default_claude_max_(\d+)x$/)
    if (maxN) return `Max ${maxN[1]}×`

    return tier
  } catch {
    return tier
  }
}

/**
 * The account's plan / "type" as one display-ready label ("Max 20×" | "Pro" | "Free" | …), or
 * null when it genuinely can't be determined.
 *
 * Evidence, strongest first:
 *
 * 1. `orgType` — the profile API's `organization.organization_type` ("claude_free" | "claude_pro" |
 *    "claude_max" | "claude_team…" | "claude_enterprise…"). Anthropic computes it server-side on
 *    every profile call, so it is the ONLY signal here that is current. It settles the plan FAMILY
 *    outright; nothing below may upgrade or downgrade it.
 * 2. `prettyTierLabel` — the rate-limit tier. Used to add 5×/20× granularity on top of a `claude_max`
 *    family, and, when no orgType is known at all (offline / a cache entry written before this
 *    field existed), as the legacy primary evidence.
 * 3. `plan` — the OAuth grant's `subscriptionType`. Legacy/offline evidence only.
 * 4. Nothing → null, and the column renders "—".
 *
 * WHY THE GRANT IS NOT THE AUTHORITY (fixed 2026-08-07, replacing the 2026-08-06 order). Both grant
 * fields are a snapshot taken when that grant was minted; they do NOT track the subscription
 * afterwards, and an unexpired grant is no evidence that they are fresh. Measured across 11 local
 * accounts by decrypting every token cache and diffing it against the live profile:
 *
 *   - lunawerx@gmail.com is `organization_type: "claude_free"`, `billing_type: "none"`,
 *     `has_claude_max: false` — and all THREE of its unexpired grants still say
 *     `subscriptionType: "max"` / `rateLimitTier: "default_claude_max_20x"`. Preferring the grant
 *     therefore rendered "Max 20×" for a free account (owner-reported).
 *   - Two paid accounts (2claude, temp1) carry a grant tier of `default_claude_max_5x` while their
 *     org reports `default_claude_max_20x`. So the grant is stale in BOTH directions, and its
 *     apparent 5×/20× "granularity" was granularity about the past.
 *
 * WHY A GENERIC TIER IS STILL NOT PROOF OF "FREE" (2026-08-06 finding, kept). An actively-paid Pro
 * account (`organization_type: "claude_pro"`, `has_claude_pro: true`) reports
 * `rate_limit_tier: "default_claude_ai"`. A generic tier means "this signal knows nothing" — which
 * is now moot whenever orgType is present, and still handled by the fall-through when it isn't.
 *
 * The 2026-07-22 finding also stands: `has_claude_max` / `has_claude_pro` stay `true` for an account
 * that was paid and has since lapsed, so they are entitlement history and accounts.ts consults them
 * only when there is nothing better.
 *
 * Never returns a raw `default_*` or `claude_*` string; returns null (callers render "—") when
 * nothing is known.
 */
export function resolvePlanLabel(
  plan: string | null,
  prettyTierLabel: string | null,
  orgType?: string | null,
): string | null {
  // A tier that still looks like a raw `default_claude*` string is an unmapped passthrough, i.e.
  // the generic "no plan to describe here" value — not a usable answer.
  const specificTier =
    prettyTierLabel && !/^default_claude/i.test(prettyTierLabel) ? prettyTierLabel : null

  // 1. organization_type: current by construction, and therefore final for the plan family.
  const org = orgType?.trim().toLowerCase()
  if (org) {
    if (org.includes('free')) return 'Free'
    if (org.includes('enterprise')) return 'Enterprise'
    if (org.includes('team')) return 'Team'
    // Only the tier carries 5×/20×, and only a Max-shaped tier may refine a Max family.
    if (org.includes('max')) return specificTier?.startsWith('Max') ? specificTier : 'Max'
    if (org.includes('pro')) return 'Pro'
    // An organization_type we don't recognize (a new plan family): fall through to the weaker
    // evidence below rather than guess, and never render the raw `claude_*` string.
  }

  // 2. No usable organization_type — offline, or a cache entry predating the field. This is the
  //    pre-2026-08-07 evidence order, kept verbatim for that path.
  if (specificTier) return specificTier
  const p = plan?.toLowerCase()
  if (p) {
    if (p.includes('max')) return 'Max'
    if (p.includes('pro')) return 'Pro'
    if (p.includes('free')) return 'Free'
    return plan // some other subscriptionType passthrough (already not a raw default_*)
  }
  // A generic tier with NO subscription evidence behind it is the genuine free/default account:
  // that is exactly what Anthropic reports when there is no paid plan to describe.
  if (prettyTierLabel) return 'Free'
  return null
}

// ----------------------------------------------------------------------------
// DTO shapes (from the internal tool's shared/dto.ts) — instance + instance-account only.
// ----------------------------------------------------------------------------

/** Curated glyph set for the per-instance icon (which replaces the plain status dot in the
 *  UI). These string keys are the single source of truth; the web app maps each one to a
 *  Lucide component in web/src/lib/instance-appearance.ts. */
export const INSTANCE_ICON_KEYS = [
  'box',
  'boxes',
  'terminal',
  'rocket',
  'star',
  'heart',
  'flame',
  'zap',
  'ghost',
  'cat',
  'bot',
  'cpu',
  'folder',
  'globe',
  'flask',
  'sparkles',
] as const
export type InstanceIconKey = (typeof INSTANCE_ICON_KEYS)[number]

/** Curated color palette for the per-instance icon. Keys map to fixed oklch values (chosen to
 *  read on both light and dark backgrounds) in web/src/lib/instance-appearance.ts. */
export const INSTANCE_COLOR_KEYS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const
export type InstanceColorKey = (typeof INSTANCE_COLOR_KEYS)[number]

/** Max length of an instance display label (see instance-meta.ts). */
export const INSTANCE_LABEL_MAX = 60

/** Status of an instance-account resolution attempt. */
export type CMAccountStatus = 'live' | 'cache' | 'offline' | 'loggedout' | 'unknown'

/** Resolved identity for a single isolated Claude Desktop instance. Never carries a token. */
export interface CMAccount {
  status: CMAccountStatus
  email: string | null
  name: string | null
  /** Normalized plan string, e.g. "max" | "pro" | "free" | subscriptionType passthrough. */
  plan: string | null
  /** Pretty rate-limit tier label, e.g. "Max 20×" (see prettyTier above). Can be a generic
   *  `default_*` passthrough even for a paid account — use `planLabel` for display. */
  rateLimitTier: string | null
  /** The profile API's raw `organization.organization_type` ("claude_free" | "claude_pro" |
   *  "claude_max" | …). The authoritative, always-current plan family — see resolvePlanLabel.
   *  Null on the offline/cache path when we've never resolved this instance live. */
  orgType: string | null
  /** Display-ready account type ("Max 20×" | "Pro" | "Free" | …), reconciled from `orgType` +
   *  `rateLimitTier` + `plan` by resolvePlanLabel. Null when it can't be determined (render "—"). */
  planLabel: string | null
  accountUuid: string | null
  orgUuid: string | null
  orgName: string | null
  /** Where this CMAccount came from: 'live' (network), 'cache', 'offline', etc. */
  source: string | null
  /** One-line display label, e.g. "Michael <lunawerx@gmail.com> · Max 20×". */
  label: string
}

/** A single isolated Claude Desktop instance, running or available. */
export interface CMInstance {
  /** Permanent short handle (`#7`) — see core/instance-numbers.ts. Unique across desktop, CLI and
   *  Codex instances alike, assigned on first sight and never reused, so it is the one identifier
   *  a human can say out loud and an MCP client can resolve back to this exact account. */
  num: number
  name: string
  dir: string
  isRunning: boolean
  pid: number | null
  startTime: string | null
  sizeBytes: number | null
  /** Live resident memory (summed working set across the instance's whole process tree —
   *  Electron main + renderer/gpu/utility children). Null when the instance isn't running or
   *  the platform can't cheaply report it (e.g. the unix `ps` path). */
  memoryBytes: number | null
  /** Attached lazily/omitted — null until /account is resolved. */
  account: CMAccount | null
  /** Which account this instance is signed into RIGHT NOW — config.json's `lastKnownAccountUuid`,
   *  null when signed out. Cheap enough (stat-gated, see instances.ts readLoginUuid) to ship with
   *  every list, unlike `account`: the UI compares it against `account.accountUuid` to notice that
   *  an instance was re-logged into a different account and re-resolve the identity immediately,
   *  instead of showing the previous account's email until someone hits Refresh. */
  loginUuid: string | null
  /** True when discovered from a running process whose --user-data-dir isn't under
   *  the instances root. */
  isExternal: boolean
  /**
   * True when this row IS the regular, non-isolated Claude Desktop — its dir is
   * `claudeUserDataDir()` rather than anything under the instances root.
   *
   * The one fact that lets a caller join a SESSION to this row. A session carries an instance
   * LABEL (`SessionSummary.instance`): a dir name for an isolated instance, or the literal
   * `'default'` for the non-isolated install (server/src/instance-sessions.ts scanAll). A dir name
   * matches `name` directly; `'default'` never can, because this row's `name` is the basename of
   * the default user-data dir ("Claude" on Windows) and nothing here is ever called "default".
   * Without this flag the web had to guess — and guessing here means showing one account's email
   * against another account's chat, which is the single thing the identity code is most careful
   * about (see `loginChanged`).
   *
   * Note this row still only EXISTS while the default install is running: it is discovered from a
   * process, never seeded (see listInstances). False on every isolated instance.
   */
  isDefault: boolean
  /** User display label overriding the folder `name` (null = show `name`). Pure UI metadata
   *  (instance-meta.json under appDataDir()), so it can be changed while the instance runs —
   *  unlike the folder, which Claude Desktop holds open. */
  label: string | null
  /** Chosen glyph key (see INSTANCE_ICON_KEYS); null = a deterministic default from the dir. */
  icon: InstanceIconKey | null
  /** Chosen icon color key (see INSTANCE_COLOR_KEYS); null = a deterministic default. */
  color: InstanceColorKey | null
}

/** Result of a mutating action (open/quit/create/delete). */
export interface CMActionResult {
  ok: boolean
  action: string | null
  dir: string | null
  message: string | null
  /** Optional extra payload (e.g. freed byte count, launched PID). Omitted on
   *  the common early-return guard-clause failure paths — callers should treat
   *  a missing `data` as "no extra payload," never as a malformed result. */
  data?: Record<string, unknown>
  /** Create-only: surfaces the "Browser Dance" caveat (quit other instances before first login). */
  needsBrowserDance?: boolean
}

/** How Claude Desktop is installed on this machine (see core/desktop-install.ts). On Windows,
 *  Anthropic ships two installers: the classic Squirrel `.exe` (installs to
 *  `%LOCALAPPDATA%\AnthropicClaude\app-<ver>\Claude.exe` — the only build this app can launch
 *  with `--user-data-dir`) and the MSIX package (PFN `Claude_pzs8sxrjxfjjc`, lands under the
 *  ACL-locked `C:\Program Files\WindowsApps`, AppContainer-sandboxed — NOT manageable here). */
export interface CMDesktopInstall {
  platform: 'win32' | 'darwin' | 'linux'
  /** Launchable classic-install binary (null when only the MSIX build — or nothing — is present). */
  directPath: string | null
  /** True when the MSIX package is detected (win32 only; always false elsewhere). */
  msixDetected: boolean
  /** Which detection signals fired, for debuggability: 'packages-dir' | 'exec-alias' | 'appx' | 'fake'. */
  msixSignals: string[]
  /** False when the Instances/Manager tab cannot launch instances on this machine. */
  manageable: boolean
}

/** Cached instance-account identity — NEVER a token. Written by core/accounts.ts, keyed by
 *  normalized instance dir in the instances-cache.json file under CONFIG_DIR. */
export interface CMAccountCacheEntry {
  email: string | null
  name: string | null
  plan: string | null
  rateLimitTier: string | null
  uuid: string | null
  orgUuid: string | null
  orgName: string | null
  /** Last live `organization.organization_type`. Optional because entries written before
   *  2026-08-07 don't have it; resolvePlanLabel falls back to the older evidence when absent. */
  orgType?: string | null
  resolvedAt: string
}
