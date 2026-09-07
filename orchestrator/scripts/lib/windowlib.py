"""windowlib - put a desktop window back the way the owner had it.

WHY (owner, 2026-09-01: "often I'm noticing you end up full screening the desktop instance for
some reason - we should stop that from happening").

WHAT WAS MEASURED, because the first two guesses were wrong: firing `claude://resume?session=`
at a running instance left its placement byte-identical (showCmd 1, same rect), and so did
`claude://code/new`. So the toolbox's two deeplink routes do NOT maximize anything on their
own, and this is NOT the fix for a cause we understood - it is a guard for one we did not
fully catch. What remains is the app's own second-instance handling and its fresh-start
placement, neither of which we can switch off from outside.

So the guard is the considerate thing rather than the clever one: note how the window was
before we poke the app, put it back if it changed, and LEAVE A LINE IN THE LOG when it had to.
That line is the evidence the next occurrence needs - if a route really does maximize a window,
this names it instead of the owner having to notice it again.

⛔ It restores placement ONLY. It never raises, focuses, moves or resizes a window on its own,
never touches one the owner has minimized in the meantime, and does nothing at all when the
placement is unchanged - which, per the measurement above, is the normal case.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from uuid import uuid4

from lib import clilib, joblocklib

ACTUATOR = Path(__file__).resolve().parents[1] / "actuator" / "window_placement.ps1"
# THE LAST-RESORT BACKSTOP, not the reclaim rule. A UI lock is reclaimed on PROOF that its
# owner is gone (see _may_reclaim); age is consulted only where no proof is obtainable - an
# owner-less lock left by an older build, or a platform whose liveness we cannot read - so
# that a crash cannot wedge one window's lane forever. It is the worst case of the send
# pipeline (a daemon message call of CONFIRM_SECS+120s plus a CONFIRM_SECS actuator confirm,
# ~7 min), doubled.
UI_LOCK_STALE_SECS = 15 * 60


def _lock_key(instance: str | None) -> str:
    """One key per instance whether the caller names it ('5claude') or paths it
    ('C:\\...\\.claude-instances\\5claude') - both shapes reach the lanes."""
    s = str(instance or "").strip()
    if "/" in s or chr(92) in s:
        s = Path(s).name
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or "unknown"


# The window keys THIS PROCESS already holds, so instance_lock is RE-ENTRANT within one process.
#
# ⛔ THIS IS LOAD-BEARING, not a convenience. The lanes call each other IN-PROCESS: the naming
# pass holds a window's lock for its whole run and then reaches rename_chat.main directly
# (name_chats._daemon_rename), which takes the same lock again for the same window. Without
# re-entry the second take finds a live owner - itself - and correctly refuses, so every rename
# inside a naming pass would stall its full wait_secs and come back "the window is busy". A lock
# that deadlocks its own holder looks exactly like the contention it was added to report.
#
# Re-entering is safe because one process drives one window at a time by construction; what this
# lock guards against is another PROCESS. A nested take yields True without claiming or releasing
# anything, so the outermost holder still owns the record and still gives it back exactly once.
_HELD_KEYS: set[str] = set()


def _owner_alive(pid: int, started_at: float | None) -> bool | None:
    """Is the process that took the lock still that same process?

    ONE proof-of-death implementation for the whole toolbox - joblocklib's (AH-16) - reached
    through a name THIS module owns so a test can drive all three answers without spawning
    processes. It records a PID *and* that PID's OS creation time, so a PID the OS later hands
    to something unrelated can never impersonate the original holder.

    True: still running, same process. False: PROVABLY not - the PID is gone, or it is a
    different process now. None: could not be determined (not Windows, or an OpenProcess
    failure we cannot read as 'gone'). ⛔ None is NOT permission to take over.
    """
    return joblocklib._owner_alive(pid, started_at)


def _read_owner(path: Path) -> dict | None:
    """The holder's record, or None when there is no readable one (a lock from a build before
    this file existed, or a claim caught between its mkdir and its write)."""
    try:
        data = json.loads((path / "owner.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _may_reclaim(owner: dict | None, age_secs: float) -> bool:
    """Whether a waiter may break an existing UI lock. THE POINT OF THE WHOLE FILE.

    The old rule was age alone: a lock older than UI_LOCK_STALE_SECS was removed with no check
    of who held it or whether it was still driving. A window driver that legitimately ran long
    - a 240s actuator behind a slow confirm, several of them - therefore had its lock stolen
    while it was mid-gesture, and two lanes then drove one Electron window: the interleaved
    sidebar click this lock exists to prevent, arriving from the guard itself.

    So proof comes first and age is only the fallback where no proof exists:
      alive True  -> refuse, whatever the age says. A living owner is never stale.
      alive False -> reclaim now. It is provably gone; waiting out the clock helps nobody.
      unknown     -> age only, so a crash on a platform we cannot read cannot wedge the lane.
    """
    if owner is not None:
        try:
            pid = int(owner.get("pid") or -1)
        except (TypeError, ValueError):
            pid = -1
        started = owner.get("started_at")
        alive = _owner_alive(pid, started if isinstance(started, (int, float)) else None)
        if alive is True:
            return False
        if alive is False:
            return True
    return age_secs > UI_LOCK_STALE_SECS


def _ui_mutex(key: str):
    """The cross-process mutex the reclaim decision runs inside, so two waiters that both find
    a dead owner cannot both break and retake the lock and both believe they hold it. Same
    primitive the attempt ledger and joblocklib already use - not a second one for one job.

    It waits at most ledgerlib.LOCK_WAIT_SECS and then raises TimeoutError, which IS an OSError
    subclass - that is why the two callers below can suppress OSError and mean it. A wedged
    state lock therefore reads as "the holder stands" (refuse) and as "do not delete" (release),
    both of which are the safe answer, and instance_lock keeps its promise never to raise.
    """
    from lib import ledgerlib

    return ledgerlib.locked(f"uilock-{key}")


def _claim(path: Path, instance: str, token: str) -> None:
    """Stamp who we are into a lock directory we just created. Best effort: a lock we hold but
    could not stamp is still ours to release (see _release), and failing the caller's window
    poke over an unwritable state dir would be the courtesy breaking the work again."""
    payload = {
        "instance": str(instance),
        "pid": os.getpid(),
        "token": token,
        "started_at": joblocklib._process_start_time(os.getpid()),
        "acquired_at": time.time(),
    }
    with contextlib.suppress(OSError):
        tmp = path / f"owner.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp, path / "owner.json")


def _age_of(path: Path, owner: dict | None) -> float:
    """How long the lock has stood, from the holder's own record where there is one and the
    directory's mtime where there is not."""
    if owner is not None and isinstance(owner.get("acquired_at"), (int, float)):
        return time.time() - float(owner["acquired_at"])
    try:
        return time.time() - path.stat().st_mtime
    except OSError:
        return 0.0


def _reclaim_if_dead(path: Path, key: str, instance: str, token: str) -> bool | None:
    """One attempt at taking a lock somebody else already holds, inside the mutex.

    True: the holder was provably gone (or unprovable past the backstop) and the lock is OURS
    now. False: the holder stands - wait. None: the lock vanished while we looked, so the plain
    mkdir is worth another try immediately.
    """
    with contextlib.suppress(OSError), _ui_mutex(key):
        if not path.is_dir():
            return None
        owner = _read_owner(path)
        if not _may_reclaim(owner, _age_of(path, owner)):
            return False
        shutil.rmtree(path, ignore_errors=True)
        try:
            path.mkdir()
        except OSError:
            return None  # somebody won the race between our rmtree and our mkdir
        _claim(path, instance, token)
        return True
    return False


def _release(path: Path, key: str, token: str) -> None:
    """Give the lock back, but ONLY if it is still ours.

    AH-16's second half, which cost more than the first: the old holder rmdir'd its lock
    directory unconditionally on exit, so a holder that outlived its own reclaim deleted its
    SUCCESSOR's lock - one stolen lock became two lanes holding nothing. A missing owner record
    counts as ours because the only way to get one is our own failed _claim write.
    """
    with contextlib.suppress(OSError), _ui_mutex(key):
        owner = _read_owner(path)
        if owner is None or owner.get("token") == token:
            shutil.rmtree(path, ignore_errors=True)


@contextlib.contextmanager
def instance_lock(instance: str | None, wait_secs: float = 90.0):
    """ONE DRIVER PER WINDOW AT A TIME. `with instance_lock(inst) as mine:` yields True when
    this process holds the instance's UI lock, False when another lane kept it past
    `wait_secs` - then SKIP the poke and say so; it is retried next cycle.

    WHY (review 2026-09-01): every 5-minute lane has its own job lock and none of them share
    one per WINDOW, yet the courier's composer send, archive_chat's sidebar control,
    unblock_prompts' Allow press and spawn_chat's deeplink all drive the same Electron window
    of one instance. Interleaved, one lane's sidebar click switches the pane another lane is
    typing into - the exact wrong-chat failure the verify rail exists for - and two
    capture/restore pairs can leave the window re-maximized after the first lane put it back
    (the owner's "full screening" complaint, from the very guard meant to stop it).

    An atomic mkdir is the lock (the same shape as the courier's per-delivery claim), and it
    carries an owner record so it is reclaimed on PROOF that its holder died rather than on age
    (_may_reclaim) and released only by the holder that took it (_release). Nothing here
    raises: an instance-less caller simply proceeds.
    """
    if not instance:
        yield True
        return
    from lib import ledgerlib

    key = _lock_key(instance)
    if key in _HELD_KEYS:
        # Already ours, higher up this very call stack (see _HELD_KEYS). Note that the key is
        # normalised, so an outer caller naming the instance and an inner one pathing it are
        # recognised as the same window rather than deadlocking on two spellings of it.
        yield True
        return
    path = ledgerlib._state_dir() / "locks" / f"ui-{key}"
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + max(0.0, wait_secs)
    token = uuid4().hex
    held = False
    claimed = False  # did WE create this directory? Only then may we remove it.
    while True:
        try:
            path.mkdir()
            _claim(path, str(instance), token)
            held = claimed = True
            break
        except FileExistsError:
            took = _reclaim_if_dead(path, key, str(instance), token)
            if took is True:
                held = claimed = True
                break
            if took is None:
                continue  # it vanished: the other lane just finished - retake
            if time.time() >= deadline:
                break
            time.sleep(1.0)
        except OSError:
            # The locks dir itself is unusable: never let a courtesy block the work. We hold
            # nothing, so `claimed` stays False and the release below removes nobody's lock.
            held = True
            break
    if claimed:
        _HELD_KEYS.add(key)
    try:
        if held:
            # THE LOCK IS THE ONE PLACE EVERY DRIVER PASSES THROUGH, so the placement courtesy
            # lives here too (owner, 2026-09-01: "something full screened one of the accounts
            # again" during the live smoke). Before this, only archive, courier and rename
            # wrapped keep_placement themselves; the doctrine picker, the spawn's deeplink and
            # trust dialog, the unblock press and the naming pass drove the same windows with
            # nothing putting them back. One mechanism, every caller, no way to forget it.
            with keep_placement(instance):
                yield held
        else:
            yield held
    finally:
        if claimed:
            _HELD_KEYS.discard(key)
            _release(path, key, token)


def _run(args: list[str]) -> tuple[int, str]:
    try:
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR)]
            + args, timeout=60)
        return r.returncode, (r.stdout or "").strip()
    except Exception as err:  # a courtesy must never break the delivery it wraps
        return 1, str(err)[:160]


def capture(instance: str | None) -> str | None:
    """The window's placement as an opaque JSON line, or None when there is nothing to keep."""
    if not instance or not ACTUATOR.exists():
        return None
    code, out = _run(["-Capture", "-Instance", str(instance)])
    return out if code == 0 and out.startswith("{") else None


def restore(instance: str | None, state: str | None) -> str | None:
    """Put it back if it moved. Returns a note ONLY when a restore actually happened."""
    if not instance or not state or not ACTUATOR.exists():
        return None
    code, out = _run(["-Apply", "-Instance", str(instance), "-State", state])
    return out if code == 0 and out.startswith("restored") else None


def unmaximize(instance: str | None) -> str | None:
    """A window WE just brought up that came up maximized is put back to normal (its own
    restore rect, showCmd 1). Returns a note only when that actually happened.

    The app relaunches with its profile's saved placement, and a profile last closed
    maximized reopens full screen natively (AgentHydra's launcher says so in its own
    comments) - which is how an instance the toolbox opened during the live smoke filled the
    owner's screen (2026-09-01: "something full screened one of the accounts again"). This
    touches only a window that is maximized RIGHT NOW after our own open; it never fights a
    window the owner sized himself later."""
    if not instance or not ACTUATOR.exists():
        return None
    state = capture(instance)
    if not state:
        return None
    try:
        import json

        placement = json.loads(state)
    except ValueError:
        return None
    if int(placement.get("showCmd") or 0) != 3:
        return None
    placement["showCmd"] = 1
    return restore(instance, json.dumps(placement))


@contextlib.contextmanager
def keep_placement(instance: str | None, note=None):
    """Wrap anything that pokes a desktop app: `with keep_placement(inst): ...`.

    `note` is an optional callable that receives the one-line evidence when a restore was
    genuinely needed - the caller decides where that goes (a log line, a ledger detail).
    """
    # A COURTESY MUST NEVER BREAK THE WORK IT WRAPS. Every step here is suppressed, including
    # the capture: this exists to be polite about a window, and a delivery that failed because
    # the politeness threw would be far worse than a window left where the app put it.
    before = None
    with contextlib.suppress(Exception):
        before = capture(instance)
    try:
        yield
    finally:
        said = None
        with contextlib.suppress(Exception):
            said = restore(instance, before)
        if said and note:
            with contextlib.suppress(Exception):
                note(said)
