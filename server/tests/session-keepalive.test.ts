// server/tests/session-keepalive.test.ts — when the keepalive is allowed to spend quota.
//
// The spawn is the boring half. THE DECISION IS THE RISK: this feature exists to burn a turn on
// purpose, on the owner's own accounts, unattended. Every rule below is a reason NOT to, and each
// one is here because the failure it prevents is silent — a keepalive that pokes an account already
// running, or one nearly out of weekly quota, costs real money and reports nothing wrong.
//
// decideKeepalive is pure precisely so this can be pinned without spawning anything.

import { describe, expect, test } from 'bun:test'
import { decideKeepalive, runKeepaliveSweep, windowRunning } from '../src/session-keepalive'
import type { UsageSnapshot } from '../src/types'

function snap(patch: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    account: 'a@b.com',
    session: { pct: 0, resets: '' },
    weekAll: { pct: 10, resets: 'Sep 9, 3:00am' },
    weekModel: null,
    capturedAt: '2026-09-06T12:00:00.000Z',
    ...patch,
  }
}

describe('windowRunning', () => {
  test('an empty reset string means the 5-hour window has not started', () => {
    // That empty string is the ONLY signal a snapshot carries for this.
    expect(windowRunning(snap({ session: { pct: 0, resets: '' } }))).toBe(false)
  })

  test('a reset time means it is running', () => {
    expect(windowRunning(snap({ session: { pct: 12, resets: 'Sep 6, 5:00pm' } }))).toBe(true)
    expect(
      windowRunning(
        snap({ session: { pct: 12, resets: '', resetsAt: '2026-09-06T17:00:00.000Z' } }),
      ),
    ).toBe(true)
  })

  test('no session figure at all is UNKNOWN, not "not running"', () => {
    // The difference matters: one is a reason to act, the other is a reason to leave it alone.
    expect(windowRunning(snap({ session: null }))).toBeNull()
    expect(windowRunning(null)).toBeNull()
  })
})

describe('decideKeepalive', () => {
  test('nudges an idle account with weekly quota to spare', () => {
    const d = decideKeepalive(snap(), 80)
    expect(d.action).toBe('nudge')
  })

  test('never pokes an account whose window is already running', () => {
    // The entire goal is a running window. Poking one that has it is pure waste.
    const d = decideKeepalive(snap({ session: { pct: 20, resets: 'Sep 6, 5:00pm' } }), 80)
    expect(d.action).toBe('skip')
    expect(d.reason).toContain('already running')
  })

  test('refuses at or above the weekly floor, boundary included', () => {
    // Burning the last of a WEEKLY cap to start a five-hour clock is exactly backwards: the
    // 5-hour window refills the same day, the weekly one does not.
    expect(decideKeepalive(snap({ weekAll: { pct: 80, resets: 'x' } }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: { pct: 95, resets: 'x' } }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: { pct: 79.9, resets: 'x' } }), 80).action).toBe('nudge')
  })

  test('an unreadable reading never spends — "I could not tell" is not permission', () => {
    expect(decideKeepalive(null, 80).action).toBe('skip')
    expect(decideKeepalive(undefined, 80).action).toBe('skip')
    expect(decideKeepalive(snap({ session: null }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: null }), 80).action).toBe('skip')
    expect(decideKeepalive(snap({ weekAll: { pct: Number.NaN, resets: 'x' } }), 80).action).toBe(
      'skip',
    )
  })

  test('a floor of 0 stops everything, which is the honest reading of "never"', () => {
    // Not a special case in the code — it falls out of `>=`. Pinned so nobody "tidies" it into a
    // truthiness check that would make 0 mean "no floor" and quietly re-enable spending.
    expect(decideKeepalive(snap({ weekAll: { pct: 0, resets: 'x' } }), 0).action).toBe('skip')
  })

  test('every decision says why, including the ones that act', () => {
    // These end up in a log the owner reads to answer "why did it spend that?".
    for (const d of [
      decideKeepalive(snap(), 80),
      decideKeepalive(snap({ session: { pct: 1, resets: 'later' } }), 80),
      decideKeepalive(null, 80),
    ]) {
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})

// --- the sweep: what it does, and what it refuses to do -------------------------------------------
describe('runKeepaliveSweep', () => {
  const targets = [
    { label: 'idle-1', usageKey: 'desktop:a' },
    { label: 'running-1', usageKey: 'desktop:b' },
    { label: 'spent-1', usageKey: 'desktop:c' },
  ]
  const readings: Record<string, UsageSnapshot> = {
    'desktop:a': snap(),
    'desktop:b': snap({ session: { pct: 5, resets: 'Sep 6, 5:00pm' } }),
    'desktop:c': snap({ weekAll: { pct: 92, resets: 'x' } }),
  }
  const reading = (k: string) => readings[k] ?? null

  test('disabled means it does not even look, let alone spend', async () => {
    let called = 0
    const r = await runKeepaliveSweep({
      enabled: false,
      weeklyFloorPct: 80,
      targets,
      reading,
      nudge: async () => {
        called++
        return true
      },
    })
    expect(called).toBe(0)
    expect(r.considered).toBe(0)
    expect(r.nudged).toEqual([])
  })

  test('nudges only the idle account, and says why it left the others', async () => {
    const poked: string[] = []
    const r = await runKeepaliveSweep({
      enabled: true,
      weeklyFloorPct: 80,
      targets,
      reading,
      nudge: async (t) => {
        poked.push(t.label)
        return true
      },
    })
    expect(poked).toEqual(['idle-1'])
    expect(r.nudged).toEqual(['idle-1'])
    expect(r.skipped['running-1']).toContain('already running')
    expect(r.skipped['spent-1']).toContain('floor')
  })

  test('a nudge that did not start the window is NOT reported as a success', async () => {
    // The turn was spent either way. Calling it a win is how you spend it again every tick.
    const r = await runKeepaliveSweep({
      enabled: true,
      weeklyFloorPct: 80,
      targets: [targets[0]!],
      reading,
      nudge: async () => false,
    })
    expect(r.nudged).toEqual([])
    expect(r.skipped['idle-1']).toContain('still does not report as running')
  })

  test('one account throwing does not stop the sweep, and the reason is kept', async () => {
    const r = await runKeepaliveSweep({
      enabled: true,
      weeklyFloorPct: 80,
      targets: [
        { label: 'boom', usageKey: 'desktop:a' },
        { label: 'fine', usageKey: 'desktop:a' },
      ],
      reading,
      nudge: async (t) => {
        if (t.label === 'boom') throw new Error('spawn refused')
        return true
      },
    })
    expect(r.skipped.boom).toContain('spawn refused')
    expect(r.nudged).toEqual(['fine'])
  })
})
