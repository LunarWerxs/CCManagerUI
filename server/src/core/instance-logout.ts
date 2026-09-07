// server/src/core/instance-logout.ts — sign one isolated Claude Desktop instance out.
//
// WHAT A LOGIN ACTUALLY IS HERE, and therefore what a logout has to remove. An instance's whole
// credential lives in `<dir>/config.json`: `lastKnownAccountUuid` names the account, and
// `oauth:tokenCacheV2` (older builds: `oauth:tokenCache`) holds the safeStorage-encrypted grants
// blob that `core/accounts.ts` decrypts to read a token. Delete those three keys and the profile is
// signed out; the app asks for a login the next time it starts. Nothing else in the profile is
// touched, so history, settings and the folder itself survive.
//
// ⛔ IT REFUSES WHILE THE INSTANCE IS RUNNING, and that refusal is the whole safety story. Claude
// Desktop is an Electron app holding config.json open, and it re-saves that file on its own
// schedule: a logout written underneath it is either clobbered seconds later (so the button lied)
// or interleaved with the app's own write (so the profile is corrupt and the account is not signed
// out either). Neither failure announces itself. Quit the instance first, which the UI says.
//
// ⛔ AND IT IS NOT A DELETE. The one adjacent operation people conflate with this removes the
// profile folder; this leaves everything and only forgets who was signed in. It is still not
// nothing — logging back in costs the "Browser Dance" (quit the other instances first), which is
// why the UI asks before doing it.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { deleteAccountsCacheEntry } from './accounts'
import { normalizePath } from './paths'
import { listClaudeProcesses } from './process'
import type { CMActionResult } from './shared'

/** Every key in config.json that carries a credential or names the signed-in account. */
const LOGIN_KEYS = ['lastKnownAccountUuid', 'oauth:tokenCacheV2', 'oauth:tokenCache'] as const

export interface LogoutInstanceOptions {
  /** Injected for tests; defaults to the real process scan. */
  listProcesses?: typeof listClaudeProcesses
}

/**
 * Remove the stored login from an instance profile.
 *
 * Returns a status-carrying result rather than throwing, matching every other lifecycle action
 * here. `data.removed` names the keys that were actually present, so a caller can tell "signed out"
 * from "there was nothing to sign out of" instead of both looking like success.
 */
export async function logoutInstance(
  dir: string,
  options: LogoutInstanceOptions = {},
): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  const configPath = path.join(normDir, 'config.json')

  if (!existsSync(configPath)) {
    return {
      ok: false,
      action: 'logout',
      dir: normDir,
      message: 'That instance has no config.json, so there is no login stored to remove.',
      data: { removed: [] },
    }
  }

  // --- Guard: never write this file under a running app. See the header. ---
  const listProcesses = options.listProcesses ?? listClaudeProcesses
  try {
    const procs = await listProcesses()
    const running = procs.some((p) => p.dir && normalizePath(p.dir) === normDir)
    if (running) {
      return {
        ok: false,
        action: 'logout',
        dir: normDir,
        message:
          'That instance is running. Claude Desktop holds its config open and re-saves it, so a logout written now would be undone or corrupt the profile. Quit the instance first, then log out.',
        data: { removed: [] },
      }
    }
  } catch {
    // A failed process scan is NOT permission to proceed: the guard exists precisely for the case
    // we cannot rule out, so an unreadable process list refuses too.
    return {
      ok: false,
      action: 'logout',
      dir: normDir,
      message:
        'Could not check whether that instance is running, and logging out under a running app can corrupt the profile. Try again in a moment.',
      data: { removed: [] },
    }
  }

  let config: Record<string, unknown>
  try {
    const raw = readFileSync(configPath, 'utf8')
    config = raw?.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch (err) {
    return {
      ok: false,
      action: 'logout',
      dir: normDir,
      message: `Could not read that instance's config.json: ${err instanceof Error ? err.message : String(err)}`,
      data: { removed: [] },
    }
  }

  const removed = LOGIN_KEYS.filter((k) => k in config)
  if (removed.length === 0) {
    // Still clears our cached identity below: a stale cache entry would keep the row claiming an
    // account the profile no longer holds.
    deleteAccountsCacheEntry(normDir)
    return {
      ok: true,
      action: 'logout',
      dir: normDir,
      message: 'That instance was already signed out.',
      data: { removed: [] },
    }
  }
  for (const k of removed) delete config[k]

  // Write beside it and rename over, so a failure mid-write can never leave a half-written
  // config.json — the one file whose loss would strand the profile.
  try {
    const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
    renameSync(tmp, configPath)
  } catch (err) {
    return {
      ok: false,
      action: 'logout',
      dir: normDir,
      message: `Could not write that instance's config.json: ${err instanceof Error ? err.message : String(err)}`,
      data: { removed: [] },
    }
  }

  // Our own identity cache remembers who this dir belonged to. Left behind, the table would go on
  // showing the old account's email against a profile that is now signed out.
  deleteAccountsCacheEntry(normDir)

  return {
    ok: true,
    action: 'logout',
    dir: normDir,
    message: 'Signed out. That instance will ask for a login the next time it starts.',
    data: { removed: [...removed] },
  }
}
