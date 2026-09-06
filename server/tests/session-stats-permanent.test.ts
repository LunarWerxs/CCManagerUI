// server/tests/session-stats-permanent.test.ts — a chat's numbers outlive its transcript.
//
// THE LOSS THIS EXISTS TO STOP. Claude Code deletes transcripts on its own schedule
// (`cleanupPeriodDays`, 30 days by default) and warmSessionScanCache prunes every cache row whose
// file it can no longer glob. So a chat's entire history — what it cost, how long it ran, which
// account paid for it — used to evaporate a month after it finished, and the Analytics tab's "all
// time" quietly meant "the last month or so". Measured on the machine this was written for: 35,943
// transcripts totalling 233.5B tokens, with nothing older than 30 June, against a year of real use.
//
// The permanent record (db.ts session_stats) is written as each session is scanned and is NEVER
// pruned; the prune stamps `gone_at` instead. These tests pin the parts that make that true.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markSessionGone, scanSessionAnalytics } from '../src/analytics'
import { db } from '../src/db'

const dir = mkdtempSync(join(tmpdir(), 'ah-permanent-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function transcript(lines: unknown[]): string {
  const path = join(dir, `p${n++}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
  return path
}

const assistant = (at: string, usage: Record<string, number>) => ({
  type: 'assistant',
  timestamp: at,
  message: { role: 'assistant', model: 'claude-opus-5', usage },
})

/** An Edit call, which is what the line counters read. */
const edit = (at: string, file: string, oldText: string, newText: string) => ({
  type: 'assistant',
  timestamp: at,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: file, old_string: oldText, new_string: newText },
      },
    ],
  },
})

const U = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000 }

describe('what a scan captures for the permanent record', () => {
  test('edit churn is counted at scan time, because later there is nothing left to re-read', async () => {
    // editCount alone cannot tell a typo fix from a rewrite, and once the transcript is deleted
    // there is no way to work it out again — so it is captured now or never.
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2026-09-01T10:00:00.000Z', U),
        edit('2026-09-01T10:01:00.000Z', 'a.ts', 'one\ntwo', 'one\ntwo\nthree\nfour'),
        edit('2026-09-01T10:02:00.000Z', 'b.ts', '', 'only one line'),
      ]),
      'claude',
    )
    expect(a.editCount).toBe(2)
    // Two DISTINCT files — which editCount, a count of edit CALLS, does not tell you.
    expect(a.filesTouched.size).toBe(2)
    expect(a.linesRemoved).toBe(2)
    expect(a.linesAdded).toBe(5)
  })

  test('the same file edited twice is one file touched, not two', async () => {
    const a = await scanSessionAnalytics(
      transcript([
        assistant('2026-09-01T10:00:00.000Z', U),
        edit('2026-09-01T10:01:00.000Z', 'a.ts', 'x', 'y'),
        edit('2026-09-01T10:02:00.000Z', 'a.ts', 'y', 'z'),
      ]),
      'claude',
    )
    expect(a.editCount).toBe(2)
    expect(a.filesTouched.size).toBe(1)
  })

  test('a session that only read reports zero churn, not a missing number', async () => {
    const a = await scanSessionAnalytics(
      transcript([assistant('2026-09-01T10:00:00.000Z', U)]),
      'claude',
    )
    expect(a.editCount).toBe(0)
    expect(a.filesTouched.size).toBe(0)
    expect(a.linesAdded).toBe(0)
    expect(a.linesRemoved).toBe(0)
  })
})

describe('the record survives the transcript', () => {
  test('markSessionGone stamps the row without erasing a single number', () => {
    db.query(
      'insert or replace into session_stats (session_key, session_id, source, weighted, ' +
        'cost_usd, input_tokens, lines_added, first_seen_at, last_scanned_at, gone_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)',
    ).run('claude:gone-1', 'gone-1', 'claude', 1234, 5.5, 999, 42, 1, 2)

    markSessionGone.run(1_700_000_000_000, 'claude:gone-1')

    const row = db
      .query<
        {
          weighted: number
          cost_usd: number
          input_tokens: number
          lines_added: number
          gone_at: number
        },
        [string]
      >(
        'select weighted, cost_usd, input_tokens, lines_added, gone_at from session_stats ' +
          'where session_key = ?',
      )
      .get('claude:gone-1')

    expect(row).toBeTruthy()
    // The whole point: the transcript is gone and every figure is still here.
    expect(row?.gone_at).toBe(1_700_000_000_000)
    expect(row?.weighted).toBe(1234)
    expect(row?.cost_usd).toBe(5.5)
    expect(row?.input_tokens).toBe(999)
    expect(row?.lines_added).toBe(42)
  })

  test('stamping twice keeps the FIRST time it went, not the latest sweep', () => {
    // Every warm re-runs the prune; without the `gone_at is null` guard the date would march
    // forward forever and "when did I lose this" would stop being answerable.
    db.query(
      'insert or replace into session_stats (session_key, session_id, source, first_seen_at, ' +
        'last_scanned_at, gone_at) values (?, ?, ?, ?, ?, null)',
    ).run('claude:gone-2', 'gone-2', 'claude', 1, 2)
    markSessionGone.run(1000, 'claude:gone-2')
    markSessionGone.run(9999, 'claude:gone-2')
    const row = db
      .query<{ gone_at: number }, [string]>(
        'select gone_at from session_stats where session_key = ?',
      )
      .get('claude:gone-2')
    expect(row?.gone_at).toBe(1000)
  })
})
