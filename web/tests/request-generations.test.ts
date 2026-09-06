// web/tests/request-generations.test.ts — AH-21: a superseded response must never overwrite what
// a newer request already answered. The hazard is the same shape everywhere it shows up (a slow
// answer to an old question landing after a fast answer to a new one), but the fix differs by what
// "newer" means for that caller:
//
//   - useData's queue/scheduler polls take no filter, so a plain generation counter is enough —
//     only the response belonging to the most recently ISSUED call may be applied. This mirrors
//     the sessions coalescer already in useData.ts, which this file does not touch or re-test.
//   - useOpenSession's transcript tail carries VIEW OPTIONS (textOnly/thinking/humanOnly), so
//     "same provider+session" alone is not "same request" — an older read can still land after a
//     newer one for the identical session and repaint it under controls the reader changed away
//     from. Its guard has to fold the view options in, not just the id/source pair.
//
// Both are exercised by resolving the OLDER call's promise strictly after the NEWER one's, then
// asserting the older answer never reaches the visible ref — "last resolved" must lose to "last
// issued".

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { nextTick, ref } from 'vue'
import type {
  QueueItem,
  SchedulerState,
  SessionSource,
  SessionSummary,
  TailResult,
} from '../src/lib/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function qItem(id: string): QueueItem {
  return {
    id,
    session_id: id,
    title: id,
    cwd: '/',
    prompt: '',
    model: null,
    effort: null,
    permission_mode: null,
    account_id: null,
    status: 'queued',
  } as unknown as QueueItem
}

function schedState(over: Partial<SchedulerState> = {}): SchedulerState {
  return {
    enabled: true,
    running_count: 0,
    queued_count: 0,
    spacing_seconds: 30,
    poll_seconds: 5,
    max_concurrent: 2,
    tomorrow_time: '09:00',
    ...over,
  }
}

function tailResult(over: Partial<TailResult> = {}): TailResult {
  return {
    session_id: 's1',
    source: 'claude' as SessionSource,
    title: 't',
    cwd: '/',
    events: [],
    ...over,
  } as TailResult
}

let queueCalls: { resolve: (v: QueueItem[]) => void }[] = []
let schedulerCalls: { resolve: (v: SchedulerState) => void }[] = []
let tailCalls: {
  opts: { limit?: number; textOnly?: boolean; thinking?: boolean; humanOnly?: boolean }
  resolve: (v: TailResult) => void
}[] = []

mock.module('../src/lib/api', () => ({
  getQueue: () => {
    const d = deferred<QueueItem[]>()
    queueCalls.push(d)
    return d.promise
  },
  getScheduler: () => {
    const d = deferred<SchedulerState>()
    schedulerCalls.push(d)
    return d.promise
  },
  getTail: (
    _id: string,
    _source: string,
    opts: { limit?: number; textOnly?: boolean; thinking?: boolean; humanOnly?: boolean },
  ) => {
    const d = deferred<TailResult>()
    tailCalls.push({ opts, resolve: d.resolve })
    return d.promise
  },
}))

const { useData } = await import('../src/composables/useData')
const { useOpenSession } = await import('../src/composables/useOpenSession')

const { queue, scheduler, refreshQueue, refreshScheduler } = useData()

describe('useData queue/scheduler request generations', () => {
  beforeEach(() => {
    queueCalls = []
    schedulerCalls = []
    queue.value = []
    scheduler.value = null
  })

  test('a slow old queue response cannot resurrect a row a newer refresh already dropped', async () => {
    const p1 = refreshQueue() // e.g. the 2s poll tick, in flight when a row gets deleted
    const p2 = refreshQueue() // the post-mutation refresh, issued after and answered sooner
    expect(queueCalls).toHaveLength(2)

    queueCalls[1].resolve([qItem('a')])
    await p2
    expect(queue.value.map((q) => q.id)).toEqual(['a'])

    queueCalls[0].resolve([qItem('a'), qItem('b')])
    await p1
    expect(queue.value.map((q) => q.id)).toEqual(['a'])
  })

  test('a slow old scheduler response cannot revert a newer view', async () => {
    const p1 = refreshScheduler()
    const p2 = refreshScheduler()
    expect(schedulerCalls).toHaveLength(2)

    schedulerCalls[1].resolve(schedState({ enabled: false, running_count: 3 }))
    await p2
    expect(scheduler.value).toEqual(schedState({ enabled: false, running_count: 3 }))

    schedulerCalls[0].resolve(schedState({ enabled: true, running_count: 0 }))
    await p1
    expect(scheduler.value).toEqual(schedState({ enabled: false, running_count: 3 }))
  })
})

describe('useOpenSession transcript request generations', () => {
  function setup() {
    const sessions = ref<SessionSummary[]>([
      { session_id: 's1', source: 'claude' } as unknown as SessionSummary,
    ])
    const showTools = ref(true)
    const showThinking = ref(false)
    const humanOnly = ref(false)
    const deps = {
      sessions,
      queue: ref<QueueItem[]>([]),
      showTools,
      showThinking,
      humanOnly,
    }
    const open = useOpenSession(deps)
    return { open, showThinking }
  }

  /** useOpenSession also watches the three display-option refs and reloads on its own when they
   *  change, so a manual second loadTail() call right after flipping one races that watcher's own
   *  fire-and-forget call — Vue schedules the watch flush as a microtask, and it isn't guaranteed
   *  to lose that race. Settling a few ticks (same pattern as shared-prefs.test.ts's settle()) is
   *  more robust than reaching for an exact promise handle for a call this test doesn't make. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await nextTick()
  }

  beforeEach(() => {
    tailCalls = []
  })

  test('an older transcript response requested with stale display options loses to the newer one', async () => {
    const { open, showThinking } = setup()
    open.select({ session_id: 's1', source: 'claude' } as unknown as SessionSummary)
    await settle()
    expect(tailCalls).toHaveLength(1)
    expect(tailCalls[0].opts.thinking).toBe(false)

    // Toggling a display control reloads the transcript on its own (useOpenSession's watch) —
    // this is the realistic way a second, differently-optioned request gets issued for the same
    // session while the first is still outstanding.
    showThinking.value = true
    await settle()
    expect(tailCalls).toHaveLength(2)
    expect(tailCalls[1].opts.thinking).toBe(true)

    // Newer (thinking: true) answers first.
    tailCalls[1].resolve(tailResult({ title: 'new' }))
    await settle()
    expect(open.tail.value?.title).toBe('new')

    // Older (thinking: false) answers late — must not repaint under the stale option.
    tailCalls[0].resolve(tailResult({ title: 'old' }))
    await settle()
    expect(open.tail.value?.title).toBe('new')
  })

  test('the pending flag is false once the latest request resolves, even with an older one still outstanding', async () => {
    const { open } = setup()
    open.selectedId.value = 's1'
    open.selectedSource.value = 'claude' as SessionSource

    const p1 = open.loadTail() // slow, still outstanding below
    const p2 = open.loadTail() // fast, resolves first
    expect(open.tailLoading.value).toBe(true)

    tailCalls[1].resolve(tailResult())
    await p2
    // The latest request settled — the flag must read "not loading" even though p1 is still out.
    expect(open.tailLoading.value).toBe(false)

    tailCalls[0].resolve(tailResult())
    await p1
    // The straggler finishing afterwards must not flip it back or otherwise misreport.
    expect(open.tailLoading.value).toBe(false)
  })
})
