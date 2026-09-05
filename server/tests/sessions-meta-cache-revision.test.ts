// server/tests/sessions-meta-cache-revision.test.ts — audit AH-36: the in-memory metadata cache
// must treat a revision as mtime AND size, the way the persisted cache and the in-flight key
// already do.
//
// Reproduced 2026-09-05: a 101-byte transcript was scanned, an assistant turn was appended (211
// bytes) and the mtime put back to the first value - the exact pair a coarse-timestamp
// filesystem produces on its own - and scanMeta() kept answering the first parse. The list's
// title, preview, count and ending all lagged a change the index had already detected.
//
// The scratch sqlite behind the persisted cache is the suite's (tests/setup.ts), so nothing here
// touches the developer's own scan cache.
import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanMeta } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

function record(role: 'user' | 'assistant', text: string, timestamp: string): string {
  return `${JSON.stringify({ type: role, message: { role, content: text }, timestamp })}\n`
}

test('a same-mtime, different-size revision is re-parsed, not served from the old L1 entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-meta-rev-'))
  try {
    const path = join(dir, 'same-mtime.jsonl')
    writeFileSync(path, record('user', 'first title', '2026-09-05T12:00:00Z'))
    const before = statSync(path)
    const tf: TranscriptFile = {
      session_id: 'same-mtime',
      source: 'claude',
      path,
      project: 'D--meta-rev',
      mtime_ms: before.mtimeMs,
      size_bytes: before.size,
      archived: false,
    }
    const first = await scanMeta(tf)
    expect(first?.title).toBe('first title')

    appendFileSync(path, record('assistant', 'new answer', '2026-09-05T12:01:00Z'))
    // Put the mtime back exactly where it was: the file changed, its timestamp did not.
    utimesSync(path, before.atime, before.mtime)
    const after = statSync(path)
    expect(after.size).toBeGreaterThan(before.size)

    const second = await scanMeta({ ...tf, size_bytes: after.size, mtime_ms: before.mtimeMs })
    expect(second?.last_text_preview).toBe('new answer')
    expect(second?.message_count).toBe(2)

    // And an unchanged revision still hits the cache (no re-parse of an identical file).
    const third = await scanMeta({ ...tf, size_bytes: after.size, mtime_ms: before.mtimeMs })
    expect(third).toBe(second)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
