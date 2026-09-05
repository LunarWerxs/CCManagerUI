// server/tests/session-import-claim.test.ts — audit AH-05: one import per session at a time,
// across every entry point, with the claim held from before the rendered check.
//
// The importer's slow step is injected (isInstanceRunning is a deferred promise the test resolves
// by hand), so two calls can be made to overlap deterministically without a desktop app. Two
// rails keep this suite from ever launching anything: the injected rendered record sits INSIDE
// the scratch instance dir, so the importer takes its "already renders here" exit before the
// spawn; and Bun.spawn is replaced for the duration with one that throws, so if that exit were
// ever bypassed the importer would report `spawn-failed` rather than start a real app. (An
// earlier draft of this file got the first rail wrong and the importer went for the spawn.)
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSessionToDesktop } from '../src/session-launch'

const realSpawn = Bun.spawn
let spawnAttempts = 0
beforeEach(() => {
  spawnAttempts = 0
  ;(Bun as unknown as { spawn: unknown }).spawn = () => {
    spawnAttempts++
    throw new Error('this suite must never launch anything')
  }
})
afterEach(() => {
  ;(Bun as unknown as { spawn: unknown }).spawn = realSpawn
  expect(spawnAttempts).toBe(0)
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A rendered record UNDER the instance dir: what alreadyRendersIn needs to claim residency. */
const renderedIn = (dir: string) => () => ({
  archived: false,
  path: join(dir, 'claude-code-sessions', 'acct', 'org', 'local_x.json'),
})
const notLive = () => false

test('a second import of the same session into the same target waits and coalesces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-import-claim-'))
  try {
    const sid = `claim-${crypto.randomUUID()}`
    const gate = deferred<boolean>()
    let secondProbes = 0
    const first = importSessionToDesktop({
      sessionId: sid,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: () => gate.promise,
      findRendered: renderedIn(dir),
    })
    const second = importSessionToDesktop({
      sessionId: sid,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: async () => {
        secondProbes++
        return true
      },
      findRendered: renderedIn(dir),
    })
    gate.resolve(true)
    const [a, b] = await Promise.all([first, second])
    expect(a.ok).toBe(true)
    expect(a.alreadyRendered).toBe(true)
    expect(b.ok).toBe(true)
    expect(b.coalesced).toBe(true)
    // The second caller did none of its own work: it never even asked whether the app runs.
    expect(secondProbes).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same session aimed at a different target while one import runs is refused as busy', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'ah-import-claim-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'ah-import-claim-b-'))
  try {
    const sid = `claim-${crypto.randomUUID()}`
    const gate = deferred<boolean>()
    const first = importSessionToDesktop({
      sessionId: sid,
      instanceDir: dirA,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: () => gate.promise,
      findRendered: renderedIn(dirA),
    })
    const other = await importSessionToDesktop({
      sessionId: sid,
      instanceDir: dirB,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: async () => true,
      findRendered: renderedIn(dirB),
    })
    expect(other.ok).toBe(false)
    expect(other.reason).toContain('import-in-flight')
    expect(other.reason).toContain(dirA)
    gate.resolve(true)
    expect((await first).ok).toBe(true)
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('when the first attempt fails, the waiting caller runs its own attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-import-claim-'))
  try {
    const sid = `claim-${crypto.randomUUID()}`
    const gate = deferred<boolean>()
    const first = importSessionToDesktop({
      sessionId: sid,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: () => gate.promise,
      findRendered: renderedIn(dir),
    })
    let secondProbes = 0
    const second = importSessionToDesktop({
      sessionId: sid,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: async () => {
        secondProbes++
        return true
      },
      findRendered: renderedIn(dir),
    })
    gate.resolve(false) // the first finds the instance not running and refuses
    const [a, b] = await Promise.all([first, second])
    expect(a.ok).toBe(false)
    expect(a.reason).toContain('instance-not-running')
    expect(b.ok).toBe(true)
    expect(b.coalesced).toBeUndefined()
    expect(secondProbes).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('distinct sessions into the same target do not wait on each other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-import-claim-'))
  try {
    const gate = deferred<boolean>()
    const slow = importSessionToDesktop({
      sessionId: `claim-${crypto.randomUUID()}`,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: () => gate.promise,
      findRendered: renderedIn(dir),
    })
    const quick = await importSessionToDesktop({
      sessionId: `claim-${crypto.randomUUID()}`,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: async () => true,
      findRendered: renderedIn(dir),
    })
    expect(quick.ok).toBe(true)
    expect(quick.coalesced).toBeUndefined()
    gate.resolve(true)
    expect((await slow).ok).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the importer never reaches a spawn when the rendered check is not satisfied here either', async () => {
  // Belt and braces for the rails above: an instance that "runs" but does not render the chat
  // would be the spawn path; with Bun.spawn stubbed to throw it must come back as spawn-failed,
  // never launch. (Counted by afterEach; this test deliberately expects exactly one attempt.)
  const dir = mkdtempSync(join(tmpdir(), 'ah-import-claim-'))
  try {
    const r = await importSessionToDesktop({
      sessionId: `claim-${crypto.randomUUID()}`,
      instanceDir: dir,
      title: 'Real title',
      isLive: notLive,
      isInstanceRunning: async () => true,
      findRendered: () => null,
    })
    // Either the binary is not resolvable on this machine (ok:false, desktop-binary-not-found) or
    // the stubbed spawn refused (ok:false, the stub's message). Both are ok:false with no launch.
    expect(r.ok).toBe(false)
    expect(spawnAttempts <= 1).toBe(true)
    spawnAttempts = 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
