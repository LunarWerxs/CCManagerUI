/**
 * Remote access via `cloudflared` - two flavours, vendored from RepoYeti's src/tunnel.ts:
 *
 *  - QUICK (default, zero-config): `cloudflared tunnel --url http://127.0.0.1:<port>`, scrape the
 *    rotating `*.trycloudflare.com` URL it prints. The relay absorbs the rotation (remote.ts).
 *  - NAMED: `cloudflared tunnel run --token <token>` against the owner's own Cloudflare account -
 *    a STABLE host that never rotates. Nothing to scrape; the hostname is configured in the
 *    Cloudflare dashboard, so `https://<hostname>` is reported once an edge connection registers.
 *
 * Tunnel failure is NON-FATAL: the gateway keeps serving loopback. SECURITY: never expose a
 * tunnel without app-layer auth - the caller refuses to start one unless OIDC is configured.
 */
import { type ChildProcess, spawn } from 'node:child_process'

/**
 * Injection point for tests: a fake child (EventEmitter-based, matching just the surface below)
 * stands in for the real cloudflared process. Deliberately NOT `mock.module('node:child_process')`
 * - that mock is global for the whole `bun test` run and leaks into every other file loaded beside
 * this one (switch.ts/switch.test.ts also spawn real children), as already burned once on
 * desktop-install.test.ts (see tests/monitor.test.ts). Defaults to the real `spawn`.
 */
export type SpawnFn = typeof spawn

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
export const TUNNEL_READY_RE = /registered tunnel connection|connection [0-9a-f-]{6,} registered/i

export interface TunnelHandle {
  stop(): void
}

export function cloudflaredExecutable(platform = process.platform): string {
  return process.env.CLOUDFLARED ?? (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

function launchFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const missing = /ENOENT|not found in \$PATH|executable not found/i.test(message)
  if (!missing) return `could not launch cloudflared: ${message}`
  return [
    'cloudflared was not found on PATH, so the tunnel could not start.',
    'Remote access needs it installed once:',
    'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    'Verify with `cloudflared --version`, then start the gateway again.',
  ].join('\n  ')
}

function spawnCloudflared(
  args: string[],
  detect: (chunk: string) => string | null,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
  extraEnv?: Record<string, string>,
  spawnFn: SpawnFn = spawn,
): TunnelHandle {
  let proc: ChildProcess
  try {
    proc = spawnFn(cloudflaredExecutable(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // The connector token goes in the ENVIRONMENT, never in `args` - see startNamedTunnel.
      // CF_TUNNEL_TOKEN is stripped on the way in: it is our own input variable, and a child
      // that already receives the token as TUNNEL_TOKEN has no use for a second copy.
      env: { ...process.env, CF_TUNNEL_TOKEN: undefined, ...extraEnv } as NodeJS.ProcessEnv,
    })
  } catch (err) {
    onError(launchFailure(err))
    return { stop() {} }
  }
  let found = false
  // Set by stop() BEFORE the kill signal goes out, so the exit handler below can tell a
  // deliberate shutdown from the connector dying on its own. `dead` closes the window for good
  // once the child is gone: it blocks a late/racing stdout chunk from calling onUrl after exit
  // (Node's 'exit' can fire before buffered stdio finishes draining) and makes error/exit
  // mutually exclusive, so a connector that already reported one outage can't report a second.
  let stopping = false
  let dead = false
  const scan = (buf: Buffer): void => {
    if (found || dead) return
    const url = detect(buf.toString())
    if (url) {
      found = true
      onUrl(url)
    }
  }
  proc.stdout?.on('data', scan)
  proc.stderr?.on('data', scan)
  proc.on('error', (err) => {
    if (dead) return
    dead = true
    onError(launchFailure(err))
  })
  proc.on('exit', (code) => {
    if (dead) return
    dead = true
    if (stopping) return // asked to stop - not an outage, nothing to report
    if (!found) {
      onError(`cloudflared exited (code ${code}) before the tunnel was ready`)
    } else {
      // Was ready, then died on its own: the connector is gone but nothing cleared the URL it
      // published. This is the outage remote.ts and the status pill need to hear about.
      onError(
        `cloudflared exited unexpectedly (code ${code}) after the tunnel was ready - remote access is down`,
      )
    }
  })
  return {
    stop() {
      stopping = true
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    },
  }
}

/** QUICK tunnel: scrape the rotating `*.trycloudflare.com` URL cloudflared prints. */
export function startTunnel(
  port: number,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
  spawnFn?: SpawnFn,
): TunnelHandle {
  return spawnCloudflared(
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    (chunk) => URL_RE.exec(chunk)?.[0] ?? null,
    onUrl,
    onError,
    undefined,
    spawnFn,
  )
}

/**
 * NAMED tunnel: report `https://<hostname>` the moment an edge connection registers.
 *
 * ⛔ THE TOKEN IS PASSED BY ENVIRONMENT, NOT ON THE COMMAND LINE. `--token <value>` puts a live
 * credential in the Windows process table, where any process running as this user can read it -
 * `Get-CimInstance Win32_Process`, Sysmon / 4688 command-line auditing, Task Manager's command
 * line column, and (the reason it matters here) AgentHydra's own fleet views, which list command
 * lines: a routine process dump pasted to an agent would carry the token with it. cloudflared
 * reads the same value from TUNNEL_TOKEN, which no process listing shows. Found by audit,
 * 2026-09-03. Do not "simplify" this back to an argument.
 */
export function startNamedTunnel(
  token: string,
  hostname: string,
  onUrl: (url: string) => void,
  onError: (message: string) => void,
): TunnelHandle {
  const url = `https://${hostname}`
  return spawnCloudflared(
    ['tunnel', '--no-autoupdate', 'run'],
    (chunk) => (TUNNEL_READY_RE.test(chunk) ? url : null),
    onUrl,
    onError,
    { TUNNEL_TOKEN: token },
  )
}
