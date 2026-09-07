import type {
  Account,
  ActivityReport,
  AgentPresence,
  AnalyticsCoverage,
  ArchivedScope,
  AuthType,
  ChatGptContextPack,
  CliInstance,
  CMAccount,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  CodexAccount,
  CodexInstance,
  CodexResetRedeemResult,
  ConcurrencyPoint,
  DispatchedScope,
  EditEntry,
  EffortLevel,
  Incident,
  IncidentState,
  InstanceColorKey,
  InstanceIconKey,
  MonitorSettings,
  MonitorView,
  NotificationSettings,
  NotifyDeliveryResult,
  PermissionMode,
  PortableModeSettings,
  PortableWindowResult,
  ProjectSummary,
  ProviderSettings,
  QueueItem,
  RateLimitScope,
  ResetEvent,
  RunCost,
  RunEvent,
  SchedulerState,
  SearchIndexStatus,
  SessionPeriod,
  SessionSearchResponse,
  SessionSecretScan,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
  SessionUsage,
  SpendReport,
  SyncStatus,
  TailResult,
  TranscriptSettings,
  UpdateApplyResult,
  UpdateStatus,
  UsageCheckResult,
  UsageSettings,
  UsageSnapshot,
} from '@agenthydra/server/types'

export type {
  Account,
  ActivityReport,
  AgentPresence,
  AnalyticsCoverage,
  ArchivedScope,
  AuthType,
  ChatGptContextPack,
  CliInstance,
  CMAccount,
  CMAccountStatus,
  CMActionResult,
  CMDesktopInstall,
  CMInstance,
  CodexAccount,
  CodexAccountStatus,
  CodexAuthMode,
  CodexInstance,
  CodexResetRedeemResult,
  CodexResetRedeemStatus,
  ConcurrencyPoint,
  DispatchedScope,
  EditEntry,
  EffortLevel,
  Incident,
  IncidentState,
  InstanceColorKey,
  InstanceIconKey,
  MonitorSettings,
  MonitorStateName,
  MonitorStatusRow,
  MonitorView,
  NotificationSettings,
  NotifyDeliveryResult,
  PermissionMode,
  PortableModeSettings,
  PortableWindowResult,
  ProjectSummary,
  ProviderSettings,
  QueueItem,
  QueueStatus,
  RateLimitScope,
  ResetEvent,
  ResetKind,
  RunEvent,
  SchedulerState,
  SearchIndexStatus,
  SearchPath,
  SessionEnding,
  SessionPeriod,
  SessionSearchResponse,
  SessionSearchResult,
  SessionSecretScan,
  SessionSource,
  SessionSourceScope,
  SessionSummary,
  SessionUsage,
  SessionUsageStatus,
  SpendBucket,
  SpendReport,
  SyncStatus,
  TailEvent,
  TailResult,
  TitleSource,
  TokenBreakdown,
  TranscriptSettings,
  UpdateApplyResult,
  UpdateStatus,
  UsageAdvice,
  UsageCheckResult,
  UsageLimit,
  UsageReason,
  UsageSettings,
  UsageSeverity,
  UsageSnapshot,
  UsageSource,
} from '@agenthydra/server/types'
// Value re-export: the curated icon/color key sets that drive the instance appearance pickers
// (single source of truth, also validated server-side). See lib/instance-appearance.ts.
export {
  INSTANCE_COLOR_KEYS,
  INSTANCE_ICON_KEYS,
  INSTANCE_LABEL_MAX,
} from '@agenthydra/server/types'

// Prod bundles are served by the daemon itself, so same-origin relative URLs follow the
// daemon to whatever port it actually bound (the port-hop). Dev (Vite on :5173) still needs
// the absolute API origin; VITE_API_BASE overrides both.
export const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? '' : 'http://localhost:7787')

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

// --- analytics ---------------------------------------------------------------
// Read-only aggregates over the per-session totals the daemon warms in the background. Every one
// carries a `coverage` block; the view shows it rather than drawing a chart that quietly describes
// half the store.
export const getSpend = (period: SessionPeriod = '30d') =>
  j<SpendReport>(`/api/analytics/spend?period=${period}`)
export const getActivity = (period: SessionPeriod = '30d') =>
  j<ActivityReport>(`/api/analytics/activity?period=${period}`)
export const getConcurrency = (period: SessionPeriod = '30d', bucketMinutes = 180) =>
  j<{ buckets: ConcurrencyPoint[] }>(
    `/api/analytics/concurrency?period=${period}&bucketMinutes=${bucketMinutes}`,
  )
export const getRecentEdits = (limit = 200) =>
  j<{ edits: EditEntry[] }>(`/api/analytics/edits?limit=${limit}`)
export const getAnalyticsStatus = () => j<AnalyticsCoverage>('/api/analytics')
/** Which coding agents are installed here — including ones whose conversations we cannot read yet.
 *  Listing those is the point: silence would read as "AgentHydra looked and found nothing". */
export const getAgentTools = () => j<{ tools: AgentPresence[] }>('/api/agent-tools')
export const refreshAnalytics = () =>
  j<{ scanned: number; skipped: number; failed: number; budgetExhausted: boolean }>(
    '/api/analytics/refresh',
    {
      method: 'POST',
    },
  )
export const deleteAnalytics = () =>
  j<AnalyticsCoverage & { ok: boolean }>('/api/analytics', { method: 'DELETE' })
/** What one queued run cost. Computed on demand, never stored — see server/src/session-usage.ts. */
export const getRunCost = (id: string) => j<RunCost>(`/api/queue/${encodeURIComponent(id)}/cost`)

// --- sessions ---------------------------------------------------------------
export const getSessions = (
  limit = 200,
  instance = '',
  archived: ArchivedScope = 'hide',
  period: SessionPeriod = '24h',
  source: SessionSourceScope = 'all',
  dispatched: DispatchedScope = 'all',
  rateLimited: RateLimitScope = 'all',
) =>
  j<SessionSummary[]>(
    `/api/sessions?limit=${limit}${instance ? `&instance=${encodeURIComponent(instance)}` : ''}` +
      `${archived === 'hide' ? '' : `&archived=${archived}`}&period=${period}` +
      `${source === 'all' ? '' : `&source=${source}`}` +
      `${dispatched === 'all' ? '' : `&dispatched=${dispatched}`}` +
      `${rateLimited === 'all' ? '' : `&ratelimited=${rateLimited}`}`,
  )
/** Every folder with conversations in it, for a "where has work happened" overview. */
export const getSessionProjects = () => j<ProjectSummary[]>('/api/sessions/projects')
export const getSession = (id: string, source: SessionSource, locator?: string) =>
  j<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}${sourceQuery(source, locator)}`)
/** Set the user's own "done" mark on a session (distinct from Claude Desktop's read-only
 *  `archived` flag). Mark only: never affects which sessions getSessions() returns. */
// `locator` (audit AH-35), alongside `source`: two products sharing a format (Kilo/MiMo Code,
// both `opencode`; two Hermes profiles) can hold the same session id, and `source` alone cannot
// tell the server which one a caller means. Every function below takes it optionally — a row
// without one (an older cache, a synthetic test fixture) falls back to source+id exactly as
// before, which is what the server-side route does too.
const sourceQuery = (source: SessionSource, locator?: string) =>
  `?source=${source}${locator ? `&locator=${encodeURIComponent(locator)}` : ''}`

export const setSessionDone = (
  id: string,
  source: SessionSource,
  done: boolean,
  locator?: string,
) =>
  j<{ session_id: string; source: SessionSource; done: boolean }>(
    `/api/sessions/${encodeURIComponent(id)}/done${sourceQuery(source, locator)}`,
    {
      method: 'POST',
      body: JSON.stringify({ done }),
    },
  )
/** Browser download URL for the raw transcript (save-as copy). API_BASE prefix: this
 *  URL lands in a plain <a href>, which unlike j() would otherwise resolve against the
 *  Vite dev origin instead of the daemon. */
export const sessionFileUrl = (id: string, source: SessionSource, locator?: string) =>
  `${API_BASE}/api/sessions/${encodeURIComponent(id)}/file${sourceQuery(source, locator)}`
/** Get the original transcript's absolute path on the daemon's machine. */
export const getSessionFileLocation = (id: string, source: SessionSource, locator?: string) =>
  j<{ path: string }>(
    `/api/sessions/${encodeURIComponent(id)}/file-location${sourceQuery(source, locator)}`,
  )
/** Open the transcript on the daemon's machine with the OS default handler. */
export const openSessionFile = (id: string, source: SessionSource, locator?: string) =>
  j<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(id)}/open-file${sourceQuery(source, locator)}`,
    { method: 'POST' },
  )
/** Put the transcript FILE (not its text) on the clipboard of the daemon's machine, named after the
 *  session. The browser cannot do this — no ClipboardItem type maps to a native file-drop — so it's
 *  a daemon round-trip. `reason: 'unsupported'` comes back on Linux, which has no such convention. */
export const copySessionFile = (id: string, source: SessionSource, locator?: string) =>
  j<{ ok: boolean; filename?: string; reason?: string }>(
    `/api/sessions/${encodeURIComponent(id)}/copy-file${sourceQuery(source, locator)}`,
    { method: 'POST' },
  )
/** Download URL for a readable export. A plain <a href> like sessionFileUrl above, so it carries
 *  the API_BASE prefix; the daemon sets the filename via content-disposition. */
export const sessionExportUrl = (
  id: string,
  source: SessionSource,
  format: 'markdown' | 'html',
  thinking = false,
  locator?: string,
) =>
  `${API_BASE}/api/sessions/${encodeURIComponent(id)}/export?source=${source}&format=${format}` +
  `${thinking ? '&thinking=1' : ''}${locator ? `&locator=${encodeURIComponent(locator)}` : ''}`
/** Open a terminal sitting in this session (`claude --resume <id>`). Always returns the command
 *  line, working launch or not, so the copy fallback is never unavailable. */
export const resumeSessionInTerminal = (id: string, source: SessionSource, locator?: string) =>
  j<{ ok: boolean; command: string; reason?: string }>(
    `/api/sessions/${encodeURIComponent(id)}/resume-terminal${sourceQuery(source, locator)}`,
    { method: 'POST' },
  )
/** What credentials this session printed, as a count and a REDACTED list. There is no reveal
 *  parameter on the daemon and there should not be one — see server/src/session-export.ts. */
export const getSessionSecrets = (id: string, source: SessionSource, locator?: string) =>
  j<SessionSecretScan>(
    `/api/sessions/${encodeURIComponent(id)}/secrets${sourceQuery(source, locator)}`,
  )
/** Token totals and a dollar cost for one session, computed on demand from its transcript.
 *  Never throws for an unsupported provider — the result carries a `status` saying why it is
 *  empty, which the UI shows instead of an unexplained zero. */
export const getSessionUsage = (id: string, source: SessionSource, locator?: string) =>
  j<SessionUsage>(`/api/sessions/${encodeURIComponent(id)}/usage${sourceQuery(source, locator)}`)
export const getTail = (
  id: string,
  source: SessionSource,
  opts: { limit?: number; textOnly?: boolean; thinking?: boolean; humanOnly?: boolean } = {},
  locator?: string,
) => {
  const flag = (on: boolean | undefined) => (on ? '1' : '0')
  return j<TailResult>(
    `/api/sessions/${id}/tail?limit=${opts.limit ?? 40}&textOnly=${flag(opts.textOnly)}` +
      `&thinking=${flag(opts.thinking)}&humanOnly=${flag(opts.humanOnly)}&source=${source}` +
      `${locator ? `&locator=${encodeURIComponent(locator)}` : ''}`,
  )
}
/** Advanced BODY search: streams every transcript's raw content server-side (substring or
 *  regex, optionally case-sensitive). Deliberately separate from getSessions() above (slower,
 *  opt-in, and never used by the default fast client-side filter).
 *
 *  Returns a response, not a bare list: the search runs under a wall-clock budget, so the caller
 *  has to be able to tell "nothing matched" from "we ran out of time". */
export const searchSessionBodies = (
  query: string,
  opts: {
    regex?: boolean
    caseSensitive?: boolean
    instance?: string
    source?: SessionSource
    /** Force the exhaustive scan: every transcript in full, tool output included. Slower, and the
     *  only way to match text inside a tool result or in the middle of a word. */
    everything?: boolean
  } = {},
) =>
  j<SessionSearchResponse>(
    `/api/sessions/search?q=${encodeURIComponent(query)}` +
      `${opts.regex ? '&regex=1' : ''}` +
      `${opts.caseSensitive ? '&case=1' : ''}` +
      `${opts.instance ? `&instance=${encodeURIComponent(opts.instance)}` : ''}` +
      `${opts.source ? `&source=${opts.source}` : ''}` +
      `${opts.everything ? '&everything=1' : ''}`,
  )

// --- search index -----------------------------------------------------------
/** The conversation index behind the fast search path. It stores no text of its own and rebuilds
 *  itself from the transcripts, so deleting it loses nothing but the time to build it again. */
export const getSearchIndex = () => j<SearchIndexStatus>('/api/search-index')
export const deleteSearchIndex = () =>
  j<SearchIndexStatus & { ok: boolean }>('/api/search-index', { method: 'DELETE' })

// --- accounts ---------------------------------------------------------------
export const getAccounts = () => j<Account[]>('/api/accounts')
export const createAccount = (b: { label: string; auth_type: AuthType; secret: string }) =>
  j<Account>('/api/accounts', { method: 'POST', body: JSON.stringify(b) })
export const deleteAccount = (id: string) =>
  j<{ ok: boolean }>(`/api/accounts/${id}`, { method: 'DELETE' })

// --- queue ------------------------------------------------------------------
/** `instance_ref` value meaning "deliberately unpinned — run on the ambient CLI login", as opposed
 *  to an absent/null ref, which means "nobody said" and auto-resolves to the session's own desktop
 *  instance. Mirrors AMBIENT_RUN_AS in server/src/types.ts. */
export const AMBIENT_RUN_AS = 'ambient'
export interface NewQueueItem {
  session_id?: string
  title: string
  cwd: string
  prompt: string
  model?: string | null
  effort?: EffortLevel | null
  permission_mode?: PermissionMode | null
  account_id?: string | null
  /** Run under a signed-in instance's login: 'desktop:<dir>' or 'cli:<id>' (see server types.ts).
   *  OMIT (or null) on a resume to let the server pin the session's OWN desktop instance;
   *  AMBIENT_RUN_AS opts out of that and runs on the ambient CLI login. */
  instance_ref?: string | null
  new_chat: boolean
  fork: boolean
  /** ISO timestamp; the scheduler won't auto-dispatch before this. */
  not_before?: string | null
}
export const getQueue = () => j<QueueItem[]>('/api/queue')
export const createQueueItem = (b: NewQueueItem) =>
  j<QueueItem>('/api/queue', { method: 'POST', body: JSON.stringify(b) })
export const updateQueueItem = (id: string, patch: Partial<QueueItem>) =>
  j<QueueItem>(`/api/queue/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteQueueItem = (id: string) =>
  j<{ ok: boolean }>(`/api/queue/${id}`, { method: 'DELETE' })
export const runQueueItem = (id: string) =>
  j<{ ok: boolean }>(`/api/queue/${id}/run`, { method: 'POST' })
/** Dispatch every due queued item now (ignores scheduler limits, honors the session lock). */
export const runDueQueueItems = () =>
  j<{ ok: boolean; started: number; skipped: number }>('/api/queue/run-due', { method: 'POST' })
export const cancelQueueItem = (id: string) =>
  j<{ ok: boolean }>(`/api/queue/${id}/cancel`, { method: 'POST' })
export const getRunEvents = (id: string) => j<RunEvent[]>(`/api/queue/${id}/events`)
export const streamUrl = (id: string) => `${API_BASE}/api/queue/${id}/stream`

// --- session messaging (server/src/routes/session-message.ts) ---------------
/** AH-12: the one path left that actually delivers text into a session — types it into the
 *  chat's own desktop app (or the native peer pipe, when live) and confirms from the transcript.
 *  This is what SessionComposer sends through now that queueing a run is permanently refused; it
 *  is also what the MCP `fan_out_send` tool uses server-side. Throws with the server's own reason
 *  on ANY failure, busy included (the route itself refuses a busy chat rather than degrading to a
 *  queue add) — including the soft "typed, but the transcript did not grow" case, which the route
 *  reports as `ok:false` on an HTTP 200, so it would not otherwise surface as a thrown Error. */
export const sendSessionMessage = async (id: string, text: string): Promise<{ detail: string }> => {
  const r = await j<{ ok: boolean; detail?: string; error?: string }>(
    `/api/sessions/${encodeURIComponent(id)}/message`,
    { method: 'POST', body: JSON.stringify({ text }) },
  )
  if (!r.ok) throw new Error(r.error || r.detail || 'Failed to deliver the message.')
  return { detail: r.detail ?? '' }
}

// --- incidents (server/src/incidents.ts) -------------------------------------
// Repeated queue-run failures, grouped and deduped so a night of the same error doesn't read as a
// night of unrelated ones. See incidents.ts's header for the full model.
export const getIncidents = (state?: IncidentState) =>
  j<Incident[]>(`/api/incidents${state ? `?state=${state}` : ''}`)
export const ackIncident = (id: string) =>
  j<{ ok: boolean; incident: Incident }>(`/api/incidents/${id}/ack`, { method: 'POST' })
export const resolveIncident = (id: string) =>
  j<{ ok: boolean; incident: Incident }>(`/api/incidents/${id}/resolve`, { method: 'POST' })

// --- scheduler --------------------------------------------------------------
export const getScheduler = () => j<SchedulerState>('/api/scheduler')
export const updateScheduler = (b: Partial<SchedulerState>) =>
  j<SchedulerState>('/api/scheduler', { method: 'POST', body: JSON.stringify(b) })

// --- instances ----------------------------------------------------------------
// "instance account" = which Anthropic account a Claude Desktop *instance* is logged into
// (distinct from the sqlite `accounts` table above, which holds auth secrets for queue
// dispatch). See server/src/core/shared.ts for the DTO shapes.
export const listInstances = () => j<CMInstance[]>('/api/instances')
export const getInstanceAccount = (dir: string, opts: { noNetwork?: boolean } = {}) =>
  j<CMAccount>(
    `/api/instances/${encodeURIComponent(dir)}/account${opts.noNetwork ? '?noNetwork=1' : ''}`,
  )
export const openInstance = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/open`, { method: 'POST' })
/** `confirmExternal` is the explicit opt-in required to quit the DEFAULT (non-isolated) Claude
 *  Desktop — the server refuses that dir without it (see core/instances.ts quitInstance guard). */
export const quitInstance = (dir: string, opts: { confirmExternal?: boolean } = {}) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/quit`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
/** Remove the stored login from a profile: it asks for a sign-in the next time it starts. Refused
 *  while the instance is running (the app would overwrite or corrupt the write), and the failure
 *  message says so. History, settings and the folder are untouched. */
export const logoutInstance = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/logout`, { method: 'POST' })
export const focusInstance = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/focus`, { method: 'POST' })
export const revealInstanceFolder = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/reveal`, { method: 'POST' })
/** Create a desktop launcher (.lnk on Windows) that opens this instance directly. The result's
 *  `data.path` holds where it landed; a failure carries the MSIX-aware message (same as open). */
export const createInstanceShortcut = (dir: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/shortcut`, { method: 'POST' })
/** Add the lightweight Instances chooser to the user's Desktop. */
export const createInstanceModeShortcut = () =>
  j<CMActionResult>('/api/instance-mode/shortcut', { method: 'POST' })
export const deleteInstance = (dir: string, confirmName: string) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })
/** Update an instance's UI metadata: display label (a pure relabel — never touches the folder,
 *  so it works while the instance runs), icon glyph, and icon color. A field present in the
 *  patch is applied (null clears it to the default); an omitted field is left unchanged. The
 *  result's `data` echoes the sanitized `{ label, icon, color }`. */
export const setInstanceMeta = (
  dir: string,
  patch: {
    label?: string | null
    icon?: InstanceIconKey | null
    color?: InstanceColorKey | null
  },
) =>
  j<CMActionResult>(`/api/instances/${encodeURIComponent(dir)}/meta`, {
    method: 'POST',
    body: JSON.stringify(patch),
  })
export const createInstance = (name: string) =>
  j<CMActionResult>('/api/instances', { method: 'POST', body: JSON.stringify({ name }) })
export const getDesktopInstall = (opts: { fresh?: boolean } = {}) =>
  j<CMDesktopInstall>(`/api/desktop-install${opts.fresh ? '?fresh=1' : ''}`)

/** Always-latest classic (Squirrel .exe) Claude Desktop installer — the only Windows build
 *  the Instances tab can launch. ~217 MB full installer; the claude.ai download page instead
 *  serves a ~7 MB ClaudeSetup.exe bootstrapper that installs the unmanageable MSIX build. */
export const CLASSIC_DESKTOP_INSTALLER_URL =
  'https://claude.ai/api/desktop/win32/x64/exe/latest/redirect'
/** Official download page (serves the MSIX bootstrapper for Windows — link kept for reference). */
export const DESKTOP_DOWNLOAD_PAGE_URL = 'https://claude.com/download'

// --- self-update --------------------------------------------------------------
/** /api/update returns the engine status PLUS the daemon's distribution: a 'compiled' (packaged
 *  release) build can't git-pull, so the UI hides the update controls and points at Releases. */
export type UpdateStatusWithDistribution = UpdateStatus & {
  distribution?: 'source' | 'compiled'
}
export const checkUpdate = () => j<UpdateStatusWithDistribution>('/api/update')

/**
 * Apply an update.
 *
 * Bounded, unlike every other call here, because this is the one request that can legitimately run
 * for many minutes and the one where "still working" and "never coming back" are indistinguishable
 * from the outside. On a source checkout the server runs git pull (120s cap) then `bun install`
 * (240s) then a web build (240s), and a failure re-runs install+build to roll back, so the honest
 * worst case is around 17 minutes of real work. Twenty minutes therefore cannot false-trip on a
 * healthy update, while still guaranteeing the spinner ENDS: before this, a daemon that died
 * mid-apply (which it does on purpose — a compiled apply relaunches the process) left the promise
 * unresolved forever, and the UI simply span until the user gave up and reloaded.
 *
 * The abort surfaces as a normal rejection, which SettingsView already renders as applyError.
 */
const APPLY_UPDATE_TIMEOUT_MS = 20 * 60 * 1000
export const applyUpdate = () =>
  j<UpdateApplyResult>('/api/update/apply', {
    method: 'POST',
    signal: AbortSignal.timeout(APPLY_UPDATE_TIMEOUT_MS),
  })

/** What the BACKGROUND check last found — a memory read on the server, no network, no git. Cheap
 *  enough to poll from the app shell, which is what lets the "update available" hint live outside
 *  the Settings screen. `checked: false` means no background tick has landed yet. */
export interface UpdateAvailability {
  checked: boolean
  checkedAt?: number
  updateAvailable: boolean
  canApply?: boolean
  currentVersion?: string
  latestVersion?: string | null
  reason?: string | null
  autoApply?: boolean
}
export const getUpdateAvailability = () => j<UpdateAvailability>('/api/update/available')

/** The daemon's identity + version. Used to tell "it restarted" from "it died" after an update:
 *  a short timeout, because the whole point is to poll it while the port is coming back. */
export interface Health {
  ok: boolean
  service: string
  version: string
  distribution: 'compiled' | 'source'
  ts: number
}
export const getHealth = (timeoutMs = 2000) =>
  j<Health>('/api/health', { signal: AbortSignal.timeout(timeoutMs) })

/** Where a running apply currently is (server/src/update-progress.ts). Polled while an apply is in
 *  flight so a multi-minute update reports itself instead of showing a mute spinner. */
export interface UpdateProgress {
  phase:
    | 'idle'
    | 'preparing'
    | 'downloading'
    | 'extracting'
    | 'verifying'
    | 'installing'
    | 'building'
    | 'done'
    | 'failed'
  message: string
  startedAt: number | null
  receivedBytes: number | null
  totalBytes: number | null
  seq: number
}
export const getUpdateProgress = () => j<UpdateProgress>('/api/update/progress')

export interface AutoUpdateSettings {
  enabled: boolean
  intervalSecs: number
}
export const getAutoUpdateSettings = () => j<AutoUpdateSettings>('/api/update/settings')
export const updateAutoUpdateSettings = (b: Partial<AutoUpdateSettings>) =>
  j<AutoUpdateSettings>('/api/update/settings', { method: 'POST', body: JSON.stringify(b) })

// --- app shutdown -------------------------------------------------------------
/** Full app shutdown from the UI. The daemon drops the tray's shutdown sentinel and exits, so the
 *  tray tears the WHOLE app down (window + daemon + tray icon) rather than reviving the daemon.
 *  Same-origin and token-free by design: the `-shutdown-source: ui` header (no tray token) is what
 *  the daemon treats as a user "Shut down" (see server/src/index.ts /api/shutdown). */
export const shutdownApp = () =>
  j<{ ok: boolean }>('/api/shutdown', {
    method: 'POST',
    headers: { 'x-agenthydra-shutdown-source': 'ui' },
  })

// --- app settings (portable mode, hide tray icon, usage auto-refresh + section visibility) -------
/** Everything /api/settings returns: window/tray, usage, provider, editor, and notification settings. */
export type AppSettings = PortableModeSettings &
  UsageSettings &
  ProviderSettings &
  TranscriptSettings &
  NotificationSettings
/**
 * What a settings PATCH may carry. Identical to AppSettings except for the SMTP password, which is
 * WRITE-ONLY: the server never returns it (AppSettings carries `notifySmtpPassSet` instead), so it
 * cannot be part of the read type without inviting a round-trip that echoes a secret back.
 * An empty string means "leave the stored password alone", never "clear it".
 */
export type AppSettingsPatch = Partial<AppSettings> & { notifySmtpPass?: string }
export const getSettings = () => j<AppSettings>('/api/settings')
export const updateSettings = (b: AppSettingsPatch) =>
  j<AppSettings>('/api/settings', { method: 'POST', body: JSON.stringify(b) })

// --- cross-window UI preferences (see server/src/core/ui-prefs.ts) ------------------------------
// A mirror of a few localStorage keys, kept server-side because the quick-instances window can be
// served from a DIFFERENT PORT than the full manager — and a browser scopes localStorage per
// origin, port included. Values are the raw strings vueuse's useStorage reads and writes, so this
// carries no schema of its own; `null` in a patch deletes the key.
/** Every mirrored preference, keyed exactly as it is in localStorage. */
export const getUiPrefs = () => j<{ prefs: Record<string, string> }>('/api/ui-prefs')
/** Merge preferences into the shared store; returns everything that was kept. */
export const updateUiPrefs = (patch: Record<string, string | null>) =>
  j<{ prefs: Record<string, string> }>('/api/ui-prefs', {
    method: 'POST',
    body: JSON.stringify(patch),
  })
export const openPortableWindow = () =>
  j<PortableWindowResult>('/api/portable-window', { method: 'POST' })
export const createChatGptContextPack = (cwd: string, task: string) =>
  j<ChatGptContextPack>('/api/chatgpt/context-pack', {
    method: 'POST',
    body: JSON.stringify({ cwd, task }),
  })

// --- "Sync my settings with Connections" (see server/src/connections.ts) -----------------------
/** A handled sync failure — returned at HTTP 200 so it's non-blocking. */
export interface SyncErrorResult {
  ok: false
  error: string
}
export type SyncResult = SyncStatus | SyncErrorResult

/** Read the current sync status (enabled/connected/email/appearance/etc). */
export const getSyncStatus = () => j<SyncStatus>('/api/settings/sync')
/**
 * Turn sync on/off, disconnect, or push an updated appearance blob.
 * `{ enabled: true, appearance }` seeds/pulls; `{ enabled: false }` turns off (keeps the
 * connection); `{ enabled: false, forget: true }` disconnects fully.
 */
export const setSync = (b: {
  enabled?: boolean
  forget?: boolean
  appearance?: Record<string, unknown>
}) => j<SyncResult>('/api/settings/sync', { method: 'PUT', body: JSON.stringify(b) })
/** Force a pull of the remote synced settings now. */
export const syncPull = () => j<SyncResult>('/api/settings/sync/pull', { method: 'POST' })
/** Force a push of the current local settings now. */
export const syncPush = () => j<SyncResult>('/api/settings/sync/push', { method: 'POST' })

// --- usage-check subsystem (Feature B) -----------------------------------------
// Read an account's remaining Claude quota. A check is a ~300ms call to the same quota endpoint the
// CLI's `/usage` screen reads (it only falls back to spawning `claude` when no OAuth token works),
// and reading quota does not consume quota — so refreshing freely is fine. Results are cached
// server-side per key; pass refresh to force a fresh read.
/** Check a registered dispatch account's usage (by id or label). */
export const checkAccountUsage = (account: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/usage?account=${encodeURIComponent(account)}${refresh ? '&refresh=1' : ''}`,
  )
/** Check usage for a desktop instance (own token → linked CLI instance's login → dispatch account). */
export const checkDesktopInstanceUsage = (dir: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/instances/${encodeURIComponent(dir)}/usage${refresh ? '?refresh=1' : ''}`,
  )
/** The whole server-side usage cache, keyed by `desktop:<dir>` / `acct:<id>` / `cli:<id>` etc. */
export const getUsageCache = () =>
  j<{ cache: Record<string, UsageSnapshot>; lastAutoRefreshAt: string | null }>('/api/usage/cache')
/** Force one background refresh sweep now (the same pass the auto-refresh timer runs). */
export const refreshAllUsage = () =>
  j<{ ok: boolean; checked: number }>('/api/usage/refresh', { method: 'POST' })

// --- reset notifications (see server/src/reset-watch.ts) ----------------------------------------
// Quota-window rollovers the daemon noticed. They are raised server-side (so a notification still
// fires with no browser open) and mirrored here so the app can toast them and let you acknowledge —
// which is also what stops persistent mode from re-raising them.
/** Open (unacknowledged, unexpired) reset events, newest first. */
export const getResetEvents = () => j<ResetEvent[]>('/api/notifications/events')
/** Acknowledge one event, or every open one when `id` is omitted. */
export const acknowledgeResetEvents = (id?: string) =>
  j<ResetEvent[]>('/api/notifications/ack', {
    method: 'POST',
    body: JSON.stringify(id ? { id } : {}),
  })
/** Fire a test notification through the configured channels, so the plumbing can be proven now. */
export const sendTestNotification = () =>
  j<NotifyDeliveryResult>('/api/notifications/test', { method: 'POST' })

// --- CLI instances (Feature A) -------------------------------------------------
export const listCliInstances = () => j<CliInstance[]>('/api/cli-instances')
export const createCliInstance = (name: string) =>
  j<CMActionResult>('/api/cli-instances', { method: 'POST', body: JSON.stringify({ name }) })
export const launchCliInstance = (id: string, opts: { model?: string; effort?: string } = {}) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/launch`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
/** Open a terminal for the USER to /login this CLI instance (the daemon never logs in itself). */
export const cliInstanceLogin = (id: string) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/login`, { method: 'POST' })
export const renameCliInstance = (id: string, name: string) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const associateCliInstance = (
  id: string,
  accountId: string | null,
  accountLabel?: string | null,
) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/associate`, {
    method: 'POST',
    body: JSON.stringify({ accountId, accountLabel }),
  })
/**
 * Link this CLI instance to a DESKTOP instance (pass null to unlink). They are normally the same
 * Anthropic account with two separate logins, so linking groups them in the UI and lets each act as
 * the other's usage-check fallback when one's token is expired.
 */
export const linkCliInstanceToDesktop = (
  id: string,
  desktopDir: string | null,
  desktopLabel?: string | null,
) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}/link-desktop`, {
    method: 'POST',
    body: JSON.stringify({ desktopDir, desktopLabel }),
  })
export const deleteCliInstance = (id: string, confirmName: string) =>
  j<CMActionResult>(`/api/cli-instances/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })
export const checkCliInstanceUsage = (id: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/cli-instances/${encodeURIComponent(id)}/usage${refresh ? '?refresh=1' : ''}`,
  )

// --- Codex CLI + Desktop instances -------------------------------------------
// Each listed instance already carries a locally-resolved `account` (auth.json is plain JSON, so
// the server can afford to attach it eagerly); getCodexInstanceAccount is the LIVE refresh, which
// re-reads the plan from ChatGPT rather than from the token's mint-time claim.
export const listCodexInstances = () => j<CodexInstance[]>('/api/codex-instances')
export const getCodexInstanceAccount = (id: string, opts: { noNetwork?: boolean } = {}) =>
  j<CodexAccount>(
    `/api/codex-instances/${encodeURIComponent(id)}/account${opts.noNetwork ? '?noNetwork=1' : ''}`,
  )
export const checkCodexInstanceUsage = (id: string, refresh = false) =>
  j<UsageCheckResult>(
    `/api/codex-instances/${encodeURIComponent(id)}/usage${refresh ? '?refresh=1' : ''}`,
  )
export const createCodexInstance = (name: string) =>
  j<CMActionResult>('/api/codex-instances', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const launchCodexInstance = (id: string, opts: { model?: string; effort?: string } = {}) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/launch`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
export const codexInstanceLogin = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/login`, {
    method: 'POST',
  })
export const openCodexDesktopInstance = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/desktop/open`, {
    method: 'POST',
  })
export const focusCodexDesktopInstance = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/desktop/focus`, {
    method: 'POST',
  })
export const quitCodexDesktopInstance = (id: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/desktop/quit`, {
    method: 'POST',
  })
/** Redeem one banked Codex `/usage reset` credit. `force` bypasses the "busiest window isn't
 *  fully used" guard — omit it to let the server refuse a wasteful redemption. A successful
 *  redeem (`ok: true`) carries the freshly re-checked `usage` snapshot. */
export const redeemCodexResetCredit = (id: string, opts: { force?: boolean } = {}) =>
  j<CodexResetRedeemResult & { usage?: UsageSnapshot }>(
    `/api/codex-instances/${encodeURIComponent(id)}/redeem-reset-credit`,
    { method: 'POST', body: JSON.stringify({ force: opts.force === true }) },
  )
export const renameCodexInstance = (id: string, name: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const deleteCodexInstance = (id: string, confirmName: string) =>
  j<CMActionResult>(`/api/codex-instances/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  })

// --- auto-resume monitor (Feature E) -------------------------------------------
export const getMonitor = () => j<MonitorView>('/api/monitor')
export const updateMonitor = (b: Partial<MonitorSettings>) =>
  j<MonitorView>('/api/monitor', { method: 'POST', body: JSON.stringify(b) })
export const setMonitorAccount = (accountId: string, enabled: boolean) =>
  j<MonitorView>('/api/monitor/account', {
    method: 'POST',
    body: JSON.stringify({ accountId, enabled }),
  })
/** Force one monitor pass now (manual "check for resumable stops"). */
export const runMonitorCheck = () =>
  j<{ ok: boolean } & MonitorView>('/api/monitor/check', { method: 'POST' })

/** Move a chat to another account: stops its live process if any, archives its old desktop
 *  entries, runs a one-turn migration on the target account, then imports it into that
 *  instance's desktop app under its real title (the finalize hook fires the import). */
export const migrateSession = (
  sessionId: string,
  instanceRef: string,
  // THE TITLE DECISION IS REQUIRED (server, since 2026-08-29: a migration is a landing, and a chat
  // must not land without a real name). Exactly one of: `title`, a real new name; or
  // `confirmTitle`, the chat's CURRENT title restated exactly, accepted only when that title is
  // itself a real name. This client sent neither for a month, so every migrate from the UI -
  // single or bulk - was refused with 400 before it did anything (owner's console, 2026-09-03:
  // sixteen 400s for sixteen chats). Callers pass the row's own title as the confirmation.
  opts: { title?: string; confirmTitle?: string } = {},
) =>
  j<{ ok: boolean; itemId?: string; stoppedLive?: boolean; error?: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/migrate`,
    {
      method: 'POST',
      body: JSON.stringify({
        instance_ref: instanceRef,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.confirmTitle ? { confirm_title: opts.confirmTitle } : {}),
      }),
    },
  )
