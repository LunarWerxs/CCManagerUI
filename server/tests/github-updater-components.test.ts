// server/tests/github-updater-components.test.ts — audit AH-08: a compiled update brings the
// release-owned sidecars (orchestrator/, misc/) to the release's exact content, carries user state
// across, removes retired files, and rolls back as a unit.
//
// Reproduced 2026-09-05 with a synthetic release against a disposable install: the updater swapped
// the executable and overlaid misc/, but orchestrator/old-payload.txt stayed, new-payload.txt never
// arrived, and misc/obsolete-component.txt survived. Everything here runs on scratch directories;
// no real install, release or process is touched.
import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  installedComponentVersion,
  RELEASE_COMPONENTS,
  RELEASE_VERSION_FILE,
  reconcileComponent,
  rollbackComponents,
  swapComponent,
} from '../src/github-updater'

const ORCH = RELEASE_COMPONENTS.find((c) => c.name === 'orchestrator')!
const MISC = RELEASE_COMPONENTS.find((c) => c.name === 'misc')!

function put(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function fixture(): { root: string; bundle: string; install: string } {
  const root = mkdtempSync(join(tmpdir(), 'ah-components-'))
  const bundle = join(root, 'bundle', 'AgentHydra-9.9.9-windows-x64')
  const install = join(root, 'install')
  // The release ships the toolbox and the tray toolkit.
  put(bundle, 'orchestrator/orch.py', 'new driver')
  put(bundle, 'orchestrator/scripts/lib/hydralib.py', 'new lib')
  put(bundle, 'orchestrator/new-payload.txt', 'new')
  put(bundle, 'misc/lunarwerx-tray.exe', 'new tray')
  put(bundle, 'misc/new-component.txt', 'new')
  // The install has an OLD toolbox with live state, and a retired sidecar in misc/.
  put(install, 'AgentHydra.exe', 'old exe')
  put(install, 'orchestrator/orch.py', 'old driver')
  put(install, 'orchestrator/old-payload.txt', 'old')
  put(install, 'orchestrator/state/holds.json', '{"held":["abc"]}')
  put(install, 'orchestrator/state/trash/abc/manifest.json', '{}')
  put(install, 'misc/lunarwerx-tray.exe', 'old tray')
  put(install, 'misc/obsolete-component.txt', 'retired')
  return { root, bundle, install }
}

test('a swap brings orchestrator/ to the release content, keeps state, removes retired files, stamps the version', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const aside = swapComponent(bundle, install, ORCH, 'stamp1', '9.9.9', output)
    expect(aside).not.toBeNull()
    const o = join(install, 'orchestrator')
    expect(readFileSync(join(o, 'orch.py'), 'utf8')).toBe('new driver')
    expect(existsSync(join(o, 'new-payload.txt'))).toBe(true)
    expect(existsSync(join(o, 'old-payload.txt'))).toBe(false) // retired, gone by construction
    expect(readFileSync(join(o, 'state/holds.json'), 'utf8')).toBe('{"held":["abc"]}') // carried
    expect(existsSync(join(o, 'state/trash/abc/manifest.json'))).toBe(true)
    expect(installedComponentVersion(install, 'orchestrator')).toBe('9.9.9')
    // The previous copy sits aside for rollback until the caller discards it.
    expect(existsSync(aside!.aside)).toBe(true)
    expect(readFileSync(join(aside!.aside, 'old-payload.txt'), 'utf8')).toBe('old')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed swap leaves the previous copy exactly where it was, state included', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    // The aside rename succeeds; putting the NEW copy in place fails (a lock, a full disk), and
    // the copy fallback fails with it, which is what a real EBUSY on the destination does.
    const failing = () => {
      throw new Error('EBUSY: injected')
    }
    expect(() =>
      swapComponent(bundle, install, ORCH, 'stamp2', '9.9.9', output, { move: failing }),
    ).toThrow('EBUSY')
    const o = join(install, 'orchestrator')
    expect(readFileSync(join(o, 'orch.py'), 'utf8')).toBe('old driver')
    expect(existsSync(join(o, 'old-payload.txt'))).toBe(true)
    expect(readFileSync(join(o, 'state/holds.json'), 'utf8')).toBe('{"held":["abc"]}')
    expect(existsSync(join(o, 'new-payload.txt'))).toBe(false)
    expect(readdirSync(install).filter((n) => n.includes('.old-'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rollbackComponents restores the aside copy after a later step failed', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const aside = swapComponent(bundle, install, ORCH, 'stamp3', '9.9.9', output)!
    // ...the exe swap then fails; the caller rolls the components back.
    rollbackComponents(install, [aside])
    const o = join(install, 'orchestrator')
    expect(readFileSync(join(o, 'orch.py'), 'utf8')).toBe('old driver')
    expect(existsSync(join(o, 'old-payload.txt'))).toBe(true)
    expect(existsSync(join(o, 'state/holds.json'))).toBe(true)
    expect(existsSync(aside.aside)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bare-executable install acquires the toolbox through an update', () => {
  const { root, bundle, install } = fixture()
  try {
    rmSync(join(install, 'orchestrator'), { recursive: true, force: true })
    const output: string[] = []
    const aside = swapComponent(bundle, install, ORCH, 'stamp4', '9.9.9', output)
    expect(aside).toBeNull() // nothing to roll back to
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('new driver')
    expect(installedComponentVersion(install, 'orchestrator')).toBe('9.9.9')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bundle that ships no orchestrator/ keeps the installed one untouched', () => {
  const { root, bundle, install } = fixture()
  try {
    rmSync(join(bundle, 'orchestrator'), { recursive: true, force: true })
    const output: string[] = []
    expect(swapComponent(bundle, install, ORCH, 'stamp5', '9.9.9', output)).toBeNull()
    expect(readFileSync(join(install, 'orchestrator/orch.py'), 'utf8')).toBe('old driver')
    expect(output.join('\n')).toContain('ships no orchestrator/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reconcile brings misc/ to the release content and removes the retired sidecar', () => {
  const { root, bundle, install } = fixture()
  try {
    const output: string[] = []
    const r = reconcileComponent(bundle, install, MISC, '9.9.9', output)
    expect(r.installed).toBe(true)
    const m = join(install, 'misc')
    expect(readFileSync(join(m, 'lunarwerx-tray.exe'), 'utf8')).toBe('new tray')
    expect(existsSync(join(m, 'new-component.txt'))).toBe(true)
    expect(existsSync(join(m, 'obsolete-component.txt'))).toBe(false)
    expect(r.removed).toEqual(['obsolete-component.txt'])
    expect(r.locked).toEqual([])
    expect(installedComponentVersion(install, 'misc')).toBe('9.9.9')
    // Idempotent: a second pass changes nothing and removes nothing.
    const again = reconcileComponent(bundle, install, MISC, '9.9.9', [])
    expect(again.removed).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the version stamp reads null on an install that predates stamping', () => {
  const { root, install } = fixture()
  try {
    expect(installedComponentVersion(install, 'orchestrator')).toBeNull()
    expect(RELEASE_VERSION_FILE).toBe('.release-version')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// install.ps1 (the manual install, audit AH-40) carries its own component list in PowerShell. It
// must name exactly what the self-updater swaps, or a manual install and an in-app update would
// disagree about what a release IS. Parsed from the script rather than declared twice by hand.
test('install.ps1 and the self-updater agree on the release components', () => {
  const script = readFileSync(resolve(import.meta.dir, '../../install.ps1'), 'utf8')
  const block = script.slice(script.indexOf('$ReleaseComponents = @('))
  const names = [...block.slice(0, block.indexOf(')')).matchAll(/Name = '([A-Za-z]+)'/g)].map(
    (m) => m[1],
  )
  expect(new Set(names)).toEqual(new Set(['exe', ...RELEASE_COMPONENTS.map((c) => c.name)]))
})
