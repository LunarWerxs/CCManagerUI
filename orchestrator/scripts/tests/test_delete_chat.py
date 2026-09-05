"""delete_chat.py: a probe chat leaves NOTHING in the account - meta record and transcript
gone, an undo copy taken first, the running app's own Delete control driven where an app
holds the chat, every rail (hold, live writer, ambiguity) refusing before a byte moves."""

import json
import os
import shutil
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402
from util import run_cli  # noqa: E402

import delete_chat  # noqa: E402
from lib import holdlib, hydralib, ledgerlib, mutationlib  # noqa: E402

SID = "aaaa1111-2222-3333-4444-555566667777"
OTHER = "bbbb1111-2222-3333-4444-555566667777"


class DeleteChatTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        os.environ["ORCHESTRATOR_STATE_DIR"] = str(self.root / "state")
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        # one isolated instance store holding the chat's meta record, one transcript
        self.inst = self.root / "inst1"
        self.meta = self.inst / "claude-code-sessions" / "acct" / "org" / "local_x.json"
        self.meta.parent.mkdir(parents=True)
        self.meta.write_text(json.dumps({"cliSessionId": SID, "title": "Probe",
                                         "isArchived": False}), encoding="utf-8")
        self.transcript = self.root / "proj" / f"{SID}.jsonl"
        self.transcript.parent.mkdir()
        self.transcript.write_text(json.dumps({"type": "user", "message": {"content": "ping"}})
                                   + "\n", encoding="utf-8")
        self.running = False
        self.live = None
        stub = self
        self.stub.routes["/api/fleet"] = lambda m, p, q, b: {"instances": [
            {"num": 1, "name": "inst1", "dir": str(stub.inst), "isRunning": stub.running,
             "signedIn": True}]}
        self.stub.routes["/api/chats/dossier"] = lambda m, p, q, b: {"matches": (
            [{"instance": "inst1", "chatId": "local_x", "cliSessionId": SID, "lineageIds": [SID],
              "title": "Probe", "archived": False, "live": stub.live, "metaPath": str(stub.meta)}]
            if stub.meta.exists() and dossier_query(q) in (SID, "Probe") else [])}
        self.stub.routes[f"/api/sessions/{SID}"] = lambda m, p, q, b: (
            {"session_id": SID, "title": "Probe", "transcript_path": str(stub.transcript)}
            if stub.transcript.exists() else (404, {"error": "no such session"}))
        self.stub.routes["/api/sessions"] = []
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        # never scan this machine's real stores from a unit test
        for name, value in (("store_roots", lambda fleet: [
                {"instance": "inst1", "root": stub.inst / "claude-code-sessions",
                 "isRunning": stub.running}]),
                            ("transcript_index", lambda fleet: {})):
            p = mock.patch.object(delete_chat.stamplib, name, side_effect=value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(delete_chat.gatelib, "find_transcript_on_disk",
                              side_effect=lambda sid: str(stub.transcript)
                              if sid == SID and stub.transcript.exists() else "")
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(delete_chat, "VERIFY_SECS", 0)
        p.start()
        self.addCleanup(p.stop)
        # the sidecar sweep globs the CLI projects root: point it at this test's tree
        p = mock.patch.object(delete_chat.gatelib, "_PROJECTS_ROOT", self.root)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def test_deletes_record_and_transcript_with_an_undo_copy_and_records_the_mutation(self):
        code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertTrue(got["ok"])
        self.assertFalse(self.meta.exists())
        self.assertFalse(self.transcript.exists())
        trash = Path(got["trash"])
        manifest = json.loads((trash / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual({i["kind"] for i in manifest["items"]}, {"meta", "transcript"})
        for item in manifest["items"]:
            self.assertTrue((trash / item["name"]).exists())
        self.assertEqual(got["remaining"], [])
        self.assertEqual(got["ui"], [])  # the app was not running: no UI control driven
        kinds = [m["kind"] for m in mutationlib.list_mutations(SID)]
        self.assertEqual(kinds, ["delete"])

    def test_undo_puts_both_files_back(self):
        run_cli(delete_chat.main, [SID, "--json"])
        self.assertFalse(self.meta.exists())
        code, out, _ = run_cli(delete_chat.main, ["--undo", SID, "--json"])
        self.assertEqual(code, 0, out)
        self.assertTrue(self.meta.exists())
        self.assertTrue(self.transcript.exists())
        self.assertEqual(json.loads(self.meta.read_text(encoding="utf-8"))["title"], "Probe")

    def test_a_held_chat_is_refused_and_force_is_a_persons_word(self):
        holdlib.hold(SID, "mine", by="owner")
        code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 3)
        self.assertIn("HELD", json.loads(out)["why"])
        self.assertTrue(self.meta.exists())
        self.assertTrue(self.transcript.exists())
        code, _, _ = run_cli(delete_chat.main, [SID, "--json", "--force"])
        self.assertEqual(code, 0)
        self.assertFalse(self.meta.exists())

    def test_a_live_writer_is_refused_without_stop_idle_and_stopped_with_it(self):
        self.live = {"pid": 4242, "name": "claude", "startedAt": "2026-09-04T00:00:00Z"}
        code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 3)
        self.assertIn("LIVE writer", json.loads(out)["why"])
        self.assertTrue(self.meta.exists())
        stops = []

        def stop(match, min_quiet_secs=300, idle_after_secs=180):
            stops.append(min_quiet_secs)
            return {"stopped": True, "pid": 4242, "reason": "idle", "why": "idle 20s"}

        with mock.patch.object(delete_chat.enginelib, "background_work",
                               return_value={"scanned": True, "outstanding": []}), \
             mock.patch.object(delete_chat.enginelib, "stop_idle_engine", side_effect=stop):
            code, out, _ = run_cli(delete_chat.main, [SID, "--stop-idle", "--json"])
        self.assertEqual(code, 0, out)
        self.assertEqual(stops, [15])  # no background job outstanding: the fast window
        self.assertFalse(self.meta.exists())

    def test_a_working_engine_still_refuses_even_with_stop_idle(self):
        self.live = {"pid": 4242, "name": "claude"}
        with mock.patch.object(delete_chat.enginelib, "background_work",
                               return_value={"scanned": True, "outstanding": []}), \
             mock.patch.object(delete_chat.enginelib, "stop_idle_engine",
                               return_value={"stopped": False, "reason": "working",
                                             "why": "a turn is in flight"}):
            code, out, _ = run_cli(delete_chat.main, [SID, "--stop-idle", "--json"])
        self.assertEqual(code, 3)
        self.assertIn("in flight", json.loads(out)["why"])
        self.assertTrue(self.transcript.exists())

    def test_a_running_app_gets_its_own_delete_control_first_then_the_files_go(self):
        self.running = True
        calls = []

        def run_text(args, **kw):
            calls.append(args)
            return mock.Mock(returncode=0, stdout="Delete done for 'Probe'", stderr="")

        with mock.patch.object(delete_chat.clilib, "run_text", side_effect=run_text), \
             mock.patch.object(delete_chat.windowlib, "capture", return_value=None), \
             mock.patch.object(delete_chat.windowlib, "restore", return_value=None):
            code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 0, out)
        ui = [c for c in calls if "-Action" in c]
        self.assertEqual(len(ui), 1)
        self.assertEqual(ui[0][ui[0].index("-Action") + 1], "Delete")
        self.assertEqual(ui[0][ui[0].index("-Instance") + 1], str(self.inst))
        self.assertEqual(ui[0][ui[0].index("-Title") + 1], "Probe")
        got = json.loads(out)
        self.assertEqual(got["ui"][0]["exit"], 0)
        self.assertIsNone(got["note"])
        self.assertFalse(self.meta.exists())

    def test_an_unconfirmed_app_delete_is_reported_not_hidden(self):
        self.running = True
        with mock.patch.object(delete_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=3, stdout="FAIL: not rendered",
                                                      stderr="")), \
             mock.patch.object(delete_chat.windowlib, "capture", return_value=None), \
             mock.patch.object(delete_chat.windowlib, "restore", return_value=None):
            code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        got = json.loads(out)
        self.assertEqual(code, 0, out)  # the files are gone and verified
        self.assertIn("re-save", got["note"])
        self.assertEqual(got["ui"][0]["exit"], 3)

    def test_a_hinted_running_app_gets_the_ui_delete_even_before_its_record_hits_the_disk(self):
        # Measured 2026-09-04: a spawned chat answered, the app logged its session mapping,
        # and wrote no local_*.json for minutes - the sidebar row lives in the app's memory.
        self.meta.unlink()
        self.running = True
        calls = []

        def run_text(args, **kw):
            calls.append(args)
            return mock.Mock(returncode=0, stdout="Delete done for 'Probe'", stderr="")

        with mock.patch.object(delete_chat.clilib, "run_text", side_effect=run_text), \
             mock.patch.object(delete_chat.windowlib, "capture", return_value=None), \
             mock.patch.object(delete_chat.windowlib, "restore", return_value=None):
            res = delete_chat.delete(SID, instance_hint="1")
        self.assertTrue(res["ok"], res)
        ui = [c for c in calls if "-Action" in c]
        self.assertEqual(len(ui), 1)
        self.assertEqual(ui[0][ui[0].index("-Instance") + 1], str(self.inst))
        self.assertEqual(ui[0][ui[0].index("-Title") + 1], "Probe")  # the daemon's own title
        self.assertTrue(res["ui"][0]["hinted"])
        self.assertFalse(self.transcript.exists())
        # no hint, no record: nothing to drive, transcript still goes
        self.transcript.write_text("{}\n", encoding="utf-8")
        calls.clear()
        with mock.patch.object(delete_chat.clilib, "run_text", side_effect=run_text):
            res = delete_chat.delete(SID)
        self.assertTrue(res["ok"], res)
        self.assertEqual([c for c in calls if "-Action" in c], [])

    def test_sidecars_named_after_the_session_go_too_and_come_back_on_undo(self):
        # Measured 2026-09-04: the transcript was gone and `<sid>.desktop-released.json` sat
        # beside it - a file that still carries the chat's id is the chat not being deleted.
        sidecar = self.transcript.with_name(f"{SID}.desktop-released.json")
        sidecar.write_text("{}", encoding="utf-8")
        code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertEqual(got["sidecars"], [str(sidecar)])
        self.assertFalse(sidecar.exists())
        self.assertEqual(got["remaining"], [])
        code, _, _ = run_cli(delete_chat.main, ["--undo", SID, "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(sidecar.exists())
        # a session with ONLY a sidecar left (a previous delete could not see it) still resolves
        self.meta.unlink()
        self.transcript.unlink()
        code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 0, out)
        self.assertFalse(sidecar.exists())

    def test_a_transcript_only_session_is_deletable_by_its_id(self):
        self.meta.unlink()  # no desktop record anywhere: a console probe's shape
        code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 0, out)
        self.assertFalse(self.transcript.exists())
        self.assertEqual(json.loads(out)["records"], [])

    def test_not_found_and_ambiguity_refuse_before_anything_moves(self):
        code, out, _ = run_cli(delete_chat.main, [OTHER, "--json"])
        self.assertEqual(code, 3)
        self.assertIn("no chat matches", json.loads(out)["why"])
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"instance": "inst1", "cliSessionId": SID, "title": "Same", "archived": False},
            {"instance": "inst1", "cliSessionId": OTHER, "title": "Same", "archived": False}]}
        code, out, _ = run_cli(delete_chat.main, ["Same", "--json"])
        self.assertEqual(code, 3)
        self.assertIn("ambiguous", json.loads(out)["why"])
        self.assertTrue(self.meta.exists())
        self.assertTrue(self.transcript.exists())

    def test_something_left_behind_is_partial_exit_2_and_named(self):
        real_remove = delete_chat._remove

        def flaky(path):
            if path.suffix == ".jsonl":
                return f"{path}: locked by another process"
            return real_remove(path)

        with mock.patch.object(delete_chat, "_remove", side_effect=flaky):
            code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 2)
        got = json.loads(out)
        self.assertTrue(any("locked" in r for r in got["remaining"]))
        self.assertTrue(any("transcript" in r for r in got["remaining"]))
        self.assertTrue(self.transcript.exists())
        self.assertFalse(self.meta.exists())

    def test_released_sweep_lists_by_default_and_deletes_only_with_yes(self):
        # The app's own Delete leaves `<sid>.desktop-released.json` + the transcript behind.
        marker = self.transcript.with_name(f"{SID}.desktop-released.json")
        marker.write_text(json.dumps({"v": 1, "reason": "delete"}), encoding="utf-8")
        only_marker = self.root / "proj2" / f"{OTHER}.desktop-released.json"
        only_marker.parent.mkdir()
        only_marker.write_text(json.dumps({"v": 1, "reason": "delete"}), encoding="utf-8")
        self.meta.unlink()  # the app already removed its record, as it does
        code, out, _ = run_cli(delete_chat.main, ["--released", "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertFalse(got["act"])
        self.assertEqual(got["count"], 2)
        self.assertEqual(got["withTranscript"], 1)
        self.assertEqual({r["sessionId"] for r in got["results"]}, {SID, OTHER})
        self.assertTrue(marker.exists() and self.transcript.exists() and only_marker.exists())
        code, out, _ = run_cli(delete_chat.main, ["--released", "--yes", "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertTrue(all(r["deleted"] for r in got["results"]))
        self.assertFalse(marker.exists())
        self.assertFalse(self.transcript.exists())
        self.assertFalse(only_marker.exists())
        code, out, _ = run_cli(delete_chat.main, ["--released"])
        self.assertEqual(code, 0)
        self.assertIn("nothing left behind", out)

    def test_released_sweep_covers_every_instances_projects_root_not_just_the_default(self):
        # Review 2026-09-05: scanning ~/.claude/projects alone reports "clean" for leftovers
        # sitting in an isolated instance's own <dir>/projects tree.
        inst_marker = self.inst / "projects" / "some-project" / f"{OTHER}.desktop-released.json"
        inst_marker.parent.mkdir(parents=True)
        inst_marker.write_text(json.dumps({"reason": "delete"}), encoding="utf-8")
        self.meta.unlink()
        self.transcript.unlink()
        code, out, _ = run_cli(delete_chat.main, ["--released", "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertEqual([r["sessionId"] for r in got["results"]], [OTHER])
        self.assertIn(str(self.inst / "projects"), got["roots"])
        # and a bare id whose only trace is that instance-side marker still resolves + deletes
        code, out, _ = run_cli(delete_chat.main, [OTHER, "--json"])
        self.assertEqual(code, 0, out)
        self.assertFalse(inst_marker.exists())

    def test_released_sweep_with_yes_still_respects_a_hold(self):
        marker = self.transcript.with_name(f"{SID}.desktop-released.json")
        marker.write_text(json.dumps({"reason": "delete"}), encoding="utf-8")
        self.meta.unlink()
        holdlib.hold(SID, "mine", by="owner")
        code, out, _ = run_cli(delete_chat.main, ["--released", "--yes", "--json"])
        self.assertEqual(code, 4)
        got = json.loads(out)
        self.assertFalse(got["results"][0]["deleted"])
        self.assertIn("HELD", got["results"][0]["why"])
        self.assertTrue(self.transcript.exists() and marker.exists())

    def test_undo_records_an_undelete_mutation_so_the_generic_undo_can_confirm_it(self):
        run_cli(delete_chat.main, [SID, "--json"])
        run_cli(delete_chat.main, ["--undo", SID, "--json"])
        kinds = sorted(m["kind"] for m in mutationlib.list_mutations(SID))
        self.assertEqual(kinds, ["delete", "undelete"])
        self.assertEqual(mutationlib.INVERSE_KIND["delete"], "undelete")
        self.assertEqual(mutationlib.INVERSE_KIND["undelete"], "delete")

    # --- audit AH-28: delete and undo of ONE chat never interleave ------------------------------
    #
    # Reproduced 2026-09-05 with the production copy_to_trash / undo / unlink functions: delete
    # paused right after its trash copy, undo restored the manifest, delete resumed and unlinked
    # the just-restored transcript. deleteOk true, undoOk true, transcript gone. The per-chat
    # lock makes whichever arrives second DEFER instead.

    def test_an_undo_arriving_mid_delete_is_deferred_and_the_delete_still_completes(self):
        real_copy = delete_chat.copy_to_trash
        mid = {}

        def copy_then_undo(*a, **kw):
            manifest = real_copy(*a, **kw)
            # The operator's undo, landing exactly where the audit paused the delete: after the
            # trash copy exists and before a single source file has been unlinked.
            mid["undo"] = delete_chat.undo(SID)
            mid["transcript_still_there"] = self.transcript.exists()
            return manifest

        with mock.patch.object(delete_chat, "copy_to_trash", side_effect=copy_then_undo):
            res = delete_chat.delete(SID)
        self.assertTrue(res["ok"], res)
        self.assertFalse(mid["undo"]["ok"])
        self.assertEqual(mid["undo"]["code"], 3)
        self.assertTrue(mid["undo"].get("deferred"))
        self.assertIn("still running", mid["undo"]["why"])
        self.assertTrue(mid["transcript_still_there"])  # the deferred undo copied nothing
        self.assertFalse(self.transcript.exists())
        self.assertFalse(self.meta.exists())
        # Once the delete has released the lock, a standalone undo restores every file.
        later = delete_chat.undo(SID)
        self.assertTrue(later["ok"], later)
        self.assertTrue(self.transcript.exists())
        self.assertTrue(self.meta.exists())
        # No lock file is left behind by either side.
        self.assertFalse(list((self.root / "state").glob(".lock-delete-*")))

    def test_a_second_delete_of_the_same_chat_is_deferred_while_the_first_runs(self):
        with ledgerlib.try_locked(f"delete-{SID}", stale_secs=900) as ours:
            self.assertTrue(ours)
            res = delete_chat.delete(SID)
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], 3)
        self.assertTrue(res.get("deferred"))
        # Nothing moved: no trash copy, no manifest, both source files intact.
        self.assertTrue(self.meta.exists())
        self.assertTrue(self.transcript.exists())
        self.assertFalse(delete_chat.trash_dir(SID).exists())
        # And the CLI reports it as a refusal (exit 3), the same class as a hold.
        with ledgerlib.try_locked(f"delete-{SID}", stale_secs=900):
            code, out, _ = run_cli(delete_chat.main, [SID, "--json"])
        self.assertEqual(code, 3)
        self.assertTrue(json.loads(out).get("deferred"))

    def test_bad_usage_is_exit_3(self):
        for argv in ([], ["--undo"], [SID, OTHER]):
            code, _, _ = run_cli(delete_chat.main, argv)
            self.assertEqual(code, 3, argv)
        self.assertTrue(self.meta.exists())
        code, out, _ = run_cli(delete_chat.main, ["--undo", OTHER, "--json"])
        self.assertEqual(code, 3)
        self.assertIn("no undo copy", json.loads(out)["why"])


if __name__ == "__main__":
    unittest.main()
