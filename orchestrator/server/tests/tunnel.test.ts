// server/tests/tunnel.test.ts - AH-19: a cloudflared child that dies AFTER reporting its URL used
// to go unreported. `proc.on('exit', ...)` only called onError while `!found`, so once a Quick
// Tunnel had scraped its `*.trycloudflare.com` URL, a later crash left remote.ts holding a stale
// URL forever (StatusPills.vue would keep showing an address nothing answers on).
//
// The fake child is injected via tunnel.ts's own `SpawnFn` parameter, not `mock.module` -
// `mock.module('node:child_process')` is global for the whole `bun test` run and would leak into
// switch.test.ts, which spawns real children through switch.ts (see tests/monitor.test.ts for the
// prior incident this avoided).

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { startTunnel } from '../src/tunnel.ts'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = () => true
}

function fakeSpawn(child: FakeChild) {
  return (() => child) as unknown as Parameters<typeof startTunnel>[3]
}

describe('tunnel: exit after readiness', () => {
  test('one ready callback, then the crash is reported as an outage, not silence', () => {
    const child = new FakeChild()
    const urls: string[] = []
    const errors: string[] = []
    startTunnel(
      7790,
      (u) => urls.push(u),
      (e) => errors.push(e),
      fakeSpawn(child),
    )

    child.stdout.emit('data', Buffer.from('https://blue-fox.trycloudflare.com'))
    expect(urls).toEqual(['https://blue-fox.trycloudflare.com'])
    expect(errors).toEqual([])

    // The connector dies on its own, well after it was ready.
    child.emit('exit', 1)
    expect(urls).toEqual(['https://blue-fox.trycloudflare.com']) // exactly one ready callback
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/exited unexpectedly.*after the tunnel was ready/i)
  })

  test('a late data chunk arriving after exit cannot resurrect a ready callback', () => {
    const child = new FakeChild()
    const urls: string[] = []
    const errors: string[] = []
    startTunnel(
      7791,
      (u) => urls.push(u),
      (e) => errors.push(e),
      fakeSpawn(child),
    )

    child.emit('exit', 1) // dies before ever reporting a URL
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/before the tunnel was ready/i)

    // A straggling stdout chunk from the now-dead process must not call onUrl.
    child.stdout.emit('data', Buffer.from('https://late-owl.trycloudflare.com'))
    expect(urls).toEqual([])
    expect(errors).toHaveLength(1) // no second report either
  })

  test('an intentional stop is not reported as an outage', () => {
    const child = new FakeChild()
    const urls: string[] = []
    const errors: string[] = []
    const handle = startTunnel(
      7792,
      (u) => urls.push(u),
      (e) => errors.push(e),
      fakeSpawn(child),
    )

    child.stdout.emit('data', Buffer.from('https://green-elk.trycloudflare.com'))
    handle.stop() // sets the "stopping" flag before the (fake) kill signal
    child.emit('exit', null) // the process actually going away, same as a real kill()

    expect(urls).toEqual(['https://green-elk.trycloudflare.com'])
    expect(errors).toEqual([])
  })
})
