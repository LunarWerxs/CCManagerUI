// server/src/core/instances.ts: instance discovery + open/quit (PLAN.md §2).
// Adapted verbatim (behavior) from an internal LunarWerx tool's instance discovery module;
// the import paths were adapted (./shared instead of ../../../shared/index.ts, no .ts
// extensions to match this repo's convention), and openInstance's no-binary failure message
// is now MSIX-aware (core/desktop-install.ts) instead of the ported generic one.
//
// Depends on:
//   core/paths.ts    : instancesRoot(), resolveLaunchBinary(), launchArgs(dir), normalizePath()
//   core/process.ts  : listClaudeProcesses(): CMProcessInfo[] (per-OS main-process enumeration,
//                       already filtered to exclude Electron `--type=` children and parsed for
//                       `--user-data-dir`)
//   core/shared.ts    : CMInstance, CMActionResult DTOs
//
// Nothing here throws for expected failure conditions (missing dirs, no processes found, spawn
// failures, permission errors); every public function returns a status-carrying result instead.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildDetachedSpawn } from '../detached-spawn.mjs'
import { detectDesktopInstall } from './desktop-install'
import { readInstanceMetaMap } from './instance-meta'
import { instanceNumbers, instanceRef } from './instance-numbers'
import {
  currentPlatform,
  defaultClaudeDir,
  instancesRoot,
  isPathInside,
  launchArgs,
  normalizePath,
  resolveLaunchBinary,
} from './paths'
import {
  type CMProcessInfo,
  invalidateClaudeProcessCache,
  type ListClaudeProcessesOptions,
  listClaudeProcesses,
} from './process'
import type { CMActionResult, CMInstance } from './shared'

// ----------------------------------------------------------------------------
// Discovery
// ----------------------------------------------------------------------------

/** Metadata for one discovered instance dir, prior to attaching running-state. */
interface DiscoveredMeta {
  name: string
  dir: string // normalized
  isExternal: boolean
}

/**
 * Enumerates the subdirectories of `instancesRoot()`. Best-effort: a missing root
 * (first run) or a listing error yields an empty array rather than throwing.
 */
function listInstanceRootDirs(): DiscoveredMeta[] {
  const root = instancesRoot()
  const out: DiscoveredMeta[] = []
  try {
    if (!existsSync(root)) return out
    const entries = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      try {
        if (!entry.isDirectory()) continue
        const full = normalizePath(`${root}/${entry.name}`)
        out.push({ name: entry.name, dir: full, isExternal: false })
      } catch {
        // Skip anything we can't stat/read (permissions, race with deletion, etc.).
      }
    }
  } catch {
    // Root unreadable; treat as "no known instances", callers still see running ones.
  }
  return out
}

/** Best-effort recursive byte size of a directory. Returns undefined on any failure. */
function dirSizeBytes(dir: string): number | undefined {
  try {
    if (!existsSync(dir)) return undefined
    let total = 0
    const stack: string[] = [dir]
    while (stack.length) {
      const current = stack.pop()
      if (current === undefined) continue
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        continue // locked/permission-denied subdir, skip it and keep summing the rest
      }
      for (const name of entries) {
        const full = `${current}/${name}`
        try {
          const st = statSync(full)
          if (st.isDirectory()) stack.push(full)
          else if (st.isFile()) total += st.size
        } catch {
          // Individual file/dir vanished or is locked; skip, best-effort only.
        }
      }
    }
    return total
  } catch {
    return undefined
  }
}

/**
 * Which account an instance is signed into right now: `<dir>/config.json`'s `lastKnownAccountUuid`
 * (null when signed out, unreadable, or malformed).
 *
 * This is the ONLY part of account identity cheap enough to ship with every list response — the
 * rest needs a safeStorage decrypt and a profile call (core/accounts.ts). It exists so the UI can
 * notice that an instance was re-logged into a DIFFERENT account and re-resolve, instead of
 * showing the identity it resolved once forever.
 *
 * Deliberately un-memoized: these files run 3–9 KB, so re-reading one per instance per poll tick
 * is far cheaper than the staleness a stat-keyed cache would risk (an account switch rewrites
 * config.json to the SAME size, since one uuid is exactly as long as another). Identity only —
 * never reads or returns a token. Never throws.
 */
export function readLoginUuid(instanceDir: string): string | null {
  return readLoginState(instanceDir).uuid
}

/**
 * ⛔ 'SIGNED OUT' AND 'I COULD NOT READ THE PROFILE' ARE DIFFERENT PROBLEMS, and `readLoginUuid`
 * answers null to both. That single boolean is what the fleet reports, so a config.json that a
 * crash left half-written is announced to the owner as "instance #N is signed out - sign it in",
 * sending him to fix a login that was never broken while the real fault (a damaged profile) goes
 * unnamed. The uuid is unchanged for every existing caller; this just keeps the reason.
 *
 * `no-config` is separated from `unreadable` on purpose too: a directory with no config.json yet
 * is a NEW instance that has never been signed in, which is ordinary, while a config.json that
 * exists and will not parse is damage.
 */
export type LoginState =
  | { uuid: string; reason: 'signed-in' }
  | { uuid: null; reason: 'signed-out' | 'no-config' | 'unreadable' }

export function readLoginState(instanceDir: string): LoginState {
  if (!instanceDir?.trim()) return { uuid: null, reason: 'unreadable' }
  let raw: string
  try {
    raw = readFileSync(join(instanceDir, 'config.json'), 'utf8')
  } catch (err) {
    // Nothing there yet vs. something there we cannot read - only the second one is damage.
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { uuid: null, reason: missing ? 'no-config' : 'unreadable' }
  }
  if (!raw?.trim()) return { uuid: null, reason: 'unreadable' }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed.lastKnownAccountUuid === 'string'
      ? { uuid: parsed.lastKnownAccountUuid, reason: 'signed-in' }
      : { uuid: null, reason: 'signed-out' }
  } catch {
    return { uuid: null, reason: 'unreadable' }
  }
}

export interface ListInstancesOptions {
  /** Attach account identity (slow path: decrypt + one network call per instance). */
  includeAccount?: boolean
  /** Compute on-disk size per instance (walks the tree, can be slow for large profiles). */
  includeSize?: boolean
  /** Resolver used when includeAccount is set. Injected so instances.ts has no hard
   *  dependency on core/accounts.ts (kept decoupled + easy to unit test). */
  resolveAccount?: (
    dir: string,
  ) => Promise<CMInstance['account'] | null | undefined> | CMInstance['account'] | null | undefined
}

/**
 * Union of (a) subdirs of `instancesRoot()` and (b) dirs seen on a running Claude
 * process's `--user-data-dir`. One `CMInstance` per normalized dir. Dirs only seen
 * via a running process (i.e. launched from outside the instances root) are still
 * listed, flagged `isExternal: true`.
 */
export async function listInstances(options: ListInstancesOptions = {}): Promise<CMInstance[]> {
  const known = new Map<string, DiscoveredMeta>()
  for (const meta of listInstanceRootDirs()) known.set(meta.dir, meta)

  let procs: CMProcessInfo[] = []
  try {
    // includeChildren: one scan yields both the main process per dir (for pid/startTime/running)
    // AND every `--type=` child, so per-instance memory is the summed working set of the whole
    // Electron tree — not just the (small) main process. Same single CIM/ps call as before.
    procs = await listClaudeProcesses({ includeChildren: true })
  } catch {
    // Process enumeration failed entirely (e.g. wmic/ps unavailable); fall back to
    // "nothing is running", still surface the known instance dirs.
    procs = []
  }

  const runningByDir = new Map<string, CMProcessInfo>()
  const memoryByDir = new Map<string, number>()
  const root = normalizePath(instancesRoot())
  for (const proc of procs) {
    if (!proc.dir) continue
    const normDir = normalizePath(proc.dir)

    // Memory: sum every process (main + children) sharing this dir. WorkingSetSize double-counts
    // shared pages across the tree, same as Task Manager's per-process column — an accepted
    // approximation of "roughly how much RAM this instance uses".
    if (typeof proc.memoryBytes === 'number' && Number.isFinite(proc.memoryBytes)) {
      memoryByDir.set(normDir, (memoryByDir.get(normDir) ?? 0) + proc.memoryBytes)
    }

    // Running-state representative: the MAIN process only (it carries the pid + startTime we show);
    // keep the earliest-seen, defensive against duplicate scans.
    if (proc.isMain && !runningByDir.has(normDir)) runningByDir.set(normDir, proc)

    if (!known.has(normDir)) {
      const isUnderRoot = isPathInside(root, normDir)
      known.set(normDir, {
        name: basename(normDir),
        dir: normDir,
        isExternal: !isUnderRoot,
      })
    }
  }

  // One read of the presentation-metadata file (label/icon/color), keyed by normalized dir.
  const metaMap = readInstanceMetaMap()

  // …and one read of the number registry for the WHOLE fleet, which also assigns a number to any
  // instance seen for the first time. Bulk rather than per-row: this list runs on a refresh timer.
  const numbers = instanceNumbers([...known.values()].map((m) => instanceRef('desktop', m.dir)))

  const results: CMInstance[] = []
  for (const meta of known.values()) {
    results.push(
      await buildInstanceRow(meta, {
        options,
        running: runningByDir.get(meta.dir),
        memoryByDir,
        metaMap,
        numbers,
      }),
    )
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Is this dir the regular, NON-ISOLATED Claude Desktop profile (`claudeUserDataDir()`)?
 *
 * One answer, THREE callers, and they must never disagree: `removeInstance` refuses to delete that
 * profile (core/lifecycle.ts Guard 1), `quitInstance` refuses to kill it without confirmation, and
 * `buildInstanceRow` stamps `CMInstance.isDefault`, which is how a session labelled `'default'`
 * finds its account. A UI calling a row "the default install" while a guard called the same row an
 * ordinary instance would be lying in one of the places, and the lie you notice is the dangerous
 * one. Each of the three used to inline its own copy of this comparison.
 *
 * ⛔ CASE IS FOLDED ONLY ON WINDOWS, matching normalizePath's own rule — POSIX paths are
 * case-sensitive, so `~/.config/Claude` and `~/.config/claude` are two different directories there.
 * The inlined copies lowercased unconditionally, which on Linux/macOS quietly made a differently
 * cased isolated instance look like the default profile. That was merely over-cautious in the two
 * guards (they refuse more than they must); it is not survivable in `isDefault`, where a false
 * positive puts one account's address against another account's chat. The fold is kept explicit
 * rather than trusting normalizePath alone so a future change there cannot silently make the
 * Windows comparison case-sensitive.
 *
 * `dir` must already be normalized. Never throws: an unresolvable default dir means "not the
 * default", never an error out of a list.
 */
export function isDefaultClaudeDir(dir: string): boolean {
  let defaultDir = ''
  try {
    defaultDir = normalizePath(defaultClaudeDir())
  } catch {
    return false
  }
  if (!defaultDir) return false
  const fold = (p: string) => (currentPlatform() === 'win32' ? p.toLowerCase() : p)
  return fold(dir) === fold(defaultDir)
}

/** Builds one row of listInstances's result from its already-gathered per-dir inputs. */
async function buildInstanceRow(
  meta: DiscoveredMeta,
  ctx: {
    options: ListInstancesOptions
    running: CMProcessInfo | undefined
    memoryByDir: Map<string, number>
    metaMap: ReturnType<typeof readInstanceMetaMap>
    numbers: Map<string, number>
  },
): Promise<CMInstance> {
  const { options, running, memoryByDir, metaMap, numbers } = ctx
  let account: CMInstance['account'] = null
  if (options.includeAccount && options.resolveAccount) {
    try {
      account = (await options.resolveAccount(meta.dir)) ?? null
    } catch {
      account = null
    }
  }

  const sizeBytes = options.includeSize ? (dirSizeBytes(meta.dir) ?? null) : null
  const memoryBytes = running ? (memoryByDir.get(meta.dir) ?? null) : null
  const ui = metaMap[meta.dir]

  return {
    num: numbers.get(instanceRef('desktop', meta.dir)) ?? 0,
    name: meta.name,
    dir: meta.dir,
    isRunning: Boolean(running),
    pid: running?.pid ?? null,
    startTime: running?.startTime ?? null,
    sizeBytes,
    memoryBytes,
    account,
    loginUuid: readLoginUuid(meta.dir),
    isExternal: meta.isExternal,
    isDefault: isDefaultClaudeDir(meta.dir),
    label: ui?.label ?? null,
    icon: ui?.icon ?? null,
    color: ui?.color ?? null,
  }
}

// ----------------------------------------------------------------------------
// Open
// ----------------------------------------------------------------------------

/** The argv + spawn flag used to launch an instance so it OUTLIVES this daemon. */
export interface InstanceLaunch {
  argv: string[]
  /** Pass `detached: true` to Bun.spawn (POSIX only; creates a new session via setsid). */
  detached: boolean
}

/**
 * Builds the launch argv for an instance binary, per-OS, such that the launched Claude Desktop
 * is NOT a descendant of this daemon, so quitting AgentHydra can't take the instance with it.
 *
 * WHY this matters: the Windows tray host quits by tree-killing the daemon's whole process tree
 * (`taskkill /PID <daemon> /T /F`, see lunarwerx-ui/src/tray-host/Tray-Host.ts). A Claude Desktop
 * launched as a direct child of the daemon (plain `Bun.spawn([binary, ...args]).unref()`) is IN
 * that tree, so Quit drags the whole instance down with it.
 *
 * The Windows `cmd /c start ""` hand-off and the POSIX `detached:true` are the shared kit primitive
 * (buildDetachedSpawn — see server-lib/detached-spawn.mjs, which documents why `.unref()` /
 * `detached:true` don't break the Windows tree). The ONE app-specific twist here is darwin: we hand
 * the launch to LaunchServices via `open` (which locates + launches Claude Desktop itself, never as
 * our child) instead of spawning the resolved binary — so darwin is handled here and everything else
 * delegates to the primitive. Pure + exported so the detach contract is locked in by unit tests
 * (see instances-launch.test.ts).
 */
export function buildInstanceLaunch(
  platform: NodeJS.Platform,
  binary: string,
  args: string[],
): InstanceLaunch {
  // darwin: `open ...args` hands off to LaunchServices (already detached); the resolved binary is
  // intentionally dropped — `open` finds and launches the app itself.
  if (platform === 'darwin') return { argv: ['open', ...args], detached: false }
  // win32 (`cmd /c start ""` hand-off) + linux (setsid `detached:true`) share the kit primitive.
  return buildDetachedSpawn(platform, [binary, ...args])
}

/**
 * Opens (launches) the given instance dir. If already running, this is a no-op
 * that returns an "already running" success result (focusing the existing window
 * is left to the shell layer (out of scope for this app's browser+tray shell).
 */
export async function openInstance(dir: string): Promise<CMActionResult> {
  const normDir = normalizePath(dir)

  try {
    // fresh: this decides whether to LAUNCH. A cached snapshot a poll tick old could miss an
    // instance that just started (→ a second copy on the same profile) or still show one the
    // user just quit (→ a click that silently does nothing).
    const procs = await listClaudeProcesses({ fresh: true })
    const running = procs.find((p) => p.dir && normalizePath(p.dir) === normDir)
    if (running) {
      return {
        ok: true,
        action: 'open',
        dir: normDir,
        message: 'already running',
        data: { pid: running.pid },
      }
    }
  } catch {
    // Best-effort; if we can't determine running state, still attempt the launch
    // rather than silently failing here.
  }

  let binary: string | null = null
  try {
    binary = await resolveLaunchBinary()
  } catch {
    binary = null
  }

  if (!binary) {
    // Say WHY when we can: on Windows the usual culprit is the MSIX build (not launchable
    // with --user-data-dir, see core/desktop-install.ts), so the failure toast becomes
    // actionable instead of a dead end.
    let message = 'No Claude launch binary could be resolved.'
    try {
      const install = await detectDesktopInstall()
      if (install.platform === 'win32') {
        message = install.msixDetected
          ? 'Only the MSIX (Windows Apps) build of Claude Desktop is installed; it cannot be launched with an isolated profile. Install the classic Windows installer.'
          : 'No Claude Desktop installation was found. Install the classic Windows installer.'
      }
    } catch {
      // Detection is best-effort; keep the generic message.
    }
    return {
      ok: false,
      action: 'open',
      dir: normDir,
      message,
      data: {},
    }
  }

  try {
    const { argv, detached } = buildInstanceLaunch(process.platform, binary, launchArgs(normDir))
    const proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      ...(detached ? { detached: true } : {}),
    })
    proc.unref()
    // The world just changed under the cached snapshot — drop it so the poll tick that follows
    // this click shows the row as running instead of waiting out the TTL.
    invalidateClaudeProcessCache()
    return {
      ok: true,
      action: 'open',
      dir: normDir,
      message: 'launched',
      // NOTE: on win32/darwin `proc.pid` is the transient hand-off process (cmd/open), not the
      // instance; the instance's real PID is (re)discovered by the next listInstances() scan.
      data: { binary, pid: proc.pid },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'open',
      dir: normDir,
      message: `Failed to launch: ${message}`,
      data: {},
    }
  }
}

// ----------------------------------------------------------------------------
// Quit
// ----------------------------------------------------------------------------

export interface QuitInstanceOptions {
  /** Skip the graceful phase and force-kill immediately. */
  force?: boolean
  /** How long to wait for a graceful exit before force-killing (ms). Default 5000. */
  gracefulTimeoutMs?: number
  /**
   * Explicit confirmation required to quit the DEFAULT (non-isolated) Claude Desktop profile —
   * the user's real, externally-managed Claude Desktop (the "External" instance row). Without
   * this, quitInstance refuses up front, before any process is even enumerated: unlike an
   * isolated instance dir this app created, that profile may have a real, in-progress
   * conversation. Mirrors removeInstance()'s Guard 1 in core/lifecycle.ts — same protection,
   * quit-side. Ignored (no effect) for any other dir.
   */
  confirmExternal?: boolean
  /**
   * Process-list source, injected so tests can exercise the guard/kill path deterministically
   * without spawning real OS process enumeration or risking a real kill (mirrors
   * ListInstancesOptions.resolveAccount's injection style). Defaults to listClaudeProcesses.
   */
  listProcesses?: (options: ListClaudeProcessesOptions) => Promise<CMProcessInfo[]>
}

/** True once none of `pids` are alive anymore (best-effort liveness probe). */
function anyAlive(pids: number[]): boolean {
  for (const pid of pids) {
    try {
      // signal 0 = liveness probe only, doesn't actually kill (Node/Bun convention on all OSes).
      process.kill(pid, 0)
      return true
    } catch {
      // ESRCH (no such process) => this one's dead; keep checking the rest.
    }
  }
  return false
}

async function forceKillPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      const proc = Bun.spawn(['taskkill', '/pid', String(pid), '/f', '/t'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
      await proc.exited
    } catch {
      // Best-effort; process may have already exited between scan and kill.
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already dead or not ours; ignore.
  }
}

async function gracefulKillPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      // No /f: asks the process to close its main window first (best-effort graceful).
      const proc = Bun.spawn(['taskkill', '/pid', String(pid), '/t'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
      await proc.exited
    } catch {
      // Ignore; we'll force-kill on timeout regardless.
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already dead or not ours; ignore.
  }
}

/**
 * Finds every Claude process (main + `--type=` children) whose `--user-data-dir`
 * matches `dir`, tries a graceful shutdown first (unless `force`), then force-kills
 * anything still alive after the grace period. Returns the count actually stopped.
 */
export async function quitInstance(
  dir: string,
  options: QuitInstanceOptions = {},
): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5000

  // --- Guard: never quit the default (non-isolated) Claude Desktop profile without explicit
  // confirmation. This is the quit-side analog of removeInstance()'s Guard 1 (core/lifecycle.ts):
  // that dir is the user's REAL, externally-managed Claude Desktop, not an isolated instance this
  // app created, and may have a real conversation in progress. Checked (and refused) BEFORE any
  // process enumeration, so an unconfirmed quit of the default dir never even lists processes.
  // Shared with the row builder's `isDefault` flag, so the guard and the UI can never disagree
  // about which row IS the regular install — see isDefaultClaudeDir.
  if (isDefaultClaudeDir(normDir) && options.confirmExternal !== true) {
    return {
      ok: false,
      action: 'quit',
      dir: normDir,
      message:
        'Refusing to quit the regular (non-isolated) Claude Desktop without explicit confirmation: it may have a real conversation in progress. Pass confirmExternal to proceed.',
      data: { killedCount: 0 },
    }
  }

  const listProcesses = options.listProcesses ?? listClaudeProcesses

  let matched: CMProcessInfo[]
  try {
    // fresh: these PIDs are about to be KILLED. Acting on a cached snapshot risks signalling a
    // PID the OS has since handed to an unrelated process.
    const all = await listProcesses({ includeChildren: true, fresh: true })
    matched = all.filter((p) => p.dir && normalizePath(p.dir) === normDir)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'quit',
      dir: normDir,
      message: `Failed enumerating processes: ${message}`,
      data: { killedCount: 0 },
    }
  }

  if (matched.length === 0) {
    return {
      ok: true,
      action: 'quit',
      dir: normDir,
      message: 'not running',
      data: { killedCount: 0 },
    }
  }

  const pids = matched.map((p) => p.pid)

  if (!options.force) {
    const main = matched.find((p) => p.isMain) ?? matched[0]
    if (main) {
      await gracefulKillPid(main.pid)
      const deadline = Date.now() + gracefulTimeoutMs
      while (Date.now() < deadline && anyAlive(pids)) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  const stillAlive = pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

  let forceKilled = 0
  if (stillAlive.length > 0) {
    await Promise.all(
      stillAlive.map(async (pid) => {
        await forceKillPid(pid)
        forceKilled += 1
      }),
    )
  }

  const gracefullyStopped = pids.length - stillAlive.length
  const totalAccountedFor = Math.max(0, gracefullyStopped) + forceKilled

  // Same reason as openInstance's: the row the user just acted on must go grey on the very next
  // poll, not whenever the cached snapshot happens to age out.
  invalidateClaudeProcessCache()

  return {
    ok: true,
    action: 'quit',
    dir: normDir,
    message: `stopped ${totalAccountedFor} process(es)`,
    data: { killedCount: totalAccountedFor },
  }
}

// ----------------------------------------------------------------------------
// Focus
// ----------------------------------------------------------------------------

/** Runs a small PowerShell snippet that finds the first visible top-level window owned by
 *  `pid`, restores it if minimized, and brings it to the foreground via user32. Returns
 *  'focused' | 'no-window' | an error string. Never throws. */
async function focusWindowByPid(pid: number): Promise<'focused' | 'no-window' | string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Namespace AgentHydra -Name Win32 -MemberDefinition @"' +
      '\n[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);' +
      '\n[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' +
      '\n[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);' +
      '\n[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' +
      '\n[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' +
      '\npublic delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);' +
      '\n"@',
    `$targetPid = ${pid}`,
    '$found = [IntPtr]::Zero',
    '$callback = {',
    '  param([IntPtr]$hWnd, [IntPtr]$lParam)',
    '  $procId = 0',
    '  [void][AgentHydra.Win32]::GetWindowThreadProcessId($hWnd, [ref]$procId)',
    '  if ($procId -eq $targetPid -and [AgentHydra.Win32]::IsWindowVisible($hWnd)) {',
    '    $script:found = $hWnd',
    '    return $false',
    '  }',
    '  return $true',
    '}',
    '[void][AgentHydra.Win32]::EnumWindows($callback, [IntPtr]::Zero)',
    'if ($found -eq [IntPtr]::Zero) {',
    '  Write-Output "NO_WINDOW"',
    '} else {',
    '  [void][AgentHydra.Win32]::ShowWindow($found, 9)',
    '  $ok = [AgentHydra.Win32]::SetForegroundWindow($found)',
    '  if ($ok) { Write-Output "FOCUSED" } else { Write-Output "FOREGROUND_DENIED" }',
    '}',
  ].join('\n')

  type CaptureProc = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let proc: CaptureProc | null = null
  try {
    proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    }) as CaptureProc
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const trimmed = stdout.trim()
    if (trimmed.includes('FOCUSED')) return 'focused'
    if (trimmed.includes('NO_WINDOW')) return 'no-window'
    if (trimmed.includes('FOREGROUND_DENIED')) return 'foreground denied by Windows'
    if (exitCode !== 0) return stderr.trim() || `powershell exited with code ${exitCode}`
    return 'no-window'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Brings the running instance's main window to the foreground on Windows (PID-driven, via
 * user32 EnumWindows/SetForegroundWindow). Gracefully no-ops on non-Windows platforms and
 * when the instance isn't currently running.
 */
export async function focusInstance(dir: string): Promise<CMActionResult> {
  const normDir = normalizePath(dir)

  if (process.platform !== 'win32') {
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: 'not supported on this platform',
      data: {},
    }
  }

  let procs: CMProcessInfo[]
  try {
    // fresh: this resolves the PID whose window we are about to raise; a stale one is either a
    // dead PID or, worse, a recycled one belonging to something else entirely.
    procs = await listClaudeProcesses({ fresh: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: `Failed enumerating processes: ${message}`,
      data: {},
    }
  }

  const running = procs.find((p) => p.dir && normalizePath(p.dir) === normDir)
  if (!running) {
    return { ok: false, action: 'focus', dir: normDir, message: 'not running', data: {} }
  }

  try {
    const outcome = await focusWindowByPid(running.pid)
    if (outcome === 'focused') {
      return {
        ok: true,
        action: 'focus',
        dir: normDir,
        message: 'focused',
        data: { pid: running.pid },
      }
    }
    if (outcome === 'no-window') {
      return {
        ok: false,
        action: 'focus',
        dir: normDir,
        message: 'no window found for this instance',
        data: { pid: running.pid },
      }
    }
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: outcome,
      data: { pid: running.pid },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'focus',
      dir: normDir,
      message: `Failed to focus: ${message}`,
      data: {},
    }
  }
}

// ----------------------------------------------------------------------------
// Reveal folder
// ----------------------------------------------------------------------------

/** Reveals the instance's profile directory in the OS file browser (Explorer/Finder/xdg-open).
 *  Fire-and-forget, matching the existing open-file route's style (index.ts's /open-file);
 *  Explorer's own exit code is unreliable, so success just means the spawn didn't throw.
 *
 *  NO windowsHide HERE, and it must stay that way: explorer is a GUI program, and Bun's windowsHide
 *  is libuv's hide flag, which sets STARTUPINFO SW_HIDE as well as CREATE_NO_WINDOW. A console app
 *  ignores SW_HIDE, but a GUI app obeys it, so hiding this spawn hides the very window the button
 *  exists to open: the route still returns ok, and nothing appears. Measured 2026-07-16, spawning
 *  `explorer <dir>` both ways: plain opened 1 Explorer window, windowsHide opened 0.
 *  (index.ts's open-file route is the safe-looking exception: `cmd /c start` hides only the
 *  transient cmd, because `start` ShellExecutes the target as a fresh process that inherits none of
 *  our STARTUPINFO.) */
export async function revealInstanceFolder(dir: string): Promise<CMActionResult> {
  const normDir = normalizePath(dir)
  try {
    const cmd =
      process.platform === 'win32'
        ? ['explorer', normDir]
        : process.platform === 'darwin'
          ? ['open', normDir]
          : ['xdg-open', normDir]
    Bun.spawn(cmd, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
    return { ok: true, action: 'reveal', dir: normDir, message: 'opened', data: {} }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      action: 'reveal',
      dir: normDir,
      message: `Failed to open folder: ${message}`,
      data: {},
    }
  }
}
