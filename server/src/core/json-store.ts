// server/src/core/json-store.ts — the ONE way a JSON registry is read and mutated.
//
// WHY THIS EXISTS (audit AH-01, 2026-09-05): the CLI and Codex instance registries each did their
// own `JSON.parse(readFileSync(...))` inside a try/catch that returned an EMPTY store on ANY
// failure, and their writers overwrote the file in place. Reproduced against the real functions:
// a malformed `cli-instances.json` holding an existing id, followed by one create, came back
// `ok: true` with a fresh file that held only the new record. The damaged registry - and every
// managed identity in it - was gone, with a success message. A store that cannot be read is not
// an empty store; treating the two alike is how a transient read error turns into data loss.
//
// Three problems, three separate answers, because they are not interchangeable:
//
//   * MISSING vs CORRUPT vs UNREADABLE  -> `readJsonStore` returns which, and never guesses.
//     Readers may degrade (an empty list with a logged reason); MUTATORS MUST REFUSE, leaving the
//     bytes exactly as found so the owner can repair them.
//   * A WRITE INTERRUPTED HALFWAY       -> `writeJsonStoreAtomic`: temp file beside the target,
//     then `renameSync`, which is atomic on the same volume. A crash before the rename leaves the
//     previous valid file in place; there is no moment where the registry is half-written.
//   * TWO WRITERS AT ONCE               -> `mutateJsonStore` holds an interprocess lock around
//     read-modify-write. Within one process every mutation is synchronous, so JS's single thread
//     already serializes them; the lock is for the OTHER process - the quick-instance daemon
//     (instance-mode.ts) writes the same files as the main daemon, and last-writer-wins between
//     two processes silently drops whichever record landed first.
//
// The lock is a file created with O_EXCL. It records the holder's pid and time so a lock left by
// a crashed process is broken (dead pid, or older than STALE_LOCK_MS) instead of wedging every
// later write. Waiting is a bounded synchronous spin: hold times are a few milliseconds, the wait
// cap is seconds, and a mutation that cannot get the lock refuses rather than proceeding unlocked.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** What a read found. `raw` is the exact file text, kept so a corrupt store can be reported and
 *  preserved rather than described from memory. */
export type JsonStoreRead<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T; raw: string }
  | { status: 'corrupt'; reason: string; raw: string }
  | { status: 'unreadable'; reason: string }

export interface JsonStoreSpec<T> {
  /** Absolute path of the registry file. */
  path: string
  /** Turn parsed JSON into the typed store, or return null when the shape is not this store's.
   *  A null here is CORRUPT, not empty: the file parsed but does not describe this registry. */
  decode: (parsed: unknown) => T | null
  /** A fresh empty store, used ONLY when the file does not exist. Built per call so a caller
   *  mutating what it gets back can never poison the next read. */
  empty: () => T
}

/** How long a mutator will wait for another writer before refusing. */
const LOCK_WAIT_MS = 5_000
/** Sleep between lock attempts. Hold times are single-digit milliseconds. */
const LOCK_POLL_MS = 5
/** A lock older than this is assumed abandoned even if its pid cannot be probed. */
const STALE_LOCK_MS = 30_000
/** How long a read of the store itself is retried through Windows' transient access errors. */
const READ_RETRY_MS = 250
/** Same for the rename that publishes a write; a little longer because it is the one that costs
 *  a whole mutation if it gives up. */
const RENAME_RETRY_MS = 1_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined
}

/** The codes Windows returns for "someone has this open right now" rather than "you may not". A
 *  file another process is deleting, or that Defender/the indexer is scanning, answers with one of
 *  these for a few milliseconds; on POSIX they essentially never occur for our own files. */
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Run `fn`, retrying only on the transient codes above, for at most `budgetMs`. Any other error,
 *  or the same transient one past the budget, is rethrown as-is. */
function retryTransient<T>(fn: () => T, budgetMs: number): T {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      return fn()
    } catch (err) {
      const code = errorCode(err)
      if (!code || !TRANSIENT_CODES.has(code) || Date.now() >= deadline) throw err
      sleepSync(10)
    }
  }
}

/**
 * Read a registry, saying WHICH failure happened when one did.
 *
 * Transient access errors are retried briefly (see retryTransient): on Windows a reader can land
 * exactly on another process's rename and see the file as momentarily inaccessible. Anything
 * persistent is reported as unreadable, never as empty.
 */
export function readJsonStore<T>(spec: JsonStoreSpec<T>): JsonStoreRead<T> {
  let raw: string
  try {
    raw = retryTransient(() => readFileSync(spec.path, 'utf8'), READ_RETRY_MS)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', reason: `${code ?? 'read failed'}: ${errorMessage(err)}` }
  }
  // An empty file is not a missing file: something truncated it (a crash mid-write predating the
  // atomic path, a disk-full). It holds no records we can prove, so it is corrupt, not empty.
  if (!raw.trim()) return { status: 'corrupt', reason: 'file is empty', raw }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: 'corrupt', reason: `invalid JSON: ${errorMessage(err)}`, raw }
  }
  const value = spec.decode(parsed)
  if (value === null)
    return { status: 'corrupt', reason: 'JSON does not have this store’s shape', raw }
  return { status: 'ok', value, raw }
}

/**
 * Replace the registry atomically: write beside it, then rename over it.
 *
 * The temp name carries pid + time + a random tail so two processes writing the same store can
 * never collide on the scratch file either (the reason `.trust.tmp`-style fixed names are a bug).
 * Throws on failure; the caller decides how to report it. A failed write never leaves a partial
 * target because the target is only ever touched by the rename.
 */
export function writeJsonStoreAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    // The rename is retried on the codes Windows hands out while something else briefly holds the
    // destination (Defender scanning the file a previous write just produced, the search indexer).
    // graceful-fs does the same for the same reason. Bounded: a genuinely locked file still fails.
    retryTransient(() => renameSync(tmp, path), RENAME_RETRY_MS)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // The rename may have consumed it already; nothing to clean.
    }
    throw err
  }
}

export type JsonStoreMutation<R> =
  | { ok: true; result: R }
  | { ok: false; status: 'corrupt' | 'unreadable' | 'locked' | 'write-failed'; reason: string }

/**
 * Read-modify-write under the interprocess lock.
 *
 * `fn` receives the CURRENT store (a fresh decode, taken after the lock is held, so it cannot be a
 * snapshot another process has since replaced) and returns `{ result, changed }`. The file is
 * rewritten only when `changed` is true, so a mutation that found nothing to do costs no write.
 *
 * Refuses - without calling `fn` and without touching the file - when the store is corrupt or
 * unreadable, or when the lock cannot be obtained in time. The caller turns that into its own
 * status-carrying result; this layer never throws for those.
 */
export function mutateJsonStore<T, R>(
  spec: JsonStoreSpec<T>,
  fn: (store: T) => { result: R; changed: boolean },
): JsonStoreMutation<R> {
  const lock = acquireLock(spec.path)
  if (!lock.ok) return { ok: false, status: 'locked', reason: lock.reason }
  try {
    const read = readJsonStore(spec)
    if (read.status === 'corrupt' || read.status === 'unreadable') {
      return { ok: false, status: read.status, reason: read.reason }
    }
    const store = read.status === 'ok' ? read.value : spec.empty()
    const { result, changed } = fn(store)
    if (changed) {
      try {
        writeJsonStoreAtomic(spec.path, store)
      } catch (err) {
        return { ok: false, status: 'write-failed', reason: errorMessage(err) }
      }
    }
    return { ok: true, result }
  } finally {
    lock.release()
  }
}

/** One human sentence for a refused mutation, shared so every registry says the same thing. */
export function describeStoreRefusal(
  what: string,
  path: string,
  failure: { status: 'corrupt' | 'unreadable' | 'locked' | 'write-failed'; reason: string },
): string {
  switch (failure.status) {
    case 'corrupt':
      return `Refusing to modify the ${what}: '${path}' is not a valid registry (${failure.reason}). It was left untouched so nothing in it is lost; move it aside or repair it, then retry.`
    case 'unreadable':
      return `Refusing to modify the ${what}: '${path}' could not be read (${failure.reason}). It was left untouched; check its permissions, then retry.`
    case 'locked':
      return `The ${what} at '${path}' is being written by another process (${failure.reason}). Nothing was changed; retry in a moment.`
    case 'write-failed':
      return `Could not write the ${what} at '${path}' (${failure.reason}). The previous registry is intact; nothing was changed.`
  }
}

// --- interprocess lock -----------------------------------------------------------------------

type LockHandle = { ok: true; release: () => void } | { ok: false; reason: string }

function lockPathFor(path: string): string {
  return `${path}.lock`
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH: no such process. Anything else (EPERM: it exists but is not ours) means alive.
    return errorCode(err) !== 'ESRCH'
  }
}

/** Break a lock whose holder is provably gone, or which is simply too old to be a live write. */
function breakIfStale(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    let holder: { pid?: unknown; at?: unknown } = {}
    try {
      holder = JSON.parse(raw) as { pid?: unknown; at?: unknown }
    } catch {
      // Unparseable lock: fall through to the age test below.
    }
    const pid = typeof holder.pid === 'number' ? holder.pid : Number.NaN
    const at = typeof holder.at === 'number' ? holder.at : statSync(lockPath).mtimeMs
    const tooOld = Date.now() - at > STALE_LOCK_MS
    const holderDead = Number.isFinite(pid) && pid !== process.pid && !pidAlive(pid)
    if (!tooOld && !holderDead) return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    // Vanished between our attempt and this read - the holder released it. Nothing to break.
    return true
  }
}

function acquireLock(path: string): LockHandle {
  const lockPath = lockPathFor(path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  let lastError = ''
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      return {
        ok: true,
        release: () => {
          try {
            rmSync(lockPath, { force: true })
          } catch {
            // Best effort: a lock we cannot remove is broken by the next writer's stale check.
          }
        },
      }
    } catch (err) {
      const code = errorCode(err)
      // EEXIST is the ordinary "someone holds it". Windows ALSO answers EPERM/EACCES/EBUSY when
      // the previous holder's lock file is mid-delete (its name lingers, pending-delete, for the
      // few microseconds between their rmSync and the handle closing) - measured 3 times in 25
      // runs of the two-process test. That is contention too, not a permission problem, so it
      // waits like EEXIST does; only a code outside both sets (a missing or read-only dir) fails.
      if (code !== 'EEXIST' && !(code && TRANSIENT_CODES.has(code))) {
        return { ok: false, reason: `${code ?? 'lock failed'}: ${errorMessage(err)}` }
      }
      lastError = code === 'EEXIST' ? 'lock held' : `lock file transiently ${code}`
      if (code === 'EEXIST' && breakIfStale(lockPath)) continue
      if (Date.now() >= deadline) {
        return { ok: false, reason: `${lastError} for more than ${LOCK_WAIT_MS} ms` }
      }
      sleepSync(LOCK_POLL_MS)
    }
  }
}

/** A synchronous sleep that works under Bun and Node alike (Atomics.wait on a private buffer). */
const sleepCell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms)
}
