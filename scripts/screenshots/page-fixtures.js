/**
 * Synthetic API, injected into the page before the SPA boots (see capture.mjs).
 *
 * This file is read as TEXT and evaluated in the browser — it is not imported as a module.
 *
 * Every string in here is invented. The README screenshots are public, so no session title,
 * account address, project name or filesystem path from a real machine may appear in them.
 * Stubbing `fetch` rather than pointing a daemon at a synthetic home directory is the stricter
 * option: no daemon runs, so there is nothing live to accidentally read. Anything that slips
 * through the route table is recorded in `window.__fixtureEscapes`, which capture.mjs asserts is
 * empty before it will keep the images.
 */
;(() => {
  const now = Date.now()
  const ago = (m) => now - m * 60000
  const iso = (m) => new Date(now - m * 60000).toISOString()

  const proj = (n) => `C:\\Projects\\${n}`
  const projKey = (n) => `C--Projects-${n}`

  // Where each provider's transcript actually lives, so the raw-file affordances in the UI line
  // up with the badge on the row. OpenCode and Hermes have no per-session file: each shares one
  // SQLite store across sessions, which is why their rows point at the database.
  const transcriptPath = (source, p, i) =>
    source === 'codex'
      ? `C:\\Users\\dev\\.codex\\sessions\\2026\\08\\04\\rollout-2026-08-04T09-14-22-s${i}.jsonl`
      : source === 'opencode'
        ? 'C:\\Users\\dev\\.local\\share\\opencode\\opencode.db'
        : source === 'hermes'
          ? 'C:\\Users\\dev\\AppData\\Local\\hermes\\state.db'
          : `C:\\Users\\dev\\.claude\\projects\\${projKey(p)}\\s${i}.jsonl`

  // A mixed list is the point of the shot: the app reads every provider, and the badge column is
  // the only thing that says so. The fields the server nulls out for non-Claude rows (instance,
  // queue_status, and git_branch for OpenCode/Hermes, neither of which parses repo metadata) are
  // nulled here too — a fixture that fills them would photograph a UI the daemon cannot produce.
  const sessions = [
    ['Refactor checkout validation', 'acme-storefront', 'main', 128, 2, 'work', 'claude'],
    ['Fix flaky upload test', 'atlas-api', 'main', 64, 18, null, 'codex'],
    [
      'Add pagination to search results',
      'acme-storefront',
      'feat/search',
      212,
      63,
      'personal',
      'claude',
    ],
    ['Friendlier parser error messages', 'pico-cli', 'feat/parser', 48, 184, null, 'opencode'],
    ['Audit log retention policy', 'atlas-api', 'main', 91, 300, 'research', 'claude'],
    ['Dark mode token pass', 'acme-storefront', 'main', 156, 480, 'personal', 'claude'],
    ['Rate limiter backoff', 'atlas-api', 'main', 73, 1500, 'work', 'claude'],
    ['Tidy up CLI help output', 'pico-cli', 'main', 39, 2900, 'work', 'claude'],
    ['Summarize the incident channel', 'atlas-api', 'main', 27, 4200, null, 'hermes'],
  ].map(([title, p, branch, count, mins, instance, source], i) => {
    const session_id = `s${i}0000000-0000-4000-8000-00000000000${i}`
    // The reader (source) and the product that wrote it (tool) coincide 1:1 for every fixture row
    // — none of these are a fork sharing another product's format — so the same string covers both.
    const tool = source === 'claude' ? 'claude-code' : source
    return {
      session_id,
      source,
      tool,
      // A fake but well-shaped locator (server/src/session-locator.ts): source+tool+storeKey+id,
      // base64url after 'v1:'. Nothing reads the storeKey back out of a fixture row, so the source
      // string stands in for it; the real server always derives this from the actual store.
      locator: `v1:${btoa(JSON.stringify([source, tool, source, session_id]))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')}`,
      title,
      cwd: proj(p),
      project: projKey(p),
      git_branch: source === 'opencode' || source === 'hermes' ? null : branch,
      message_count: count,
      // Span varies per row on purpose: every session sharing one duration made every shape chip
      // read "Marathon" in the screenshot, which is a fixture artefact that looked like a bug in the
      // classifier. The multiplier spreads them across quick/standard/deep instead.
      created_at: ago(mins + 4 + i * 55),
      last_activity_at: ago(mins),
      last_role: 'assistant',
      last_text_preview: 'Updated the module and re-ran the suite; everything passes locally.',
      size_bytes: count * 3200,
      transcript_path: transcriptPath(source, p, i),
      queue_status: null,
      instance: source === 'claude' ? instance : null,
      archived: false,
      done: i === 7,
      // Two rows carry the "queued here" marker so the shape chip in the screenshot shows both the
      // automation case and the ordinary one. Real dispatched-ness comes from a queue row (see
      // server/src/sessions.ts); here it is simply stated.
      dispatched: i === 3 || i === 6,
      // Only OpenCode reports subagent counts (server/src/sessions.ts collapseSubagents); none of
      // these rows stand for a fan-out, so zero is the honest value everywhere.
      subagent_count: 0,
      // None of these threads hit a rate-limit wall — a fabricated badge here would photograph a
      // state the sample data never earned.
      limit_stop: null,
      // Every row's title reads as a deliberately-set label in the screenshot, not an inferred one —
      // 'custom' is the source that means exactly that (see TitleSource in server/src/types.ts).
      title_source: 'custom',
      title_tag: null, // only used for title_source: 'envelope', which none of these rows are.
      copy_index: 1,
      copy_count: 1, // ordinary case: one transcript file per conversation, no interrupt/resume split.
      ended_because: null, // Claude-only marker for a superseded copy; none of these are superseded.
    }
  })
  /** The queue only ever holds `claude` runs, so its rows may only point at Claude sessions. */
  const claudeSessions = sessions.filter((s) => s.source === 'claude')

  const turns = [
    {
      role: 'user',
      kind: 'text',
      text: 'The checkout form accepts an empty postcode. Can you tighten the validation and add a test?',
      tool_name: null,
      timestamp: iso(9),
    },
    {
      role: 'assistant',
      kind: 'text',
      // Carries markdown on purpose: the transcript pane renders it now (web/src/lib/markdown.ts),
      // and a shot of plain prose would photograph a product feature that is not there. Still
      // entirely invented content.
      text: [
        'Found it: the postcode field is validated with a regex that allows an empty match, so a blank value passes.',
        '',
        '```ts',
        'const POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i',
        '// was: /^[A-Z0-9 ]*$/ — an empty string matched',
        '```',
        '',
        'Three changes:',
        '',
        '- tightened the pattern so a blank value cannot match',
        '- made the field **required** at the schema level, not only in the UI',
        '- added a case covering empty and whitespace-only inputs',
      ].join('\n'),
      tool_name: null,
      timestamp: iso(8),
    },
    {
      role: 'user',
      kind: 'text',
      text: 'Does that break the international addresses we allow?',
      tool_name: null,
      timestamp: iso(5),
    },
    {
      role: 'assistant',
      kind: 'text',
      text: 'No. The rule only rejects empty or whitespace-only values; the format check stays permissive for non-UK addresses, which is what the existing international tests assert. Full suite is green: 214 passed.',
      tool_name: null,
      timestamp: iso(4),
    },
  ]

  const instDir = (n) => `C:\\Users\\dev\\.claude-instances\\${n}`
  const account = (name, email, tier) => ({
    status: 'live',
    email,
    name,
    plan: tier.startsWith('Max') ? 'max' : 'pro',
    rateLimitTier: tier,
    planLabel: tier,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'live',
    label: `${name} <${email}> · ${tier}`,
  })
  const loggedOut = {
    status: 'loggedout',
    email: null,
    name: null,
    plan: null,
    rateLimitTier: null,
    planLabel: null,
    accountUuid: null,
    orgUuid: null,
    orgName: null,
    source: 'loggedout',
    label: '(not logged in)',
  }

  const instances = [
    {
      name: 'work',
      isRunning: true,
      pid: 8412,
      up: 214,
      mem: 2_684_354_560,
      account: account('Alex Rivera', 'alex@example.com', 'Max 20×'),
      icon: 'rocket',
      color: 'blue',
    },
    {
      name: 'personal',
      isRunning: true,
      pid: 6120,
      up: 51,
      mem: 1_476_395_008,
      account: account('Sam Chen', 'sam@example.com', 'Pro'),
      icon: 'heart',
      color: 'violet',
    },
    {
      name: 'research',
      isRunning: false,
      pid: null,
      up: null,
      mem: null,
      account: account('Dana Woods', 'dana@example.com', 'Max'),
      icon: 'flask',
      color: 'teal',
    },
    {
      name: 'ci-runner',
      isRunning: false,
      pid: null,
      up: null,
      mem: null,
      account: loggedOut,
      icon: 'bot',
      color: 'slate',
    },
  ].map((i) => ({
    name: i.name,
    dir: instDir(i.name),
    isRunning: i.isRunning,
    pid: i.pid,
    startTime: i.up == null ? null : iso(i.up),
    sizeBytes: null,
    memoryBytes: i.mem,
    account: i.account,
    isExternal: false,
    label: null,
    icon: i.icon,
    color: i.color,
  }))

  const snap = (pct, model) => ({
    account: null,
    session: { pct: Math.max(4, pct - 22), resets: 'in 2h 40m', limit: null, used: null },
    weekAll: { pct, resets: 'Sat 9:00am', limit: null, used: null },
    weekModel: model
      ? { pct: model, resets: 'Sat 9:00am', label: 'Opus', limit: null, used: null }
      : null,
    capturedAt: iso(3),
    source: 'api',
  })
  const noData = {
    account: null,
    session: null,
    weekAll: null,
    weekModel: null,
    capturedAt: iso(3),
    source: 'api',
  }
  /** Per instance, so the on-load refresh cannot stamp one number across every row. */
  const usageFor = (dir) => {
    const d = dir.toLowerCase()
    if (d.includes('work')) return snap(72, 55)
    if (d.includes('personal')) return snap(26, null)
    if (d.includes('research')) return snap(55, 31)
    return null
  }

  const usageCache = {
    cache: {
      [`desktop:${instDir('work').toLowerCase()}`]: snap(72, 55),
      [`desktop:${instDir('personal').toLowerCase()}`]: snap(26, null),
      [`desktop:${instDir('research').toLowerCase()}`]: snap(55, 31),
      'cli:cli-1': snap(41, null),
    },
    lastAutoRefreshAt: iso(3),
  }

  const queue = [
    ['Refactor checkout validation', 'acme-storefront', 'running'],
    ['Regenerate API client', 'atlas-api', 'queued'],
    ['Audit log retention policy', 'atlas-api', 'queued'],
    ['Dark mode token pass', 'acme-storefront', 'queued'],
    ['Tidy up CLI help output', 'pico-cli', 'completed'],
  ].map(([title, p, status], i) => ({
    id: `q${i}0000000-0000-4000-8000-00000000000${i}`,
    session_id: claudeSessions[i % claudeSessions.length].session_id,
    title,
    cwd: proj(p),
    prompt: 'resume',
    model: i % 2 ? 'sonnet' : 'opus',
    effort: i % 2 ? 'medium' : 'high',
    permission_mode: null,
    account_id: null,
    new_chat: false,
    fork: false,
    status,
    pid: status === 'running' ? 9004 : null,
    position: i + 1,
    started_at: status === 'running' ? iso(6) : status === 'completed' ? iso(120) : null,
    finished_at: status === 'completed' ? iso(112) : null,
    exit_code: status === 'completed' ? 0 : null,
    created_at: ago(200 - i * 10),
    // One scheduled item, so the drawer shows a "runs at" chip.
    not_before: i === 3 ? iso(-180) : null,
    instance_ref: null,
    retry_attempts: 0,
  }))

  const cliInstances = [
    {
      id: 'cli-1',
      name: 'sandbox (CLI)',
      configDir: 'C:\\Users\\dev\\.claude-cli\\sandbox',
      loggedIn: true,
      associatedAccountId: null,
      associatedAccountLabel: null,
      associatedDesktopDir: null,
      lastUsageCheck: null,
    },
  ]
  const codexInstances = [
    {
      id: 'codex-1',
      name: 'work (Codex)',
      codexHome: 'C:\\Users\\dev\\.agenthydra\\codex-instances\\codex-1',
      desktopUserDataDir: 'C:\\Users\\dev\\.agenthydra\\codex-instances\\codex-1\\desktop',
      isDesktopRunning: true,
      desktopPid: 48216,
      loggedIn: true,
      createdAt: ago(4_320),
    },
  ]

  const dirFromUsageUrl = (url) => {
    const m = url.match(/\/api\/instances\/([^/]+)\/usage/)
    try {
      return m ? decodeURIComponent(m[1]) : ''
    } catch {
      return m ? m[1] : ''
    }
  }

  const routes = [
    [
      /\/api\/sessions\/[^/]+\/tail/,
      () => ({
        session_id: sessions[0].session_id,
        title: sessions[0].title,
        cwd: sessions[0].cwd,
        events: turns,
      }),
    ],
    // --- analytics ------------------------------------------------------------------------------
    // Invented but internally consistent, the same rule the usage fixture follows: the per-model
    // costs sum to the headline, the per-day series sums to the same figure, and coverage is
    // complete so the screenshot never shows a half-warmed caveat as if it were the normal state.
    [
      /\/api\/analytics\/spend/,
      () => {
        const byModel = [
          {
            key: 'claude-opus-5',
            weighted: 812_000_000,
            costUsd: 214.4,
            sessions: 21,
            turns: 1840,
          },
          {
            key: 'claude-sonnet-5',
            weighted: 402_000_000,
            costUsd: 61.2,
            sessions: 14,
            turns: 1210,
          },
          { key: 'claude-haiku-4-5', weighted: 96_000_000, costUsd: 8.1, sessions: 6, turns: 430 },
        ]
        const total = byModel.reduce((n, m) => n + m.costUsd, 0)
        const days = 21
        const shape = (i) => 0.5 + Math.sin(i / 2.2) * 0.35 + (i % 7 === 0 ? -0.3 : 0)
        const raw = Array.from({ length: days }, (_, i) => Math.max(0.05, shape(i)))
        const sum = raw.reduce((n, v) => n + v, 0)
        const byDay = raw.map((v, i) => ({
          key: new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
          weighted: Math.round((v / sum) * 1_310_000_000),
          costUsd: Number(((v / sum) * total).toFixed(2)),
          sessions: 2,
          turns: 60,
        }))
        // The token split, shaped like a real store: cache reads dominate, fresh input is a sliver.
        // Internally consistent, so total is the sum of the four.
        const tokens = {
          input: 9_400_000,
          cacheRead: 1_180_000_000,
          cacheWrite: 41_000_000,
          output: 12_600_000,
          total: 0,
        }
        tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
        const slice = (f) => ({
          input: Math.round(tokens.input * f),
          cacheRead: Math.round(tokens.cacheRead * f),
          cacheWrite: Math.round(tokens.cacheWrite * f),
          output: Math.round(tokens.output * f),
          total: Math.round(tokens.total * f),
        })
        return {
          from: byDay[0].key,
          to: byDay[byDay.length - 1].key,
          totalCostUsd: total,
          totalWeighted: 1_310_000_000,
          tokens,
          // Four tools, because the shot's job is to show that the stats are not Claude-only.
          byProvider: [
            { key: 'claude', tokens: slice(0.68), sessions: 26, costUsd: 232.6 },
            { key: 'codex', tokens: slice(0.2), sessions: 11, costUsd: null },
            { key: 'opencode', tokens: slice(0.07), sessions: 4, costUsd: 4.1 },
            { key: 'hermes', tokens: slice(0.05), sessions: 2, costUsd: 2.3 },
          ],
          sessions: 43,
          byModel,
          byProject: [
            {
              key: proj('acme-storefront'),
              weighted: 690_000_000,
              costUsd: 148.7,
              sessions: 18,
              turns: 0,
            },
            {
              key: proj('atlas-api'),
              weighted: 430_000_000,
              costUsd: 96.3,
              sessions: 15,
              turns: 0,
            },
            { key: proj('pico-cli'), weighted: 190_000_000, costUsd: 38.7, sessions: 8, turns: 0 },
          ],
          byDay,
          byAccount: [
            { key: 'Alex Rivera', weighted: 740_000_000, costUsd: 162.4, sessions: 22, turns: 0 },
            { key: 'Sam Chen', weighted: 570_000_000, costUsd: 121.3, sessions: 19, turns: 0 },
          ],
          unpricedModels: [],
          coverage: { sessions: 41, total: 41, refreshing: false, bytes: 24_800 },
        }
      },
    ],
    [
      /\/api\/analytics\/activity/,
      () => ({
        // A working week: quiet overnight, busiest mid-afternoon, light at the weekend.
        hours: Array.from({ length: 168 }, (_, i) => {
          const day = Math.floor(i / 24)
          const hour = i % 24
          if (hour < 8 || hour > 21) return 0
          const weekday = day >= 1 && day <= 5 ? 1 : 0.25
          return Math.round(weekday * (14 - Math.abs(15 - hour) * 1.6) * 4)
        }),
        tools: [
          { key: 'Bash', count: 1840 },
          { key: 'Edit', count: 960 },
          { key: 'Read', count: 720 },
          { key: 'Grep', count: 410 },
          { key: 'Write', count: 260 },
          { key: 'Glob', count: 150 },
        ],
        agentMinutes: 5820,
        health: [
          {
            session_id: sessions[2].session_id,
            source: 'claude',
            project: proj('acme-storefront'),
            toolErrors: 14,
            toolErrorStreak: 5,
            edits: 62,
            compactions: 1,
          },
          {
            session_id: sessions[4].session_id,
            source: 'claude',
            project: proj('atlas-api'),
            toolErrors: 9,
            toolErrorStreak: 3,
            edits: 21,
            compactions: 0,
          },
        ],
        coverage: { sessions: 41, total: 41, refreshing: false, bytes: 24_800 },
      }),
    ],
    [
      /\/api\/analytics\/concurrency/,
      () => ({
        buckets: Array.from({ length: 56 }, (_, i) => ({
          at: Date.now() - (56 - i) * 3 * 3_600_000,
          sessions: Math.max(0, Math.round(3 + Math.sin(i / 4) * 2.4 + (i % 8 === 0 ? 2 : 0))),
        })),
      }),
    ],
    [
      /\/api\/analytics\/edits/,
      () => ({
        edits: [
          ['acme-storefront', 'src/checkout/postcode.ts'],
          ['acme-storefront', 'src/checkout/postcode.test.ts'],
          ['acme-storefront', 'src/theme/tokens.css'],
          ['atlas-api', 'internal/ratelimit/backoff.go'],
          ['atlas-api', 'internal/audit/retention.go'],
          ['pico-cli', 'cmd/help.go'],
        ].map(([p, rel], i) => ({
          session_id: sessions[i % sessions.length].session_id,
          source: 'claude',
          project: proj(p),
          // Windows separators, because the projects these fixtures describe are Windows paths and
          // the feed shows them verbatim.
          path: [proj(p), ...rel.split('/')].join('\\'),
          turn: 40 + i * 7,
          ts: Date.now() - i * 900_000,
        })),
      }),
    ],
    [/\/api\/analytics$/, () => ({ sessions: 41, total: 41, refreshing: false, bytes: 24_800 })],
    [
      // No secrets in the demo transcript, which is the honest fixture: the chip only appears when
      // there is something to report, so a screenshot showing one would advertise a state the
      // sample session is not in.
      /\/api\/sessions\/[^/]+\/secrets/,
      () => ({
        session_id: sessions[0].session_id,
        source: 'claude',
        count: 0,
        findings: [],
        truncated: false,
      }),
    ],
    [
      // Invented, but internally consistent: total is the sum of the four counts, and the dollar
      // figure is what those tokens actually come to at Opus 5's published rates (input 5, output
      // 25, cache read 0.5, 5-minute cache write 6.25, per million). A fixture that photographed
      // arithmetic the product cannot reproduce would be a lie in a public screenshot.
      /\/api\/sessions\/[^/]+\/usage/,
      () => ({
        session_id: sessions[0].session_id,
        source: 'claude',
        status: 'ok',
        tokens: {
          input: 41200,
          output: 18600,
          cacheRead: 3120000,
          cacheCreation: 96400,
          total: 3276200,
          turns: 42,
        },
        costUsd: 2.83,
        pricedModels: ['claude-opus-5'],
        unpricedModels: [],
        pricesAsOf: '2026-08-13',
      }),
    ],
    [/\/api\/sessions\/search/, () => []],
    [/\/api\/sessions/, () => sessions],
    [/\/api\/instances\/[^/]+\/account/, () => instances[0].account],
    [
      /\/api\/instances\/[^/]+\/usage/,
      (url) => {
        const dir = dirFromUsageUrl(url)
        const s = usageFor(dir)
        return {
          key: `desktop:${dir.toLowerCase()}`,
          snapshot: s ?? noData,
          reason: s ? 'ok' : 'logged_out',
        }
      },
    ],
    [/\/api\/instances/, () => instances],
    [
      /\/api\/cli-instances\/[^/]+\/usage/,
      () => ({ key: 'cli:cli-1', snapshot: snap(41, null), reason: 'ok' }),
    ],
    [/\/api\/cli-instances/, () => cliInstances],
    [/\/api\/codex-instances/, () => codexInstances],
    [/\/api\/usage\/cache/, () => usageCache],
    [/\/api\/usage/, () => ({ key: 'acct:1', snapshot: snap(72, 55), reason: 'ok' })],
    [/\/api\/queue/, () => queue],
    [
      /\/api\/scheduler/,
      () => ({ enabled: true, running: false, nextRunAt: null, intervalMin: 15 }),
    ],
    [/\/api\/settings\/sync/, () => ({ enabled: false, connected: false, email: null })],
    [
      /\/api\/settings/,
      () => ({
        autoRefresh: true,
        autoRefreshIntervalMin: 15,
        showDesktopInstances: true,
        showCliInstances: true,
        codexDesktopEnabled: true,
        codexCliEnabled: true,
        chatGptHandoffEnabled: true,
        transcriptEditor: '',
        transcriptEditorResolved: 'VS Code',
        theme: 'dark',
        tooltips: true,
      }),
    ],
    [
      /\/api\/desktop-install/,
      () => ({
        platform: 'win32',
        directPath: 'C:\\ok\\Claude.exe',
        msixDetected: false,
        msixSignals: [],
        manageable: true,
      }),
    ],
    [/\/api\/accounts/, () => []],
    // Both of these were escaping to a live daemon (the escape assertion has been failing the run
    // since these features landed). Empty is also the honest fixture: no mirrored UI preferences
    // means the shots use the app's defaults, and no reset events means no notification banner.
    [/\/api\/ui-prefs/, () => ({ prefs: {} })],
    [/\/api\/notifications\/events/, () => []],
    [/\/api\/monitor/, () => ({ accounts: [], enabled: false })],
    [/\/api\/update/, () => ({ status: 'idle', distribution: 'compiled' })],
  ]

  window.__fixtureEscapes = []

  // Mirrors server/src/headless-policy.ts: headlessRunsAllowed() is permanently false, so a real
  // queue-create is always refused with this exact shape (see server/src/routes/queue.ts ~line
  // 169). A fixture that answered 200 here would photograph a write the backend can never perform.
  // Text duplicated rather than imported — this file is evaluated as a browser string, not a
  // module — so if the owner-law message in headless-policy.ts ever changes, update it here too.
  const NO_HEADLESS_REASON =
    'no-headless: AgentHydra does not run chats you cannot see (owner law, 2026-08-27, restated ' +
    '2026-08-31 - there is no setting for this). Continue this thread in its desktop app, or land ' +
    'it in one via import. Nothing was run.'

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'POST' && /\/api\/queue\/?($|\?)/.test(url)) {
      return new Response(JSON.stringify({ error: NO_HEADLESS_REASON }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/')) {
      for (const [pattern, build] of routes) {
        if (pattern.test(url)) {
          return new Response(JSON.stringify(build(url)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      // No fixture matched. Answer emptily rather than letting it hit a real daemon, and record
      // it so the capture fails loudly instead of quietly shipping whatever a live API returned.
      window.__fixtureEscapes.push(url)
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  }

  // The queue drawer opens an EventSource for live runs; keep it inert rather than erroring.
  window.EventSource = class {
    constructor() {
      this.readyState = 0
    }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
})()
