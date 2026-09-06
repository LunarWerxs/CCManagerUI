<script setup lang="ts">
import { LogOut, Moon, RefreshCw, Sun } from '@lucide/vue'
import { useStorage } from '@vueuse/core'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { toast } from 'vue-sonner'
import AccountsStrip from '@/components/AccountsStrip.vue'
import ArmSwitch from '@/components/ArmSwitch.vue'
import ChatsTable from '@/components/ChatsTable.vue'
import HoldsView from '@/components/HoldsView.vue'
import InstancesTable from '@/components/InstancesTable.vue'
import LogicTree from '@/components/LogicTree.vue'
import PlanTable from '@/components/PlanTable.vue'
import RulesView from '@/components/RulesView.vue'
import ScriptsView from '@/components/ScriptsView.vue'
import SignIn from '@/components/SignIn.vue'
import StatusPills from '@/components/StatusPills.vue'
import Tiles from '@/components/Tiles.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import WaitingTable from '@/components/WaitingTable.vue'
import { useDashboard } from '@/composables/useDashboard'
import { useGateway } from '@/composables/useGateway'
import { useTheme } from '@/lib/theme'
import AppFooter from '@/shell/AppFooter.vue'

type View = 'plan' | 'waiting' | 'chats' | 'instances' | 'holds' | 'scripts' | 'rules' | 'tree'
const VIEWS: { id: View; label: string }[] = [
  { id: 'plan', label: 'The plan' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'chats', label: 'Every chat' },
  { id: 'instances', label: 'Instances' },
  { id: 'holds', label: 'Holds & breaker' },
  { id: 'scripts', label: 'The scripts' },
  { id: 'rules', label: 'The rules' },
  { id: 'tree', label: 'Logic tree' },
]

const { isDark, toggle: toggleTheme } = useTheme()
const gateway = useGateway()
const dash = useDashboard()
const view = useStorage<View>('orchestrator.view', 'plan')

const ready = computed(() => gateway.auth.value !== null)

async function openView(v: View): Promise<void> {
  view.value = v
  if (v !== 'plan') dash.planFilter.value = null
  await loadFor(v)
}

function loadFor(v: View): Promise<void> {
  switch (v) {
    case 'plan':
    case 'waiting':
      return dash.loadPlan()
    case 'chats':
      return dash.loadChats()
    case 'instances':
      return dash.loadInstances()
    case 'holds':
      return dash.loadSuppressed()
    case 'scripts':
      return dash.loadScripts()
    case 'rules':
      return dash.loadRules()
    default:
      return Promise.resolve()
  }
}

async function refresh(): Promise<void> {
  await Promise.all([gateway.loadStatus(), dash.refreshAll(), loadFor(view.value)])
}

function selectKind(kind: typeof dash.planFilter.value): void {
  dash.planFilter.value = kind
  view.value = 'plan'
}

const currentSlot = computed(() => {
  switch (view.value) {
    case 'plan':
    case 'waiting':
      return dash.plan
    case 'chats':
      return dash.chats
    case 'instances':
      return dash.instances
    case 'holds':
      return dash.suppressed
    case 'scripts':
      return dash.scripts
    case 'rules':
      return dash.rules
    default:
      return null
  }
})

const statusLine = computed(() => {
  const s = currentSlot.value
  if (!s?.loadedAt) return ''
  const at = new Date(s.loadedAt).toLocaleTimeString()
  if ((view.value === 'plan' || view.value === 'waiting') && dash.plan.data) {
    return `scanned ${dash.plan.data.scanned} visible chats over full transcript tails · ${at}`
  }
  return at
})

async function afterAuthReady(): Promise<void> {
  if (gateway.needsSignIn.value) return
  void gateway.loadStatus()
  gateway.startPolling()
  // The accounts strip is deliberately not awaited: the usage survey can take a minute.
  void dash.loadAccounts()
  await loadFor(view.value)
}

// AH-23: connect() resolves exactly once per call - immediately on success, on an auth refusal,
// or after its bounded auto-retry backoff gives up - whether that's the very first attempt at
// mount or a later one kicked off by the Retry button. Either way this is the single place that
// reacts to "we're in", so the poller/dash bootstrap above only ever runs once per real recovery.
async function tryConnect(): Promise<void> {
  const connected = await gateway.connect()
  if (connected) await afterAuthReady()
}

function retryConnect(): void {
  void tryConnect()
}

onMounted(() => {
  void tryConnect()
})
onUnmounted(() => gateway.stopPolling())

// Signing in reloads the page, so the only transition to handle is session loss mid-view.
watch(
  () => gateway.needsSignIn.value,
  (needs) => {
    if (needs) gateway.stopPolling()
  },
)

// AH-26: signOut() catches its own rejection rather than pretending the sign-out worked - surface
// it so the click doesn't just silently do nothing.
watch(
  () => gateway.signOutError.value,
  (msg) => {
    if (msg) toast.error('Sign-out failed', { description: msg })
  },
)
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <Toaster position="bottom-right" :theme="isDark ? 'dark' : 'light'" close-button />

    <div v-if="!ready" class="grid min-h-dvh place-items-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <template v-if="gateway.authRefused.value">
        <p class="text-destructive">Sign-in was refused. This orchestrator needs a fresh sign-in, not a reconnect.</p>
        <Button as-child size="sm" variant="outline">
          <a href="/oauth/login">Sign in</a>
        </Button>
      </template>
      <template v-else-if="gateway.authError.value">
        <p class="text-destructive">gateway unreachable: {{ gateway.authError.value }}</p>
        <p v-if="gateway.reconnecting.value" class="text-xs">retrying automatically…</p>
        <Button size="sm" variant="outline" @click="retryConnect">
          <RefreshCw />
          Retry
        </Button>
      </template>
      <span v-else>connecting…</span>
    </div>

    <SignIn v-else-if="gateway.needsSignIn.value" :auth="gateway.auth.value!" />

    <div v-else class="mx-auto w-full max-w-[1280px] px-4 pb-10 pt-4 sm:px-6">
      <header class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="flex items-center gap-2">
          <img src="/favicon.svg" alt="" class="size-7" />
          <h1 class="text-lg font-semibold tracking-tight">Orchestrator</h1>
          <span class="rounded-full border border-border bg-input/20 px-2 py-0.5 text-[11px] text-muted-foreground">read-only · acts stay in the terminal</span>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <ArmSwitch />
          <Button variant="outline" size="icon" title="Refresh every reading" @click="refresh">
            <RefreshCw :class="{ 'animate-spin': dash.plan.loading || dash.accounts.loading }" />
          </Button>
          <Button variant="ghost" size="icon" :title="isDark ? 'Light theme' : 'Dark theme'" @click="toggleTheme()">
            <Sun v-if="isDark" />
            <Moon v-else />
          </Button>
          <DropdownMenu v-if="gateway.auth.value?.remote">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" class="gap-2">
                <img v-if="gateway.auth.value?.ownerPicture" :src="gateway.auth.value.ownerPicture" alt="" class="size-5 rounded-full" />
                <span class="max-w-[10rem] truncate">{{ gateway.auth.value?.owner || 'owner' }}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="gateway.signOut(false)"><LogOut /> Sign out</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem @select="gateway.signOut(true)">Sign out everywhere</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <StatusPills :status="gateway.status.value" :error="gateway.statusError.value" />

      <p class="mb-4 mt-2 text-[13px] text-muted-foreground">
        Every verdict below is computed by the Python toolbox from real transcript tails and the daemon's dossier.
        This page shows what it <em>would</em> do and why; the switch is the only thing here that changes anything.
      </p>

      <AccountsStrip :data="dash.accounts.data" :loading="dash.accounts.loading" :error="dash.accounts.error" />

      <Tiles v-if="dash.plan.data" :plan="dash.plan.data" :filter="dash.planFilter.value" @select="selectKind" />

      <nav class="mb-3 mt-4 flex flex-wrap gap-1.5" aria-label="Views">
        <Button
          v-for="v in VIEWS"
          :key="v.id"
          size="sm"
          :variant="view === v.id ? 'default' : 'outline'"
          :aria-pressed="view === v.id"
          @click="openView(v.id)"
        >
          {{ v.label }}
        </Button>
      </nav>

      <p class="mb-2 min-h-[1.2em] text-xs text-muted-foreground">
        <template v-if="currentSlot?.loading">running the read-only scan…</template>
        <template v-else>{{ statusLine }}</template>
      </p>

      <Alert v-if="currentSlot?.error" variant="destructive" class="mb-3">
        <AlertTitle>⛔ Read failed - this is NOT an empty fleet</AlertTitle>
        <AlertDescription>{{ currentSlot.error }}</AlertDescription>
      </Alert>

      <div class="space-y-2">
        <template v-if="currentSlot?.loading && !currentSlot.data">
          <Skeleton class="h-9 w-full" />
          <Skeleton class="h-9 w-full" />
          <Skeleton class="h-9 w-3/4" />
        </template>
        <template v-else-if="view === 'plan' && dash.plan.data">
          <PlanTable :plan="dash.plan.data" :filter="dash.planFilter.value" @clear-filter="dash.planFilter.value = null" />
        </template>
        <template v-else-if="view === 'waiting' && dash.plan.data">
          <WaitingTable :plan="dash.plan.data" />
        </template>
        <template v-else-if="view === 'chats' && dash.chats.data">
          <ChatsTable :data="dash.chats.data" />
        </template>
        <template v-else-if="view === 'instances' && dash.instances.data">
          <InstancesTable :data="dash.instances.data" />
        </template>
        <template v-else-if="view === 'holds' && dash.suppressed.data">
          <HoldsView :data="dash.suppressed.data" />
        </template>
        <template v-else-if="view === 'scripts' && dash.scripts.data">
          <ScriptsView :data="dash.scripts.data" />
        </template>
        <template v-else-if="view === 'rules' && dash.rules.data">
          <RulesView :data="dash.rules.data" />
        </template>
        <template v-else-if="view === 'tree'">
          <LogicTree />
        </template>
      </div>
    </div>
    <AppFooter />
  </TooltipProvider>
</template>
