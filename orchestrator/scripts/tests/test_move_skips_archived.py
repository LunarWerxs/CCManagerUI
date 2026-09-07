"""A MOVE TOUCHES UNARCHIVED CHATS ONLY (owner, Michael, 2026-09-05: "when I tell you to move,
only move UN archived chats. Not archived ones. Make sure that's the default. Unless asked").

WHY THIS FILE EXISTS, and why the assertions are shaped the way they are. On 2026-09-05 an agent
was told to spread one account's chats across two others. It moved eight, then reported the source
account drained. Two things were wrong at once, and only the first was visible:

  1. A live, UNARCHIVED chat was still sitting there. The sweep had enumerated through
     hydralib.sessions(), whose default window answered 21 rows that day against 500 for
     all+archived, and the chat was simply not in the answer. "no chats match" was read as
     "the account is empty" - the one reading a windowed answer can never support.
  2. Nothing anywhere refused to move an ARCHIVED chat. The agent's own judgment was the only
     thing that had kept retired twins off a live account, and judgment is not a guarantee.

So these pin BOTH halves, because fixing either alone leaves the same failure reachable:
  - an archived chat is refused with exit 7, and the refusal names the flag that would allow it;
  - --archived is the one word that allows it, and --force alone never does;
  - the refusal fires on --dry-run too (a plan that says "would move" for a chat the real run
    refuses is the trap, not a convenience);
  - resolution asks the COMPLETE question, so an archived chat comes back as exit 7 and never as
    the far more misleading "no such chat".
"""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_chat  # noqa: E402
from lib import holdlib, hydralib  # noqa: E402
from stubdaemon import StubDaemon  # noqa: E402
from util import run_cli  # noqa: E402

SID = "3c6d0acd-344f-4273-a0f5-95426eb48621"


def fleet():
    return {"instances": [
        {"num": 27, "name": "anothuh1", "label": None, "dir": "c:\\i\\anothuh1",
         "ref": "desktop:c:\\i\\anothuh1", "isRunning": True, "signedIn": True,
         "account": {"email": "thomas@example.com", "planLabel": "Max 20×"}},
        {"num": 36, "name": "anutha23", "label": "Ada", "dir": "c:\\i\\anutha23",
         "ref": "desktop:c:\\i\\anutha23", "isRunning": True, "signedIn": True,
         "account": {"email": "darragh@example.com", "planLabel": "Max 20×"}},
    ]}


class ArchivedMoveTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = fleet()
        self._patches = [
            mock.patch.object(migrate_chat, "BYPASS_WATCH_SECS", 0),
            mock.patch.object(migrate_chat, "confirm_bypass_in_app",
                              lambda *_a, **_k: "REFUSED: no window (test)"),
            mock.patch.object(migrate_chat, "_pretrust_workspace", lambda *_a, **_k: None),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _archived_chat(self):
        def route(method, path, query, body):
            return {"matches": [{"instance": "anothuh1", "chatId": "local_a", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "Gitprotekt OVH server crash",
                                 "archived": True, "lastActivityAt": "T1", "live": None}]}
        self.stub.routes["/api/chats/dossier"] = route

    def _live_chat(self):
        def route(method, path, query, body):
            return {"matches": [{"instance": "anothuh1", "chatId": "local_b", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "Gitprotekt OVH server crash",
                                 "archived": False, "lastActivityAt": "T1", "live": None}]}
        self.stub.routes["/api/chats/dossier"] = route

    def test_archived_chat_is_refused_with_exit_7(self):
        self._archived_chat()
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "36", "--now", "--json"])
        self.assertEqual(code, 7, out)
        payload = json.loads(out)
        self.assertFalse(payload["landed"])
        self.assertTrue(payload["archivedSkipped"])
        self.assertIn("ARCHIVED", payload["report"])
        # The refusal must name the way past it, or the next caller guesses (and the usual
        # guess is --force, which is a different word for a different thing).
        self.assertIn("--archived", payload["report"])
        # NOTHING was posted: a refusal that still touched the daemon is not a refusal.
        self.assertEqual(self.stub.posts, [])

    def test_archived_flag_is_the_one_word_that_allows_it(self):
        self._archived_chat()
        code, out, _ = run_cli(
            migrate_chat.main, [SID, "--to", "36", "--now", "--archived", "--dry-run", "--json"])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertTrue(payload["dryRun"])
        self.assertIn("DRY RUN", payload["report"])

    def test_force_alone_does_not_drag_an_archived_chat_along(self):
        """--force is a person's word about ONE chat's hold. It must not quietly widen the
        CLASS of chats a move will touch - otherwise every hold override becomes an archived
        move too, and the default this file defends would be one flag away from gone."""
        self._archived_chat()
        with mock.patch.object(holdlib, "why_blocked", return_value=None):
            code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "36", "--now", "--force", "--json"])
        self.assertEqual(code, 7, out)
        self.assertEqual(self.stub.posts, [])

    def test_the_refusal_fires_on_dry_run_too(self):
        """A dry run is what an operator (or an agent) reads before acting. If it plans a move
        the real run would refuse, the plan is worse than nothing: this is the exact shape of
        the 2026-09-05 miss, where every dry run said 'would move'."""
        self._archived_chat()
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "36", "--now", "--dry-run", "--json"])
        self.assertEqual(code, 7, out)
        self.assertNotIn("DRY RUN", json.loads(out)["report"])

    def test_an_unarchived_chat_is_untouched_by_the_guard(self):
        """The guard must be narrow. A normal move plans exactly as before."""
        self._live_chat()
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "36", "--now", "--dry-run", "--json"])
        self.assertEqual(code, 0, out)
        self.assertTrue(json.loads(out)["dryRun"])

    def test_resolution_asks_the_complete_question(self):
        """The fallback table scan must not be windowed. A move that cannot SEE a chat reports
        'no such chat', which sends the caller looking for a chat that is sitting right there;
        seeing it and refusing it by name is the answer that can be acted on."""
        seen = {}

        def route(method, path, query, body):
            seen["query"] = query
            return []
        self.stub.routes["/api/sessions"] = route
        self.stub.routes["/api/chats/dossier"] = {"matches": []}
        run_cli(migrate_chat.main, ["no-such-chat-anywhere", "--to", "36", "--json"])
        self.assertIn("period=all", seen.get("query", ""))
        self.assertIn("archived=include", seen.get("query", ""))


if __name__ == "__main__":
    unittest.main()
