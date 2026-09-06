// useSessionFileActions — the three ways a transcript's own file leaves the app: open it, put the
// FILE on the clipboard (only the daemon can do that, see api.copySessionFile), or copy its
// location. Split out of SessionsView.vue because all three share the same failure-toast shape and
// none of them touch the transcript that is currently open.

import type { Ref } from 'vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { SessionSummary } from '@/lib/api'
import * as api from '@/lib/api'
import { composeSessionPathClipboard } from '@/lib/session-clipboard'

export function useSessionFileActions(deps: {
  copyPathIncludeName: Ref<boolean>
  copyPathIncludePrompt: Ref<boolean>
  copyPathPrompt: Ref<string>
}) {
  const { t } = useI18n()

  async function openFile(session: SessionSummary) {
    try {
      const r = await api.openSessionFile(session.session_id, session.source, session.locator)
      if (!r.ok) toast.error(t('sessions.openFileFailed'))
    } catch {
      toast.error(t('sessions.openFileFailed'))
    }
  }

  // Puts the FILE on the clipboard, not its text — which only the daemon can do (see
  // api.copySessionFile). It reports the name it staged, because that name (the session title, not
  // the uuid) is the whole point and is worth confirming before the user pastes somewhere.
  const copyingFile = ref(false)
  async function copyFile(session: SessionSummary) {
    copyingFile.value = true
    try {
      const r = await api.copySessionFile(session.session_id, session.source, session.locator)
      if (r.ok) toast.success(t('sessions.copyFileDone', { name: r.filename ?? '' }))
      else if (r.reason === 'unsupported') toast.error(t('sessions.copyFileUnsupported'))
      else toast.error(t('sessions.copyFileFailed'))
    } catch {
      toast.error(t('sessions.copyFileFailed'))
    } finally {
      copyingFile.value = false
    }
  }

  async function copyFileLocation(session: SessionSummary) {
    try {
      const { path } = await api.getSessionFileLocation(
        session.session_id,
        session.source,
        session.locator,
      )
      const text = composeSessionPathClipboard({
        path,
        title: session.title,
        includeName: deps.copyPathIncludeName.value,
        includePrompt: deps.copyPathIncludePrompt.value,
        prompt: deps.copyPathPrompt.value,
      })
      await navigator.clipboard.writeText(text)
      // Says WHAT was copied rather than that something was: the clipboard can now hold three
      // lines where it used to hold one, and a paste into a terminal is a surprise worth
      // pre-empting.
      toast.success(
        text === path ? t('sessions.copyFileLocationDone') : t('sessions.copyFileLocationDoneRich'),
      )
    } catch {
      toast.error(t('sessions.copyFileLocationFailed'))
    }
  }

  return { openFile, copyingFile, copyFile, copyFileLocation }
}
