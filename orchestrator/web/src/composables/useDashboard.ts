import { reactive, ref } from 'vue'
import {
  type AccountsData,
  api,
  type ChatsData,
  type DecisionKind,
  type InstancesData,
  type Plan,
  type RulesData,
  type ScriptsData,
  type SuppressedData,
} from '@/lib/api'

export interface Slot<T> {
  data: T | null
  loading: boolean
  error: string | null
  loadedAt: number | null
}

function slot<T>(): Slot<T> {
  return reactive({ data: null, loading: false, error: null, loadedAt: null }) as Slot<T>
}

// One cache for the whole page. The plan is the expensive read (every chat gated over its real
// transcript tail) and the accounts strip is the slow one (the usage survey); both are loaded
// once and re-read only on an explicit refresh, exactly as the Python dashboard does.
const plan = slot<Plan>()
const accounts = slot<AccountsData>()
const chats = slot<ChatsData>()
const instances = slot<InstancesData>()
const suppressed = slot<SuppressedData>()
const rules = slot<RulesData>()
const scripts = slot<ScriptsData>()
const planFilter = ref<DecisionKind | null>(null)

async function run<T>(s: Slot<T>, loader: () => Promise<T>, force: boolean): Promise<void> {
  if (s.loading) return
  if (s.data && !force) return
  s.loading = true
  s.error = null
  try {
    s.data = await loader()
    s.loadedAt = Date.now()
  } catch (err) {
    s.error = err instanceof Error ? err.message : String(err)
  } finally {
    s.loading = false
  }
}

export function useDashboard() {
  const loadPlan = (force = false) => run(plan, api.plan, force)
  const loadAccounts = (force = false) => run(accounts, api.accounts, force)
  const loadChats = (force = false) => run(chats, api.chats, force)
  const loadInstances = (force = false) => run(instances, api.instances, force)
  const loadSuppressed = (force = false) => run(suppressed, api.suppressed, force)
  const loadRules = (force = false) => run(rules, api.rules, force)
  const loadScripts = (force = false) => run(scripts, api.scripts, force)

  /** Re-read everything that is currently loaded; untouched views reload the next time they open. */
  async function refreshAll(): Promise<void> {
    const jobs: Promise<void>[] = [loadPlan(true), loadAccounts(true)]
    if (chats.data) jobs.push(loadChats(true))
    if (instances.data) jobs.push(loadInstances(true))
    if (suppressed.data) jobs.push(loadSuppressed(true))
    if (rules.data) jobs.push(loadRules(true))
    if (scripts.data) jobs.push(loadScripts(true))
    await Promise.all(jobs)
  }

  return {
    plan,
    accounts,
    chats,
    instances,
    suppressed,
    rules,
    scripts,
    planFilter,
    loadPlan,
    loadAccounts,
    loadChats,
    loadInstances,
    loadSuppressed,
    loadRules,
    loadScripts,
    refreshAll,
  }
}
