// useSessionUsage — what the open session spent. A separate, cheap request rather than a field on
// the tail: the tail is a bounded byte-window on the END of the transcript, and a session's cost is
// the whole file. The daemon streams it and caches on (mtime, size), so re-opening a finished
// session costs nothing.

import type { Ref } from 'vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionSource, SessionUsage } from '@/lib/api'
import * as api from '@/lib/api'
import { formatCompact, formatUsd } from '@/lib/format'

export function useSessionUsage(deps: {
  selectedId: Ref<string | null>
  selectedSource: Ref<SessionSource | null>
  /** The exact row's locator (audit AH-35), when the selection carries one. Optional so a caller
   *  that predates locators still compiles and behaves exactly as before. */
  selectedLocator?: Ref<string | null>
}) {
  const { t } = useI18n()
  const usage = ref<SessionUsage | null>(null)

  async function loadUsage() {
    const id = deps.selectedId.value
    const source = deps.selectedSource.value
    const locator = deps.selectedLocator?.value ?? undefined
    if (!id || !source) {
      usage.value = null
      return
    }
    try {
      const u = await api.getSessionUsage(id, source, locator)
      if (deps.selectedId.value !== id || deps.selectedSource.value !== source) return // selection moved on
      usage.value = u
    } catch {
      usage.value = null // a missing figure is silent; a wrong one would not be
    }
  }
  // Watching the selection rather than calling from a select() handler catches every way a
  // session gets opened — the list, a body-search hit, and the restored selection on mount.
  watch(
    [deps.selectedId, deps.selectedSource],
    () => {
      usage.value = null
      void loadUsage()
    },
    { immediate: true },
  )

  /** The header chip: "1.2M tokens · $4.21". A trailing "+" means some model in the session has no
   *  published price, so the figure is a floor. */
  const usageSummary = computed(() => {
    const u = usage.value
    if (u?.status !== 'ok' || u.tokens.turns === 0) return null
    const tokens = t('sessions.usageTokens', { n: formatCompact(u.tokens.total) })
    if (u.costUsd === null) return tokens
    const cost = formatUsd(u.costUsd)
    return `${tokens} · ${u.unpricedModels.length ? `${cost}+` : cost}`
  })

  const usageDetail = computed(() => {
    const u = usage.value
    if (u?.status !== 'ok') return undefined
    const parts = [
      t('sessions.usageBreakdown', {
        input: formatCompact(u.tokens.input),
        output: formatCompact(u.tokens.output),
        cacheRead: formatCompact(u.tokens.cacheRead),
        cacheWrite: formatCompact(u.tokens.cacheCreation),
        turns: u.tokens.turns,
      }),
    ]
    if (u.unpricedModels.length) {
      const models = u.unpricedModels.join(', ')
      parts.push(
        u.costUsd === null
          ? t('sessions.usageNoPrice', { models })
          : t('sessions.usageLowerBound', { models }),
      )
    }
    parts.push(t('sessions.usageListPrice', { date: u.pricesAsOf }))
    return parts.join(' ')
  })

  return { usage, loadUsage, usageSummary, usageDetail }
}
