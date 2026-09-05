// server/tests/registry-integrity.test.ts — audit AH-01 and AH-03 against the REAL registries.
//
// AH-01: a corrupt `cli-instances.json` / `codex-instances.json` followed by a create used to come
// back ok:true with a fresh file holding only the new record (reproduced 2026-09-05 by
// tmp/audit2/registry-corruption.mts against the unmodified functions). Now every mutation refuses
// and the damaged bytes are exactly what they were, so the identities in them can be recovered.
//
// AH-03: a delete whose directory removal FAILED used to splice the record anyway and report
// success, leaving the login on disk with no row to manage it from. Now the record stays and the
// real error comes back; the same button works once the lock is gone.
//
// CONFIG_DIR is the suite's scratch dir (tests/setup.ts), so the registry files touched here are
// throwaway ones - but they are SHARED with every other test file in this worker, so each test
// saves whatever it found and puts it back, corrupt bytes included, before it returns.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '../src/config'
import {
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  listCliInstances,
  reconcileCliInstanceDirs,
  renameCliInstance,
} from '../src/core/cli-instances'
import {
  createCodexInstance,
  deleteCodexInstance,
  getCodexInstance,
  reconcileCodexInstanceDirs,
  renameCodexInstance,
} from '../src/core/codex-instances'

const CLI_STORE = join(CONFIG_DIR, 'cli-instances.json')
const CODEX_STORE = join(CONFIG_DIR, 'codex-instances.json')
const CLI_ROOT = join(CONFIG_DIR, 'cli-instances')
const CODEX_ROOT = join(CONFIG_DIR, 'codex-instances')

const NO_PROCESSES = { listDesktopProcesses: async () => [] }

/** Hold a registry's current bytes (or its absence) and restore them exactly. */
function preserve(path: string): () => void {
  const had = existsSync(path)
  const bytes = had ? readFileSync(path) : null
  return () => {
    if (bytes) writeFileSync(path, bytes)
    else rmSync(path, { force: true })
  }
}

const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
})

const MALFORMED = '{not-json; synthetic-old-id-keep-me}'

describe('AH-01: a registry that cannot be read is never overwritten', () => {
  test('CLI: create against malformed JSON refuses, leaves the bytes, and mints no orphan dir', () => {
    restores.push(preserve(CLI_STORE))
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CLI_STORE, MALFORMED)

    const result = createCliInstance('created-after-corruption')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not a valid registry')
    expect(result.data?.registry).toBe('corrupt')
    // Byte-for-byte: the identities in the damaged file are still there to recover.
    expect(readFileSync(CLI_STORE, 'utf8')).toBe(MALFORMED)
    // The dir minted for the never-landed record was taken back.
    expect(reconcileCliInstanceDirs().orphanDirs).toEqual([])
    // Readers degrade to empty rather than throwing, and say why.
    expect(listCliInstances()).toEqual([])
    expect(reconcileCliInstanceDirs().registry).toBe('corrupt')
    // Every other mutator refuses the same way.
    expect(renameCliInstance('any', 'x').ok).toBe(false)
    expect(renameCliInstance('any', 'x').data?.registry).toBe('corrupt')
  })

  test('CLI: a wrong-shape document counts as corrupt, not empty', () => {
    restores.push(preserve(CLI_STORE))
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CLI_STORE, '{"instances":"not-an-array"}')
    expect(createCliInstance('x').ok).toBe(false)
    expect(readFileSync(CLI_STORE, 'utf8')).toBe('{"instances":"not-an-array"}')
  })

  test('Codex: create against malformed JSON refuses and leaves the bytes', () => {
    restores.push(preserve(CODEX_STORE))
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CODEX_STORE, MALFORMED)

    const result = createCodexInstance('created-after-corruption')
    expect(result.ok).toBe(false)
    expect(result.data?.registry).toBe('corrupt')
    expect(readFileSync(CODEX_STORE, 'utf8')).toBe(MALFORMED)
    expect(reconcileCodexInstanceDirs().registry).toBe('corrupt')
    expect(reconcileCodexInstanceDirs().orphanDirs).toEqual([])
    expect(renameCodexInstance('any', 'x').ok).toBe(false)
  })

  test('a missing registry is still simply empty: create works from nothing', () => {
    restores.push(preserve(CLI_STORE))
    rmSync(CLI_STORE, { force: true })
    const created = createCliInstance('from-nothing')
    expect(created.ok).toBe(true)
    const id = created.data?.id as string
    expect(getCliInstance(id)?.name).toBe('from-nothing')
    expect(deleteCliInstance(id, 'from-nothing').ok).toBe(true)
  })

  test('reconciliation reports a directory no record claims', () => {
    const orphan = join(CLI_ROOT, `orphan-${crypto.randomUUID()}`)
    mkdirSync(orphan, { recursive: true })
    try {
      expect(reconcileCliInstanceDirs().orphanDirs).toContain(orphan)
    } finally {
      rmSync(orphan, { recursive: true, force: true })
    }
    const codexOrphan = join(CODEX_ROOT, `orphan-${crypto.randomUUID()}`)
    mkdirSync(codexOrphan, { recursive: true })
    try {
      expect(reconcileCodexInstanceDirs().orphanDirs).toContain(codexOrphan)
    } finally {
      rmSync(codexOrphan, { recursive: true, force: true })
    }
  })
})

describe('AH-03: a delete whose directory survives keeps the record and says so', () => {
  test('CLI: a failing remove returns the error with the row intact; a later delete succeeds', () => {
    const name = `cli-locked-${crypto.randomUUID()}`
    const created = createCliInstance(name)
    expect(created.ok).toBe(true)
    const id = created.data?.id as string
    const configDir = created.data?.configDir as string
    try {
      const failed = deleteCliInstance(id, name, {
        removeDir: () => {
          throw new Error('EBUSY: resource busy or locked (injected)')
        },
      })
      expect(failed.ok).toBe(false)
      expect(failed.message).toContain('EBUSY')
      expect(failed.message).toContain('record was kept')
      expect(failed.data?.partial).toBe(true)
      expect(getCliInstance(id)).not.toBeNull()
      expect(existsSync(configDir)).toBe(true)

      // A remove that throws nothing but leaves the dir is caught by the absence check.
      const silent = deleteCliInstance(id, name, { removeDir: () => {} })
      expect(silent.ok).toBe(false)
      expect(silent.message).toContain('still exists')
      expect(getCliInstance(id)).not.toBeNull()
    } finally {
      const real = deleteCliInstance(id, name)
      expect(real.ok).toBe(true)
      expect(getCliInstance(id)).toBeNull()
      expect(existsSync(configDir)).toBe(false)
    }
  })

  test('Codex: a failing remove returns the error with the row intact; a later delete succeeds', async () => {
    const name = `codex-locked-${crypto.randomUUID()}`
    const created = createCodexInstance(name)
    expect(created.ok).toBe(true)
    const id = created.data?.id as string
    const codexHome = created.data?.codexHome as string
    try {
      const failed = await deleteCodexInstance(id, name, {
        ...NO_PROCESSES,
        removeDir: () => {
          throw new Error('EPERM: operation not permitted (injected)')
        },
      })
      expect(failed.ok).toBe(false)
      expect(failed.message).toContain('EPERM')
      expect(failed.data?.partial).toBe(true)
      expect(getCodexInstance(id)).not.toBeNull()
      expect(existsSync(codexHome)).toBe(true)

      const silent = await deleteCodexInstance(id, name, { ...NO_PROCESSES, removeDir: () => {} })
      expect(silent.ok).toBe(false)
      expect(silent.message).toContain('still exists')
      expect(getCodexInstance(id)).not.toBeNull()
    } finally {
      const real = await deleteCodexInstance(id, name, NO_PROCESSES)
      expect(real.ok).toBe(true)
      expect(getCodexInstance(id)).toBeNull()
      expect(existsSync(codexHome)).toBe(false)
    }
  })
})
