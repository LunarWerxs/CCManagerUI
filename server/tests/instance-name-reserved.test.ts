// server/tests/instance-name-reserved.test.ts — the two words an instance folder may not be called.
//
// `SessionSummary.instance` carries a folder NAME, except for two words that mean something else:
// 'default' is the regular non-isolated Claude Desktop (instance-sessions.ts stamps its chats with
// that literal string) and 'other' is the sessions filter's "no desktop instance" scope
// (sessions.ts). A folder taking one of those words collides with the meaning, and it does so
// SILENTLY — an instance called "default" makes its chats indistinguishable from the regular
// install's, so nothing downstream can say which account held a given conversation, and one called
// "other" can never be selected in the instance filter because that value already means the
// opposite. Neither is recoverable once the folder exists, so the refusal has to be at creation.
//
// createInstance() is validateInstanceName()'s only caller, so testing through it also pins that
// the refusal actually reaches the API (and therefore the create dialog, which just renders the
// server's message).

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from '../src/core/lifecycle'
import { instancesRoot } from '../src/core/paths'

// tests/setup.ts points AGENTHYDRA_INSTANCES_ROOT at a throwaway dir, so a create that WRONGLY
// succeeded would land there and not in the developer's real ~/.claude-instances.

describe('createInstance refuses the reserved sentinel names', () => {
  for (const name of ['default', 'other']) {
    test(`refuses "${name}", and creates no folder`, async () => {
      const result = await createInstance(name)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('reserved')
      // The refusal must happen BEFORE mkdir — a rejected create that still left the directory
      // behind would hand you the collision anyway, just without a row to explain it.
      expect(existsSync(join(instancesRoot(), name))).toBe(false)
    })

    test(`refuses "${name}" whatever the case, and however it is padded`, async () => {
      // Case matters because the collision is with a WORD. On Windows the folder name folds to the
      // sentinel and on POSIX it does not, so allowing "Default" would make the same folder break
      // on one machine and not the other.
      for (const variant of [
        name.toUpperCase(),
        `  ${name}  `,
        name[0]!.toUpperCase() + name.slice(1),
      ]) {
        const result = await createInstance(variant)
        expect(result.ok).toBe(false)
        expect(result.message).toContain('reserved')
      }
    })
  }
})

describe('createInstance does NOT over-refuse', () => {
  // The rule is about the whole name, not a substring. Refusing "default-work" or "otherwise"
  // would be its own bug — a guard that blocks legitimate names gets worked around, and then it
  // stops guarding anything.
  for (const name of ['default-work', 'otherwise']) {
    test(`creates "${name}", which merely contains a reserved word`, async () => {
      const result = await createInstance(name)
      expect(result.ok).toBe(true)
      expect(existsSync(join(instancesRoot(), name))).toBe(true)
    })
  }
})
