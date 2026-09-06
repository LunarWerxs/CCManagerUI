// AH-12: QueueView/QueueBuilder already went honest about headless dispatch being permanently
// refused (server/src/headless-policy.ts's headlessRunsAllowed() is hardcoded false); the
// Settings -> Scheduler panel (SettingsView.vue) was the one surface the earlier fix missed — it
// still described and let you configure a scheduler that can never dispatch anything. This pins
// the same contract from the data side: the flag SettingsView.vue's scheduler group branches on to
// disable its Enabled switch, the tomorrow-time input, and the three advanced number inputs must be
// false, and the explanation it shows instead must actually name what still works, not just say
// "disabled". No DOM/component mount is available in this repo's test setup (bun:test, no
// @vue/test-utils or jsdom), so this checks the same inputs the template renders from, matching
// web/tests/headless-composer.test.ts's approach for the same flag.
import { describe, expect, test } from 'bun:test'
import settings from '../src/i18n/locales/en/settings'
import { HEADLESS_QUEUEING_ENABLED } from '../src/lib/headless'

describe('AH-12: Settings scheduler panel is honest about headless dispatch', () => {
  test('the flag the panel disables its controls on is false', () => {
    expect(HEADLESS_QUEUEING_ENABLED).toBe(false)
  })

  test('the unavailable explanation says what the scheduler would do and what works instead', () => {
    const hint = settings.schedulerUnavailableHint
    expect(typeof hint).toBe('string')
    expect(hint.length).toBeGreaterThan(0)
    // what the scheduler would do, and that headless dispatch is not available in this build
    expect(hint).toMatch(/scheduler/i)
    expect(hint).toMatch(/never runs a chat nobody can see/i)
    // what works instead: desktop chat reply, fan_out, import
    expect(hint).toMatch(/desktop chat/i)
    expect(hint).toMatch(/fan_out/i)
    expect(hint).toMatch(/import/i)
  })

  test('the existing scheduler description key is untouched (flag flipping back needs no other change)', () => {
    expect(settings.schedulerHint.length).toBeGreaterThan(0)
    expect(settings.schedulerEnabledLabel).toBe('Enabled')
  })
})
