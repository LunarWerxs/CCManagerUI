// server/tests/github-updater-checksum.test.ts — audit AH-38: the compiled updater verifies a
// download against the release's SHA256SUMS.txt BEFORE extracting it or running anything out of
// it. Before this its only gate was `<new exe> --version`, which executes the download to test it.
//
// Pure and offline: a scratch file stands in for the archive, a hand-written manifest for the
// release's. The network wiring (fetching the manifest asset, refusing a release without one) is
// read in downloadAndVerifyUpdate / applyUpdate; what can be pinned deterministically is here.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSha256Sums, sha256File, verifyArchiveChecksum } from '../src/github-updater'

function scratchArchive(bytes: string): { dir: string; path: string; name: string; hex: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-checksum-'))
  const name = 'AgentHydra-9.9.9-windows-x64.zip'
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { dir, path, name, hex: createHash('sha256').update(bytes).digest('hex') }
}

test('parseSha256Sums reads the workflow manifest shape, binary markers, CRLF and junk lines', () => {
  const hex = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  const text = [
    `${hex}  out/AgentHydra-1.0.0-linux-x64.tar.gz`,
    `${other} *out/AgentHydra-1.0.0-windows-x64.zip\r`,
    '',
    'not a manifest line',
    `${'c'.repeat(63)}  out/too-short-hash.zip`,
    `${'D'.repeat(64)}  out\\AgentHydra-1.0.0-darwin-arm64.tar.gz`,
  ].join('\n')
  const sums = parseSha256Sums(text)
  expect(sums.get('AgentHydra-1.0.0-linux-x64.tar.gz')).toBe(hex)
  expect(sums.get('AgentHydra-1.0.0-windows-x64.zip')).toBe(other)
  expect(sums.get('AgentHydra-1.0.0-darwin-arm64.tar.gz')).toBe('d'.repeat(64))
  expect(sums.has('too-short-hash.zip')).toBe(false)
  expect(sums.size).toBe(3)
})

test('a download whose bytes match the manifest passes, and reports the digest', async () => {
  const a = scratchArchive('the release bytes')
  try {
    expect(await sha256File(a.path)).toBe(a.hex)
    const r = await verifyArchiveChecksum(a.path, a.name, `${a.hex}  out/${a.name}\n`)
    expect(r).toEqual({ ok: true, sha256: a.hex })
  } finally {
    rmSync(a.dir, { recursive: true, force: true })
  }
})

test('altered bytes are refused with both digests named', async () => {
  const a = scratchArchive('the release bytes')
  try {
    writeFileSync(a.path, 'the release bytes, plus one byte')
    const r = await verifyArchiveChecksum(a.path, a.name, `${a.hex}  out/${a.name}\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('SHA-256 mismatch')
      expect(r.reason).toContain(a.hex.slice(0, 12))
      expect(r.reason).toContain('refusing')
    }
  } finally {
    rmSync(a.dir, { recursive: true, force: true })
  }
})

test('a manifest with no entry for this asset is a refusal, not a pass', async () => {
  const a = scratchArchive('the release bytes')
  try {
    const r = await verifyArchiveChecksum(a.path, a.name, `${a.hex}  out/some-other-asset.zip\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('no entry for')
    const empty = await verifyArchiveChecksum(a.path, a.name, '')
    expect(empty.ok).toBe(false)
  } finally {
    rmSync(a.dir, { recursive: true, force: true })
  }
})

test('a foreign file that happens to carry the right name still fails on its bytes', async () => {
  // The scenario the version canary could never catch: something else printing the expected
  // version. The manifest is about the bytes the release published, not about what they print.
  const a = scratchArchive('genuine')
  try {
    const foreign = join(a.dir, 'foreign.zip')
    writeFileSync(foreign, 'looks fine, prints the right version, is not the release')
    const r = await verifyArchiveChecksum(foreign, a.name, `${a.hex}  out/${a.name}\n`)
    expect(r.ok).toBe(false)
  } finally {
    rmSync(a.dir, { recursive: true, force: true })
  }
})

test('a download that cannot be read is a refusal, not a crash', async () => {
  const r = await verifyArchiveChecksum(
    join(tmpdir(), 'ah-checksum-does-not-exist', 'x.zip'),
    'x.zip',
    `${'e'.repeat(64)}  out/x.zip\n`,
  )
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('could not hash')
})
