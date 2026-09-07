import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { chatDossier, listChats } from '../chat-dossier'
import { CLIPBOARD_DIR } from '../config'
import { resolveInstance } from '../core/instance-ref'
import { db, getSetting } from '../db'
import { contentDispositionAttachment, safeTranscriptFilename } from '../filenames'
import { app } from '../http-app'
import { findDesktopChat } from '../instance-sessions'
import { readLiveRegistry } from '../live-registry'
import { boundedQueryInt, jsonBody } from '../route-helpers'
import { dropSearchIndex, searchIndexStatus } from '../search-index'
import {
  type ExportFormat,
  exportSession,
  isExportRefused,
  scanSessionSecrets,
} from '../session-export'
import { makeLocator } from '../session-locator'
import { resumeSessionInTerminal } from '../session-resume'
import { searchSessionBodies } from '../session-search'
import { sessionUsage } from '../session-usage'
import { getSession, listProjects, listSessions, sessionMarkKey } from '../sessions'
import { findTranscriptAsync, tailTranscript } from '../transcript'
import { buildTranscriptOpenArgv } from '../transcript-open'
import {
  type ArchivedScope,
  isDispatchedScope,
  isRateLimitScope,
  isSessionPeriod,
  isSessionSource,
  periodCutoffMs,
  type SessionPeriod,
  type SessionSource,
} from '../types'
import { uiRenameChat } from '../ui-archive'

/**
 * A point in time from a query string: epoch milliseconds, or anything Date can parse (ISO-8601).
 *
 * Both forms, because the two callers want different ones — a UI computes a number, and a person
 * or an agent writing a URL by hand writes "2026-08-01". Anything unparseable returns null, which
 * every caller reads as "no bound", so a typo widens the answer rather than silently emptying it.
 */
function queryEpoch(raw: string | undefined): number | null {
  if (!raw) return null
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && raw.trim() !== '') return asNumber
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

/** Session, transcript and chat-management routes: listing, search, export, tail, secrets scan,
 *  file/clipboard delivery, and the desktop chat rename + dossier lookups. See index.ts for the
 *  app-wide middleware these routes run behind. */

// The columns `fields=compact` keeps: which session, what it is called, where it ran, when it
// last moved, and whether it is archived. Everything a caller needs to CHOOSE a session; nothing
// it needs only after choosing one.
//
// ⛔ WHY A PROJECTION EXISTS AT ALL (2026-09-06): a full row is 27 fields and ~2KB, of which
// transcript_path, last_text_preview, queue_status and limit_stop are most of the weight. One
// 206-session account came to 117,432 characters and was refused by an agent's token cap before
// a single row was read — a list nobody can receive answers nothing, and lowering `limit` to fit
// silently hides sessions instead. Opt-in, so the web UI's full rows are untouched.
const COMPACT_SESSION_FIELDS = [
  'session_id',
  'source',
  'title',
  'cwd',
  'instance',
  'archived',
  'last_activity_at',
  'message_count',
] as const

/** Narrow each row to the requested columns, or return them untouched when none were asked for.
 *  An unknown column name is a 400 rather than a silently missing field: a caller that asked for
 *  `titel` and got rows without it would read that as "these sessions have no title". */
function projectSessionRows(
  rows: unknown,
  spec: string | undefined,
): { rows: unknown } | { error: string } {
  if (!spec?.trim() || !Array.isArray(rows)) return { rows }
  const asked =
    spec.trim() === 'compact'
      ? [...COMPACT_SESSION_FIELDS]
      : spec
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
  const first = rows[0]
  if (first && typeof first === 'object') {
    const known = new Set(Object.keys(first as Record<string, unknown>))
    const unknown = asked.filter((k) => !known.has(k))
    if (unknown.length)
      return {
        error: `unknown field(s): ${unknown.join(', ')}. Valid: ${[...known].sort().join(', ')}`,
      }
  }
  // session_id always survives, whatever was asked for: a row nobody can address again is not a
  // cheaper row, it is a useless one.
  const keep = new Set<string>(['session_id', ...asked])
  return {
    rows: rows.map((r) =>
      r && typeof r === 'object'
        ? Object.fromEntries(
            Object.entries(r as Record<string, unknown>).filter(([k]) => keep.has(k)),
          )
        : r,
    ),
  }
}
// --- sessions -----------------------------------------------------------------
app.get('/api/sessions', async (c) => {
  const limit = c.req.query('limit')
  const instance = c.req.query('instance')
  // Anything unrecognized falls back to 'hide': a typo'd scope should show the live list, never
  // silently bury it under the archived majority.
  const archived = c.req.query('archived')
  const scope: ArchivedScope = archived === 'include' || archived === 'only' ? archived : 'hide'
  // Same defensive read as the scope above: an unrecognized period falls back to the default
  // window rather than quietly widening the list to everything on disk.
  const rawPeriod = c.req.query('period')
  const period: SessionPeriod = isSessionPeriod(rawPeriod) ? rawPeriod : '24h'
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : 'all'
  // Unrecognized narrows to nothing, so this one falls back to 'all' as well: never let a bad
  // parameter hide sessions.
  const rawDispatched = c.req.query('dispatched')
  const dispatched = isDispatchedScope(rawDispatched) ? rawDispatched : 'all'
  // Same defensive read once more: an unrecognized value must never narrow the list.
  const rawRateLimited = c.req.query('ratelimited')
  const rateLimited = isRateLimitScope(rawRateLimited) ? rawRateLimited : 'all'
  // An explicit `since` OUTRANKS `period`, and `until` has no period equivalent at all. The canned
  // windows exist because the UI wants three buttons; a caller reconstructing a past week (an MCP
  // client asked to summarise last month, say) needs real bounds, and telling it to fetch 'all' and
  // filter client-side is how a 1,200-session store gets streamed to answer a 20-row question.
  const since = queryEpoch(c.req.query('since'))
  const until = queryEpoch(c.req.query('until'))
  const rows = await listSessions({
    limit: boundedQueryInt(limit, 200, 500),
    offset: boundedQueryInt(c.req.query('offset'), 0, 100_000, 0),
    instance: instance || undefined,
    archived: scope,
    sinceMs: since ?? periodCutoffMs(period),
    untilMs: until,
    source,
    dispatched,
    rateLimited,
    project: c.req.query('project') || undefined,
  })
  // ⛔ PROJECTED AFTER listSessions, never inside it. listSessions owns the paging contract -
  // offset is paid in REAL rows so page 2 starts where page 1 stopped - and narrowing columns
  // before that slice would change nothing about which rows are returned but would put the
  // projection on the wrong side of the one invariant this list has.
  const projected = projectSessionRows(rows, c.req.query('fields'))
  if ('error' in projected) return c.json({ error: projected.error }, 400)
  return c.json(projected.rows)
})
// Every folder that has conversations in it, from the index alone (no transcript reads). This is
// how a client that was told "search all my chat histories" finds out what "all" is: the session
// list only ever answers newest-N, so without this there is no way to learn that a project exists
// before asking about it. MUST STAY ABOVE `/api/sessions/:id` for the reason spelled out below.
app.get('/api/sessions/projects', async (c) => c.json(await listProjects()))
// Advanced BODY search (streams every transcript file, substring or regex); deliberately a
// separate, slower, opt-in path so the fast metadata list above (GET /api/sessions, used by the
// default client-side filter) is never touched by this. See server/src/session-search.ts.
//
// MUST STAY ABOVE `/api/sessions/:id`. Both are two-segment routes, and the param one wins when it
// is registered first — which is how this endpoint spent its whole life answering
// `{"error":"session not found"}` to every content search, in the SPA and over MCP alike. Adding a
// route below this line that could be read as a session id will break it again.
app.get('/api/sessions/search', async (c) => {
  const query = c.req.query('q') ?? ''
  const regex = c.req.query('regex') === '1'
  const caseSensitive = c.req.query('case') === '1'
  const instance = c.req.query('instance') || undefined
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const limit = boundedQueryInt(c.req.query('limit'), 50, 200)
  // `everything=1` forces the exhaustive scan: every byte of every transcript, tool output
  // included. The index answers faster and completely, but only over what was SAID, so the way
  // past its two limits is an explicit parameter rather than a hidden heuristic.
  const mode = c.req.query('everything') === '1' ? 'scan' : 'auto'
  try {
    // A blank query returns the same SHAPE as a real search rather than an empty array — a caller
    // that has to special-case "did I get results or a response object?" will get it wrong.
    return c.json(
      await searchSessionBodies({ query, regex, caseSensitive, instance, source, limit, mode }),
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})
// ONE query, everything the system knows about a chat: metadata + archive flag as it sits on
// disk right now, lineage ids across auto-compact rolls, done-mark, and the live process
// hosting it (if any). Built 2026-08-28 because answering "what happened to chat X" used to
// take an hour of hand-joins across the stores that each hold a quarter of the answer.
// Query by title fragment or ANY id.
// --- rename a chat through the app's own control ---------------------------------------------
// The one write the daemon cannot make on disk: a RUNNING app holds its chat list in memory and
// re-saves over any file edit. It exists because an IMPORTED chat renders as 'Untitled' whatever
// its disk title says, and an untitled chat is both a naming-law violation and undeliverable -
// the courier aims by rendered name, so it reports those rows as no-title and stops. This is a
// DIRECT request only (never on the machinery's own initiative), so a hold does not gate it.
app.post('/api/chats/:id/rename', async (c) => {
  const body = await jsonBody(c)
  const newTitle = typeof body.new_title === 'string' ? body.new_title.trim() : ''
  if (!newTitle) return c.json({ ok: false, detail: 'new_title is required' }, 400)
  const chat = findDesktopChat(c.req.param('id'))
  if (!chat?.instance)
    return c.json({ ok: false, detail: 'no desktop instance holds this chat' }, 404)
  // The app matches rows by what it RENDERS, which is not always the disk title (that mismatch
  // is the whole reason this route exists), so the caller may name the on-screen row itself.
  const from =
    typeof body.current_title === 'string' && body.current_title.trim()
      ? body.current_title.trim()
      : chat.title
  if (!from)
    return c.json(
      { ok: false, detail: "this chat's current on-screen name is unknown - pass current_title" },
      400,
    )
  return c.json(await uiRenameChat(chat.instance, from, newTitle))
})

app.get('/api/chats/dossier', (c) => {
  const q = c.req.query('q') ?? ''
  if (!q.trim())
    return c.json({ error: 'q required: a title fragment or any session/chat id' }, 400)
  return c.json(chatDossier(q.trim()))
})
// One desktop instance's chats, compactly — the read that did not exist until 2026-09-06, when
// answering "what does this account hold" cost five round trips and produced a wrong number.
// See listChats in chat-dossier.ts for why it lives beside the dossier rather than in sessions.ts.
app.get('/api/chats', async (c) => {
  const raw = (c.req.query('instance') ?? '').trim()
  let instances: string[] | undefined
  if (raw) {
    // Any spelling move_chat accepts — number, email, account name, ref, or the directory label
    // itself. A label that the registry does not know is passed through rather than rejected:
    // the result carries every label the scan saw, so a typo shows up as an empty list beside
    // the real names instead of as a 404 with no clue in it.
    const hit = await resolveInstance(raw)
    if (hit && hit.kind !== 'desktop')
      return c.json(
        {
          error: `instance ${raw} is a ${hit.kind} instance; desktop chats live only on desktop instances`,
        },
        400,
      )
    instances = [hit ? basename(hit.handle.replace(/[\\/]+$/, '')) : raw]
  }
  const archived = c.req.query('archived')
  const got = listChats({
    instances,
    // Same defensive read as /api/sessions: an unrecognized scope shows the live list rather
    // than silently burying it under the archived majority.
    archived: archived === 'include' || archived === 'only' ? archived : 'hide',
    q: c.req.query('q') || undefined,
    limit: boundedQueryInt(c.req.query('limit'), 200, 1000),
    offset: boundedQueryInt(c.req.query('offset'), 0, 100_000, 0),
  })
  // ⛔ AN INSTANCE THAT DOES NOT EXIST MUST NOT LOOK LIKE AN INSTANCE WITH NO CHATS. Both are
  // `{rows: [], counts: {all: 0}}`, and the second is a real and reassuring answer, so a typo or
  // an ambiguous email would read as "that account is empty" - the exact class of silently-wrong
  // answer this whole endpoint exists to stop. Only fires when the scan saw NOTHING under the
  // label, so a real but genuinely empty account still answers 200.
  if (instances && !got.instances.includes(instances[0] as string))
    return c.json(
      {
        error: `no desktop instance matched "${raw}". Known chat-store labels: ${got.instances.join(', ')}`,
        instances: got.instances,
      },
      404,
    )
  return c.json(got)
})
// How many sessions hold a LIVE engine process right now — ONE cheap authoritative read of
// the same pid-checked registry the dossier's `live` field answers from, so the two can
// never disagree. Built 2026-08-31 for the orchestrator's machine-wide concurrency cap
// ("18 chats running at one time"); its fallback was one dossier walk per visible chat.
app.get('/api/sessions/live', (c) => {
  const sessions = readLiveRegistry(join(homedir(), '.claude'))
  const seen = new Set<string>()
  const rows = sessions.filter((s) =>
    seen.has(s.sessionId) ? false : (seen.add(s.sessionId), true),
  )
  return c.json({ count: rows.length, sessions: rows })
})
app.get('/api/sessions/:id', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  // `?locator=` (audit AH-35), alongside the older `?source=`: two products sharing a format
  // (Kilo/MiMo Code, both `opencode`; two Hermes profiles) can hold the same session id, and only a
  // locator names the exact row rather than "the newest match for that id+source". Ignored when it
  // doesn't parse or resolves to nothing in the current index — see pickSession in transcript.ts.
  const locator = c.req.query('locator') || undefined
  const s = await getSession(c.req.param('id'), source, locator)
  return s ? c.json(s) : c.json({ error: 'session not found' }, 404)
})
// The user's own mark (distinct from Claude Desktop's read-only isArchived, surfaced via
// include_archived above). Mark only: never used to filter listSessions.
app.post('/api/sessions/:id/done', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source: SessionSource = isSessionSource(rawSource) ? rawSource : 'claude'
  const locator = c.req.query('locator') || undefined
  const body = await jsonBody(c)
  const done = body.done === true
  // Resolved so the mark keys on the SAME product+store a locator (or source+id) actually named:
  // two products sharing a format, or two stores of the same product (two Hermes profiles, two
  // OpenCode-format databases), can hold the same session id, and marking "done" by source+id alone
  // would toggle whichever one that id happened to resolve to. A row this app has never indexed
  // (already deleted, or a locator from elsewhere) still gets marked, under the plain source+id key
  // — exactly the pre-locator behavior — because sessionMarkKey's `tf` is optional.
  const tf = await findTranscriptAsync(id, source, locator)
  db.query(
    'insert into session_marks (session_id, done, updated_at) values (?, ?, ?) ' +
      'on conflict(session_id) do update set done = ?, updated_at = ?',
  ).run(
    sessionMarkKey(source, id, tf ?? undefined),
    done ? 1 : 0,
    Date.now(),
    done ? 1 : 0,
    Date.now(),
  )
  return c.json({ session_id: id, source, done })
})
// Download a copy of the raw transcript (browser save-as; works over remote too). The filename is
// the session TITLE, not the raw id — the same safeTranscriptFilename the SPA's <a download> uses,
// so the two agree in every deployment shape (the browser honors the <a> name only same-origin and
// this header only cross-origin). getSession re-derives the title (cheap: scanMeta is mtime-cached
// and the sessions list nearly always warmed it first); fall back to the id if the lookup misses.
app.get('/api/sessions/:id/file', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const tf = await findTranscriptAsync(id, source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode' || tf.source === 'hermes')
    return c.json(
      { error: 'OpenCode and Hermes sessions are stored in a shared database, not a raw file' },
      409,
    )
  // tf's own locator, not the raw query param: this pins the title lookup to the EXACT row just
  // resolved (source+id alone could resolve to a different product's session — audit AH-35).
  const session = await getSession(id, tf.source, makeLocator(tf))
  const filename = safeTranscriptFilename(session?.title, tf.session_id)
  return new Response(Bun.file(tf.path), {
    headers: {
      'content-type': 'application/jsonl; charset=utf-8',
      'content-disposition': contentDispositionAttachment(filename),
    },
  })
})
// A readable export: Markdown, or one self-contained HTML file. Reads the WHOLE transcript, not the
// tail window the viewer shows, because a silently truncated document is worse than none. Secrets
// in recognisable formats are replaced on the way out and the document says so — this path exists
// to produce something you send somewhere. See server/src/session-export.ts.
app.get('/api/sessions/:id/export', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const format: ExportFormat = c.req.query('format') === 'html' ? 'html' : 'markdown'
  const thinking = c.req.query('thinking') === '1' || c.req.query('thinking') === 'true'
  const id = c.req.param('id')
  // Resolved ONCE and re-expressed as its own locator for both calls below, so the title lookup and
  // the render cannot land on two different products' sessions sharing this id (audit AH-35) — a
  // real risk here specifically, since the two calls used to repeat the source+id resolution
  // independently.
  const tf = await findTranscriptAsync(id, source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  const pinned = makeLocator(tf)
  // The transcript index carries no title for a Claude session, so without this the document is
  // headed with a uuid and the file is named after one twice. getSession derives the real title the
  // list shows (cheap: scanMeta is mtime-cached), exactly as the raw-file download does.
  const session = await getSession(id, tf.source, pinned)
  const result = await exportSession(id, format, tf.source, {
    thinking,
    title: session?.title,
    cwd: session?.cwd,
    locator: pinned,
  })
  if (!result) return c.json({ error: 'session not found' }, 404)
  // Over the export ceiling (audit AH-37): a 413 that says why and what to do instead, rather than
  // a daemon quietly holding a few hundred megabytes and hoping.
  if (isExportRefused(result))
    return c.json(
      { error: result.message, sizeBytes: result.sizeBytes, limitBytes: result.limitBytes },
      413,
    )
  return new Response(result.body, {
    headers: {
      'content-type': result.contentType,
      'content-disposition': contentDispositionAttachment(result.filename),
      // What the export left out, for a caller that wants to say so without parsing the document.
      'x-agenthydra-redacted': String(result.redacted),
    },
  })
})
// Reopen a finished session in a real terminal (`claude --resume <id>`), and hand back the command
// line either way so "copy the command" works even where no terminal could be opened. See
// server/src/session-resume.ts.
app.post('/api/sessions/:id/resume-terminal', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const tf = await findTranscriptAsync(id, source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  const session = await getSession(id, tf.source, makeLocator(tf))
  return c.json(resumeSessionInTerminal(id, tf.source, session?.cwd || null))
})
// What secrets this session printed, as a count and a redacted list. There is deliberately no
// reveal parameter: the transcript is already open in the viewer on this machine, so this endpoint
// can only add a way to lose credentials, never a way to see something otherwise unreachable.
app.get('/api/sessions/:id/secrets', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const scan = await scanSessionSecrets(c.req.param('id'), source, locator)
  if (!scan) return c.json({ error: 'session not found' }, 404)
  return c.json(scan)
})
// Return the original transcript's absolute location so the SPA can copy it as plain text.
// Resolve it here rather than reconstructing it in the browser: project-folder encoding is lossy,
// and findTranscript also handles the rare case where the same session id exists in two folders.
app.get('/api/sessions/:id/file-location', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const tf = await findTranscriptAsync(c.req.param('id'), source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode' || tf.source === 'hermes')
    return c.json({ error: 'OpenCode and Hermes sessions are stored in a shared database' }, 409)
  return c.json({ path: tf.path })
})
// Open the transcript in an editor (loopback daemon: same posture as the portable-window spawn;
// the file opens on the machine the daemon runs on). .jsonl has no OS file association, so handing
// this to the bare default handler would pop Windows' "Pick an app" dialog instead of opening -
// buildTranscriptOpenArgv names an editor explicitly so that never happens (transcript-open.ts).
app.post('/api/sessions/:id/open-file', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const tf = await findTranscriptAsync(c.req.param('id'), source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode' || tf.source === 'hermes')
    return c.json({ error: 'OpenCode and Hermes sessions are stored in a shared database' }, 409)
  const cmd = buildTranscriptOpenArgv(
    process.platform,
    tf.path,
    getSetting('transcript_editor'),
    process.env,
    existsSync,
  )
  try {
    Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }).unref()
    return c.json({ ok: true })
  } catch {
    return c.json({ ok: false }, 500)
  }
})
/**
 * Copy the transcript FILE ITSELF to the OS clipboard — so Ctrl+V in Explorer, Slack or a mail
 * client pastes the .jsonl, not its text.
 *
 * This has to be the daemon's job: a web page cannot do it at all. `navigator.clipboard.write()`
 * only accepts blobs the page itself constructs (text/html/png and friends); no ClipboardItem type
 * maps to a native file-drop (Windows CF_HDROP / macOS NSFilenamesPasteboardType), because letting
 * a page assert "there is a file at this path on your disk" is a filesystem-disclosure primitive.
 * The daemon is already local and already shells out for the sibling open-file route, so it can.
 *
 * The path reaches PowerShell through the ENVIRONMENT, never string-interpolated into -Command: a
 * session title can legally contain a quote or a `$`, and building a script out of one would be
 * both fragile and an injection seam.
 */
app.post('/api/sessions/:id/copy-file', async (c) => {
  const id = c.req.param('id')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const tf = await findTranscriptAsync(id, source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  if (tf.source === 'opencode' || tf.source === 'hermes')
    return c.json({ error: 'OpenCode and Hermes sessions are stored in a shared database' }, 409)
  if (process.platform !== 'win32' && process.platform !== 'darwin')
    // Linux has no cross-desktop file-clipboard convention (GNOME and KDE disagree on the private
    // MIME type), so there is nothing honest to spawn. Say so rather than silently no-op.
    return c.json({ ok: false, reason: 'unsupported' }, 501)

  const session = await getSession(id, tf.source, makeLocator(tf))
  const staged = join(CLIPBOARD_DIR, safeTranscriptFilename(session?.title, tf.session_id))
  try {
    rmSync(CLIPBOARD_DIR, { recursive: true, force: true })
    mkdirSync(CLIPBOARD_DIR, { recursive: true })
    await Bun.write(staged, Bun.file(tf.path))
  } catch {
    return c.json({ ok: false, reason: 'stage-failed' }, 500)
  }

  const cmd =
    process.platform === 'win32'
      ? [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // -LiteralPath: a title may contain [ ] which -Path would read as a wildcard.
          'Set-Clipboard -LiteralPath $env:AGENTHYDRA_CLIP_PATH',
        ]
      : [
          'osascript',
          '-e',
          'set the clipboard to (POSIX file (system attribute "AGENTHYDRA_CLIP_PATH"))',
        ]
  try {
    // windowsHide: true on every console-program spawn in this file, not just this one. The daemon
    // only inherits a window-less console today because Tray-Host.ps1 happens to launch it with
    // CreateNoWindow=true. Started any other way (a terminal, Explorer, the compiled portable exe),
    // that inheritance is gone and a plain click on this button would flash a real console window.
    // Stating the intent at the spawn call makes that impossible regardless of how the daemon started.
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, AGENTHYDRA_CLIP_PATH: staged },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    // Awaited, unlike open-file's fire-and-forget: the button reports whether the copy landed, and
    // "it's on your clipboard" is a claim we should only make once the exit code says so.
    const code = await proc.exited
    return code === 0
      ? c.json({ ok: true, filename: basename(staged) })
      : c.json({ ok: false }, 500)
  } catch {
    return c.json({ ok: false }, 500)
  }
})
app.get('/api/sessions/:id/tail', async (c) => {
  const limit = c.req.query('limit')
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const flag = (name: string) => {
    const v = c.req.query(name)
    return v === '1' || v === 'true'
  }
  return c.json(
    await tailTranscript(
      c.req.param('id'),
      {
        limit: boundedQueryInt(limit, 40, 200),
        textOnly: flag('textOnly'),
        thinking: flag('thinking'),
        humanOnly: flag('humanOnly'),
      },
      source,
      locator,
    ),
  )
})
// What this one session spent: token totals and a dollar cost at published list prices, computed
// on demand from the transcript itself (no table, nothing stored — see server/src/session-usage.ts).
// Answers 200 with a `status` rather than an error for a source that records no per-turn usage, so
// the UI can explain the gap instead of showing a zero it cannot justify.
app.get('/api/sessions/:id/usage', async (c) => {
  const rawSource = c.req.query('source')
  const source = isSessionSource(rawSource) ? rawSource : undefined
  const locator = c.req.query('locator') || undefined
  const tf = await findTranscriptAsync(c.req.param('id'), source, locator)
  if (!tf) return c.json({ error: 'session not found' }, 404)
  return c.json(await sessionUsage(tf))
})
// The conversation index behind the fast search path. It holds no text of its own and rebuilds
// itself from the transcripts, so deleting it costs nothing but the time to build it again — which
// is exactly why the delete is offered rather than buried.
app.get('/api/search-index', (c) => c.json(searchIndexStatus()))
app.delete('/api/search-index', (c) => c.json({ ok: dropSearchIndex(), ...searchIndexStatus() }))
