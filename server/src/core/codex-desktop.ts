import { existsSync, mkdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { buildDetachedSpawn } from '../detached-spawn.mjs'
import { extractUserDataDir, linuxProcTable } from './process'
import { createScanCache } from './scan-cache'
import type { CMActionResult } from './shared'

export interface CodexDesktopTarget {
  id: string
  name: string
  codexHome: string
}

export interface CodexDesktopProcessRecord {
  pid: number
  parentPid: number
  name: string
  commandLine: string
  executablePath?: string
}

export interface CodexDesktopRuntime {
  desktopUserDataDir: string
  pid: number
}

export interface CodexDesktopLaunch {
  argv: string[]
  detached: boolean
  envOverrides: Record<string, string>
}

type ListDesktopProcesses = (options?: { fresh?: boolean }) => Promise<CodexDesktopRuntime[]>

/** Codex Desktop's Chromium/Electron profile. CODEX_HOME remains the sibling CLI/agent store. */
export function codexDesktopUserDataDir(codexHome: string): string {
  return join(codexHome, 'desktop')
}

/**
 * Where the DEFAULT (non-isolated) Codex Desktop keeps its profile — the install a user already had
 * before this app existed.
 *
 * NOT `<CODEX_HOME>/desktop`: that layout is one WE impose when creating an isolated instance. The
 * shipped app uses its own Electron userData path, so the default install can never be matched by
 * the isolated-layout rule, which is precisely why a running Codex Desktop used to appear nowhere in
 * the table (owner-reported 2026-08-07: "I have at least one codex instance, it's running").
 *
 * The win32 path is VERIFIED against the running MSIX build (OpenAI.Codex 26.730.8199.0), read off
 * its crashpad child's `--user-data-dir`. The mac/linux paths mirror the same relative layout under
 * each platform's Electron userData root and are UNVERIFIED — which costs nothing, because a running
 * instance is matched on the path the process itself announced (see listCodexInstances); this
 * constant only has to answer for a default install that is NOT currently running.
 */
export function defaultCodexDesktopUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.USERPROFILE || env.HOME || ''
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Codex', 'web', 'Codex')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Codex', 'web', 'Codex')
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Codex', 'web', 'Codex')
}

/** Case-normalized path key, exported so the instance list can match runtimes against dirs the
 *  same way findRuntime does rather than inventing a second comparison. */
export function codexPathKey(value: string): string {
  return pathKey(value)
}

function pathKey(value: string): string {
  const normalized = normalize(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isCodexDesktopRecord(record: CodexDesktopProcessRecord): boolean {
  if (/^(chatgpt|codex)(\.exe)?$/i.test(record.name)) return true
  const identity = `${record.executablePath ?? ''} ${record.commandLine}`
  return /(?:codex|chatgpt)(?:\.app|\.exe|\shelper|[/\\])/i.test(identity)
}

/**
 * Maps Electron child command lines back to their top-level desktop PID. Codex sets its user-data
 * path before acquiring the single-instance lock, so the main process does not repeat the path in
 * argv; its crashpad child does. Walking that child's parent chain recovers the focus/quit PID.
 */
export function codexDesktopRuntimesFromRecords(
  records: CodexDesktopProcessRecord[],
): CodexDesktopRuntime[] {
  const byPid = new Map(records.map((record) => [record.pid, record]))
  const byDir = new Map<string, CodexDesktopRuntime>()

  for (const record of records) {
    const rawDir = extractUserDataDir(record.commandLine)
    if (!rawDir) continue

    let root = record
    const visited = new Set<number>([root.pid])
    while (true) {
      const parent = byPid.get(root.parentPid)
      if (!parent || visited.has(parent.pid) || !isCodexDesktopRecord(parent)) break
      visited.add(parent.pid)
      root = parent
    }

    const key = pathKey(rawDir)
    if (!byDir.has(key)) {
      byDir.set(key, { desktopUserDataDir: normalize(rawDir), pid: root.pid })
    }
  }

  return [...byDir.values()]
}

async function capture(command: string[], timeoutMs = 10_000): Promise<string | null> {
  type CaptureProcess = Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  let child: CaptureProcess
  try {
    child = Bun.spawn(command, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    }) as CaptureProcess
  } catch {
    return null
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    return await Promise.race([
      (async () => {
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ])
        return exitCode === 0 ? stdout : null
      })(),
      timeout,
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    try {
      child.kill()
    } catch {
      // It already exited.
    }
  }
}

/** null = the scan could not be performed (no PowerShell, spawn error, timeout, unparseable
 *  output). An EMPTY string from a successful PowerShell is the genuine "nothing running". The
 *  two used to share one `return []`, which is what let a delete guard read a broken scan as
 *  "not running" (audit AH-02). */
async function listWindowsDesktopProcessRecords(): Promise<CodexDesktopProcessRecord[] | null> {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `Get-CimInstance -ClassName Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" |`,
    'Select-Object ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath |',
    'ConvertTo-Json -Compress -Depth 3',
  ].join(' ')
  const stdout = await capture(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])
  if (stdout === null) return null
  if (!stdout.trim()) return []

  try {
    const parsed: unknown = JSON.parse(stdout)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const value = row as Record<string, unknown>
      const pid = Number(value.ProcessId)
      const parentPid = Number(value.ParentProcessId)
      if (!Number.isFinite(pid) || !Number.isFinite(parentPid)) return []
      return [
        {
          pid,
          parentPid,
          name: typeof value.Name === 'string' ? value.Name : '',
          commandLine: typeof value.CommandLine === 'string' ? value.CommandLine : '',
          executablePath:
            typeof value.ExecutablePath === 'string' ? value.ExecutablePath : undefined,
        },
      ]
    })
  } catch {
    return null
  }
}

/** null = no process table could be read; an empty listing from a successful read is a real
 *  empty. Linux reads /proc (no `ps` needed, see core/process.ts linuxProcTable); elsewhere `ps`. */
async function listUnixDesktopProcessRecords(): Promise<CodexDesktopProcessRecord[] | null> {
  const table = linuxProcTable()
  const stdout = table
    ? table.map((r) => `${r.pid} ${r.ppid} ${r.command}`).join('\n')
    : await capture(['ps', '-eo', 'pid=,ppid=,command='])
  if (stdout === null) return null

  const records: CodexDesktopProcessRecord[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const commandLine = match[3]!
    if (!/(?:codex|chatgpt)/i.test(commandLine)) continue
    records.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: commandLine.split(/\s+/)[0] ?? '',
      commandLine,
    })
  }
  return records
}

/** The one OS scan behind {@link listCodexDesktopProcesses} — a second `Get-CimInstance
 *  Win32_Process` on Windows, and therefore a second ~490ms PowerShell spawn, on the Codex
 *  table's own 5s poll. Cached for the same reasons as core/process.ts's; see scan-cache.ts. */
const codexProcessCache = createScanCache<CodexProcessScan>(
  async () => {
    try {
      const records =
        process.platform === 'win32'
          ? await listWindowsDesktopProcessRecords()
          : await listUnixDesktopProcessRecords()
      if (records === null) {
        return {
          ok: false,
          reason:
            process.platform === 'win32'
              ? 'Get-CimInstance did not return a process list'
              : 'neither /proc nor `ps` returned a process list',
        }
      }
      return { ok: true, runtimes: codexDesktopRuntimesFromRecords(records) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  },
  { freshMs: 3_000, staleMs: 30_000 },
)

/** One enumeration attempt: the runtimes, or the reason there is no answer. */
export type CodexProcessScan =
  | { ok: true; runtimes: CodexDesktopRuntime[] }
  | { ok: false; reason: string }

/**
 * Running Codex/ChatGPT Desktop processes, keyed by their `--user-data-dir`.
 *
 * Served from a shared cached snapshot (see scan-cache.ts): the Codex instances table polls this
 * every 5s and the underlying scan is a PowerShell + WMI round trip. `fresh: true` bypasses the
 * cache for anything about to act on the answer (launch / stop), which must not decide from a
 * snapshot a poll tick old.
 *
 * LENIENT: a scan that could not run reads as an empty list, which is right for a table and
 * wrong for a delete. Destructive callers use {@link scanCodexDesktopProcesses}.
 */
export async function listCodexDesktopProcesses(
  options: { fresh?: boolean } = {},
): Promise<CodexDesktopRuntime[]> {
  const scan = await scanCodexDesktopProcesses(options)
  return scan.ok ? scan.runtimes : []
}

/** {@link listCodexDesktopProcesses} without folding failure into empty (audit AH-02). */
export async function scanCodexDesktopProcesses(
  options: { fresh?: boolean } = {},
): Promise<CodexProcessScan> {
  return await codexProcessCache.get({ fresh: options.fresh })
}

export type ScanDesktopProcesses = (options?: { fresh?: boolean }) => Promise<CodexProcessScan>

/** Whether `target`'s desktop is running, stopped, or UNKNOWN because the OS could not be asked.
 *  Always a fresh scan: every caller is about to act on the answer. */
export async function codexDesktopRunState(
  target: CodexDesktopTarget,
  scan: ScanDesktopProcesses = scanCodexDesktopProcesses,
): Promise<
  | { state: 'running'; runtime: CodexDesktopRuntime }
  | { state: 'stopped' }
  | { state: 'unknown'; reason: string }
> {
  const result = await scan({ fresh: true })
  if (!result.ok) return { state: 'unknown', reason: result.reason }
  const wanted = pathKey(codexDesktopUserDataDir(target.codexHome))
  const runtime = result.runtimes.find((r) => pathKey(r.desktopUserDataDir) === wanted)
  return runtime ? { state: 'running', runtime } : { state: 'stopped' }
}

/** Forget the cached Codex process snapshot — call after launching or stopping one, so the row
 *  the user just clicked updates on the next poll instead of waiting out the TTL. */
export function invalidateCodexProcessCache(): void {
  codexProcessCache.invalidate()
}

async function findRuntime(
  target: CodexDesktopTarget,
  listProcesses: ListDesktopProcesses = listCodexDesktopProcesses,
  opts: { fresh?: boolean } = {},
): Promise<CodexDesktopRuntime | null> {
  const wanted = pathKey(codexDesktopUserDataDir(target.codexHome))
  return (
    (await listProcesses({ fresh: opts.fresh })).find(
      (runtime) => pathKey(runtime.desktopUserDataDir) === wanted,
    ) ?? null
  )
}

/** Resolves the packaged desktop GUI, independently from the Codex CLI resolver. */
export async function resolveCodexDesktopBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configured = env.AGENTHYDRA_CODEX_DESKTOP_PATH?.trim()
  if (configured) return existsSync(configured) ? configured : null

  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1",
      "if ($package) { $candidate = Join-Path $package.InstallLocation 'app\\ChatGPT.exe'; if (Test-Path -LiteralPath $candidate) { [Console]::Out.Write($candidate) } }",
    ].join('; ')
    const packaged = (
      await capture(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])
    )?.trim()
    if (packaged && existsSync(packaged)) return packaged

    const localAppData = env.LOCALAPPDATA ?? ''
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const candidates = [
      join(localAppData, 'Programs', 'Codex', 'Codex.exe'),
      join(localAppData, 'OpenAI', 'Codex', 'Codex.exe'),
      join(programFiles, 'Codex', 'Codex.exe'),
    ]
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  if (platform === 'darwin') {
    const home = env.HOME ?? ''
    const candidates = [
      '/Applications/Codex.app/Contents/MacOS/Codex',
      '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      join(home, 'Applications', 'Codex.app', 'Contents', 'MacOS', 'Codex'),
      join(home, 'Applications', 'ChatGPT.app', 'Contents', 'MacOS', 'ChatGPT'),
    ]
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  return null
}

const powershellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

/**
 * Builds a launch that survives quitting/updating AgentHydra. On Windows, a short-lived
 * PowerShell process applies the instance environment and hands the GUI to Start-Process. Once the
 * hand-off exits, Codex is no longer in the daemon's live process tree. The generic WMI detacher is
 * intentionally not used there: an MSIX full-trust executable created by the WMI service exits
 * before Electron starts, even though Win32_Process.Create reports success.
 *
 * `--user-data-dir` is intentionally passed as well: the Windows MSIX build reads the environment
 * variable inside the app, but Chromium's package-level single-instance bootstrap only separates
 * concurrent processes when the profile is present in argv.
 */
export function buildCodexDesktopLaunch(
  platform: NodeJS.Platform,
  binary: string,
  codexHome: string,
  desktopUserDataDir: string,
): CodexDesktopLaunch {
  if (platform === 'win32') {
    const script = [
      `$env:CODEX_HOME = ${powershellLiteral(codexHome)}`,
      `$env:CODEX_ELECTRON_USER_DATA_PATH = ${powershellLiteral(desktopUserDataDir)}`,
      `Start-Process -FilePath ${powershellLiteral(binary)} -ArgumentList ${powershellLiteral(`--user-data-dir=${desktopUserDataDir}`)}`,
    ].join('; ')
    // Encoding prevents PowerShell's `-Command` quote rules from consuming the `$env:` assignments
    // before Start-Process receives them.
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
    return {
      argv: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
      detached: false,
      envOverrides: {},
    }
  }

  const launch = buildDetachedSpawn(platform, [binary, `--user-data-dir=${desktopUserDataDir}`])
  return {
    ...launch,
    envOverrides: {
      CODEX_HOME: codexHome,
      CODEX_ELECTRON_USER_DATA_PATH: desktopUserDataDir,
    },
  }
}

export interface OpenCodexDesktopOptions {
  listProcesses?: ListDesktopProcesses
  resolveBinary?: () => Promise<string | null>
  spawn?: typeof Bun.spawn
  platform?: NodeJS.Platform
}

export async function openCodexDesktop(
  target: CodexDesktopTarget,
  options: OpenCodexDesktopOptions = {},
): Promise<CMActionResult> {
  const desktopDir = codexDesktopUserDataDir(target.codexHome)
  // fresh: this decides whether to LAUNCH a second Codex Desktop on the same profile.
  const running = await findRuntime(target, options.listProcesses, { fresh: true })
  if (running) {
    return {
      ok: true,
      action: 'codex-desktop-open',
      dir: target.codexHome,
      message: 'already running',
      data: { id: target.id, pid: running.pid, desktopUserDataDir: desktopDir },
    }
  }

  const binary = await (options.resolveBinary ?? resolveCodexDesktopBinary)()
  if (!binary) {
    return {
      ok: false,
      action: 'codex-desktop-open',
      dir: target.codexHome,
      message:
        'Codex Desktop was not found. Install the Codex desktop app or set AGENTHYDRA_CODEX_DESKTOP_PATH.',
      data: { id: target.id, desktopUserDataDir: desktopDir },
    }
  }

  try {
    mkdirSync(desktopDir, { recursive: true })
    const platform = options.platform ?? process.platform
    const launch = buildCodexDesktopLaunch(platform, binary, target.codexHome, desktopDir)
    const spawn = options.spawn ?? Bun.spawn
    const child = spawn(launch.argv, {
      env: { ...(process.env as Record<string, string>), ...launch.envOverrides },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: platform === 'win32',
      ...(launch.detached ? { detached: true } : {}),
    })
    child.unref()
    // The cached snapshot is now wrong by construction — drop it so the next poll shows the row
    // as running rather than waiting out the TTL.
    invalidateCodexProcessCache()
    return {
      ok: true,
      action: 'codex-desktop-open',
      dir: target.codexHome,
      message: 'Codex Desktop launched.',
      data: { id: target.id, binary, desktopUserDataDir: desktopDir },
    }
  } catch (error) {
    return {
      ok: false,
      action: 'codex-desktop-open',
      dir: target.codexHome,
      message: `Failed to launch Codex Desktop: ${error instanceof Error ? error.message : String(error)}`,
      data: { id: target.id, desktopUserDataDir: desktopDir },
    }
  }
}

async function focusWindowsPid(pid: number): Promise<'focused' | 'no-window' | string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Namespace AgentHydraCodex -Name Win32 -MemberDefinition @"' +
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
    '  [void][AgentHydraCodex.Win32]::GetWindowThreadProcessId($hWnd, [ref]$procId)',
    '  if ($procId -eq $targetPid -and [AgentHydraCodex.Win32]::IsWindowVisible($hWnd)) {',
    '    $script:found = $hWnd',
    '    return $false',
    '  }',
    '  return $true',
    '}',
    '[void][AgentHydraCodex.Win32]::EnumWindows($callback, [IntPtr]::Zero)',
    'if ($found -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW" } else {',
    '  [void][AgentHydraCodex.Win32]::ShowWindow($found, 9)',
    '  if ([AgentHydraCodex.Win32]::SetForegroundWindow($found)) { Write-Output "FOCUSED" } else { Write-Output "FOREGROUND_DENIED" }',
    '}',
  ].join('\n')
  const stdout = await capture(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])
  if (stdout?.includes('FOCUSED')) return 'focused'
  if (stdout?.includes('NO_WINDOW')) return 'no-window'
  if (stdout?.includes('FOREGROUND_DENIED')) return 'foreground denied by Windows'
  return stdout === null ? 'failed to run the Windows focus helper' : 'no-window'
}

export async function focusCodexDesktop(
  target: CodexDesktopTarget,
  options: { listProcesses?: ListDesktopProcesses; platform?: NodeJS.Platform } = {},
): Promise<CMActionResult> {
  const desktopDir = codexDesktopUserDataDir(target.codexHome)
  // fresh: the PID here is about to be focused / killed, so a recycled stale one is not acceptable.
  const runtime = await findRuntime(target, options.listProcesses, { fresh: true })
  if (!runtime) {
    return {
      ok: false,
      action: 'codex-desktop-focus',
      dir: target.codexHome,
      message: 'not running',
      data: { id: target.id },
    }
  }

  const platform = options.platform ?? process.platform
  let outcome: string
  if (platform === 'win32') {
    outcome = await focusWindowsPid(runtime.pid)
  } else if (platform === 'darwin') {
    const script = `tell application "System Events" to set frontmost of first process whose unix id is ${runtime.pid} to true`
    outcome = (await capture(['osascript', '-e', script])) === null ? 'focus failed' : 'focused'
  } else {
    outcome = 'focus is not supported on this platform'
  }

  return {
    ok: outcome === 'focused',
    action: 'codex-desktop-focus',
    dir: target.codexHome,
    message: outcome === 'no-window' ? 'no window found for this instance' : outcome,
    data: { id: target.id, pid: runtime.pid, desktopUserDataDir: desktopDir },
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return !isAlive(pid)
}

export async function quitCodexDesktop(
  target: CodexDesktopTarget,
  options: {
    listProcesses?: ListDesktopProcesses
    platform?: NodeJS.Platform
    gracefulTimeoutMs?: number
  } = {},
): Promise<CMActionResult> {
  const desktopDir = codexDesktopUserDataDir(target.codexHome)
  // fresh: the PID here is about to be focused / killed, so a recycled stale one is not acceptable.
  const runtime = await findRuntime(target, options.listProcesses, { fresh: true })
  if (!runtime) {
    return {
      ok: true,
      action: 'codex-desktop-quit',
      dir: target.codexHome,
      message: 'not running',
      data: { id: target.id, killedCount: 0 },
    }
  }

  const platform = options.platform ?? process.platform
  try {
    if (platform === 'win32') {
      const graceful = Bun.spawn(['taskkill', '/pid', String(runtime.pid), '/t'], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
      await graceful.exited
    } else {
      process.kill(runtime.pid, 'SIGTERM')
    }

    if (!(await waitForExit(runtime.pid, options.gracefulTimeoutMs ?? 5000))) {
      if (platform === 'win32') {
        const forced = Bun.spawn(['taskkill', '/pid', String(runtime.pid), '/f', '/t'], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
          windowsHide: true,
        })
        await forced.exited
      } else {
        process.kill(runtime.pid, 'SIGKILL')
      }
    }
    invalidateCodexProcessCache()
    return {
      ok: true,
      action: 'codex-desktop-quit',
      dir: target.codexHome,
      message: 'Codex Desktop stopped.',
      data: { id: target.id, pid: runtime.pid, killedCount: 1, desktopUserDataDir: desktopDir },
    }
  } catch (error) {
    return {
      ok: false,
      action: 'codex-desktop-quit',
      dir: target.codexHome,
      message: `Failed to stop Codex Desktop: ${error instanceof Error ? error.message : String(error)}`,
      data: { id: target.id, pid: runtime.pid, killedCount: 0 },
    }
  }
}

export async function isCodexDesktopRunning(
  target: CodexDesktopTarget,
  listProcesses: ListDesktopProcesses = listCodexDesktopProcesses,
): Promise<boolean> {
  return (await findRuntime(target, listProcesses)) !== null
}
