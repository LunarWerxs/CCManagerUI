// useDoneMarks — "done" marks: seen it / handled it, without hiding it. Persisted server-side
// (sqlite) rather than in localStorage: these are the user's own judgements about real work, so
// they outlive a cleared browser store or a different webview profile. Deliberately NOT a filter:
// a done row stays exactly where it was, just quieter.

import type { Ref } from 'vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { SessionSummary } from '@/lib/api'
import * as api from '@/lib/api'

export function useDoneMarks(deps: { sessions: Ref<SessionSummary[]> }) {
  const { t } = useI18n()
  const doneCount = computed(() => deps.sessions.value.filter((s) => s.done).length)

  async function setDone(s: SessionSummary, done: boolean) {
    const prev = s.done
    s.done = done // optimistic: the row marks instantly, the write is a formality
    try {
      await api.setSessionDone(s.session_id, s.source, done, s.locator)
    } catch {
      s.done = prev
      toast.error(t('sessions.markDoneFailed'))
    }
  }
  const toggleDone = (s: SessionSummary) => setDone(s, !s.done)

  async function clearDoneMarks() {
    await Promise.all(deps.sessions.value.filter((s) => s.done).map((s) => setDone(s, false)))
  }

  return { doneCount, setDone, toggleDone, clearDoneMarks }
}
