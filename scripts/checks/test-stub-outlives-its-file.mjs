// Guardrail against a test file whose stub OUTLIVES it.
//
// `bun test` runs every file in ONE process (CI's serial run, and each --parallel worker too), and
// two kinds of stub are process-wide rather than file-wide:
//   · an assignment to a global - globalThis.fetch, Bun.spawn - made at module scope or inside a
//     before* hook and never put back;
//   · mock.module(), which Bun applies to the whole run: every file that loads that module AFTER
//     this one gets the fake, and mock.restore() does not undo it (measured on bun 1.4.0).
// Both are invisible in the file that made them - it passes alone, and it passes under --parallel
// whenever the split happens to isolate it - and land on whichever file runs next. Found the hard
// way on 2026-09-05, twice in one day. First, three probe tests parked under tmp/ patched fetch and
// node:child_process at module scope and broke instance-pointer + updater-engine in the serial run
// (bunfig.toml now ignores tmp/). Then request-generations.test.ts mock.module'd web/src/lib/api and
// resource-status.test.ts, next in order, imported the real runQueueItem and awaited a getQueue
// nothing would ever resolve: three 5s timeouts, and because a timed-out test never reaches its
// `finally`, ITS fetch stub then leaked on to instance-pointer as well. One unrestored mock, three
// files red, none of them the culprit, and a bisect to find it.
//
// The rule, mechanical on purpose:
//   1. A global stubbed at MODULE SCOPE or inside beforeAll/beforeEach must be assigned again inside
//      afterAll/afterEach. A stub made inside a test body is that test's own business and is not
//      examined; the shape this repo uses there is try/finally (web/tests/resource-status.test.ts).
//   2. Every mock.module(SPEC) outside an after* hook must have a mock.module(SPEC) inside one,
//      re-mocking to a copy of the real exports taken BEFORE the fake was installed. Taken after,
//      the copy IS the fake: mock.module rewrites the live bindings of a namespace that was already
//      imported. web/tests/request-generations.test.ts is the worked example. Where the module under
//      test allows it, inject the dependency instead and mock nothing (tests/monitor.test.ts).
//
// Comments and string interiors are blanked before the scan (the same scanner as
// spawn-test-without-timeout.mjs), so a file that DISCUSSES a leak in prose is not reported as one.
// The mock specifier is read back from the untouched text at the same index.
//
// Self-contained by design (same reason as the other checks here): imports nothing but node stdlib,
// and returns plain finding objects for the runner.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'test-stub-outlives-its-file'

// The globals this repo's tests actually stub. `fetch` is the whole HTTP boundary of the web and
// orchestrator composables and of every daemon client; Bun.spawn/spawnSync are its process
// boundary. Listed by name so a new one is a deliberate addition here, never a silent widening.
// `=` must not be the start of `==` or `=>`.
const GLOBAL_STUB = /(?<![\w$.])((?:globalThis|global|window)\.fetch|Bun\.spawnSync|Bun\.spawn)\s*=(?![=>])/g
const MODULE_MOCK = /(?<![\w$.])mock\.module\s*\(/g
const BEFORE_HOOK = /(?<![\w$.])(?:beforeAll|beforeEach)\s*\(/g
const AFTER_HOOK = /(?<![\w$.])(?:afterAll|afterEach)\s*\(/g

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.arkitect', 'coverage', 'build'])
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/** Recursively yield every test file under `dir`. */
function* testFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* testFiles(p)
    } else if (TEST_FILE.test(e.name)) {
      yield p
    }
  }
}

/** Index just past the regex literal opening at `start`, or -1 if it does not close on that line.
 *  `/` inside a `[...]` class is literal, so classes are tracked. */
function endOfRegex(text, start) {
  let inClass = false
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === '\n') return -1
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '/') return j + 1
  }
  return -1
}

// A `/` opens a regex only where an expression is expected. A missed regex can carry a bare quote,
// which opens a string that never closes and inverts code/string for the rest of the file.
const REGEX_OPENS_AFTER = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>'],
)
const REGEX_OPENS_AFTER_KEYWORD =
  /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/

/** One scanner step inside a string/template literal opened by `quote`: blanks the current char (or
 *  escape pair) in `out` in place. */
function advanceInString(text, out, i, quote, prev) {
  const ch = text[i]
  if (ch === '\\') {
    if (text[i] !== '\n') out[i] = ' '
    if (text[i + 1] !== '\n') out[i + 1] = ' '
    return { i: i + 2, inString: quote, prev }
  }
  if (ch === quote) {
    return { i: i + 1, inString: null, prev: ch }
  }
  if (ch !== '\n') out[i] = ' '
  return { i: i + 1, inString: quote, prev }
}

/** One scanner step outside a string: opens a string, blanks a comment or a regex literal, or
 *  advances one character while tracking `prev`, the last non-whitespace char. */
function advanceCode(text, out, i, prev) {
  const ch = text[i]
  if (ch === '"' || ch === "'" || ch === '`') {
    return { i: i + 1, inString: ch, prev }
  }
  if (ch === '/' && text[i + 1] === '/') {
    let j = i
    while (j < text.length && text[j] !== '\n') out[j++] = ' '
    return { i: j, inString: null, prev }
  }
  if (ch === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2)
    const stop = end === -1 ? text.length : end + 2
    for (let j = i; j < stop; j++) if (text[j] !== '\n') out[j] = ' '
    return { i: stop, inString: null, prev }
  }
  if (
    ch === '/' &&
    (prev === '' ||
      REGEX_OPENS_AFTER.has(prev) ||
      REGEX_OPENS_AFTER_KEYWORD.test(text.slice(0, i).trimEnd()))
  ) {
    const end = endOfRegex(text, i)
    if (end !== -1) {
      for (let j = i; j < end; j++) if (text[j] !== '\n') out[j] = ' '
      return { i: end, inString: null, prev: '/' }
    }
  }
  const nextPrev = /\s/.test(ch) ? prev : ch
  return { i: i + 1, inString: null, prev: nextPrev }
}

/** Blank comments and the INTERIOR of every string/template literal with spaces, so every surviving
 *  character keeps its original index (line numbers and the specifier lookup both rely on that).
 *  Quotes and braces are preserved so spans and depth still balance. */
function blankNonCode(text) {
  const out = text.split('')
  let inString = null
  let prev = ''
  let i = 0
  while (i < text.length) {
    const step = inString ? advanceInString(text, out, i, inString, prev) : advanceCode(text, out, i, prev)
    i = step.i
    inString = step.inString
    prev = step.prev
  }
  return out.join('')
}

/** Extract `text` from `open` (a bracket) through its match. Operates on blanked code. */
function extractBalanced(text, open, oc = '(', cc = ')') {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === oc) depth++
    else if (c === cc) {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}

/** [start, end) index spans of every call whose head matches `head` - the whole argument list, so a
 *  hook's callback body is inside its span. */
function callSpans(code, head) {
  head.lastIndex = 0
  const spans = []
  for (const m of code.matchAll(head)) {
    const open = m.index + m[0].length - 1
    spans.push([open, open + extractBalanced(code, open).length])
  }
  return spans
}

const within = (spans, index) => spans.some(([a, b]) => index >= a && index < b)

/** Brace depth at `index`: 0 is module scope. Braces inside strings and comments are already
 *  blanked, so only code braces count. */
function depthAt(code, index) {
  let depth = 0
  for (let i = 0; i < index; i++) {
    const c = code[i]
    if (c === '{') depth++
    else if (c === '}') depth--
  }
  return depth
}

/** `globalThis.fetch`, `global.fetch` and `window.fetch` are one global; the Bun ones are their own. */
const normalizeGlobal = (name) => (name.endsWith('.fetch') ? 'fetch' : name)

/** The literal first argument of the mock.module call at `index` in the UNTOUCHED text, or null when
 *  it is not a string literal. */
function mockSpecifier(text, index) {
  const m = text.slice(index, index + 400).match(/^mock\.module\s*\(\s*(['"`])([^'"`\n]+)\1/)
  return m ? m[2] : null
}

/** Every stub in `text` that outlives the file: a module-scope or before-hook global assignment with
 *  no after-hook assignment to the same global, and a mock.module(SPEC) with no mock.module(SPEC)
 *  inside an after hook. Exported so the rule can be unit-tested against fixture strings. */
export function findViolations(text) {
  const code = blankNonCode(text)
  const before = callSpans(code, BEFORE_HOOK)
  const after = callSpans(code, AFTER_HOOK)
  const hits = []

  const restored = new Set()
  const stubs = []
  GLOBAL_STUB.lastIndex = 0
  for (const m of code.matchAll(GLOBAL_STUB)) {
    const name = normalizeGlobal(m[1])
    if (within(after, m.index)) restored.add(name)
    else if (depthAt(code, m.index) === 0 || within(before, m.index)) stubs.push({ index: m.index, name })
  }
  for (const s of stubs) if (!restored.has(s.name)) hits.push({ index: s.index, kind: 'global', name: s.name })

  // A mock whose specifier is not a literal cannot be matched by name; any re-mock in an after hook
  // is then accepted, which errs towards silence rather than a false red on an exotic shape.
  const remocked = new Set()
  const mocks = []
  MODULE_MOCK.lastIndex = 0
  for (const m of code.matchAll(MODULE_MOCK)) {
    const spec = mockSpecifier(text, m.index) ?? '*'
    if (within(after, m.index)) remocked.add(spec)
    else mocks.push({ index: m.index, spec })
  }
  for (const k of mocks) {
    if (remocked.has(k.spec) || remocked.has('*')) continue
    hits.push({ index: k.index, kind: 'module', name: k.spec })
  }

  return hits.sort((a, b) => a.index - b.index)
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length

const CHEAP_REJECT = /mock\.module|(?:globalThis|global|window)\.fetch\s*=|Bun\.spawn(?:Sync)?\s*=/

export const audit = {
  id: ID,
  title: 'a test file must put back every global it stubs and every module it mocks before it ends',
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: the cost lands on a DIFFERENT file, in the serial run CI uses, as a red that reads as
  // a bug in code nobody touched.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const findings = []
    let filesScanned = 0

    for (const file of testFiles(root)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      let text
      try {
        if (statSync(file).size > 2_000_000) continue
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!CHEAP_REJECT.test(text)) continue // cheap reject before the scanner runs
      filesScanned += 1
      for (const hit of findViolations(text)) {
        findings.push({
          id: ID,
          file: rel,
          line: lineAt(text, hit.index),
          severity: 'error',
          what: hit.kind === 'global' ? `${hit.name} stubbed, never restored` : `mock.module(${hit.name}) never re-mocked`,
          message:
            hit.kind === 'global'
              ? `This file stubs ${hit.name} at module scope or in a before* hook and never assigns ` +
                'it back in afterAll/afterEach. bun test runs every file in one process, so the ' +
                "stub is what the NEXT file's code calls: three probe tests that did this to fetch " +
                "on 2026-09-05 made instance-pointer's findLiveInstance probe its own server " +
                'through a fake and count 0 hits, in a file nobody had touched.'
              : `mock.module(${JSON.stringify(hit.name)}) is global for the whole bun test run and ` +
                'mock.restore() does not undo it: every file that loads this module after this one ' +
                'gets the fake. request-generations.test.ts did this to web/src/lib/api on ' +
                '2026-09-05 and resource-status.test.ts, next in the serial order, waited 5s three ' +
                'times on a getQueue nothing would ever resolve.',
          fix:
            hit.kind === 'global'
              ? `Keep the original (const real = ${hit.name === 'fetch' ? 'globalThis.fetch' : hit.name}) ` +
                'and assign it back in afterAll, or stub inside the test with a try/finally restore ' +
                'the way web/tests/resource-status.test.ts does.'
              : 'Copy the real exports BEFORE installing the fake - ' +
                '`const realApi = { ...(await import(SPEC)) }` - and re-mock to that copy in afterAll: ' +
                '`afterAll(() => { mock.module(SPEC, () => realApi) })`. A copy taken after the fake ' +
                "is a copy of the fake, because mock.module rewrites the namespace's live bindings. " +
                'Better still, inject the dependency and mock nothing (tests/monitor.test.ts).',
        })
      }
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} stub(s) that outlive their test file:\n${findings
          .map((f) => `- ${f.file}:${f.line} (${f.what})`)
          .join('\n')}`
      : `Every module-scope or before-hook global stub and every mock.module in the test tree is ` +
        `put back in an after hook (${filesScanned} stubbing file(s) scanned). ✓`

    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation. During an arkitect
// run the module is only IMPORTED, so this block is inert there; it fires only on direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
