// server/src/session-keepalive.ts — keep an account's 5-hour window ticking.
//
// WHAT IT IS FOR. The 5-hour quota window is a ROLLING one that only starts when the account is
// first used. An account left idle has no window running, so the moment you do want to work on it
// the clock starts from zero and you wait the full five hours before it refills. Nudging each idle
// account once puts every window in flight, so they come back sooner and stagger instead of all
// starting the moment you get busy.
//
// ⛔ WHY THIS IS NOT A HEADLESS CHAT, which this program does not do (server/src/headless-policy.ts,
// owner law). That ban is on a CONVERSATION nobody can watch. This is the same shape as the `/usage`
// probe the policy file explicitly carves out: spawn `claude -p` with one throwaway question, read
// the answer, delete the transcript. There is no thread, nothing to resume, and nothing a person
// would ever want to open. If this ever grows a second turn, or keeps its transcript, it has become
// a chat and belongs behind that chokepoint instead.
//
// ⛔ IT SPENDS REAL QUOTA, so it is OFF until switched on, and it refuses on its own terms:
//   · an account whose window is ALREADY running is skipped — that is the whole goal, not a reason
//     to poke it again;
//   · an account at or above the weekly floor is skipped, because burning the last of a weekly cap
//     to start a five-hour clock is exactly backwards;
//   · an unreadable quota reading is a skip, never a guess. "I could not tell" must not spend.

import { resolveClaudeExe } from './config'
import type { UsageSnapshot } from './types'
import { checkUsage, pruneUsageProbeTranscripts, usageProbeCwd } from './usage'
import { getCachedUsage } from './usage-cache'

/** The smallest question that still costs a turn. Deliberately not "hi" — a model that answers
 *  chattily costs more output than one told exactly what to say, and the reply is discarded. */
export const KEEPALIVE_PROMPT = 'Reply with the single word: ok'

/**
 * Is this account's 5-hour window currently running?
 *
 * `resets` is `''` when the window has not started (see UsageLimit) — that empty string IS the
 * signal, and it is the only one a snapshot carries. A null `session` means the reading told us
 * nothing about the window, which is NOT the same as "not running": both are handled by the caller,
 * separately, because one is a reason to act and the other is a reason to leave it alone.
 */
export function windowRunning(snapshot: UsageSnapshot | null | undefined): boolean | null {
  const session = snapshot?.session
  if (!session) return null
  const resets = (session.resetsAt ?? session.resets ?? '').trim()
  return resets !== ''
}

export interface KeepaliveDecision {
  /** 'nudge' is the only outcome that spends anything. */
  action: 'nudge' | 'skip'
  /** Why, in words fit for a log line. Always set, including for a nudge. */
  reason: string
}

/**
 * Decide what to do about ONE account, from its last quota reading.
 *
 * Pure, so the rule can be tested without spawning anything — the whole risk of this feature is in
 * the decision, not in the spawn.
 *
 * @param weeklyFloorPct skip when the weekly cap is at or above this. The weekly window is the
 *   binding one (a 5-hour window refills the same day; a weekly does not), so spending it to start
 *   a session clock is a bad trade at any level, and a terrible one near the cap.
 */
export function decideKeepalive(
  snapshot: UsageSnapshot | null | undefined,
  weeklyFloorPct: number,
): KeepaliveDecision {
  if (!snapshot) return { action: 'skip', reason: 'no quota reading for this account' }

  const running = windowRunning(snapshot)
  if (running === null)
    return { action: 'skip', reason: 'the reading does not say whether the window is running' }
  if (running) return { action: 'skip', reason: 'the 5-hour window is already running' }

  const weekly = snapshot.weekAll?.pct
  if (typeof weekly !== 'number' || !Number.isFinite(weekly))
    return { action: 'skip', reason: 'no weekly figure, so the floor cannot be checked' }
  if (weekly >= weeklyFloorPct)
    return {
      action: 'skip',
      reason: `weekly usage is ${Math.round(weekly)}%, at or above the ${weeklyFloorPct}% floor`,
    }

  return { action: 'nudge', reason: `window idle, weekly at ${Math.round(weekly)}%` }
}

export interface KeepaliveTarget {
  /** For the log line only. */
  label: string
  /** CLAUDE_CONFIG_DIR for a CLI login, when this target is one. */
  configDir?: string
  auth?: Parameters<typeof checkUsage>[0] extends { auth?: infer A } ? A : never
}

/**
 * Start the window for one account by asking the model one throwaway question.
 *
 * ⛔ IT MUST BE A REAL PROMPT, not the `/usage` probe. `/usage` is a slash command the CLI answers
 * from quota state; if it never reaches the model it spends no turn and starts no window, and this
 * whole feature would be a no-op that looked like it worked. So this spawns `claude -p <prompt>`
 * with an actual question — the one thing here that HAS to cost something.
 *
 * Everything around the spawn is copied deliberately from the usage probe (usage.ts), because each
 * part of it was learned the hard way: the scratch cwd keeps the throwaway transcript out of real
 * project folders, `windowsHide` stops a CMD window flashing on its own schedule, the timeout
 * bounds a hung CLI, and the sweep deletes the stub afterwards so this leaves nothing behind.
 *
 * Returns true only when a follow-up reading shows the window actually running — the nudge is
 * judged by its effect, never by "the command exited 0".
 */
export async function nudgeWindow(
  target: KeepaliveTarget,
  deps: { timeoutMs?: number } = {},
): Promise<boolean> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  if (target.configDir) env.CLAUDE_CONFIG_DIR = target.configDir
  const probeCwd = usageProbeCwd()
  if (probeCwd) env.PWD = probeCwd

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([resolveClaudeExe(), '-p', KEEPALIVE_PROMPT], {
      env,
      cwd: probeCwd ?? undefined,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    }) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  } catch {
    return false // never launched → nothing was spent and nothing was started
  }

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }, deps.timeoutMs ?? 60_000)
  try {
    await Promise.all([new Response(proc.stdout).text(), proc.exited])
  } catch {
    // a read/exit error still may have spent the turn; the reading below is what decides
  } finally {
    clearTimeout(timer)
    pruneUsageProbeTranscripts()
  }

  // Ask again, and let the answer speak. forceCli is deliberately NOT set: this is a plain read of
  // the state the nudge was meant to change, and the free API path answers it.
  const after = await checkUsage({ account: target.label, configDir: target.configDir })
  return windowRunning(after) === true
}

/** The last reading we have for an account, without spending anything to get one. */
export function lastReading(usageKey: string): UsageSnapshot | null {
  return getCachedUsage(usageKey) ?? null
}

export interface KeepaliveSweepResult {
  considered: number
  nudged: string[]
  /** label -> why it was left alone. Kept so "why did nothing happen?" has an answer. */
  skipped: Record<string, string>
}

/**
 * One pass over the fleet: nudge every idle account that passes the rules.
 *
 * SEQUENTIAL, not parallel. Each nudge is a real CLI spawn against a real account, and firing a
 * dozen at once is both a thundering herd against the same API and the fastest way to turn a
 * misconfiguration into a dozen charges instead of one. There is no hurry here — the whole point is
 * a clock that runs for five hours.
 *
 * Returns what it did AND what it declined to do, because a sweep that silently does nothing is
 * indistinguishable from one that is broken.
 */
export async function runKeepaliveSweep(deps: {
  enabled: boolean
  weeklyFloorPct: number
  targets: (KeepaliveTarget & { usageKey: string })[]
  nudge?: (t: KeepaliveTarget) => Promise<boolean>
  reading?: (usageKey: string) => UsageSnapshot | null
}): Promise<KeepaliveSweepResult> {
  const out: KeepaliveSweepResult = { considered: 0, nudged: [], skipped: {} }
  if (!deps.enabled) return out
  const read = deps.reading ?? lastReading
  const doNudge = deps.nudge ?? nudgeWindow

  for (const t of deps.targets) {
    out.considered++
    const decision = decideKeepalive(read(t.usageKey), deps.weeklyFloorPct)
    if (decision.action === 'skip') {
      out.skipped[t.label] = decision.reason
      continue
    }
    try {
      const started = await doNudge(t)
      if (started) out.nudged.push(t.label)
      // A nudge that did not start the window is reported as a skip WITH ITS REASON rather than as
      // a success: the turn was spent either way, and quietly calling that a win is how you end up
      // spending it again on the next tick forever.
      else out.skipped[t.label] = 'nudged, but the window still does not report as running'
    } catch (e) {
      out.skipped[t.label] = `nudge failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return out
}
