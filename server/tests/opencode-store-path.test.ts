// server/tests/opencode-store-path.test.ts — audit AH-34: an OpenCode-compatible product's
// sessions are read from THAT product's database, not from the default OpenCode one.
//
// Kilo, MiMo Code and IcodeMate are `format: 'opencode'` stores with their own databases.
// Discovery gave each row its database path and every later read path dropped it, so a session
// that appeared in the list opened as "transcript not found", exported empty, scanned as empty
// and reported zero analytics (reproduced 2026-09-05 with exactly this fixture). Every read now
// forwards the row's own path.
//
// The fixture is a synthetic Kilo database in a scratch dir, pointed at through KILO_DIR (the
// catalog reads that variable at call time). The index is rebuilt with force so this process's
// cached index cannot predate the variable - that rebuild walks this machine's real stores too,
// which is why the first test carries a long timeout. Nothing real is read: the id is invented.
import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessionAnalytics } from '../src/analytics'
import { exportSession } from '../src/session-export'
import { scanMeta } from '../src/sessions'
import { listTranscriptFiles, tailTranscript } from '../src/transcript'

const SID = `ses_kilo_${crypto.randomUUID().slice(0, 8)}`
const root = mkdtempSync(join(tmpdir(), 'ah-kilo-store-'))
const kiloRoot = join(root, 'kilo')
mkdirSync(kiloRoot, { recursive: true })
const kiloDb = join(kiloRoot, 'kilo.db')
{
  const db = new Database(kiloDb)
  db.exec(`
    create table session (id text primary key, project_id text, directory text, title text,
      time_created integer, time_updated integer, time_archived integer, model text,
      tokens_input integer, tokens_output integer, tokens_reasoning integer,
      tokens_cache_read integer, tokens_cache_write integer, cost real);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
  `)
  db.query('insert into session values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    SID,
    'audit',
    'D:\\audit',
    'Kilo row',
    1,
    2,
    null,
    'kilo-model',
    120,
    30,
    0,
    0,
    0,
    0.5,
  )
  db.query('insert into message values (?, ?, ?, ?)').run(
    'm1',
    SID,
    2,
    JSON.stringify({ role: 'user', modelID: 'kilo-model' }),
  )
  db.query('insert into part values (?, ?, ?, ?, ?)').run(
    'p1',
    'm1',
    SID,
    2,
    JSON.stringify({ type: 'text', text: 'from Kilo' }),
  )
  db.close()
}
const previousKiloDir = process.env.KILO_DIR
process.env.KILO_DIR = kiloRoot

afterAll(() => {
  if (previousKiloDir === undefined) delete process.env.KILO_DIR
  else process.env.KILO_DIR = previousKiloDir
  // Purge the Kilo row from this process's index so no later file in the worker sees it. A forced
  // rebuild walks the machine's real stores (seconds), hence the widened hook timeout below.
  listTranscriptFiles(true)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // The reader keeps the database handle open for the process's lifetime (Windows then refuses
    // the delete); the suite's scratch sweep (tests/setup.ts) removes it on the next run.
  }
}, 60_000)

test('the index carries the Kilo row with its own database path', () => {
  const row = listTranscriptFiles(true).find((x) => x.session_id === SID)
  expect(row).toBeDefined()
  expect(row?.tool).toBe('kilo')
  expect(row?.source).toBe('opencode')
  expect(row?.path).toBe(kiloDb)
}, 60_000) // a forced rebuild walks every store on the machine, not just the fixture

test('tail reads the text from the Kilo database, not "transcript not found"', async () => {
  const tail = await tailTranscript(SID, {}, 'opencode')
  expect(tail.error).toBeUndefined()
  expect(tail.events.map((e) => e.text)).toContain('from Kilo')
})

test('list metadata is scanned from the Kilo database', async () => {
  const row = listTranscriptFiles().find((x) => x.session_id === SID)
  expect(row).toBeDefined()
  const meta = await scanMeta(row!)
  expect(meta?.last_text_preview).toBe('from Kilo')
  expect(meta?.message_count).toBeGreaterThan(0)
})

test('export renders the Kilo session, not an empty document', async () => {
  const doc = await exportSession(SID, 'markdown', 'opencode')
  expect(doc).not.toBeNull()
  expect(doc?.body).toContain('from Kilo')
})

test('analytics totals come from the Kilo row', async () => {
  const analytics = await scanSessionAnalytics(kiloDb, 'opencode', SID)
  expect(analytics.providerCostUsd).toBe(0.5)
  const models = Object.values(analytics.tokens)
  expect(models.length).toBeGreaterThan(0)
  const input = models.reduce((n, m) => n + (m.input ?? 0), 0)
  expect(input).toBe(120)
})
