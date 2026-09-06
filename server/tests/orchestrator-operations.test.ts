// server/tests/orchestrator-operations.test.ts — audit AH-09: a long toolbox run is an operation
// with an id and a life beyond the HTTP connection that started it.
//
// Reproduced end to end on 2026-09-05: a 270-second command behind the daemon's 255-second idle
// timeout gave the client ECONNRESET, a retry answered "busy", and the original finished with
// nobody to tell. The registry here lets a retry with the same idempotency key get THE SAME
// operation (no second act), lets a caller poll by id, and lets a running operation be cancelled.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cancelOrchestratorOperation,
  getOrchestratorOperation,
  listOrchestratorOperations,
  pythonBinary,
  resetOrchestratorOperationsForTests,
  startOrchestratorOperation,
} from '../src/orchestrator'

afterEach(() => resetOrchestratorOperationsForTests())

function fakeToolbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-ops-'))
  writeFileSync(join(dir, 'orch.py'), '# fake driver\n')
  return dir
}

function deferred() {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  return { gate, release }
}

test('a retry with the same idempotency key joins the running operation and spawns nothing', async () => {
  const dir = fakeToolbox()
  const { gate, release } = deferred()
  let spawns = 0
  const deps = {
    dir,
    spawn: async () => {
      spawns++
      await gate
      return { code: 0, stdout: 'VERDICT: fine\n', stderr: '', timedOut: false }
    },
  }
  const first = startOrchestratorOperation({ script: 'chats' }, { idempotencyKey: 'k1', deps })
  expect(first.reused).toBe(false)
  expect(first.op.status).toBe('running')
  expect(getOrchestratorOperation(first.op.id)?.status).toBe('running')

  const retry = startOrchestratorOperation({ script: 'chats' }, { idempotencyKey: 'k1', deps })
  expect(retry.reused).toBe(true)
  expect(retry.op.id).toBe(first.op.id)
  expect(spawns).toBe(1)

  release()
  const done = await first.promise
  expect(done.status).toBe('done')
  expect(done.result && 'stdout' in done.result && done.result.stdout).toContain('VERDICT: fine')
  expect((await retry.promise).id).toBe(first.op.id)

  // Finished within the TTL: the same key still returns the original outcome, no second act.
  const later = startOrchestratorOperation({ script: 'chats' }, { idempotencyKey: 'k1', deps })
  expect(later.reused).toBe(true)
  expect((await later.promise).status).toBe('done')
  expect(spawns).toBe(1)
})

test('different keys, and no key, each get their own operation', async () => {
  const dir = fakeToolbox()
  let spawns = 0
  const deps = {
    dir,
    spawn: async () => {
      spawns++
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const a = startOrchestratorOperation({ script: 'chats' }, { idempotencyKey: 'a', deps })
  await a.promise
  const b = startOrchestratorOperation({ script: 'chats' }, { idempotencyKey: 'b', deps })
  await b.promise
  const c = startOrchestratorOperation({ script: 'chats' }, { deps })
  await c.promise
  expect(new Set([a.op.id, b.op.id, c.op.id]).size).toBe(3)
  expect(spawns).toBe(3)
  expect(listOrchestratorOperations().map((o) => o.id)).toContain(c.op.id)
})

test('a request refused before it ran does not pin its key: the retry runs for real', async () => {
  const dir = fakeToolbox()
  let spawns = 0
  const deps = {
    dir,
    spawn: async () => {
      spawns++
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  // An invalid script name is refused by validation - nothing spawned, status failed.
  const bad = startOrchestratorOperation({ script: 'Not A Script' }, { idempotencyKey: 'k2', deps })
  const badDone = await bad.promise
  expect(badDone.status).toBe('failed')
  expect(badDone.ran).toBe(false)
  expect(spawns).toBe(0)
  // The same key with a good request is not stuck behind that refusal.
  const good = startOrchestratorOperation({ script: 'chats' }, { idempotencyKey: 'k2', deps })
  expect(good.reused).toBe(false)
  expect((await good.promise).status).toBe('done')
  expect(spawns).toBe(1)
})

test('cancel marks a running operation cancelled once its spawn ends, and is a no-op afterwards', async () => {
  const dir = fakeToolbox()
  const { gate, release } = deferred()
  const deps = {
    dir,
    spawn: async () => {
      await gate
      return { code: 1, stdout: '', stderr: 'killed', timedOut: false }
    },
  }
  const op = startOrchestratorOperation({ script: 'sweep' }, { deps })
  const cancelled = cancelOrchestratorOperation(op.op.id)
  expect(cancelled).toEqual({ ok: true, status: 'running' })
  release()
  const done = await op.promise
  expect(done.status).toBe('cancelled')
  expect(cancelOrchestratorOperation(op.op.id)).toEqual({ ok: true, status: 'cancelled' })
  expect(cancelOrchestratorOperation('nope')).toEqual({ ok: false, error: 'no such operation' })
})

const hasPython = (() => {
  try {
    return (
      Bun.spawnSync([pythonBinary(), '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      }).exitCode === 0
    )
  } catch {
    return false
  }
})()

test.skipIf(!hasPython)(
  'cancelling a real running script kills it well before its deadline',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-ops-real-'))
    writeFileSync(
      join(dir, 'orch.py'),
      'import time\nprint("started", flush=True)\ntime.sleep(120)\n',
    )
    const started = Date.now()
    const op = startOrchestratorOperation(
      { script: 'chats', timeoutMs: 110_000 },
      { deps: { dir } },
    )
    // Give the interpreter a moment to exist, then cancel.
    await Bun.sleep(1500)
    expect(cancelOrchestratorOperation(op.op.id).ok).toBe(true)
    const done = await op.promise
    expect(done.status).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(30_000)
  },
  60_000,
)
