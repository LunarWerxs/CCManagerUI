// The daemon-side seam onto the Python orchestrator (server/src/orchestrator.ts).
//
// Two halves. The PURE half - the invocation grammar, the exit-code meanings, the dir and python
// resolution - is pinned exactly, because it is the whole security story: a menu name is the only
// thing that can reach `python orch.py`, and arguments travel as an argv array. The SPAWN half is
// exercised through an injected fake so the suite never needs python or a fleet, plus one real run
// of the interpreter (skipped where none is installed) proving the argv actually lands unquoted.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TIMEOUT_MS,
  DRIVER_EXIT_MEANINGS,
  defaultDeadline,
  exitMeaning,
  LONG_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  orchestratorDir,
  orchestratorStatus,
  pythonBinary,
  runOrchestrator,
  runOriginAllowed,
  validateInvocation,
} from '../src/orchestrator'

describe('validateInvocation - the only grammar that reaches orch.py', () => {
  test('a menu name with string args and the default deadline', () => {
    const r = validateInvocation({ script: 'chats', args: ['--instance', 'pap3r rotate'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.invocation).toEqual({
        script: 'chats',
        args: ['--instance', 'pap3r rotate'],
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
    }
  })

  test('driver words are menu names too', () => {
    for (const w of ['loop', 'armed', 'arm', 'disarm'])
      expect(validateInvocation({ script: w }).ok).toBe(true)
  })

  test.each([
    ['', 'required'],
    ['../orch', 'not a menu name'],
    ['chats; rm -rf /', 'not a menu name'],
    ['Chats', 'not a menu name'],
    ['scripts/chats.py', 'not a menu name'],
  ])('refuses script %j', (script, why) => {
    const r = validateInvocation({ script })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(why)
  })

  test('args must be an array of NUL-free strings', () => {
    expect(validateInvocation({ script: 'chats', args: 'x' }).ok).toBe(false)
    expect(validateInvocation({ script: 'chats', args: [1] }).ok).toBe(false)
    expect(validateInvocation({ script: 'chats', args: ['a\0b'] }).ok).toBe(false)
    expect(validateInvocation({ script: 'chats', args: null }).ok).toBe(true)
  })

  test('the deadline is clamped to the ceiling and must be positive', () => {
    const big = validateInvocation({ script: 'loop', timeoutMs: 10 * MAX_TIMEOUT_MS })
    expect(big.ok && big.invocation.timeoutMs).toBe(MAX_TIMEOUT_MS)
    expect(validateInvocation({ script: 'loop', timeoutMs: 0 }).ok).toBe(false)
    expect(validateInvocation({ script: 'loop', timeoutMs: 'soon' }).ok).toBe(false)
  })
})

describe('runOriginAllowed - the run route takes no Origin or exactly its own', () => {
  const self = 'http://127.0.0.1:7789/api/orchestrator/run'
  test('no Origin (curl, tray, an MCP client) is allowed', () => {
    expect(runOriginAllowed(undefined, self)).toBe(true)
    expect(runOriginAllowed('', self)).toBe(true)
  })
  test('the daemon’s own origin is allowed, byte for byte', () => {
    expect(runOriginAllowed('http://127.0.0.1:7789', self)).toBe(true)
  })
  test.each([
    'http://127.0.0.1:5173', // another loopback PORT - same-site to Fetch, not same-origin
    'http://localhost:7789', // same port, different host spelling
    'https://127.0.0.1:7789', // scheme
    'http://evil.example', // cross-site
    'null', // opaque origin (sandboxed iframe, file://)
    'not a url',
  ])('%s is refused', (origin) => {
    expect(runOriginAllowed(origin, self)).toBe(false)
  })
})

describe('resolution', () => {
  test('the toolbox is the sibling folder unless the env points elsewhere', () => {
    expect(orchestratorDir({})).toMatch(/[\\/]orchestrator$/)
    expect(orchestratorDir({ AGENTHYDRA_ORCHESTRATOR_DIR: ' D:/elsewhere ' })).toBe('D:/elsewhere')
  })

  test('python on Windows, python3 elsewhere, env wins', () => {
    expect(pythonBinary({}, 'win32')).toBe('python')
    expect(pythonBinary({}, 'linux')).toBe('python3')
    expect(pythonBinary({}, 'darwin')).toBe('python3')
    expect(pythonBinary({ AGENTHYDRA_PYTHON: '/opt/py/bin/python3.12' }, 'win32')).toBe(
      '/opt/py/bin/python3.12',
    )
  })

  test("the driver's exit codes read as verdicts", () => {
    expect(DRIVER_EXIT_MEANINGS[0]).toBe('ok')
    expect(DRIVER_EXIT_MEANINGS[3]).toContain('not armed')
  })
})

/** A toolbox with a driver that can be spawned - or not - depending on the test. */
function fakeToolbox(withDriver = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-'))
  if (withDriver) writeFileSync(join(dir, 'orch.py'), '# fake driver\n')
  return dir
}

describe('runOrchestrator - argv in, verdict out', () => {
  test('refuses before spawning when the toolbox is missing', async () => {
    const dir = fakeToolbox(false)
    let spawned = false
    const r = await runOrchestrator(
      { script: 'chats' },
      {
        dir,
        spawn: async () => {
          spawned = true
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
    )
    expect(spawned).toBe(false)
    expect('error' in r && r.error).toContain('no orch.py')
  })

  test('spawns python orch.py <script> <args...> in the toolbox dir and reports the code', async () => {
    const dir = fakeToolbox()
    const seen: { command: string[]; cwd: string; timeoutMs: number }[] = []
    const r = await runOrchestrator(
      { script: 'migrate_chat', args: ['Odin', '--to', '3claude', '--stop-idle'], timeoutMs: 5000 },
      {
        dir,
        python: 'py-fake',
        spawn: async (command, cwd, timeoutMs) => {
          seen.push({ command, cwd, timeoutMs })
          return { code: 3, stdout: 'REFUSED', stderr: '', timedOut: false }
        },
      },
    )
    expect(seen).toEqual([
      {
        command: ['py-fake', 'orch.py', 'migrate_chat', 'Odin', '--to', '3claude', '--stop-idle'],
        cwd: dir,
        timeoutMs: 5000,
      },
    ])
    expect('ok' in r && r.ok).toBe(false)
    if ('exitCode' in r) {
      expect(r.exitCode).toBe(3)
      // A delegated script's 3 is ITS OWN code (migrate_chat: bad usage) - never the driver's
      // "not armed". Only the driver's words carry the driver's meanings.
      expect(r.exitMeaning).toBeNull()
      expect(r.stdout).toBe('REFUSED')
      expect(r.timedOut).toBe(false)
    }
  })

  test("the driver's own words carry the driver's exit meanings; everyone shares 0 = ok", () => {
    expect(exitMeaning('armed', 3)).toContain('not armed')
    expect(exitMeaning('loop', 2)).toContain('failed')
    expect(exitMeaning('migrate_chat', 3)).toBeNull()
    expect(exitMeaning('chats', 0)).toBe('ok')
    expect(exitMeaning('chats', null)).toBeNull()
  })

  test('an acting fleet pass gets the long deadline whichever tool asked for it', () => {
    expect(defaultDeadline('loop', ['--live'])).toBe(LONG_TIMEOUT_MS)
    expect(defaultDeadline('sweep', ['--all', '--yes'])).toBe(LONG_TIMEOUT_MS)
    expect(defaultDeadline('loop', [])).toBe(DEFAULT_TIMEOUT_MS)
    expect(defaultDeadline('chats', [])).toBe(DEFAULT_TIMEOUT_MS)
    const v = validateInvocation({ script: 'loop', args: ['--live'] })
    expect(v.ok && v.invocation.timeoutMs).toBe(LONG_TIMEOUT_MS)
  })

  test('the same script cannot be started twice at once; a different one can', async () => {
    const dir = fakeToolbox()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = async () => {
      await gate
      return { code: 0, stdout: 'done', stderr: '', timedOut: false }
    }
    const first = runOrchestrator({ script: 'sweep' }, { dir, spawn: slow })
    const second = await runOrchestrator({ script: 'sweep' }, { dir, spawn: slow })
    expect('busy' in second && second.busy).toBe(true)
    expect('error' in second && second.error).toContain('already running')
    const other = await runOrchestrator(
      { script: 'chats' },
      { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
    )
    expect('ok' in other && other.ok).toBe(true)
    release()
    const done = await first
    expect('ok' in done && done.ok).toBe(true)
    const third = await runOrchestrator(
      { script: 'sweep' },
      { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) },
    )
    expect('ok' in third && third.ok).toBe(true)
  })

  test('a timed-out run is never ok, whatever the code says', async () => {
    const dir = fakeToolbox()
    const r = await runOrchestrator(
      { script: 'loop' },
      { dir, spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: true }) },
    )
    expect('ok' in r && r.ok).toBe(false)
    if ('timedOut' in r) expect(r.timedOut).toBe(true)
  })

  test('a spawn that cannot start is an error, not a crash', async () => {
    const dir = fakeToolbox()
    const r = await runOrchestrator(
      { script: 'census' },
      {
        dir,
        spawn: async () => {
          throw new Error('ENOENT python')
        },
      },
    )
    expect('error' in r && r.error).toContain('ENOENT')
  })

  // A fake driver answering all three probes: --version, the bare menu, and --catalog. `catalog`
  // is exactly what `orch.py --catalog` prints, so a test can hand it malformed output.
  const fakeDriver =
    (catalog: { code?: number; stdout: string; stderr?: string }) => async (command: string[]) => {
      if (command[1] === '--version')
        return { code: 0, stdout: 'Python 3.14.0\n', stderr: '', timedOut: false }
      if (command[2] === '--catalog')
        return {
          code: catalog.code ?? 0,
          stdout: catalog.stdout,
          stderr: catalog.stderr ?? '',
          timedOut: false,
        }
      return { code: 0, stdout: '  OBSERVE\n    chats  ...\n', stderr: '', timedOut: false }
    }

  const CATALOG_JSON = JSON.stringify({
    chats: { kind: 'observe', summary: 'OBSERVE: every chat.', invocation: 'direct' },
    archive_chat: { kind: 'mutate', summary: 'ACT: archive ONE chat.', guards: ['hold', 'force'] },
  })

  test('status reads the menu AND the action catalog through the same spawn', async () => {
    const dir = fakeToolbox()
    const s = await orchestratorStatus({
      dir,
      python: 'py-fake',
      spawn: fakeDriver({ stdout: CATALOG_JSON }),
    })
    expect(s.present).toBe(true)
    expect(s.pythonVersion).toBe('Python 3.14.0')
    expect(s.menu).toContain('chats')
    expect(s.error).toBeNull()
    // AH-25: the same list as DATA, so no consumer has to parse the prose above.
    expect(s.actionsError).toBeNull()
    expect(Object.keys(s.actions ?? {}).sort()).toEqual(['archive_chat', 'chats'])
    expect(s.actions?.archive_chat?.kind).toBe('mutate')
    expect(s.actions?.archive_chat?.guards).toEqual(['hold', 'force'])
  })

  // The three ways --catalog can fail to answer. In every one of them the toolbox is HEALTHY: the
  // prose menu came back, so `error` must stay null and only `actionsError` may fill in. Folding
  // these into `error` would make an older-but-working driver read as a broken install.
  const catalogFailures = [
    [
      'a driver too old to know --catalog',
      { code: 2, stdout: '', stderr: 'unknown option' },
      /exited 2/,
    ],
    [
      'output that is not JSON at all',
      { stdout: 'orchestrator - one entry point.\n' },
      /did not print JSON/,
    ],
    ['JSON that is not an object', { stdout: '["chats","archive_chat"]' }, /not an object/],
  ] as const

  for (const [name, catalog, expected] of catalogFailures) {
    test(`${name} leaves the toolbox healthy and says WHY the catalog is missing`, async () => {
      const s = await orchestratorStatus({
        dir: fakeToolbox(),
        python: 'py-fake',
        spawn: fakeDriver(catalog),
      })
      expect(s.menu).toContain('chats')
      expect(s.error).toBeNull()
      expect(s.actions).toBeNull()
      expect(s.actionsError).toMatch(expected)
    })
  }

  test('an unread toolbox reports WHY, so "not read" never reads as "it has no actions"', async () => {
    const s = await orchestratorStatus({
      dir: join(tmpdir(), 'agenthydra-orch-absent-on-purpose'),
      python: 'py-fake',
      spawn: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    })
    expect(s.present).toBe(false)
    expect(s.actions).toBeNull()
    expect(s.actionsError).toContain('no orch.py under')
  })

  test('the catalog is not a dispatch allowlist: a script missing from it still runs', async () => {
    // orch.py resolves a script name against the FILES under scripts/ on purpose, so a new script
    // works before its catalog row exists. If the daemon ever starts gating on `actions`, this
    // test is what says so.
    const dir = fakeToolbox()
    const r = await runOrchestrator(
      { script: 'brand_new_script' },
      { dir, spawn: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }) },
    )
    expect('ok' in r && r.ok).toBe(true)
  })
})

// The one real spawn: prove the argv lands in python UNQUOTED (a space inside one arg stays one
// arg). Skipped where the interpreter is not installed - the fake-spawn tests above cover the
// seam itself. 20s: a cold CI runner starting an interpreter has been measured well over 5s.
const hasPython = (() => {
  try {
    return (
      Bun.spawnSync([pythonBinary(), '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
      }).exitCode === 0
    )
  } catch {
    return false
  }
})()

test.skipIf(!hasPython)(
  'a real python sees each arg intact, spaces and all',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-real-'))
    writeFileSync(join(dir, 'orch.py'), 'import sys, json\nprint(json.dumps(sys.argv[1:]))\n')
    const r = await runOrchestrator(
      { script: 'chats', args: ['--instance', 'pap3r rotate'], timeoutMs: 15_000 },
      { dir },
    )
    expect('stdout' in r && JSON.parse(r.stdout)).toEqual(['chats', '--instance', 'pap3r rotate'])
    expect('ok' in r && r.ok).toBe(true)
  },
  20_000,
)

// AH-25, against the REAL driver rather than a fake. Every test above proves the daemon handles
// whatever `--catalog` prints; only this one proves the driver in this repo actually prints it.
// A fake-spawn suite alone would stay green through a rename of the flag, a driver that lost the
// subcommand, or a catalog that stopped being JSON - the whole failure this closes.
test.skipIf(!hasPython || !existsSync(join(orchestratorDir(), 'orch.py')))(
  'the real orch.py --catalog parses, and every row carries a kind and a summary',
  async () => {
    const s = await orchestratorStatus({})
    expect(s.actionsError).toBeNull()
    const actions = s.actions ?? {}
    expect(Object.keys(actions).length).toBeGreaterThan(5)
    for (const [name, row] of Object.entries(actions)) {
      expect(['observe', 'mutate']).toContain(row.kind)
      expect(typeof row.summary === 'string' && row.summary.length > 0).toBe(true)
      // The prose menu and the data must describe the same toolbox, or a consumer that moved off
      // the text is reading a different fleet from the one a person sees.
      expect(s.menu).toContain(name)
    }
  },
  60_000,
)
