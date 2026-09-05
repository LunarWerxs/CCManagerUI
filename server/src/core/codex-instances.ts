import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CODEX_HOME, CONFIG_DIR, resolveCodexExe } from '../config'
import type { CodexInstance } from '../types'
import { localCodexAccount } from './codex-account'
import {
  type CodexDesktopRuntime,
  codexDesktopRunState,
  codexDesktopUserDataDir,
  codexPathKey,
  defaultCodexDesktopUserDataDir,
  focusCodexDesktop,
  listCodexDesktopProcesses,
  openCodexDesktop,
  quitCodexDesktop,
  type ScanDesktopProcesses,
  scanCodexDesktopProcesses,
} from './codex-desktop'
import { instanceNumbers, instanceRef } from './instance-numbers'
import {
  describeStoreRefusal,
  type JsonStoreMutation,
  type JsonStoreSpec,
  mutateJsonStore,
  readJsonStore,
} from './json-store'
import { CODEX_LAUNCH_EFFORTS, type LaunchOptionsInput, launchOptionError } from './launch-options'
import { isPathInside, normalizePath } from './paths'
import type { CMActionResult } from './shared'

const CODEX_INSTANCES_ROOT = join(CONFIG_DIR, 'codex-instances')
const STORE_PATH = join(CONFIG_DIR, 'codex-instances.json')
const NAME_MAX = 60

/** The store deliberately does NOT hold `num`: the number registry (core/instance-numbers.ts) owns
 *  it, so there is exactly one place it can be assigned from and no stale mirror to reconcile. */
type StoredCodexInstance = Omit<
  CodexInstance,
  | 'num'
  | 'loggedIn'
  | 'account'
  | 'desktopUserDataDir'
  | 'isDesktopRunning'
  | 'desktopPid'
  | 'isExternal'
  | 'isDefault'
>

interface Store {
  instances: StoredCodexInstance[]
}

// Persistence goes through core/json-store.ts, exactly as cli-instances.ts's does: a corrupt or
// unreadable registry is never mistaken for an empty one, writes are atomic, and mutations hold
// the interprocess lock shared with the quick-instance daemon. See that file for the why.

const STORE_WHAT = 'Codex instance registry'

const STORE_SPEC: JsonStoreSpec<Store> = {
  path: STORE_PATH,
  decode: (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null
    const instances = (parsed as { instances?: unknown }).instances
    if (!Array.isArray(instances)) return null
    return { instances: instances as StoredCodexInstance[] }
  },
  empty: () => ({ instances: [] }),
}

let reportedStoreFailure: string | null = null

/** READERS: the store, or empty when missing. A damaged file also reads as empty - logged once,
 *  never written back; every mutator refuses on the same condition. */
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
      `[codex-instances] ${STORE_PATH} is ${read.status} (${read.reason}). Listing no stored Codex instances and refusing every change until it is repaired; the file has NOT been modified.`,
    )
  }
  return STORE_SPEC.empty()
}

function mutate<R>(fn: (store: Store) => { result: R; changed: boolean }): JsonStoreMutation<R> {
  return mutateJsonStore(STORE_SPEC, fn)
}

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

/** The on-disk layout versus the registry; the Codex twin of reconcileCliInstanceDirs. */
export interface CodexInstanceReconciliation {
  registry: 'ok' | 'missing' | 'corrupt' | 'unreadable'
  orphanDirs: string[]
  missingDirs: Array<{ id: string; name: string; codexHome: string }>
}

/** READ-ONLY report of CODEX_HOMEs no record claims and records whose home is gone. */
export function reconcileCodexInstanceDirs(): CodexInstanceReconciliation {
  const read = readJsonStore(STORE_SPEC)
  const records = read.status === 'ok' ? read.value.instances : []
  const claimed = new Set(records.map((rec) => basename(rec.codexHome)))
  let orphanDirs: string[] = []
  try {
    if (existsSync(CODEX_INSTANCES_ROOT)) {
      orphanDirs = readdirSync(CODEX_INSTANCES_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !claimed.has(entry.name))
        .map((entry) => join(CODEX_INSTANCES_ROOT, entry.name))
        .sort()
    }
  } catch {
    // An unreadable root reports no orphans; the registry status says whether to trust it.
  }
  const missingDirs = records
    .map((rec) => ({ id: rec.id, name: rec.name, codexHome: rec.codexHome }))
    .filter((rec) => !existsSync(rec.codexHome))
  return { registry: read.status, orphanDirs, missingDirs }
}

export function isCodexLoggedIn(codexHome: string): boolean {
  try {
    return existsSync(join(codexHome, 'auth.json'))
  } catch {
    return false
  }
}

/** An instance row before its number is stamped on. Every builder below produces this shape; the
 *  number is attached in ONE place (numbered/withNumbers) so a row can never escape without one. */
type UnnumberedCodexInstance = Omit<CodexInstance, 'num'>

/** Stamp the permanent number onto a whole list in a single registry read/write. */
function withNumbers(rows: UnnumberedCodexInstance[]): CodexInstance[] {
  const numbers = instanceNumbers(rows.map((r) => instanceRef('codex', r.id)))
  return rows.map((row) => ({ ...row, num: numbers.get(instanceRef('codex', row.id)) ?? 0 }))
}

function hydrate(
  instance: StoredCodexInstance,
  runtime: CodexDesktopRuntime | null = null,
): UnnumberedCodexInstance {
  return {
    ...instance,
    loggedIn: isCodexLoggedIn(instance.codexHome),
    // Eager, because it is cheap here: auth.json is plain JSON and the identity is a base64 payload
    // decode, so the Codex table gets an email/plan on first paint with no extra request. The live
    // usage route refreshes the plan from the server-computed value (see codex-account.ts).
    account: localCodexAccount(instance.codexHome),
    desktopUserDataDir: codexDesktopUserDataDir(instance.codexHome),
    isDesktopRunning: runtime !== null,
    desktopPid: runtime?.pid ?? null,
    isExternal: false,
    isDefault: false,
  }
}

/** Stable synthetic id for the default install. Not a uuid, so it can never collide with a stored
 *  row and is recognizable in a usage cache key (`codex:default`). */
export const DEFAULT_CODEX_INSTANCE_ID = 'default'

/** Synthetic id for a Codex Desktop discovered running from an unrecognized profile. */
const externalIdFor = (userDataDir: string): string => `external:${codexPathKey(userDataDir)}`

/**
 * The rows this app did not create: the DEFAULT Codex install, plus any Codex Desktop running from
 * a profile that belongs to no stored instance.
 *
 * Why this exists: before it, `listCodexInstances` returned only rows created through this app, so a
 * user with a perfectly normal Codex Desktop running saw an empty table and the message "No Codex
 * instances found" (owner-reported 2026-08-07). The Claude side already lists such installs via
 * `CMInstance.isExternal`; this is the same rule for Codex.
 *
 * The default install is listed WHETHER OR NOT it is running, because its identity lives in
 * CODEX_HOME on disk and is readable either way — the same reason the Claude table resolves stopped
 * instances. Its profile path is taken from the running process when there is one (authoritative,
 * no platform guessing) and from the documented default otherwise.
 */
function discoveredInstances(
  runtimes: CodexDesktopRuntime[],
  claimed: Set<string>,
): UnnumberedCodexInstance[] {
  const out: UnnumberedCodexInstance[] = []

  const defaultProfile = defaultCodexDesktopUserDataDir()
  const defaultKey = codexPathKey(defaultProfile)
  const defaultRuntime = runtimes.find((r) => codexPathKey(r.desktopUserDataDir) === defaultKey)
  if (!claimed.has(codexPathKey(CODEX_HOME))) {
    out.push({
      id: DEFAULT_CODEX_INSTANCE_ID,
      name: basename(CODEX_HOME),
      codexHome: CODEX_HOME,
      loggedIn: isCodexLoggedIn(CODEX_HOME),
      account: localCodexAccount(CODEX_HOME),
      desktopUserDataDir: defaultRuntime?.desktopUserDataDir ?? defaultProfile,
      isDesktopRunning: defaultRuntime !== undefined,
      desktopPid: defaultRuntime?.pid ?? null,
      isExternal: true,
      isDefault: true,
      createdAt: 0,
    })
  }

  for (const runtime of runtimes) {
    const key = codexPathKey(runtime.desktopUserDataDir)
    if (key === defaultKey) continue // already the default row above
    // A profile we launched sits at <codexHome>/desktop, so the parent IS the CODEX_HOME. For a
    // profile someone else chose that inference can be wrong, which is why the row is flagged
    // external: it is listed and readable, never renamed or deleted.
    const codexHome = dirname(runtime.desktopUserDataDir)
    if (claimed.has(codexPathKey(codexHome))) continue
    claimed.add(codexPathKey(codexHome))
    out.push({
      id: externalIdFor(runtime.desktopUserDataDir),
      name: basename(codexHome),
      codexHome,
      loggedIn: isCodexLoggedIn(codexHome),
      account: localCodexAccount(codexHome),
      desktopUserDataDir: runtime.desktopUserDataDir,
      isDesktopRunning: true,
      desktopPid: runtime.pid,
      isExternal: true,
      isDefault: false,
      createdAt: 0,
    })
  }

  return out
}

export interface ListCodexInstancesOptions {
  listDesktopProcesses?: () => Promise<CodexDesktopRuntime[]>
}

export async function listCodexInstances(
  options: ListCodexInstancesOptions = {},
): Promise<CodexInstance[]> {
  const runtimes = await (options.listDesktopProcesses ?? listCodexDesktopProcesses)()
  const runtimeByDir = new Map(
    runtimes.map((runtime) => [normalizePath(runtime.desktopUserDataDir), runtime]),
  )
  const stored = readStore().instances.map((instance) =>
    hydrate(
      instance,
      runtimeByDir.get(normalizePath(codexDesktopUserDataDir(instance.codexHome))) ?? null,
    ),
  )
  // Stored rows claim their CODEX_HOME first, so discovery can never duplicate one that this app
  // manages (e.g. an instance deliberately pointed at the default home).
  const claimed = new Set(stored.map((instance) => codexPathKey(instance.codexHome)))
  return withNumbers([...stored, ...discoveredInstances(runtimes, claimed)])
}

/**
 * One STORED instance by id. Stays synchronous, and stays store-only, because every caller is a
 * mutating action (launch / open / quit / rename / delete) and those apply solely to instances this
 * app created — a discovered row has no store entry to act on.
 */
export function getCodexInstance(id: string): CodexInstance | null {
  const instance = readStore().instances.find((candidate) => candidate.id === id)
  return instance ? (withNumbers([hydrate(instance)])[0] ?? null) : null
}

/**
 * One instance by id INCLUDING the discovered ones, for the read-only routes (account, usage) —
 * so the default install's identity and quota are readable exactly like a stored instance's.
 *
 * Falls back to the (cached) process scan only when the id is not in the store, so the common
 * stored-row lookup stays a pure file read.
 */
/**
 * Resolve an id that may be a DISCOVERED instance rather than one this app created.
 *
 * Takes the same process-listing override as listCodexInstances, and forwards it. Without that a
 * caller (or a test) resolving an id has no way to avoid enumerating the machine's real desktop
 * processes, which on Windows means shelling out: a test asserting only that ids resolve was doing
 * a full process sweep, and timed out on a cold CI runner at five seconds.
 */
export async function findCodexInstance(
  id: string,
  options: ListCodexInstancesOptions = {},
): Promise<CodexInstance | null> {
  const stored = getCodexInstance(id)
  if (stored) return stored
  if (id !== DEFAULT_CODEX_INSTANCE_ID && !id.startsWith('external:')) return null
  return (await listCodexInstances(options)).find((candidate) => candidate.id === id) ?? null
}

function validName(name: string): string | null {
  const value = (name ?? '').trim()
  if (!value) return 'Name cannot be empty.'
  if (value.length > NAME_MAX) return `Name must be ≤ ${NAME_MAX} chars.`
  return null
}

export function createCodexInstance(name: string): CMActionResult {
  const reason = validName(name)
  if (reason)
    return {
      ok: false,
      action: 'codex-create',
      dir: null,
      message: reason,
      data: { name },
    }

  const id = crypto.randomUUID()
  const codexHome = join(CODEX_INSTANCES_ROOT, id)
  try {
    mkdirSync(codexHome, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      action: 'codex-create',
      dir: codexHome,
      message: `Failed to create CODEX_HOME '${codexHome}': ${error instanceof Error ? error.message : String(error)}`,
      data: { name },
    }
  }

  const instance: StoredCodexInstance = {
    id,
    name: name.trim(),
    codexHome,
    createdAt: Date.now(),
  }
  const outcome = mutate((store) => {
    store.instances.push(instance)
    return { result: null, changed: true }
  })
  if (!outcome.ok) {
    // The record never landed; take the freshly minted home back rather than leave an orphan.
    try {
      rmSync(codexHome, { recursive: true, force: true })
    } catch {
      // Best effort; reconcileCodexInstanceDirs reports it if it survives.
    }
    return refusal('codex-create', null, { name }, outcome)
  }
  return {
    ok: true,
    action: 'codex-create',
    dir: codexHome,
    message: `Codex instance '${instance.name}' created. Use Log in to authenticate it.`,
    data: { id, codexHome },
  }
}

export function renameCodexInstance(id: string, name: string): CMActionResult {
  const reason = validName(name)
  if (reason)
    return {
      ok: false,
      action: 'codex-rename',
      dir: null,
      message: reason,
      data: { id },
    }
  const outcome = mutate((store) => {
    const instance = store.instances.find((candidate) => candidate.id === id)
    if (!instance) return { result: null, changed: false }
    instance.name = name.trim()
    return { result: instance.codexHome, changed: true }
  })
  if (!outcome.ok) return refusal('codex-rename', null, { id }, outcome)
  if (outcome.result === null)
    return {
      ok: false,
      action: 'codex-rename',
      dir: null,
      message: 'Codex instance not found.',
      data: { id },
    }
  return {
    ok: true,
    action: 'codex-rename',
    dir: outcome.result,
    message: 'Renamed.',
    data: { id },
  }
}

export interface DeleteCodexInstanceOptions {
  /** Legacy/test injection: a plain runtime list, treated as a SUCCESSFUL scan. */
  listDesktopProcesses?: () => Promise<CodexDesktopRuntime[]>
  /** Injected scan that can also say "could not enumerate"; wins over listDesktopProcesses. */
  scanDesktopProcesses?: ScanDesktopProcesses
  /** Injected recursive remove, for tests that need the filesystem step to fail on every OS. */
  removeDir?: (dir: string) => void
}

/**
 * Guarded delete. Refuses when the name does not confirm, when the desktop is running, and - since
 * audit AH-02 - when the OS could not say whether it is running: a failed process scan used to read
 * as "not running" and wave the delete through. Since AH-03 the record is also kept whenever the
 * CODEX_HOME survives the remove, instead of being dropped with a success message over a login
 * that is still on disk.
 */
export async function deleteCodexInstance(
  id: string,
  confirmName?: string,
  options: DeleteCodexInstanceOptions = {},
): Promise<CMActionResult> {
  const instance = readStore().instances.find((candidate) => candidate.id === id)
  if (!instance)
    return {
      ok: false,
      action: 'codex-delete',
      dir: null,
      message: 'Codex instance not found.',
      data: { id },
    }
  if (!confirmName || confirmName !== instance.name)
    return {
      ok: false,
      action: 'codex-delete',
      dir: instance.codexHome,
      message: `Refusing to delete: confirmName must exactly match '${instance.name}'.`,
      data: { id },
    }

  const legacyList = options.listDesktopProcesses
  const scan: ScanDesktopProcesses =
    options.scanDesktopProcesses ??
    (legacyList
      ? async () => ({ ok: true, runtimes: await legacyList() })
      : scanCodexDesktopProcesses)
  const runState = await codexDesktopRunState(instance, scan)
  if (runState.state === 'unknown') {
    return {
      ok: false,
      action: 'codex-delete',
      dir: instance.codexHome,
      message: `Could not verify whether this Codex Desktop instance is running (${runState.reason}). Refusing to delete: an unknown state is not a stopped instance. Retry once process enumeration works.`,
      data: { id, runningState: 'unknown', reason: runState.reason },
    }
  }
  if (runState.state === 'running') {
    return {
      ok: false,
      action: 'codex-delete',
      dir: instance.codexHome,
      message: 'Quit this Codex Desktop instance before deleting it.',
      data: { id, runningState: 'running', pid: runState.runtime.pid },
    }
  }

  if (isPathInside(CODEX_INSTANCES_ROOT, instance.codexHome)) {
    const removeDir =
      options.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }))
    try {
      removeDir(instance.codexHome)
    } catch (error) {
      return {
        ok: false,
        action: 'codex-delete',
        dir: instance.codexHome,
        message: `Could not delete '${instance.codexHome}': ${error instanceof Error ? error.message : String(error)}. The instance record was kept so it can be retried; its login data is still on disk.`,
        data: { id, partial: true },
      }
    }
    if (existsSync(instance.codexHome)) {
      return {
        ok: false,
        action: 'codex-delete',
        dir: instance.codexHome,
        message: `'${instance.codexHome}' still exists after the delete (something is holding it open). The instance record was kept so it can be retried; its login data is still on disk.`,
        data: { id, partial: true },
      }
    }
  }
  const outcome = mutate((store) => {
    const index = store.instances.findIndex((candidate) => candidate.id === id)
    if (index < 0) return { result: false, changed: false }
    store.instances.splice(index, 1)
    return { result: true, changed: true }
  })
  if (!outcome.ok)
    return refusal('codex-delete', instance.codexHome, { id, dirRemoved: true }, outcome)
  return {
    ok: true,
    action: 'codex-delete',
    dir: instance.codexHome,
    message: `Codex instance '${instance.name}' deleted.`,
    data: { id },
  }
}

function missingCodexInstance(action: string, id: string): CMActionResult {
  return {
    ok: false,
    action,
    dir: null,
    message: 'Codex instance not found.',
    data: { id },
  }
}

export async function openCodexDesktopInstance(id: string): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  return instance ? openCodexDesktop(instance) : missingCodexInstance('codex-desktop-open', id)
}

export async function focusCodexDesktopInstance(id: string): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  return instance ? focusCodexDesktop(instance) : missingCodexInstance('codex-desktop-focus', id)
}

export async function quitCodexDesktopInstance(id: string): Promise<CMActionResult> {
  const instance = getCodexInstance(id)
  return instance ? quitCodexDesktop(instance) : missingCodexInstance('codex-desktop-quit', id)
}

export interface CodexLaunchOptions extends LaunchOptionsInput {
  login?: boolean
}

export function launchCodexInstance(id: string, options: CodexLaunchOptions = {}): CMActionResult {
  const instance = getCodexInstance(id)
  if (!instance)
    return {
      ok: false,
      action: 'codex-launch',
      dir: null,
      message: 'Codex instance not found.',
      data: { id },
    }

  const optionError = options.login ? null : launchOptionError(options, CODEX_LAUNCH_EFFORTS)
  if (optionError)
    return {
      ok: false,
      action: 'codex-launch',
      dir: instance.codexHome,
      message: optionError,
      data: { id },
    }

  const exe = resolveCodexExe()
  const args: string[] = options.login ? ['login'] : []
  if (!options.login && typeof options.model === 'string') args.push('--model', options.model)
  if (!options.login && typeof options.effort === 'string')
    args.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`)
  const env = {
    ...(process.env as Record<string, string>),
    CODEX_HOME: instance.codexHome,
  }

  try {
    if (process.platform === 'win32') {
      const inner = [`"${exe}"`, ...args.map((arg) => JSON.stringify(arg))].join(' ')
      Bun.spawn(['cmd', '/c', 'start', '', 'cmd', '/k', inner], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        // Hide only the transient launcher cmd; `start` still creates the visible inner terminal.
        windowsHide: true,
      })
    } else if (process.platform === 'darwin') {
      const command = `CODEX_HOME=${JSON.stringify(instance.codexHome)} ${JSON.stringify(exe)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`
      Bun.spawn([
        'osascript',
        '-e',
        `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      ])
    } else {
      const command = `${JSON.stringify(exe)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}; exec bash`
      Bun.spawn(['x-terminal-emulator', '-e', 'bash', '-lc', command], {
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
    }
  } catch (error) {
    return {
      ok: false,
      action: options.login ? 'codex-login' : 'codex-launch',
      dir: instance.codexHome,
      message: `Failed to open a terminal: ${error instanceof Error ? error.message : String(error)}`,
      data: { id },
    }
  }

  return {
    ok: true,
    action: options.login ? 'codex-login' : 'codex-launch',
    dir: instance.codexHome,
    message: options.login
      ? 'Opened Codex login in a terminal.'
      : 'Launched a terminal for this Codex instance.',
    data: { id, codexHome: instance.codexHome },
  }
}
