// server/tests/orchestrator-kill-tree-unix.test.ts — audit AH-15: a timed-out toolbox run takes its
// whole process tree with it on Linux/macOS, not just the interpreter.
//
// Windows always had `taskkill /T`; the Unix branch was `proc.kill()` alone, so an actuator the
// script had spawned survived the deadline and kept the pipes open. These tests run only where the
// Unix branch runs; on Windows they are skipped and the Windows tree kill is covered by the
// toolbox's own taskkill discipline.
//
// On Linux the walk reads /proc and needs no `pgrep`: the CI container (oven/bun) ships neither
// pgrep nor ps, and with the pgrep-only walk the first version of these tests failed there exactly
// the way the bug they guard against fails - an empty tree, a surviving grandchild, and a route
// that hung on its pipe until the test's own timeout (2026-09-05).
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pythonBinary, runOrchestrator, unixDescendants } from '../src/orchestrator'

const unix = process.platform !== 'win32'
const hasPython = (() => {
  try {
    return (
      Bun.spawnSync([pythonBinary(), '--version'], { stdout: 'ignore', stderr: 'ignore' })
        .exitCode === 0
    )
  } catch {
    return false
  }
})()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return (e as { code?: string }).code !== 'ESRCH'
  }
  if (process.platform === 'linux') {
    // A killed process whose parent is gone is a ZOMBIE until PID 1 reaps it, and signal 0 still
    // "succeeds" on a zombie. Under systemd (a GitHub runner) that is instant; in a container
    // whose PID 1 is a plain shell or `sleep` it never happens, and the first run of this test
    // read a reaped-in-all-but-name grandchild as alive. State Z is dead for our purposes.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .charAt(0)
      if (state === 'Z') return false
    } catch {
      return false
    }
  }
  return true
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}

test.skipIf(!unix)(
  'unixDescendants lists a child and a grandchild, deepest first',
  async () => {
    // sh -> sleep: the shell is the child, its sleep the grandchild.
    const parent = Bun.spawn(['sh', '-c', 'sleep 30 & wait'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      await Bun.sleep(300)
      const tree = unixDescendants(parent.pid)
      expect(tree.length).toBeGreaterThanOrEqual(1)
      // Every listed pid is a live process we can see.
      for (const pid of tree) expect(alive(pid)).toBe(true)
      if (process.platform === 'linux') {
        // No `pgrep`, no `ps` on the PATH: the walk must answer from /proc alone.
        const savedPath = process.env.PATH
        process.env.PATH = '/nonexistent'
        try {
          expect(unixDescendants(parent.pid)).toEqual(tree)
        } finally {
          process.env.PATH = savedPath
        }
      }
    } finally {
      for (const pid of unixDescendants(parent.pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      parent.kill('SIGKILL')
    }
  },
  20_000, // a subprocess test names its budget (scripts/checks/spawn-test-without-timeout.mjs)
)

test.skipIf(!unix || !hasPython)(
  'a timed-out run kills the grandchild the script spawned, and the route still completes',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenthydra-orch-tree-'))
    writeFileSync(
      join(dir, 'orch.py'),
      [
        'import subprocess, sys, time',
        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])',
        'print(child.pid, flush=True)',
        'time.sleep(120)',
        '',
      ].join('\n'),
    )
    const started = Date.now()
    const r = await runOrchestrator({ script: 'chats', timeoutMs: 1500 }, { dir })
    if (!('stdout' in r)) throw new Error(`unexpected: ${JSON.stringify(r)}`)
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
    // The route came back close to the deadline: the drain did not hang on the grandchild's pipe.
    expect(Date.now() - started).toBeLessThan(15_000)
    const grandchild = Number.parseInt(r.stdout.trim(), 10)
    expect(Number.isFinite(grandchild)).toBe(true)
    expect(await waitGone(grandchild, 3000)).toBe(true)
  },
  30_000,
)

test.skipIf(unix)(
  'on Windows the Unix walk is not the path taken; it still answers without throwing',
  () => {
    expect(Array.isArray(unixDescendants(process.pid))).toBe(true)
  },
)
