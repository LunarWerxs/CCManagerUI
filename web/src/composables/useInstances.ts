// Instance data + actions, mirroring useData.ts's shape (module-scope singleton refs +
// a `guard` helper that swallows failures into `lastError` instead of throwing across a
// component boundary). "Instance account" = which Anthropic account a Claude Desktop
// *instance* is logged into — resolved lazily, never the sqlite `accounts` table.
import { ref } from 'vue'
import type { CMInstance } from '@/lib/api'
import * as api from '@/lib/api'
import { loginChanged } from '@/lib/instance-appearance'

const instances = ref<CMInstance[]>([])
const loading = ref(false)
const resolvingAccounts = ref(false)
const busyDirs = ref<Set<string>>(new Set())
const lastError = ref<string | null>(null)
// When each dir was last auto-resolved, so a poll tick doesn't re-hit one every 4 seconds.
// See autoResolveAccounts() for what actually gets retried and why.
const lastAutoResolveAt = new Map<string, number>()
/** How long before an instance with NO identity yet (logged out, offline, unreadable) is retried.
 *  Short, because the thing that changes it — signing the profile in — is something the user does
 *  in the next minute and then looks straight at this table to confirm. A retry is a local file
 *  read that finds no token and gives up, so this is close to free. */
const UNRESOLVED_RETRY_MS = 60_000
/** How long a RESOLVED identity is trusted before a background re-check. An account's email, name
 *  or plan can change without anything on disk changing (the user edits it at claude.ai), so the
 *  only way to notice is to ask again on a timer. Slow, because it costs one profile call per
 *  instance and the answer rarely changes. */
const RESOLVED_REFRESH_MS = 15 * 60_000
/** A re-login IS visible on disk — config.json's `lastKnownAccountUuid` stops matching the
 *  identity on screen (see CMInstance.loginUuid) — so that case doesn't wait for the slow timer.
 *  Still throttled, so a mismatch that somehow persists can't turn the 4s poll into a profile-API
 *  hammer. */
const LOGIN_CHANGED_RETRY_MS = 30_000

/**
 * How hard a caller wants identities resolved.
 *
 * `'full'` is the Instances tab: it is the screen ABOUT accounts, so it pays for the profile calls
 * that keep emails, names and plans current.
 *
 * `'cache'` is everyone else, and it is the DEFAULT because everyone else outnumbers it. The
 * sessions list, the queue drawer and the composer all consume this singleton just to put a name on
 * a chip, and they mount at app start — so with one shared resolve policy, opening the app on the
 * Sessions view fired a full profile call for EVERY instance. Measured 2026-08-07 on a 15-instance
 * install: 15 network resolves, 4-wide, ~1.4 SECONDS of continuous requests, to label chips that
 * the on-disk identity cache answers in about 25ms. Cache mode reads that cache and stops.
 *
 * The one thing cache mode still pays for is a login it can PROVE is wrong (`loginChanged`): the
 * cached identity belongs to a different account than the instance is now signed into, so showing
 * it would be showing the wrong person's email. That set is empty on essentially every tick.
 */
type ResolveMode = 'cache' | 'full'

function guard<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((e) => {
    lastError.value = e instanceof Error ? e.message : String(e)
    return undefined
  })
}

function setBusy(dir: string, busy: boolean) {
  const next = new Set(busyDirs.value)
  if (busy) next.add(dir)
  else next.delete(dir)
  busyDirs.value = next
}

function upsert(next: CMInstance) {
  const idx = instances.value.findIndex((i) => i.dir === next.dir)
  if (idx === -1) {
    instances.value = [...instances.value, next]
  } else {
    const copy = instances.value.slice()
    copy[idx] = { ...copy[idx], ...next }
    instances.value = copy
  }
}

/** Reload the instance list. `silent` (used by the 4s background poll) skips the `loading`
 *  toggle so the toolbar Refresh icon only spins on a first load or a user-initiated refresh —
 *  not every poll tick, which reads as a distracting constant spinner. `force` re-resolves every
 *  account from scratch (the toolbar Refresh button), rather than only the ones still unknown. */
async function refreshInstances(
  opts: { silent?: boolean; force?: boolean; resolve?: ResolveMode } = {},
) {
  if (!opts.silent) loading.value = true
  const r = await guard(api.listInstances())
  if (r) {
    // Preserve any account identity we've already resolved: the /api/instances list omits it
    // (account is null there), so a naive replace would wipe resolved emails on every poll.
    // Exception: an identity that no longer matches the instance's current login is dropped
    // instead of carried — a blank cell for the tick it takes to re-resolve beats the previous
    // account's email.
    const prev = new Map(instances.value.map((i) => [i.dir, i.account]))
    instances.value = r.map((i) => {
      if (i.account != null) return i
      const carried = prev.get(i.dir) ?? null
      if (!carried) return i
      const next = { ...i, account: carried }
      return loginChanged(next) ? i : next
    })
  }
  if (!opts.silent) loading.value = false
  void autoResolveAccounts({ force: opts.force, mode: opts.resolve ?? 'cache' })
}

/**
 * Resolve the account identity of every instance that doesn't have one yet. Silent (no toasts,
 * and no busy flag — see resolveAccount), driven off every list load and poll tick.
 *
 * There is no manual "Resolve" action anymore, and nothing here is limited to RUNNING instances:
 * resolving reads config.json and the token cache straight off disk (see core/accounts.ts), so a
 * stopped instance resolves exactly as well as a running one. Gating it on `isRunning` only meant
 * a stopped instance sat there showing a button that resolved it on the first click, every time —
 * which is a chore, not a choice.
 *
 * What gets retried: an instance with NO identity (logged out / offline / unreadable) is re-tried
 * every UNRESOLVED_RETRY_MS, so signing one in shows up on its own. A RESOLVED identity is not
 * final either — the account behind an instance can change under us, so it is re-checked every
 * RESOLVED_REFRESH_MS, and much sooner (LOGIN_CHANGED_RETRY_MS) when the instance's on-disk login
 * uuid stops matching the identity on screen. Refresh (`force`) still re-resolves everything now.
 *
 * Resolved a few AT A TIME, not one after another. On a fresh page load NOTHING has been resolved
 * yet, so every instance is stale and the old strictly-serial loop turned the account column into
 * a waterfall: measured 2026-08-06 at ~10 requests × 200-820ms each, i.e. roughly 3.5 SECONDS
 * before the last row got its identity — on every single open of the app. Each resolve is an
 * independent decrypt + profile call against a DIFFERENT account, so there is nothing to serialize
 * for; the loop was only ever incidental.
 *
 * `mode` decides whether pass 2 runs at all — see ResolveMode. Only the Instances tab asks for
 * 'full'; every other consumer of this singleton wants a name for a chip and is served by the
 * cache.
 */
async function autoResolveAccounts(
  opts: { force?: boolean; mode?: ResolveMode } = {},
): Promise<void> {
  if (resolvingAccounts.value) return
  const mode = opts.mode ?? 'cache'
  const now = Date.now()
  const stale = instances.value.filter((i) => {
    if (opts.force) return true
    const last = lastAutoResolveAt.get(i.dir)
    const age = last === undefined ? Number.POSITIVE_INFINITY : now - last
    // No identity yet (signed out / offline / unreadable) — retry on the short timer.
    if (!i.account?.email && !i.account?.name) return age >= UNRESOLVED_RETRY_MS
    // Signed into a different account than the one on screen — re-resolve promptly.
    if (loginChanged(i)) return age >= LOGIN_CHANGED_RETRY_MS
    // Known identity, same account: re-check occasionally in case the email/name/plan changed.
    return age >= RESOLVED_REFRESH_MS
  })
  if (stale.length === 0) return

  resolvingAccounts.value = true
  try {
    // Pass 1 — CACHE ONLY, and only for rows that would otherwise sit blank. `noNetwork` answers
    // from the identity we already wrote to disk last time (no profile call, no decrypt round
    // trip): measured 2026-08-06 at 25ms for ALL ELEVEN instances, against ~1.5s for the same
    // eleven over the network. So the account column fills in essentially at page load instead of
    // arriving a second and a half later, and pass 2 quietly corrects it if anything changed.
    //
    // Scoped to `!account` on purpose: on a poll tick every row already carries an identity
    // (refreshInstances re-attaches them), so this finds nothing to do and costs nothing. It is a
    // first-paint path, not a per-tick one. lastAutoResolveAt is deliberately NOT stamped here —
    // a cached read is not a resolve, and stamping it would let the cache suppress the real one.
    const blank = stale.filter((i) => !i.account)
    if (blank.length) await Promise.all(blank.map((i) => resolveAccount(i.dir, true)))

    // Pass 2 — the real resolve. Bounded, not unbounded: someone running a dozen accounts would
    // otherwise open a dozen simultaneous profile calls, and each row lands as it arrives anyway
    // (resolveAccount merges into `instances` per-instance), so the visible difference between
    // 4-wide and all-at-once is nil while the risk of tripping Anthropic's rate limiter is not.
    //
    // In CACHE mode it is narrowed to the rows whose cached identity is provably the WRONG account
    // (see ResolveMode). Not skipped outright: showing another account's email against an instance
    // is a correctness bug, not a staleness one, and that set is empty on virtually every tick —
    // whereas the periodic re-check cohort is every instance you own, which is the storm.
    const queue = mode === 'full' ? stale.slice() : stale.filter(loginChanged)
    if (queue.length === 0) return
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        const inst = queue.shift()
        if (!inst) return
        lastAutoResolveAt.set(inst.dir, Date.now())
        await resolveAccount(inst.dir)
      }
    })
    await Promise.all(workers)
  } finally {
    resolvingAccounts.value = false
  }
}

let pollTimer: number | null = null

/** Started by the Instances tab alone, which is why this is the one caller that resolves in 'full'
 *  mode: it is the screen where an out-of-date email or plan is the thing you came to look at.
 *  Every other consumer calls refreshInstances() directly and gets the cache. */
function startPolling() {
  if (pollTimer !== null) return
  refreshInstances({ resolve: 'full' })
  // Background ticks are silent (no `loading` toggle) — see refreshInstances().
  pollTimer = window.setInterval(() => refreshInstances({ silent: true, resolve: 'full' }), 4000)
}

function stopPolling() {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  pollTimer = null
}

/** Launch (open) an instance. Returns the action result (or undefined on hard failure) so
 *  the caller can surface the server's failure message (e.g. the MSIX-only explanation). */
async function open(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.openInstance(dir))
    if (result?.ok) await refreshInstances()
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Quit a running instance. Returns true on success. Quitting the External (default, non-isolated)
 *  Claude Desktop needs `confirmExternal: true` — the server refuses it otherwise, and the UI only
 *  passes it from an explicit confirmation dialog. */
async function quit(dir: string, opts: { confirmExternal?: boolean } = {}): Promise<boolean> {
  setBusy(dir, true)
  try {
    const result = await guard(api.quitInstance(dir, opts))
    if (result?.ok) await refreshInstances()
    return result?.ok ?? false
  } finally {
    setBusy(dir, false)
  }
}

/** Bring a running instance's window to the foreground (Windows only). Returns the action
 *  result (or undefined on hard failure) so the caller can surface the server's failure
 *  message (e.g. "not running", "no window found"). No instance state changes, so this
 *  doesn't trigger a refresh. */
async function focus(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    return await guard(api.focusInstance(dir))
  } finally {
    setBusy(dir, false)
  }
}

/**
 * Sign an instance out: its stored login is removed, so it asks for one next start.
 *
 * Refreshes on success like open/quit do, because the row's account cell is exactly what this
 * changes — leaving the old email on screen after signing out would be the one wrong answer.
 */
async function logout(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.logoutInstance(dir))
    if (result?.ok) await refreshInstances({ force: true, resolve: 'full' })
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Reveal an instance's profile folder in the OS file browser. */
async function revealFolder(dir: string): Promise<api.CMActionResult | undefined> {
  return await guard(api.revealInstanceFolder(dir))
}

/** Create a desktop launcher that opens this instance directly. Returns the action result (or
 *  undefined on hard failure) so the caller can surface the server's message (e.g. the MSIX-only
 *  explanation, or the path it landed at). No instance state changes, so no refresh. */
async function createShortcut(dir: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    return await guard(api.createInstanceShortcut(dir))
  } finally {
    setBusy(dir, false)
  }
}

/** Create a new isolated instance. Returns the action result (or null on hard failure)
 *  so the caller can surface `needsBrowserDance`. */
async function create(name: string): Promise<api.CMActionResult | undefined> {
  const result = await guard(api.createInstance(name))
  if (result?.ok) await refreshInstances()
  return result
}

/** Delete an instance (guarded server-side; confirmName must match exactly). */
async function remove(dir: string, confirmName: string): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.deleteInstance(dir, confirmName))
    if (result?.ok) await refreshInstances()
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Update an instance's UI metadata: display label (a pure relabel that never touches the
 *  on-disk folder, so it works while the instance is running), icon glyph, and icon color.
 *  The dir is unchanged, so the row re-keys in place on refresh. */
async function setAppearance(
  dir: string,
  patch: {
    label?: string | null
    icon?: api.InstanceIconKey | null
    color?: api.InstanceColorKey | null
  },
): Promise<api.CMActionResult | undefined> {
  setBusy(dir, true)
  try {
    const result = await guard(api.setInstanceMeta(dir, patch))
    if (result?.ok) await refreshInstances()
    return result
  } finally {
    setBusy(dir, false)
  }
}

/** Resolve (or re-resolve) the account identity for one instance and merge it in.
 *
 *  Deliberately does NOT set the row busy: this runs unattended now (see autoResolveAccounts),
 *  and busy disables the row's buttons — so flagging it would make Open/Focus flicker
 *  un-clickable every time a background resolve happened to be in flight. Resolving reads a file
 *  and asks Anthropic who this token belongs to; it changes nothing about the instance, so there
 *  is nothing for a busy flag to protect. */
async function resolveAccount(dir: string, noNetwork = false): Promise<boolean> {
  const account = await guard(api.getInstanceAccount(dir, { noNetwork }))
  if (account === undefined) return false
  const existing = instances.value.find((i) => i.dir === dir)
  if (existing) upsert({ ...existing, account })
  return true
}

export function useInstances() {
  return {
    instances,
    loading,
    resolvingAccounts,
    busyDirs,
    lastError,
    refreshInstances,
    startPolling,
    stopPolling,
    open,
    quit,
    focus,
    logout,
    revealFolder,
    createShortcut,
    create,
    remove,
    setAppearance,
    resolveAccount,
  }
}
