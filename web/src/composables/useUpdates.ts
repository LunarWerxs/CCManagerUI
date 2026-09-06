// Self-update state for the app.
//
// The check/apply mechanics come from the shared kit (lib/useSelfUpdate.ts, synced — not edited
// here). This module adds the two things that were missing and that users actually reported:
//
//  1. AVAILABILITY, readable from anywhere. The kit's `checkForUpdate` performs a real check, so
//     the only place that called it was the Settings screen's onMounted — meaning someone who
//     never opened Settings was never told a new version existed. `availability` instead reads the
//     daemon's last BACKGROUND check (GET /api/update/available: a memory read, no network), which
//     the app shell can poll cheaply and render as a passive hint.
//
//  2. PROGRESS during an apply. `updateApplying` is a single boolean bound to one unresolved POST,
//     and that POST legitimately covers minutes — a ~100 MB release download, or on a source
//     checkout a git pull plus `bun install` plus a web build. With nothing in between, "working"
//     and "hung" looked identical, which is exactly how it was described: "it just sat there
//     spinning for a very long time". So while an apply is in flight we poll the server's phase
//     and expose it for the UI to render.
import { computed, ref } from 'vue'
import type { UpdateApplyResult, UpdateStatusWithDistribution } from '@/lib/api'
import * as api from '@/lib/api'
import { useSelfUpdate } from '@/lib/useSelfUpdate'

const { updateStatus, updateChecking, updateApplying, checkForUpdate, applyUpdate } = useSelfUpdate<
  UpdateStatusWithDistribution,
  UpdateApplyResult
>({
  checkUpdate: api.checkUpdate,
  applyUpdate: api.applyUpdate,
})

// --- availability (the passive "there's a newer version" signal) --------------------------------

const availability = ref<api.UpdateAvailability | null>(null)

/** True only when the daemon has actually looked and found something. Never true on the strength of
 *  not having checked — a hint that appears before the first background tick would be a guess. */
const updateAvailable = computed(
  () => availability.value?.checked === true && availability.value.updateAvailable,
)

/** The version being offered, for the hint's label. Null when unknown. */
const latestVersion = computed(() => availability.value?.latestVersion ?? null)

/**
 * Has the user looked at the update hint in THIS run of the app?
 *
 * A plain module-scope ref, deliberately: not useUiPrefs (which mirrors through the daemon) and not
 * useAppSettings (which round-trips to /api/settings). Both of those survive a restart, and a
 * dismissal that survives a restart is a dismissal you never see again — the dot would go quiet for
 * good on the first click and stop being a signal. Living only in memory means it clears itself
 * when the app is next opened, which is exactly the intended lifetime: "yes, I've seen it, stop
 * nagging me for now."
 *
 * It deliberately does NOT record WHICH version was dismissed. Availability is re-read hourly, so a
 * newer release arriving mid-session would otherwise have to fight a flag set for the previous one;
 * on the next launch the dot returns for whatever is current, which is the simpler promise.
 */
const updateDotDismissed = ref(false)

/** What the header should actually draw. Separate from {@link updateAvailable} so the FACT (there
 *  is a newer version) stays available to anything that needs it — the Settings card still says so
 *  in full — while only the nag is dismissible. */
const showUpdateDot = computed(() => updateAvailable.value && !updateDotDismissed.value)

/** Called when the user opens Settings from the dotted button: they are now looking at the thing
 *  the dot was pointing at, so it has done its job for this session. */
function dismissUpdateDot(): void {
  updateDotDismissed.value = true
}

async function refreshAvailability(): Promise<void> {
  try {
    availability.value = await api.getUpdateAvailability()
  } catch {
    // An older daemon has no such route, and a failed poll is not worth surfacing — the hint simply
    // stays hidden, which is how the app behaved before this existed.
  }
}

/**
 * Poll availability from the app shell.
 *
 * Hourly, because what it reads only moves when the daemon's own background check runs (every 6h by
 * default) — this is a cheap read of a slow answer, not a check of its own. One immediate read on
 * mount, so a window opened while the daemon has already been up shows the hint straight away
 * instead of waiting out a full interval.
 */
const AVAILABILITY_POLL_MS = 60 * 60 * 1000
let availabilityTimer: number | null = null

function startAvailabilityPolling(): void {
  if (availabilityTimer !== null) return
  void refreshAvailability()
  availabilityTimer = window.setInterval(() => void refreshAvailability(), AVAILABILITY_POLL_MS)
}

function stopAvailabilityPolling(): void {
  if (availabilityTimer !== null) window.clearInterval(availabilityTimer)
  availabilityTimer = null
}

// --- apply progress ------------------------------------------------------------------------------

const progress = ref<api.UpdateProgress | null>(null)

/** One line describing what the update is doing right now, with a percentage once the server starts
 *  reporting bytes. Null when there is nothing to say, so the caller falls back to its own generic
 *  copy rather than rendering an empty row. */
const progressLabel = computed(() => {
  const p = progress.value
  if (!p || p.phase === 'idle') return null
  if (p.receivedBytes != null && p.totalBytes) {
    const pct = Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
    const mb = (n: number) => (n / 1048576).toFixed(0)
    return `${p.message} ${pct}% (${mb(p.receivedBytes)}/${mb(p.totalBytes)} MB)`
  }
  return p.message || null
})

/**
 * Apply, polling the server's phase for as long as the request is in flight.
 *
 * The poll starts BEFORE the apply and is cleared in a finally, so it cannot outlive the request
 * that justified it. One second is fast enough for a download readout without being chatty.
 */
async function applyUpdateWithProgress(): Promise<UpdateApplyResult> {
  progress.value = null
  const timer = window.setInterval(() => {
    void api
      .getUpdateProgress()
      .then((p) => {
        progress.value = p
      })
      .catch(() => {
        // Mid-apply the daemon may be swapping its own binary and briefly refusing connections.
        // Expected, not worth showing — keep the last phase on screen and try again next tick.
      })
  }, 1000)
  const versionBefore = updateStatus.value?.currentVersion ?? null
  try {
    return await applyUpdate()
  } catch (e) {
    // THE compiled-release failure mode, and the one actually reported ("it just sat there
    // spinning"). A compiled apply deliberately restarts the daemon: index.ts fires relaunchDaemon
    // 250ms after writing this very response, and that relaunch exits the process 800ms later. So
    // roughly one second after the server answers, the socket this fetch is riding on is gone — and
    // if the body had not been fully received by then, the request fails. The update SUCCEEDED; the
    // only thing that broke was the page's ability to hear about it.
    //
    // So a dropped request here is not evidence of failure, it is evidence of a restart. Wait for
    // the daemon to come back and read its version: that answers definitively, in seconds, what the
    // user was previously left to guess at while a spinner turned.
    const restarted = await waitForDaemonAfterApply()
    if (restarted) {
      progress.value = null
      const applied = restarted.version !== versionBefore
      return {
        ok: true,
        message: applied
          ? `Updated to v${restarted.version}. Reload to finish switching over.`
          : `The app restarted and is running v${restarted.version}. Reload to be sure.`,
        restartRequired: true,
        status: (updateStatus.value ?? {}) as UpdateStatusWithDistribution,
        output: [],
      } as UpdateApplyResult
    }
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(
        'The update is taking longer than expected and this page stopped waiting for it. It may still be running. Reload to see the current version.',
      )
    }
    throw e
  } finally {
    window.clearInterval(timer)
    // Re-read availability so a successful update clears the hint without needing a reload.
    void refreshAvailability()
  }
}

/**
 * Poll /api/health until the daemon answers again, for as long as a restart plausibly takes.
 *
 * Ninety seconds: the successor waits out the predecessor's port (up to 8s), then boots — measured
 * at well under two seconds — so this is generous by an order of magnitude and still bounded. Null
 * means it genuinely did not come back, which IS a real failure and must not be dressed up as one.
 */
async function waitForDaemonAfterApply(timeoutMs = 90_000): Promise<{ version: string } | null> {
  const deadline = Date.now() + timeoutMs
  // A beat first: the daemon is still alive for ~1s after responding, so an immediate probe would
  // succeed against the process that is about to exit and report the OLD version.
  await new Promise((r) => setTimeout(r, 2000))
  while (Date.now() < deadline) {
    try {
      const health = await api.getHealth()
      if (health.ok) return { version: health.version }
    } catch {
      // Still down — expected for the second or two the port is being handed over.
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

export function useUpdates() {
  return {
    updateStatus,
    updateChecking,
    updateApplying,
    checkForUpdate,
    applyUpdate: applyUpdateWithProgress,
    availability,
    updateAvailable,
    showUpdateDot,
    dismissUpdateDot,
    latestVersion,
    refreshAvailability,
    startAvailabilityPolling,
    stopAvailabilityPolling,
    progress,
    progressLabel,
  }
}
