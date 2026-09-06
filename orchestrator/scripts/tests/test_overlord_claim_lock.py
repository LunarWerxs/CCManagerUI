"""AH-31: overlord.json's claim writers (manual --claim, adoption, rebirth) used to
write_text() directly with no mutex and no atomic replace - a person's deliberate --claim
could race the scheduled tick's own adoption/rebirth, whichever direct write landed last
silently became the role owner, and a reader could observe a transient empty/partial file.

This coordinates a manual-claim writer against an automatic adoption/rebirth writer with a
threading.Barrier so their read-modify-write windows genuinely overlap, then asserts: the
file is always parseable JSON, exactly one owner remains (the documented precedence - manual
always wins), and find_overlord() resolves that same session. A separate test hammers
_write_claim from many threads while a reader loops, proving no partial/empty read ever
happens mid-write.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

import overlord  # noqa: E402
from lib import hydralib  # noqa: E402


class ClaimLockTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.claim_path = Path(self._state.name) / "overlord.json"

    def _assert_parseable(self):
        raw = self.claim_path.read_text(encoding="utf-8")
        data = json.loads(raw)  # raises if a reader ever saw a partial/mangled write
        self.assertIn("sessionId", data)
        return data

    def test_manual_claim_racing_adoption_leaves_exactly_one_owner_manual_wins(self):
        """A person's --claim and the scheduled tick's adoption of an existing manager fire
        at the same instant. Whichever thread the OS schedules first, the documented
        precedence must hold: the manual claim is the one left standing, and it is never
        torn/partial."""
        barrier = threading.Barrier(2)
        # The automatic writer's decision snapshot is taken BEFORE the race, exactly as
        # rebirth()/​_locate_or_rebirth do it - so a manual claim landing during the race is
        # detected as "at or after since_ms" regardless of which thread wins the barrier.
        decided_at_ms = int(time.time() * 1000)

        results: dict[str, tuple[bool, str]] = {}

        def manual_writer():
            barrier.wait()
            wrote, why = overlord._write_claim("manual-sid", "Person's chat", manual=True)
            results["manual"] = (wrote, why)

        def automatic_writer():
            barrier.wait()
            wrote, why = overlord._write_claim("auto-sid", "Adopted manager", manual=False,
                                               since_ms=decided_at_ms)
            results["auto"] = (wrote, why)

        threads = [threading.Thread(target=manual_writer),
                   threading.Thread(target=automatic_writer)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        # The manual write ALWAYS lands - it never checks or defers.
        self.assertTrue(results["manual"][0])
        data = self._assert_parseable()
        # Exactly one owner survives on disk, and it is the manual claim (precedence).
        self.assertEqual(data["sessionId"], "manual-sid")
        self.assertTrue(data.get("manual"))
        # The automatic writer either lost the race outright (its own write happened first,
        # then got overwritten - acceptable, still one owner on disk) or correctly detected
        # the manual claim and deferred (reported False). Either way the file itself never
        # ends up owned by the automatic writer once the manual claim exists.
        final = self._assert_parseable()
        self.assertEqual(final["sessionId"], "manual-sid")

    def test_repeated_manual_vs_automatic_races_always_resolve_to_one_parseable_owner(self):
        """Run the race many times (fresh state each round) to flush out any interleaving
        that a single run might miss - the bug this fixes is a RACE, so one pass proves
        little."""
        for i in range(20):
            self.claim_path.unlink(missing_ok=True)
            barrier = threading.Barrier(2)
            decided_at_ms = int(time.time() * 1000)

            def manual_writer(i=i):
                barrier.wait()
                overlord._write_claim(f"manual-{i}", "Person", manual=True)

            def automatic_writer(i=i, since=decided_at_ms):
                barrier.wait()
                overlord._write_claim(f"auto-{i}", "Adopted", manual=False, since_ms=since)

            threads = [threading.Thread(target=manual_writer),
                       threading.Thread(target=automatic_writer)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10)
            data = self._assert_parseable()
            self.assertEqual(data["sessionId"], f"manual-{i}",
                             f"round {i}: manual claim must win and be the sole owner")

    def test_automatic_writer_defers_when_a_manual_claim_already_won(self):
        """Not a race: the automatic writer's decision snapshot is taken FIRST, then the
        manual claim lands during its decision window (before it gets around to writing) -
        exactly what rebirth()/_locate_or_rebirth guard against. The automatic writer must
        detect the manual claim is newer than its own snapshot and defer, not clobber it."""
        since_ms = int(time.time() * 1000)  # the automatic writer "decides" first...
        time.sleep(0.02)
        overlord._write_claim("person-sid", "Orchestrate", manual=True)  # ...then this lands
        wrote, why = overlord._write_claim("auto-sid", "Adopted manager", manual=False,
                                           since_ms=since_ms)
        self.assertFalse(wrote)
        self.assertIn("manual claim", why)
        data = self._assert_parseable()
        self.assertEqual(data["sessionId"], "person-sid")  # untouched

    def test_find_overlord_resolves_the_session_that_won_the_race(self):
        """The claim file is only half the story - find_overlord() must resolve the SAME
        session the race left as owner, by id, un-archived."""
        barrier = threading.Barrier(2)
        decided_at_ms = int(time.time() * 1000)

        def manual_writer():
            barrier.wait()
            overlord._write_claim("winner-sid", "Person's claim", manual=True)

        def automatic_writer():
            barrier.wait()
            overlord._write_claim("loser-sid", "Adopted manager", manual=False,
                                  since_ms=decided_at_ms)

        threads = [threading.Thread(target=manual_writer),
                   threading.Thread(target=automatic_writer)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        data = self._assert_parseable()
        winner = data["sessionId"]
        self.stub.routes["/api/sessions"] = lambda m, p, q, b: [
            {"session_id": winner, "archived": False, "title": "whatever", "instance": "p2",
             "transcript_path": "", "last_activity_at": 0},
        ]
        row = overlord.find_overlord()
        self.assertIsNotNone(row)
        self.assertEqual(row["session_id"], winner)

    def test_a_reader_never_sees_empty_or_partial_json_during_heavy_concurrent_writes(self):
        """Loop a reader thread while several writer threads hammer _write_claim N times
        each - the atomic-replace guarantee this ports from ledgerlib/deliverylib means a
        reader must NEVER observe an empty file or a JSONDecodeError, even mid-storm."""
        overlord._write_claim("seed", "seed", manual=True)  # file exists before the storm
        stop = threading.Event()
        failures: list[str] = []

        def reader():
            while not stop.is_set():
                try:
                    raw = self.claim_path.read_text(encoding="utf-8")
                except OSError:
                    continue  # a rename mid-open is fine, absence is fine; content must not be
                if raw == "":
                    failures.append("read an EMPTY file mid-write")
                    continue
                try:
                    json.loads(raw)
                except json.JSONDecodeError as err:
                    failures.append(f"read PARTIAL/mangled JSON: {err} -- {raw!r}")
                # A hair of slack between reads: this loop exists to CATCH a writer mid-replace,
                # not to out-race Windows' mandatory file locking / AV scanning into spurious
                # PermissionErrors on the writer side, which would test OS scheduling noise
                # rather than the atomicity guarantee this test is actually after.
                time.sleep(0.003)

        def writer(n: int):
            for i in range(10):
                try:
                    overlord._write_claim(f"w{n}-{i}", "spam", manual=True)
                except Exception as err:  # noqa: BLE001 - surface it, don't let it vanish
                    failures.append(f"writer {n} iteration {i} raised: {err!r}")

        reader_thread = threading.Thread(target=reader)
        reader_thread.start()
        writers = [threading.Thread(target=writer, args=(n,)) for n in range(3)]
        for t in writers:
            t.start()
        for t in writers:
            t.join(timeout=20)
        stop.set()
        reader_thread.join(timeout=5)

        self.assertEqual(failures, [])
        self._assert_parseable()  # final state is still sane


if __name__ == "__main__":
    unittest.main()
