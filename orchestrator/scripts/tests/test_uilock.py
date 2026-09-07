"""windowlib.instance_lock: ONE DRIVER PER WINDOW AT A TIME - the atomic-mkdir lock that
stops the courier's composer send, archive_chat's sidebar control and any other lane from
interleaving on the same instance's window.

THE DEFECT THIS FILE NOW PINS (2026-09-06). The lock reclaimed purely on AGE: a lock directory
older than UI_LOCK_STALE_SECS was removed with no check of who held it or whether that holder
was still driving. Every long window gesture was therefore a theft waiting to happen - the
actuator alone runs up to 240s per press, and spawn_chat's deeplink-plus-trust-modal-plus-
composer path stacks several behind a 120s wait. Cross the ceiling and a second lane deleted the
first one's lock and started clicking the same Electron sidebar: the interleaved wrong-chat
failure this lock exists to prevent, arriving from the guard itself.

And the second half, which is worse: the original holder then removed the lock directory
unconditionally on its own exit, deleting whatever SUCCESSOR had replaced it. One stolen lock
became two lanes each believing they held one and neither actually holding anything.

Same defect, and now the same fix, as joblocklib's AH-16 (tests/test_joblocklib.py): the lock
records its owner's PID and that PID's OS creation time, a waiter may take over only when the
recorded process is PROVABLY not running any more, an inconclusive answer is never permission to
take over, and release is token-checked.

⛔ THE ONE ASSERTION TO KEEP IF EVERYTHING ELSE GOES: a live owner is never stale. Age must not
break a lock whose holder is provably alive, however far past the ceiling it is.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import joblocklib  # noqa: E402
from lib import ledgerlib  # noqa: E402
from lib import windowlib  # noqa: E402


@contextmanager
def _no_placement(_instance, note=None):
    """instance_lock wraps a granted lock in keep_placement, which SHELLS OUT to the window
    actuator. These tests are about the lock, so the courtesy is stubbed: left real it spends
    two PowerShell starts per acquisition on a measurement nothing here reads."""
    yield


class UiLockTestBase(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.addCleanup(self._state.cleanup)
        self.addCleanup(lambda: os.environ.pop("ORCHESTRATOR_STATE_DIR", None))
        patcher = mock.patch.object(windowlib, "keep_placement", _no_placement)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Re-entrancy is tracked in module state. A key left behind by one case would make the
        # next one silently short-circuit and pass without ever taking a lock.
        windowlib._HELD_KEYS.clear()
        self.addCleanup(windowlib._HELD_KEYS.clear)

    def _lock_path(self, instance: str) -> Path:
        return ledgerlib._state_dir() / "locks" / f"ui-{windowlib._lock_key(instance)}"

    def _alive_says(self, verdict):
        """Drive _owner_alive's three answers directly, so every case runs on every platform.
        The real prober is exercised without a stub by RealOwnershipTest below."""
        patcher = mock.patch.object(windowlib, "_owner_alive", return_value=verdict)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _plant_owner(self, instance: str, **fields) -> Path:
        """A lock directory held by somebody else, with a hand-written owner record."""
        path = self._lock_path(instance)
        path.mkdir(parents=True)
        record = {"instance": instance, "pid": os.getpid(), "token": "theirs",
                  "started_at": None, "acquired_at": time.time()}
        record.update(fields)
        (path / "owner.json").write_text(json.dumps(record), encoding="utf-8")
        return path


class MayReclaimTest(UiLockTestBase):
    """The reclaim decision itself, isolated from the filesystem."""

    OWNER = {"pid": 4321, "token": "t", "started_at": 1.0, "acquired_at": 0.0}

    def test_a_live_owner_is_never_stale_however_old_the_lock_is(self):
        """⛔ THE REGRESSION. Age alone used to authorise the takeover, so a lane legitimately
        holding the window longer than the ceiling had it stolen mid-gesture."""
        self._alive_says(True)
        for age in (0.0, windowlib.UI_LOCK_STALE_SECS + 1, 86_400.0, 10_000_000.0):
            with self.subTest(age=age):
                self.assertFalse(
                    windowlib._may_reclaim(self.OWNER, age),
                    "a provably running holder must keep its lock at any age",
                )

    def test_a_provably_dead_owner_is_reclaimed_at_once_without_waiting_out_the_clock(self):
        """The other side of the same coin: making a live holder safe must not make a crashed
        one cost 15 minutes of nobody being able to drive that window."""
        self._alive_says(False)
        self.assertTrue(windowlib._may_reclaim(self.OWNER, 0.0))

    def test_an_unprovable_owner_is_left_alone_until_the_age_backstop(self):
        """None means we could not determine it (not Windows, or an OpenProcess we cannot read
        as 'gone'). Unknown is not permission to take over - but it must not wedge the lane
        forever either, so age is still the last resort and only the last resort."""
        self._alive_says(None)
        self.assertFalse(windowlib._may_reclaim(self.OWNER, windowlib.UI_LOCK_STALE_SECS - 1))
        self.assertTrue(windowlib._may_reclaim(self.OWNER, windowlib.UI_LOCK_STALE_SECS + 1))

    def test_a_lock_with_no_owner_record_falls_back_to_age(self):
        """A directory left by a build before owner.json existed, or a claim caught between its
        mkdir and its write. Nothing to prove anything about, so the old rule stands for it."""
        self._alive_says(True)  # must not be consulted: there is no pid to consult it on
        self.assertFalse(windowlib._may_reclaim(None, 1.0))
        self.assertTrue(windowlib._may_reclaim(None, windowlib.UI_LOCK_STALE_SECS + 1))

    def test_a_corrupt_owner_record_is_treated_as_unproven_not_as_dead(self):
        """Garbage in the pid field must not read as 'nobody is there'."""
        self._alive_says(None)
        junk = {"pid": "not-a-pid", "started_at": "whenever", "acquired_at": 0.0}
        self.assertFalse(windowlib._may_reclaim(junk, 1.0))


class InstanceLockTest(UiLockTestBase):
    """The context manager, end to end, against a real lock directory."""

    def test_the_lock_is_released_after_the_with_block(self):
        with windowlib.instance_lock("temp1"):
            self.assertTrue(self._lock_path("temp1").exists())
        self.assertFalse(self._lock_path("temp1").exists())
        # and it can be taken again immediately - nothing was left behind
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine)

    def test_an_uncontended_lock_is_stamped_with_who_took_it(self):
        path = self._lock_path("work")
        with windowlib.instance_lock("work", wait_secs=0) as mine:
            self.assertTrue(mine)
            owner = json.loads((path / "owner.json").read_text(encoding="utf-8"))
            self.assertEqual(owner["pid"], os.getpid())
            self.assertEqual(owner["instance"], "work")

    def test_another_lane_holding_it_refuses_us_and_we_leave_its_lock_alone(self):
        self._alive_says(True)
        path = self._plant_owner("temp1")
        with windowlib.instance_lock("temp1", wait_secs=0) as second:
            self.assertFalse(second, "the window must not be driven while its holder is alive")
        self.assertEqual(json.loads((path / "owner.json").read_text())["token"], "theirs",
                         "a refused waiter must leave the holder's lock exactly as it found it")

    def test_a_live_holder_keeps_the_window_even_past_the_stale_ceiling(self):
        self._alive_says(True)
        self._plant_owner("temp1",
                          acquired_at=time.time() - windowlib.UI_LOCK_STALE_SECS * 10)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertFalse(mine, "a day-old lock held by a running process is not stale")

    def test_a_dead_holders_lock_is_taken_over(self):
        self._alive_says(False)
        path = self._plant_owner("temp1", pid=999_999, started_at=1.0)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine)
            self.assertNotEqual(json.loads((path / "owner.json").read_text())["token"], "theirs")
        self.assertFalse(path.exists(), "our own lock is released on the way out")

    def test_a_stale_lock_dir_is_broken_and_retaken(self):
        # An OWNER-LESS directory - a lock from a build before owner.json existed - is the one
        # case with nothing to prove anything about, so the age rule still applies to it.
        path = self._lock_path("temp1")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.mkdir()
        old = time.time() - 20 * 60  # 20 minutes, past UI_LOCK_STALE_SECS (15 minutes)
        os.utime(path, (old, old))
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine)

    def test_a_wedged_state_lock_never_reaches_the_caller(self):
        """instance_lock's contract is that nothing in it raises. The reclaim and release paths
        go through ledgerlib.locked(), which RAISES TimeoutError when another writer is wedged,
        so both suppress it - and both must fail to the safe side: refuse the takeover, and
        delete nobody's lock."""
        boom = mock.patch.object(
            windowlib, "_ui_mutex", side_effect=TimeoutError("another writer is wedged"))
        boom.start()
        self.addCleanup(boom.stop)
        path = self._lock_path("temp1")
        path.mkdir(parents=True)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertFalse(mine, "an unreadable lock state is not permission to drive")
        self.assertTrue(path.exists(), "and it must not have removed the holder's lock")
        windowlib._release(path, windowlib._lock_key("temp1"), "whatever")
        self.assertTrue(path.exists())

    def test_the_lock_is_reentrant_within_one_process(self):
        """⛔ THE SELF-DEADLOCK. name_chats holds a window's lock for a whole naming pass and
        then calls rename_chat.main IN-PROCESS, which takes the same lock again. Refusing there
        would stall every rename for its full wait_secs and report the window busy against
        itself - and the inner call names the instance by PATH where the outer named it, so the
        two spellings must resolve to one key or the deadlock returns through the side door."""
        with windowlib.instance_lock("5claude", wait_secs=0) as outer:
            self.assertTrue(outer)
            path_shape = "C:" + chr(92) + "i" + chr(92) + ".claude-instances" + chr(92) + "5claude"
            with windowlib.instance_lock(path_shape, wait_secs=0) as inner:
                self.assertTrue(inner, "a lane must not be refused its own lock")
            self.assertTrue(self._lock_path("5claude").exists(),
                            "and leaving the inner block must not release the outer holder")
        self.assertFalse(self._lock_path("5claude").exists())

    def test_a_reentrant_take_does_not_pay_the_placement_courtesy_twice(self):
        """The outer take already captured and restored the window. Doing it again per nested
        call is two more actuator starts for a measurement nobody reads."""
        seen: list[str] = []

        @contextmanager
        def counting(instance, note=None):
            seen.append(str(instance))
            yield

        patcher = mock.patch.object(windowlib, "keep_placement", counting)
        patcher.start()
        self.addCleanup(patcher.stop)
        with windowlib.instance_lock("temp1", wait_secs=0):
            with windowlib.instance_lock("temp1", wait_secs=0):
                pass
        self.assertEqual(seen, ["temp1"])

    def test_lock_key_maps_a_path_and_its_basename_to_the_same_key(self):
        # Both shapes reach the lanes: a bare instance name, and a full instance directory.
        self.assertEqual(
            windowlib._lock_key("5claude"),
            windowlib._lock_key("C:" + chr(92) + "i" + chr(92) + ".claude-instances" + chr(92) + "5claude"),
        )

    def test_an_empty_instance_yields_true_without_locking(self):
        with windowlib.instance_lock(None) as mine:
            self.assertTrue(mine)
        with windowlib.instance_lock("") as mine2:
            self.assertTrue(mine2)


class NestedLaneTest(UiLockTestBase):
    """The re-entrancy above, pinned on the call path that actually needs it rather than on the
    primitive alone - name_chats holds the window and reaches rename_chat.main in-process."""

    def test_a_rename_driven_from_inside_a_held_lock_is_not_refused_as_busy(self):
        import rename_chat

        ran: list[list[str]] = []
        patches = [
            mock.patch.object(rename_chat.windowlib, "keep_placement", _no_placement),
            mock.patch.object(type(rename_chat.ACTUATOR), "exists", lambda _self: True),
            mock.patch.object(
                rename_chat.clilib, "run_text",
                lambda args, **k: ran.append(args)
                or type("R", (), {"returncode": 0, "stdout": "renamed", "stderr": ""})()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine)
            code, out = rename_chat._drive_rename("temp1", "old", "new")
        self.assertEqual(code, 0, f"the naming pass must not be told its own window is busy: {out}")
        self.assertEqual(len(ran), 1, "and the actuator must actually have been driven")


class ReleaseTest(UiLockTestBase):
    """AH-16's second half: an old holder must never unlink its successor's lock."""

    def test_a_superseded_holder_cannot_delete_the_new_holders_lock(self):
        path = self._plant_owner("temp1", token="the-successor")
        windowlib._release(path, windowlib._lock_key("temp1"), "the-old-holder")
        self.assertTrue(path.exists(), "a stale token must remove nobody's lock")
        windowlib._release(path, windowlib._lock_key("temp1"), "the-successor")
        self.assertFalse(path.exists(), "the real holder still gives its own lock back")

    def test_a_failed_stamp_still_releases_its_own_directory(self):
        """_claim is best effort, so a lock we hold but could not stamp must not be orphaned
        until the age backstop - it is ours, and nobody else can have written it."""
        path = self._lock_path("temp1")
        path.mkdir(parents=True)
        windowlib._release(path, windowlib._lock_key("temp1"), "whatever")
        self.assertFalse(path.exists())


@unittest.skipUnless(sys.platform == "win32", "the ownership proof is Windows-specific")
class RealOwnershipTest(UiLockTestBase):
    """No stubbed prober: the real PID-plus-creation-time check, on the platform that has it."""

    def _live_child(self) -> int:
        """A real OTHER process, alive for the length of the test."""
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(proc.wait)
        self.addCleanup(proc.kill)
        return proc.pid

    def test_another_live_process_holding_it_is_refused_past_the_ceiling(self):
        """The property the old same-process double-take was standing in for, tested the way it
        actually matters: a DIFFERENT, running process holds the window. `acquired_at` is
        backdated far past the ceiling, so only the liveness proof can refuse this."""
        pid = self._live_child()
        self._plant_owner("temp1", pid=pid,
                          started_at=joblocklib._process_start_time(pid),
                          acquired_at=time.time() - windowlib.UI_LOCK_STALE_SECS * 10)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertFalse(mine, "another lane's live lock must survive any age")

    def test_this_very_process_counts_as_a_live_owner(self):
        self._plant_owner("temp1", started_at=joblocklib._process_start_time(os.getpid()),
                          acquired_at=time.time() - 86_400)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertFalse(mine, "a day-old lock held by a running process is not stale")

    def test_a_process_that_has_exited_is_provably_gone(self):
        """A real crashed lane: a child that has actually exited, recorded the way a holder
        records itself. `started_at` is pinned to a creation time nothing alive can have, which
        is what makes this deterministic - Windows keeps an exited process openable while any
        handle to it survives, so 'OpenProcess failed' alone would be a flaky proof."""
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        self._plant_owner("temp1", pid=proc.pid, started_at=0.0)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine, "a crashed lane's lock is reclaimed without waiting it out")

    def test_a_recycled_pid_cannot_impersonate_the_original_holder(self):
        """The reason a PID alone is not enough: the OS hands them out again. This process is
        alive, but it is not the process the record describes, so the lock is reclaimable."""
        self._plant_owner("temp1", started_at=1.0)
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine, "same pid, different creation time, so a different process")


if __name__ == "__main__":
    unittest.main()
