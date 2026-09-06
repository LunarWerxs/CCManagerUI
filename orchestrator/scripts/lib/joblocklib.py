"""joblocklib - PROOF-OF-DEATH locks for the scheduled lanes (audit item AH-16).

schedule_jobs.py's old per-job lock was a bare mkdir'd directory reclaimed purely by AGE
(a lock older than 30 minutes was removed, no check of who held it or whether it was still
working). That let a second wrapper invocation steal a legitimate long-running job's lock
once it crossed 30 minutes, and then the ORIGINAL holder, on its own eventual exit,
unconditionally rmdir'd the lock directory - deleting its successor's lock too.

This module fixes both halves:
  - a lock records its owner's PID *and* that PID's OS process-creation time, so a PID the
    OS later hands to an unrelated process can never be mistaken for the original owner;
  - a waiter may reclaim the lock only when the recorded PID is PROVABLY not running that
    same process any more. An inconclusive check (we could not determine liveness) is
    treated as "still alive" - unknown process state must never authorize a takeover;
  - only the token that took the lock may release it, so an old holder that outlives its
    own reclaim can never unlink whatever newer holder replaced it;
  - the holder refreshes a heartbeat timestamp while it runs, for observability (--status
    can show how fresh a live lock is) - it is not itself what authorizes reclaim.

The read-check-write around reclaiming and releasing goes through ledgerlib.locked(), the
existing cross-process mutex the attempt ledger already uses, rather than inventing a
second locking primitive for the same problem.
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from lib import ledgerlib

HEARTBEAT_SECS = 10


def _state_dir() -> Path:
    env = os.environ.get("ORCHESTRATOR_STATE_DIR")
    if env:
        return Path(env)
    # <repo>/state, matching ledgerlib._state_dir() (this file also lives in scripts/lib/).
    return Path(__file__).resolve().parents[2] / "state"


def _lock_dir(job: str) -> Path:
    return _state_dir() / "locks" / job


def _owner_path(job: str) -> Path:
    return _lock_dir(job) / "owner.json"


def _process_start_time(pid: int) -> float | None:
    """The OS's own record of when `pid` was created (Unix epoch seconds), or None if the PID
    cannot be opened at all right now - which reads as 'not running' to callers, since a PID
    that cannot be opened for even a liveness query is not a process anyone can be racing."""
    if os.name != "nt" or pid <= 0:
        return None
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        creation = ctypes.c_uint64()
        exit_t = ctypes.c_uint64()
        kernel_t = ctypes.c_uint64()
        user_t = ctypes.c_uint64()
        ok = kernel32.GetProcessTimes(
            handle, ctypes.byref(creation), ctypes.byref(exit_t),
            ctypes.byref(kernel_t), ctypes.byref(user_t),
        )
        if not ok:
            return None
        # FILETIME: 100ns ticks since 1601-01-01 -> Unix epoch seconds.
        return (creation.value - 116444736000000000) / 10_000_000
    finally:
        kernel32.CloseHandle(handle)


def _owner_alive(pid: int, started_at: float | None) -> bool | None:
    """True: `pid` is running and is the same process that took the lock (its creation time
    matches what we recorded, so a PID the OS reused for something else cannot impersonate the
    original owner). False: PROVABLY not the same process any more - the PID does not exist, or
    it exists but is a different process now. None: could not be determined (non-Windows, or an
    OpenProcess failure we cannot attribute to 'gone', e.g. permissions) - callers must never
    reclaim on None."""
    if os.name != "nt":
        return None
    now_start = _process_start_time(pid)
    if now_start is None:
        return False  # the PID does not exist right now - provably gone
    if started_at is None:
        return None  # no creation time was ever recorded to compare against - unknown
    return abs(now_start - started_at) < 2.0  # FILETIME/float rounding slack


@dataclass
class Lock:
    job: str
    token: str
    _hb_stop: "threading.Event | None" = field(default=None, repr=False)
    _hb_thread: "threading.Thread | None" = field(default=None, repr=False)

    def heartbeat_once(self) -> None:
        """Refresh the heartbeat timestamp, but only while this token still owns the lock -
        never write a heartbeat over a lock that was reclaimed out from under this holder."""
        path = _owner_path(self.job)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return
        if data.get("token") != self.token:
            return
        data["heartbeat"] = time.time()
        tmp = path.with_name(f"owner.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)

    def start_heartbeat(self, interval: float = HEARTBEAT_SECS) -> None:
        self._hb_stop = threading.Event()

        def _loop() -> None:
            while not self._hb_stop.wait(interval):
                self.heartbeat_once()

        self._hb_thread = threading.Thread(target=_loop, daemon=True)
        self._hb_thread.start()

    def release(self) -> bool:
        """Release the lock, but ONLY if this token still owns it (AH-16: an old holder must
        never unlink a newer holder's lock). Returns whether this call actually removed it."""
        if self._hb_stop is not None:
            self._hb_stop.set()
        with ledgerlib.locked(f"joblock-{self.job}"):
            path = _owner_path(self.job)
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                return False
            if data.get("token") != self.token:
                return False
            shutil.rmtree(_lock_dir(self.job), ignore_errors=True)
            return True


def acquire(job: str) -> "Lock | None":
    """Take the job lock, or return None when a live owner already holds it (or ownership
    could not be proven dead). Never blocks - callers are 5-minute-tick lanes, and the right
    answer to contention is 'skip this tick', the same posture as ledgerlib.try_locked()."""
    with ledgerlib.locked(f"joblock-{job}"):
        d = _lock_dir(job)
        owner = _owner_path(job)
        if d.is_dir() and owner.exists():
            data = None
            try:
                data = json.loads(owner.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                data = None
            if data is not None:
                alive = _owner_alive(int(data.get("pid") or -1), data.get("started_at"))
                if alive is not False:
                    # True (confirmed running) or None (unproven) - never reclaim either way.
                    return None
            # data is None (unreadable owner file) or alive is False: provably not the same
            # live process any more. Fall through and reclaim.
        d.mkdir(parents=True, exist_ok=True)
        token = uuid4().hex
        pid = os.getpid()
        payload = {
            "job": job,
            "pid": pid,
            "token": token,
            "started_at": _process_start_time(pid),
            "heartbeat": time.time(),
            "acquired_at": time.time(),
        }
        tmp = owner.with_name(f"owner.{pid}.tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp, owner)
        return Lock(job=job, token=token)
