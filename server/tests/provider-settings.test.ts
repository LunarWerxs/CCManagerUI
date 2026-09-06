import { expect, test } from 'bun:test'
import { getProviderSettings, setProviderSettings } from '../src/provider-settings'

test('provider settings default on for installed surfaces and off for ChatGPT handoff', () => {
  expect(getProviderSettings()).toEqual({
    codexDesktopEnabled: true,
    codexCliEnabled: true,
    chatGptHandoffEnabled: false,
    // The keepalive spends quota, so its default is the only one that matters for safety: OFF,
    // with a floor that leaves an account alone once its weekly cap is 80% gone.
    keepaliveEnabled: false,
    keepaliveWeeklyFloorPct: 80,
  })
})

test('provider settings round-trip independently', () => {
  expect(
    setProviderSettings({
      codexDesktopEnabled: false,
      codexCliEnabled: true,
      chatGptHandoffEnabled: true,
    }),
  ).toEqual({
    codexDesktopEnabled: false,
    codexCliEnabled: true,
    chatGptHandoffEnabled: true,
    keepaliveEnabled: false,
    keepaliveWeeklyFloorPct: 80,
  })

  setProviderSettings({
    codexDesktopEnabled: true,
    codexCliEnabled: true,
    chatGptHandoffEnabled: false,
  })
})

test('the keepalive floor is clamped, so a typo cannot turn a safety rail into permission', () => {
  // It is a percentage AND a guard. Anything unparseable or out of range has to land somewhere
  // safe rather than somewhere permissive.
  expect(setProviderSettings({ keepaliveWeeklyFloorPct: 150 }).keepaliveWeeklyFloorPct).toBe(100)
  expect(setProviderSettings({ keepaliveWeeklyFloorPct: -5 }).keepaliveWeeklyFloorPct).toBe(0)
  expect(setProviderSettings({ keepaliveWeeklyFloorPct: Number.NaN }).keepaliveWeeklyFloorPct).toBe(
    80,
  )
  setProviderSettings({ keepaliveWeeklyFloorPct: 80, keepaliveEnabled: false })
})
