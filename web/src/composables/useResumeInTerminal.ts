// useResumeInTerminal — reopen a Claude session in a terminal. The command comes back whether or
// not the terminal opened, so a machine we cannot open a window on still gets something usable
// rather than a failure toast and nothing else.
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { SessionSummary } from '@/lib/api'
import * as api from '@/lib/api'

export function useResumeInTerminal() {
  const { t } = useI18n()
  const resuming = ref(false)

  async function resumeInTerminal(s: SessionSummary) {
    resuming.value = true
    try {
      const r = await api.resumeSessionInTerminal(s.session_id, s.source, s.locator)
      if (r.ok) {
        toast.success(t('sessions.resumeOpened'))
        return
      }
      await navigator.clipboard?.writeText(r.command).catch(() => {})
      toast.info(
        r.reason === 'source-unsupported'
          ? t('sessions.resumeUnsupported')
          : t('sessions.resumeCopied'),
        { description: r.command },
      )
    } catch {
      toast.error(t('sessions.resumeFailed'))
    } finally {
      resuming.value = false
    }
  }

  return { resuming, resumeInTerminal }
}
