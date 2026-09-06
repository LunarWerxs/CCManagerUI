// server/src/core/process.ts — per-OS Claude process enumeration + `--user-data-dir` parsing
// (PLAN.md §3/§4/§9 item 3).
//
// Mirrors a verified PowerShell prototype (Get-CMRunningProcess, from an earlier internal
// scratch tool) ported to cross-platform Bun/TypeScript.
//
// Cross-platform via Bun.spawn:
//   win32:        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | ..."`
//                 (falls back to `wmic process get ProcessId,CommandLine /format:list` if
//                 PowerShell itself is unavailable — rare, but keeps this dependency-light).
//   darwin/linux: `ps -eo pid=,command=` (no header row; wide enough to not truncate cmdline).
//
// "Main" process = has `--user-data-dir` AND lacks `--type=` (Electron marks child processes
// — gpu-process, renderer, utility, crashpad-handler, zygote, etc. — with `--type=`).
// `listClaudeProcesses({ includeChildren: true })` returns everything (main + children) so
// callers like quitInstance() can kill the whole process tree for a dir; the default
// (`includeChildren` unset/false) returns only main processes, which is what discovery/open
// need (one row per running instance).
//
// Nothing here throws for expected failure conditions (powershell/wmic/ps missing, spawn
// failure, unparseable output, permission-denied on some processes) — every path returns an
// empty array rather than rejecting, since "we can't currently enumerate processes" should
// degrade to "no known running instances", not crash the caller.

import { readdirSync, readFileSync } from 'node:fs'
import { normalizePath } from './paths.ts'
import { createScanCache } from './scan-cache.ts'

/** One row of the OS process table, as `ps -eo pid=,ppid=,command=` would print it. */
export interface ProcTableRow {
  pid: number
  ppid: number
  command: string
}

/**
 * Linux: the process table read straight from /proc, so it needs no `ps`.
 *
 * Both Unix listers below used to shell out to `ps`, and a Linux box without procps (a minimal
 * container is one; the CI image ships neither ps nor pgrep) answered "could not enumerate", which
 * the delete guard rightly refuses to act on - so on such a box no instance could ever be deleted
 * (2026-09-05, reproduced in the container). /proc is the source `ps` itself reads. Returns null
 * off Linux or where /proc is unreadable, and the caller falls back to `ps` (macOS).
 */
/** Test seam. process-scan-unknown.test.ts injects an enumeration failure by making Bun.spawn
 *  throw, which on Linux no longer reaches /proc at all; this lets that test make /proc answer
 *  "unreadable" too, so "could not look" is exercised on every platform. Null = no override. */
export const procTableForTests: { override: (() => ProcTableRow[] | null) | null } = {
  override: null,
}

export function linuxProcTable(): ProcTableRow[] | null {
  if (procTableForTests.override) return procTableForTests.override()
  if (process.platform !== 'linux') return null
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }
  const NUL = String.fromCharCode(0)
  const rows: ProcTableRow[] = []
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number.parseInt(name, 10)
    let stat: string
    let cmdline: string
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8')
    } catch {
      continue // raced with an exit
    }
    // "pid (comm) state ppid ..." - comm may hold spaces and parentheses, so split after the LAST ')'.
    const close = stat.lastIndexOf(')')
    if (close < 0) continue
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)
    const ppid = Number.parseInt(fields[1] ?? '', 10)
    if (!Number.isFinite(ppid)) continue
    // cmdline is the NUL-separated argv; a kernel thread has none, and `ps` prints its comm in
    // brackets for those, so this does the same.
    const argv = cmdline.split(NUL).filter((part) => part.length > 0)
    const command =
      argv.length > 0 ? argv.join(' ') : `[${stat.slice(stat.indexOf('(') + 1, close)}]`
    rows.push({ pid, ppid, command })
  }
  return rows.length > 0 ? rows : null
}

/** Hard cap on how deep the Unix descendant walk goes. An actuator chain is python -> shell ->
 *  tool, three or four levels; twelve bounds a pathological fork tree without ever mattering. */
const UNIX_TREE_MAX_DEPTH = 12

/**
 * Every descendant of `pid` on a Unix host, DEEPEST FIRST. Returns [] for a childless process or
 * a host where neither source can be read.
 *
 * WHY IT EXISTS (audit AH-15): on Windows the kill is `taskkill /T`, the whole tree; on Unix it
 * was the named process alone. Its own child, the actuator it was blocking on, kept running
 * unsupervised and still held the stdout/stderr pipes, so a caller's drain could not finish until
 * that grandchild happened to exit. A process group would be the canonical answer, but Bun.spawn
 * offers no `detached`, so the tree is enumerated and killed leaf-first instead.
 *
 * /proc first (via linuxProcTable), `pgrep -P` second. The order matters: the CI container ships
 * neither `pgrep` nor `ps`, and the pgrep-only walk answered EMPTY there, which is indistinguishable
 * from "no children" and silently turned the tree kill back into a single-process kill (2026-09-05).
 */
export function unixDescendants(pid: number, maxDepth = UNIX_TREE_MAX_DEPTH): number[] {
  const out: number[] = []
  const table = linuxProcTable()
  if (table) {
    const children = new Map<number, number[]>()
    for (const row of table) {
      const list = children.get(row.ppid)
      if (list) list.push(row.pid)
      else children.set(row.ppid, [row.pid])
    }
    const walk = (parent: number, depth: number): void => {
      if (depth >= maxDepth) return
      for (const child of children.get(parent) ?? []) {
        if (child === parent) continue
        walk(child, depth + 1) // grandchildren first, so a parent cannot respawn what we killed
        out.push(child)
      }
    }
    walk(pid, 0)
    return out
  }
  const walk = (parent: number, depth: number): void => {
    if (depth >= maxDepth) return
    let stdout: string
    try {
      const r = Bun.spawnSync(['pgrep', '-P', String(parent)], { stdout: 'pipe', stderr: 'ignore' })
      stdout = r.stdout.toString()
    } catch {
      return // no pgrep on this host: killing the named process is all we can do
    }
    for (const line of stdout.split('\n')) {
      const child = Number.parseInt(line.trim(), 10)
      if (!Number.isFinite(child) || child <= 0 || child === parent) continue
      walk(child, depth + 1)
      out.push(child)
    }
  }
  walk(pid, 0)
  return out
}

/**
 * Kill `pid` AND everything it spawned. The one implementation, because there were two and only
 * one of them was ever fixed.
 *
 * A cancelled or timed-out run is the case that matters: the thing being killed is a supervisor
 * blocked on an actuator (a PowerShell driving a window, a `subprocess.run` inside the toolbox, a
 * `claude` under a runner), and killing only the named process leaves that actuator running with
 * nobody watching it while the caller is told the work stopped. Windows has always used
 * `taskkill /T /F`; the Unix branch walks the tree and kills leaf-first so a parent cannot respawn
 * what was just killed.
 *
 * Never throws: a process that died between enumeration and signal is the expected case, not an
 * error, and every caller here is already reporting some other outcome.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      })
      return
    }
    for (const child of unixDescendants(pid)) {
      try {
        process.kill(child, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

// `--user-data-dir` shows up three ways in a reported command line, depending on how the value
// was quoted when the process was launched — the discovery here must handle all three or a
// running instance whose profile path contains a space is mis-parsed (and so appears "stopped"
// or as a bogus external entry). Verified empirically 2026-07:
//   --user-data-dir=C:\no space\x      unquoted — Bun.spawn/libuv leaves a space-free argv as-is
//                                       (the manager's own openInstance, common case)
//   --user-data-dir="C:\a b\x"          value quoted — what the desktop-shortcut .lnk writes
//   "--user-data-dir=C:\a b\x"          WHOLE token quoted — libuv wraps the entire argv element
//                                       in quotes when the value contains a space, so the quote
//                                       lands BEFORE the flag name, not after the '='
// Three ordered alternatives, most-specific first; capture group 1/2/3 respectively holds the
// value. `[^"]+` (not `[^"\s]`) in the quoted branches is what keeps spaces inside the path.
const USER_DATA_DIR_RE =
  /"--user-data-dir[= ]([^"]+)"|--user-data-dir[= ]"([^"]+)"|--user-data-dir[= ]([^"\s]+)/
const TYPE_FLAG_RE = /--type=/

/** Extracts the raw (un-normalized) `--user-data-dir` value from a process command line, or
 *  `null` when the flag is absent. Handles all three quotings above. Exported for unit tests. */
export function extractUserDataDir(cmdline: string): string | null {
  const m = cmdline.match(USER_DATA_DIR_RE)
  if (!m) return null
  const raw = (m[1] ?? m[2] ?? m[3])?.trim()
  return raw && raw.length > 0 ? raw : null
}

/** One discovered Claude Desktop process. */
export interface CMProcessInfo {
  pid: number
  cmdline: string
  /** Parsed + normalized `--user-data-dir` value, or `null` if the process didn't carry one
   *  (shouldn't normally happen for anything matched by the main-process filter, but child
   *  processes included via `includeChildren` may lack it in edge cases). */
  dir: string | null
  /** True when this is the main (non-`--type=`) process for its `--user-data-dir`. */
  isMain: boolean
  /** Best-effort process start time (ISO string), or `undefined` if unavailable on this
   *  OS/path (e.g. the `ps`-based unix path does not cheaply expose it). */
  startTime?: string
  /** Best-effort resident memory (working-set bytes) for THIS single process, or `undefined`
   *  when unavailable (unix `ps` path). Callers that want a per-instance total sum this across
   *  the whole process tree (main + `--type=` children). */
  memoryBytes?: number
}

export interface ListClaudeProcessesOptions {
  /** Include Electron child processes (renderer/gpu/utility/crashpad/... — marked `--type=`)
   *  in addition to the main process. Default `false` (discovery wants one row per instance;
   *  quit/kill wants the whole tree). */
  includeChildren?: boolean
  /** Bypass the shared scan cache and enumerate for real. Set it on any path that is about to
   *  ACT on the answer (open / quit / focus / delete guards): those must not decide from a
   *  snapshot that is a poll tick old. Read-only listing paths leave it off — see scan-cache.ts
   *  for why the polling routes must not pay for a PowerShell spawn. */
  fresh?: boolean
}

/** Parses a single raw process record into a CMProcessInfo, or `null` if it isn't a Claude
 *  Desktop process we care about (no `--user-data-dir` at all) or is malformed. */
function parseProcessRecord(
  pid: number,
  cmdline: string,
  startTime?: string,
  memoryBytes?: number,
): CMProcessInfo | null {
  if (!cmdline?.trim() || !Number.isFinite(pid)) return null

  const rawDir = extractUserDataDir(cmdline)
  if (rawDir === null) return null // no `--user-data-dir` → not an instance process we track

  const dir = normalizePath(rawDir)
  const isMain = !TYPE_FLAG_RE.test(cmdline)

  return { pid, cmdline, dir, isMain, startTime, memoryBytes }
}

// ----------------------------------------------------------------------------
// Shared spawn helper.
// ----------------------------------------------------------------------------

/** Runs a command via Bun.spawn and captures stdout as text. Never throws — returns `null`
 *  on spawn failure, non-zero exit, or timeout so callers can try the next strategy. */
async function runCaptureStdout(
  cmd: string[],
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<string | null> {
  type CaptureProc = Bun.Subprocess<'ignore', 'pipe', 'ignore'>
  let proc: CaptureProc | null = null
  try {
    proc = Bun.spawn(cmd, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    }) as CaptureProc
  } catch {
    return null // command not found / spawn rejected outright
  }

  const activeProc = proc
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })

  try {
    return await Promise.race([
      (async () => {
        const [stdout, exitCode] = await Promise.all([
          new Response(activeProc.stdout).text(),
          activeProc.exited,
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
      activeProc.kill()
    } catch {
      // Already exited — ignore.
    }
  }
}

// ----------------------------------------------------------------------------
// Windows: Get-CimInstance Win32_Process (primary), wmic (fallback).
// ----------------------------------------------------------------------------

interface WinProcRecord {
  pid: number
  commandLine: string | null
  /** Working-set bytes (Win32_Process.WorkingSetSize), or null when absent. */
  workingSetSize: number | null
  /** Process start time as a round-trip ISO string (Win32_Process.CreationDate), or null. */
  creationDate: string | null
}

/**
 * Strip raw control bytes out of PowerShell's JSON before parsing. The UTF-8 preamble in the
 * script below prevents the known corruption (see its comment), but the failure mode is too
 * expensive to leave to one line of defense: a single stray control byte in ONE process's
 * command line otherwise unparses the whole document and blinds running-detection for the
 * entire fleet. Escaped backslash-u sequences are untouched — only literal bytes JSON forbids
 * inside strings are replaced, each with a space so offsets stay meaningful.
 */
export function sanitizeCimJson(s: string): string {
  let out = ''
  let dirty = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      out += ' '
      dirty = true
    } else {
      out += s[i]
    }
  }
  return dirty ? out : s
}

/** Primary Windows strategy: `Get-CimInstance Win32_Process` filtered to `Claude.exe`,
 *  emitted as JSON so parsing is exact (no column-width truncation like `wmic`/`tasklist`,
 *  and no ambiguity from `Format-List`'s line-wrapping of long command lines).
 *
 *  Also projects `WorkingSetSize` (live memory) and `CreationDate` (start time, formatted to a
 *  round-trip ISO string in PowerShell so JS `Date.parse` reads it identically on PS 5.1 and 7 —
 *  raw `ConvertTo-Json` serializes a CIM DateTime differently across versions). Both come free
 *  from the same snapshot this call already makes for running-state, so uptime/memory add no
 *  extra process scan. */
async function listWindowsProcessesViaCim(): Promise<WinProcRecord[] | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Force UTF-8 stdout. Windows PowerShell 5.1 otherwise encodes piped output in the legacy
    // OEM codepage, where any character it cannot represent becomes a raw 0x1A SUB byte — and a
    // control byte inside a JSON string makes the WHOLE document unparseable. Found live
    // 2026-08-25: one claude.exe whose command line contained "→" (a prompt) corrupted the scan,
    // the wmic fallback does not exist on current Windows, and every instance read as
    // not-running until that unrelated session exited.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Get-CimInstance -ClassName Win32_Process -Filter "Name=\'Claude.exe\'" | ' +
      'Select-Object ProcessId, CommandLine, WorkingSetSize, ' +
      "@{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } }} | " +
      'ConvertTo-Json -Compress -Depth 3',
  ].join('; ')

  const stdout = await runCaptureStdout([
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  if (stdout === null) return null

  const trimmed = sanitizeCimJson(stdout).trim()
  if (!trimmed) return [] // no Claude.exe processes running — valid empty result

  try {
    const parsed: unknown = JSON.parse(trimmed)
    // ConvertTo-Json emits a single object (not an array) when there's exactly one match.
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return records
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        pid: typeof r.ProcessId === 'number' ? r.ProcessId : Number(r.ProcessId),
        commandLine: typeof r.CommandLine === 'string' ? r.CommandLine : null,
        workingSetSize:
          typeof r.WorkingSetSize === 'number' && Number.isFinite(r.WorkingSetSize)
            ? r.WorkingSetSize
            : null,
        creationDate: typeof r.CreationDate === 'string' ? r.CreationDate : null,
      }))
      .filter((r) => Number.isFinite(r.pid))
  } catch {
    return null // malformed JSON — let the caller fall back to wmic
  }
}

/** Fallback Windows strategy: `wmic process get ProcessId,CommandLine /format:list`. Used
 *  only if PowerShell itself is unavailable (rare on modern Windows, but `wmic` is
 *  deprecated/removed on newer builds too — this is genuinely best-effort). */
async function listWindowsProcessesViaWmic(): Promise<WinProcRecord[] | null> {
  const stdout = await runCaptureStdout([
    'wmic',
    'process',
    'where',
    "name='Claude.exe'",
    'get',
    'ProcessId,CommandLine',
    '/format:list',
  ])
  if (stdout === null) return null

  // /format:list emits blocks like:
  //   CommandLine=...
  //   ProcessId=1234
  // separated by blank lines, with \r\n line endings.
  const records: WinProcRecord[] = []
  const blocks = stdout.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue

    let commandLine: string | null = null
    let pid: number | null = null
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq)
      const value = line.slice(eq + 1)
      if (key === 'CommandLine') commandLine = value || null
      else if (key === 'ProcessId') pid = Number.parseInt(value, 10)
    }

    if (pid !== null && Number.isFinite(pid)) {
      // wmic's own CreationDate/WorkingSetSize columns are DMTF-formatted and column-truncated;
      // this deprecated fallback stays memory/uptime-less (best-effort) rather than mis-parse them.
      records.push({ pid, commandLine, workingSetSize: null, creationDate: null })
    }
  }
  return records
}

/** null = BOTH Windows strategies failed. That is "could not enumerate", which the public
 *  `scanClaudeProcesses` reports as such; it is never folded into an empty list here. */
async function listWindowsProcesses(): Promise<CMProcessInfo[] | null> {
  let records = await listWindowsProcessesViaCim()
  if (records === null) {
    records = await listWindowsProcessesViaWmic()
  }
  if (records === null) return null

  const out: CMProcessInfo[] = []
  for (const r of records) {
    if (!r.commandLine) continue
    const parsed = parseProcessRecord(
      r.pid,
      r.commandLine,
      r.creationDate ?? undefined,
      r.workingSetSize ?? undefined,
    )
    if (parsed) out.push(parsed)
  }
  return out
}

// ----------------------------------------------------------------------------
// macOS / Linux: `ps -eo pid=,command=`.
// ----------------------------------------------------------------------------

/** null = `ps` could not be run or failed; see listWindowsProcesses. */
async function listUnixProcesses(): Promise<CMProcessInfo[] | null> {
  // `pid=,command=` suppresses the header row; `command` (not `comm`) gives the full
  // argv/cmdline rather than just the truncated executable basename. BSD `ps` (macOS) and
  // procps `ps` (Linux) both support this `-o key=` no-header syntax.
  // Linux answers from /proc first (see linuxProcTable): a box without procps still gets a real
  // table rather than "unknown". The parser below is the same for both sources.
  const table = linuxProcTable()
  const stdout = table
    ? table.map((r) => `${r.pid} ${r.command}`).join('\n')
    : await runCaptureStdout(['ps', '-eo', 'pid=,command='])
  if (stdout === null) return null

  const out: CMProcessInfo[] = []
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) continue

    const pidStr = trimmed.slice(0, spaceIdx)
    const cmdline = trimmed.slice(spaceIdx + 1).trim()
    const pid = Number.parseInt(pidStr, 10)
    if (!Number.isFinite(pid)) continue

    // Cheap pre-filter (avoid running the --user-data-dir regex against every process on
    // the box) before the real parse — anything Claude-related mentions "claude" somewhere.
    if (!/claude/i.test(cmdline)) continue

    const parsed = parseProcessRecord(pid, cmdline)
    if (parsed) out.push(parsed)
  }
  return out
}

// ----------------------------------------------------------------------------
// Public API.
// ----------------------------------------------------------------------------

/**
 * Enumerates currently-running Claude Desktop processes across all instances, per-OS.
 * Filters to processes whose command line carries `--user-data-dir` (i.e. Claude Desktop
 * instances launched by this app or manually with that flag); by default excludes Electron
 * child processes (`--type=gpu-process`, `--type=renderer`, `--type=utility`,
 * `--type=crashpad-handler`, etc.) so callers get one record per running instance.
 *
 * Pass `{ includeChildren: true }` to get the full process tree per instance (used by
 * quitInstance()-style callers that need to kill every process, not just the main one).
 *
 * The underlying OS scan is SHARED AND CACHED (see scan-cache.ts): the Instances tab polls this
 * every 4s and the scan costs ~490ms of PowerShell + WMI on Windows, so paying for it per request
 * put half a second on every poll tick and on first paint. Pass `{ fresh: true }` from anything
 * about to act on the answer. `includeChildren` filters the SAME cached snapshot — it was never
 * a different scan, so the two shapes share one cache entry.
 *
 * Never throws: enumeration failures (powershell/wmic/ps unavailable, spawn error, timeout,
 * unparseable output) resolve to an empty array. THAT MAKES THIS THE WRONG CALL FOR ANYTHING
 * DESTRUCTIVE - an empty array here means "none running OR could not look", and a delete guard
 * that reads it as the former deletes a live profile the moment PowerShell hiccups (audit AH-02,
 * reproduced with an injected spawn failure). Anything about to destroy data must call
 * {@link scanClaudeProcesses}, which keeps the two apart. This lenient shape stays for the UI
 * tables, where a blank tick is the right degradation.
 */
export async function listClaudeProcesses(
  options: ListClaudeProcessesOptions = {},
): Promise<CMProcessInfo[]> {
  const scan = await scanClaudeProcesses(options)
  return scan.ok ? scan.processes : []
}

/** The outcome of one enumeration attempt: the processes, or the reason there is no answer. */
export type ClaudeProcessScan =
  | { ok: true; processes: CMProcessInfo[] }
  | { ok: false; reason: string }

/**
 * The same enumeration as {@link listClaudeProcesses}, WITHOUT collapsing failure into empty.
 *
 * `ok: false` means the OS could not be asked (no PowerShell/wmic/ps, spawn error, timeout,
 * unparseable output). A caller deciding whether a profile is safe to delete must refuse on it;
 * a caller only painting a table may treat it as nothing to show. Same cache, same `fresh`
 * semantics, same `includeChildren` narrowing.
 */
export async function scanClaudeProcesses(
  options: ListClaudeProcessesOptions = {},
): Promise<ClaudeProcessScan> {
  const scan = await claudeProcessCache.get({ fresh: options.fresh })
  if (!scan.ok) return scan
  return {
    ok: true,
    processes: options.includeChildren ? scan.processes : scan.processes.filter((p) => p.isMain),
  }
}

/** The one OS scan behind {@link listClaudeProcesses} / {@link scanClaudeProcesses}. Always
 *  holds the FULL set (main + `--type=` children); the public functions do the narrowing, so both
 *  shapes are served from a single cached snapshot. A failed scan is cached like any other answer
 *  (a `fresh: true` caller bypasses it anyway), so a broken PowerShell does not turn every poll
 *  tick into a fresh 10-second timeout. */
const claudeProcessCache = createScanCache<ClaudeProcessScan>(
  async () => {
    try {
      const processes =
        process.platform === 'win32' ? await listWindowsProcesses() : await listUnixProcesses()
      if (processes === null) {
        return {
          ok: false,
          reason:
            process.platform === 'win32'
              ? 'neither Get-CimInstance nor wmic returned a process list'
              : 'neither /proc nor `ps` returned a process list',
        }
      }
      return { ok: true, processes }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },
  // 3s fresh: comfortably inside the UI's 4s poll, so a tick that lands early costs nothing, and
  // the tick that does refresh takes the cached answer while the scan runs behind it. 30s stale:
  // past that the app has effectively been idle (nothing polling), and a caller coming back
  // deserves a real answer rather than a snapshot from whenever it last had focus.
  { freshMs: 3_000, staleMs: 30_000 },
)

/**
 * Forget the cached process snapshot so the next listing scans for real.
 *
 * Call this after anything that CHANGES what a scan would return — launching, quitting, creating
 * or deleting an instance. Freshness that lags by a poll tick is invisible when someone else's
 * process appeared; it is very visible when the user just clicked the button themselves and the
 * row didn't change.
 */
export function invalidateClaudeProcessCache(): void {
  claudeProcessCache.invalidate()
}

// ----------------------------------------------------------------------------
// Ancestry walk — "which process launched me?" (core/self-identity.ts).
// ----------------------------------------------------------------------------

/** One ancestor of the current process. */
export interface AncestorProcess {
  pid: number
  name: string | null
  executablePath: string | null
  commandLine: string | null
}

/** Hard cap on how far up the tree to walk. Twelve is far more than any real
 *  agent → MCP-server chain (observed: 3) and bounds the cost of a pid-reuse cycle. */
const MAX_ANCESTRY_DEPTH = 12

/**
 * The chain of parent processes above `startPid`, NEAREST PARENT FIRST.
 *
 * WHY THIS EXISTS: a stdio MCP server spawned by Claude Code gets a REDUCED environment — no
 * `CLAUDE_CODE_EXECPATH`, no `CLAUDE_CONFIG_DIR` — so env alone cannot say which Claude Desktop
 * instance it belongs to. The answer is sitting in plain sight one and two hops up the tree: the
 * parent is `<instanceDir>/claude-code/<ver>/claude.exe` and the grandparent is the Electron host
 * carrying `--user-data-dir=<instanceDir>`.
 *
 * ONE spawn, not one per hop: the Windows path does the whole walk inside PowerShell, the unix
 * path takes a single `ps` snapshot and walks it in memory. Never throws — every failure
 * (PowerShell absent, permission denied, malformed output, timeout) resolves to null, which
 * callers must treat as "could not enumerate", never as "no ancestors".
 */
export async function processAncestry(startPid = process.pid): Promise<AncestorProcess[] | null> {
  try {
    return process.platform === 'win32'
      ? await windowsAncestry(startPid)
      : await unixAncestry(startPid)
  } catch {
    return null
  }
}

async function windowsAncestry(startPid: number): Promise<AncestorProcess[] | null> {
  // The loop lives in PowerShell so the whole chain costs ONE spawn (~300ms) instead of one per
  // hop. `$out` is forced to an array with @() — ConvertTo-Json serializes a single-element array
  // as a bare object otherwise, and the parse below would have to guess.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = ${startPid}`,
    '$out = @()',
    '$seen = @{}',
    `for ($i = 0; $i -lt ${MAX_ANCESTRY_DEPTH}; $i++) {`,
    '  if (-not $p -or $seen.ContainsKey($p)) { break }',
    '  $seen[$p] = $true',
    '  $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$p"',
    '  if (-not $proc) { break }',
    '  $parent = $proc.ParentProcessId',
    '  if ($i -gt 0) {',
    '    $out += [pscustomobject]@{ ProcessId = $proc.ProcessId; Name = $proc.Name; ' +
      'ExecutablePath = $proc.ExecutablePath; CommandLine = $proc.CommandLine }',
    '  }',
    '  $p = $parent',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
  ].join('; ')

  const stdout = await runCaptureStdout([
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  if (stdout === null) return null

  const trimmed = stdout.trim()
  if (!trimmed || trimmed === '[]') return []

  try {
    const parsed: unknown = JSON.parse(trimmed)
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return records
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        pid: typeof r.ProcessId === 'number' ? r.ProcessId : Number(r.ProcessId),
        name: typeof r.Name === 'string' ? r.Name : null,
        executablePath: typeof r.ExecutablePath === 'string' ? r.ExecutablePath : null,
        commandLine: typeof r.CommandLine === 'string' ? r.CommandLine : null,
      }))
      .filter((r) => Number.isFinite(r.pid))
  } catch {
    return null
  }
}

async function unixAncestry(startPid: number): Promise<AncestorProcess[] | null> {
  // One snapshot of every process, then walk the pid→ppid map in memory. `ps` has no ancestry
  // mode, and a per-hop `ps -p <pid>` would be a spawn each.
  const stdout = await runCaptureStdout(['ps', '-eo', 'pid=,ppid=,command='])
  if (stdout === null) return null

  const byPid = new Map<number, { ppid: number; command: string }>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    byPid.set(Number.parseInt(m[1]!, 10), {
      ppid: Number.parseInt(m[2]!, 10),
      command: m[3]!.trim(),
    })
  }

  const out: AncestorProcess[] = []
  const seen = new Set<number>([startPid])
  let pid = byPid.get(startPid)?.ppid
  for (let i = 0; i < MAX_ANCESTRY_DEPTH && pid && !seen.has(pid); i++) {
    seen.add(pid)
    const row = byPid.get(pid)
    if (!row) break
    // `command` is the full argv; argv[0] is the executable path on both macOS and Linux.
    const exe = row.command.split(/\s+/)[0] ?? null
    out.push({
      pid,
      name: exe ? (exe.split('/').pop() ?? null) : null,
      executablePath: exe,
      commandLine: row.command,
    })
    pid = row.ppid
  }
  return out
}
