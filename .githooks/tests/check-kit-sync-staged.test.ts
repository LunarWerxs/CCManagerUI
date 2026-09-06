// .githooks/tests/check-kit-sync-staged.test.ts - AH-24: the kit-sync pre-commit guard must check
// BOTH intentionally vendored UI kit targets, agenthydra and orchestrator. Before the fix,
// .githooks/pre-commit invoked check-kit-sync-staged.mjs with only "agenthydra", so drift staged
// under the orchestrator target went straight through a commit uncaught. The fix added a second
// invocation line (`node .githooks/check-kit-sync-staged.mjs orchestrator || exit 1`); nothing
// exercised the HOOK ITSELF until this file - the guard script has no caller anywhere else in the
// test suite.
//
// This drives the real, on-disk `.githooks/pre-commit` and `.githooks/check-kit-sync-staged.mjs`
// (read fresh at test time, never duplicated by hand - a future revert of the second invocation
// line is read straight into the sandbox and fails this test) against a disposable git repo with a
// stub `lunarwerx-ui/sync.mjs` standing in for the kit. It never touches this repo's own git index:
// this working tree routinely has other agent sessions with files staged of their own, so the only
// safe way to prove a pre-commit hook's behavior is a throwaway repo, never `git add`/`git commit`
// here.
//
// Revert check: comment out the "orchestrator" line in .githooks/pre-commit and both tests below
// fail - "still fails the commit" no longer throws (the drift silently passes), and the call-log
// assertion in both tests sees only "agenthydra".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK_TEST_TIMEOUT = 20_000 // real git init/commit + two node subprocesses; ~1s locally

const REPO_ROOT = join(import.meta.dir, '..', '..')
const REAL_PRECOMMIT = join(REPO_ROOT, '.githooks', 'pre-commit')
const REAL_GUARD = join(REPO_ROOT, '.githooks', 'check-kit-sync-staged.mjs')

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: HOOK_TEST_TIMEOUT },
  )
}

interface CommitResult {
  status: number
  output: string
}

function commit(repo: string): CommitResult {
  try {
    const output = git(repo, 'commit', '-m', 'test')
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * A stub standing in for lunarwerx-ui/sync.mjs's `--check --app <app>` behavior: reports one
 * "differs" line for `driftedApp` only (mirroring the real report format check-kit-sync-staged.mjs
 * parses), exiting non-zero exactly when it reports drift - matching --check's real contract. Every
 * invocation is appended to calls.log so a test can prove BOTH app arguments were actually asked,
 * not just that the one which happens to drift was caught.
 */
function writeStub(kitDir: string, driftedApp: string | null, offenderPath: string): void {
  const posixPath = offenderPath.replace(/\\/g, '/')
  const lines = [
    "import { appendFileSync } from 'node:fs'",
    "const app = process.argv[process.argv.indexOf('--app') + 1]",
    "appendFileSync(new URL('./calls.log', import.meta.url), app + '\\n')",
    `if (app === ${JSON.stringify(driftedApp)}) {`,
    `  console.log('  ! differs  ${posixPath}')`,
    '  process.exit(1)',
    '}',
    'process.exit(0)',
    '',
  ]
  writeFileSync(join(kitDir, 'sync.mjs'), lines.join('\n'))
}

function callsLog(kitDir: string): string[] {
  try {
    return readFileSync(join(kitDir, 'calls.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

describe('.githooks/pre-commit: the kit-sync guard covers both vendored targets (AH-24)', () => {
  let sandbox: string
  let repo: string
  let kit: string
  let offender: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'ah24-hook-'))
    repo = join(sandbox, 'repo')
    kit = join(sandbox, 'lunarwerx-ui')
    mkdirSync(join(repo, '.githooks'), { recursive: true })
    mkdirSync(kit, { recursive: true })

    // Byte-identical copies of the REAL hook files, read fresh every run.
    writeFileSync(join(repo, '.githooks', 'pre-commit'), readFileSync(REAL_PRECOMMIT))
    writeFileSync(join(repo, '.githooks', 'check-kit-sync-staged.mjs'), readFileSync(REAL_GUARD))
    chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755) // git on POSIX refuses a non-executable hook

    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'core.hooksPath', '.githooks')

    const offenderDir = join(repo, 'orchestrator', 'server', 'src')
    mkdirSync(offenderDir, { recursive: true })
    offender = join(offenderDir, 'drifted.ts')
    writeFileSync(offender, 'export const x = 1\n')
    git(repo, 'add', '.')
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  test(
    'drift reported only under the orchestrator target still fails the commit',
    () => {
      writeStub(kit, 'orchestrator', offender)

      const result = commit(repo)
      expect(result.status).not.toBe(0)
      expect(result.output).toContain(offender.replace(/\\/g, '/'))

      // Both targets were actually asked - the orchestrator invocation is not merely present in
      // the shell script's text, it ran.
      expect(callsLog(kit)).toEqual(['agenthydra', 'orchestrator'])
    },
    HOOK_TEST_TIMEOUT,
  )

  test(
    'no drift under either target passes the commit',
    () => {
      writeStub(kit, null, offender)

      const result = commit(repo)
      expect(result.status).toBe(0)
      expect(git(repo, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
      expect(callsLog(kit)).toEqual(['agenthydra', 'orchestrator'])
    },
    HOOK_TEST_TIMEOUT,
  )
})
