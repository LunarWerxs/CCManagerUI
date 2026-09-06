// server/tests/api-origins.test.ts - the browser-origin allowlist both local HTTP servers use.
//
// AH-11 asked for an exact-origin allowlist instead of "any loopback port". The first fix landed
// in index.ts only, and adversarial verification of that closure (2026-09-06) found
// instance-mode.ts still accepting any loopback origin, so a page on any other localhost port
// could drive instance create / open / quit. The expansion now lives in one module that both
// entry points call, and scripts/checks/local-api-origin-allowlist.mjs fails the build if a third
// local server appears without it. These cases pin what the list may and may not contain.
import { expect, test } from 'bun:test'
import { apiOriginAllowlist } from '../src/api-origins'

const noDev = {} as NodeJS.ProcessEnv

test('the bound origin and its other host spelling are allowed, and nothing else', () => {
  const allowed = apiOriginAllowlist('http://127.0.0.1:7787', noDev)
  expect(allowed).toContain('http://127.0.0.1:7787')
  expect(allowed).toContain('http://localhost:7787')
  expect(allowed).toHaveLength(2)
  // The whole point of AH-11: ANOTHER loopback port is a different origin and is not allowed.
  expect(allowed).not.toContain('http://127.0.0.1:7788')
  expect(allowed).not.toContain('http://localhost:3000')
  expect(allowed).not.toContain('http://evil.example')
})

test('a localhost-spelled binding gets the numeric spelling, not the other way round only', () => {
  const allowed = apiOriginAllowlist('http://localhost:5199', noDev)
  expect(new Set(allowed)).toEqual(new Set(['http://localhost:5199', 'http://127.0.0.1:5199']))
})

test('two servers on different ports never share an allowlist', () => {
  const daemon = apiOriginAllowlist('http://127.0.0.1:7787', noDev)
  const instances = apiOriginAllowlist('http://127.0.0.1:7799', noDev)
  for (const origin of instances) expect(daemon).not.toContain(origin)
})

test('AGENTHYDRA_DEV_ORIGINS adds the dev server, trimmed, and blanks are ignored', () => {
  const allowed = apiOriginAllowlist('http://127.0.0.1:7787', {
    AGENTHYDRA_DEV_ORIGINS: ' http://localhost:5173 , ,http://127.0.0.1:5173',
  } as NodeJS.ProcessEnv)
  expect(allowed).toContain('http://localhost:5173')
  expect(allowed).toContain('http://127.0.0.1:5173')
  expect(allowed).not.toContain('')
  expect(allowed).toHaveLength(4)
})

test('an unparseable own origin widens nothing', () => {
  expect(apiOriginAllowlist('not a url', noDev)).toEqual(['not a url'])
  expect(apiOriginAllowlist('', noDev)).toEqual([])
})

test('a non-default port and https are carried through as given', () => {
  const allowed = apiOriginAllowlist('https://localhost:8443', noDev)
  expect(new Set(allowed)).toEqual(new Set(['https://localhost:8443', 'https://127.0.0.1:8443']))
})
