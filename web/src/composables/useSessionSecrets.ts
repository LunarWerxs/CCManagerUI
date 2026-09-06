// useSessionSecrets — credentials the open session printed. Same shape as useSessionUsage: one
// cheap request per opened session, streamed server-side, never stored. The result is ALWAYS
// redacted — the daemon has no unredacted form of it, on purpose (server/src/session-export.ts).

import type { Ref } from 'vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionSecretScan, SessionSource } from '@/lib/api'
import * as api from '@/lib/api'

export function useSessionSecrets(deps: {
  selectedId: Ref<string | null>
  selectedSource: Ref<SessionSource | null>
  /** The exact row's locator (audit AH-35), when the selection carries one. Optional so a caller
   *  that predates locators still compiles and behaves exactly as before. */
  selectedLocator?: Ref<string | null>
}) {
  const { t } = useI18n()
  const secrets = ref<SessionSecretScan | null>(null)
  const secretsOpen = ref(false)

  /** Deliberately the same wording the export and the context pack use: a guardrail, not a
   *  guarantee. Overstating it is how a scan like this does harm. */
  const secretsDetail = computed(() =>
    secrets.value ? t('sessions.secretsHint', { n: secrets.value.count }) : undefined,
  )

  async function loadSecrets() {
    const id = deps.selectedId.value
    const source = deps.selectedSource.value
    const locator = deps.selectedLocator?.value ?? undefined
    if (!id || !source) {
      secrets.value = null
      return
    }
    try {
      const r = await api.getSessionSecrets(id, source, locator)
      if (deps.selectedId.value !== id || deps.selectedSource.value !== source) return
      secrets.value = r
    } catch {
      secrets.value = null
    }
  }
  watch(
    [deps.selectedId, deps.selectedSource],
    () => {
      secrets.value = null
      void loadSecrets()
    },
    { immediate: true },
  )

  return { secrets, secretsOpen, secretsDetail, loadSecrets }
}
