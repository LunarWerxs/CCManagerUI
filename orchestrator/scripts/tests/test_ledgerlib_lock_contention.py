"""ledgerlib.locked / try_locked under real contention (found 2026-09-05 while landing AH-31).

On Windows a deleted file's name lingers, pending-delete, for the microseconds between the
previous holder's unlink and its handle closing; an O_CREAT|O_EXCL create landing in that window
answers PermissionError (errno 13), not FileExistsError. Both helpers caught only the latter, so
under contention a lane that should have waited CRASHED instead: measured 42 crashes in 1,800
acquisitions across 6 threads before the fix. Every lock in the toolbox goes through these two
functions, so every lane sharing a ledger, a hold file, a delivery queue or a claim was exposed."""

import collections
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import ledgerlib  # noqa: E402

THREADS = 6
ROUNDS = 300


class LockContentionTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_locked_never_raises_under_contention_and_serializes_the_critical_section(self):
        errors = collections.Counter()
        inside = {"now": 0, "max": 0}
        guard = threading.Lock()

        def lane():
            for _ in range(ROUNDS):
                try:
                    with ledgerlib.locked("contended"):
                        with guard:
                            inside["now"] += 1
                            inside["max"] = max(inside["max"], inside["now"])
                        with guard:
                            inside["now"] -= 1
                except Exception as err:  # noqa: BLE001 - the whole point is that none happen
                    errors[type(err).__name__] += 1

        threads = [threading.Thread(target=lane) for _ in range(THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)
        self.assertEqual(dict(errors), {}, f"{THREADS * ROUNDS} acquisitions raised: {dict(errors)}")
        self.assertEqual(inside["max"], 1, "two lanes were inside the locked section at once")
        self.assertFalse((Path(self._state.name) / ".lock-contended").exists())

    def test_try_locked_answers_true_or_false_but_never_raises_under_contention(self):
        errors = collections.Counter()
        outcomes = collections.Counter()

        def lane():
            for _ in range(ROUNDS):
                try:
                    with ledgerlib.try_locked("contended-try") as ours:
                        outcomes["held" if ours else "deferred"] += 1
                except Exception as err:  # noqa: BLE001
                    errors[type(err).__name__] += 1

        threads = [threading.Thread(target=lane) for _ in range(THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)
        self.assertEqual(dict(errors), {}, f"try_locked raised: {dict(errors)}")
        self.assertEqual(sum(outcomes.values()), THREADS * ROUNDS)
        self.assertGreater(outcomes["held"], 0)
        self.assertFalse((Path(self._state.name) / ".lock-contended-try").exists())


if __name__ == "__main__":
    unittest.main()
