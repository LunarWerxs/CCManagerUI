// server/tests/default-claude-dir.test.ts — which dir IS the regular, non-isolated Claude Desktop.
//
// Two callers depend on this one answer and they must never disagree (core/instances.ts):
//
//   quitInstance()     refuses to kill that profile without explicit confirmation — it is the
//                      user's real Claude Desktop and may have a live conversation in it.
//   buildInstanceRow() stamps CMInstance.isDefault, which is the ONLY way a session labelled
//                      'default' can be joined to an account (its row is named after its folder,
//                      "Claude", so nothing is ever literally called "default").
//
// Both failures are silent. A false negative lets an unconfirmed quit through AND leaves the
// sessions view unable to name the account. A false positive would refuse to quit an ordinary
// instance and put the wrong account's address on a chat. Neither throws, so only a test catches
// them — hence this file rather than a comment claiming the comparison is obviously right.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDefaultClaudeDir } from '../src/core/instances'
import { claudeUserDataDir, normalizePath } from '../src/core/paths'

// claudeUserDataDir() reads its env on every call, so the default profile can be relocated into a
// scratch dir for the duration of a test. The variable differs per platform because the resolution
// does (paths.ts): %APPDATA%\Claude, ~/Library/Application Support/Claude, $XDG_CONFIG_HOME/Claude.
const RELOCATE_VAR =
  process.platform === 'win32'
    ? 'APPDATA'
    : process.platform === 'darwin'
      ? 'HOME'
      : 'XDG_CONFIG_HOME'

const saved = process.env[RELOCATE_VAR]
const scratches: string[] = []

function relocateDefaultProfile(): string {
  const base = mkdtempSync(join(tmpdir(), 'ah-default-'))
  scratches.push(base)
  process.env[RELOCATE_VAR] = base
  return normalizePath(claudeUserDataDir())
}

afterEach(() => {
  if (saved === undefined) delete process.env[RELOCATE_VAR]
  else process.env[RELOCATE_VAR] = saved
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true })
})

describe('isDefaultClaudeDir', () => {
  test('says yes to the regular profile dir, whatever this platform calls it', () => {
    const defaultDir = relocateDefaultProfile()
    expect(isDefaultClaudeDir(defaultDir)).toBe(true)
  })

  test('says no to an isolated instance, including one sitting right beside it', () => {
    const defaultDir = relocateDefaultProfile()
    // A sibling folder, and one whose name merely CONTAINS the default's — a prefix/substring
    // comparison would call both of these the default install.
    expect(isDefaultClaudeDir(normalizePath(join(defaultDir, '..', '3claude')))).toBe(false)
    expect(isDefaultClaudeDir(`${defaultDir}-backup`)).toBe(false)
    expect(isDefaultClaudeDir(normalizePath(join(defaultDir, 'nested')))).toBe(false)
  })

  test('a folder literally named "default" is NOT the default install', () => {
    // The session LABEL is the string 'default'; the dir never is. Matching on the word rather
    // than on the path is the mistake this pins.
    const defaultDir = relocateDefaultProfile()
    expect(isDefaultClaudeDir(normalizePath(join(defaultDir, '..', 'default')))).toBe(false)
  })

  test('case and separators do not change the answer on Windows', () => {
    const defaultDir = relocateDefaultProfile()
    // normalizePath already folds both, so this pins that the comparison keeps agreeing with it
    // rather than reintroducing a raw === somewhere upstream.
    expect(isDefaultClaudeDir(defaultDir.toUpperCase())).toBe(process.platform === 'win32')
  })

  test('an empty or unrelated path is false, never a throw', () => {
    relocateDefaultProfile()
    expect(isDefaultClaudeDir('')).toBe(false)
    expect(isDefaultClaudeDir(normalizePath(join(tmpdir(), 'nothing-to-do-with-claude')))).toBe(
      false,
    )
  })
})
