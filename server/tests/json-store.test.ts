// server/tests/json-store.test.ts — the three promises core/json-store.ts makes, each pinned.
//
//   1. A file that cannot be read is reported as such and NEVER rewritten (audit AH-01: a
//      malformed registry followed by one create used to come back as a fresh file holding only
//      the new record).
//   2. A write is atomic: the target is only ever touched by a rename, so no scratch file is left
//      behind and no half-written registry is ever observable.
//   3. Two PROCESSES mutating the same store both land: the interprocess lock is exercised by two
//      real `bun` children hammering one file, not by two promises in one thread (which JS's
//      single thread would serialize on its own and prove nothing).
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type JsonStoreSpec,
  mutateJsonStore,
  readJsonStore,
  writeJsonStoreAtomic,
} from '../src/core/json-store'

interface Store {
  rows: string[]
}

function specFor(path: string): JsonStoreSpec<Store> {
  return {
    path,
    decode: (parsed) => {
      if (!parsed || typeof parsed !== 'object') return null
      const rows = (parsed as { rows?: unknown }).rows
      return Array.isArray(rows) ? { rows: rows as string[] } : null
    },
    empty: () => ({ rows: [] }),
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ah-json-store-'))
}

test('missing, corrupt, wrong-shape and empty files are told apart', () => {
  const dir = scratch()
  try {
    const spec = specFor(join(dir, 'store.json'))
    expect(readJsonStore(spec).status).toBe('missing')

    writeFileSync(spec.path, '{not-json; synthetic-old-id}')
    const corrupt = readJsonStore(spec)
    expect(corrupt.status).toBe('corrupt')
    if (corrupt.status === 'corrupt') expect(corrupt.raw).toContain('synthetic-old-id')

    writeFileSync(spec.path, '{"somethingElse":true}')
    expect(readJsonStore(spec).status).toBe('corrupt')

    writeFileSync(spec.path, '')
    expect(readJsonStore(spec).status).toBe('corrupt')

    writeFileSync(spec.path, '{"rows":["a"]}')
    const ok = readJsonStore(spec)
    expect(ok.status).toBe('ok')
    if (ok.status === 'ok') expect(ok.value.rows).toEqual(['a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mutation against a corrupt store is refused and the bytes are untouched', () => {
  const dir = scratch()
  try {
    const spec = specFor(join(dir, 'store.json'))
    const original = '{not-json; synthetic-old-id}'
    writeFileSync(spec.path, original)
    let called = false
    const outcome = mutateJsonStore(spec, (store) => {
      called = true
      store.rows.push('new')
      return { result: null, changed: true }
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.status).toBe('corrupt')
    expect(called).toBe(false)
    // Byte-for-byte: the damaged registry is exactly what the owner will find to repair.
    expect(readFileSync(spec.path, 'utf8')).toBe(original)
    // And no lock or scratch file is left beside it.
    expect(readdirSync(dir)).toEqual(['store.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mutation that reports no change writes nothing; one that does writes atomically', () => {
  const dir = scratch()
  try {
    const spec = specFor(join(dir, 'store.json'))
    const untouched = mutateJsonStore(spec, () => ({ result: 1, changed: false }))
    expect(untouched.ok).toBe(true)
    expect(existsSync(spec.path)).toBe(false)

    const written = mutateJsonStore(spec, (store) => {
      store.rows.push('a')
      return { result: store.rows.length, changed: true }
    })
    expect(written.ok).toBe(true)
    if (written.ok) expect(written.result).toBe(1)
    expect(JSON.parse(readFileSync(spec.path, 'utf8'))).toEqual({ rows: ['a'] })
    expect(readdirSync(dir)).toEqual(['store.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed write leaves the previous file intact and no scratch behind', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'store.json')
    writeFileSync(path, '{"rows":["keep"]}')
    // A value JSON.stringify cannot serialize makes the write throw before the rename.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => writeJsonStoreAtomic(path, cyclic)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{"rows":["keep"]}')
    expect(readdirSync(dir)).toEqual(['store.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two processes appending to one store both survive (interprocess lock)', async () => {
  const dir = scratch()
  try {
    const path = join(dir, 'store.json')
    const modulePath = pathToFileURL(resolve(import.meta.dir, '../src/core/json-store.ts')).href
    const ROUNDS = 40
    // Each child appends ROUNDS rows tagged with its own name, one locked mutation per row, with
    // no delay between them so the two genuinely contend for the file.
    const script = (tag: string) => `
      const { mutateJsonStore } = await import(${JSON.stringify(modulePath)})
      const spec = {
        path: ${JSON.stringify(path)},
        decode: (p) => (p && Array.isArray(p.rows) ? { rows: p.rows } : null),
        empty: () => ({ rows: [] }),
      }
      const refused = []
      for (let i = 0; i < ${ROUNDS}; i++) {
        const out = mutateJsonStore(spec, (s) => { s.rows.push(${JSON.stringify(tag)} + ':' + i); return { result: null, changed: true } })
        if (!out.ok) refused.push(out.status + ': ' + out.reason)
      }
      console.log(JSON.stringify({ refused }))
    `
    const children = ['left', 'right'].map((tag) =>
      Bun.spawn([process.execPath, '-e', script(tag)], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      }),
    )
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { out, err, code }
      }),
    )
    for (const o of outputs) {
      expect(o.err).toBe('')
      expect(o.code).toBe(0)
      expect(JSON.parse(o.out.trim())).toEqual({ refused: [] })
    }
    const final = JSON.parse(readFileSync(path, 'utf8')) as Store
    expect(final.rows).toHaveLength(ROUNDS * 2)
    expect(final.rows.filter((r) => r.startsWith('left:'))).toHaveLength(ROUNDS)
    expect(final.rows.filter((r) => r.startsWith('right:'))).toHaveLength(ROUNDS)
    // Both children released their lock and cleaned their scratch files.
    expect(readdirSync(dir)).toEqual(['store.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test('a lock left by a dead process is broken instead of wedging every later write', () => {
  const dir = scratch()
  try {
    const spec = specFor(join(dir, 'store.json'))
    // A pid no live process can plausibly hold, stamped long ago.
    writeFileSync(`${spec.path}.lock`, JSON.stringify({ pid: 2_147_483_000, at: 1 }))
    const outcome = mutateJsonStore(spec, (store) => {
      store.rows.push('after-stale-lock')
      return { result: null, changed: true }
    })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(readFileSync(spec.path, 'utf8'))).toEqual({ rows: ['after-stale-lock'] })
    expect(existsSync(`${spec.path}.lock`)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
