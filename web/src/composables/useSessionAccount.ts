// useSessionAccount — which Anthropic ACCOUNT the open transcript is talking to, and the two
// things you want to do with that answer: bring the account's app up, or put its address on the
// clipboard.
//
// Why the open chat needs to say this at all. Every desktop instance runs a DIFFERENT account, and
// the transcript pane never named the one behind the chat you were reading: the answer lived one
// tab away, in a table you had to match by folder name. But it is the fact that decides whether a
// chat is worth resuming (is that account out of quota?), whose weekly limit a long run is
// spending, and which login to hand to another tool. So it belongs on the chat, and the address —
// the identifying form, not the handle — belongs one click away.
//
// Split out of SessionsView.vue for the same reason every other feature there is: this is one
// coherent thing (a lookup plus its two actions plus their toasts), and that view already delegates
// its file actions, migration and terminal resume the same way.
import type { ComputedRef, Ref } from 'vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useInstances } from '@/composables/useInstances'
import type { CMInstance, SessionSummary } from '@/lib/api'
import {
  accountEmail,
  accountHandle,
  displayName,
  instanceForSessionLabel,
} from '@/lib/instance-appearance'

export interface SessionAccount {
  /** The instance LABEL the session carries: a dir name, or 'default' for the non-isolated install. */
  label: string
  /** The instance row it resolves to, or null when it resolves to none — see below. */
  instance: CMInstance | null
  /** What to call it on screen: the account handle when one is resolved, else the instance's own
   *  display name, else the label the session was stamped with. */
  name: string
  /** The full address, or null when nothing is resolved / the instance is signed out. */
  email: string | null
}

export function useSessionAccount(deps: {
  selected: ComputedRef<SessionSummary | null> | Ref<SessionSummary | null>
  /** The label the sessions list already shows for an instance folder (useSessionFilters), reused
   *  so an unresolvable label reads the same here as it does on the row's chip. */
  instanceLabelFor: (folder: string) => string
}) {
  const { t } = useI18n()
  // The shared singleton. useSessionFilters already mounts and refreshes it for the row chips, so
  // reading it here costs no request of its own and the name fills in as accounts resolve.
  const { instances, open, focus } = useInstances()

  /** What to call it when no account has resolved: the instance's own display name, else the same
   *  wording the session ROW's instance chip uses for that label. `'default'` is spelled out rather
   *  than shown raw — the row chip says "Default", and a header reading the bare word "default"
   *  beside it would look like a different thing. */
  function unresolvedName(inst: CMInstance | null, label: string): string {
    if (inst) return displayName(inst)
    return label === 'default' ? t('sessions.instanceDefault') : deps.instanceLabelFor(label)
  }

  /**
   * The account behind the open session, or null when the chat has no desktop instance at all — a
   * plain CLI transcript, or a Codex/OpenCode session, both of which carry `instance: null`.
   *
   * `instance` is null while `label` is not whenever the label cannot be resolved: an instance
   * folder deleted since the chat ran, the regular non-isolated install simply not running (its row
   * only exists while a process for it does), or the label being ambiguous between two rows (see
   * instanceForSessionLabel). That is a real state and it is presented as one —
   * name what we know, disable what we cannot do — rather than papered over with a near-match,
   * because the WRONG email against a chat is worse than no email. It is the same failure
   * `loginChanged` exists to prevent.
   */
  const sessionAccount = computed<SessionAccount | null>(() => {
    const s = deps.selected.value
    if (!s?.instance) return null
    const inst = instanceForSessionLabel(instances.value, s.instance)
    return {
      label: s.instance,
      instance: inst,
      // The account comes first because the question here is "which login is this?" — the same
      // question the Instances tab's account column answers with the handle. displayName() is only
      // the fallback: it prefers a label the user typed, which names the ROW, not the login.
      name: accountHandle(inst?.account) ?? unresolvedName(inst, s.instance),
      email: accountEmail(inst?.account),
    }
  })

  const openingInstance = ref(false)

  /**
   * Bring the account's app up: launch it, or focus it when it is already running.
   *
   * The same split the Instances table makes with its Open/Focus button, so the action never lies
   * about what it does — and focusing rather than re-launching is what you actually want from a
   * chat you are reading. A deliberate click is what satisfies the rule that nothing opens an
   * account on its own.
   */
  async function openSessionInstance() {
    const inst = sessionAccount.value?.instance
    if (!inst || openingInstance.value) return
    openingInstance.value = true
    try {
      if (inst.isRunning) {
        const result = await focus(inst.dir)
        if (result?.ok) toast.success(t('instances.toastFocused'))
        else toast.error(result?.message ?? t('instances.toastFocusFailed'))
        return
      }
      const result = await open(inst.dir)
      if (result?.ok) toast.success(t('instances.toastOpened'))
      // The server's own message explains the MSIX-only case; the generic key is the last resort.
      else toast.error(result?.message ?? t('instances.toastOpenFailed'))
    } finally {
      openingInstance.value = false
    }
  }

  /** The FULL address, never the handle shown on screen: two accounts on different domains render
   *  the same handle, so only the address identifies the login outside this app. */
  function copySessionAccountEmail() {
    const email = sessionAccount.value?.email
    if (!email) return
    navigator.clipboard?.writeText(email).catch(() => {})
    toast.success(t('instances.toastEmailCopied', { email }))
  }

  return { sessionAccount, openingInstance, openSessionInstance, copySessionAccountEmail }
}
