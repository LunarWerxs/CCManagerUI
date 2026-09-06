import { getSetting, setSetting } from './db'
import type { ProviderSettings } from './types'

const enabledByDefault = (key: string): boolean => getSetting(key) !== '0'

export function getProviderSettings(): ProviderSettings {
  return {
    codexDesktopEnabled: enabledByDefault('provider_codex_desktop'),
    codexCliEnabled: enabledByDefault('provider_codex_cli'),
    // This opens an external consumer surface and creates a repository context file, so it is an
    // explicit opt-in rather than appearing in the composer without the owner asking for it.
    chatGptHandoffEnabled: getSetting('provider_chatgpt_handoff') === '1',
    // OPT-IN FOR A STRONGER REASON THAN THE ONE ABOVE: this one SPENDS QUOTA on its own, on idle
    // accounts, with nobody watching. See server/src/session-keepalive.ts.
    keepaliveEnabled: getSetting('keepalive_enabled') === '1',
    keepaliveWeeklyFloorPct: clampFloor(getSetting('keepalive_weekly_floor')),
  }
}

/** The floor is a PERCENTAGE and a safety rail, so a nonsense value must land somewhere safe rather
 *  than somewhere permissive: anything unparseable becomes 80, and the range is clamped so a typo
 *  cannot turn "never spend" into "always spend". */
function clampFloor(raw: string): number {
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return 80
  return Math.min(100, Math.max(0, n))
}

export function setProviderSettings(patch: Partial<ProviderSettings>): ProviderSettings {
  if (typeof patch.codexDesktopEnabled === 'boolean')
    setSetting('provider_codex_desktop', patch.codexDesktopEnabled ? '1' : '0')
  if (typeof patch.codexCliEnabled === 'boolean')
    setSetting('provider_codex_cli', patch.codexCliEnabled ? '1' : '0')
  if (typeof patch.chatGptHandoffEnabled === 'boolean')
    setSetting('provider_chatgpt_handoff', patch.chatGptHandoffEnabled ? '1' : '0')
  if (typeof patch.keepaliveEnabled === 'boolean')
    setSetting('keepalive_enabled', patch.keepaliveEnabled ? '1' : '0')
  if (typeof patch.keepaliveWeeklyFloorPct === 'number')
    setSetting('keepalive_weekly_floor', String(clampFloor(String(patch.keepaliveWeeklyFloorPct))))
  return getProviderSettings()
}
