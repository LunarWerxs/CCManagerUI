"""overlord.settle_twins (the HANDOFF path's archive step, run after a quota-handoff/nudge
relocation): it writes the disk flag directly, bypassing archive_chat.py's rails, so before
this fix a running app's later re-save (the same erase reconcile.py's janitor-path docstring
describes) had no ledger row to be caught by - the twin surfaced again only through the FULL
archive-candidate pipeline, preserve turn included. settle_twins now records the same
`ledgerlib.note("archive", ...)` archive_chat.py records, putting it on reconcile's radar so a
revert converges through archive_chat's --no-preserve retry - no extra closeout turn."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402
import overlord  # noqa: E402
import reconcile  # noqa: E402


class HandoffArchiveConvergesTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.chats = {}  # sid -> (instance, archived), as reconcile's dossier read sees it
        stub = self.stub

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            if sid not in self.chats:
                return {"matches": []}
            inst, archived = self.chats[sid]
            return {"matches": [{"instance": inst, "chatId": f"c-{sid}", "cliSessionId": sid,
                                 "lineageIds": [sid], "title": f"chat {sid}",
                                 "archived": archived, "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "closed", "dir": "c:\\i\\closed", "isRunning": False},
        ]}
        # A zombie-twin meta file, as current_match() would hand settle_twins.
        self._meta = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump({"isArchived": False, "cliSessionId": "s1", "title": "chat s1"}, self._meta)
        self._meta.close()

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()
        os.unlink(self._meta.name)

    def test_settle_twins_puts_the_handoff_archive_on_reconcile_s_radar(self):
        # The handoff path settles a zombie twin: disk flag flipped, and (the fix) a ledger
        # row recorded - the same row archive_chat.py itself would leave behind.
        report = overlord.settle_twins([{"metaPath": self._meta.name, "cliSessionId": "s1"}])
        self.assertIn("1 flagged", report)
        on_disk = json.loads(Path(self._meta.name).read_text())
        self.assertTrue(on_disk["isArchived"])
        rows = [r for r in ledgerlib._load() if r.get("kind") == "archive" and r.get("session") == "s1"]
        self.assertEqual(len(rows), 1)

    def test_erased_handoff_archive_converges_without_an_extra_closeout_turn(self):
        import unittest.mock as mock

        overlord.settle_twins([{"metaPath": self._meta.name, "cliSessionId": "s1"}])
        # THE ERASE: the running app re-saves its in-memory chat list over the file, exactly
        # the shape reconcile.py's docstring describes - disk (dossier) now disagrees with
        # what was just settled.
        self.chats["s1"] = ("closed", False)
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "reverted")
        with mock.patch("archive_chat.main", return_value=0) as m:
            out = reconcile.retry(r["reverted"])
        # --no-preserve: no extra closeout turn asking it to update docs again - the same
        # convergence a janitor-caused revert gets, not a fresh preserve request.
        m.assert_called_once_with(["s1", "--no-preserve"])
        self.assertIn("re-archived", out[0]["outcome"])


if __name__ == "__main__":
    unittest.main()
