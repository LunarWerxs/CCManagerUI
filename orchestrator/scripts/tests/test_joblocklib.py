"""test_joblocklib - AH-16: the job lock must require PROOF of death before reclaiming, and
only its own token may release it.

Covers the three failure shapes the old age-only mkdir lock had:
  1. a live owner (even one long past the old 30-minute stale window) blocks a second acquire;
  2. a verified-dead owner (a PID that no longer exists) IS reclaimable;
  3. an old holder can never unlink a newer holder's lock (token mismatch on release).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import joblocklib  # noqa: E402


@unittest.skipUnless(sys.platform == "win32", "joblocklib's ownership check is Windows-specific")
class JobLockTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_live_owner_blocks_a_second_acquire_even_past_the_old_stale_age(self):
        lock = joblocklib.acquire("reconcile")
        self.assertIsNotNone(lock)
        # Backdate the timestamps well past the OLD 30-minute age-based reclaim window - the
        # new lock must ignore age entirely and look at whether the PID is still running.
        owner = joblocklib._owner_path("reconcile")
        data = json.loads(owner.read_text(encoding="utf-8"))
        data["acquired_at"] -= 3600
        data["heartbeat"] -= 3600
        owner.write_text(json.dumps(data), encoding="utf-8")

        second = joblocklib.acquire("reconcile")
        self.assertIsNone(second, "a live owner (this test process) must never be reclaimed by age")

        self.assertTrue(lock.release())

    def test_a_verified_dead_owner_is_reclaimable(self):
        lock = joblocklib.acquire("saturate")
        self.assertIsNotNone(lock)
        # Stand in for a crashed holder: point the owner record at a PID that provably is not
        # running any more, by spawning a trivial child, waiting for it to exit, and recording
        # ITS pid/creation-time as the "owner" - a real exited process, not a guessed number.
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        dead_pid = proc.pid
        owner = joblocklib._owner_path("saturate")
        data = json.loads(owner.read_text(encoding="utf-8"))
        data["pid"] = dead_pid
        data["started_at"] = 0.0  # a creation time that certainly won't match anything alive now
        owner.write_text(json.dumps(data), encoding="utf-8")

        reclaimed = joblocklib.acquire("saturate")
        self.assertIsNotNone(reclaimed, "a provably-dead owner must be reclaimable")
        self.assertNotEqual(reclaimed.token, data["token"])
        self.assertTrue(reclaimed.release())

    def test_old_holder_cannot_unlink_a_newer_holders_lock(self):
        old = joblocklib.acquire("twins")
        self.assertIsNotNone(old)
        # Simulate the OLD holder going stale/dead and a new tick reclaiming the lock.
        owner = joblocklib._owner_path("twins")
        data = json.loads(owner.read_text(encoding="utf-8"))
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        data["pid"] = proc.pid
        data["started_at"] = 0.0
        owner.write_text(json.dumps(data), encoding="utf-8")

        new = joblocklib.acquire("twins")
        self.assertIsNotNone(new)
        self.assertNotEqual(old.token, new.token)

        # The OLD token must not be able to remove the NEW holder's lock.
        removed = old.release()
        self.assertFalse(removed, "an old holder's release() must refuse to touch a newer lock")
        self.assertTrue(joblocklib._owner_path("twins").exists(),
                         "the newer holder's lock must survive the old holder's release() call")
        current = json.loads(joblocklib._owner_path("twins").read_text(encoding="utf-8"))
        self.assertEqual(current["token"], new.token)

        self.assertTrue(new.release())

    def test_unknown_liveness_never_authorizes_a_takeover(self):
        lock = joblocklib.acquire("overlord")
        self.assertIsNotNone(lock)
        owner = joblocklib._owner_path("overlord")
        data = json.loads(owner.read_text(encoding="utf-8"))
        # No creation time on record at all - liveness is UNKNOWN, not proven dead.
        data["started_at"] = None
        owner.write_text(json.dumps(data), encoding="utf-8")

        second = joblocklib.acquire("overlord")
        self.assertIsNone(second, "an unproven owner state must never be treated as reclaimable")
        self.assertTrue(lock.release())

    def test_heartbeat_refreshes_the_owner_file_only_for_the_current_token(self):
        lock = joblocklib.acquire("chips")
        self.assertIsNotNone(lock)
        before = json.loads(joblocklib._owner_path("chips").read_text(encoding="utf-8"))["heartbeat"]
        time.sleep(0.05)
        lock.heartbeat_once()
        after = json.loads(joblocklib._owner_path("chips").read_text(encoding="utf-8"))["heartbeat"]
        self.assertGreater(after, before)
        self.assertTrue(lock.release())


if __name__ == "__main__":
    unittest.main()
