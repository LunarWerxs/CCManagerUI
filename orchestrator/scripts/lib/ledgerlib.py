"""ledgerlib - THE ATTEMPT LEDGER: the orchestrator's memory of its own acts.

Rule 3 of the rewrite (README.md): "Count every attempt. An act that has failed N times stops,
loudly, and says why. A deterministic refusal stops after one." v2 had no memory of failure
anywhere, so it hammered the same un-landable archive on 227 chats forever. This file is that
memory.

It is a port of v2's breaker.ts with one extension the postmortem demanded: an attempt can be
recorded as DETERMINISTIC (the same inputs can never succeed - an ambiguous title, a 4xx that
names a permanent condition), and one such attempt suppresses immediately instead of after the
cap.

The law it lives under, unchanged from v2:
  - It bounds the UNATTENDED path only. A deed a person asks for directly is never blocked -
    being asked is the point of asking. Callers express that with force=True, which is still
    RECORDED, just never suppressed.
  - Every suppression is LOUD: the verdict says which act was withheld, how many attempts it
    has seen, and when the window frees up.
  - Success CLEARS the count. The brake exists for futile repetition, not for work that lands.

State lives in <repo>/state/attempts.json (override: ORCHESTRATOR_STATE_DIR). This is the one
piece of state the orchestrator owns, and it is memory of the orchestrator's OWN behaviour,
never of the fleet's - the daemon stays the sole authority on what exists.

Writes are atomic (temp file + os.replace) AND serialized (locked(), below): the file used
to accept the read-modify-write race as "the loser drops the other's rows for one window",
but the adversarial review (2026-08-31) showed the loss is not always benign - a clear()
raced by a stale note() can RESURRECT a deterministic row, permanently suppressing a chat
that provably succeeded. Writers now take the cross-process mutex; readers never need it.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from pathlib import Path

ATTEMPT_CAP = 4
ATTEMPT_WINDOW_MS = 6 * 3600 * 1000

VALID_KINDS = ("archive", "deliver", "surface", "migrate", "rename", "instance", "name",
               "automation", "compact", "preserve",
               # 2026-09-01: the permission-picker route's breaker, and the provenance row a
               # chat gets when the toolbox spawned it (unblock_prompts reads that one)
               "mode", "spawned",
               # 2026-09-04: a probe chat deleted after its drill (delete_chat.py)
               "delete")

# How long a writer may hold the state-file mutex before a waiter treats it as abandoned
# (a crashed process must never wedge every future note() on this machine).
LOCK_STALE_SECS = 30
LOCK_WAIT_SECS = 5


@contextlib.contextmanager
def locked(name: str):
    """A cross-PROCESS mutex for one state file's load-mutate-save (adversarial review,
    2026-08-31: two concurrent writers each rewrite the WHOLE file, so the second save
    silently drops the first one's row - a lost hold, an undercounted breaker). O_CREAT|
    O_EXCL on a sidecar is atomic on Windows and POSIX alike; a lock older than
    LOCK_STALE_SECS is a crashed writer's and is broken loudly, never waited on forever."""
    path = _state_dir() / f".lock-{name}"
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + LOCK_WAIT_SECS
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except (FileExistsError, PermissionError) as err:
            # PermissionError IS contention here, not a permissions problem (measured 2026-09-05:
            # 42 of 1,800 contended acquisitions across 6 threads raised errno 13 on Windows, and
            # every one of them was a crash where a wait was owed). On Windows a deleted file's
            # NAME lingers, pending-delete, until the previous holder's handle closes, and an
            # O_EXCL create landing in that window answers ACCESS_DENIED rather than EEXIST. A
            # state dir that genuinely cannot be written fails the mkdir above, or fails here
            # every time until the deadline, where the error is named.
            if isinstance(err, FileExistsError):
                try:
                    if time.time() - path.stat().st_mtime > LOCK_STALE_SECS:
                        path.unlink()  # a crashed writer's leftovers - break it and retry
                        continue
                except OSError:
                    pass  # it vanished between the check and the stat: just retry
            if time.time() > deadline:
                raise TimeoutError(
                    f"could not take the '{name}' state lock within {LOCK_WAIT_SECS}s "
                    f"(last answer: {type(err).__name__}) - another writer is wedged; "
                    "investigate rather than clobbering"
                ) from None
            time.sleep(0.01)
    try:
        yield
    finally:
        try:
            path.unlink()
        except OSError:
            pass


@contextlib.contextmanager
def try_locked(name: str, stale_secs: int = LOCK_STALE_SECS):
    """The NON-BLOCKING sibling of locked(): yields True when this process took the named lock,
    False when another live holder has it - the caller skips or defers, never waits. For an
    ACT that must not run twice for one subject (an archive run per chat), where the right
    answer to "someone else is on it" is to step back, not to queue behind them. A stale lock
    (crashed holder, older than stale_secs) is broken and retaken, exactly as locked().

    stale_secs defaults to LOCK_STALE_SECS (30s), right for a quick state-file mutation, but
    an ACT holding this lock for its whole duration needs its own, longer window: 30s let a
    second concurrent archive_chat invocation decide the first one's holder was crashed and
    steal the lock mid-act (the actuator alone runs up to 240s), running the preserve/archive
    rails twice on one chat (adversarial review, 2026-09-01)."""
    path = _state_dir() / f".lock-{name}"
    path.parent.mkdir(parents=True, exist_ok=True)
    held = False
    # A handful of attempts, not two: on Windows the previous holder's unlink leaves the name
    # pending-delete for a few microseconds, during which the O_EXCL create answers
    # PermissionError (see locked()). That is "wait a tick", not "someone holds it", so it gets a
    # few short retries before this reports not-ours; a real holder still answers EEXIST at once.
    for attempt in range(6):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            held = True
            break
        except PermissionError:
            time.sleep(0.005)
            continue
        except FileExistsError:
            try:
                if attempt == 0 and time.time() - path.stat().st_mtime > stale_secs:
                    path.unlink()
                    continue
            except OSError:
                continue  # it vanished between the check and the stat: retry once
            break
    try:
        yield held
    finally:
        if held:
            try:
                path.unlink()
            except OSError:
                pass


def _state_dir() -> Path:
    env = os.environ.get("ORCHESTRATOR_STATE_DIR")
    if env:
        return Path(env)
    # <repo>/state. ⚠ Count the parents from THIS FILE's real home (scripts/lib/): the lib
    # reorg moved this file one level deeper and the old parent.parent silently became
    # scripts/state - a second, wrong state dir that quietly split the ledger from the
    # scheduler's logs/locks (found live 2026-08-31 when deliveries.json "did not exist").
    return Path(__file__).resolve().parents[2] / "state"


def _ledger_path() -> Path:
    return _state_dir() / "attempts.json"


def _load() -> list[dict]:
    try:
        raw = json.loads(_ledger_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    rows = raw.get("attempts", []) if isinstance(raw, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def _save(rows: list[dict]) -> None:
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique temp name per writer: a FIXED name let two concurrent processes interleave bytes
    # into the same temp file, and the mangled JSON then read back as an EMPTY ledger - wiping
    # every count the brake depends on (review finding, 2026-08-31). os.replace stays atomic.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"attempts": rows}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _mine(rows: list[dict], kind: str, session_id: str, now_ms: int) -> list[dict]:
    """This (kind, session)'s rows that still count: everything inside the sliding window,
    PLUS every deterministic row regardless of age - an ambiguous title does not stop being
    ambiguous because six hours passed, and letting the row age out re-opened exactly the
    'retried things that could never work' loop (review finding, 2026-08-31). A deterministic
    row leaves the ledger only through clear() - success, or a person's word."""
    floor = now_ms - ATTEMPT_WINDOW_MS
    return [
        r
        for r in rows
        if r.get("kind") == kind
        and r.get("session") == session_id
        and (r.get("at", 0) >= floor or r.get("deterministic"))
    ]


def check(kind: str, session_id: str, now_ms: int | None = None, _rows: list[dict] | None = None) -> dict:
    """Should the unattended machinery skip this act right now? Read-only.

    Returns {suppressed, attempts, deterministic, retry_after, why}. Call note() when the act
    actually goes ahead - checking is not attempting.
    """
    if kind not in VALID_KINDS:
        # note() already refuses unknown kinds; a check() that silently answered 'not
        # suppressed, 0 attempts' for a typo'd kind would un-count every recorded attempt.
        raise ValueError(f"unknown breaker kind {kind!r} - new acts must opt in deliberately")
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    mine = _mine(_rows if _rows is not None else _load(), kind, session_id, now_ms)
    det = [r for r in mine if r.get("deterministic")]
    if det:
        return {
            "suppressed": True,
            "attempts": len(mine),
            "deterministic": True,
            "retry_after": None,
            "why": (
                f"a previous '{kind}' on this chat failed DETERMINISTICALLY "
                f"({det[-1].get('note') or 'same inputs can never succeed'}) - retrying is futile "
                "until something about the chat changes. A direct request from a person is never "
                f"blocked by this; once the condition is fixed, clear it with: "
                f"python scripts/attempts.py --clear {kind} {session_id}"
            ),
        }
    if len(mine) < ATTEMPT_CAP:
        return {
            "suppressed": False,
            "attempts": len(mine),
            "deterministic": False,
            "retry_after": None,
            "why": f"{len(mine)} of {ATTEMPT_CAP} attempts used in the last {ATTEMPT_WINDOW_MS // 3600_000}h",
        }
    oldest = min(r.get("at", now_ms) for r in mine)
    retry_after = oldest + ATTEMPT_WINDOW_MS
    return {
        "suppressed": True,
        "attempts": len(mine),
        "deterministic": False,
        "retry_after": retry_after,
        "why": (
            f"'{kind}' has been attempted {len(mine)} times on this chat in the last "
            f"{ATTEMPT_WINDOW_MS // 3600_000}h without sticking - suppressed so the machinery "
            "stops repeating a futile cycle. A direct request from a person is never blocked by this."
        ),
    }


def note(
    kind: str,
    session_id: str,
    *,
    deterministic: bool = False,
    note: str = "",
    now_ms: int | None = None,
    error: str | None = None,
) -> None:
    """Record that an act went ahead (or was refused deterministically). One row per attempt,
    always - v2 once keyed on (kind, session, timestamp) and merged same-millisecond attempts,
    under-counting exactly the tight loop the counter exists to catch.

    A DETERMINISTIC attempt is always a genuine failure ("same inputs can never succeed"), so
    it is also filed as an INCIDENT (lib/incidentlib.py), grouped by its normalized cause
    instead of sitting as one more anonymous row in this ledger - `error` (or `note`'s text,
    when none is given) is the cause text. The row records which incident it belongs to
    (`incident`), so the two can be joined. `error` also files an incident for an ORDINARY
    (non-deterministic) attempt when a caller already knows the cause; without it, an ordinary
    attempt files nothing here - it may still fail, but that is annotate()'s job
    (`failure=True`) once the outcome is known."""
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown breaker kind {kind!r} - new acts must opt in deliberately")
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    fail_text = error or (note if deterministic else None)
    incident_id = None
    if fail_text:
        from lib import incidentlib  # local: incidentlib imports this module, so import here

        incident_id = incidentlib.record(kind, session_id, fail_text)
    with locked("attempts"):
        # Window-prune ordinary attempts only; deterministic rows persist until clear().
        rows = [
            r
            for r in _load()
            if r.get("at", 0) >= now_ms - ATTEMPT_WINDOW_MS or r.get("deterministic")
        ]
        rows.append(
            {
                "kind": kind,
                "session": session_id,
                "at": now_ms,
                "deterministic": bool(deterministic),
                "note": note,
                "incident": incident_id,
            }
        )
        _save(rows)


def annotate(kind: str, session_id: str, outcome: str, now_ms: int | None = None, *,
             failure: bool = False) -> None:
    """Attach the OUTCOME to the most recent attempt row. Adds no row, so the count is safe.

    ⛔ NEVER record a failure by calling note() a second time. The counter is "one row per
    attempt" on purpose (see note), so a second row per failure would make the breaker trip
    at half its intended number - turning a diagnostic into a new bug.

    THE HOLE THIS FILLS (2026-09-01): the breaker knew a chat had failed four times in six
    hours and suppressed it, correctly. But the rows behind that verdict read only
    "deliver <id> to '<title>'" - the reason lived in the DELIVERY record, which the breaker
    never shows - so four chats on one account sat unreachable with no way to tell whether
    the app was shut, the row was ambiguous, or the text never matched. A brake that stops
    the machine without saying what it hit sends you guessing; every stop should carry its
    reason.

    `failure=True` marks this outcome as a genuine failure (not merely informational): it also
    files an INCIDENT (lib/incidentlib.py) for (kind, session_id) - grouping this failure with
    every other one that shares its normalized cause - and stamps the matched row's `incident`
    field. Most annotate() calls are asides on an attempt that is still succeeding (e.g.
    migrate_chat noting which idle engine it stopped along the way) and pass nothing; only a
    caller that KNOWS the outcome is a failure sets this explicitly - guessing from the outcome
    TEXT would misfire on rows like "landed ... but the source row is still visible", which
    names a real failure without the word "fail" anywhere in it.
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown breaker kind {kind!r} - new acts must opt in deliberately")
    incident_id = None
    if failure:
        from lib import incidentlib  # local: incidentlib imports this module, so import here

        incident_id = incidentlib.record(kind, session_id, outcome)
    with locked("attempts"):
        rows = _load()
        for r in reversed(rows):
            if r.get("kind") == kind and r.get("session") == session_id:
                r["outcome"] = str(outcome)[:400]
                if incident_id:
                    r["incident"] = incident_id
                _save(rows)
                return


def verify(
    kind: str,
    session_id: str,
    verified: bool | None,
    note: str = "",
    now_ms: int | None = None,
) -> None:
    """Attach the READ-BACK verdict to the most recent attempt row. Adds no row, same shape as
    annotate() and for the same reason (a second row per outcome would trip the breaker at half
    its intended count).

    This repo's own rule 4 (README.md): "never claim an act landed without checking."
    NousResearch/hermes-agent's cron/delivery_queue.py (MIT) documents the same discipline for a
    different problem, and reading it is what prompted writing this; no code is shared. Three
    verdicts, and they are NOT interchangeable:
      - True  - the target's state was re-read AFTER acting and it shows the change.
      - False - the target's state was re-read and it does NOT show the change. Counts as a
                failed attempt like any other (it already has a row from note()); it does not
                add a second one.
      - None  - UNKNOWN: the read-back itself could not be performed (the verifying call
                failed, timed out, or the caller had no way to check at all). ⛔ Never treat
                this as success, never clear() the breaker on it, and never let it retry
                silently - a provably-never-attempted row may be re-queued, but one whose
                outcome is unknown must surface for a person, exactly the delivery_queue.py
                distinction this ports.
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown breaker kind {kind!r} - new acts must opt in deliberately")
    if verified is not None and not isinstance(verified, bool):
        raise TypeError("verified must be True, False, or None (unknown) - not a truthy value")
    with locked("attempts"):
        rows = _load()
        for r in reversed(rows):
            if r.get("kind") == kind and r.get("session") == session_id:
                r["verified"] = verified
                if note:
                    r["verify_note"] = str(note)[:400]
                _save(rows)
                return
    # No row to attach to: the caller verified something note() never opened a row for. Rather
    # than silently drop an unknown-outcome verdict (the one this doctrine cares about most),
    # open one directly so it still surfaces below.
    with locked("attempts"):
        rows = _load()
        rows.append({
            "kind": kind, "session": session_id, "at": now_ms or int(time.time() * 1000),
            "deterministic": False, "note": "", "verified": verified,
            **({"verify_note": str(note)[:400]} if note else {}),
        })
        _save(rows)


def unverified(now_ms: int | None = None, within_ms: int = ATTEMPT_WINDOW_MS) -> list[dict]:
    """Every recent act whose verified field is unknown (None) or explicitly False - the
    judgment queue this doctrine feeds. `verified` absent (an act that never called verify(), or
    ran before this existed) counts as unknown too: no positive evidence is no positive
    evidence, whether that is because nobody checked or because nobody could. Never confuses
    this with `suppressed()` above, which is about the BREAKER tripping, not about whether an
    act's outcome was ever confirmed - a chat can be unverified without ever having been
    suppressed, and vice versa."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    floor = now_ms - within_ms
    _MISSING = object()  # tell "never checked" apart from an explicit verified=None (also unknown)
    out = []
    for r in _load():
        at = r.get("at", 0)
        if at < floor:
            continue
        v = r.get("verified", _MISSING)
        if v is True:
            continue  # confirmed - not the judgment queue's business
        out.append({
            "kind": r.get("kind"),
            "session": r.get("session"),
            "at": at,
            # False is a CONFIRMED disagreement, distinct from "unknown" (never checked, or the
            # check itself couldn't run) - the doctrine this ports treats them differently: false
            # already counts as a failed attempt, unknown must never be retried at all.
            "status": "false" if v is False else "unknown",
            "note": r.get("note") or "",
            "verify_note": r.get("verify_note") or "",
        })
    return out


def clear(kind: str, session_id: str) -> None:
    """The act stuck: forget the history. The brake is for futility, not for work."""
    with locked("attempts"):
        rows = [
            r for r in _load() if not (r.get("kind") == kind and r.get("session") == session_id)
        ]
        _save(rows)


def suppressed(now_ms: int | None = None) -> list[dict]:
    """Every (kind, chat) currently held back - for status surfaces. Loud, never silent.

    Loads the ledger ONCE and hands it to check() - one read, however many pairs. Rows whose
    kind is no longer registered are reported as their own entry rather than crashing or being
    silently skipped: an unreadable suppression is still a suppression."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    rows = _load()
    seen: dict[tuple[str, str], None] = {}
    out = []
    for r in rows:
        key = (str(r.get("kind")), str(r.get("session")))
        if key in seen:
            continue
        seen[key] = None
        if key[0] not in VALID_KINDS:
            out.append({
                "kind": key[0], "session": key[1], "suppressed": True, "attempts": None,
                "deterministic": None, "retry_after": None,
                "why": f"ledger holds rows under UNKNOWN kind {key[0]!r} - a retired or typo'd "
                       "act name; investigate rather than ignore",
            })
            continue
        verdict = check(key[0], key[1], now_ms, _rows=rows)
        if verdict["suppressed"]:
            out.append({"kind": key[0], "session": key[1], **verdict})
    return out
