// GitHub-Releases self-updater for the COMPILED distribution.
//
// The git-based engine (updater-engine.mjs) can't work in a packaged build (no .git, no server/src).
// This is its compiled-mode counterpart: it asks the GitHub Releases API for the latest tag, and —
// when newer — downloads that release's bundle for THIS platform, extracts it beside the running
// binary, and swaps the self-contained executable in place. It exposes the SAME UpdateStatus / UpdateApplyResult
// shape the engine does, so updater.ts, the /api/update routes, the auto-update loop, and the web UI
// all drive it unchanged.
//
// The binary swap is the delicate part, done defensively:
//   1. Stage the download+extract INSIDE the install dir (so every rename is same-volume — a temp
//      dir on another drive would make renameSync throw EXDEV mid-swap).
//   1b. VERIFY the archive's SHA-256 against the release's SHA256SUMS.txt BEFORE extracting it or
//      running anything out of it (verifyArchiveChecksum) — a version string is a compatibility
//      canary, not an integrity check, and running the canary already executes the download.
//   2. PROVE the new exe runs (`<new> --version` prints the expected version) BEFORE touching the
//      live install — never swap in a binary that doesn't launch.
//   3. Rename the running exe aside (allowed on Windows even while running; fine on POSIX) so it can
//      be rolled back, then move the new exe into its place.
//   4. On any failure mid-swap, restore from the renamed-aside originals.
// Leftover `*.old-*` artifacts are swept on the next boot (cleanupStaleUpdateArtifacts).

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import { basename, join } from 'node:path'
import { APP_ROOT, appEnv, SERVICE_NAME, VERSION } from './config'
import { getSetting, setSetting } from './db'
import {
  beginUpdateProgress,
  finishUpdateProgress,
  setUpdateBytes,
  setUpdatePhase,
} from './update-progress'
import type { UpdateApplyResult, UpdateStatus } from './updater-engine.mjs'

const REPO = 'LunarWerxs/agenthydra'
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
/** LunarWerx's Studio proxy: relays GitHub's `releases/latest` JSON for this repo VERBATIM (so
 *  every reader below is unchanged), and logs one anonymous install-count row per hit (random
 *  install id, app version, coarse OS tag, and a CDN-derived coarse country — never the caller's
 *  IP; 90-day retention). This IS the app's update check, not an addition to it: replacing the
 *  former direct `api.github.com` call here means the periodic check that already ran adds zero
 *  extra network traffic. See README.md "Update check" for the user-facing disclosure. */
const STUDIO_LATEST_API = 'https://studio.connections.icu/v1/app/agenthydra/latest'
/** The plain GitHub API, carrying no install id and no version/os telemetry. Serves two jobs:
 *  the PRIVACY path (pinging disabled, see {@link pingOptedOut}, so opting out still leaves
 *  update-checking working) and, since 2026-08, the RESILIENCE path — {@link fetchLatestRelease}
 *  retries here whenever the Studio proxy fails, so a proxy outage or a moved path can never
 *  strand an install the way YTSort's renamed update URL did. */
const GITHUB_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`

// ── anonymous install ping ──────────────────────────────────────────────────────────────────
//
// Piggybacks entirely on the update check above: no separate request, no separate timer. The
// settings table (server/src/db.ts) already IS "the app's existing config/state location" — the
// auto-update loop persists its own settings there — so the install id and the reported flag
// live beside them rather than inventing a second store.

/** Windows build-number → "win11-26100" / "win10-19045", using Microsoft's Windows 11 cutover
 *  build (22000). Exported so the parsing logic is testable independent of the host OS. */
export function formatWindowsTag(release: string): string {
  const build = Number(release.split('.')[2])
  if (!Number.isFinite(build)) return 'windows'
  return `win${build >= 22000 ? 11 : 10}-${build}`
}

/** Coarse OS tag sent with the ping: Windows gets its build number, everything else gets its
 *  plain family. Never anything more identifying (no hostname, no arch, no locale). */
export function coarseOsTag(): string {
  if (process.platform === 'win32') return formatWindowsTag(os.release())
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

/** Anonymous per-install id sent as `X-Install-Id`. Generated once and persisted in the settings
 *  table; reused for the life of the install. Never derived from hostname, MAC, username, or any
 *  other machine identifier. */
export function installId(): string {
  const existing = getSetting('app_install_id')
  if (existing) return existing
  const id = randomUUID()
  setSetting('app_install_id', id)
  return id
}

function pingAlreadyReported(): boolean {
  return getSetting('app_ping_reported') === '1'
}
/** Called once, only after a ping the server actually received (HTTP success) — never before,
 *  so a request that never left the machine (offline, timeout) does not consume the one-time
 *  `new=1` signal. */
function markPingReported(): void {
  setSetting('app_ping_reported', '1')
}

/** True when the anonymous ping should be skipped: an explicit opt-out, or a dev/test/CI run
 *  (which must never inflate install-count analytics or depend on network access). Update
 *  CHECKING itself keeps working either way — it just falls back to asking GitHub directly,
 *  carrying no install id and no version/os telemetry. */
export function pingOptedOut(): boolean {
  return appEnv('NO_PING') === '1' || process.env.NODE_ENV === 'test' || !!process.env.CI
}

/** Build the request for "the latest release" — the one call that serves both jobs (update info
 *  + anonymous install ping) when pinging is allowed, or GitHub directly with no telemetry when
 *  it is not. Exported so the URL/header shape is unit-testable without a real network call. */
export function buildLatestReleaseRequest(): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': `${SERVICE_NAME}/${VERSION}`,
  }
  if (pingOptedOut()) return { url: GITHUB_LATEST_API, headers }

  headers['X-Install-Id'] = installId()
  const params = new URLSearchParams({ v: VERSION, os: coarseOsTag() })
  if (!pingAlreadyReported()) params.set('new', '1')
  return { url: `${STUDIO_LATEST_API}?${params.toString()}`, headers }
}

/** Fire the request built above. Bounded to 5s so a slow/unreachable endpoint never turns an
 *  update check into a hang — every caller already wraps this in try/catch and treats a failure
 *  as "no answer", exactly as before this ping existed.
 *
 *  On a Studio failure this retries against {@link GITHUB_LATEST_API}. Note that constant was
 *  already here but only for the PRIVACY path (ping opted out); it was never a failure path, so
 *  until now a broken proxy stranded this install exactly like any other single-endpoint app.
 *
 *  Why it matters (YTSort, 2026-08): a shipped artifact whose only update URL later stopped
 *  resolving left every install silently polling a dead link for six months, with no signal to
 *  the users or the maintainer. GitHub's own API is the right backstop because it is the one
 *  URL here a rename cannot orphan — GitHub redirects both owner and repo renames.
 *
 *  `viaFallback` exists so the caller does NOT mark the install-count ping reported for a
 *  response Studio never served: that would burn this install's one-time `new=1` on a request
 *  the analytics side never saw. */
async function fetchLatestRelease(): Promise<{ res: Response; viaFallback: boolean }> {
  const { url, headers } = buildLatestReleaseRequest()
  let res: Response | null = null
  let primaryError: unknown = null
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
  } catch (e) {
    primaryError = e
  }
  if (res?.ok) return { res, viaFallback: false }
  // Already talking to GitHub (ping opted out) — there is no second opinion left to ask for.
  if (url === GITHUB_LATEST_API) {
    if (res) return { res, viaFallback: false }
    throw primaryError
  }
  let fallback: Response
  try {
    fallback = await fetch(GITHUB_LATEST_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `${SERVICE_NAME}/${VERSION}`,
      },
      signal: AbortSignal.timeout(5000),
    })
  } catch (e) {
    if (primaryError) throw primaryError
    if (res) return { res, viaFallback: false }
    throw e
  }
  // Backstop unhappy too: hand back the PRIMARY's response so the reason an operator reads
  // names the endpoint that actually broke rather than the one standing in for it.
  if (!fallback.ok) {
    if (res) return { res, viaFallback: false }
    throw primaryError
  }
  return { res: fallback, viaFallback: true }
}

/** This binary's release target string (matches the release-asset naming: windows-x64, linux-arm64…). */
export function currentTarget(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform // darwin | linux | windows
  return `${os}-${process.arch}` // arch is already x64 | arm64
}

/** `1.2.3` → [1,2,3]; strips a leading `v`. Non-numeric parts become 0. */
function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0)
}
/** True when `remote` is a strictly newer semver than `local`. */
export function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
}
interface GhRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: GhAsset[]
}

/** The manifest release.yml publishes beside the archives (`sha256sum out/* > out/SHA256SUMS.txt`)
 *  and install.ps1 already refuses to install without. */
export const CHECKSUM_MANIFEST = 'SHA256SUMS.txt'

/**
 * `sha256sum` output -> basename -> lowercase hex. Tolerates the binary-mode `*` marker, CRLF, blank
 * lines and paths with directories (the workflow hashes `out/<name>`); anything that is not
 * `<64 hex> <path>` is skipped rather than guessed at.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(raw)
    if (!m) continue
    const name = m[2]!.replace(/\\/g, '/').split('/').pop()
    if (name) out.set(name, m[1]!.toLowerCase())
  }
  return out
}

/** SHA-256 of a file on disk, streamed (release archives are ~100 MB). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Does the downloaded archive match what the release's manifest says it should be? (audit AH-38)
 *
 * The updater used to establish that a download was genuine by RUNNING it (`<exe> --version`
 * must print the expected version) - a compatibility canary, not an integrity check, and by the
 * time it answered the downloaded program had already executed. This runs first, on the bytes,
 * before extraction and before any candidate is launched. Missing manifest, missing entry and
 * mismatch are all refusals: an unverifiable download is not installed.
 *
 * Boundary, stated plainly: the manifest is downloaded from the same release as the archive, so
 * this proves the bytes are the ones the release published, not that the publisher is who you
 * think - a compromised release account can sign its own manifest. Publisher identity needs a
 * signature against a key shipped in this binary; that is not built.
 */
export async function verifyArchiveChecksum(
  archivePath: string,
  assetName: string,
  manifestText: string,
): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const sums = parseSha256Sums(manifestText)
  const expected = sums.get(assetName)
  if (!expected)
    return {
      ok: false,
      reason: `${CHECKSUM_MANIFEST} has no entry for ${assetName} (${sums.size} entr${sums.size === 1 ? 'y' : 'ies'} read) - refusing an unverifiable download`,
    }
  let actual: string
  try {
    actual = await sha256File(archivePath)
  } catch (e) {
    return {
      ok: false,
      reason: `could not hash the download: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (actual !== expected)
    return {
      ok: false,
      reason: `SHA-256 mismatch for ${assetName}: the release manifest says ${expected.slice(0, 12)}…, the download is ${actual.slice(0, 12)}… - refusing a download that is not what was published`,
    }
  return { ok: true, sha256: actual }
}

/** The compressed updater asset for THIS platform. A release may also expose a direct Windows
 *  `.exe` for humans; extension matching makes updater selection independent of upload order. */
export function assetForThisPlatform(assets: GhAsset[]): GhAsset | null {
  const target = currentTarget()
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz'
  return assets.find((a) => a.name.endsWith(`-${target}${extension}`)) ?? null
}

let cached: { value: UpdateStatus; at: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

function baseStatus(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    ok: true,
    service: SERVICE_NAME,
    currentVersion: VERSION,
    currentCommit: null,
    remoteCommit: null,
    branch: null,
    upstream: null,
    // A non-null `remote` keeps the web UI from graying the controls out as "no update source".
    remote: RELEASES_PAGE,
    dirty: false,
    updateAvailable: false,
    canApply: false,
    checkedAt: Date.now(),
    reason: null,
    ...overrides,
  }
}

export async function checkForUpdate(opts: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  let release: GhRelease
  try {
    const { res, viaFallback } = await fetchLatestRelease()
    if (!res.ok) {
      return baseStatus({
        ok: false,
        reason:
          // 429 is GitHub's SECONDARY rate limit and it is the same situation as the 403 primary
          // one: transient, self-resolving, nothing the user broke. Reporting it as the generic
          // "couldn't reach the API" made a wait-and-retry look like a dead endpoint, which is the
          // kind of message that sends someone hunting for a network fault that isn't there.
          res.status === 403 || res.status === 429
            ? 'GitHub API rate limit reached — try the check again later.'
            : `couldn't reach the GitHub Releases API (HTTP ${res.status}).`,
      })
    }
    // The ping succeeded (the server answered) — record it before touching the body, so a
    // malformed/unexpected JSON payload still counts as "this install was heard from".
    // Not for a fallback response: Studio never served it, so it never saw the ping either.
    if (!pingOptedOut() && !viaFallback) markPingReported()
    release = (await res.json()) as GhRelease
  } catch (e) {
    return baseStatus({
      ok: false,
      reason: `couldn't reach the GitHub Releases API (${e instanceof Error ? e.message : String(e)}).`,
    })
  }

  const remoteVersion = release.tag_name?.replace(/^v/, '') ?? ''
  const available = !!remoteVersion && isNewer(remoteVersion, VERSION)
  const asset = available ? assetForThisPlatform(release.assets ?? []) : null

  const value = baseStatus({
    remoteCommit: release.tag_name ?? null,
    updateAvailable: available,
    canApply: available && !!asset,
    reason: !available
      ? null
      : asset
        ? `v${remoteVersion} is available.`
        : `v${remoteVersion} is available, but no ${currentTarget()} build is attached to it — download it from ${RELEASES_PAGE}.`,
  })
  cached = { value, at: Date.now() }
  return value
}

/** Await a child process; reject on non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code ?? 'null'}`)),
    )
  })
}

/** `<exe> --version` prints exactly `expected` — the gate that a downloaded binary actually runs
 *  before it's allowed to replace the live one. */
function verifyExeVersion(exePath: string, expected: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }
    try {
      const child = spawn(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const timer = setTimeout(() => {
        child.kill()
        finish(false)
      }, 15_000)
      child.stdout?.on('data', (d) => {
        out += String(d)
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0 && out.trim().replace(/^v/, '') === expected.replace(/^v/, ''))
      })
    } catch {
      finish(false)
    }
  })
}

/**
 * Stream a download to disk, publishing bytes-received as it goes (see update-progress.ts).
 *
 * `Bun.write(path, response)` is the shorter way to do this and was what ran here before, but it is
 * opaque: the whole transfer is one await with nothing observable in between, which is precisely
 * what made a healthy multi-MB download look like a hang.
 *
 * `expected` comes from the release asset's own `size`. The response's content-length is preferred
 * when present (a redirect to a CDN can serve a different encoding), and a missing one is reported
 * as null rather than guessed — the UI then shows bytes without a percentage.
 */
async function writeWithProgress(
  response: Response,
  destPath: string,
  expected: number,
): Promise<void> {
  const header = Number(response.headers.get('content-length'))
  const total = Number.isFinite(header) && header > 0 ? header : (expected ?? null)
  const body = response.body
  if (!body) {
    // No readable stream (shouldn't happen for a release asset) — fall back to the simple path
    // rather than failing an update over a missing progress nicety.
    await Bun.write(destPath, response)
    return
  }

  const file = Bun.file(destPath).writer()
  let received = 0
  // Throttled: a 100 MB download delivers thousands of chunks and the UI polls once a second, so
  // publishing every chunk would be pure churn for identical readings.
  let lastPublishedAt = 0
  try {
    for await (const chunk of body) {
      file.write(chunk)
      received += (chunk as Uint8Array).byteLength
      const now = Date.now()
      if (now - lastPublishedAt >= 250) {
        lastPublishedAt = now
        setUpdateBytes(received, total)
      }
    }
    setUpdateBytes(received, total)
  } finally {
    await file.end()
  }
}

async function extract(archivePath: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ])
  } else {
    await run('tar', ['-xzf', archivePath, '-C', destDir])
  }
}

/** Move `from`→`to`, falling back to copy+remove across volumes (renameSync throws EXDEV there). */
function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

function fail(message: string): UpdateApplyResult {
  // Every early return in applyUpdate goes through here, so this is the one place that has to
  // settle the progress record — otherwise a failed apply leaves the UI on "Downloading…" forever,
  // which is the exact symptom this reporting exists to remove.
  finishUpdateProgress(false, message)
  return {
    ok: false,
    message,
    restartRequired: false,
    status: baseStatus({ ok: false, reason: message }),
    output: [],
  }
}

/**
 * Everything up to having a verified, ready-to-install executable on disk: staging dir setup,
 * download-with-progress, extraction, and a version self-check. Nothing here has touched the
 * INSTALLED app yet, so a thrown error is safe to let applyUpdate's own try/catch handle —
 * there is nothing to roll back. Pulled out of applyUpdate, see fail() above for why every
 * early return (here, as a returned UpdateApplyResult rather than a throw) still goes through it.
 */
async function downloadAndVerifyUpdate(
  asset: GhAsset,
  /** The release's SHA256SUMS.txt asset. Verified against BEFORE anything is extracted or run. */
  sums: GhAsset,
  remoteVersion: string,
  staging: string,
  bundledExeName: string,
  exeName: string,
  output: string[],
): Promise<{ newExe: string; bundleDirPath: string | null } | UpdateApplyResult> {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true }) // tar -C needs it to exist; Expand-Archive/Bun.write are fine either way
  const archivePath = join(staging, asset.name)
  const totalMb = Math.round(asset.size / 1048576)
  const headers = { accept: 'application/octet-stream', 'user-agent': `${SERVICE_NAME}/${VERSION}` }
  output.push(`downloading ${asset.name} (${totalMb} MB)`)
  setUpdatePhase('downloading', `Downloading v${remoteVersion} (${totalMb} MB)…`)
  const dl = await fetch(asset.browser_download_url, { headers, redirect: 'follow' })
  if (!dl.ok) return fail(`download failed (HTTP ${dl.status})`)
  // Streamed rather than `Bun.write(path, response)` so the bytes can be COUNTED as they land.
  // This is the step the "it just sat there spinning" report was actually about: a ~100 MB
  // release over a normal connection is tens of seconds during which the old code emitted
  // nothing at all, and a slow download was indistinguishable from a dead one.
  await writeWithProgress(dl, archivePath, asset.size)

  // Integrity BEFORE extraction and before any candidate runs (audit AH-38; see
  // verifyArchiveChecksum for what this does and does not prove).
  output.push(`verifying SHA-256 against ${CHECKSUM_MANIFEST}`)
  setUpdatePhase('verifying', 'Checking the download against the release checksums…')
  const sumsRes = await fetch(sums.browser_download_url, { headers, redirect: 'follow' })
  if (!sumsRes.ok)
    return fail(
      `could not fetch ${CHECKSUM_MANIFEST} (HTTP ${sumsRes.status}) - refusing an unverifiable download`,
    )
  const verified = await verifyArchiveChecksum(archivePath, asset.name, await sumsRes.text())
  if (!verified.ok) return fail(verified.reason)
  output.push(`sha256 ok (${verified.sha256.slice(0, 12)}…)`)

  output.push('extracting')
  setUpdatePhase('extracting', 'Extracting the update…')
  await extract(archivePath, staging)

  // Updater bundles retain the versioned wrapper directory expected by older releases, while
  // containing only the executable now. Also accept a flat archive if one is ever published.
  const entries = readdirSync(staging, { withFileTypes: true })
  const bundleDirEntry = entries.find((e) => e.isDirectory() && e.name.startsWith('AgentHydra-'))
  const bundleDirPath = bundleDirEntry ? join(staging, bundleDirEntry.name) : null
  const newExe = bundleDirPath ? join(bundleDirPath, bundledExeName) : join(staging, bundledExeName)
  if (!existsSync(newExe)) return fail(`the update bundle has no ${exeName}`)

  output.push('verifying the new binary runs')
  setUpdatePhase('verifying', 'Checking that the downloaded build runs…')
  if (!(await verifyExeVersion(newExe, remoteVersion))) {
    return fail('the downloaded binary failed its version self-check — not swapping it in')
  }
  return { newExe, bundleDirPath }
}

// The swap above moves ONE file, which is right for the daemon but would freeze misc/ at
// whatever version first installed it. The tray host is a separate executable with its own
// bugs (an icon that did not survive an Explorer restart, most recently), so without this a
// fixed launcher would never reach anyone who updates in place. These are app-owned launcher
// files, not user data: the shortcut lives at the install root and is untouched. Best-effort,
// and deliberately non-fatal: the daemon is already updated and working, and a locked
// lunarwerx-tray.exe (the running tray host holds its own image) must not roll back an
// otherwise-good update. The next update retries. Pulled out of applyUpdate, see fail() above.
function refreshTrayToolkit(
  bundleDirPath: string | null,
  staging: string,
  installDir: string,
  output: string[],
): void {
  const bundledMisc = bundleDirPath ? join(bundleDirPath, 'misc') : join(staging, 'misc')
  if (!existsSync(bundledMisc)) return
  try {
    cpSync(bundledMisc, join(installDir, 'misc'), { recursive: true })
    output.push('refreshed the tray toolkit')
  } catch {
    output.push('could not refresh misc/ (in use?) — the app itself is updated')
  }
}

export async function applyUpdate(): Promise<UpdateApplyResult> {
  beginUpdateProgress('Checking for the latest release…')
  const status = await checkForUpdate({ fresh: true })
  if (!status.ok) return fail(status.reason ?? 'update check failed')
  if (!status.updateAvailable) return fail('already up to date')

  const remoteVersion = (status.remoteCommit ?? '').replace(/^v/, '')
  // Re-fetch the release to get the asset URL (checkForUpdate intentionally doesn't carry it).
  // The check above already marked the ping reported on success, so this second hit never
  // resends `new=1` — one "first ping" signal per install, no matter how many requests it takes.
  let asset: GhAsset | null = null
  let sums: GhAsset | null = null
  try {
    const { res } = await fetchLatestRelease()
    if (res.ok) {
      const assets = ((await res.json()) as GhRelease).assets ?? []
      asset = assetForThisPlatform(assets)
      sums = assets.find((a) => a.name === CHECKSUM_MANIFEST) ?? null
    }
  } catch {
    asset = null
  }
  if (!asset) return fail(`no ${currentTarget()} build attached to v${remoteVersion}`)
  // Same rule install.ps1 applies: a release without its manifest cannot be verified, so it is not
  // installed. Every release since the manifest step landed carries one.
  if (!sums)
    return fail(
      `v${remoteVersion} published no ${CHECKSUM_MANIFEST}, so the download cannot be verified - refusing to update`,
    )

  const exePath = process.execPath
  const exeName = basename(exePath)
  const bundledExeName = process.platform === 'win32' ? 'AgentHydra.exe' : 'agenthydra'
  const installDir = APP_ROOT
  const staging = join(installDir, '.update-staging')
  const stamp = String(status.checkedAt) // Date.now() is unavailable here; reuse the check time
  const output: string[] = []

  // Staged renames-aside, tracked so a mid-swap failure can roll them back.
  let exeMovedAside: string | null = null

  try {
    const prepared = await downloadAndVerifyUpdate(
      asset,
      sums,
      remoteVersion,
      staging,
      bundledExeName,
      exeName,
      output,
    )
    if (!('newExe' in prepared)) return prepared
    const { newExe, bundleDirPath } = prepared
    setUpdatePhase('installing', `Installing v${remoteVersion}…`)

    // --- swap the exe (rename-aside is allowed on a running Windows image) ---
    exeMovedAside = join(installDir, `${exeName}.old-${stamp}`)
    renameSync(exePath, exeMovedAside)
    moveInto(newExe, exePath)
    if (process.platform !== 'win32') {
      try {
        await run('chmod', ['+x', exePath])
      } catch {
        /* best-effort; the bundle already ships it executable */
      }
    }
    output.push(`installed v${remoteVersion}`)

    refreshTrayToolkit(bundleDirPath, staging, installDir, output)

    rmSync(staging, { recursive: true, force: true })
    cached = null // force the next check to re-read the (now-current) version
    finishUpdateProgress(true, `Updated to v${remoteVersion}. Restarting…`)

    return {
      ok: true,
      message: `Updated to v${remoteVersion}. Restarting…`,
      restartRequired: true,
      status: baseStatus({ currentVersion: remoteVersion, updateAvailable: false }),
      output,
    }
  } catch (e) {
    // Roll back anything we moved aside so the install is never left half-swapped.
    try {
      if (exeMovedAside && existsSync(exeMovedAside)) {
        rmSync(exePath, { force: true })
        renameSync(exeMovedAside, exePath)
      }
    } catch {
      /* rollback is best-effort */
    }
    return fail(`update failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Delete leftover `*.old-*` swap artifacts + a stale staging dir. Best-effort, run at boot. */
export function cleanupStaleUpdateArtifacts(): void {
  try {
    const installDir = APP_ROOT
    rmSync(join(installDir, '.update-staging'), { recursive: true, force: true })
    for (const name of readdirSync(installDir)) {
      if (/\.old-\d+(\.exe)?$/.test(name)) {
        rmSync(join(installDir, name), { recursive: true, force: true })
      }
    }
    const webDir = join(installDir, 'web')
    if (existsSync(webDir)) {
      for (const name of readdirSync(webDir)) {
        if (/^dist\.old-\d+$/.test(name))
          rmSync(join(webDir, name), { recursive: true, force: true })
      }
    }
  } catch {
    /* best-effort */
  }
}
