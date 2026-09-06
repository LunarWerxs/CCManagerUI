// tests/install-transactional.test.ts — AH-40: install.ps1 must swap release-owned components
// (AgentHydra.exe, misc/, orchestrator/) atomically, never leave a half-upgraded install behind,
// and never drop orchestrator/state/ (user data — see orchestrator/scripts/lib/ledgerlib.py's
// _state_dir()) that lives inside an otherwise release-owned folder.
//
// Everything here targets a synthetic release ZIP and a temp -InstallDir via the -FromZip /
// -InstallDir / -NoLaunch / -Force / -FailAfterStage seams added to install.ps1 for exactly this.
// NOTHING here touches the real install, the real daemon, or the real tray — see install.ps1's own
// header for what a real run does.
//
// THE CANARY SEAM: install.ps1 runs `<staged exe> --version` and refuses to install on a mismatch,
// and one of the required tests (`version-mismatch canary refuses`) has to prove that refusal for
// real, which means the fake "AgentHydra.exe" must actually be a runnable Windows binary — a text
// file renamed to .exe fails with ERROR_BAD_EXE_FORMAT before install.ps1 ever gets a chance to
// read its output, and a -SkipCanary flag would have made that one test not test the canary at
// all. So instead of a .cmd (Windows will not execute a bare batch file through the literal
// "AgentHydra.exe" path install.ps1 invokes) this compiles a tiny REAL .exe per fixture with the
// .NET Framework's csc.exe, which every Windows box (dev machine or GitHub's windows-latest
// runner) has carried since .NET Framework 4 — no extra install, no network.
//
// -Force is passed on every install.ps1 invocation below. None of the required scenarios is "does
// it refuse under a running instance" (that guard has no dedicated test here), and passing it
// removes a real, environment-dependent failure mode: if a developer happens to have the actual
// AgentHydra tray open while running `bun test`, the process-name check would otherwise see a
// genuine 'AgentHydra' or 'lunarwerx-tray' process and refuse every scenario in this file.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { REPO_ROOT } from './repo-root'

const win = process.platform === 'win32'
const INSTALL_PS1 = join(REPO_ROOT, 'install.ps1')

/** The .NET Framework's C# compiler — present on every Windows box without extra tooling. */
function findCsc(): string | null {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}
const CSC = win ? findCsc() : null

function psQuote(s: string): string {
  return s.replace(/'/g, "''")
}

/** A real, runnable AgentHydra.exe stand-in: `--version` prints exactly `version` and exits 0,
 *  anything else exits 1 — matching verifyExeVersion()'s expectation in server/src/github-updater.ts. */
function compileFakeExe(exePath: string, version: string): void {
  const srcPath = exePath.replace(/\.exe$/i, '.cs')
  const src = [
    'using System;',
    'class Program {',
    '  static int Main(string[] args) {',
    '    if (args.Length > 0 && args[0] == "--version") {',
    `      Console.WriteLine(${JSON.stringify(version)});`,
    '      return 0;',
    '    }',
    '    return 1;',
    '  }',
    '}',
    '',
  ].join('\n')
  writeFileSync(srcPath, src)
  execFileSync(CSC as string, ['/nologo', `/out:${exePath}`, srcPath], { timeout: 30_000 })
}

interface ReleaseDirOpts {
  /** Version the compiled exe actually reports — defaults to the folder's own version, override
   *  to build a mismatched fixture (canary refusal test). */
  exeVersion?: string
  miscMarker?: string
  /** Add a sidecar file to misc/ that a later "upgrade" fixture omits, so the swap's deletion of
   *  stale release-owned content is provable. */
  miscRetired?: boolean
}

/** Builds `<baseDir>/AgentHydra-<version>-windows-x64/` with the same top-level shape the release
 *  workflow ships (.github/workflows/release.yml's "Compile + package" step): AgentHydra.exe,
 *  misc/, orchestrator/. Returns the directory (the thing install.ps1 expects to find as the
 *  archive's sole top-level folder once zipped). */
function buildReleaseDir(baseDir: string, version: string, opts: ReleaseDirOpts = {}): string {
  const dir = join(baseDir, `AgentHydra-${version}-windows-x64`)
  mkdirSync(dir, { recursive: true })
  compileFakeExe(join(dir, 'AgentHydra.exe'), opts.exeVersion ?? version)

  const miscDir = join(dir, 'misc')
  mkdirSync(miscDir, { recursive: true })
  writeFileSync(join(miscDir, 'marker.txt'), opts.miscMarker ?? version)
  if (opts.miscRetired) writeFileSync(join(miscDir, 'retired-sidecar.txt'), 'old tray helper')

  const orchDir = join(dir, 'orchestrator')
  mkdirSync(orchDir, { recursive: true })
  writeFileSync(join(orchDir, 'orch.py'), '# placeholder orchestrator entrypoint\n')

  return dir
}

function zipDir(dir: string, zipPath: string): void {
  const cmd = `Compress-Archive -LiteralPath '${psQuote(dir)}' -DestinationPath '${psQuote(zipPath)}' -Force`
  execFileSync('powershell', ['-NoProfile', '-Command', cmd], { timeout: 20_000 })
}

/** Builds a release dir + zips it in one call; returns the zip path. */
function buildReleaseZip(baseDir: string, version: string, opts: ReleaseDirOpts = {}): string {
  const dir = buildReleaseDir(
    join(baseDir, `src-${version}-${Math.random().toString(36).slice(2)}`),
    version,
    opts,
  )
  const zipPath = join(baseDir, `AgentHydra-${version}-windows-x64.zip`)
  zipDir(dir, zipPath)
  return zipPath
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runInstall(args: string[]): RunResult {
  try {
    const stdout = execFileSync('pwsh', ['-NoProfile', '-File', INSTALL_PS1, ...args], {
      timeout: 60_000,
      encoding: 'utf8',
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    }
  }
}

function exeVersion(exePath: string): string {
  return execFileSync(exePath, ['--version'], { timeout: 10_000, encoding: 'utf8' }).trim()
}

/** Any `<installDir>.staging-*` (a sibling of installDir) or `<component>.old-*` (inside it, e.g.
 *  installDir\misc.old-<stamp>) artifact left behind — a real directory-listing scan, since
 *  existsSync on the un-suffixed prefix is always false and would prove nothing. */
function leftoverArtifacts(installDir: string): string[] {
  const found: string[] = []
  const parent = dirname(installDir)
  const base = basename(installDir)
  if (existsSync(parent)) {
    for (const name of readdirSync(parent)) {
      if (name.startsWith(`${base}.staging-`)) found.push(join(parent, name))
    }
  }
  if (existsSync(installDir)) {
    for (const name of readdirSync(installDir)) {
      if (name.includes('.old-')) found.push(join(installDir, name))
    }
  }
  return found
}

describe.skipIf(!win || !CSC)('install.ps1 transactional swap (AH-40)', () => {
  test('a fresh install lands all components', () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-install-fresh-'))
    const zip = buildReleaseZip(work, '0.20.0')
    const installDir = join(work, 'install')

    const result = runInstall([
      '-FromZip',
      zip,
      '-InstallDir',
      installDir,
      '-NoShortcut',
      '-NoLaunch',
      '-Force',
    ])
    expect(result.status).toBe(0)

    expect(existsSync(join(installDir, 'AgentHydra.exe'))).toBe(true)
    expect(existsSync(join(installDir, 'misc', 'marker.txt'))).toBe(true)
    expect(existsSync(join(installDir, 'orchestrator', 'orch.py'))).toBe(true)
    expect(exeVersion(join(installDir, 'AgentHydra.exe'))).toBe('0.20.0')
    // No leftover staging/aside artifacts on a clean fresh install.
    expect(leftoverArtifacts(installDir)).toEqual([])
  }, 30_000)

  test('an upgrade replaces misc/ and orchestrator/ while orchestrator/state/ survives', () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-install-upgrade-'))
    const installDir = join(work, 'install')

    const zipV1 = buildReleaseZip(work, '0.20.0', { miscRetired: true })
    expect(
      runInstall([
        '-FromZip',
        zipV1,
        '-InstallDir',
        installDir,
        '-NoShortcut',
        '-NoLaunch',
        '-Force',
      ]).status,
    ).toBe(0)
    expect(existsSync(join(installDir, 'misc', 'retired-sidecar.txt'))).toBe(true)

    // Simulate user/runtime data the scheduler would have written into the release-owned
    // orchestrator/ folder (orchestrator/scripts/lib/ledgerlib.py's _state_dir()).
    const stateDir = join(installDir, 'orchestrator', 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'sentinel.json'), '{"attempts":["keep-me"]}')

    // v2 ships a misc/ with no retired sidecar and an updated marker — proves the swap actually
    // REPLACES the component rather than merging into it.
    const zipV2 = buildReleaseZip(work, '0.20.1', { miscMarker: 'v2-marker' })
    const result = runInstall([
      '-FromZip',
      zipV2,
      '-InstallDir',
      installDir,
      '-NoShortcut',
      '-NoLaunch',
      '-Force',
    ])
    expect(result.status).toBe(0)

    expect(exeVersion(join(installDir, 'AgentHydra.exe'))).toBe('0.20.1')
    expect(readFileSync(join(installDir, 'misc', 'marker.txt'), 'utf8')).toBe('v2-marker')
    expect(existsSync(join(installDir, 'misc', 'retired-sidecar.txt'))).toBe(false)
    // The user's ledger survived the orchestrator/ swap.
    expect(readFileSync(join(stateDir, 'sentinel.json'), 'utf8')).toBe('{"attempts":["keep-me"]}')
  }, 30_000)

  test('an injected failure during the swap leaves the prior install intact', () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-install-rollback-'))
    const installDir = join(work, 'install')

    const zipV1 = buildReleaseZip(work, '0.21.0')
    expect(
      runInstall([
        '-FromZip',
        zipV1,
        '-InstallDir',
        installDir,
        '-NoShortcut',
        '-NoLaunch',
        '-Force',
      ]).status,
    ).toBe(0)
    const stateDir = join(installDir, 'orchestrator', 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'sentinel.json'), 'untouched')

    // 'exe' is swapped before 'misc' in $ReleaseComponents, so failing after 'misc' proves the
    // rollback undoes an ALREADY-swapped earlier component too, not just the one that failed.
    const zipV2 = buildReleaseZip(work, '0.21.1')
    const result = runInstall([
      '-FromZip',
      zipV2,
      '-InstallDir',
      installDir,
      '-NoShortcut',
      '-NoLaunch',
      '-Force',
      '-FailAfterStage',
      'misc',
    ])
    expect(result.status).not.toBe(0)

    // The prior install is back exactly as it was: old exe, old version, no leftovers.
    expect(exeVersion(join(installDir, 'AgentHydra.exe'))).toBe('0.21.0')
    expect(existsSync(join(stateDir, 'sentinel.json'))).toBe(true)
    expect(leftoverArtifacts(installDir)).toEqual([])
  }, 30_000)

  // THE ONE ABOVE CANNOT CATCH THE STATE BUG, which is why this one exists. 'misc' is swapped
  // before 'orchestrator', so failing after it means the state-carry step never ran and the
  // sentinel survives no matter what that step does. Failing after 'orchestrator' is the only
  // ordering that exercises it: by then state/ has been carried into staging, and the outer
  // `finally` deletes staging unconditionally. With the carry done as a MOVE (as it was until
  // 2026-09-06) the rollback restored an orchestrator/ whose state/ had gone with the staging
  // directory, silently destroying the scheduler's ledger in the one path built to protect it.
  test('a failure AFTER the orchestrator swap still leaves the scheduler ledger intact', () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-install-rollback-state-'))
    const installDir = join(work, 'install')

    const zipV1 = buildReleaseZip(work, '0.23.0')
    expect(
      runInstall([
        '-FromZip',
        zipV1,
        '-InstallDir',
        installDir,
        '-NoShortcut',
        '-NoLaunch',
        '-Force',
      ]).status,
    ).toBe(0)

    // A ledger with real shape: a file at the top and one nested a directory down, because the
    // carry copies a TREE and a shallow copy would pass a one-file assertion.
    const stateDir = join(installDir, 'orchestrator', 'state')
    mkdirSync(join(stateDir, 'trash', 'abc'), { recursive: true })
    writeFileSync(join(stateDir, 'sentinel.json'), '{"attempts":["keep-me"]}')
    writeFileSync(join(stateDir, 'trash', 'abc', 'manifest.json'), '{"undo":true}')

    const zipV2 = buildReleaseZip(work, '0.23.1')
    const result = runInstall([
      '-FromZip',
      zipV2,
      '-InstallDir',
      installDir,
      '-NoShortcut',
      '-NoLaunch',
      '-Force',
      '-FailAfterStage',
      'orchestrator',
    ])
    expect(result.status).not.toBe(0)

    // Rolled back whole: the old executable, and every byte of the ledger, nested file included.
    expect(exeVersion(join(installDir, 'AgentHydra.exe'))).toBe('0.23.0')
    expect(readFileSync(join(stateDir, 'sentinel.json'), 'utf8')).toBe('{"attempts":["keep-me"]}')
    expect(readFileSync(join(stateDir, 'trash', 'abc', 'manifest.json'), 'utf8')).toBe(
      '{"undo":true}',
    )
    expect(leftoverArtifacts(installDir)).toEqual([])
  }, 30_000)

  test('a version-mismatch canary refuses before touching the install', () => {
    const work = mkdtempSync(join(tmpdir(), 'ah-install-mismatch-'))
    const installDir = join(work, 'install')

    const zipV1 = buildReleaseZip(work, '0.22.0')
    expect(
      runInstall([
        '-FromZip',
        zipV1,
        '-InstallDir',
        installDir,
        '-NoShortcut',
        '-NoLaunch',
        '-Force',
      ]).status,
    ).toBe(0)

    // The folder claims 0.22.1 but the compiled exe inside reports 0.9.9 — a corrupt/mismatched
    // build install.ps1 must catch itself, without any of the release's own tooling lying to it.
    const zipBad = buildReleaseZip(work, '0.22.1', { exeVersion: '0.9.9' })
    const result = runInstall([
      '-FromZip',
      zipBad,
      '-InstallDir',
      installDir,
      '-NoShortcut',
      '-NoLaunch',
      '-Force',
    ])
    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toMatch(/version canary failed/i)

    // Refused before touching the install: still the old version, nothing staged or left aside.
    expect(exeVersion(join(installDir, 'AgentHydra.exe'))).toBe('0.22.0')
    expect(leftoverArtifacts(installDir)).toEqual([])
  }, 30_000)
})
