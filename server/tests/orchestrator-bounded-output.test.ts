// server/tests/orchestrator-bounded-output.test.ts — audit AH-14: the orchestrator adapter bounds
// a child's output WHILE reading it, not after buffering all of it.
//
// Before this the adapter did `new Response(stream).text()` on both pipes and applied the 200k
// cap afterwards, so a verbose or runaway script had the daemon hold its entire output in memory
// first. drainBounded keeps the LAST `cap` characters as the bytes arrive and counts what it
// dropped; runOrchestrator folds that count into the one truncation header.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainBounded, MAX_OUTPUT_CHARS, pythonBinary, runOrchestrator } from '../src/orchestrator'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!))
      else controller.close()
    },
  })
}

test('drainBounded keeps the tail, counts the rest, and never holds more than the cap', async () => {
  const chunks = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(3, '0')}\n`)
  const total = chunks.join('')
  const { text, dropped } = await drainBounded(streamOf(chunks), 100)
  expect(text.length).toBe(100)
  expect(dropped).toBe(total.length - 100)
  expect(text).toBe(total.slice(-100))
  expect(text.endsWith('line 049\n')).toBe(true)
})

test('drainBounded under the cap drops nothing, and a missing stream is empty', async () => {
  expect(await drainBounded(streamOf(['short']), 100)).toEqual({ text: 'short', dropped: 0 })
  expect(await drainBounded(null)).toEqual({ text: '', dropped: 0 })
})

test('drainBounded decodes a multi-byte character split across chunks', async () => {
  const bytes = new TextEncoder().encode('ok 🟢 done')
  const a = bytes.slice(0, 5) // splits the 4-byte emoji
  const b = bytes.slice(5)
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(a)
      c.enqueue(b)
      c.close()
    },
  })
  expect((await drainBounded(stream)).text).toBe('ok 🟢 done')
})

test('the truncation header reports what the adapter dropped plus any final trim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-bounded-'))
  writeFileSync(join(dir, 'orch.py'), '# fake driver\n')
  const r = await runOrchestrator(
    { script: 'chats' },
    {
      dir,
      spawn: async () => ({
        code: 0,
        stdout: 'kept tail\nVERDICT: fine\n',
        stderr: 'x'.repeat(MAX_OUTPUT_CHARS + 10),
        timedOut: false,
        stdoutDropped: 5_000,
      }),
    },
  )
  if (!('stdout' in r)) throw new Error(`unexpected: ${JSON.stringify(r)}`)
  expect(r.stdout.startsWith('…[truncated 5000 chars]\n')).toBe(true)
  expect(r.stdout.endsWith('VERDICT: fine\n')).toBe(true)
  // No adapter count on stderr, so the header is the final trim alone.
  expect(r.stderr.startsWith('…[truncated 10 chars]\n')).toBe(true)
  expect(r.stderr.length).toBe(MAX_OUTPUT_CHARS + '…[truncated 10 chars]\n'.length)
})

// The real adapter against a real interpreter, where one is installed (the fake-spawn tests above
// pin the seam itself). A script that prints well past the cap on BOTH streams must come back
// bounded, with its last line intact and the loss counted, and the child must not deadlock on a
// full pipe while the other stream is being read.
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
  'a real child printing megabytes on both streams comes back bounded, verdict intact',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-bounded-real-'))
    writeFileSync(
      join(dir, 'orch.py'),
      [
        'import sys',
        'for i in range(12000):',
        '    sys.stdout.write("out line %05d " % i + "x" * 80 + "\\n")',
        '    sys.stderr.write("err line %05d " % i + "y" * 80 + "\\n")',
        'sys.stdout.write("VERDICT: done\\n")',
        'sys.stderr.write("STDERR END\\n")',
        '',
      ].join('\n'),
    )
    const r = await runOrchestrator({ script: 'chats', timeoutMs: 60_000 }, { dir })
    if (!('stdout' in r)) throw new Error(`unexpected: ${JSON.stringify(r)}`)
    expect(r.ok).toBe(true)
    expect(r.timedOut).toBe(false)
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 40)
    expect(r.stderr.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 40)
    expect(r.stdout.endsWith('VERDICT: done\n')).toBe(true)
    expect(r.stderr.endsWith('STDERR END\n')).toBe(true)
    const dropped = /^…\[truncated (\d+) chars\]\n/.exec(r.stdout)
    expect(dropped).not.toBeNull()
    // 12000 lines of ~96 chars is ~1.15 MB; well over 900k of it had to go.
    expect(Number(dropped?.[1])).toBeGreaterThan(900_000)
  },
  90_000,
)
