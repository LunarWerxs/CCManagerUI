// server/tests/analytics-window.test.ts — what a time period on the Analytics tab actually means.
//
// THE BUG THIS PINS. The window used to be applied per SESSION, on `last_ts`: a session whose last
// turn landed inside the window contributed its ENTIRE life to the totals, and one that ended a day
// before it contributed NOTHING — including the part that really was inside. On a machine that runs
// marathon sessions "last 7 days" was therefore neither the last 7 days nor anything else you could
// name, and it silently disagreed with the day chart drawn directly below it, which had always been
// day-accurate. Both failures are invisible: every number still renders, just wrong.
//
// The per-day weighted map is the only per-day fact a stored row has, so it is what scopes the
// window now. These tests are about that scoping rule and the scaling that follows from it.

import { describe, expect, test } from 'bun:test'
import { scaleModelSpend, windowShare } from '../src/analytics'
import type { ModelSpend } from '../src/types'

/** A session that spent evenly across four days. */
const FOUR_DAYS = {
  '2026-09-01': 100,
  '2026-09-02': 100,
  '2026-09-03': 100,
  '2026-09-04': 100,
}

describe('windowShare', () => {
  test('no window means the whole session counts', () => {
    expect(windowShare(FOUR_DAYS, null)).toBe(1)
  })

  test('a session entirely inside the window counts in full', () => {
    expect(windowShare(FOUR_DAYS, '2026-09-01')).toBe(1)
    expect(windowShare(FOUR_DAYS, '2026-08-01')).toBe(1)
  })

  test('a session STRADDLING the window contributes only its inside part', () => {
    // The old rule gave this session's whole life to a two-day window, or nothing at all to one
    // that ended a day early. Two of four days in range is a half.
    expect(windowShare(FOUR_DAYS, '2026-09-03')).toBeCloseTo(0.5, 10)
    expect(windowShare(FOUR_DAYS, '2026-09-04')).toBeCloseTo(0.25, 10)
  })

  test('a session entirely BEFORE the window contributes nothing', () => {
    expect(windowShare(FOUR_DAYS, '2026-09-05')).toBe(0)
  })

  test('the share follows the weight, not the number of days', () => {
    // One heavy day and three trivial ones: a day count would call this 25%, which is the whole
    // reason the map stores weighted tokens rather than a tally of dates.
    const lopsided = { '2026-09-01': 1, '2026-09-02': 1, '2026-09-03': 1, '2026-09-04': 997 }
    expect(windowShare(lopsided, '2026-09-04')).toBeCloseTo(0.997, 10)
  })

  test('a row with no usable day data answers null, so the caller can fall back', () => {
    // Null is "cannot answer from days", NOT "nothing in range". An old row, or one whose turns
    // carried no timestamps, must fall back to the last_ts test — silently omitting real spend is
    // worse than counting a little of it at the wrong end of a boundary.
    expect(windowShare({}, '2026-09-01')).toBeNull()
    expect(windowShare({ '2026-09-01': 0 }, '2026-09-01')).toBeNull()
  })

  test('the boundary day itself is INSIDE the window', () => {
    // `>=`, not `>`: the cutoff day is the first day of the period, not the last excluded one.
    expect(windowShare({ '2026-09-03': 10 }, '2026-09-03')).toBe(1)
    expect(windowShare({ '2026-09-02': 10 }, '2026-09-03')).toBe(0)
  })
})

const SPEND: Record<string, ModelSpend> = {
  'claude-opus-5': {
    weighted: 1000,
    output: 200,
    turns: 10,
    input: 300,
    cacheRead: 5000,
    cacheCreation5m: 40,
    cacheCreation1h: 20,
  },
}

describe('scaleModelSpend', () => {
  test('a full share is the same object, untouched', () => {
    // Identity on the common path: no window, no allocation, and no chance of a rounding drift
    // creeping into an all-time total.
    expect(scaleModelSpend(SPEND, 1)).toBe(SPEND)
  })

  test('every count scales together, so the four-way split still sums correctly', () => {
    const half = scaleModelSpend(SPEND, 0.5)['claude-opus-5']
    expect(half).toBeDefined()
    expect(half?.weighted).toBe(500)
    expect(half?.input).toBe(150)
    expect(half?.cacheRead).toBe(2500)
    expect(half?.cacheCreation5m).toBe(20)
    expect(half?.cacheCreation1h).toBe(10)
    expect(half?.output).toBe(100)
  })

  test('turns are rounded, because a turn is a count and not a quantity', () => {
    expect(scaleModelSpend(SPEND, 0.5)['claude-opus-5']?.turns).toBe(5)
    expect(scaleModelSpend(SPEND, 0.25)['claude-opus-5']?.turns).toBe(3)
  })

  test('every model in the session is scaled, not just the first', () => {
    const two = scaleModelSpend({ a: SPEND['claude-opus-5']!, b: SPEND['claude-opus-5']! }, 0.5)
    expect(Object.keys(two)).toEqual(['a', 'b'])
    expect(two.a?.weighted).toBe(500)
    expect(two.b?.weighted).toBe(500)
  })
})
