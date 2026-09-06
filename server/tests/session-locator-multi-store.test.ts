// server/tests/session-locator-multi-store.test.ts — audit AH-35: `TranscriptFile.tool` is the
// product identity and `source` is only the parsing FORMAT (server/src/transcript.ts ~74-81), yet
// the index used to de-duplicate by `${source}:${session_id}` alone, lookups filtered by
// source+id alone, and every route accepted only `?source=`. Two OpenCode-format products (Kilo and
// MiMo Code) holding the SAME session id collapsed to ONE row — this file reproduces exactly that
// with a synthetic Kilo + MiMo Code pair sharing one id, and locks in the fix: both rows survive the
// index, each is addressable by its own locator (server/src/session-locator.ts), and a route called
// with `?locator=` resolves the row it names rather than "the newest match for source+id".
//
// Same fixture SHAPE as opencode-store-path.test.ts (AH-34): a scratch SQLite database per store,
// pointed at through the catalog's own env var (KILO_DIR / MIMOCODE_DIR), with the index force-
// rebuilt so this process's cache cannot predate the variables. Nothing real is read.
import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from '../src/http-app'
import '../src/routes/sessions'
import { dedupeKey, makeLocator, matchesLocator, parseLocator } from '../src/session-locator'
import { findTranscriptAsync, listTranscriptFiles, tailTranscript } from '../src/transcript'

const SID = `ses_shared_${crypto.randomUUID().slice(0, 8)}`
const root = mkdtempSync(join(tmpdir(), 'ah-multi-store-'))

function makeOpenCodeDb(dir: string, dbFile: string, text: string) {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, dbFile)
  const db = new Database(dbPath)
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
    'Shared-id row',
    1,
    2,
    null,
    'x-model',
    10,
    5,
    0,
    0,
    0,
    0.1,
  )
  db.query('insert into message values (?, ?, ?, ?)').run(
    `m-${dbFile}`,
    SID,
    2,
    JSON.stringify({ role: 'user', modelID: 'x-model' }),
  )
  db.query('insert into part values (?, ?, ?, ?, ?)').run(
    `p-${dbFile}`,
    `m-${dbFile}`,
    SID,
    2,
    JSON.stringify({ type: 'text', text }),
  )
  db.close()
  return dbPath
}

const kiloRoot = join(root, 'kilo')
const mimoRoot = join(root, 'mimocode')
const kiloDb = makeOpenCodeDb(kiloRoot, 'kilo.db', 'from Kilo')
const mimoDb = makeOpenCodeDb(mimoRoot, 'mimocode.db', 'from MiMo Code')

const previousKiloDir = process.env.KILO_DIR
const previousMimoDir = process.env.MIMOCODE_DIR
process.env.KILO_DIR = kiloRoot
process.env.MIMOCODE_DIR = mimoRoot

afterAll(() => {
  if (previousKiloDir === undefined) delete process.env.KILO_DIR
  else process.env.KILO_DIR = previousKiloDir
  if (previousMimoDir === undefined) delete process.env.MIMOCODE_DIR
  else process.env.MIMOCODE_DIR = previousMimoDir
  listTranscriptFiles(true)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // The reader keeps the database handle open for the process's lifetime (Windows then refuses
    // the delete); the suite's scratch sweep (tests/setup.ts) removes it on the next run.
  }
}, 60_000)

test('both products survive the index under one shared session id', () => {
  const rows = listTranscriptFiles(true).filter((f) => f.session_id === SID)
  expect(rows).toHaveLength(2)
  const byTool = new Map(rows.map((r) => [r.tool, r]))
  expect(byTool.get('kilo')?.path).toBe(kiloDb)
  expect(byTool.get('mimocode')?.path).toBe(mimoDb)
  // Distinct, well-formed locators — the whole point: source+id alone cannot tell these two apart.
  const kiloLoc = byTool.get('kilo')?.locator
  const mimoLoc = byTool.get('mimocode')?.locator
  expect(kiloLoc).toBeTruthy()
  expect(mimoLoc).toBeTruthy()
  expect(kiloLoc).not.toBe(mimoLoc)
}, 60_000)

test('each row is addressable by its own locator', async () => {
  const rows = listTranscriptFiles().filter((f) => f.session_id === SID)
  const kilo = rows.find((r) => r.tool === 'kilo')!
  const mimo = rows.find((r) => r.tool === 'mimocode')!

  const foundKilo = await findTranscriptAsync(SID, 'opencode', kilo.locator)
  expect(foundKilo?.path).toBe(kiloDb)
  const foundMimo = await findTranscriptAsync(SID, 'opencode', mimo.locator)
  expect(foundMimo?.path).toBe(mimoDb)

  // A bare source, with no locator, still resolves — the older calling convention keeps working —
  // but is not asserted to pick one product over the other, since "the newest match" is exactly the
  // ambiguity a locator exists to remove.
  const bySourceOnly = await findTranscriptAsync(SID, 'opencode')
  expect(bySourceOnly).not.toBeNull()
})

test("tail returns each store's own text, not the other product's", async () => {
  const rows = listTranscriptFiles().filter((f) => f.session_id === SID)
  const kilo = rows.find((r) => r.tool === 'kilo')!
  const mimo = rows.find((r) => r.tool === 'mimocode')!

  const kiloTail = await tailTranscript(SID, {}, 'opencode', kilo.locator)
  expect(kiloTail.events.map((e) => e.text)).toContain('from Kilo')
  expect(kiloTail.events.map((e) => e.text)).not.toContain('from MiMo Code')

  const mimoTail = await tailTranscript(SID, {}, 'opencode', mimo.locator)
  expect(mimoTail.events.map((e) => e.text)).toContain('from MiMo Code')
  expect(mimoTail.events.map((e) => e.text)).not.toContain('from Kilo')
})

test('GET /api/sessions/:id?locator= resolves the exact row named, not the other product', async () => {
  const rows = listTranscriptFiles().filter((f) => f.session_id === SID)
  const kilo = rows.find((r) => r.tool === 'kilo')!
  const mimo = rows.find((r) => r.tool === 'mimocode')!

  const kiloRes = await app.request(
    `/api/sessions/${SID}?source=opencode&locator=${encodeURIComponent(kilo.locator!)}`,
  )
  expect(kiloRes.status).toBe(200)
  const kiloBody = (await kiloRes.json()) as { tool: string; locator: string }
  expect(kiloBody.tool).toBe('kilo')
  expect(kiloBody.locator).toBe(kilo.locator!)

  const mimoRes = await app.request(
    `/api/sessions/${SID}?source=opencode&locator=${encodeURIComponent(mimo.locator!)}`,
  )
  expect(mimoRes.status).toBe(200)
  const mimoBody = (await mimoRes.json()) as { tool: string; locator: string }
  expect(mimoBody.tool).toBe('mimocode')
})

test('locator round-trips through parse + matchesLocator', () => {
  const rows = listTranscriptFiles().filter((f) => f.session_id === SID)
  const kilo = rows.find((r) => r.tool === 'kilo')!
  const mimo = rows.find((r) => r.tool === 'mimocode')!

  const parsedKilo = parseLocator(kilo.locator)
  expect(parsedKilo).not.toBeNull()
  expect(parsedKilo?.tool).toBe('kilo')
  expect(matchesLocator(kilo, parsedKilo!)).toBe(true)
  // The SAME session id, a DIFFERENT store: must not match.
  expect(matchesLocator(mimo, parsedKilo!)).toBe(false)

  // Malformed / foreign / wrong-version input is a miss, never a throw.
  expect(parseLocator(undefined)).toBeNull()
  expect(parseLocator('')).toBeNull()
  expect(parseLocator('not-a-locator')).toBeNull()
  expect(parseLocator('v2:whatever')).toBeNull()
  expect(parseLocator('v1:not-valid-base64url-json!!!')).toBeNull()
})

test('the intentional same-store dedup still collapses: same product, different physical path, one row', () => {
  // Models a Codex rollout briefly visible in both the live and archived roots while a move settles
  // (finishIndex's own long-standing case) without needing real Codex fixtures: two records that
  // agree on source + tool but differ on path must still produce the SAME dedupe identity, because
  // storeKeyOf treats a file-backed format's tool as the whole store family.
  const a = { source: 'codex' as const, tool: 'codex', path: 'C:\\live\\r1.jsonl', session_id: 'x' }
  const b = {
    source: 'codex' as const,
    tool: 'codex',
    path: 'C:\\archived\\r1.jsonl',
    session_id: 'x',
  }
  expect(dedupeKey(a)).toBe(dedupeKey(b))
  expect(makeLocator(a)).toBe(makeLocator(b))

  // But two DIFFERENT products of one format sharing a session id must not collapse — the bug this
  // whole audit is about, restated as a pure unit check independent of any fixture database.
  const kiloLike = {
    source: 'opencode' as const,
    tool: 'kilo',
    path: 'C:\\kilo.db',
    session_id: 'x',
  }
  const mimoLike = {
    source: 'opencode' as const,
    tool: 'mimocode',
    path: 'C:\\mimocode.db',
    session_id: 'x',
  }
  expect(dedupeKey(kiloLike)).not.toBe(dedupeKey(mimoLike))
})
