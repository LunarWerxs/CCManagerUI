"""migrate_chat.py and rename_chat.py against a stub daemon: refusals, verify, honesty."""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

SID = "bbbb1111-2222-3333-4444-555566667777"


def fleet():
    return {
        "instances": [
            {"num": 2, "name": "2claude", "dir": "c:\\i\\2claude", "ref": "desktop:c:\\i\\2claude", "isRunning": True},
            {"num": 3, "name": "3claude", "dir": "c:\\i\\3claude", "ref": "desktop:c:\\i\\3claude", "isRunning": False},
        ]
    }


class ActTestBase(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        from lib import hydralib
        import migrate_chat

        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = fleet()
        # The post-landing bypass watch is real seconds in production (the app's boot re-save
        # is what it waits for); a stub daemon boots nothing, so one pass is the whole watch.
        self._watch = mock.patch.object(migrate_chat, "BYPASS_WATCH_SECS", 0)
        self._watch.start()
        # ⛔ NO TEST MAY REACH THE REAL PICKER - same rail as test_migrate_fast_path's base:
        # confirm_bypass_in_app drives a PowerShell actuator at a live Electron window, and
        # every target in this suite's fleet is isRunning=True.
        self._picker = mock.patch.object(migrate_chat, "confirm_bypass_in_app",
                                         lambda _row, _fleet: "REFUSED: no window (test)")
        self._picker.start()

    def tearDown(self):
        self._picker.stop()
        self._watch.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def dossier_static(self, instance="temp1", title="T", after_instance=None, after_title=None,
                       live=None):
        stub = self.stub

        def route(method, path, query, body):
            acted = any("/import-desktop" in p or "/rename" in p for p, _ in stub.posts)
            now_title = (after_title or title) if acted else title
            q = dossier_query(query)
            # answer BY the query, like the real daemon: id, or a fragment of either title
            if q != SID and q not in title and q not in now_title:
                return {"matches": []}
            return {
                "matches": [
                    {
                        "instance": (after_instance or instance) if acted else instance,
                        "chatId": "local_y",
                        "cliSessionId": SID,
                        "lineageIds": [SID],
                        "title": now_title,
                        "archived": False,
                        "lastActivityAt": "T1",
                        "live": live,
                    }
                ]
            }

        stub.routes["/api/chats/dossier"] = route


class MigrateTest(ActTestBase):
    def test_lands_verifies_and_clears(self):
        from lib import ledgerlib
        import migrate_chat

        self.dossier_static(after_instance="2claude")
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        code = migrate_chat.main([SID, "--to", "2"])
        self.assertEqual(code, 0)
        posts = [b for p, b in self.stub.posts if p.endswith("/import-desktop")]
        # confirm_title restates the current title - the daemon's naming door demands a real
        # title or exactly this proof of programmatic review on EVERY import
        self.assertEqual(posts, [{"instance_ref": "desktop:c:\\i\\2claude", "confirm_title": "T"}])
        self.assertEqual(len(ledgerlib._load()), 0)

    def test_unknown_instance_is_deterministic(self):
        from lib import ledgerlib
        import migrate_chat

        self.dossier_static()
        self.assertEqual(migrate_chat.main([SID, "--to", "nope"]), 3)
        self.assertEqual(self.stub.posts, [])
        self.assertTrue(ledgerlib.check("migrate", SID)["deterministic"])

    def test_superseded_409_is_deterministic(self):
        from lib import ledgerlib
        import migrate_chat

        self.dossier_static()
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = (409, {"error": "superseded: kept x"})
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude"]), 3)
        self.assertTrue(ledgerlib.check("migrate", SID)["deterministic"])

    def test_unverified_landing_is_not_claimed(self):
        from lib import ledgerlib
        import migrate_chat

        self.dossier_static(after_instance="temp1")  # dossier never shows the move
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude"]), 1)
        # confirmed disagreement (the dossier came back and does NOT show the move) is False.
        self.assertEqual(ledgerlib._load()[-1]["verified"], False)

    def test_verify_read_back_failure_is_unknown_not_a_confirmed_disagreement(self):
        # never claim an act landed without checking: the import POST can succeed while the
        # verify read-back itself fails (daemon blip, timeout) - that is UNKNOWN, not the same
        # False a dossier that came back and disagreed would get.
        from lib import hydralib, ledgerlib
        import migrate_chat

        self.dossier_static(after_instance="2claude")
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        real_dossier = hydralib.dossier

        def flaky_dossier(query):
            if any(p.endswith("/import-desktop") for p, _ in self.stub.posts):
                raise hydralib.DaemonError("/api/chats/dossier", None, "boom")
            return real_dossier(query)

        with mock.patch.object(migrate_chat.hydralib, "dossier", side_effect=flaky_dossier):
            code = migrate_chat.main([SID, "--to", "2claude"])
        self.assertEqual(code, 1)
        rows = ledgerlib._load()
        self.assertIsNone(rows[-1]["verified"])  # unknown - never False
        uq = ledgerlib.unverified()
        self.assertEqual(len(uq), 1)
        self.assertEqual(uq[0]["status"], "unknown")

    def test_already_there_changes_nothing(self):
        import migrate_chat

        self.dossier_static(instance="2claude")
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude"]), 0)
        self.assertEqual(self.stub.posts, [])

    def test_console_only_session_resolves_via_sessions_table_and_lands(self):
        # The dossier only knows desktop records; a console stray MUST still be migratable
        # (the live fleet's whole land-console lane died on this before the fallback).
        from lib import ledgerlib
        import migrate_chat

        stub = self.stub

        def dossier_route(method, path, query, body):
            landed = any(p.endswith("/import-desktop") for p, _ in stub.posts)
            if not landed:
                return {"matches": []}
            return {"matches": [{"instance": "2claude", "chatId": "local_z", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "Console stray", "archived": False,
                                 "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "Console stray", "instance": None,
             "tool": "claude-code", "last_activity_at": 5}
        ]
        stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        code = migrate_chat.main([SID, "--to", "2claude"])
        self.assertEqual(code, 0)
        posts = [b for p, b in stub.posts if p.endswith("/import-desktop")]
        self.assertEqual(posts, [{"instance_ref": "desktop:c:\\i\\2claude",
                                  "confirm_title": "Console stray"}])
        self.assertEqual(len(ledgerlib._load()), 0)

    def test_daemon_live_refusal_is_transient_exit_4(self):
        from lib import ledgerlib
        import migrate_chat

        self.dossier_static()
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = (
            422, {"error": "refused: session is live"})
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude"]), 4)
        self.assertFalse(ledgerlib.check("migrate", SID)["deterministic"])  # NOT permanent

    def test_live_writer_refuses_even_with_force(self):
        import migrate_chat

        self.dossier_static(live={"pid": 11, "name": "w"})
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude", "--force"]), 4)
        self.assertEqual(self.stub.posts, [])

    def test_verified_landing_stamps_bypass_permissions(self):
        # The automation doctrine (owner, 2026-08-31): every landed chat is stamped
        # bypassPermissions via the daemon's own endpoint, after the landing verifies.
        import json

        import migrate_chat
        from util import run_cli

        self.dossier_static(after_instance="2claude")
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        self.stub.routes[f"/api/sessions/{SID}/automation"] = {"ok": True, "mode": "bypassPermissions"}
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2", "--json"])
        self.assertEqual(code, 0)
        stamps = [p for p, _ in self.stub.posts if p.endswith("/automation")]
        self.assertEqual(len(stamps), 1)
        payload = json.loads(out)
        self.assertTrue(payload["bypassStamped"])
        self.assertIn("stamped bypassPermissions", payload["report"])

    def test_failed_stamp_never_unlands_but_is_reported(self):
        import json

        import migrate_chat
        from util import run_cli

        self.dossier_static(after_instance="2claude")
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        self.stub.routes[f"/api/sessions/{SID}/automation"] = (422, {"ok": False})
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2", "--json"])
        self.assertEqual(code, 0)  # the landing stands
        payload = json.loads(out)
        self.assertTrue(payload["landed"])
        self.assertFalse(payload["bypassStamped"])
        self.assertIn("stamp", payload["report"].lower())

    def test_landing_stamps_ultracode_into_the_meta_record(self):
        # The doctrine's mechanical half: a verified landing writes sessionSettings.ultracode
        # + effort=xhigh into the chat's meta on disk - never prompt words.
        import json
        import tempfile

        import migrate_chat
        from util import run_cli

        with tempfile.TemporaryDirectory() as td:
            meta = Path(td) / "local_y.json"
            meta.write_text(json.dumps({"cliSessionId": SID, "title": "T",
                                        "model": "claude-opus-4-8"}), encoding="utf-8")
            stub = self.stub

            def route(method, path, query, body):
                acted = any("/import-desktop" in p for p, _ in stub.posts)
                q = dossier_query(query)
                if q != SID and q not in "T":
                    return {"matches": []}
                return {"matches": [{"instance": "2claude" if acted else "temp1",
                                     "chatId": "local_y", "cliSessionId": SID,
                                     "lineageIds": [SID], "title": "T", "archived": False,
                                     "lastActivityAt": "T1", "live": None,
                                     "metaPath": str(meta)}]}

            stub.routes["/api/chats/dossier"] = route
            stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
            stub.routes[f"/api/sessions/{SID}/automation"] = {"ok": True}
            code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2", "--json"])
            self.assertEqual(code, 0)
            payload = json.loads(out)
            self.assertTrue(payload["ultracodeStamped"])
            written = json.loads(meta.read_text(encoding="utf-8"))
            self.assertIs(written["sessionSettings"]["ultracode"], True)
            self.assertEqual(written["effort"], "xhigh")
            self.assertEqual(written["model"], "claude-opus-4-8")  # model never touched

    def test_landing_settles_the_running_source_row(self):
        # The zombie-row leak (2026-08-31): a running source app re-saves the daemon's
        # archived flag away, leaving a visible stale twin after every migration. The
        # landing now drives the source app's OWN archive control to settle it.
        import unittest.mock as mock

        import migrate_chat

        stub = self.stub
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 2, "name": "2claude", "dir": "c:\\i\\2claude", "ref": "desktop:c:\\i\\2claude", "isRunning": True},
            {"num": 4, "name": "src", "dir": "c:\\i\\src", "ref": "desktop:c:\\i\\src", "isRunning": True},
        ]}

        def route(method, path, query, body):
            acted = any("/import-desktop" in p for p, _ in stub.posts)
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [{"instance": "2claude" if acted else "src", "chatId": "local_y",
                                 "cliSessionId": SID, "lineageIds": [SID], "title": "T",
                                 "archived": False, "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = route
        stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        with mock.patch.object(migrate_chat, "_settle_source", return_value=(0, "Archive done")) as m:
            code = migrate_chat.main([SID, "--to", "2claude"])
        self.assertEqual(code, 0)
        # Dir-first (2026-09-06): the fixture's fleet row carries a dir for "src", so the
        # actuator (and the window lock it keys inside _settle_source) must be aimed at
        # that unique profile dir, never the bare leaf name a sibling profile could share.
        m.assert_called_once_with("c:\\i\\src", "T")

    def test_closed_source_needs_no_settle(self):
        import unittest.mock as mock

        import migrate_chat

        self.dossier_static(after_instance="2claude")  # source 'temp1' is not in the fleet
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        with mock.patch.object(migrate_chat, "_settle_source") as m:
            self.assertEqual(migrate_chat.main([SID, "--to", "2"]), 0)
        m.assert_not_called()

    def test_refusals_never_post_a_stamp(self):
        import migrate_chat

        self.dossier_static(live={"pid": 11, "name": "w"})
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude"]), 4)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/automation")], [])

    def test_400_is_deterministic_not_retried(self):
        from lib import ledgerlib
        import migrate_chat

        self.dossier_static()
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = (400, {"error": "title required"})
        self.assertEqual(migrate_chat.main([SID, "--to", "2claude"]), 3)
        self.assertTrue(ledgerlib.check("migrate", SID)["deterministic"])

    def test_source_still_visible_reads_the_un_archived_flag_from_disk(self):
        # _source_still_visible is the double-check after a settle (owner, 2026-09-01: "it
        # can't do it blind; it must always double check, confirm") - the app's own control
        # said one thing, the meta record on disk is what actually answers.
        import migrate_chat

        with tempfile.TemporaryDirectory() as td:
            src_root = Path(td) / "src" / "claude-code-sessions" / "a" / "b"
            src_root.mkdir(parents=True)
            meta = src_root / "local_y.json"
            meta.write_text(json.dumps({"cliSessionId": SID, "isArchived": False, "title": "T"}),
                            encoding="utf-8")
            self.stub.routes["/api/fleet"] = {
                "instances": [{"num": 4, "name": "src", "dir": str(Path(td) / "src"),
                              "ref": "desktop:c:\\i\\src", "isRunning": True}]}
            self.assertTrue(migrate_chat._source_still_visible(SID, "src"))
            meta.write_text(json.dumps({"cliSessionId": SID, "isArchived": True, "title": "T"}),
                            encoding="utf-8")
            self.assertFalse(migrate_chat._source_still_visible(SID, "src"))

    def _settle_verify_fixture(self, td, archived_on_disk):
        """A landing whose source instance ('src') is RUNNING and has ONE meta record for SID,
        archived or not - the shape _settle_source's exit-3 double-check must re-read."""
        src_root = Path(td) / "src" / "claude-code-sessions" / "a" / "b"
        src_root.mkdir(parents=True)
        (src_root / "local_y.json").write_text(
            json.dumps({"cliSessionId": SID, "isArchived": archived_on_disk, "title": "T"}),
            encoding="utf-8")
        stub = self.stub
        stub.routes["/api/fleet"] = {
            "instances": [
                {"num": 2, "name": "2claude", "dir": "c:\\i\\2claude",
                 "ref": "desktop:c:\\i\\2claude", "isRunning": True},
                {"num": 4, "name": "src", "dir": str(Path(td) / "src"),
                 "ref": "desktop:c:\\i\\src", "isRunning": True},
            ]
        }

        def route(method, path, query, body):
            acted = any("/import-desktop" in p for p, _ in stub.posts)
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [{"instance": "2claude" if acted else "src", "chatId": "local_y",
                                 "cliSessionId": SID, "lineageIds": [SID], "title": "T",
                                 "archived": False, "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = route
        stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}

    def test_settle_exit_3_with_the_source_STILL_VISIBLE_falls_back_to_the_disk_flag(self):
        # THE DOUBLE-CHECK (owner, 2026-09-01): exit 3 is not "already settled" - a row that
        # is not rendered is not archived. But naming the twin and stopping there was not
        # enough either (live, 2026-09-04): a window that renders NO rows returns 3 for every
        # chat, so nine moves off it left nine twins and only a warning nobody saw. A window
        # that never rendered the row has nothing on screen to re-save from, so the weaker
        # disk flag is written and the state is 'flagged', not 'visible'.
        import migrate_chat
        from util import run_cli

        with tempfile.TemporaryDirectory() as td:
            self._settle_verify_fixture(td, archived_on_disk=False)
            meta = Path(td) / "src" / "claude-code-sessions" / "a" / "b" / "local_y.json"
            with mock.patch.object(migrate_chat, "_settle_source", return_value=(3, "not rendered")), \
                 mock.patch.object(migrate_chat.time, "sleep"):
                code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2claude", "--json"])
            self.assertEqual(code, 0)
            payload = json.loads(out)
            self.assertEqual(payload["sourceRow"], "flagged")
            self.assertNotIn("STILL VISIBLE", payload["report"])
            self.assertTrue(json.loads(meta.read_text(encoding="utf-8"))["isArchived"])

    def test_a_CLOSED_source_instance_is_VERIFIED_too_never_assumed_settled(self):
        """"A closed app's disk flag is durable on its own" was a claim about the daemon's
        import, not a check of it - and two closed-instance twins from older moves were
        sitting on this machine when it was finally checked (2026-09-04). One store scan."""
        import migrate_chat
        from util import run_cli

        with tempfile.TemporaryDirectory() as td:
            self._settle_verify_fixture(td, archived_on_disk=False)
            for inst in self.stub.routes["/api/fleet"]["instances"]:
                if inst["name"] == "src":
                    inst["isRunning"] = False
            meta = Path(td) / "src" / "claude-code-sessions" / "a" / "b" / "local_y.json"
            with mock.patch.object(migrate_chat, "_settle_source") as settle:
                code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2claude", "--json"])
            settle.assert_not_called()  # a closed app has no control to drive
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out)["sourceRow"], "flagged")
            self.assertTrue(json.loads(meta.read_text(encoding="utf-8"))["isArchived"])

    def test_a_twin_that_survives_even_the_disk_flag_is_named_and_annotated(self):
        import migrate_chat
        from lib import ledgerlib
        from util import run_cli

        with tempfile.TemporaryDirectory() as td:
            self._settle_verify_fixture(td, archived_on_disk=False)
            with mock.patch.object(migrate_chat, "_settle_source", return_value=(3, "not rendered")), \
                 mock.patch.object(migrate_chat, "_archive_source_on_disk", return_value=False), \
                 mock.patch.object(migrate_chat.time, "sleep"):
                code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2claude", "--json"])
            self.assertEqual(code, 0)  # the landing itself still stands
            payload = json.loads(out)
            self.assertEqual(payload["sourceRow"], "visible")
            self.assertFalse(payload["sourceSettled"])
            self.assertIn("STILL VISIBLE", payload["report"])
            rows = ledgerlib._load()
            annotated = [r for r in rows if r.get("kind") == "migrate" and r.get("session") == SID]
            self.assertTrue(annotated and "still visible" in annotated[-1].get("outcome", ""))

    def test_settle_exit_3_with_the_source_actually_archived_is_a_clean_settle(self):
        import migrate_chat
        from util import run_cli

        with tempfile.TemporaryDirectory() as td:
            self._settle_verify_fixture(td, archived_on_disk=True)
            with mock.patch.object(migrate_chat, "_settle_source", return_value=(3, "not rendered")), \
                 mock.patch.object(migrate_chat.time, "sleep"):
                code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2claude", "--json"])
            self.assertEqual(code, 0)
            payload = json.loads(out)
            self.assertNotIn("STILL VISIBLE", payload["report"])
            self.assertIn("settled through its app", payload["report"])


class RenameTest(ActTestBase):
    """rename_chat drives THIS repo's sidebar actuator (rename_chat._drive_rename) since the
    live smoke of 2026-09-01 - the daemon's /rename route ran AgentHydra's copy, which
    refuses every currently-open chat as ambiguous. The drive is mocked here; the actuator
    itself is proven live."""

    def _drive(self, code=0, text="renamed"):
        import rename_chat

        calls = []

        def fake(instance, old_title, new_title):
            calls.append((instance, old_title, new_title))
            # dossier_static flips to the after-state once an act is seen on the stub's
            # post log; the drive is local now, so record it there ourselves.
            if code == 0:
                self.stub.posts.append(("/actuator/rename-drive", {"new_title": new_title}))
            return code, text

        patcher = mock.patch.object(rename_chat, "_drive_rename", side_effect=fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_renames_verifies_and_clears(self):
        from lib import ledgerlib
        import rename_chat

        self.dossier_static(title="Old", after_title="New name")
        calls = self._drive()
        code = rename_chat.main([SID, "--to", "New name"])
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("temp1", "Old", "New name")])
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/rename")], [])
        self.assertEqual(len(ledgerlib._load()), 0)

    def test_not_rendered_in_the_instance_is_deterministic(self):
        from lib import ledgerlib
        import rename_chat

        self.dossier_static(title="Old")
        self._drive(code=3, text="not rendered: the row is not in the sidebar")
        self.assertEqual(rename_chat.main([SID, "--to", "New"]), 3)
        self.assertTrue(ledgerlib.check("rename", "local_y")["deterministic"])

    def test_an_actuator_failure_is_recorded_not_claimed(self):
        from lib import ledgerlib
        import rename_chat

        self.dossier_static(title="Old", after_title="Old")
        self._drive(code=1, text="AMBIGUOUS: 2 rendered chats end with 'Old'")
        self.assertEqual(rename_chat.main([SID, "--to", "New"]), 1)
        self.assertEqual(len(ledgerlib._load()), 1)  # the attempt is on the ledger

    def test_unverified_rename_is_not_claimed(self):
        from lib import ledgerlib
        import rename_chat

        self.dossier_static(title="Old", after_title="Old")  # dossier keeps the old name
        self._drive()
        self.assertEqual(rename_chat.main([SID, "--to", "New"]), 1)
        # a real disagreement (the read-back succeeded and says no) is recorded False, distinct
        # from the read-back-itself-failed 'unknown' case above.
        self.assertEqual(ledgerlib._load()[-1]["verified"], False)

    def test_verify_read_back_failure_is_unknown_not_a_confirmed_disagreement(self):
        # never claim an act landed without checking: when the VERIFY read-back itself fails
        # (not "the dossier disagrees" - the call could not be made at all), the ledger must
        # record unknown, never silently collapse to the same False a real disagreement gets.
        from lib import hydralib, ledgerlib
        import rename_chat

        self.dossier_static(title="Old", after_title="New")
        self._drive()
        real_dossier = hydralib.dossier
        seen = {"n": 0}

        def flaky_dossier(query):
            seen["n"] += 1
            if seen["n"] >= 2:  # the resolve succeeds; only the post-act verify call fails
                raise hydralib.DaemonError("/api/chats/dossier", None, "boom")
            return real_dossier(query)

        with mock.patch.object(rename_chat.hydralib, "dossier", side_effect=flaky_dossier):
            code = rename_chat.main([SID, "--to", "New"])
        self.assertEqual(code, 1)
        rows = ledgerlib._load()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[-1]["verified"])  # unknown - never False
        uq = ledgerlib.unverified()
        self.assertEqual(len(uq), 1)
        self.assertEqual(uq[0]["status"], "unknown")

    def test_same_title_changes_nothing(self):
        import rename_chat

        self.dossier_static(title="Same")
        calls = self._drive()
        self.assertEqual(rename_chat.main([SID, "--to", "Same"]), 0)
        self.assertEqual(calls, [])

    def test_held_chat_is_refused_without_force(self):
        # A hold is a person's word and outranks every verdict (rule 5) - this closes
        # drill.py's --rename round trip renaming a held chat out from under whoever placed
        # the hold, since drill.py's --rename goes through this script.
        from lib import holdlib
        import rename_chat

        self.dossier_static(title="Old")
        calls = self._drive()
        holdlib.hold(SID, "I am working this one")
        self.assertEqual(rename_chat.main([SID, "--to", "New"]), 6)
        self.assertEqual(calls, [])  # the app was never driven

    def test_held_chat_renames_with_force(self):
        # --force is the person speaking again - it lifts the hold for this one act, the
        # same rule every other act script (archive_chat.py, migrate_chat.py) follows.
        from lib import holdlib
        import rename_chat

        self.dossier_static(title="Old", after_title="New name")
        calls = self._drive()
        holdlib.hold(SID, "I am working this one")
        self.assertEqual(rename_chat.main([SID, "--to", "New name", "--force"]), 0)
        self.assertEqual(calls, [("temp1", "Old", "New name")])


if __name__ == "__main__":
    unittest.main()
