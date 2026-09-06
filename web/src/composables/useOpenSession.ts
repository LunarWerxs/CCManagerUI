// useOpenSession — which session is open, its tail (the live, polled window onto the transcript),
// and the shell-wide layout that follows having one open at all. Split out of SessionsView.vue
// because this is the one piece of state nearly everything else in the view reads from or writes
// through (body search, the composer, multi-select, the jump-to-session flow), so it earns being
// named and owned on its own rather than living as a dozen loose refs in the view.

import type { Ref } from 'vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useShellWidth } from '@/composables/useShellWidth'
import type { QueueItem, SessionSource, SessionSummary, TailResult } from '@/lib/api'
import * as api from '@/lib/api'

export function useOpenSession(deps: {
  sessions: Ref<SessionSummary[]>
  queue: Ref<QueueItem[]>
  showTools: Ref<boolean>
  showThinking: Ref<boolean>
  humanOnly: Ref<boolean>
}) {
  const selectedId = ref<string | null>(null)
  const selectedSource = ref<SessionSource | null>(null)
  // The exact row select() was given, not re-derived: two products sharing a format can hold the
  // same session id (audit AH-35), so `source` alone cannot always tell the daemon which one this
  // is. Null for a selection made before locators existed (a stale bookmark, a test) — the tail
  // call below falls back to source+id exactly as it always did.
  const selectedLocator = ref<string | null>(null)
  const tail = ref<TailResult | null>(null)
  const tailLoading = ref(false)
  const chatEl = ref<HTMLElement | null>(null)

  // Long-message expand state resets on every deliberate reload (a fresh view of the transcript
  // starts collapsed again), so it lives beside the load rather than beside the render pass.
  const expandedMsgs = ref<Set<number>>(new Set())
  const isExpanded = (i: number) => expandedMsgs.value.has(i)
  function toggleExpand(i: number) {
    const next = new Set(expandedMsgs.value)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    expandedMsgs.value = next
  }

  // Last-known summary, not a bare find(): an actively-written session can drop out of
  // one 12s scan cycle (partial JSONL mid-write), and a null flash would blank the
  // transcript and yank the shell width. Keep showing what we knew until it reappears.
  const selected = ref<SessionSummary | null>(null)
  watch(
    [deps.sessions, selectedId, selectedSource],
    () => {
      if (!selectedId.value) {
        selected.value = null
        return
      }
      const s = deps.sessions.value.find(
        (x) =>
          x.session_id === selectedId.value &&
          (!selectedSource.value || x.source === selectedSource.value),
      )
      if (s) selected.value = s
    },
    { immediate: true },
  )

  // an open transcript benefits from room; widen the whole shell while one is selected
  const { wide: shellWide } = useShellWidth()
  watch(
    () => !!selected.value,
    (hasSelection) => {
      shellWide.value = hasSelection
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    shellWide.value = false
  })

  // How many /tail reads are outstanding. The poll below fires every 4 s whether or not the last
  // one came back, and on a big store a read can take longer than that — so without this the polls
  // stack into a queue of identical requests, each one delaying the next, and the reader watches a
  // spinner that is waiting on answers nobody will look at. A skipped silent tick loses nothing:
  // another is 4 s behind it asking the same question. Only the SILENT path yields; a click is
  // intent and always runs.
  let tailInFlight = 0

  // Explicit loads (a click, a display-option toggle) are allowed to overlap — unlike the silent
  // poll below, nothing skips them — so network order need not match call order. Matching only
  // provider+session (the old guard) misses the case where the SAME session gets two reads with
  // DIFFERENT view options (textOnly/thinking/humanOnly): an older read requested under the
  // previous options can still land after a newer one and repaint the transcript under controls
  // the reader has since changed away from. A monotonic sequence number fixes that — only the
  // response belonging to the most recently ISSUED call may be applied, options included.
  //
  // The id/source check stays alongside it rather than being replaced: closing the transcript
  // (SessionsView sets selectedId to null directly, with no loadTail call to bump the sequence)
  // must still blank a straggling response for the session that's no longer open.
  let tailRequestSeq = 0

  async function loadTail(opts: { silent?: boolean } = {}) {
    const id = selectedId.value
    const source = selectedSource.value
    const locator = selectedLocator.value ?? undefined
    if (!id || !source) return
    if (opts.silent && tailInFlight > 0) return
    // measured BEFORE the fetch: whether the reader was already at the conversation's end
    const el = chatEl.value
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
    const seq = ++tailRequestSeq
    const stale = () =>
      seq !== tailRequestSeq || selectedId.value !== id || selectedSource.value !== source
    if (!opts.silent) tailLoading.value = true
    tailInFlight++
    try {
      const r = await api.getTail(
        id,
        source,
        {
          limit: 40,
          textOnly: !deps.showTools.value,
          thinking: deps.showThinking.value,
          humanOnly: deps.humanOnly.value,
        },
        locator,
      )
      if (stale()) return
      tail.value = r
    } catch {
      // Same staleness test the success path makes. A read that fails AFTER the reader moved on
      // (or after a newer read has been issued for the same session) belongs to a conversation
      // nobody is currently waiting on, and blanking on its behalf would clear what they ARE
      // looking at.
      if (!opts.silent && !stale()) tail.value = null
    } finally {
      tailInFlight--
      // Only the LATEST request may clear the pending flag. A straggling older request finishing
      // after a newer one was issued must not report "not loading" while that newer fetch is still
      // outstanding.
      if (!opts.silent && seq === tailRequestSeq) tailLoading.value = false
    }
    if (stale()) return
    if (!opts.silent) expandedMsgs.value = new Set()
    // chat convention: land at the bottom; silent refreshes only stick if already there
    await nextTick()
    if (!opts.silent || nearBottom) chatEl.value?.scrollTo({ top: chatEl.value.scrollHeight })
  }

  function select(s: SessionSummary) {
    selectedId.value = s.session_id
    selectedSource.value = s.source
    selectedLocator.value = s.locator ?? null
    loadTail()
  }

  // --- live transcript: follow the selected session's queue run -----------------
  // A run starting or finishing means the CLI just appended to the transcript on
  // disk; while one is active, poll so the reply streams into view.
  const runningRunId = computed(
    () =>
      (selectedSource.value === 'claude'
        ? deps.queue.value.find((q) => q.session_id === selectedId.value && q.status === 'running')
            ?.id
        : null) ?? null,
  )
  let tailPollTimer: number | undefined
  watch(runningRunId, (id, oldId) => {
    window.clearInterval(tailPollTimer)
    if (id) tailPollTimer = window.setInterval(() => loadTail({ silent: true }), 4000)
    if (!!id !== !!oldId && selectedId.value) loadTail({ silent: true })
  })
  onBeforeUnmount(() => window.clearInterval(tailPollTimer))

  // The three display controls the daemon applies (compact is purely visual, so it is not here).
  watch([deps.showTools, deps.showThinking, deps.humanOnly], () => loadTail())

  return {
    selectedId,
    selectedSource,
    selectedLocator,
    tail,
    tailLoading,
    chatEl,
    selected,
    loadTail,
    select,
    runningRunId,
    expandedMsgs,
    isExpanded,
    toggleExpand,
  }
}
