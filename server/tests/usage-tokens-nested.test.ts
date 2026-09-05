// server/tests/usage-tokens-nested.test.ts — audit AH-33: the quota budget's token count must see
// the transcripts nested under a parent session (Task-tool subagents, workflow descendants), which
// the transcript index already counts as separate spend.
//
// Reproduced 2026-09-05: a config dir whose ONLY eligible usage record sat at
// projects/<proj>/<parent>/subagents/child.jsonl came back from tokensSince() as raw 0 / turns 0.
// The fixtures here are hand-written JSONL, no real session data.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tokensSince } from '../src/usage-tokens'

const AT = '2026-09-05T12:00:00Z'
const SINCE = new Date('2026-09-05T11:00:00Z')

function usageRecord(requestId: string, input: number, output: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: AT,
    requestId,
    message: {
      id: `msg-${requestId}`,
      model: 'claude-sonnet-4-20260101',
      usage: { input_tokens: input, output_tokens: output },
    },
  })}\n`
}

test('a usage record that exists only in a nested subagent transcript is counted once', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-nested-usage-'))
  try {
    const nested = join(home, 'projects', 'D--work', 'parent-session', 'subagents')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'agent-1.jsonl'), usageRecord('nested-request', 10, 2))
    const spend = tokensSince(SINCE, [home])
    expect(spend.raw).toBe(12)
    expect(spend.turns).toBe(1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('parent and child transcripts add up, and a request id seen in both is charged once', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-nested-usage-'))
  try {
    const project = join(home, 'projects', 'D--work')
    const nested = join(project, 'parent-session', 'subagents')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(project, 'parent-session.jsonl'), usageRecord('parent-request', 100, 5))
    writeFileSync(
      join(nested, 'agent-1.jsonl'),
      // The child's own call, plus a replay of the parent's request (a resumed transcript copies
      // its parent's messages) which must not be billed a second time.
      usageRecord('child-request', 20, 3) + usageRecord('parent-request', 100, 5),
    )
    const spend = tokensSince(SINCE, [home])
    expect(spend.raw).toBe(105 + 23)
    expect(spend.turns).toBe(2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the walk is bounded: a transcript buried past the depth cap is not visited', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-nested-usage-'))
  try {
    let deep = join(home, 'projects')
    for (let i = 0; i < 9; i++) deep = join(deep, `level-${i}`)
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'too-deep.jsonl'), usageRecord('deep-request', 1, 1))
    expect(tokensSince(SINCE, [home]).raw).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
