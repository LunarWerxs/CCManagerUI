// server/src/core/instance-ref.ts — turn whatever a human or an AI typed into ONE real instance.
//
// The number registry (instance-numbers.ts) is deliberately dumb: ref <-> integer, nothing else.
// This module is the layer above it that knows about the three instance families, and it exists so
// there is exactly ONE resolution rule shared by the REST route, the MCP tools and the queue's
// `instance_ref` field. Every caller accepts the same spellings, and a change to what counts as a
// valid reference happens in one place.
//
// Accepted spellings, in the order they are tried:
//   7 · "7" · "#7"                 the permanent number — the spoken handle this all exists for
//   "desktop:<dir>" · "cli:<id>"   an explicit ref (what the queue stores, what usage caches key on)
//   "<uuid>" · "default"           a bare CLI/Codex instance id
//   "C:\…\.claude-instances\x"     a desktop instance directory
//   "4claude"                      a name or label, case-insensitive, if it matches exactly one
//
// A name is tried LAST and only accepted when unambiguous: labels are user-editable and two
// instances may share the account name they default to, so a name that matches two rows resolves to
// nothing rather than to a coin flip. The number never has that problem, which is the argument for
// preferring it in anything written down.

import { resolveAccount } from './accounts'
import { listCliInstances } from './cli-instances'
import { listCodexInstances } from './codex-instances'
import { type InstanceKind, instanceRef, refForNumber } from './instance-numbers'
import { listInstances } from './instances'
import { normalizeInstancePath } from './paths'
import {
  describeSelfIdentity,
  detectSelfIdentity,
  type SelfIdentityDeps,
  type SelfIdentityDetection,
} from './self-identity'

/** One instance, flattened to the fields any caller needs to act on or display it. */
export interface ResolvedInstance {
  /** The permanent number (`#7`). */
  num: number
  kind: InstanceKind
  /** The handle the existing per-kind routes/tools take: a DIR for desktop, an ID for cli/codex. */
  handle: string
  /** `desktop:<dir>` | `cli:<id>` | `codex:<id>` — the registry/usage-cache key and the value the
   *  queue's `instance_ref` column stores. */
  ref: string
  /** What the UI calls it: user label, else account name, else folder/instance name. */
  name: string
  /** The account this instance is signed into, when it is known without a network call. */
  email: string | null
  plan: string | null
  /**
   * The RATE-LIMIT tier, as a display label (`Pro`, `Max 5×`, `Max 20×` — core/shared.ts
   * prettyTier), or the raw string when unrecognized.
   *
   * Surfaced NEXT TO `plan` rather than folded into it because they answer different questions and
   * can disagree: `plan` is what the subscription is CALLED (an org seat reads "Team"), while this
   * is what the quota actually IS. An agent pacing itself needs the second one — headroom differs
   * by roughly 20× between Pro and Max 20×, so "how fast may I burn" cannot be read off the plan
   * name alone.
   */
  tier: string | null
  /** Where its credentials live: the desktop user-data dir, the CLAUDE_CONFIG_DIR, or CODEX_HOME.
   *  This is what a usage check ultimately reads. */
  configDir: string
  loggedIn: boolean
  /** Desktop/Codex-desktop only: whether a window is up right now. Null when not applicable. */
  isRunning: boolean | null
}

/** Every instance across all three families, numbered, in number order. */
export async function listAllInstances(): Promise<ResolvedInstance[]> {
  // `noNetwork` identity: reads the already-resolved instances-cache.json and never decrypts or
  // calls out. That matters because this listing is the cheap lookup every other tool funnels
  // through — "who is #7" must not cost a round trip per instance.
  const [desktops, codexes] = await Promise.all([
    listInstances({
      includeAccount: true,
      includeSize: false,
      resolveAccount: (dir) => resolveAccount(dir, { noNetwork: true }),
    }),
    listCodexInstances(),
  ])
  const clis = listCliInstances()
  const desktopByDir = new Map(desktops.map((d) => [normalizeInstancePath(d.dir), d]))

  const rows: ResolvedInstance[] = []

  for (const inst of desktops) {
    rows.push({
      num: inst.num,
      kind: 'desktop',
      handle: inst.dir,
      ref: instanceRef('desktop', inst.dir),
      name: inst.label ?? inst.account?.name ?? inst.name,
      email: inst.account?.email ?? null,
      plan: inst.account?.planLabel ?? null,
      tier: inst.account?.rateLimitTier ?? null,
      configDir: inst.dir,
      // `loginUuid` is config.json's lastKnownAccountUuid, read on every list — present means a
      // login is on file, which is the cheapest honest answer available without touching a token.
      loggedIn: inst.loginUuid !== null,
      isRunning: inst.isRunning,
    })
  }

  for (const inst of clis) {
    // A CLI login and the desktop instance it is LINKED to are the same Anthropic account with two
    // auth stores (see usage-service.ts), so the linked instance's resolved identity is this row's
    // identity too. Without this, every CLI row would report a null email — the exact question
    // ("which account is #9?") the number is supposed to answer.
    const linked = inst.associatedDesktopDir
      ? (desktopByDir.get(normalizeInstancePath(inst.associatedDesktopDir)) ?? null)
      : null
    rows.push({
      num: inst.num,
      kind: 'cli',
      handle: inst.id,
      ref: instanceRef('cli', inst.id),
      name: inst.name,
      email: linked?.account?.email ?? null,
      plan: linked?.account?.planLabel ?? null,
      tier: linked?.account?.rateLimitTier ?? null,
      configDir: inst.configDir,
      loggedIn: inst.loggedIn,
      isRunning: null,
    })
  }

  for (const inst of codexes) {
    rows.push({
      num: inst.num,
      kind: 'codex',
      handle: inst.id,
      ref: instanceRef('codex', inst.id),
      name: inst.name,
      email: inst.account?.email ?? null,
      plan: inst.account?.planLabel ?? null,
      // Codex accounts are OpenAI-side; there is no Claude rate-limit tier to report.
      tier: null,
      configDir: inst.codexHome,
      loggedIn: inst.loggedIn,
      isRunning: inst.isDesktopRunning,
    })
  }

  return rows.sort((a, b) => a.num - b.num)
}

/**
 * Which instance owns a given credential directory — the reverse lookup that lets a running agent
 * answer "WHICH one am I?".
 *
 * A Claude Code process launched as CLI instance #9 has `CLAUDE_CONFIG_DIR` set to that instance's
 * config dir and knows nothing else about itself; a Codex process has `CODEX_HOME`. Matching that
 * one env var back to a row is what turns "check your usage" into a check of the RIGHT account.
 * Returns null for the plain `~/.claude` login, which belongs to no managed instance.
 */
export async function instanceForConfigDir(configDir: string): Promise<ResolvedInstance | null> {
  if (!configDir?.trim()) return null
  const wanted = normalizeInstancePath(configDir)
  return (
    (await listAllInstances()).find((r) => normalizeInstancePath(r.configDir) === wanted) ?? null
  )
}

/** What {@link identifySelf} answers: WHO the calling process is, plus the proof. */
export interface SelfIdentityResult {
  /** The managed instance this process belongs to, or null (unmanaged dir / default login). */
  instance: ResolvedInstance | null
  /** How that was established, with every signal that agreed or was ruled out. */
  detection: SelfIdentityDetection
  /** One sentence to quote back at a human. */
  summary: string
}

/**
 * WHICH INSTANCE AM I? — the full answer, evidence included.
 *
 * MUST RUN IN THE AGENT'S OWN PROCESS TREE (the MCP server, a hook, a spawned tool), NOT in the
 * AgentHydra daemon: the whole method is reading this process's environment and walking up to the
 * `claude.exe` that launched it. Called on the daemon it would faithfully identify the daemon,
 * which is exactly the wrong answer delivered with total confidence. That is why the MCP layer
 * detects locally and only asks the daemon for the cheap dir→instance lookup.
 */
export async function identifySelf(deps?: SelfIdentityDeps): Promise<SelfIdentityResult> {
  const detection = await detectSelfIdentity(deps)
  const instance = detection.configDir ? await instanceForConfigDir(detection.configDir) : null
  return { instance, detection, summary: describeSelfIdentity(detection, instance) }
}

/** Parse `7`, `"7"` or `"#7"` into a number. Null for anything else — including `"7claude"`, which
 *  must fall through to the name match rather than being read as instance 7. */
export function parseInstanceNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 ? input : null
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^#/, '')
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  return n > 0 ? n : null
}

/**
 * Resolve any accepted spelling to one live instance, or null.
 *
 * `null` means "no LIVE instance", which is not the same as "never existed": a number belonging to
 * a deleted instance still resolves in the registry but has nothing behind it, and the caller
 * should say so rather than silently acting on a different row.
 */
export async function resolveInstance(input: unknown): Promise<ResolvedInstance | null> {
  return pickInstance(await listAllInstances(), input)
}

/**
 * The matching rule itself, over a list handed in — every spelling, in priority order.
 *
 * Split out from resolveInstance so it can be TESTED. It could not be before: the only entry point
 * awaited listAllInstances(), which reads this machine's real fleet, so the rule that decides which
 * account a tool is about to act on had no unit coverage at all. That is how the email case below
 * stayed broken while several tool descriptions promised it (2026-09-06).
 *
 * Order is deliberate and goes from unambiguous to inferred: number, exact ref, handle/dir, then
 * the two human-typed spellings (name, email) which only count when they name exactly one row.
 */
export function pickInstance(
  all: readonly ResolvedInstance[],
  input: unknown,
): ResolvedInstance | null {
  const num = parseInstanceNumber(input)
  if (num !== null) {
    const direct = all.find((r) => r.num === num)
    if (direct) return direct
    // The number is known to the registry but its instance is gone. Nothing to return — but this
    // is deliberately distinguished from an unknown number by resolveInstanceError() below.
    return null
  }

  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null

  // An explicit ref, and the same string normalized (a desktop ref's dir may be spelled any way).
  const byRef = all.find((r) => r.ref === raw)
  if (byRef) return byRef
  if (raw.startsWith('desktop:')) {
    const wanted = instanceRef('desktop', raw.slice('desktop:'.length))
    const hit = all.find((r) => r.ref === wanted)
    if (hit) return hit
  }

  // A bare handle: a CLI/Codex id, or a desktop dir in any spelling.
  const byHandle = all.find(
    (r) =>
      r.handle === raw ||
      (r.kind === 'desktop' && normalizeInstancePath(r.handle) === normalizeInstancePath(raw)),
  )
  if (byHandle) return byHandle

  // A name/label — only when it identifies exactly one row.
  const needle = raw.toLowerCase()
  const byName = all.filter((r) => r.name.toLowerCase() === needle)
  if (byName.length === 1) return byName[0]!

  // The signed-in ACCOUNT EMAIL, same one-row rule.
  //
  // ⛔ THE TOOLS ALREADY PROMISED THIS AND IT WAS NOT TRUE (found by probing the /api/chats route
  // with an address). move_chat's `from` is documented as "instance number, name, label or email";
  // an email fell all the way through to `null` here, and null is indistinguishable from "that
  // instance is gone", so the caller got an empty answer rather than an error. An email is also
  // the identifier a person is most likely to know for an account.
  //
  // Last, and only when unambiguous, for the same reason `name` is: two instances can be signed
  // into the SAME account (a second profile on one login is an ordinary setup), and silently
  // picking either would be worse than declining. Ambiguous stays null, which resolveInstanceError
  // below reports as unknown.
  const byEmail = all.filter((r) => r.email?.toLowerCase() === needle)
  if (byEmail.length === 1) return byEmail[0]!

  return null
}

/** A message explaining a failed resolve, phrased for whoever passed the bad reference. Separate
 *  from resolveInstance so the happy path stays a plain nullable and never builds a string. */
export async function resolveInstanceError(input: unknown): Promise<string> {
  const num = parseInstanceNumber(input)
  if (num !== null) {
    const retired = refForNumber(num)
    if (retired) {
      return `instance #${num} was '${retired.ref}', which no longer exists (deleted). Numbers are never reused, so this one stays retired — call list_instance_numbers for the current fleet.`
    }
    return `no instance #${num}. Call list_instance_numbers to see every instance and its number.`
  }
  return `could not resolve instance '${String(input)}'. Pass its number (e.g. 7 or "#7"), its dir/id, or an unambiguous name — list_instance_numbers shows all three.`
}
