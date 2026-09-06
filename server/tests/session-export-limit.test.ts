// server/tests/session-export-limit.test.ts — audit AH-37: the export path is not constant-memory
// (the rendered document is one string by contract), so it now has an explicit ceiling that is
// checked before a byte is parsed and reported as a distinct refusal, never as "not found" and
// never as a silently truncated document.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPORT_MAX_BYTES_DEFAULT,
  exportMaxBytes,
  exportSession,
  isExportRefused,
} from '../src/session-export'
import type { TranscriptFile } from '../src/transcript'

function claudeTranscript(dir: string, sessionId: string, turns: number): TranscriptFile {
  const path = join(dir, `${sessionId}.jsonl`)
  const lines: string[] = []
  for (let i = 0; i < turns; i++) {
    lines.push(
      JSON.stringify({
        type: i % 2 ? 'assistant' : 'user',
        message: { role: i % 2 ? 'assistant' : 'user', content: `turn ${i} says hello` },
        timestamp: `2026-09-05T12:${String(i % 60).padStart(2, '0')}:00Z`,
      }),
    )
  }
  writeFileSync(path, `${lines.join('\n')}\n`)
  const st = statSync(path)
  return {
    session_id: sessionId,
    source: 'claude',
    path,
    project: 'D--export-limit',
    mtime_ms: st.mtimeMs,
    size_bytes: st.size,
    archived: false,
  }
}

test('a transcript over the ceiling is refused up front, naming both sizes, and nothing is parsed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-export-limit-'))
  try {
    const tf = claudeTranscript(dir, 'big', 40)
    let reads = 0
    const result = await exportSession(
      'big',
      'markdown',
      'claude',
      {},
      {
        findTranscript: async () => {
          reads++
          return tf
        },
        maxBytes: 100, // the fixture is a few KB; the ceiling is what is under test
      },
    )
    expect(isExportRefused(result)).toBe(true)
    if (isExportRefused(result)) {
      expect(result.sizeBytes).toBe(tf.size_bytes)
      expect(result.limitBytes).toBe(100)
      expect(result.message).toContain('export refused')
      expect(result.message).toContain('Download the raw transcript instead')
    }
    expect(reads).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('under the ceiling the export renders in full, unchanged by the guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-export-limit-'))
  try {
    const tf = claudeTranscript(dir, 'small', 6)
    const result = await exportSession(
      'small',
      'markdown',
      'claude',
      { title: 'Small chat' },
      { findTranscript: async () => tf, maxBytes: 1024 * 1024 },
    )
    expect(isExportRefused(result)).toBe(false)
    expect(result).not.toBeNull()
    if (result && !isExportRefused(result)) {
      expect(result.turns).toBe(6)
      expect(result.body).toContain('turn 5 says hello')
      expect(result.body).toContain('Small chat')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session the index does not know is still null, not a refusal', async () => {
  const result = await exportSession(
    'nope',
    'html',
    'claude',
    {},
    { findTranscript: async () => null },
  )
  expect(result).toBeNull()
})

test('the ceiling defaults to 64 MB and honours AGENTHYDRA_EXPORT_MAX_MB', () => {
  expect(EXPORT_MAX_BYTES_DEFAULT).toBe(64 * 1024 * 1024)
  expect(exportMaxBytes({})).toBe(EXPORT_MAX_BYTES_DEFAULT)
  expect(exportMaxBytes({ AGENTHYDRA_EXPORT_MAX_MB: '256' })).toBe(256 * 1024 * 1024)
  expect(exportMaxBytes({ AGENTHYDRA_EXPORT_MAX_MB: '0.5' })).toBe(512 * 1024)
  // Nonsense falls back to the default rather than to "no ceiling".
  expect(exportMaxBytes({ AGENTHYDRA_EXPORT_MAX_MB: 'lots' })).toBe(EXPORT_MAX_BYTES_DEFAULT)
  expect(exportMaxBytes({ AGENTHYDRA_EXPORT_MAX_MB: '-5' })).toBe(EXPORT_MAX_BYTES_DEFAULT)
})
