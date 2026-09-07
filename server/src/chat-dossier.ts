// server/src/chat-dossier.ts — ONE query, everything the system knows about a chat.
//
// WHY THIS EXISTS (owner ask, 2026-08-28, verbatim: "so the next time this doesn't take a
// f***ing hour to do what should have taken 3 seconds and one query"): diagnosing "what
// happened to chat X" used to mean hand-walking the stores that each hold a piece of the
// answer — the desktop metadata files (title, archive flag, lineage ids), the marks table
// (done), and the live registry (is a process hosting it right now). This joins them by ANY
// id or title fragment and returns the whole story in one response.
//
// The scan is a FRESH read of every store on purpose — no 15-second cache. A dossier is a
// diagnostic: the caller is usually asking because the world just changed, and a cached
// archive flag is exactly the lie they came here to catch. ~1300 small files, well under a
// second; this endpoint is called by a human-paced investigation, not a hot path.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultClaudeUserDataDir, instancesRoot } from './core/paths'
import { db } from './db'
import { readLiveRegistry } from './live-registry'

/** One chat's full metadata row, read straight off disk (superset of SessionMeta: the cached
 *  scan drops lineage and timestamps, and lineage ids are the whole point here). */
export interface DossierChat {
  instance: string
  metaPath: string
  metaMtime: string | null
  chatId: string | null
  cliSessionId: string | null
  /** Continuations this chat rolled through (auto-compact keeps the chat, rolls the id).
   *  A mark can be filed under ANY of these and still be about this chat. */
  priorCliSessionIds: string[]
  title: string | null
  cwd: string | null
  createdAt: string | null
  lastActivityAt: string | null
  archived: boolean
  /** ⛔ THE SAME FLAG UNDER THE NAME THE STORE ITSELF USES, and it is not redundant.
   *  `archived` is this API's name for it; the metadata file on disk calls it `isArchived`.
   *  An agent that read the documented name straight off the store got every chat wrong -
   *  206 of them came back undefined, which reads as "not archived", when 205 were archived,
   *  and nothing errored (field mismatch found 2026-09-06). Emitting both means the name in
   *  the answer is also the name in the file, so a hand-check cannot silently invert. */
  isArchived: boolean
  permissionMode: string | null
}

export interface DossierMatch extends DossierChat {
  /** Every id this chat answers to — what the marks and live-registry joins run on. */
  lineageIds: string[]
  doneMark: { done: boolean; updatedAt: string } | null
  live: { pid: number; name: string; startedAt: string; cwd: string } | null
}

const iso = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null

function scanStoreFull(userDataDir: string, label: string, out: DossierChat[]): void {
  const dir = join(userDataDir, 'claude-code-sessions')
  if (!existsSync(dir)) return
  const glob = new Bun.Glob('*/*/local_*.json')
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    try {
      const path = join(dir, rel)
      const meta = JSON.parse(readFileSync(path, 'utf8'))
      const chatId = rel.slice(rel.lastIndexOf('local_'), -'.json'.length) || null
      out.push({
        instance: label,
        metaPath: path,
        metaMtime: ((): string | null => {
          try {
            return new Date(statSync(path).mtimeMs).toISOString()
          } catch {
            return null
          }
        })(),
        chatId,
        cliSessionId:
          typeof meta?.cliSessionId === 'string' && meta.cliSessionId ? meta.cliSessionId : null,
        priorCliSessionIds: Array.isArray(meta?.priorCliSessionIds)
          ? meta.priorCliSessionIds.filter((x: unknown) => typeof x === 'string')
          : [],
        title: typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : null,
        cwd: typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : null,
        createdAt: iso(meta?.createdAt),
        lastActivityAt: iso(meta?.lastActivityAt),
        archived: !!meta?.isArchived,
        isArchived: !!meta?.isArchived,
        permissionMode: typeof meta?.permissionMode === 'string' ? meta.permissionMode : null,
      })
    } catch {
      /* unreadable metadata file: skip it */
    }
  }
}

/** Every desktop chat on the machine, fresh from disk. Injectable roots for tests. */
export function collectChats(roots?: Array<{ dir: string; label: string }>): DossierChat[] {
  const out: DossierChat[] = []
  const targets =
    roots ??
    [{ dir: defaultClaudeUserDataDir(), label: 'default' }].concat(
      ((): Array<{ dir: string; label: string }> => {
        const root = instancesRoot()
        try {
          if (!existsSync(root)) return []
          return readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => ({ dir: join(root, e.name), label: e.name }))
        } catch {
          return []
        }
      })(),
    )
  for (const t of targets) scanStoreFull(t.dir, t.label, out)
  return out
}

export function lineageIdsOf(c: DossierChat): string[] {
  const ids = new Set<string>()
  if (c.cliSessionId) ids.add(c.cliSessionId)
  for (const p of c.priorCliSessionIds) ids.add(p)
  // The filename's own id: an imported chat is filed as local_<cliSessionId>, an app-created
  // chat under the app's id — either way the filename id is an address something may have used.
  if (c.chatId?.startsWith('local_')) ids.add(c.chatId.slice('local_'.length))
  return [...ids]
}

/** Case-insensitive: does this chat answer to the query, by title or any lineage id? */
export function chatMatches(c: DossierChat, q: string): boolean {
  const needle = q.toLowerCase()
  if (c.title?.toLowerCase().includes(needle)) return true
  if (c.chatId?.toLowerCase().includes(needle)) return true
  return lineageIdsOf(c).some((id) => id.toLowerCase().includes(needle))
}

export interface DossierDeps {
  roots?: Array<{ dir: string; label: string }>
  markFor?: (ids: string[]) => { done: boolean; updatedAt: string } | null
  liveFor?: (ids: string[]) => DossierMatch['live']
}

function defaultMarkFor(ids: string[]): { done: boolean; updatedAt: string } | null {
  for (const id of ids) {
    // sessionMarkKey stores the claude source bare and other sources prefixed; match both.
    const row = db
      .query<{ done: number; updated_at: number }, [string, string]>(
        'select done, updated_at from session_marks where session_id = ? or session_id like ?',
      )
      .get(id, `%:${id}`)
    if (row) return { done: !!row.done, updatedAt: iso(row.updated_at) ?? String(row.updated_at) }
  }
  return null
}

function defaultLiveFor(ids: string[]): DossierMatch['live'] {
  try {
    const live = readLiveRegistry(join(homedir(), '.claude'))
    const hit = live.find((s) => ids.includes(s.sessionId))
    if (!hit) return null
    return { pid: hit.pid, name: hit.name, startedAt: iso(hit.startedAt) ?? '', cwd: hit.cwd }
  } catch {
    return null
  }
}

/**
 * The one-query answer: every chat matching `q` (title fragment or any lineage id), each with
 * its archive flag as it sits ON DISK RIGHT NOW, its done-mark, and its live process if any.
 */
export function chatDossier(q: string, deps: DossierDeps = {}): { matches: DossierMatch[] } {
  const chats = collectChats(deps.roots)
  const markFor = deps.markFor ?? defaultMarkFor
  const liveFor = deps.liveFor ?? defaultLiveFor
  const matches: DossierMatch[] = []
  for (const c of chats) {
    if (!chatMatches(c, q)) continue
    const lineageIds = lineageIdsOf(c)
    matches.push({
      ...c,
      lineageIds,
      doneMark: markFor(lineageIds),
      live: liveFor(lineageIds),
    })
  }
  // Newest activity first — the chat being asked about is almost always the recent one.
  matches.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
  return { matches }
}

// --- listing -------------------------------------------------------------------------------
//
// WHY THIS LIVES BESIDE THE DOSSIER (2026-09-06): the dossier answers "tell me about THIS chat"
// and it was, until now, the only read of the desktop chat store that a caller could reach.
// "What chats does this account hold?" had no answer at all. list_sessions could be pointed at
// an instance, but it returns the full 27-field session row per chat — 117KB for a 206-chat
// account, refused by an agent's token cap before a single row was read — and the only cheap
// count available was move_chats(dry_run), a MUTATING tool used as a read. So a migration began
// by hand-globbing the private store, and hand-globbing is exactly how the isArchived/archived
// mismatch above produced a confidently wrong answer.
//
// It reuses collectChats/chatMatches rather than re-walking the store: one owner of that read.

/** One chat, in the smallest shape that still answers "should I move this one?". */
export interface ChatListRow {
  instance: string
  chatId: string | null
  sessionId: string | null
  title: string | null
  /** Both names, for the reason spelled out on DossierChat.isArchived. */
  archived: boolean
  isArchived: boolean
  lastActivityAt: string | null
  cwd: string | null
  /** An engine process is hosting this chat RIGHT NOW — the one thing that decides whether a
   *  move will be refused, and the reason a caller had to attempt the move to find out. */
  live: boolean
  livePid: number | null
}

export interface ChatListResult {
  rows: ChatListRow[]
  /** Chats matching the filter BEFORE limit/offset — so a capped page never reads as the whole set. */
  total: number
  /** The whole account, unfiltered by archive scope: the "how big is this thing" answer. */
  counts: { all: number; unarchived: number; archived: number; live: number }
  /** Every instance label the scan saw, so a mistyped `instance` is obvious rather than empty. */
  instances: string[]
}

export interface ListChatsOptions {
  /** Directory label(s) of the desktop instance(s) to list. Omit for every instance. */
  instances?: string[]
  /** 'hide' (default) drops archived chats, 'only' keeps just those, 'include' keeps both. */
  archived?: 'hide' | 'include' | 'only'
  /** Optional title / id fragment, matched exactly as the dossier matches. */
  q?: string
  limit?: number
  offset?: number
}

/** Session ids with a live engine, read ONCE. The dossier's per-chat liveFor re-reads the
 *  registry for every chat it returns, which is right for one chat and quadratic for 206. */
function liveIndex(): Map<string, number> {
  const out = new Map<string, number>()
  try {
    for (const s of readLiveRegistry(join(homedir(), '.claude'))) out.set(s.sessionId, s.pid)
  } catch {
    /* no registry: every chat reports live:false, which is what "unknown" already looked like */
  }
  return out
}

export function listChats(
  opts: ListChatsOptions = {},
  deps: DossierDeps & { liveIds?: Map<string, number> } = {},
): ChatListResult {
  const chats = collectChats(deps.roots)
  const live = deps.liveIds ?? liveIndex()
  const scope = opts.archived ?? 'hide'
  const wanted = opts.instances?.length ? new Set(opts.instances) : null
  const q = opts.q?.trim()

  const instances = [...new Set(chats.map((c) => c.instance))].sort()
  const scoped = wanted ? chats.filter((c) => wanted.has(c.instance)) : chats
  // The counts describe the SCOPED account in full — they are deliberately not narrowed by the
  // archive scope or by `q`, because "206 total, 1 unarchived" is the answer that stops a caller
  // reading "1 row" as "this account is empty".
  const counts = {
    all: scoped.length,
    unarchived: scoped.filter((c) => !c.isArchived).length,
    archived: scoped.filter((c) => c.isArchived).length,
    live: scoped.filter((c) => lineageIdsOf(c).some((id) => live.has(id))).length,
  }

  const matched = scoped
    .filter((c) => (scope === 'hide' ? !c.isArchived : scope === 'only' ? c.isArchived : true))
    .filter((c) => !q || chatMatches(c, q))
    // Newest first, with an UNDATED chat last rather than first. The dossier sorts on
    // (x ?? ''), which is right there - it returns the handful of chats matching one query -
    // and wrong for a list, where an empty string beats every real ISO timestamp and would
    // put the chats we know least about at the top of the page a caller reads first.
    .sort((a, b) => {
      const at = a.lastActivityAt
      const bt = b.lastActivityAt
      if (at === bt) return 0
      if (!at) return 1
      if (!bt) return -1
      return bt.localeCompare(at)
    })

  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
  const rows = matched.slice(offset, offset + limit).map((c): ChatListRow => {
    const pid = lineageIdsOf(c)
      .map((id) => live.get(id))
      .find((p) => p !== undefined)
    return {
      instance: c.instance,
      chatId: c.chatId,
      sessionId: c.cliSessionId,
      title: c.title,
      archived: c.archived,
      isArchived: c.isArchived,
      lastActivityAt: c.lastActivityAt,
      cwd: c.cwd,
      live: pid !== undefined,
      livePid: pid ?? null,
    }
  })

  return { rows, total: matched.length, counts, instances }
}
