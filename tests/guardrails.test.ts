// tests/guardrails.test.ts: proves the repo's custom checks themselves work, not just that the
// repo currently passes them. Two real failures motivate this file:
//   · reka-trigger-tooltip-button.mjs (2026-07-16) encoded a wrong diagnosis AND crashed on import
//     (`Cannot find package 'connections-arkitect'`), so it never ran at all. A check that throws
//     and a check that passes look the same from a distance.
//   · spawn-console-window.mjs's first cut had a blind spot shaped exactly like the bug it exists to
//     catch: it only saw literal argv, so a resolveClaudeExe() spawn slipped through unnoticed.
// "The check passes" is not evidence the check works; it might not even be running. So for every
// check under scripts/checks, discovered by reading the directory (never hardcoded, so
// a new check cannot silently dodge this file), we: import it for real, assert it exports a
// well-formed gating audit, run it against the live repo root, and, for every check that exposes
// findViolations, prove it actually fires on the broken shape it claims to catch and stays quiet on
// the fixed one. A guardrail that cannot fail is not a guardrail.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from './repo-root'

// The checks used to live under .arkitect/your-checks/code. That directory was deleted wholesale
// on 2026-07-27 while both this file and ci.yml still pointed at it, which is exactly the
// can-a-guardrail-silently-stop-running failure this file exists to catch. They now live in
// scripts/checks and depend on nothing but bun.
const CHECKS_DIR = join(REPO_ROOT, 'scripts', 'checks')

// Discovered, not hardcoded: a check dropped into this directory is automatically subject to every
// assertion below, including the fire / stay-quiet fixtures wired through FIXTURES_BY_FILE.
const CHECK_FILES = readdirSync(CHECKS_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort()

// Assembled at runtime, never written as a contiguous literal in this file's source: see the
// wmi-commandline-query-self-match fixtures below for why.
const CMD_LINE = 'Command' + 'Line'

// Bespoke broken / fixed text for each check that exports findViolations, written from the real bug
// each check's own header comment documents, not a synthetic near-miss. A check that exports
// findViolations but has no entry here fails loudly below rather than being silently skipped.
const FIXTURES_BY_FILE: Record<string, { broken: string[]; fixed: string[] }> = {
  'local-api-origin-allowlist.mjs': {
    broken: [
      // instance-mode.ts as it actually stood after AH-11 was marked closed: a second local server,
      // serving instance create/open/quit, still trusting ANY loopback origin. A page on any other
      // localhost port could drive it, and nothing said so.
      `
      import { cors } from 'hono/cors'
      import { isLoopbackOrigin, loopbackGuard } from './loopback-guard.mjs'
      app.use('/api/*', cors({ origin: (o) => (o && isLoopbackOrigin(o) ? o : '') }))
      app.use('/api/*', loopbackGuard)
      Bun.serve({ hostname: HOST, port: boundPort, fetch: app.fetch })
      `,
      // The permissive default called by its new name is still the permissive default: naming
      // createLoopbackGuard is not the rule, passing allowedOrigins is.
      `
      import { createLoopbackGuard } from './loopback-guard.mjs'
      app.use('/api/*', createLoopbackGuard())
      Bun.serve({ port, fetch: app.fetch })
      `,
      // Binds a port and installs no guard at all.
      `
      const app = new Hono()
      app.get('/api/things', (c) => c.json([]))
      Bun.serve({ port: 7799, fetch: app.fetch })
      `,
    ],
    fixed: [
      // The shape both entry points now have.
      `
      import { apiOriginAllowlist } from './api-origins'
      import { createLoopbackGuard } from './loopback-guard.mjs'
      let allowedApiOrigins: string[] = []
      app.use('/api/*', createLoopbackGuard({ allowedOrigins: () => allowedApiOrigins }))
      allowedApiOrigins = apiOriginAllowlist(\`http://\${HOST}:\${boundPort}\`)
      Bun.serve({ hostname: HOST, port: boundPort, fetch: app.fetch })
      `,
      // A routes module hangs handlers on a shared app and binds nothing. Not an entry point, and
      // demanding a guard of it would be the false red that gets a check ignored.
      `
      import { app } from '../http-app'
      app.get('/api/sessions', async (c) => c.json(await listSessions()))
      app.post('/api/sessions/:id/done', async (c) => c.json({ ok: true }))
      `,
      // http-app.ts itself: builds the Hono app, serves nothing.
      `
      import { Hono } from 'hono'
      export const app = new Hono()
      `,
    ],
  },
  'test-stub-outlives-its-file.mjs': {
    broken: [
      // The tmp/audit2 probe shape (2026-09-05): fetch replaced at module scope, never put back, so
      // instance-pointer's findLiveInstance probed its own server through this fake and saw 0 hits.
      `
      import { expect, test } from 'bun:test'
      const calls: string[] = []
      globalThis.fetch = (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response('{}', { status: 200 })
      }) as typeof fetch
      test('refreshAll', async () => { expect(calls).toEqual([]) })
      `,
      // The request-generations shape before its fix: a module mocked for the whole run with no
      // re-mock, so resource-status (next in order) awaited a getQueue nothing would resolve.
      `
      import { beforeEach, describe, expect, mock, test } from 'bun:test'
      mock.module('../src/lib/api', () => ({ getQueue: () => new Promise(() => {}) }))
      const { useData } = await import('../src/composables/useData')
      test('x', () => { expect(useData).toBeTruthy() })
      `,
      // A before-hook stub is module scope by another name: it runs once and nothing undoes it.
      `
      import { beforeAll, expect, test } from 'bun:test'
      beforeAll(() => { globalThis.fetch = (async () => new Response('{}')) as typeof fetch })
      test('x', () => { expect(1).toBe(1) })
      `,
    ],
    fixed: [
      // resource-status.test.ts's shape: stubbed inside the test through a helper, restored in finally.
      `
      import { expect, test } from 'bun:test'
      function setFetch(fn: typeof fetch): void { globalThis.fetch = fn }
      test('x', async () => {
        const originalFetch = globalThis.fetch
        setFetch((async () => new Response('{}')) as typeof fetch)
        try { expect(1).toBe(1) } finally { globalThis.fetch = originalFetch }
      })
      `,
      // connections-sync.test.ts's shape: a module-scope stub with an afterAll that puts it back.
      `
      import { afterAll, expect, test } from 'bun:test'
      const realFetch = globalThis.fetch
      globalThis.fetch = (async () => new Response('{}')) as typeof fetch
      afterAll(() => { globalThis.fetch = realFetch })
      test('x', () => { expect(1).toBe(1) })
      `,
      // request-generations.test.ts after its fix: the real exports copied BEFORE the fake lands,
      // and the module re-mocked to that copy once the file is done.
      `
      import { afterAll, expect, mock, test } from 'bun:test'
      const realApi = { ...(await import('../src/lib/api')) }
      mock.module('../src/lib/api', () => ({ getQueue: () => new Promise(() => {}) }))
      afterAll(() => { mock.module('../src/lib/api', () => realApi) })
      test('x', () => { expect(1).toBe(1) })
      `,
      // A file that only TALKS about the hazard, the way tunnel.test.ts and monitor.test.ts do.
      `
      import { expect, test } from 'bun:test'
      // never mock.module('node:child_process') here: it is global for the whole run, and
      // globalThis.fetch = fake at module scope leaks the same way.
      test('x', () => { expect(1).toBe(1) })
      `,
    ],
  },
  'reka-popper-root-inside-tooltip.mjs': {
    broken: [
      // DropdownMenu wraps AROUND the IconTooltip, so DropdownMenuTrigger's nearest PopperRoot is
      // the tooltip's own and the menu's popper never gets anchored (the real SessionsView.vue bug,
      // fixed 2026-07-16: menu opened off-screen and, being modal, froze the whole app's pointer
      // events).
      `
      <DropdownMenu>
        <IconTooltip :label="$t('sessions.listOptions')">
          <span class="inline-flex">
            <DropdownMenuTrigger as-child>
              <button type="button"><MoreHorizontal /></button>
            </DropdownMenuTrigger>
          </span>
        </IconTooltip>
        <DropdownMenuContent align="end" class="w-56" />
      </DropdownMenu>
      `,
    ],
    fixed: [
      // The actual shape web/src/components/SessionsView.vue ships today: IconTooltip contains a
      // <span> anchor, which contains the whole DropdownMenu including its own trigger and content.
      `
      <IconTooltip :label="$t('sessions.listOptions')">
        <span class="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button type="button"><MoreHorizontal /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56" />
          </DropdownMenu>
        </span>
      </IconTooltip>
      `,
    ],
  },
  'spawn-console-window.mjs': {
    broken: [
      // Direction A: a console-subsystem program (powershell) spawned with no windowsHide at all.
      // invisible only by accident of how the daemon happens to be launched today; a terminal,
      // Explorer, or the compiled exe all get a real, visible console flash from this same call.
      `Bun.spawn(['powershell', '-Command', script])`,
      // Direction B: a GUI program (explorer) spawned WITH windowsHide. Bun's windowsHide sets
      // STARTUPINFO SW_HIDE, which a GUI app obeys, so this hides the very window the spawn exists
      // to open (measured 2026-07-16: plain opened 1 Explorer window, windowsHide opened 0).
      `Bun.spawn(['explorer', dir], { windowsHide: true })`,
    ],
    fixed: [
      `
      Bun.spawn(['powershell', '-Command', script], { windowsHide: true })
      Bun.spawn(['explorer', dir], { stdin: 'ignore' })
      `,
      // A spawn named only in PROSE. The scan is textual, so before comments were blanked this was
      // a finding: the shared kit's detached-spawn.mjs header explains which shell
      // spawn("powershell") resolves to, and syncing that comment in turned the whole suite red
      // against a file that contains no spawn call at all (2026-08-09).
      `
      // Windows PowerShell (powershell.exe, which spawn("powershell") resolves to) space-joins
      // -ArgumentList without quoting, so pre-quote each element.
      /* Bun.spawn(['powershell', '-Command', script]) */
      export function buildDetachedSpawn(platform, argv) { return { argv, detached: true } }
      `,
      // The inverse direction must survive the same treatment: a commented-out GUI spawn is not a
      // gui-hidden finding either.
      `// Bun.spawn(['explorer', dir], { windowsHide: true })`,
    ],
  },
  'spawn-test-without-timeout.mjs': {
    broken: [
      // Direction A: an inline spawn on the 5s default. The shape tests/launcher.test.ts:126 shipped.
      `test('a live cscript probe resolves the discovery', () => {
         const out = execFileSync('cscript', ['//NoLogo', probePath], { encoding: 'utf8' })
         expect(out.trim()).toBe('AgentHydra-Tray.ps1|1')
       })`,
      // Direction B: the spawn is TWO hops away, through module-level helpers. This is the exact
      // sessions-scan-cache.test.ts shape that actually failed CI, and the one an inline-only scan
      // reports as clean.
      `function child(body) {
         return JSON.parse(Bun.spawnSync([process.execPath, '-e', body]).stdout.toString())
       }
       function listOne(id) {
         return child('const { listSessions } = await import(S); console.log(1)')
       }
       test('a transcript is parsed into a scan-cache row', () => {
         expect(listOne('abc').title).toBe('first question')
       })`,
      // Direction C: the curried test.if(cond)(name, fn) form, which reads as bodyless — and
      // therefore as compliant — unless the second call span is the one examined.
      `test.if(process.platform === 'win32')('the runner escapes the daemon job', async () => {
         const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', q])
         expect((await new Response(proc.stdout).text()).trim()).toBe('WmiPrvSE.exe')
       })`,
      // Direction D: a lifecycle HOOK, which the check was blind to until 2026-08-12. This is
      // ReDesign's tray-launcher beforeAll verbatim in shape: 0.35s locally, 5057ms on
      // windows-latest, and it held that repo's daemon job red. A hook is the worse case because
      // bun blames the timeout on an unnamed test, so the failure does not name what caused it.
      `beforeAll(() => {
         cp.execFileSync('powershell', ['-NoProfile', '-File', createShortcut], { stdio: 'ignore' })
       })`,
      // Direction E: the same blindness one hop away, and per-hook rather than per-file.
      `function regenerate() {
         return execFileSync('powershell', ['-NoProfile', '-File', p], { stdio: 'ignore' })
       }
       beforeEach(() => {
         regenerate()
       })`,
    ],
    fixed: [
      // The same three, each stating an allowance. Any value counts; what matters is that it was
      // chosen rather than inherited.
      `test('a live cscript probe resolves the discovery', () => {
         const out = execFileSync('cscript', ['//NoLogo', probePath], { encoding: 'utf8' })
         expect(out.trim()).toBe('AgentHydra-Tray.ps1|1')
       }, 20_000)`,
      `function child(body) {
         return JSON.parse(Bun.spawnSync([process.execPath, '-e', body]).stdout.toString())
       }
       function listOne(id) {
         return child('const { listSessions } = await import(S); console.log(1)')
       }
       test(
         'a transcript is parsed into a scan-cache row',
         () => {
           expect(listOne('abc').title).toBe('first question')
         },
         SPAWNS_A_CHILD_BUN,
       )`,
      `test.if(process.platform === 'win32')('the runner escapes the daemon job', async () => {
         const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', q])
         expect((await new Response(proc.stdout).text()).trim()).toBe('WmiPrvSE.exe')
       }, 30000)`,
      // A hook states its allowance as the SECOND argument, not the third. Getting that wrong in
      // either direction is the whole risk in extending the rule to hooks: read it as third and
      // every compliant hook reads as broken.
      `beforeAll(() => {
         cp.execFileSync('powershell', ['-NoProfile', '-File', createShortcut], { stdio: 'ignore' })
       }, 60_000)`,
      `function regenerate() {
         return execFileSync('powershell', ['-NoProfile', '-File', p], { stdio: 'ignore' })
       }
       beforeEach(() => {
         regenerate()
       }, 20_000)`,
      // Precision, the half that keeps this check usable: a test that only NAMES a spawn, in a
      // comment and in a string it asserts against, is not a spawn. These tests embed PowerShell and
      // VBS source in template literals as a matter of course, and spawn-console-window.mjs already
      // shipped once reading a sentence as a call.
      `test('the adapter is a thin wrapper, not a re-inlined fork', () => {
         // was: asserted the old Bun.spawn(['powershell', ...]) hand-off inline.
         const ps = readFileSync(CREATE_SHORTCUT, 'utf8')
         expect(ps).toContain("execFileSync('cscript', ['//NoLogo'])")
       })`,
    ],
  },
  'timer-callback-can-kill-the-daemon.mjs': {
    broken: [
      // scheduler.ts as it shipped until 2026-08-30: a bare named callback whose function has no
      // try/catch anywhere in it, and whose first statement is a synchronous sqlite read.
      `
      function tick() {
        if (getSetting('scheduler_enabled') !== '1') return
        const next = db.query('select * from queue_items').get()
        if (next) void dispatchItem(next)
      }
      export function startScheduler() {
        timer = setInterval(tick, pollSeconds * 1000)
      }
      `,
      // monitor.ts's shape: it HAS a try/catch, but the settings read sits above it, and the
      // callback discards the promise with \`void\` so the rejection reaches the process handler.
      `
      async function tick(deps) {
        if (getSetting('monitor_enabled') !== '1') return
        try {
          await processRateLimited(deps)
        } catch (err) {
          console.error('monitor tick error:', err)
        }
      }
      export function startMonitor() {
        timer = setInterval(() => void tick(defaultDeps), MONITOR_POLL_MS)
      }
      `,
    ],
    fixed: [
      // The shape scheduler.ts ships today: the callback is a thin guarded wrapper.
      `
      function tick() {
        try {
          tickInner()
        } catch (err) {
          console.error('scheduler tick error:', err)
        }
      }
      function tickInner() {
        if (getSetting('scheduler_enabled') !== '1') return
      }
      export function startScheduler() {
        timer = setInterval(tick, pollSeconds * 1000)
      }
      `,
      // The shape monitor.ts ships today: every statement inside the try, AND a .catch() on the
      // promise the callback returns, so nothing can escape either way.
      `
      export function startMonitor() {
        timer = setInterval(() => {
          tick(defaultDeps).catch((err) => console.error('monitor tick error:', err))
        }, MONITOR_POLL_MS)
      }
      `,
      // A timer that discusses its own failure in prose must not read as one: comments and string
      // literals are blanked before the scan.
      `
      // A bare setInterval(tick, ms) here would be unguarded and could kill the daemon.
      const note = 'setInterval(tick, 1000) is the shape we do not want'
      `,
    ],
  },
  'transcript-index-born-stale.mjs': {
    broken: [
      // Direction A: a snapshot lifetime shorter than the sweep that fills it. 2000 is the literal
      // value that shipped: a sweep took ~9.5s, so the freshness test could never once be true and
      // the daemon rebuilt the index for as long as it ran.
      `const TTL_MS = 2000`,
      // Direction B: the timestamp threaded in from before the work, in the SHORTHAND spelling the
      // real code used. `at` here is a parameter captured at the top of the builder, so the snapshot
      // is born ~9.5s old — the defect itself, and the one a colon-only pattern reads as clean.
      `function finishIndex(files, at) {
         cache = { at, files }
         return files
       }`,
      // Direction B again, spelled out: same defect, named variable, no shorthand to hide behind.
      `cache = { at: startedAt, files: result }`,
      // Direction C: the "background" refresh that blocks. A sync sweep holds the event loop for its
      // whole duration, so deferring it by a turn changes nothing — /api/health measured 6.6s.
      `setTimeout(() => {
         try {
           buildTranscriptIndex()
         } finally {
           refreshing = false
         }
       }, 0)`,
    ],
    fixed: [
      // The shape the module ships today: a lifetime longer than a sweep, stamped at the moment the
      // snapshot became true, revalidated through the async coalesced builder.
      `const TTL_MS = 15_000
       function finishIndex(files) {
         cache = { at: performance.now(), files: result }
         return result
       }
       export function listTranscriptFiles(force = false) {
         if (!force && cache) {
           if (performance.now() - cache.at >= TTL_MS) void startIndexBuild()
           return cache.files
         }
         return buildTranscriptIndex()
       }`,
      // A setTimeout that defers something which is not a sweep is not this bug.
      `setTimeout(() => { refreshing = false }, 0)`,
      // Precision, the half that keeps the check usable: this module's own header narrates the exact
      // broken shapes above, in prose and in a fenced example. A comment cannot rebuild an index,
      // and spawn-console-window.mjs already shipped once reading a sentence as a call.
      `
      // with \`const TTL_MS = 2000\`, so the snapshot was stale on arrival:
      //     cache = { at, files }
      //     setTimeout(() => buildTranscriptIndex(), 0)
      /* const TTL_MS = 2000 */
      export const audit = { id: 'transcript-index-born-stale' }
      `,
    ],
  },
  'wmi-commandline-query-self-match.mjs': {
    broken: [
      // The needle lives inside the LIKE pattern of the querying powershell's OWN command line, so
      // the query always matches itself; this is the actual dispatch.ts isRunnerAlive() bug that
      // made reattach think every runner was alive forever, on every machine, silently.
      // (Built via CMD_LINE, never written as one contiguous word+keyword pair in this file's own
      // source: this check scans tests/**/*.ts too, and a literal occurrence here would flag this
      // very test file.)
      `
      function isRunnerAlive(id) {
        const filter = "${CMD_LINE} LIKE '%" + id + ".spec.json%'"
        return runPowershell(filter)
      }
      `,
    ],
    fixed: [
      `
      function isRunnerAlive(id) {
        const filter = "${CMD_LINE} LIKE '%" + id + ".spec.json%' AND ProcessId <> $PID"
        return runPowershell(filter)
      }
      `,
    ],
  },
  'catalog-row-provenance.mjs': {
    broken: [
      // Rule C, the aider shape as it shipped: an empty `dirs` and no `envVar`, so rootsFor()
      // returns zero candidates and the row cannot match on any machine, ever.
      `export const AGENT_TOOLS: AgentTool[] = [
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'Aider',
    dirs: [],
    format: null,
  },
]`,
      // Rule B: a marker that cannot be re-checked is worse than no marker, because it stops the
      // next reader looking.
      `export const AGENT_TOOLS: AgentTool[] = [
  {
    id: 'hermes',
    name: 'Hermes Agent',
    vendor: 'Nous Research',
    dirs: ['.hermes'],
    format: null,
    verified: 'trust me',
  },
]`,
      // Rule 0, aimed at the guardrail itself: a row shape parseRows cannot read must be reported,
      // never skipped in silence. `id:` here carries two spaces, which the strict row pattern
      // misses and the looser declared-count pattern still sees.
      `export const AGENT_TOOLS: AgentTool[] = [
  {
    id:  'zed',
    name: 'Zed',
    vendor: 'Zed Industries',
    dirs: ['.local/share/zed'],
    format: 'foreign',
  },
]`,
    ],
    fixed: [
      // What the three repaired rows actually look like: a real path, an opt-in row whose empty
      // dirs is legal because an envVar can still reach it, and a marker naming file and date.
      `export const AGENT_TOOLS: AgentTool[] = [
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'Aider',
    envVar: 'AIDER_DIR',
    dirs: ['.aider'],
    format: null,
    verified: 'Aider-AI/aider aider/main.py (2026-09-04)',
  },
  {
    id: 'opt-in-only',
    name: 'Opt In Only',
    vendor: 'Example',
    envVar: 'OPT_IN_DIR',
    dirs: [],
    format: null,
  },
  {
    // A leading comment between the brace and the id is the shape that broke the first parser.
    id: 'cowork',
    name: 'Claude Cowork',
    vendor: 'Anthropic',
    dirs: [
      '.config/Claude/local-agent-mode-sessions',
      'AppData/Roaming/Claude/local-agent-mode-sessions',
    ],
    format: 'claude',
  },
]`,
    ],
  },
}

// Checks that deliberately do NOT export findViolations, and why, asserted explicitly below rather
// than silently skipped, so dropping findViolations from a future check without updating this file
// fails loudly instead of quietly losing its regression net.
const EXEMPT_FROM_FIXTURES: Record<string, string> = {
  'kit-lib-type-drift.mjs':
    'diffs export sets across a WHOLE .mjs / .d.mts file PAIR, not a single text blob a ' +
    'findViolations(text) signature could take; its regression coverage is the run({ root }) ' +
    'assertion against the real repo tree, exercised for every check below.',
}

for (const file of CHECK_FILES) {
  describe(file, () => {
    // Set by the import test and read by every test after it in this describe block. bun:test runs
    // a describe block's tests sequentially by default, so this is never read before it is set.
    let mod: any

    test('imports cleanly, the exact failure mode a crashed check hides behind', async () => {
      // pathToFileURL, not a bare path: a raw Windows path is not a valid ESM specifier.
      mod = await import(pathToFileURL(join(CHECKS_DIR, file)).href)
      expect(mod).toBeTruthy()
    })

    test('exports a well-formed, gating audit', () => {
      expect(mod.audit).toBeTruthy()
      expect(typeof mod.audit.id).toBe('string')
      expect(mod.audit.id.length).toBeGreaterThan(0)
      expect(typeof mod.audit.title).toBe('string')
      expect(mod.audit.title.length).toBeGreaterThan(0)
      expect(mod.audit.gating).toBe(true)
    })

    test('audit.run resolves clean against the real repo root (the regression net)', async () => {
      const result = await mod.audit.run({ root: REPO_ROOT })
      expect(result.failed).toBe(false)
      expect(typeof result.report).toBe('string')
      expect(result.report.length).toBeGreaterThan(0)
    })

    if (file in EXEMPT_FROM_FIXTURES) {
      test(`does not export findViolations, exempt: ${EXEMPT_FROM_FIXTURES[file]}`, () => {
        expect(mod.findViolations).toBeUndefined()
      })
    } else {
      test('exports findViolations and has registered fixtures', () => {
        // A failure here means a new check landed with findViolations but nobody taught this file
        // its broken/fixed shape, exactly the silent-skip this file exists to prevent. Fix: add an
        // entry to FIXTURES_BY_FILE (or, if it truly has no single-text-blob shape, an entry to
        // EXEMPT_FROM_FIXTURES explaining why, same as kit-lib-type-drift.mjs above).
        expect(typeof mod.findViolations).toBe('function')
        expect(FIXTURES_BY_FILE[file]).toBeTruthy()
      })

      const fixtures = FIXTURES_BY_FILE[file]
      if (fixtures) {
        fixtures.broken.forEach((text, i) => {
          test(`findViolations fires on the broken fixture #${i}`, () => {
            expect(mod.findViolations(text).length).toBeGreaterThan(0)
          })
        })
        fixtures.fixed.forEach((text, i) => {
          test(`findViolations stays quiet on the fixed fixture #${i}`, () => {
            expect(mod.findViolations(text).length).toBe(0)
          })
        })
      }
    }
  })
}

// spawn-test-without-timeout.mjs can stand ITSELF down: a repo-wide `bun test --timeout N` means
// no test inherits the 5s default, so there is nothing to enforce. That is correct (RepoYeti shells
// out to git in nearly every test and solves it exactly that way, and this check reported 230
// violations there until it learned to look), but it is also a path that silently disables a
// guardrail — precisely the failure this file exists to catch. So it gets asserted in BOTH
// directions rather than trusted.
describe('spawn-test-without-timeout.mjs — repo-wide timeout stand-down', () => {
  const load = () => import(pathToFileURL(join(CHECKS_DIR, 'spawn-test-without-timeout.mjs')).href)

  const withRoot = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthydra-guardrail-'))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return dir
  }

  test('a --timeout in the test script stands the check down', async () => {
    const { audit, globalTimeoutMs } = await load()
    const root = withRoot({
      'package.json': JSON.stringify({ scripts: { test: 'bun test tests --timeout 20000' } }),
    })
    expect(globalTimeoutMs(root)).toBe(20000)
    const res = await audit.run({ root })
    expect(res.failed).toBe(false)
    expect(res.report).toContain('20000')
  })

  test('a [test] timeout in bunfig.toml does NOT stand it down - bun ignores that key', async () => {
    // This used to assert the opposite, and the opposite was a false stand-down. Bun 1.4.0 IGNORES
    // `timeout` under [test] entirely (measured 2026-08-21 in RepoYeti: a 6s test still dies at the
    // 5s default with it set), so believing it would switch this whole check off while the repo got
    // none of the protection it thought it had bought - a guardrail reporting clean because it was
    // told to stop looking. `setDefaultTimeout()` in a preload is out for the same reason and is
    // subtler: it applies when ONE file runs and silently stops the moment a second file joins the
    // invocation. The CLI flag is the only form that actually holds.
    const { globalTimeoutMs } = await load()
    const root = withRoot({
      'package.json': JSON.stringify({ scripts: { test: 'bun test' } }),
      'bunfig.toml': '[install]\nregistry = "x"\n\n[test]\ntimeout = 15000\n',
    })
    expect(globalTimeoutMs(root)).toBeNull()
  })

  test('no repo-wide timeout means the per-test rule still applies (this repo)', async () => {
    // The real guard: if AgentHydra ever gains a global --timeout, this flips and the check above
    // stops enforcing anything. That should be a deliberate, visible change, not a silent one.
    const { globalTimeoutMs } = await load()
    expect(globalTimeoutMs(REPO_ROOT)).toBeNull()
  })
})

test('at least one check was actually discovered and exercised above', () => {
  // Guards against the whole file above passing vacuously if CHECKS_DIR were ever empty or
  // misnamed: an empty for-loop registers zero tests and bun reports that as success, not failure.
  // A guardrail that cannot fail is not a guardrail, and neither is a suite with nothing in it.
  expect(CHECK_FILES.length).toBeGreaterThan(0)
})

// ── CASE-INSENSITIVE SELF-EXCLUSION ────────────────────────────────────────────────────────────
// The net above runs every audit against REPO_ROOT, which is derived from import.meta.dir — the
// SAME canonical spelling a check's own `import.meta.url` resolves to. So the two always agreed,
// and a case-sensitive self-comparison sailed through it.
//
// It did not sail through CI. `bun scripts/checks/wmi-commandline-query-self-match.mjs` uses
// process.cwd(), which carries whatever casing the invoker typed, while Bun canonicalises
// import.meta.url to the real on-disk spelling (Node echoes the typed one instead). On a checkout
// reached as `...\agenthydra\...` whose folder is really `AgentHydra`, the check stopped excluding
// itself and reported the two example queries in its own header — green under node, RED under bun,
// which is the runtime CI uses. Found 2026-08-30 by a local CI run.
//
// This pins the property the fix relies on: a differently-cased root must not change any verdict.
describe('checks survive a differently-cased repo root (Windows path identity)', () => {
  const files = CHECK_FILES
  for (const file of files) {
    test.skipIf(process.platform !== 'win32')(`${file} is casing-stable`, async () => {
      const mod = await import(pathToFileURL(join(CHECKS_DIR, file)).href)
      if (typeof mod.audit?.run !== 'function') return
      // Windows resolves both spellings to the same directory, so any difference in the verdict
      // is the check reasoning about the STRING rather than about the file.
      const lower = await mod.audit.run({ root: REPO_ROOT.toLowerCase() })
      const upper = await mod.audit.run({ root: REPO_ROOT })
      expect(lower.failed).toBe(upper.failed)
      expect(lower.failed).toBe(false)
    })
  }
})
