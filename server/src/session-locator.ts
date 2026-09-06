// server/src/session-locator.ts — audit AH-35.
//
// `TranscriptFile.tool` is the product identity and `source` is only the parsing FORMAT (see the
// doc comment on TranscriptFile.tool in transcript.ts). Several places in this codebase used to key
// or look up a session by `source` + `session_id` alone, which is exactly wrong whenever two
// PRODUCTS share one format: Kilo and MiMo Code are both `source: 'opencode'` (OpenCode-format
// SQLite, audit AH-34), and two Hermes profiles are both `tool: 'hermes'` (two separate databases
// under one catalog root, see hermesRecords in transcript.ts). A session id colliding across either
// pair used to collapse to one row in the index, and every route that accepted only `?source=` had
// no way to ask for the other one.
//
// This module is the ONE place that identity is computed, so the index de-dup key, findTranscript,
// every session route, the done-mark key and any future join can all agree on what "the same
// session" means. `locator` is the opaque, versioned, public form of it — safe to hand out over the
// API without ever exposing a raw filesystem or database path as an identifier.

import type { SessionSource } from './types'

const LOCATOR_VERSION = 'v1'

/** The fields a locator is computed from. A structural (not nominal) shape rather than importing
 *  `TranscriptFile` as a value, so this module never has to know about transcript.ts's much larger
 *  surface — only these four fields are ever read. */
export interface LocatorSource {
  source: SessionSource
  tool?: string
  path: string
  session_id: string
}

export interface LocatorParts {
  source: SessionSource
  tool: string
  storeKey: string
}

/**
 * Which physical store a row's identity keys on, beyond source + tool.
 *
 * Database-backed formats (opencode, hermes) key on the database PATH: several Hermes profiles, or
 * several OpenCode-format products' catalog entries, can each be their own database, and two of
 * them can share a session id even when they also share a tool id (Hermes profiles all report
 * `tool: 'hermes'`). Tool alone would collapse them; the path does not, and a session never moves
 * between databases.
 *
 * File-backed formats (claude, codex, foreign) key on the tool id itself. Today's catalog gives
 * each such tool exactly one root family — Codex's live and archived roots are deliberately ONE
 * family sharing `tool: 'codex'`, which is what lets a rollout mid-move between them still collapse
 * to a single row (see finishIndex in transcript.ts) — so the tool already names "the store" for
 * these formats without needing the exact file path, which would otherwise defeat that intentional
 * live/archived merge.
 */
export function storeKeyOf(tf: LocatorSource): string {
  if (tf.source === 'opencode' || tf.source === 'hermes') return tf.path
  return tf.tool ?? tf.source
}

export function locatorParts(tf: LocatorSource): LocatorParts {
  return { source: tf.source, tool: tf.tool ?? tf.source, storeKey: storeKeyOf(tf) }
}

/**
 * The de-dup / lookup identity for a row: same product + same store survives a move (a Codex
 * rollout briefly visible in both live and archived roots, the same conversation revisited later),
 * while two different products or stores sharing a session id never collapse into each other. This
 * is the ONE thing "the same session" means everywhere in this codebase; see finishIndex and
 * findTranscript in transcript.ts.
 *
 * NUL-separated rather than colon-joined: a tool id or a Windows path can legally contain a colon
 * (`C:\...`), and a naive `${a}:${b}:${c}` join lets two different (source, tool, storeKey, id)
 * tuples produce the same string. \0 cannot appear in any of these fields.
 */
export function dedupeKey(tf: LocatorSource): string {
  const { source, tool, storeKey } = locatorParts(tf)
  return `${source}\0${tool}\0${storeKey}\0${tf.session_id}`
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8')
}

/**
 * An opaque, versioned locator for one session row — the public, API-safe form of {@link dedupeKey}.
 *
 * Never exposes a raw filesystem or database path as a public identifier (the payload is base64url,
 * not the store key in the clear), but round-trips to the exact source + tool + store a caller
 * meant. `?source=opencode` alone cannot distinguish Kilo from MiMo Code; a locator can.
 */
export function makeLocator(tf: LocatorSource): string {
  const { source, tool, storeKey } = locatorParts(tf)
  return `${LOCATOR_VERSION}:${b64urlEncode(JSON.stringify([source, tool, storeKey, tf.session_id]))}`
}

export interface ParsedLocator {
  version: string
  source: SessionSource
  tool: string
  storeKey: string
  sessionId: string
}

/**
 * Parse a locator produced by {@link makeLocator}, or null for anything malformed, foreign, or of an
 * unknown version.
 *
 * A caller must treat a bad locator exactly like no locator at all — never throw across an API
 * boundary over a query parameter a client got wrong or a future version this build predates.
 */
export function parseLocator(raw: string | undefined | null): ParsedLocator | null {
  if (!raw) return null
  const sep = raw.indexOf(':')
  if (sep < 0) return null
  const version = raw.slice(0, sep)
  if (version !== LOCATOR_VERSION) return null
  try {
    const decoded: unknown = JSON.parse(b64urlDecode(raw.slice(sep + 1)))
    if (!Array.isArray(decoded) || decoded.length !== 4) return null
    const [source, tool, storeKey, sessionId] = decoded
    if (
      typeof source !== 'string' ||
      typeof tool !== 'string' ||
      typeof storeKey !== 'string' ||
      typeof sessionId !== 'string'
    )
      return null
    return { version, source: source as SessionSource, tool, storeKey, sessionId }
  } catch {
    return null
  }
}

/** Whether a transcript row IS the one row a parsed locator named. */
export function matchesLocator(tf: LocatorSource, loc: ParsedLocator): boolean {
  if (tf.source !== loc.source || tf.session_id !== loc.sessionId) return false
  const parts = locatorParts(tf)
  return parts.tool === loc.tool && parts.storeKey === loc.storeKey
}
