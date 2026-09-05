// server/src/core/cli-instances.ts — CLI instances as first-class managed objects (§3 of
// CLI_INSTANCES_AND_USAGE_PLAN.md).
//
// The core architectural insight: an account has TWO independent auth stores. A DESKTOP instance is
// isolated with Electron's `--user-data-dir` (managed by core/instances.ts); a CLI instance is
// isolated with `CLAUDE_CONFIG_DIR=<dir>` and logged in once via `claude` → `/login`. They are
// different logins even for the same account. This module models the CLI side: a `CLAUDE_CONFIG_DIR`
// directory, its logged-in state, and the lifecycle verbs (create / launch / associate / delete).
//
// Persistence mirrors the desktop instance-identity split: a plain JSON store under CONFIG_DIR
// (NOT the sqlite db — no schema migration, same as instances-cache.json). Never carries a token;
// login is the USER's step (an OAuth/password flow an AI must never perform), so this module can
// only (a) create the dir, (b) detect logged-in state by the presence of `.credentials.json`, and
// (c) open a real terminal with the env set so the user can `/login` (or just use the session).
//
// Never throws for expected failures (bad name, collision, missing dir, guard refusal) — every
// mutating function returns a status-carrying CMActionResult, same contract as core/lifecycle.ts.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CONFIG_DIR, resolveClaudeExe } from '../config'
import type { CliInstance, UsageSnapshot } from '../types'
import { instanceNumberFor, instanceNumbers, instanceRef } from './instance-numbers'
import {
  describeStoreRefusal,
  type JsonStoreMutation,
  type JsonStoreSpec,
  mutateJsonStore,
  readJsonStore,
} from './json-store'
import { CLAUDE_LAUNCH_EFFORTS, type LaunchOptionsInput, launchOptionError } from './launch-options'
import { isPathInside } from './paths'
import type { CMActionResult } from './shared'

export type { CliInstance } from '../types'

/** Where CLI-instance config dirs live: `<CONFIG_DIR>/cli-instances/<id>`. */
const CLI_INSTANCES_ROOT = join(CONFIG_DIR, 'cli-instances')
/** The JSON store (the record list; loggedIn is recomputed, not trusted from disk). */
const STORE_PATH = join(CONFIG_DIR, 'cli-instances.json')

const NAME_MAX = 60

// --- persistence -------------------------------------------------------------
//
// Every read and write goes through core/json-store.ts: a corrupt or unreadable file is reported
// as such (never as an empty registry), writes are temp-file + rename, and mutations hold the
// interprocess lock so the quick-instance daemon and the main daemon cannot overwrite each other.
// See that file's header for the reproduction that forced this.

interface Store {
  instances: CliInstance[]
}

const STORE_WHAT = 'CLI instance registry'

const STORE_SPEC: JsonStoreSpec<Store> = {
  path: STORE_PATH,
  decode: (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null
    const instances = (parsed as { instances?: unknown }).instances
    if (!Array.isArray(instances)) return null
    return { instances: instances as CliInstance[] }
  },
  empty: () => ({ instances: [] }),
}

/** The last unreadable-store condition already logged, so a broken file is reported once per
 *  distinct failure rather than on every 4-second poll. Cleared when the store reads cleanly. */
let reportedStoreFailure: string | null = null

/**
 * READERS: the store, or an empty one when the file does not exist yet.
 *
 * A corrupt or unreadable file also reads as empty here - a list route has nothing better to show -
 * but the condition is logged (once) and, crucially, never written back: every mutator below goes
 * through `mutate`, which refuses on the same condition and leaves the bytes untouched.
 */
function readStore(): Store {
  const read = readJsonStore(STORE_SPEC)
  if (read.status === 'ok') {
    reportedStoreFailure = null
    return read.value
  }
  if (read.status === 'missing') return STORE_SPEC.empty()
  const key = `${read.status}:${read.reason}`
  if (reportedStoreFailure !== key) {
    reportedStoreFailure = key
    console.error(
      `[cli-instances] ${STORE_PATH} is ${read.status} (${read.reason}). Listing no CLI instances and refusing every change until it is repaired; the file has NOT been modified.`,
    )
  }
  return STORE_SPEC.empty()
}

/** MUTATORS: read-modify-write under the lock; see mutateJsonStore. */
function mutate<R>(fn: (store: Store) => { result: R; changed: boolean }): JsonStoreMutation<R> {
  return mutateJsonStore(STORE_SPEC, fn)
}

/** The status-carrying refusal every mutator returns when the registry cannot be safely changed. */
function refusal(
  action: string,
  dir: string | null,
  data: Record<string, unknown>,
  failure: { status: 'corrupt' | 'unreadable' | 'locked' | 'write-failed'; reason: string },
): CMActionResult {
  return {
    ok: false,
    action,
    dir,
    message: describeStoreRefusal(STORE_WHAT, STORE_PATH, failure),
    data: { ...data, registry: failure.status, reason: failure.reason },
  }
}

// --- login detection ---------------------------------------------------------

/** True when the config dir has been `/login`'d once (a `.credentials.json` is present). */
export function isLoggedIn(configDir: string): boolean {
  try {
    return existsSync(join(configDir, '.credentials.json'))
  } catch {
    return false
  }
}

// --- config-dir canonicalisation (the ccmanagerui → agenthydra rebrand) -------
//
// A record's `configDir` is written ONCE, at create time, as `<CONFIG_DIR>/cli-instances/<id>` and
// never edited afterwards. When CONFIG_DIR itself moved (`~/.ccmanagerui` → `~/.agenthydra`, see
// resolveConfigDir in ../config), the folder came with it but the ABSOLUTE PATH STRING baked into
// every existing record did not. Nothing rewrote it, so a carried-over install ended up with a
// record pointing at a directory that no longer exists: `loggedIn` is recomputed from
// `<configDir>/.credentials.json`, so it went permanently false, and a re-login would have written
// fresh credentials back under the dead brand folder.
//
// The fix is to treat "`<CLI_INSTANCES_ROOT>/<id>`" as what it always was — a derivation, not
// user data. `canonicalConfigDir` re-derives it on read (so every process, including the separate
// quick-instances window, agrees without needing a write), and migrateCliInstanceConfigDirs
// persists the rewrite and carries any credentials still sitting at the old path across.

/**
 * Where this record's config dir MUST be, if it is one we manage.
 *
 * Only rewrites a path whose last segment is the record's own id — that is the signature of a
 * dir this module minted. Anything else is left exactly as stored, so a hand-pointed or otherwise
 * unusual configDir is never "corrected" out from under its owner.
 */
export function canonicalConfigDir(rec: Pick<CliInstance, 'id' | 'configDir'>): string {
  if (!rec.configDir || basename(rec.configDir) !== rec.id) return rec.configDir
  return join(CLI_INSTANCES_ROOT, rec.id)
}

/** A stored record hydrated with its LIVE loggedIn state (the store value is only a hint).
 *  Also backfills fields added after a store was first written (records predating the desktop link
 *  have no `associatedDesktop*` keys at all), so callers never see `undefined` where they expect null. */
function hydrate(rec: CliInstance, num?: number): CliInstance {
  const configDir = canonicalConfigDir(rec)
  return {
    ...rec,
    // The registry is the source of truth for the number, not whatever the store file happens to
    // hold — a store written before numbers existed has none at all. `num` is passed in by the
    // bulk lister so a 14-instance list is one registry read, not fourteen.
    num: num ?? instanceNumberFor('cli', rec.id),
    configDir,
    associatedDesktopDir: rec.associatedDesktopDir ?? null,
    associatedDesktopLabel: rec.associatedDesktopLabel ?? null,
    loggedIn: isLoggedIn(configDir),
  }
}

/**
 * Persist the canonicalisation above, moving any credentials left behind at the old path.
 *
 * Called once at daemon boot. Copy-then-leave rather than move: the old directory is under a config
 * root we no longer own, and deleting a user's credentials to tidy up a path string is not a trade
 * worth making. Returns the ids it rewrote (empty = nothing to do, and nothing was written).
 */
export function migrateCliInstanceConfigDirs(): string[] {
  const outcome = mutate((store) => {
    const changed: string[] = []
    for (const rec of store.instances) {
      const canonical = canonicalConfigDir(rec)
      if (canonical === rec.configDir) continue
      const legacy = rec.configDir
      try {
        // Only carry credentials over when the canonical dir has none of its own — a populated
        // canonical dir is the newer login and must win.
        const canonicalEmpty = !existsSync(canonical) || readdirSync(canonical).length === 0
        if (existsSync(legacy) && canonicalEmpty) {
          mkdirSync(canonical, { recursive: true })
          cpSync(legacy, canonical, { recursive: true })
        } else {
          mkdirSync(canonical, { recursive: true })
        }
      } catch (err) {
        console.error(`[cli-instances] could not migrate '${legacy}' → '${canonical}':`, err)
      }
      rec.configDir = canonical
      changed.push(rec.id)
    }
    return { result: changed, changed: changed.length > 0 }
  })
  if (!outcome.ok) {
    console.error(`[cli-instances] ${describeStoreRefusal(STORE_WHAT, STORE_PATH, outcome)}`)
    return []
  }
  return outcome.result
}

/** What the on-disk layout says versus what the registry says, for repair without guessing. */
export interface CliInstanceReconciliation {
  /** How the registry file itself read. Anything but `ok`/`missing` means the lists below were
   *  computed against an EMPTY registry and every managed dir will look orphaned. */
  registry: 'ok' | 'missing' | 'corrupt' | 'unreadable'
  /** Directories under the instances root that no record claims - a login this app can no longer
   *  see, typically left by a registry that was overwritten before writes were guarded. */
  orphanDirs: string[]
  /** Records whose config dir is gone - an identity the UI shows that has nothing behind it. */
  missingDirs: Array<{ id: string; name: string; configDir: string }>
}

/**
 * Compare the registry with the directories it is supposed to describe. READ-ONLY: it reports,
 * it repairs nothing, because deciding whether an orphaned login dir is a lost identity or a
 * leftover is the owner's call. Logged at boot by index.ts so existing damage surfaces.
 */
export function reconcileCliInstanceDirs(): CliInstanceReconciliation {
  const read = readJsonStore(STORE_SPEC)
  const registry = read.status
  const records = read.status === 'ok' ? read.value.instances : []
  const claimed = new Set(records.map((rec) => basename(canonicalConfigDir(rec))))
  let orphanDirs: string[] = []
  try {
    if (existsSync(CLI_INSTANCES_ROOT)) {
      orphanDirs = readdirSync(CLI_INSTANCES_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !claimed.has(entry.name))
        .map((entry) => join(CLI_INSTANCES_ROOT, entry.name))
        .sort()
    }
  } catch {
    // An unreadable root reports no orphans; the registry status already says whether to trust it.
  }
  const missingDirs = records
    .map((rec) => ({ id: rec.id, name: rec.name, configDir: canonicalConfigDir(rec) }))
    .filter((rec) => !existsSync(rec.configDir))
  return { registry, orphanDirs, missingDirs }
}

// --- read --------------------------------------------------------------------

/** Every CLI instance, each with its live loggedIn state. */
export function listCliInstances(): CliInstance[] {
  const records = readStore().instances
  const numbers = instanceNumbers(records.map((r) => instanceRef('cli', r.id)))
  return records.map((rec) => hydrate(rec, numbers.get(instanceRef('cli', rec.id))))
}

/** One CLI instance by id (live loggedIn state), or null. */
export function getCliInstance(id: string): CliInstance | null {
  const rec = readStore().instances.find((i) => i.id === id)
  return rec ? hydrate(rec) : null
}

// --- create ------------------------------------------------------------------

function validName(name: string): { ok: boolean; reason: string } {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'Name cannot be empty.' }
  if (trimmed.length > NAME_MAX) return { ok: false, reason: `Name must be ≤ ${NAME_MAX} chars.` }
  return { ok: true, reason: '' }
}

/**
 * Create a new CLI instance: mint an id, mkdir its `CLAUDE_CONFIG_DIR`, persist a record with
 * loggedIn=false. Login is deferred to the user (see openCliTerminal). Idempotent per id (a fresh
 * uuid each call), never collides.
 */
export function createCliInstance(name: string): CMActionResult {
  const v = validName(name)
  if (!v.ok) {
    return { ok: false, action: 'cli-create', dir: null, message: v.reason, data: { name } }
  }
  const id = crypto.randomUUID()
  const configDir = join(CLI_INSTANCES_ROOT, id)
  try {
    mkdirSync(configDir, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      action: 'cli-create',
      dir: configDir,
      message: `Failed to create config dir '${configDir}': ${err instanceof Error ? err.message : String(err)}`,
      data: { name },
    }
  }
  const rec: CliInstance = {
    num: instanceNumberFor('cli', id),
    id,
    name: name.trim(),
    configDir,
    associatedAccountId: null,
    associatedAccountLabel: null,
    associatedDesktopDir: null,
    associatedDesktopLabel: null,
    loggedIn: false,
    lastUsageCheck: null,
    createdAt: Date.now(),
  }
  const outcome = mutate((store) => {
    store.instances.push(rec)
    return { result: null, changed: true }
  })
  if (!outcome.ok) {
    // The record never landed, so the dir minted for it is an orphan already: take it back rather
    // than leave a fresh unexplained folder beside a registry the owner now has to repair.
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {
      // Best effort; reconcileCliInstanceDirs reports it if it survives.
    }
    return refusal('cli-create', null, { name }, outcome)
  }
  return {
    ok: true,
    action: 'cli-create',
    dir: configDir,
    message: `CLI instance #${rec.num} '${rec.name}' created. Use the log-in helper to sign it in.`,
    data: { id, configDir, num: rec.num },
  }
}

// --- rename / associate ------------------------------------------------------

/** Rename the display label (never touches the folder/id). */
export function renameCliInstance(id: string, name: string): CMActionResult {
  const v = validName(name)
  if (!v.ok) return { ok: false, action: 'cli-rename', dir: null, message: v.reason, data: { id } }
  const outcome = mutate((store) => {
    const rec = store.instances.find((i) => i.id === id)
    if (!rec) return { result: null, changed: false }
    rec.name = name.trim()
    return { result: rec.configDir, changed: true }
  })
  if (!outcome.ok) return refusal('cli-rename', null, { id }, outcome)
  if (outcome.result === null)
    return {
      ok: false,
      action: 'cli-rename',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  return { ok: true, action: 'cli-rename', dir: outcome.result, message: 'Renamed.', data: { id } }
}

/** Associate (or clear, with accountId=null) the dispatch account used for this instance's usage. */
export function associateCliInstance(
  id: string,
  accountId: string | null,
  accountLabel: string | null,
): CMActionResult {
  const outcome = mutate((store) => {
    const rec = store.instances.find((i) => i.id === id)
    if (!rec) return { result: null, changed: false }
    rec.associatedAccountId = accountId
    rec.associatedAccountLabel = accountLabel
    return { result: rec.configDir, changed: true }
  })
  if (!outcome.ok) return refusal('cli-associate', null, { id, accountId }, outcome)
  if (outcome.result === null)
    return {
      ok: false,
      action: 'cli-associate',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  return {
    ok: true,
    action: 'cli-associate',
    dir: outcome.result,
    message: accountId ? 'Account associated.' : 'Association cleared.',
    data: { id, accountId },
  }
}

/** Clear the account association on every record matching `match`, in ONE store write.
 *  Returns the ids that were cleared (empty = nothing referenced it, and nothing was written).
 *  A registry that cannot be safely changed clears nothing and says so in the log: the stale badge
 *  is a wrong answer, but overwriting a damaged registry to remove it would be a worse one. */
function clearAccountAssociationsWhere(match: (accountId: string) => boolean): string[] {
  const outcome = mutate((store) => {
    const cleared: string[] = []
    for (const rec of store.instances) {
      if (!rec.associatedAccountId || !match(rec.associatedAccountId)) continue
      rec.associatedAccountId = null
      rec.associatedAccountLabel = null
      cleared.push(rec.id)
    }
    return { result: cleared, changed: cleared.length > 0 }
  })
  if (!outcome.ok) {
    console.error(`[cli-instances] ${describeStoreRefusal(STORE_WHAT, STORE_PATH, outcome)}`)
    return []
  }
  return outcome.result
}

/**
 * Detach a deleted dispatch account from every CLI instance that referenced it.
 *
 * The association is a plain id + label copied into the JSON store, NOT a foreign key — sqlite can't
 * cascade into a file it doesn't own, so deleting the account row leaves the reference behind. What
 * the user then sees is a badge naming an account that no longer exists, on an instance whose usage
 * check silently falls through to "check failed" because the id resolves to nothing. Clearing it
 * turns a wrong answer into an honest one: the instance is simply unassociated again.
 */
export function clearCliInstanceAccountAssociations(accountId: string): string[] {
  if (!accountId) return []
  return clearAccountAssociationsWhere((id) => id === accountId)
}

/**
 * Self-heal: drop any association whose account is not in `knownAccountIds`.
 *
 * The eager clear above only covers deletions that happen from now on. Records already dangling
 * (deleted before that existed, or by a hand-edited db) would keep their stale badge forever, so the
 * read path reconciles against the live account list as well. Pass EVERY known account id — an empty
 * set means "no accounts exist", which correctly clears everything.
 */
export function pruneCliInstanceAccountAssociations(knownAccountIds: Iterable<string>): string[] {
  const known = knownAccountIds instanceof Set ? knownAccountIds : new Set(knownAccountIds)
  return clearAccountAssociationsWhere((id) => !known.has(id))
}

/**
 * Link (or unlink, with desktopDir=null) this CLI instance to a DESKTOP instance.
 *
 * A desktop app and a CLI login are two separate auth stores, but they are normally the same
 * Anthropic account used two ways — so this link is what lets the UI present them as one account,
 * and lets either side's credential serve as the other's usage-check fallback (see the desktop
 * usage route: own token → LINKED CLI's token → dispatch account).
 *
 * The link is 1:1 from the CLI side: linking a CLI instance to a desktop dir that another CLI
 * instance already claims steals it, rather than leaving two CLI instances pointing at one desktop
 * (which would make "the linked CLI" ambiguous for the fallback chain).
 */
export function linkCliInstanceToDesktop(
  id: string,
  desktopDir: string | null,
  desktopLabel: string | null,
): CMActionResult {
  const outcome = mutate((store) => {
    const rec = store.instances.find((i) => i.id === id)
    if (!rec) return { result: null, changed: false }
    if (desktopDir) {
      for (const other of store.instances) {
        if (other.id !== id && other.associatedDesktopDir === desktopDir) {
          other.associatedDesktopDir = null
          other.associatedDesktopLabel = null
        }
      }
    }
    rec.associatedDesktopDir = desktopDir
    rec.associatedDesktopLabel = desktopDir ? desktopLabel : null
    return { result: rec.configDir, changed: true }
  })
  if (!outcome.ok) return refusal('cli-link-desktop', null, { id, desktopDir }, outcome)
  if (outcome.result === null)
    return {
      ok: false,
      action: 'cli-link-desktop',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  return {
    ok: true,
    action: 'cli-link-desktop',
    dir: outcome.result,
    message: desktopDir ? 'Linked to desktop instance.' : 'Desktop link cleared.',
    data: { id, desktopDir },
  }
}

/** The CLI instance linked to this desktop instance dir, or null. The reverse of the link above —
 *  used by the desktop usage route to find a backup credential when the desktop token can't be used. */
export function cliInstanceForDesktop(desktopDir: string): CliInstance | null {
  const rec = readStore().instances.find((i) => i.associatedDesktopDir === desktopDir)
  return rec ? hydrate(rec) : null
}

/** Store the latest usage snapshot on the record (called by the usage route after a check). */
export function setCliInstanceUsage(id: string, snap: UsageSnapshot): void {
  const outcome = mutate((store) => {
    const rec = store.instances.find((i) => i.id === id)
    if (!rec) return { result: null, changed: false }
    rec.lastUsageCheck = snap
    return { result: null, changed: true }
  })
  // A usage reading is a cache, not an identity: losing one costs a re-check, so a refusal here is
  // only worth the log line the reader already emits. Nothing else to do.
  void outcome
}

// --- delete (guarded) --------------------------------------------------------

export interface DeleteCliInstanceOptions {
  /** Injected recursive remove, for tests that need the filesystem step to fail on every OS
   *  (a locked directory is only reproducible on Windows). Defaults to the real `rmSync`. */
  removeDir?: (dir: string) => void
}

/**
 * Guarded delete: `confirmName` must equal the instance's display name (same discipline as the
 * desktop delete). Removes the record AND its config dir (which holds the login) — irreversible, so
 * the confirm gate matters. The dir is always under CLI_INSTANCES_ROOT (we created it), so there is
 * no "outside the root" escape to guard against as there is for desktop dirs.
 *
 * The record is dropped ONLY once the directory is verifiably gone (audit AH-03). The previous
 * shape swallowed the remove error and spliced the record anyway "so the UI isn't wedged on a
 * locked dir" - which left the login on disk with no row to manage it from, and told the user it
 * was deleted. A locked dir now returns the real error with the row intact, so the same button
 * works once the lock is gone.
 */
export function deleteCliInstance(
  id: string,
  confirmName?: string,
  options: DeleteCliInstanceOptions = {},
): CMActionResult {
  const rec = readStore().instances.find((i) => i.id === id)
  if (!rec)
    return {
      ok: false,
      action: 'cli-delete',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }
  if (!confirmName || confirmName !== rec.name) {
    return {
      ok: false,
      action: 'cli-delete',
      dir: rec.configDir,
      message: `Refusing to delete: confirmName must exactly match the instance name '${rec.name}'.`,
      data: { id },
    }
  }
  const configDir = canonicalConfigDir(rec)
  // Defensive: only ever rm a path under our own root. A hand-pointed dir is left alone and only
  // the record goes.
  if (isPathInside(CLI_INSTANCES_ROOT, configDir)) {
    const removeDir =
      options.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }))
    try {
      removeDir(configDir)
    } catch (err) {
      return {
        ok: false,
        action: 'cli-delete',
        dir: configDir,
        message: `Could not delete '${configDir}': ${err instanceof Error ? err.message : String(err)}. The instance record was kept so it can be retried; its login data is still on disk.`,
        data: { id, partial: true },
      }
    }
    if (existsSync(configDir)) {
      return {
        ok: false,
        action: 'cli-delete',
        dir: configDir,
        message: `'${configDir}' still exists after the delete (something is holding it open). The instance record was kept so it can be retried; its login data is still on disk.`,
        data: { id, partial: true },
      }
    }
  }
  const outcome = mutate((store) => {
    const idx = store.instances.findIndex((i) => i.id === id)
    if (idx < 0) return { result: false, changed: false }
    store.instances.splice(idx, 1)
    return { result: true, changed: true }
  })
  if (!outcome.ok) {
    // The dir is gone but the row could not be dropped: say exactly that, so the owner knows the
    // registry - not the login - is what needs attention. reconcileCliInstanceDirs lists it.
    return refusal('cli-delete', configDir, { id, dirRemoved: true }, outcome)
  }
  return {
    ok: true,
    action: 'cli-delete',
    dir: configDir,
    message: `CLI instance '${rec.name}' deleted.`,
    data: { id },
  }
}

// --- launch / login helper (opens a REAL terminal for the user) --------------

export interface LaunchOpts extends LaunchOptionsInput {
  /** true = a bare `claude` for the user to `/login`; false = a normal session. */
  login?: boolean
}

/**
 * Open a visible terminal with `CLAUDE_CONFIG_DIR=<configDir>` set, running `claude`. Both "Launch"
 * and the "Log-in helper" route here — the only difference is the login variant runs a bare `claude`
 * (so the user types `/login`). The terminal is the USER's surface; the daemon never performs the
 * login itself. Detached (survives a daemon restart) and value-blind (no token ever passes through).
 *
 * Windows: `cmd /c start "" cmd /k <claude …>` opens a persistent console window whose environment
 * (incl. CLAUDE_CONFIG_DIR, injected via the spawn env) the `start` hand-off propagates to the inner
 * shell. macOS/Linux: best-effort via the platform terminal opener.
 */
export function launchCliInstance(id: string, opts: LaunchOpts = {}): CMActionResult {
  const rec = getCliInstance(id)
  if (!rec)
    return {
      ok: false,
      action: 'cli-launch',
      dir: null,
      message: 'CLI instance not found.',
      data: { id },
    }

  const optionError = opts.login ? null : launchOptionError(opts, CLAUDE_LAUNCH_EFFORTS)
  if (optionError)
    return {
      ok: false,
      action: 'cli-launch',
      dir: rec.configDir,
      message: optionError,
      data: { id },
    }

  const exe = resolveClaudeExe()
  const claudeArgs: string[] = []
  if (!opts.login) {
    if (typeof opts.model === 'string') claudeArgs.push('--model', opts.model)
    if (typeof opts.effort === 'string') claudeArgs.push('--effort', opts.effort)
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CONFIG_DIR: rec.configDir,
  }

  try {
    if (process.platform === 'win32') {
      // Quote the exe (may contain spaces); `/k` keeps the window open after claude exits so the
      // user can read output / see a login prompt. The empty "" is start's mandatory title slot.
      const inner = [`"${exe}"`, ...claudeArgs].join(' ')
      Bun.spawn(['cmd', '/c', 'start', '', 'cmd', '/k', inner], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    } else if (process.platform === 'darwin') {
      // AppleScript to open Terminal.app with the env exported inline.
      const cmdline = `CLAUDE_CONFIG_DIR=${JSON.stringify(rec.configDir)} ${JSON.stringify(exe)} ${claudeArgs.join(' ')}`
      const script = `tell application "Terminal" to do script ${JSON.stringify(cmdline)}`
      Bun.spawn(['osascript', '-e', script], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    } else {
      // Linux best-effort: x-terminal-emulator holding a shell with the env set.
      const cmdline = `${JSON.stringify(exe)} ${claudeArgs.join(' ')}; exec bash`
      Bun.spawn(['x-terminal-emulator', '-e', 'bash', '-lc', cmdline], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    }
  } catch (err) {
    return {
      ok: false,
      action: opts.login ? 'cli-login' : 'cli-launch',
      dir: rec.configDir,
      message: `Failed to open a terminal: ${err instanceof Error ? err.message : String(err)}`,
      data: { id },
    }
  }
  return {
    ok: true,
    action: opts.login ? 'cli-login' : 'cli-launch',
    dir: rec.configDir,
    message: opts.login
      ? 'Opened a terminal. Run /login there to sign this instance in.'
      : 'Launched a terminal for this CLI instance.',
    data: { id, configDir: rec.configDir },
  }
}
