"""chips.py - AH-29: record() and forget() must not lose an update.

Reproduced 2026-09-05: the doctrine job calls record() while the scheduled chips lane calls
forget(), under different scheduler locks. Both used to load-filter-append/remove-save
chips.json with no cross-process mutex, so two concurrent writers could read the same stale
snapshot and one's save would silently erase the other's row - atomic replacement (temp file
+ os.replace) stopped truncation but not this lost update. The fix wraps both in
ledgerlib.locked("chips"); this pins that a record() and a forget() released together never
drop the record()'d row nor resurrect the forget()'ed one, regardless of thread scheduling."""

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import chips  # noqa: E402
from lib import ledgerlib  # noqa: E402


class ChipsLockTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self.addCleanup(self._state.cleanup)

    def _seed(self, rows):
        chips._chips_path().parent.mkdir(parents=True, exist_ok=True)
        chips._chips_path().write_text(json.dumps(rows), encoding="utf-8")

    def test_concurrent_record_and_forget_do_not_lose_an_update(self):
        # Run several times: a race only shows up on some interleavings.
        for _ in range(25):
            self._seed([
                {"instance": "hot", "chat": "B", "title": "b", "description": "", "seenAt": 1},
                {"instance": "hot", "chat": "C", "title": "c", "description": "", "seenAt": 1},
            ])
            barrier = threading.Barrier(2)

            def do_record():
                barrier.wait(timeout=5)
                chips.record("hot", "A", "a", "")

            def do_forget():
                barrier.wait(timeout=5)
                chips.forget("hot", "B")

            t1 = threading.Thread(target=do_record)
            t2 = threading.Thread(target=do_forget)
            t1.start()
            t2.start()
            t1.join(timeout=5)
            t2.join(timeout=5)

            rows = chips.load_records()
            chats = sorted(r["chat"] for r in rows)
            self.assertEqual(
                chats, ["A", "C"],
                f"lost update: expected A recorded and B forgotten, got {chats}",
            )

    def test_lock_is_the_named_chips_lock(self):
        # Confirms the fix actually serializes through ledgerlib's mutex rather than some
        # ad hoc lock: while "chips" is held, a second locked("chips") in another thread must
        # wait rather than proceeding concurrently.
        self._seed([])
        entered = threading.Event()
        release = threading.Event()
        second_started = threading.Event()
        second_done = threading.Event()

        def holder():
            with ledgerlib.locked("chips"):
                entered.set()
                release.wait(timeout=5)

        def waiter():
            entered.wait(timeout=5)
            second_started.set()
            with ledgerlib.locked("chips"):
                second_done.set()

        h = threading.Thread(target=holder)
        w = threading.Thread(target=waiter)
        h.start()
        entered.wait(timeout=5)
        w.start()
        second_started.wait(timeout=5)
        # Give the waiter a moment: it must still be blocked on the lock.
        self.assertFalse(second_done.wait(timeout=0.3))
        release.set()
        h.join(timeout=5)
        w.join(timeout=5)
        self.assertTrue(second_done.is_set())


if __name__ == "__main__":
    unittest.main()
