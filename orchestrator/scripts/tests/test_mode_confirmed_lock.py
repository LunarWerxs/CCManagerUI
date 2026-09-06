"""automation_chat's mode-confirmed.json journal under contention (audit AH-30).

A successful in-app picker records its verdict with mark_confirmed(); the fleet pass drops a
stale confirmation for a DIFFERENT chat with drop_confirmed(). Both read the whole file and
replaced it with no lock, so the loser silently erased the winner's entry and the next tick
re-ran a picker on a chat that had already confirmed. Both now run under one named lock."""

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import automation_chat  # noqa: E402


class ModeConfirmedLockTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_concurrent_mark_and_drop_keep_exactly_the_expected_entries(self):
        automation_chat.mark_confirmed("keep-me", "seed")
        automation_chat.mark_confirmed("drop-me", "seed")
        for _round in range(20):
            automation_chat.mark_confirmed("drop-me", "seed again")
            barrier = threading.Barrier(2)

            def mark():
                barrier.wait()
                automation_chat.mark_confirmed("new-one", "picker said bypass")

            def drop():
                barrier.wait()
                automation_chat.drop_confirmed("drop-me")

            threads = [threading.Thread(target=mark), threading.Thread(target=drop)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)
            got = automation_chat.load_confirmed()
            self.assertIn("new-one", got, got)      # the mark was not lost to the drop's snapshot
            self.assertNotIn("drop-me", got, got)   # the drop was not undone by the mark's snapshot
            self.assertIn("keep-me", got, got)      # an unrelated entry survived both
            automation_chat.drop_confirmed("new-one")

    def test_the_file_is_never_left_partial_and_no_lock_remains(self):
        automation_chat.mark_confirmed("a", "x")
        automation_chat.drop_confirmed("a")
        self.assertEqual(automation_chat.load_confirmed(), {})
        state = Path(self._state.name)
        self.assertFalse(list(state.glob(".lock-mode-confirmed")))
        self.assertFalse(list(state.glob("mode-confirmed.json.*.tmp")))


if __name__ == "__main__":
    unittest.main()
