// server/tests/instance-logout.test.ts — signing an instance out, and refusing to when it is unsafe.
//
// A login lives entirely in `<dir>/config.json`: `lastKnownAccountUuid` names the account and
// `oauth:tokenCacheV2` (older builds: `oauth:tokenCache`) holds the encrypted grants. Removing
// those three keys is the whole operation.
//
// THE GUARD IS THE POINT. Claude Desktop is an Electron app that holds config.json open and
// re-saves it on its own schedule, so a logout written under a running instance is either clobbered
// (the button lied) or interleaved with the app's write (the profile is corrupt AND still signed
// in). Neither announces itself, which is exactly why it is pinned here rather than trusted.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logoutInstance } from '../src/core/instance-logout'

const root = mkdtempSync(join(tmpdir(), 'ah-logout-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
/** A profile dir with a config.json holding a login plus some unrelated settings. */
function profile(config: Record<string, unknown>): string {
  const dir = join(root, `inst${n++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  return dir
}

const SIGNED_IN = {
  lastKnownAccountUuid: '0000-aaaa-bbbb',
  'oauth:tokenCacheV2': 'BASE64BLOB',
  theme: 'dark',
  windowBounds: { width: 1200, height: 800 },
}

/** No Claude process anywhere. */
const noProcs = async () => []
/** One running from this dir. */
const runningIn = (dir: string) => async () =>
  [{ dir, pid: 1234, isMain: true }] as unknown as Awaited<ReturnType<typeof noProcs>>

describe('logoutInstance', () => {
  test('removes every login key and leaves the rest of the profile alone', async () => {
    const dir = profile({ ...SIGNED_IN })
    const r = await logoutInstance(dir, { listProcesses: noProcs })
    expect(r.ok).toBe(true)

    const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(after.lastKnownAccountUuid).toBeUndefined()
    expect(after['oauth:tokenCacheV2']).toBeUndefined()
    // The settings are not ours to touch. A "logout" that reset someone's theme would be a
    // different, unasked-for operation wearing this one's name.
    expect(after.theme).toBe('dark')
    expect(after.windowBounds).toEqual({ width: 1200, height: 800 })
  })

  test('the older token key is removed too', async () => {
    // Older builds wrote `oauth:tokenCache`. Leaving it would sign the profile out on paper while
    // a usable grant sat in the file.
    const dir = profile({ lastKnownAccountUuid: 'x', 'oauth:tokenCache': 'OLDBLOB' })
    const r = await logoutInstance(dir, { listProcesses: noProcs })
    expect(r.ok).toBe(true)
    const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(after['oauth:tokenCache']).toBeUndefined()
  })

  test('REFUSES while the instance is running, and changes nothing', async () => {
    const dir = profile({ ...SIGNED_IN })
    const r = await logoutInstance(dir, { listProcesses: runningIn(dir) })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('running')
    // The file must be untouched, not merely "mostly" untouched.
    const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(after.lastKnownAccountUuid).toBe('0000-aaaa-bbbb')
    expect(after['oauth:tokenCacheV2']).toBe('BASE64BLOB')
  })

  test('a DIFFERENT instance running does not block this one', async () => {
    // The guard is about this profile, not about Claude being open at all. Over-refusing would
    // make the button useless on a machine that always has something running.
    const dir = profile({ ...SIGNED_IN })
    const other = profile({ ...SIGNED_IN })
    const r = await logoutInstance(dir, { listProcesses: runningIn(other) })
    expect(r.ok).toBe(true)
  })

  test('a process scan that fails REFUSES rather than assuming nothing is running', async () => {
    // "I could not tell" is not permission: the guard exists for exactly the case we cannot rule
    // out, and the cost of being wrong is a corrupt profile.
    const dir = profile({ ...SIGNED_IN })
    const r = await logoutInstance(dir, {
      listProcesses: async () => {
        throw new Error('wmic unavailable')
      },
    })
    expect(r.ok).toBe(false)
    const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(after.lastKnownAccountUuid).toBe('0000-aaaa-bbbb')
  })

  test('an already signed-out profile succeeds and says nothing was removed', async () => {
    // Reported as a success with an empty `removed`, so a caller can tell "signed out" from
    // "there was nothing to sign out of" instead of both reading as done.
    const dir = profile({ theme: 'light' })
    const r = await logoutInstance(dir, { listProcesses: noProcs })
    expect(r.ok).toBe(true)
    expect((r.data as { removed: string[] }).removed).toEqual([])
  })

  test('a profile with no config.json is a failure, not a silent success', async () => {
    const dir = join(root, 'nothing-here')
    mkdirSync(dir, { recursive: true })
    const r = await logoutInstance(dir, { listProcesses: noProcs })
    expect(r.ok).toBe(false)
  })
})
