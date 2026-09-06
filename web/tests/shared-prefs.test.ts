// web/tests/shared-prefs.test.ts — the cross-window preference mirror (composables/useSharedPrefs).
//
// Every case here is a way of LOSING a preference, because that is the only symptom this component
// has: nothing throws, nothing logs, the usage filter is just off again. The daemon hops to another
// port whenever its preferred one is busy, and a new port is a new browser origin with an empty
// localStorage — so on those launches this store is not a backstop, it is the only memory the app
// has, and a value dropped here is a value gone.
//
// The api module is mocked rather than the network: what is under test is the ownership rule (when
// does the store win, when does this window win), not fetch. The mock is process-wide, though - in
// Bun, mock.module holds for every file that loads after this one - so the real exports are copied
// before the fake lands and put back in afterAll (see request-generations.test.ts for the incident).

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { nextTick, ref } from 'vue'

const KEY = 'agenthydra.instances.usageFilter.enabled'
const THRESHOLD_KEY = 'agenthydra.instances.usageFilter.threshold'
const VIEW_KEY = 'agenthydra.app.view'
const VIEWS = ['sessions', 'instances'] as const

/** What the daemon is holding. */
let store: Record<string, string> = {}
/** Reads to fail before the next one succeeds — a daemon still finishing its startup. */
let readFailures = 0
/** Every patch the client sent, in order. */
let writes: Record<string, string>[] = []
/** Writes to reject — a request the closing window cancelled. */
let writeFailures = 0

const realApi = { ...(await import('../src/lib/api')) }

mock.module('../src/lib/api', () => ({
  API_BASE: '',
  getUiPrefs: async () => {
    if (readFailures > 0) {
      readFailures -= 1
      throw new Error('connection refused')
    }
    return { prefs: { ...store } }
  },
  updateUiPrefs: async (patch: Record<string, string>) => {
    writes.push({ ...patch })
    if (writeFailures > 0) {
      writeFailures -= 1
      throw new Error('cancelled')
    }
    Object.assign(store, patch)
    return { prefs: { ...store } }
  },
}))

afterAll(() => {
  mock.module('../src/lib/api', () => realApi)
})

const { hydrateSharedPrefs, registerSharedPref, resetSharedPrefsForTest } = await import(
  '../src/composables/useSharedPrefs'
)

/** Let the watcher, the hydrate chain and the fire-and-forget push all settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick()
}

beforeEach(() => {
  resetSharedPrefsForTest()
  store = {}
  writes = []
  readFailures = 0
  writeFailures = 0
})

describe('hydrateSharedPrefs', () => {
  test('the store wins over a stale local cache', () => {
    // The whole point: this window's localStorage says the filter is off because it has never seen
    // this port before, and the store knows better.
    store[KEY] = 'true'
    const enabled = ref(false)
    registerSharedPref(KEY, enabled)
    return hydrateSharedPrefs().then(async () => {
      await settle()
      expect(enabled.value).toBe(true)
      // ...and it is not echoed straight back as if the user had chosen it.
      expect(writes).toEqual([])
    })
  })

  test('a first run seeds the store from what this browser already had', async () => {
    // Nothing stored yet, but this browser may carry years of settings. They go up in one write, so
    // the next window — on another port, with an empty localStorage — inherits the real setup.
    registerSharedPref(KEY, ref(true))
    registerSharedPref(THRESHOLD_KEY, ref(70))
    await hydrateSharedPrefs()
    await settle()
    expect(writes).toEqual([{ [KEY]: 'true', [THRESHOLD_KEY]: '70' }])
    expect(store).toEqual({ [KEY]: 'true', [THRESHOLD_KEY]: '70' })
  })

  test('a key the store has never heard of is seeded while the rest are applied', async () => {
    // Adding a preference to the mirror in a later version is the same shape as a first run, one
    // key at a time: what the store knows wins, what it has never seen is carried up from here.
    store[KEY] = 'true'
    const enabled = ref(false)
    const threshold = ref(70)
    registerSharedPref(KEY, enabled)
    registerSharedPref(THRESHOLD_KEY, threshold)
    await hydrateSharedPrefs()
    await settle()
    expect(enabled.value).toBe(true)
    expect(writes).toEqual([{ [THRESHOLD_KEY]: '70' }])
  })

  test('a choice made while the first read is in flight survives, and is pushed', async () => {
    // The regression that started this: the window paints from an empty localStorage, so the filter
    // reads as off; turning it on right then was dropped by the watcher and then overwritten by the
    // value hydrate brought back. The user sees their click undo itself a moment after making it.
    store[KEY] = 'false'
    const enabled = ref(false)
    registerSharedPref(KEY, enabled)

    const hydrating = hydrateSharedPrefs()
    enabled.value = true // the click, before the read has come back
    await hydrating
    await settle()

    expect(enabled.value).toBe(true)
    expect(store[KEY]).toBe('true')
  })

  test('a read that fails once is retried rather than leaving the window on its defaults', async () => {
    // A window opened by a daemon that is still coming up. One failure used to be permanent: no
    // retry, no second hydrate, and the window ran on its cache — defaults, on a fresh port.
    store[KEY] = 'true'
    readFailures = 1
    const enabled = ref(false)
    registerSharedPref(KEY, enabled)
    await hydrateSharedPrefs()
    await settle()
    expect(enabled.value).toBe(true)
  })

  test('a store that never answers leaves local values alone and still pushes later changes', async () => {
    readFailures = 99
    const enabled = ref(true)
    registerSharedPref(KEY, enabled)
    await hydrateSharedPrefs()
    expect(enabled.value).toBe(true)

    enabled.value = false
    await settle()
    expect(writes).toEqual([{ [KEY]: 'false' }])
  })

  test('a preference registered after hydrate still gets the stored value', async () => {
    // Hydrate runs once per window and can only apply what is registered at that moment, so a
    // lazily-loaded view would otherwise opt itself out of the store for the window's whole life.
    store[KEY] = 'true'
    await hydrateSharedPrefs()
    const enabled = ref(false)
    registerSharedPref(KEY, enabled)
    await settle()
    expect(enabled.value).toBe(true)
    expect(writes).toEqual([])
  })
})

describe('registerSharedPref', () => {
  test('a change is written through to the store', async () => {
    store[KEY] = 'false'
    const enabled = ref(false)
    registerSharedPref(KEY, enabled)
    await hydrateSharedPrefs()

    enabled.value = true
    await settle()
    expect(writes).toEqual([{ [KEY]: 'true' }])
    expect(store[KEY]).toBe('true')
  })

  test('a write that never lands stays queued instead of being silently reverted', async () => {
    // The push the closing window cancelled. The value is still ours and still unconfirmed, so the
    // next change carries it along rather than leaving the store holding the old one.
    store[KEY] = 'false'
    store[THRESHOLD_KEY] = '80'
    const enabled = ref(false)
    const threshold = ref(80)
    registerSharedPref(KEY, enabled)
    registerSharedPref(THRESHOLD_KEY, threshold)
    await hydrateSharedPrefs()

    writeFailures = 1
    enabled.value = true
    await settle()
    expect(store[KEY]).toBe('false') // the write was lost

    threshold.value = 70
    await settle()
    expect(store).toEqual({ [KEY]: 'true', [THRESHOLD_KEY]: '70' })
  })

  test('the same key cannot be registered twice', async () => {
    store[KEY] = 'false'
    const enabled = ref(false)
    registerSharedPref(KEY, enabled)
    registerSharedPref(KEY, enabled)
    await hydrateSharedPrefs()

    enabled.value = true
    await settle()
    // One watcher, therefore one write — not a duplicate round trip per change.
    expect(writes).toEqual([{ [KEY]: 'true' }])
  })

  test('a string preference round-trips as written', async () => {
    // Booleans and numbers are not the whole set: the tab you were on and the session filters are
    // short enums, and they mirror through the same store in vueuse's own format (no quoting).
    store[VIEW_KEY] = 'instances'
    const view = ref('sessions')
    registerSharedPref(VIEW_KEY, view, VIEWS)
    await hydrateSharedPrefs()
    await settle()
    expect(view.value).toBe('instances')

    view.value = 'sessions'
    await settle()
    expect(store[VIEW_KEY]).toBe('sessions')
  })

  test('a string outside its declared set is refused rather than rendered', async () => {
    // The store is a plain file on disk. A hand-edited or downgrade-era value must not put the UI
    // in a state the UI cannot produce — a tab that does not exist, a filter with no such option.
    store[VIEW_KEY] = 'quantum'
    const view = ref('sessions')
    registerSharedPref(VIEW_KEY, view, VIEWS)
    await hydrateSharedPrefs()
    await settle()
    expect(view.value).toBe('sessions')
  })

  test('a stored value that does not parse is ignored rather than coerced', async () => {
    // A hand-edited file must not put NaN into a threshold or flip a boolean by accident.
    store[KEY] = 'yes'
    store[THRESHOLD_KEY] = 'eighty'
    const enabled = ref(true)
    const threshold = ref(80)
    registerSharedPref(KEY, enabled)
    registerSharedPref(THRESHOLD_KEY, threshold)
    await hydrateSharedPrefs()
    await settle()
    expect(enabled.value).toBe(true)
    expect(threshold.value).toBe(80)
  })
})
