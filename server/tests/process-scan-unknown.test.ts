// server/tests/process-scan-unknown.test.ts — audit AH-02: an unknown process state must never
// mean "stopped" to a delete.
//
// Reproduced 2026-09-05 (tmp/audit2/process-fail-open.mts): with Bun.spawn injected to fail, the
// real scanner returned [] and the real removeInstance deleted a synthetic profile. Its own
// catch-and-refuse never fired because the scanner had already swallowed the error. The fix keeps
// "none running" and "could not look" apart (scanClaudeProcesses / scanCodexDesktopProcesses) and
// makes both deletes refuse the latter, while the lenient list* shapes the UI tables read stay
// exactly as they were.
//
// The desktop-profile fixtures live under instancesRoot(), which tests/setup.ts points at the
// suite's scratch dir; nothing here goes near a real profile.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  codexDesktopRunState,
  invalidateCodexProcessCache,
  listCodexDesktopProcesses,
  scanCodexDesktopProcesses,
} from '../src/core/codex-desktop'
import {
  createCodexInstance,
  deleteCodexInstance,
  getCodexInstance,
} from '../src/core/codex-instances'
import { removeInstance } from '../src/core/lifecycle'
import { instancesRoot } from '../src/core/paths'
import {
  invalidateClaudeProcessCache,
  listClaudeProcesses,
  procTableForTests,
  scanClaudeProcesses,
} from '../src/core/process'

const cleanupDirs: string[] = []
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function desktopFixture(label: string): string {
  const dir = join(instancesRoot(), `ah-scan-unknown-${label}-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'synthetic.txt'), 'no real profile data')
  cleanupDirs.push(dir)
  return dir
}

/** Run `fn` with Bun.spawn replaced by one that throws - and, since Linux now answers from /proc
 *  without spawning anything, with the /proc table answering "unreadable" too - then put both
 *  back and drop the caches. "Could not look" must be reachable on every platform. */
async function withBrokenSpawn<T>(fn: () => Promise<T>): Promise<T> {
  const actual = Bun.spawn
  const actualProc = procTableForTests.override
  ;(Bun as unknown as { spawn: unknown }).spawn = () => {
    throw new Error('injected process-enumeration failure')
  }
  procTableForTests.override = () => null
  try {
    return await fn()
  } finally {
    ;(Bun as unknown as { spawn: unknown }).spawn = actual
    procTableForTests.override = actualProc
    invalidateClaudeProcessCache()
    invalidateCodexProcessCache()
  }
}

describe('the scanners tell "could not look" apart from "none running"', () => {
  test('Claude: a failed enumeration is ok:false; the lenient list is still []', async () => {
    await withBrokenSpawn(async () => {
      const scan = await scanClaudeProcesses({ fresh: true })
      expect(scan.ok).toBe(false)
      if (!scan.ok) expect(scan.reason).toBeTruthy()
      expect(await listClaudeProcesses({ fresh: true })).toEqual([])
    })
  })

  test('Codex: a failed enumeration is ok:false; the lenient list is still []', async () => {
    await withBrokenSpawn(async () => {
      const scan = await scanCodexDesktopProcesses({ fresh: true })
      expect(scan.ok).toBe(false)
      expect(await listCodexDesktopProcesses({ fresh: true })).toEqual([])
      const state = await codexDesktopRunState({
        id: 'x',
        name: 'x',
        codexHome: join(instancesRoot(), 'nope'),
      })
      expect(state.state).toBe('unknown')
    })
  })
})

describe('removeInstance (Claude Desktop profile)', () => {
  test('refuses on an injected unknown scan and leaves the profile in place', async () => {
    const dir = desktopFixture('injected')
    const result = await removeInstance(dir, {
      confirmName: basename(dir),
      scanProcesses: async () => ({ ok: false, reason: 'injected' }),
    })
    expect(result.ok).toBe(false)
    expect(result.data?.runningState).toBe('unknown')
    expect(result.message).toContain('unknown state is not a stopped instance')
    expect(existsSync(dir)).toBe(true)
  })

  test('refuses when the REAL scanner cannot enumerate (the audit reproduction, inverted)', async () => {
    const dir = desktopFixture('real')
    const result = await withBrokenSpawn(() => removeInstance(dir, { confirmName: basename(dir) }))
    expect(result.ok).toBe(false)
    expect(result.data?.runningState).toBe('unknown')
    expect(existsSync(dir)).toBe(true)
  })

  test('a successful empty scan still deletes a stopped fixture', async () => {
    const dir = desktopFixture('stopped')
    const result = await removeInstance(dir, {
      confirmName: basename(dir),
      scanProcesses: async () => ({ ok: true, processes: [] }),
    })
    expect(result.ok).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  test('a scan that shows the profile running still refuses, naming the pid', async () => {
    const dir = desktopFixture('running')
    const result = await removeInstance(dir, {
      confirmName: basename(dir),
      scanProcesses: async () => ({
        ok: true,
        processes: [{ pid: 4321, cmdline: `claude --user-data-dir=${dir}`, dir, isMain: true }],
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.data?.runningState).toBe('running')
    expect(result.data?.pid).toBe(4321)
    expect(existsSync(dir)).toBe(true)
  })
})

describe('deleteCodexInstance', () => {
  test('refuses on an unknown scan, deletes on a successful empty one', async () => {
    const name = `codex-unknown-${crypto.randomUUID()}`
    const created = createCodexInstance(name)
    expect(created.ok).toBe(true)
    const id = created.data?.id as string
    const codexHome = created.data?.codexHome as string
    try {
      const unknown = await deleteCodexInstance(id, name, {
        scanDesktopProcesses: async () => ({ ok: false, reason: 'injected' }),
      })
      expect(unknown.ok).toBe(false)
      expect(unknown.data?.runningState).toBe('unknown')
      expect(getCodexInstance(id)).not.toBeNull()
      expect(existsSync(codexHome)).toBe(true)

      const real = await withBrokenSpawn(() => deleteCodexInstance(id, name))
      expect(real.ok).toBe(false)
      expect(real.data?.runningState).toBe('unknown')
      expect(getCodexInstance(id)).not.toBeNull()
    } finally {
      // The legacy plain-list injection every existing test uses still reads as a successful scan.
      const ok = await deleteCodexInstance(id, name, { listDesktopProcesses: async () => [] })
      expect(ok.ok).toBe(true)
      expect(getCodexInstance(id)).toBeNull()
      expect(existsSync(codexHome)).toBe(false)
    }
  })
})
