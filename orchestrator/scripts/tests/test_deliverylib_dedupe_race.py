"""deliverylib.stage(dedupe=True) under contention (audit AH-06).

Reproduced 2026-09-05: two synchronized automatic lanes both passed the "is a reply already
pending for this chat" check and both appended under the lock - two pending rows, two ids,
neither `reused`, and the courier's per-id claim only DELAYED the second wake. The lookup now
happens against the same locked snapshot as the append, so contention yields one row and
every caller gets its identity back."""

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import deliverylib  # noqa: E402

SID = "dddd9999-1111-2222-3333-444455556666"
EVIDENCE = ("Here is what I found.\n"
            "## Am I 100% done?\n- No, the deploy step is still open.\n"
            "Shall I go ahead and run it?")


class DedupeRaceTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _race(self, lanes: int) -> list[dict]:
        barrier = threading.Barrier(lanes)
        results: list[dict] = [None] * lanes  # type: ignore[list-item]

        def lane(i: int) -> None:
            barrier.wait()
            results[i] = deliverylib.stage(SID, f"wake {i}", evidence=EVIDENCE, dedupe=True)

        threads = [threading.Thread(target=lane, args=(i,)) for i in range(lanes)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        return results

    def test_two_synchronized_automatic_lanes_leave_exactly_one_pending_row(self):
        results = self._race(2)
        self.assertTrue(all(r is not None for r in results))
        self.assertEqual(len(deliverylib.pending(SID)), 1)
        self.assertEqual(len({r["id"] for r in results}), 1)
        self.assertEqual(sum(1 for r in results if r.get("reused")), 1)

    def test_six_lanes_still_leave_one_row_and_all_share_its_identity(self):
        results = self._race(6)
        self.assertEqual(len(deliverylib.pending(SID)), 1)
        self.assertEqual(len({r["id"] for r in results}), 1)
        self.assertEqual(sum(1 for r in results if r.get("reused")), 5)

    def test_a_persons_reply_is_still_never_folded_into_an_automatic_row(self):
        auto = deliverylib.stage(SID, "wake", evidence=EVIDENCE, dedupe=True)
        person = deliverylib.stage(SID, "no, do it this way", evidence=EVIDENCE, by="person")
        self.assertNotEqual(auto["id"], person["id"])
        self.assertEqual(len(deliverylib.pending(SID)), 2)


if __name__ == "__main__":
    unittest.main()
