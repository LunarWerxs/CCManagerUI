// server/src/session-export.ts — a session you can hand to a person.
//
// The only export before this was the raw `.jsonl`: correct, complete, and unreadable by anyone who
// is not writing a parser. This renders the same turns as Markdown, and as a single self-contained
// HTML file that opens in a browser with no assets beside it.
//
// IT READS THE WHOLE TRANSCRIPT, not the tail window the viewer shows. An export of "the last 40
// turns" would be a quietly truncated document, which is worse than no export: the reader has no
// way to know what is missing.
//
// WHAT "STREAMED" MEANS HERE, honestly (audit AH-37): the FILE is read line by line, so the raw
// bytes are never held whole - but every parsed turn is kept, and the rendered document is one
// string, because `SessionExport.body: string` is the contract the route and the MCP tool hand
// out. A transcript of a few hundred megabytes therefore costs the parsed events plus one or two
// complete serialized copies at once. So there is a CEILING (EXPORT_MAX_BYTES): a transcript over
// it is refused up front with a reason that names both numbers, and the raw `.jsonl` download -
// which really is a stream - is the path for it. Constant memory would need a chunked response;
// that is not built, and this file does not claim it.
//
// SECRETS ARE REDACTED, ALWAYS, ON THIS PATH. An export exists to be sent somewhere, so the
// omission pass is not optional here the way it is for viewing your own transcript on your own
// machine. It is the same guardrail the ChatGPT context pack documents (server/src/secrets.ts) and
// carries the same caveat, stated in the export itself rather than only in the code: it catches
// formats that are unmistakable, and it is not a promise that nothing sensitive remains. Anyone
// exporting a session should still read it before sending it.
//
// The HTML is produced by escaping first and assembling tags after, the same property the web
// renderer holds (web/src/lib/markdown.ts): every tag in the output is one this file wrote.

import { readForeignSession } from './foreign-sessions'
import { readHermesSession } from './hermes-sessions'
import { readOpenCodeSession } from './opencode-sessions'
import { redactSecrets, scanSecrets } from './secrets'
import { streamLines } from './session-search'
import { eventToTailEventsForSource, findTranscriptAsync } from './transcript'
import type { SessionSecretScan, SessionSource, TailEvent } from './types'

export type ExportFormat = 'markdown' | 'html'

export interface SessionExport {
  filename: string
  contentType: string
  body: string
  /** How many secret-shaped strings were replaced. Reported in the document itself. */
  redacted: number
  turns: number
}

const ROLE_LABEL: Record<string, string> = { user: 'You', assistant: 'Assistant' }

function stamp(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

/** A fence long enough to survive whatever backticks the content itself contains. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Read every displayable turn of a transcript, in order, without holding the file in memory. */
async function readAllEvents(
  path: string,
  source: SessionSource,
  sessionId: string,
  thinking = false,
): Promise<TailEvent[]> {
  if (source === 'foreign') {
    const tf = await findTranscriptAsync(sessionId, 'foreign')
    return tf ? readForeignSession(tf.tool ?? '', tf.path) : []
  }
  // path here IS the store's db path (see the two call sites below), so a Hermes profile's own
  // database - or a Kilo / MiMo Code / IcodeMate store, which are OpenCode-format databases of
  // their own (audit AH-34) - is what actually gets read, never always the default one.
  if (source === 'opencode') return readOpenCodeSession(sessionId, path)?.events ?? []
  if (source === 'hermes') return readHermesSession(sessionId, path)?.events ?? []
  const events: TailEvent[] = []
  for await (const line of streamLines(path)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev: unknown
    try {
      ev = JSON.parse(trimmed)
    } catch {
      continue
    }
    events.push(...eventToTailEventsForSource(source, ev, { thinking }))
  }
  return events
}

interface Header {
  title: string
  sessionId: string
  source: SessionSource
  cwd: string
  turns: number
  redacted: number
  exportedAt: string
}

const CAVEAT =
  'Secrets in recognisable formats (private keys, AWS key ids, provider tokens) were replaced ' +
  'before this file was written. That is a guardrail, not a guarantee: it cannot find a ' +
  'credential written as ordinary prose or in a format it does not know. Read this before sending it.'

function toMarkdown(h: Header, events: TailEvent[]): string {
  const out: string[] = [
    `# ${h.title}`,
    '',
    `- Session: \`${h.sessionId}\` (${h.source})`,
    ...(h.cwd ? [`- Working directory: \`${h.cwd}\``] : []),
    `- Turns: ${h.turns}`,
    `- Exported: ${h.exportedAt}`,
    ...(h.redacted > 0 ? [`- Redacted: ${h.redacted}`] : []),
    '',
    `> ${CAVEAT}`,
    '',
    '---',
    '',
  ]
  for (const ev of events) {
    const when = stamp(ev.timestamp)
    if (ev.kind === 'tool_use' || ev.kind === 'tool_result') {
      const label = ev.kind === 'tool_use' ? `Tool: ${ev.tool_name ?? 'tool'}` : 'Tool result'
      const f = fence(ev.text)
      out.push(`**${label}**${when ? ` · ${when}` : ''}`, '', `${f}`, ev.text, f, '')
      continue
    }
    const who = ev.kind === 'thinking' ? 'Reasoning' : (ROLE_LABEL[ev.role] ?? ev.role)
    out.push(`### ${who}${when ? ` · ${when}` : ''}`, '', ev.text, '')
  }
  return out.join('\n')
}

/**
 * One file, no assets. The styles are inline and the palette is defined for both schemes, because
 * an exported transcript gets opened months later on a machine that knows nothing about this app.
 */
function toHtml(h: Header, events: TailEvent[]): string {
  const body = events
    .map((ev) => {
      const when = stamp(ev.timestamp)
      const meta = when ? `<span class="when">${escapeHtml(when)}</span>` : ''
      if (ev.kind === 'tool_use' || ev.kind === 'tool_result') {
        const label = ev.kind === 'tool_use' ? `Tool: ${ev.tool_name ?? 'tool'}` : 'Tool result'
        return `<section class="tool"><h4>${escapeHtml(label)}${meta}</h4><pre>${escapeHtml(ev.text)}</pre></section>`
      }
      const cls = ev.kind === 'thinking' ? 'turn thinking' : `turn ${ev.role}`
      const who = ev.kind === 'thinking' ? 'Reasoning' : (ROLE_LABEL[ev.role] ?? ev.role)
      return `<section class="${cls}"><h4>${escapeHtml(who)}${meta}</h4><pre>${escapeHtml(ev.text)}</pre></section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(h.title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #16181d; --muted: #616874; --line: #e3e6ea;
  --user: #f1f4f9; --assistant: #f7f8fa; --tool: #fafafa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d; --fg: #e7e9ee; --muted: #9aa1ad; --line: #2b2f38;
    --user: #22262e; --assistant: #1c2027; --tool: #191c22;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--fg);
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
h4 { margin: 0 0 .4rem; font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.when { float: right; text-transform: none; letter-spacing: 0; font-weight: 400; }
dl { margin: 0 0 1.25rem; color: var(--muted); font-size: .85rem; }
dl div { display: flex; gap: .5rem; }
dt { min-width: 8rem; }
.caveat { border-left: 3px solid var(--line); margin: 0 0 2rem; padding: .5rem 0 .5rem .9rem; color: var(--muted); font-size: .85rem; }
section { margin: 0 0 1.1rem; padding: .8rem 1rem; border-radius: .6rem; background: var(--assistant); }
section.user { background: var(--user); }
section.thinking { background: var(--tool); font-style: italic; }
section.tool { background: var(--tool); border-left: 2px solid var(--line); }
pre {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
  font: inherit;
}
section.tool pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(h.title)}</h1>
<dl>
  <div><dt>Session</dt><dd>${escapeHtml(h.sessionId)} (${escapeHtml(h.source)})</dd></div>
  ${h.cwd ? `<div><dt>Working directory</dt><dd>${escapeHtml(h.cwd)}</dd></div>` : ''}
  <div><dt>Turns</dt><dd>${h.turns}</dd></div>
  <div><dt>Exported</dt><dd>${escapeHtml(h.exportedAt)}</dd></div>
  ${h.redacted > 0 ? `<div><dt>Redacted</dt><dd>${h.redacted}</dd></div>` : ''}
</dl>
<p class="caveat">${escapeHtml(CAVEAT)}</p>
${body}
</main>
</body>
</html>
`
}

/** Filesystem-safe, and identifiable months later: the title, then the id. */
function exportFilename(title: string, sessionId: string, ext: string): string {
  // A session with no derivable title falls back to its own id, and slugging that would name the
  // file after the same uuid twice.
  const base = title === sessionId ? '' : title
  const slug =
    base
      .replace(/[^A-Za-z0-9 _-]+/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'session'
  return `${slug}-${sessionId.slice(0, 8)}.${ext}`
}

/** The largest transcript this path will render into one document. 64 MB of JSONL renders to a
 *  document of roughly the same size on top of its parsed events; past that the raw download is
 *  the honest answer. `AGENTHYDRA_EXPORT_MAX_MB` raises or lowers it for an operator who knows
 *  their machine. */
export const EXPORT_MAX_BYTES_DEFAULT = 64 * 1024 * 1024

export function exportMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.AGENTHYDRA_EXPORT_MAX_MB)
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : EXPORT_MAX_BYTES_DEFAULT
}

/** An export that was not produced because the transcript is over the ceiling - a distinct answer
 *  from "not found", so the route can say what to do instead. */
export interface ExportRefused {
  refused: 'too-large'
  sizeBytes: number
  limitBytes: number
  message: string
}

export function isExportRefused(x: unknown): x is ExportRefused {
  return !!x && typeof x === 'object' && (x as { refused?: unknown }).refused === 'too-large'
}

export async function exportSession(
  sessionId: string,
  format: ExportFormat,
  source?: SessionSource,
  // `locator` lives on meta rather than as its own positional parameter so an existing caller
  // passing a meta object stays valid unchanged (audit AH-35: without it, a source+id pointing at
  // two products sharing a format — Kilo/MiMo Code, both `opencode` — could export the wrong one).
  meta: { title?: string; cwd?: string; thinking?: boolean; locator?: string } = {},
  deps: { findTranscript?: typeof findTranscriptAsync; maxBytes?: number } = {},
): Promise<SessionExport | ExportRefused | null> {
  const tf = await (deps.findTranscript ?? findTranscriptAsync)(sessionId, source, meta.locator)
  if (!tf) return null

  // The ceiling, checked BEFORE a byte of the transcript is parsed (see the file header). The
  // index already carries the file size; an OpenCode/Hermes row's is its database's, which is the
  // right thing to bound on too.
  const limitBytes = deps.maxBytes ?? exportMaxBytes()
  const sizeBytes = tf.size_bytes ?? 0
  if (sizeBytes > limitBytes) {
    const mb = (n: number) => `${Math.round((n / 1048576) * 10) / 10} MB`
    return {
      refused: 'too-large',
      sizeBytes,
      limitBytes,
      message: `export refused: this transcript is ${mb(sizeBytes)}, over the ${mb(limitBytes)} export ceiling (rendering it would hold the whole document in memory). Download the raw transcript instead, or raise AGENTHYDRA_EXPORT_MAX_MB on a machine that can take it.`,
    }
  }

  // Reasoning is left out unless asked for, matching the viewer: it is the bulkiest part of a
  // transcript and the least useful part of a document someone else is going to read.
  const raw = await readAllEvents(tf.path, tf.source, sessionId, meta.thinking ?? false)
  let redacted = 0
  const events = raw.map((ev) => {
    const r = redactSecrets(ev.text)
    redacted += r.redacted
    return r.redacted ? { ...ev, text: r.text } : ev
  })

  const header: Header = {
    title: meta.title || tf.title || sessionId,
    sessionId,
    source: tf.source,
    cwd: meta.cwd || tf.cwd || '',
    turns: events.length,
    redacted,
    exportedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  }

  return format === 'html'
    ? {
        filename: exportFilename(header.title, sessionId, 'html'),
        contentType: 'text/html; charset=utf-8',
        body: toHtml(header, events),
        redacted,
        turns: events.length,
      }
    : {
        filename: exportFilename(header.title, sessionId, 'md'),
        contentType: 'text/markdown; charset=utf-8',
        body: toMarkdown(header, events),
        redacted,
        turns: events.length,
      }
}

const MAX_FINDINGS = 200

/**
 * Scan one transcript for secrets it printed.
 *
 * Never returns the secret. There is no reveal parameter and there should not be one: the
 * transcript is on this machine and already open in the viewer, so anything this could reveal is a
 * click away in the session itself — while an endpoint that hands out credentials is a new way to
 * lose them, reachable by anything that can reach the daemon, including the MCP tools.
 */
export async function scanSessionSecrets(
  sessionId: string,
  source?: SessionSource,
  locator?: string,
): Promise<SessionSecretScan | null> {
  const tf = await findTranscriptAsync(sessionId, source, locator)
  if (!tf) return null
  const events = await readAllEvents(tf.path, tf.source, sessionId)
  const findings: SessionSecretScan['findings'] = []
  let count = 0
  for (const [turn, ev] of events.entries()) {
    for (const hit of scanSecrets(ev.text)) {
      count++
      if (findings.length < MAX_FINDINGS)
        findings.push({ kind: hit.kind, redacted: hit.redacted, turn, role: ev.role })
    }
  }
  return {
    session_id: sessionId,
    source: tf.source,
    count,
    findings,
    truncated: count > findings.length,
  }
}
