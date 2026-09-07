"""name_chats.py: the naming law's deny-list, and the probe loop's contract - names what it
can prove, quarantines what needs an AI-written name, never invents, always terminates."""

import json
import os
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tempfile

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402
import name_chats  # noqa: E402


@contextmanager
def _no_placement(_instance, note=None):
    """The window-placement courtesy, minus the two PowerShell starts it costs per pass."""
    yield

SID_A = "aaaa0001-0000-0000-0000-000000000000"
SID_B = "bbbb0002-0000-0000-0000-000000000000"


class GenericTitleTest(unittest.TestCase):
    def test_generics(self):
        for t in [None, "", "  ", "Untitled", "untitled", "General coding session",
                  "New chat", "new session", "[plumbing] courier target",
                  "landing fix probe 3", "naming pass probe 99-1", "Recovered chat abc (needs a name)"]:
            self.assertTrue(name_chats.is_generic_title(t), repr(t))

    def test_real_names(self):
        for t in ["Sweep report: delivery deadlock discovery", "Fix memory_save call shape",
                  "Untitled poem analysis"]:  # 'Untitled X' is a real name; bare 'Untitled' is not
            self.assertFalse(name_chats.is_generic_title(t), repr(t))


class NamePassTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        # The pass takes the per-window UI lock (windowlib.instance_lock, state/locks/ui-<key>)
        # under the STATE DIR. Without this line that is the checkout's own state/, shared with a
        # scheduled pass running from the same checkout and with any other copy of this suite: the
        # second holder finds the lock taken, names nothing, and four tests here read "nothing
        # named" as a bug (four suites side by side, 2026-09-05: three of them red exactly this
        # way).
        os.environ["ORCHESTRATOR_STATE_DIR"] = str(Path(self._tmp.name) / "state")
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        # That lock also wraps the pass in windowlib.keep_placement, which SHELLS OUT to the
        # window actuator twice per pass. Against these fixture instances it can only fail, but
        # it still pays two PowerShell starts each time: measured 6.4s -> 17.1s for this file
        # when the naming pass moved onto the shared lock. Stubbed, because a unit test must not
        # drive the real actuator (see the memory about an importer test launching the app).
        placement = mock.patch.object(name_chats.windowlib, "keep_placement", _no_placement)
        placement.start()
        self.addCleanup(placement.stop)
        self.store = Path(self._tmp.name) / "claude-code-sessions"
        d = self.store / "org" / "user"
        d.mkdir(parents=True)
        self.metas = {
            SID_A: d / "local_a.json",
            SID_B: d / "local_b.json",
        }
        for sid, p in self.metas.items():
            p.write_text(json.dumps({"cliSessionId": sid, "title": None, "isArchived": False}),
                         encoding="utf-8")
        # sessions table knows a real title for A only
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID_A, "title": "A real chat about X", "archived": False},
            {"session_id": SID_B, "title": "General coding session", "archived": False},
        ]

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def _meta_title(self, sid):
        return json.loads(self.metas[sid].read_text(encoding="utf-8")).get("title")

    def _set_title(self, sid, title):
        meta = json.loads(self.metas[sid].read_text(encoding="utf-8"))
        meta["title"] = title
        self.metas[sid].write_text(json.dumps(meta), encoding="utf-8")

    def fake_probe(self):
        test = self

        def run(instance, probe):
            rows = name_chats.nameless_rows(test.store)
            if not rows:
                return 3, "NONE-RENDERED"
            test._set_title(rows[0]["sid"], probe)  # the app's re-save, simulated
            return 0, f"RENAMED first row -> '{probe}'"

        return run

    def fake_daemon_rename(self):
        test = self
        calls = []

        def rename(sid, title):
            calls.append((sid, title))
            test._set_title(sid, title)
            return 0, "renamed and VERIFIED"

        rename.calls = calls
        return rename

    def test_names_known_and_quarantines_unknown(self):
        dr = self.fake_daemon_rename()
        res = name_chats.name_pass("t", probe_runner=self.fake_probe(), daemon_rename=dr,
                                   store=self.store, poll_secs=2)
        self.assertEqual({r["sid"] for r in res["named"]}, {SID_A, SID_B})
        self.assertEqual(self._meta_title(SID_A), "A real chat about X")
        # B's only known title is generic -> quarantine + judgment queue, never an invented name
        self.assertEqual(len(res["needsJudgment"]), 1)
        self.assertEqual(res["needsJudgment"][0]["sid"], SID_B)
        self.assertIn("Recovered chat", self._meta_title(SID_B))
        self.assertEqual(res["remaining"], [])

    def test_callers_word_beats_sessions_table(self):
        dr = self.fake_daemon_rename()
        res = name_chats.name_pass("t", extra_titles={SID_B: "The B chat, properly named"},
                                   probe_runner=self.fake_probe(), daemon_rename=dr,
                                   store=self.store, poll_secs=2)
        self.assertEqual(res["needsJudgment"], [])
        self.assertEqual(self._meta_title(SID_B), "The B chat, properly named")

    def test_flakes_stop_after_three_and_report(self):
        def flaky(instance, probe):
            return 1, "FAIL: rename editor did not open"

        res = name_chats.name_pass("t", probe_runner=flaky, daemon_rename=self.fake_daemon_rename(),
                                   store=self.store, poll_secs=1)
        self.assertEqual(len(res["flakes"]), 3)
        self.assertEqual(len(res["remaining"]), 2)  # honest: nothing got named
        self.assertNotEqual(res["why"], "clean")

    def test_unreachable_rows_reported_as_remaining(self):
        def none_rendered(instance, probe):
            return 3, "NONE-RENDERED"

        res = name_chats.name_pass("t", probe_runner=none_rendered,
                                   daemon_rename=self.fake_daemon_rename(),
                                   store=self.store, poll_secs=1)
        self.assertEqual(res["named"], [])
        self.assertEqual(len(res["remaining"]), 2)

    def test_missing_store_is_a_stated_refusal(self):
        res = name_chats.name_pass("t", probe_runner=self.fake_probe(),
                                   daemon_rename=self.fake_daemon_rename(),
                                   store=Path(self._tmp.name) / "nope", poll_secs=1)
        self.assertIsNone(res["remaining"])
        self.assertIn("no chat store", res["why"])


if __name__ == "__main__":
    unittest.main()
