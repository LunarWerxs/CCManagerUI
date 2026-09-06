// server/src/core/lifecycle.ts — instance create + guarded delete (PLAN.md §2).
// Adapted verbatim (behavior) from an internal LunarWerx tool's instance lifecycle module;
// only the import paths were adapted (./shared instead of ../../../shared/index.ts, no .ts
// extensions to match this repo's convention).
//
// Depends on:
//   core/paths.ts     — instancesRoot(), normalizePath()
//   core/instances.ts — openInstance(dir), isDefaultClaudeDir(dir)
//   core/process.ts   — listClaudeProcesses()
//   core/shared.ts     — CMActionResult DTO
//
// Never throws for expected failure conditions (invalid name, collision, guard refusal,
// locked file, permission error) — every public function returns a status-carrying
// CMActionResult instead.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { linkCliInstanceToDesktop, listCliInstances } from './cli-instances'
import { deleteInstanceMeta } from './instance-meta'
import { isDefaultClaudeDir, openInstance } from './instances'
import { instancesRoot, isPathInside, normalizePath } from './paths'
import { type ClaudeProcessScan, scanClaudeProcesses } from './process'
import type { CMActionResult } from './shared'

// ----------------------------------------------------------------------------
// Name sanitization
// ----------------------------------------------------------------------------

const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

/**
 * Names this app has already spent on something else, so a folder may not take them.
 *
 * `SessionSummary.instance` carries an instance folder NAME — except for two words that mean
 * something other than a folder. `'default'` is the regular non-isolated Claude Desktop
 * (server/src/instance-sessions.ts scanAll stamps its chats with the literal string), and
 * `'other'` is the sessions filter's "plain CLI / no desktop instance" scope
 * (server/src/sessions.ts, and the same two words in the MCP tool descriptions).
 *
 * A folder taking one of those words does not fail loudly, which is exactly why it has to be
 * refused here. An instance called "default" makes its chats indistinguishable from the regular
 * install's — nothing downstream can then say which account held a given conversation, so the
 * Sessions view either names the wrong account or gives up on both. One called "other" can never
 * be picked in the instance filter, because that value already means "the ones with no instance".
 * Neither is recoverable after the fact, and neither is a name anyone wants on purpose.
 */
const RESERVED_INSTANCE_LABELS = new Set(['default', 'other'])

interface NameValidation {
  valid: boolean
  reason: string
  sanitized: string
}

/**
 * Validates a proposed instance name: not empty, no path separators, no ".."
 * traversal, no reserved Windows device name, and restricted to a safe charset
 * (letters/digits/dash/underscore/space) so it's a portable folder-leaf name on
 * every OS this app targets.
 */
function validateInstanceName(name: string): NameValidation {
  if (!name || name.trim().length === 0) {
    return { valid: false, reason: 'Name cannot be empty.', sanitized: '' }
  }

  const trimmed = name.trim()

  if (/[\\/]/.test(trimmed)) {
    return {
      valid: false,
      reason: 'Name cannot contain path separators (\\ or /).',
      sanitized: trimmed,
    }
  }

  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    return {
      valid: false,
      reason: 'Name cannot contain ".." or be "." / "..".',
      sanitized: trimmed,
    }
  }

  if (!/^[A-Za-z0-9_\- ]+$/.test(trimmed)) {
    return {
      valid: false,
      reason: 'Name may only contain letters, digits, dash, underscore, and space.',
      sanitized: trimmed,
    }
  }

  const bareUpper = (trimmed.split('.')[0] ?? trimmed).toUpperCase()
  if (RESERVED_WINDOWS_NAMES.has(bareUpper)) {
    return {
      valid: false,
      reason: `Name '${trimmed}' is a reserved Windows device name.`,
      sanitized: trimmed,
    }
  }

  // Case-insensitively, because the collision is with a WORD the rest of the app matches on, and
  // a folder called "Default" stamps its sessions "Default" — which is not the sentinel on POSIX
  // but is on Windows, so the same folder would break in one place and not the other. Refusing
  // both spellings everywhere is the only version of this rule that means the same thing on every
  // machine. See RESERVED_INSTANCE_LABELS.
  if (RESERVED_INSTANCE_LABELS.has(trimmed.toLowerCase())) {
    return {
      valid: false,
      reason: `Name '${trimmed}' is reserved: AgentHydra already uses it to mean something other than a folder ('default' is the regular non-isolated Claude Desktop, 'other' is the sessions filter's no-instance scope). An instance with that name could not be told apart from it. Pick another name.`,
      sanitized: trimmed,
    }
  }

  return { valid: true, reason: '', sanitized: trimmed }
}

// ----------------------------------------------------------------------------
// Size helper (shared shape with instances.ts; kept local + tiny to avoid a
// cross-file private-function import)
// ----------------------------------------------------------------------------

/** Best-effort recursive byte size of a directory. Returns 0 on any failure. */
function dirSizeBytes(dir: string): number {
  let total = 0
  try {
    if (!existsSync(dir)) return 0
    const stack: string[] = [dir]
    while (stack.length) {
      const current = stack.pop()
      if (current === undefined) continue
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        continue
      }
      for (const name of entries) {
        const full = `${current}/${name}`
        try {
          const st = statSync(full)
          if (st.isDirectory()) stack.push(full)
          else if (st.isFile()) total += st.size
        } catch {
          // Skip individual unreadable entries — best-effort only.
        }
      }
    }
  } catch {
    return total
  }
  return total
}

// ----------------------------------------------------------------------------
// Create
// ----------------------------------------------------------------------------

export interface CreateInstanceOptions {
  /** Launch the instance immediately after creating its directory. */
  launch?: boolean
}

/**
 * Creates a new isolated Claude instance data directory under `instancesRoot()`.
 * Sanitizes the name, refuses collisions, and optionally launches it afterward.
 * Always flags `needsBrowserDance: true` in the result data — the UI hint that
 * other instances should be quit before first login ("Browser Dance").
 */
export async function createInstance(
  name: string,
  options: CreateInstanceOptions = {},
): Promise<CMActionResult> {
  const validation = validateInstanceName(name)
  if (!validation.valid) {
    return {
      ok: false,
      action: 'create',
      dir: null,
      message: `Invalid instance name: ${validation.reason}`,
      data: { name },
    }
  }

  const sanitizedName = validation.sanitized
  const root = instancesRoot()

  try {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'create',
      dir: null,
      message: `Could not create or access instances root '${root}': ${message}`,
      data: { name: sanitizedName },
    }
  }

  const newDir = normalizePath(`${root}/${sanitizedName}`)

  if (existsSync(newDir)) {
    return {
      ok: false,
      action: 'create',
      dir: newDir,
      message: `An instance named '${sanitizedName}' already exists at '${newDir}'.`,
      data: { name: sanitizedName },
    }
  }

  try {
    mkdirSync(newDir, { recursive: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'create',
      dir: newDir,
      message: `Failed to create instance directory '${newDir}': ${message}`,
      data: { name: sanitizedName },
    }
  }

  // Start blank: a name reused after a prior instance's folder vanished out-of-band (Explorer
  // delete, or a swallowed deleteInstanceMeta write) could otherwise resurrect the old
  // label/icon/color, since UI metadata is keyed by dir and survives the folder.
  deleteInstanceMeta(newDir)

  let launched = false
  if (options.launch) {
    try {
      const openResult = await openInstance(newDir)
      launched = Boolean(openResult.ok)
    } catch {
      launched = false
    }
  }

  return {
    ok: true,
    action: 'create',
    dir: newDir,
    message: `Instance '${sanitizedName}' created.`,
    data: {
      dir: newDir,
      name: sanitizedName,
      launched,
    },
    needsBrowserDance: true,
  }
}

// ----------------------------------------------------------------------------
// Remove (guarded delete)
// ----------------------------------------------------------------------------

export interface RemoveInstanceOptions {
  /** Must equal the folder leaf name of `dir`, or the call is refused. */
  confirmName?: string
  /** Injected process scan (tests). Defaults to the real fresh {@link scanClaudeProcesses}. */
  scanProcesses?: (options: { fresh: true }) => Promise<ClaudeProcessScan>
}

/**
 * Guarded delete of an instance data directory. Refuses when:
 *   - `dir` is empty or does not exist
 *   - `dir` resolves to the default Claude profile dir (never deletable)
 *   - `dir` is not under `instancesRoot()`
 *   - `confirmName` does not exactly match the folder leaf name
 *   - the instance is currently running
 * On success, recursively removes the directory and returns the best-effort
 * byte count freed.
 */
export async function removeInstance(
  dir: string,
  options: RemoveInstanceOptions = {},
): Promise<CMActionResult> {
  if (!dir || dir.trim().length === 0) {
    return {
      ok: false,
      action: 'remove',
      dir: dir || null,
      message: 'Instance directory cannot be empty.',
      data: {},
    }
  }

  const normDir = normalizePath(dir)

  if (!existsSync(normDir)) {
    return {
      ok: false,
      action: 'remove',
      dir: normDir,
      message: `Instance directory does not exist: '${normDir}'.`,
      data: {},
    }
  }

  // --- Guard 1: default Claude data dir is never deletable. ---
  // Shared with quitInstance's guard and with CMInstance.isDefault, so all three agree about which
  // dir IS the regular install — see isDefaultClaudeDir, which also explains why the case fold it
  // replaced here was wrong on POSIX.
  if (isDefaultClaudeDir(normDir)) {
    return {
      ok: false,
      action: 'remove',
      dir: normDir,
      message: `Refusing to delete the default Claude data directory '${normDir}'. This is protected.`,
      data: {},
    }
  }

  // --- Guard 2: must be under instancesRoot(). ---
  const root = normalizePath(instancesRoot())
  if (!isPathInside(root, normDir)) {
    return {
      ok: false,
      action: 'remove',
      dir: normDir,
      message: `Refusing to delete '${normDir}': it is not under the instances root '${root}'.`,
      data: {},
    }
  }

  // --- Guard 3: must not be currently running, AND WE MUST ACTUALLY KNOW THAT. ---
  //
  // Audit AH-02: this guard used to read `listClaudeProcesses`, whose contract folds "could not
  // enumerate" into an empty list. The catch below looked like fail-closed but never fired,
  // because the scanner swallowed its own failure first - a transient PowerShell/CIM error during
  // a confirmed delete authorized removing a profile a desktop app was still writing into
  // (reproduced with an injected spawn failure against a synthetic profile). `scanClaudeProcesses`
  // keeps the two states apart, and UNKNOWN refuses.
  try {
    // fresh: this guard is the only thing standing between "delete the profile tree" and a live
    // instance writing into it. It must never clear on a cached snapshot.
    const scan = await (options.scanProcesses ?? scanClaudeProcesses)({ fresh: true })
    if (!scan.ok) {
      return {
        ok: false,
        action: 'remove',
        dir: normDir,
        message: `Could not verify whether '${normDir}' is running (${scan.reason}). Refusing to delete: an unknown state is not a stopped instance. Retry once process enumeration works.`,
        data: { runningState: 'unknown', reason: scan.reason },
      }
    }
    const running = scan.processes.find((p) => p.dir && normalizePath(p.dir) === normDir)
    if (running) {
      return {
        ok: false,
        action: 'remove',
        dir: normDir,
        message: `Refusing to delete '${normDir}': instance is currently running (PID ${running.pid}). Quit it first.`,
        data: { runningState: 'running', pid: running.pid },
      }
    }
  } catch (err) {
    // If we can't verify running state, fail closed rather than risk deleting a live instance.
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'remove',
      dir: normDir,
      message: `Could not verify running state for '${normDir}' (${message}). Refusing delete to be safe.`,
      data: { runningState: 'unknown', reason: message },
    }
  }

  // --- Guard 4: confirmName must equal the folder leaf name. ---
  const leafName = basename(normDir)
  if (!options.confirmName || options.confirmName !== leafName) {
    return {
      ok: false,
      action: 'remove',
      dir: normDir,
      message: `Refusing to delete '${normDir}': confirmName must exactly match the folder name '${leafName}'.`,
      data: {},
    }
  }

  // --- All guards passed: compute freed bytes (best-effort), then delete. ---
  const freedBytes = dirSizeBytes(normDir)

  try {
    rmSync(normDir, { recursive: true, force: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'remove',
      dir: normDir,
      message: `Failed to delete '${normDir}': ${message}`,
      data: { freedBytes: 0 },
    }
  }

  // Drop any UI metadata (label/icon/color) so the meta file doesn't accrete orphan entries.
  deleteInstanceMeta(normDir)

  // Clear the link on any CLI instance associated with this desktop dir. Left alone, a linked CLI
  // instance would become a ghost: still "linked" (so CliInstancesSection's unlinkedCliInstances
  // filter hides it from the standalone CLI table) even though the desktop row it was linked to no
  // longer exists — invisible and unmanageable. Unlinking returns it to the CLI Instances table.
  for (const cli of listCliInstances()) {
    const linkedDir = cli.associatedDesktopDir ? normalizePath(cli.associatedDesktopDir) : null
    if (linkedDir === normDir) {
      linkCliInstanceToDesktop(cli.id, null, null)
    }
  }

  return {
    ok: true,
    action: 'remove',
    dir: normDir,
    message: `Instance '${leafName}' deleted.`,
    data: { freedBytes },
  }
}
