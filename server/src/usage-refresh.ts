// server/src/usage-refresh.ts — keep every instance's usage number warm in the background.
//
// WHY this is safe to default ON (the old code deliberately refused to poll):
//   - A check no longer spawns `claude`. It is a single ~300ms HTTPS GET against the same quota
//     endpoint the CLI's `/usage` screen reads (see usage-api.ts). The 250 MB process boot that made
//     polling unthinkable is gone.
//   - That endpoint reports quota; it does not CONSUME it. Reading your balance is not a withdrawal:
//     no inference call, no tokens billed.
//   - Instances with no usable credential are skipped up front (desktopIsCheckable), so a logged-out
//     instance is never probed on a loop.
//
// The sweep is STAGGERED, not a stampede: instances are checked one after another with a short gap,
// so a fleet of ten does not fire ten simultaneous requests every interval. A sweep never overlaps
// itself (`sweeping` guard), and a failure in one instance never aborts the rest.
//
// Turn it off in Settings → Usage. The manual "Refresh usage" buttons work exactly the same either
// way; this only decides whether the numbers go stale between visits.

import { listCliInstances } from './core/cli-instances'
import { listInstances } from './core/instances'
import { getSetting, setSetting } from './db'
import { getProviderSettings } from './provider-settings'
import { runKeepaliveSweep } from './session-keepalive'
import type { UsageSettings } from './types'
import { checkUsageForCliInstance, checkUsageForDesktop, desktopIsCheckable } from './usage-service'

/** Default sweep interval. Quota moves on the scale of hours, so 15 minutes is plenty fresh. */
const DEFAULT_INTERVAL_MIN = 15
/** Guard rails on a user-supplied interval (a 10-second sweep would be pointless, not dangerous). */
const MIN_INTERVAL_MIN = 5
const MAX_INTERVAL_MIN = 24 * 60
/** Gap between instances within one sweep, so a fleet trickles instead of stampeding. */
const STAGGER_MS = 750

// --- settings (db `settings` table; same getSetting/setSetting pattern as portable mode) ---------

/** A setting that DEFAULTS ON: only an explicit '0' turns it off (an unset key means "never
 *  touched", which for these must read as the default, not as false). */
const onByDefault = (key: string): boolean => getSetting(key) !== '0'

export function getUsageSettings(): UsageSettings {
  const raw = Number(getSetting('usage_refresh_interval_min'))
  const interval = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN
  return {
    autoRefresh: onByDefault('usage_auto_refresh'),
    autoRefreshIntervalMin: Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, interval)),
    showDesktopInstances: onByDefault('show_desktop_instances'),
    showCliInstances: onByDefault('show_cli_instances'),
  }
}

/** Apply a partial settings patch and re-arm the timer if the schedule changed. */
export function setUsageSettings(patch: Partial<UsageSettings>): UsageSettings {
  if (typeof patch.autoRefresh === 'boolean')
    setSetting('usage_auto_refresh', patch.autoRefresh ? '1' : '0')
  if (
    typeof patch.autoRefreshIntervalMin === 'number' &&
    Number.isFinite(patch.autoRefreshIntervalMin)
  )
    setSetting(
      'usage_refresh_interval_min',
      String(
        Math.min(
          MAX_INTERVAL_MIN,
          Math.max(MIN_INTERVAL_MIN, Math.round(patch.autoRefreshIntervalMin)),
        ),
      ),
    )
  if (typeof patch.showDesktopInstances === 'boolean')
    setSetting('show_desktop_instances', patch.showDesktopInstances ? '1' : '0')
  if (typeof patch.showCliInstances === 'boolean')
    setSetting('show_cli_instances', patch.showCliInstances ? '1' : '0')
  const next = getUsageSettings()
  rearm(next)
  return next
}

// --- the sweep ----------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let sweeping = false
let lastSweepAt: string | null = null

/** ISO timestamp of the last completed sweep, or null — surfaced so the UI can say "auto-refreshed X ago". */
export function lastAutoRefreshAt(): string | null {
  return lastSweepAt
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * One pass over every checkable instance. Sequential + staggered on purpose (see the header): the
 * point is to keep numbers warm quietly, not to win a race. Never throws; one bad instance is
 * logged and skipped so the rest of the sweep still lands.
 */
export async function sweepUsage(): Promise<number> {
  if (sweeping) return 0 // a slow sweep must never overlap the next tick
  sweeping = true
  let checked = 0
  try {
    for (const inst of await listInstances()) {
      try {
        if (!(await desktopIsCheckable(inst.dir))) continue
        await checkUsageForDesktop(inst.dir)
        checked++
      } catch (err) {
        console.error(`[usage-refresh] desktop '${inst.dir}' failed:`, err)
      }
      await sleep(STAGGER_MS)
    }
    for (const cli of listCliInstances()) {
      // Nothing to check with → don't fire a doomed probe every 15 minutes.
      if (!cli.loggedIn && !cli.associatedAccountId && !cli.associatedDesktopDir) continue
      try {
        await checkUsageForCliInstance(cli.id)
        checked++
      } catch (err) {
        console.error(`[usage-refresh] cli '${cli.id}' failed:`, err)
      }
      await sleep(STAGGER_MS)
    }
    lastSweepAt = new Date().toISOString()

    // The keepalive rides on the BACK of this sweep, deliberately: its decision is made from the
    // quota readings the loops above just refreshed, so it acts on numbers seconds old rather than
    // on whatever was cached hours ago. It is a no-op unless switched on (see provider-settings),
    // and it declines on its own terms besides — session-keepalive.ts.
    //
    // CLI logins only. The nudge is a `claude -p` spawn pointed at a CLAUDE_CONFIG_DIR, which is
    // what a CLI instance IS; a desktop profile keeps its credential somewhere that spawn cannot
    // read, so a desktop-only account is reached through its linked CLI login or not at all.
    try {
      const provider = getProviderSettings()
      const result = await runKeepaliveSweep({
        enabled: provider.keepaliveEnabled,
        weeklyFloorPct: provider.keepaliveWeeklyFloorPct,
        targets: listCliInstances()
          .filter((c) => c.loggedIn)
          .map((c) => ({ label: c.name, configDir: c.configDir, usageKey: `cli:${c.id}` })),
      })
      // Logged, not silent: this is the one loop here that SPENDS, so what it did (and what it
      // declined to do, with the reason) has to be answerable after the fact.
      if (result.nudged.length)
        console.log(`[keepalive] started the 5-hour window on: ${result.nudged.join(', ')}`)
    } catch (err) {
      console.error('[keepalive] sweep failed:', err)
    }
  } finally {
    sweeping = false
  }
  return checked
}

function rearm(settings = getUsageSettings()): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (!settings.autoRefresh) return
  timer = setInterval(() => {
    void sweepUsage().catch((err) => console.error('[usage-refresh] sweep failed:', err))
  }, settings.autoRefreshIntervalMin * 60_000)
  // Don't hold the process open on this timer alone.
  timer.unref?.()
}

/**
 * Start the background refresher (called once at daemon boot). Runs a first sweep shortly after
 * start — delayed, not immediate, so it never competes with the daemon's own startup work or delays
 * the first page load.
 */
export function startUsageRefresh(): void {
  const settings = getUsageSettings()
  rearm(settings)
  if (!settings.autoRefresh) return
  const kickoff = setTimeout(() => {
    void sweepUsage().catch((err) => console.error('[usage-refresh] initial sweep failed:', err))
  }, 20_000)
  kickoff.unref?.()
}
