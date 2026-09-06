// server/tests/proc-table-linux.test.ts — the Linux process table comes from /proc, not `ps`.
//
// Found 2026-09-05 by running the repo's CI leg in its own container: oven/bun ships neither `ps`
// nor `pgrep`, so every Unix enumeration answered "could not look", the delete guard (rightly)
// refused every removeInstance, and the timed-out-run tree kill missed its grandchild. GitHub's
// ubuntu runner has procps and hid all of it. Reading /proc has no such dependency.
import { expect, test } from 'bun:test'
import { linuxProcTable } from '../src/core/process'

test.skipIf(process.platform !== 'linux')(
  'the /proc table lists this process with its parent and command line, no ps needed',
  () => {
    const table = linuxProcTable()
    expect(table).not.toBeNull()
    const me = table?.find((r) => r.pid === process.pid)
    expect(me).toBeDefined()
    expect(me?.ppid).toBe(process.ppid)
    expect(me?.command.toLowerCase()).toContain('bun')
    // Every row is a live pid with a parent; kernel threads read as "[comm]", never blank.
    for (const row of table ?? []) {
      expect(row.pid).toBeGreaterThan(0)
      expect(row.ppid).toBeGreaterThanOrEqual(0)
      expect(row.command.length).toBeGreaterThan(0)
    }
  },
)

test.skipIf(process.platform === 'linux')(
  'off Linux the /proc table is null, so the callers fall back to ps',
  () => {
    expect(linuxProcTable()).toBeNull()
  },
)
