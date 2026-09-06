import { computed, ref } from 'vue'
import {
  ApiError,
  type AuthStatus,
  api,
  type GatewayStatus,
  type SwitchResult,
  type SwitchStatus,
} from '@/lib/api'

// Module-level singletons: one gateway, one auth state, however many components read them.
const auth = ref<AuthStatus | null>(null)
const status = ref<GatewayStatus | null>(null)
const authError = ref<string | null>(null)
const statusError = ref<string | null>(null)
const switching = ref(false)
const signOutError = ref<string | null>(null)
let statusTimer: ReturnType<typeof setInterval> | undefined

// AH-23: the initial auth/status transport failure used to be a one-shot - land on the
// unreachable screen with no way back short of a manual browser reload. `connect()` retries with
// bounded backoff and distinguishes that from an outright authentication refusal (401/403), which
// is not something retrying can fix and instead points at the login path.
const reconnecting = ref(false)
const reconnectAttempt = ref(0)
const authRefused = ref(false)
const RECONNECT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 30_000]
const MAX_RECONNECT_ATTEMPTS = 6
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let pendingWaitResolve: ((stillCurrent: boolean) => void) | undefined
let connectGeneration = 0

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Cancels any in-flight backoff wait, resolving it `false` (superseded) rather than orphaning it -
 *  a bare `clearTimeout` would leave that wait's promise pending forever. */
function clearReconnectTimer(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  if (pendingWaitResolve) {
    const resolve = pendingWaitResolve
    pendingWaitResolve = undefined
    resolve(false)
  }
}

/**
 * Test-only seam: these refs are deliberate module-level singletons (one gateway shared by every
 * component), which is exactly what makes them leak between `test()` blocks that call
 * `useGateway()` independently - and, per bunfig.toml's note on cross-file leakage, potentially
 * between files in the same `bun test` run too. Never call this from app code.
 */
export function __resetGatewayForTests(): void {
  clearReconnectTimer()
  connectGeneration++ // orphan any in-flight wait from a prior test
  auth.value = null
  status.value = null
  authError.value = null
  statusError.value = null
  switching.value = false
  signOutError.value = null
  reconnecting.value = false
  reconnectAttempt.value = 0
  authRefused.value = false
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = undefined
}

/** Resolves once `delay` has passed, `false` if a newer `connect()` superseded this wait. */
function wait(delay: number, gen: number): Promise<boolean> {
  return new Promise((resolve) => {
    pendingWaitResolve = resolve
    reconnectTimer = setTimeout(() => {
      pendingWaitResolve = undefined
      resolve(gen === connectGeneration)
    }, delay)
  })
}

export function useGateway() {
  async function loadAuth(): Promise<void> {
    try {
      auth.value = await api.authStatus()
      authError.value = null
      authRefused.value = false
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // Not a transport outage - retrying won't help. Send the caller to the login path instead
        // of looping forever against a gateway that has already made its decision.
        authRefused.value = true
        authError.value = null
      } else {
        authRefused.value = false
        authError.value = message(err)
      }
    }
  }

  /**
   * Try once, then auto-retry with backoff (2s/4s/8s, capped at 30s) until it connects, is
   * refused, or gives up after `MAX_RECONNECT_ATTEMPTS`. Calling this again (e.g. an explicit
   * Retry click) supersedes any in-flight wait via the generation guard, so at most one reconnect
   * chain is ever live - callers still only see ONE eventual resolution, never a duplicate.
   */
  async function connect(): Promise<boolean> {
    const gen = ++connectGeneration
    clearReconnectTimer()
    reconnectAttempt.value = 0
    reconnecting.value = false
    for (;;) {
      await loadAuth()
      if (gen !== connectGeneration) return false // superseded by a newer connect()
      if (auth.value) {
        reconnecting.value = false
        reconnectAttempt.value = 0
        return true
      }
      if (authRefused.value) {
        reconnecting.value = false
        return false
      }
      if (reconnectAttempt.value >= MAX_RECONNECT_ATTEMPTS) {
        reconnecting.value = false
        return false
      }
      reconnecting.value = true
      const delay =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt.value, RECONNECT_DELAYS_MS.length - 1)]!
      reconnectAttempt.value++
      const stillCurrent = await wait(delay, gen)
      if (!stillCurrent) return false
    }
  }

  async function loadStatus(): Promise<void> {
    try {
      status.value = await api.status()
      statusError.value = null
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && auth.value) {
        // The session lapsed (or the key was rotated from another device): back to the gate.
        auth.value = { ...auth.value, authenticated: false }
      }
      statusError.value = message(err)
    }
  }

  function startPolling(ms = 20_000): void {
    stopPolling()
    statusTimer = setInterval(() => void loadStatus(), ms)
  }
  function stopPolling(): void {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = undefined
  }

  const needsSignIn = computed(
    () => !!auth.value && auth.value.authEnforced && !auth.value.authenticated,
  )
  const switchState = computed<SwitchStatus | null>(() => status.value?.switch ?? null)

  /** Throw the switch through `python orch.py arm|disarm`; the answer carries the fresh heartbeat read. */
  async function setArmed(on: boolean): Promise<SwitchResult> {
    switching.value = true
    try {
      const result = on ? await api.arm() : await api.disarm()
      if (status.value) status.value = { ...status.value, switch: result.switch }
      return result
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        // The gateway answers 502 with the same shape when orch.py exits non-zero.
        throw err
      }
      throw err
    } finally {
      switching.value = false
    }
  }

  // AH-26: this used to reload unconditionally, so a rejected /api/auth/logout(-all) call (a
  // dead gateway, a network blip) reloaded the page anyway - the user watched the sign-out
  // "succeed" while the session cookie never actually cleared. Now a failure is caught and
  // surfaced instead of pretending it worked.
  async function signOut(everywhere = false): Promise<void> {
    signOutError.value = null
    try {
      if (everywhere) await api.logoutAll()
      else await api.logout()
      window.location.reload()
    } catch (err) {
      signOutError.value = message(err)
    }
  }

  return {
    auth,
    status,
    authError,
    statusError,
    switching,
    signOutError,
    reconnecting,
    reconnectAttempt,
    authRefused,
    needsSignIn,
    switchState,
    loadAuth,
    connect,
    loadStatus,
    startPolling,
    stopPolling,
    setArmed,
    signOut,
  }
}
