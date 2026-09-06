/**
 * The gateway's API, typed. Every `/api/data/<name>` shape is exactly what scripts/dashboard.py
 * returns (its build_* functions are the source of truth); the rest is the gateway's own.
 */

export type DecisionKind =
  | 'wait-on-person'
  | 'judgment'
  | 'archive'
  | 'held-back'
  | 'resume'
  | 'human'
  | 'on-hold'
  | 'cannot'
  | 'leave-alone'

export interface Decision {
  action: string
  kind: DecisionKind
  detail: string
  command: string | null
}

export interface ChatAccount {
  email: string | null
  plan: string | null
  appRunning?: boolean
}

export interface PlanChat {
  sessionId: string
  title: string | null
  instance: string | null
  origin: 'desktop' | 'console'
  sourceTool: string | null
  account: ChatAccount | null
  state: 'running' | 'finished' | 'crashed' | 'ungated' | string
  cause: string
  lastActivityAt: number | null
  decision: Decision
  evidence: string
}

export interface Plan {
  generatedAt: number
  scanned: number
  complete: boolean
  incompleteWhy: string | null
  counts: Partial<Record<DecisionKind, number>>
  chats: PlanChat[]
}

export interface ChatRow {
  sessionId: string
  title: string | null
  instance: string | null
  origin: 'desktop' | 'console'
  sourceTool: string | null
  account: ChatAccount | null
  archived: boolean
  lastActivityAt: number | null
  preview: string
}

export interface ChatsData {
  generatedAt: number
  total: number
  chats: ChatRow[]
}

export interface InstanceRow {
  num: number | null
  name: string
  dir?: string
  isRunning: boolean
  email: string | null
  plan: string | null
  weeklyPct?: number | null
  visibleChats: number
  signedIn?: boolean
  [key: string]: unknown
}

export interface InstancesData {
  generatedAt: number
  instances: InstanceRow[]
}

export interface SuppressedRow {
  kind: string
  session: string
  attempts?: number
  why: string
}

export interface HoldRow {
  session: string
  reason?: string
  why?: string
  [key: string]: unknown
}

export interface SuppressedData {
  generatedAt: number
  suppressed: SuppressedRow[]
  holds: HoldRow[]
}

export interface AccountRow {
  email: string | null
  identity?: string
  plan: string | null
  kind?: string
  instances: { name: string; isRunning: boolean }[]
  fiveHourPct: number | null
  weeklyAllPct: number | null
  weeklyModelPct: number | null
  bindingPct: number | null
  peakPct?: number | null
  roomPct?: number | null
  band?: string
  fresh: boolean
  readingOk: boolean
  ageHours?: number
  underPressure: boolean
  open: boolean
  mustOpen?: boolean
  usable?: boolean
  weeklyResets?: string | null
  fillCeiling?: number
  [key: string]: unknown
}

export interface MoveRow {
  title: string
  from: { instance: string; email: string | null; bindingPct: number | null }
  to: { instance: string; email: string | null; bindingPct: number | null }
  why: string
  command: string
}

export interface ConsoleStray {
  title: string
  why: string
  command: string | null
}

export interface AccountsData {
  usageSource: 'live' | 'cache-fallback' | 'unavailable' | string
  activeAccounts: number
  measuredAccounts: number
  totalLogins: number
  accounts: AccountRow[]
  useNext: Pick<AccountRow, 'email' | 'plan' | 'bindingPct' | 'open' | 'mustOpen'>[]
  moves: MoveRow[]
  consoleStrays: ConsoleStray[]
  likelihood: { level: 'likely' | 'blocked' | 'unlikely' | 'unknown' | string; why: string }
  planIncomplete: boolean
}

export interface Rule {
  if: string
  then: string
  value: string
}

export interface RulesData {
  generatedAt: number
  sections: { title: string; rules: Rule[] }[]
}

export interface ScriptRow {
  name: string
  kind: 'observe' | 'act' | 'lib'
  summary: string
  detail: string
  usage: string
  exits: string
}

export interface ScriptsData {
  generatedAt: number
  scripts: ScriptRow[]
}

export interface HealthData {
  daemon: { version?: string; [key: string]: unknown }
  daemonUrl: string
}

export interface AuthStatus {
  authEnforced: boolean
  remote: boolean
  authenticated: boolean
  owner: string | null
  ownerPicture: string | null
  ownerClaimed: boolean
  oauthCallback: 'ready' | 'pending' | 'retrying' | 'failed' | 'incompatible'
}

export interface SwitchStatus {
  up: boolean
  paused: boolean
  pid: number | null
  ageSecs: number | null
  why: string
}

export interface GatewayStatus {
  version: string
  remote: {
    tunnel: 'quick' | 'named' | 'off'
    tunnelUrl: string | null
    tunnelError: string | null
    stableUrl: string | null
    relayError: string | null
    oauthCallback: AuthStatus['oauthCallback']
  }
  config: {
    port: number
    oauth: { issuer: string; clientId: string; redirectUri: string; ownerClaimed: boolean } | null
    tunnel: { provider: 'quick' | 'named'; hostname: string | null; hasToken: boolean }
    relay: { url: string; id: string | null }
  }
  switch: SwitchStatus
  daemon: { ok: boolean; version: string | null; url: string }
  dashboard: { ok: boolean }
}

export interface SwitchResult {
  ok: boolean
  code: number | null
  output: string
  switch: SwitchStatus
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// Test-only injection seam: lets a test swap in a fake fetch scoped to this module instead of
// patching globalThis.fetch, which would otherwise leak across test files. Never set in app code.
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchImpl: FetchFn = fetch
export function __setFetchForTests(fn: FetchFn | null): void {
  fetchImpl = fn ?? fetch
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401) throw new ApiError('sign in required', 401)
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new ApiError(body.error || `${path} -> HTTP ${res.status}`, res.status)
  return body
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  status: () => request<GatewayStatus>('/api/status'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  logoutAll: () => request<{ ok: boolean }>('/api/auth/logout-all', { method: 'POST' }),
  plan: () => request<Plan>('/api/data/plan'),
  chats: () => request<ChatsData>('/api/data/chats'),
  instances: () => request<InstancesData>('/api/data/instances'),
  suppressed: () => request<SuppressedData>('/api/data/suppressed'),
  accounts: () => request<AccountsData>('/api/data/accounts'),
  rules: () => request<RulesData>('/api/data/rules'),
  scripts: () => request<ScriptsData>('/api/data/scripts'),
  health: () => request<HealthData>('/api/data/health'),
  switch: () => request<SwitchStatus>('/api/switch'),
  arm: () => request<SwitchResult>('/api/switch/arm', { method: 'POST' }),
  disarm: () => request<SwitchResult>('/api/switch/disarm', { method: 'POST' }),
}

/** "3min ago" - same buckets as the old dashboard's rel(). */
export function rel(ms: number | null | undefined): string {
  if (!ms) return '—'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}min ago`
  if (s < 129600) return `${(s / 3600).toFixed(1)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export const KINDS: Record<
  DecisionKind,
  {
    icon: string
    label: string
    badge: 'warning' | 'success' | 'destructive' | 'info' | 'secondary' | 'primary'
  }
> = {
  'wait-on-person': { icon: '✋', label: 'waiting on you', badge: 'warning' },
  judgment: { icon: '🤔', label: 'needs a decision', badge: 'warning' },
  archive: { icon: '🗄', label: 'would archive', badge: 'success' },
  'held-back': { icon: '⏸', label: 'held back', badge: 'destructive' },
  resume: { icon: '⟳', label: 'resume candidate', badge: 'info' },
  human: { icon: '🧍', label: "a person's", badge: 'secondary' },
  'on-hold': { icon: '🔒', label: 'on hold', badge: 'secondary' },
  cannot: { icon: '🚫', label: 'cannot gate', badge: 'destructive' },
  'leave-alone': { icon: '🛠', label: 'working', badge: 'primary' },
}

export const STATE_ICON: Record<string, string> = {
  running: '🟢',
  finished: '🏁',
  crashed: '💥',
  ungated: '❓',
}
