import { afterAll, expect, test } from 'bun:test'
import { useDashboard } from '../src/composables/useDashboard'
import { __setFetchForTests, type RulesData, type ScriptsData } from '../src/lib/api'

// AH-22: refreshAll() used to omit the rules and scripts slots, so the global "Refresh every
// reading" button (App.vue's refresh()) left Rules/Scripts showing stale, cached values even
// though RulesView.vue labels them "live, from the code". This drives the real composable
// against a fake server (never globalThis.fetch - see bunfig.toml's note on why that leaks
// across test files) and proves a visited rules/scripts slot is re-fetched on refreshAll().

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('refreshAll re-fetches rules and scripts once those views have been visited', async () => {
  const rulesV1: RulesData = {
    generatedAt: 1,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the real Rule field name (api.ts), not a thenable.
    sections: [{ title: 'Section', rules: [{ if: 'a', then: 'b', value: 'v1' }] }],
  }
  const scriptsV1: ScriptsData = {
    generatedAt: 1,
    scripts: [{ name: 'n1', kind: 'observe', summary: 's', detail: 'd', usage: 'u', exits: 'e' }],
  }
  const server: { rules: RulesData; scripts: ScriptsData; plan: unknown; accounts: unknown } = {
    rules: rulesV1,
    scripts: scriptsV1,
    plan: {
      generatedAt: 1,
      scanned: 0,
      complete: true,
      incompleteWhy: null,
      counts: {},
      chats: [],
    },
    accounts: {
      usageSource: 'live',
      activeAccounts: 0,
      measuredAccounts: 0,
      totalLogins: 0,
      accounts: [],
      useNext: [],
      moves: [],
      consoleStrays: [],
    },
  }
  const requests: string[] = []

  __setFetchForTests(async (input: RequestInfo | URL): Promise<Response> => {
    const path = typeof input === 'string' ? input : input.toString()
    requests.push(path)
    switch (path) {
      case '/api/data/rules':
        return jsonResponse(server.rules)
      case '/api/data/scripts':
        return jsonResponse(server.scripts)
      case '/api/data/plan':
        return jsonResponse(server.plan)
      case '/api/data/accounts':
        return jsonResponse(server.accounts)
      default:
        return jsonResponse({ error: `unhandled path ${path}` })
    }
  })
  afterAll(() => __setFetchForTests(null))

  const dash = useDashboard()

  // Simulate a user opening the Rules and Scripts views (RulesView.vue / ScriptsView.vue call
  // dash.loadRules()/loadScripts() on open), which is the precondition for the bug: only
  // *visited* slots are expected to refresh.
  await dash.loadRules()
  await dash.loadScripts()
  expect(dash.rules.data?.sections[0]?.rules[0]?.value).toBe('v1')
  expect(dash.scripts.data?.scripts[0]?.name).toBe('n1')

  requests.length = 0 // only count what refreshAll() itself issues from here on

  // The underlying rules/scripts config changes on the server between visits.
  server.rules = {
    generatedAt: 2,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the real Rule field name (api.ts), not a thenable.
    sections: [{ title: 'Section', rules: [{ if: 'a', then: 'b', value: 'v2' }] }],
  }
  server.scripts = {
    generatedAt: 2,
    scripts: [{ name: 'n2', kind: 'act', summary: 's', detail: 'd', usage: 'u', exits: 'e' }],
  }

  await dash.refreshAll()

  // The fix: refreshAll() must issue requests for every slot that has been loaded, rules and
  // scripts included, not just plan/accounts/chats/instances/suppressed.
  expect(requests).toContain('/api/data/rules')
  expect(requests).toContain('/api/data/scripts')
  // Slots never visited in this test must stay untouched by refreshAll().
  expect(requests).not.toContain('/api/data/chats')
  expect(requests).not.toContain('/api/data/instances')
  expect(requests).not.toContain('/api/data/suppressed')

  // And the composable's state reflects the fresh values, not the cached ones.
  expect(dash.rules.data?.sections[0]?.rules[0]?.value).toBe('v2')
  expect(dash.scripts.data?.scripts[0]?.name).toBe('n2')
})
