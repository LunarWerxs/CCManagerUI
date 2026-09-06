"""trust_workspace.py + spawn_chat.py: the trusted-folder wall, and turning a chip's payload
(folder + prompt) into a real chat through the app's own deeplink."""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402
from util import run_cli  # noqa: E402

from lib import hydralib  # noqa: E402
import spawn_chat  # noqa: E402
import trust_workspace  # noqa: E402


class TrustTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self._tmp.name) / ".claude.json"
        self.cfg.write_text(json.dumps({"projects": {
            "D:/Repos/Trusted": {"hasTrustDialogAccepted": True, "mcpServers": {}},
            "D:/Repos/Cold": {"hasTrustDialogAccepted": False, "lastCost": 1.5},
        }}), encoding="utf-8")
        self._old = trust_workspace.CONFIG
        trust_workspace.CONFIG = self.cfg
        # apply_trust(act=True) now serializes on ledgerlib's cross-process lock, which lives
        # under ORCHESTRATOR_STATE_DIR - isolate it so the test never touches this machine's
        # real orchestrator state.
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        trust_workspace.CONFIG = self._old
        self._tmp.cleanup()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_trusting_an_existing_project_keeps_its_other_settings(self):
        res = trust_workspace.apply_trust(["D:/Repos/Cold"], act=True)
        self.assertEqual(res["trusted"], ["D:/Repos/Cold"])
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        entry = cfg["projects"]["D:/Repos/Cold"]
        self.assertTrue(entry["hasTrustDialogAccepted"])
        self.assertEqual(entry["lastCost"], 1.5)  # never clobbers the app's own state

    def test_a_path_variant_matches_the_existing_key_and_makes_no_duplicate(self):
        # the daemon reports cwds in whatever slash style/casing each session recorded
        trust_workspace.apply_trust(["d:\\repos\\cold"], act=True)
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        self.assertEqual(len(cfg["projects"]), 2)  # no third key
        self.assertTrue(cfg["projects"]["D:/Repos/Cold"]["hasTrustDialogAccepted"])

    def test_a_new_key_is_written_in_the_apps_forward_slash_form(self):
        # Measured live 2026-09-01: the app looks projects up by a FORWARD-slash key, so a
        # backslash key is invisible to it - the flag says trusted and the dialog still
        # appears. This is the bug that made the first trust write do nothing.
        trust_workspace.apply_trust(["D:\\Repos\\Fresh"], act=True)
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        self.assertIn("D:/Repos/Fresh", cfg["projects"])
        self.assertNotIn("D:\\Repos\\Fresh", cfg["projects"])

    def test_one_folder_twice_in_one_call_writes_one_entry(self):
        res = trust_workspace.apply_trust(["D:/New/Repo", "D:\\New\\Repo"], act=True)
        self.assertEqual(len(res["trusted"]), 1)
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        self.assertEqual(len([k for k in cfg["projects"] if "New" in k]), 1)

    def test_already_trusted_is_a_no_op_and_dry_run_writes_nothing(self):
        res = trust_workspace.apply_trust(["D:/Repos/Trusted"], act=True)
        self.assertEqual(res["trusted"], [])
        before = self.cfg.read_text(encoding="utf-8")
        trust_workspace.apply_trust(["D:/Repos/Cold"], act=False)  # dry run
        self.assertEqual(self.cfg.read_text(encoding="utf-8"), before)

    def test_a_backup_is_written_before_any_change(self):
        trust_workspace.apply_trust(["D:/Repos/Cold"], act=True)
        self.assertTrue(self.cfg.with_name(f"{self.cfg.name}.bak-trust").exists())

    def test_config_survives_a_crash_between_the_backup_and_the_rename(self):
        # save() must COPY the backup (leaving the original in place) and do exactly one
        # os.replace() into CONFIG - never rename CONFIG away first. A crash inside
        # os.replace() (mocked to raise) must never leave ~/.claude.json missing: it is
        # shared by every instance on the machine.
        before = self.cfg.read_text(encoding="utf-8")
        with mock.patch.object(trust_workspace.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                trust_workspace.apply_trust(["D:/Repos/Cold"], act=True)
        self.assertTrue(self.cfg.exists(), "CONFIG must never be missing, even mid-crash")
        self.assertEqual(self.cfg.read_text(encoding="utf-8"), before)


class SpawnChatTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self._tmp.name) / "work"
        self.folder.mkdir()
        # spawn() notes a 'spawned' row in the attempt ledger: without this the tests wrote
        # 'new-sid-sent' / 'new-sid-fallback' rows into the REAL state/attempts.json (found
        # in the live ledger, 2026-09-01 - 9 rows each).
        os.environ["ORCHESTRATOR_STATE_DIR"] = str(Path(self._tmp.name) / "state")
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        # the auto-start wait must not slow the suite: no new session registers here,
        # so shrink the window (the 'not-confirmed' path is what these tests exercise)
        self._start_wait = spawn_chat.START_WAIT_SECS
        spawn_chat.START_WAIT_SECS = 0
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "open1", "dir": "c:\\i\\open1", "isRunning": True, "signedIn": True},
            {"num": 2, "name": "shut", "dir": "c:\\i\\shut", "isRunning": False, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        # spawn() runs the duplicate-task double-check (hydralib.same_task_chats) before
        # anything else when force is not set - it needs a visible_chats() scan to succeed.
        self.stub.routes["/api/sessions"] = []

    def tearDown(self):
        spawn_chat.START_WAIT_SECS = self._start_wait
        self.stub.close()
        self._tmp.cleanup()

    def test_spawn_sends_the_apps_own_new_chat_deeplink_with_folder_and_prompt(self):
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen") as popen, \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="", stderr="")), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}) as trust:
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1")
        self.assertTrue(res["ok"], res)
        args = popen.call_args[0][0]
        self.assertEqual(args[0], "claude.exe")
        self.assertIn("--user-data-dir=c:\\i\\open1", args)
        url = args[-1]
        self.assertTrue(url.startswith("claude://code/new?"))
        self.assertIn("prompt=do%20the%20thing", url)
        self.assertIn("folder=", url)
        trust.assert_called_once()  # trust ALWAYS precedes the spawn

    def test_a_closed_instance_is_refused_not_guessed(self):
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen") as popen:
            res = spawn_chat.spawn(str(self.folder), "x", "shut")
        self.assertFalse(res["ok"])
        self.assertIn("not open", res["why"])
        popen.assert_not_called()

    def test_the_trust_modal_is_answered_for_our_folder_only(self):
        # The file write is the CLI's list; the DESKTOP app asks anyway (measured live
        # 2026-09-01), so the spawn answers the modal through the app's own control - and
        # exit 4 (a dialog naming a DIFFERENT folder) is a refusal, never a blind click.
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch.object(spawn_chat, "TRUST_ACTUATOR", Path(__file__)), \
             mock.patch.object(spawn_chat, "SUBMIT_ACTUATOR", Path("nope-not-here")), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="", stderr="")) as run:
            res = spawn_chat.spawn(str(self.folder), "x", "open1")
        self.assertEqual(res["trustDialog"], "answered")
        # the submit step also shells out, so look across ALL calls for the trust one
        self.assertTrue(any("-Folder" in c[0][0] for c in run.call_args_list))
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch.object(spawn_chat, "TRUST_ACTUATOR", Path(__file__)), \
             mock.patch.object(spawn_chat, "SUBMIT_ACTUATOR", Path("nope-not-here")), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=4, stdout="", stderr="")):
            res2 = spawn_chat.spawn(str(self.folder), "x", "open1")
        self.assertEqual(res2["trustDialog"], "refused-other-folder")

    def test_a_missing_folder_is_refused_before_anything_runs(self):
        with mock.patch.object(spawn_chat.subprocess, "Popen") as popen:
            code, _, err = run_cli(spawn_chat.main,
                                   ["--folder", str(self.folder / "nope"), "--prompt", "x"])
        self.assertEqual(code, 3)
        popen.assert_not_called()

    def _live_route(self, sid):
        resolved_cwd = str(self.folder.resolve())
        calls = {"n": 0}

        def route(method, path, query, body):
            calls["n"] += 1
            # Calls 1-2 are the duplicate-task double-check's own live lookup
            # (hydralib.same_task_chats) and spawn()'s before_ids snapshot - neither should
            # see the new session yet; only the registration-poll loop that follows should.
            if calls["n"] <= 2:
                return {"count": 0, "sessions": []}
            return {"count": 1, "sessions": [{"sessionId": sid, "cwd": resolved_cwd, "pid": 111}]}

        return route

    def test_a_confirmed_composer_submit_never_double_starts_via_the_message_fallback(self):
        # The composer already pressed Send - registering IS the proof the turn started.
        # POSTing the prompt again through the fallback would run the whole task twice.
        self.stub.routes["/api/sessions/live"] = self._live_route("new-sid-sent")
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch.object(spawn_chat, "TRUST_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "SUBMIT_ACTUATOR", Path(__file__)), \
             mock.patch.object(spawn_chat, "START_WAIT_SECS", 6), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(hydralib, "dossier", return_value=[{"title": "New chat"}]), \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1")
        self.assertEqual(res["submitted"], "sent")
        self.assertTrue(res["started"].startswith("running"), res["started"])
        self.assertEqual(self.stub.posts, [])  # no fallback POST to /message

    def test_an_unconfirmed_composer_still_gets_the_message_fallback(self):
        self.stub.routes["/api/sessions/live"] = self._live_route("new-sid-fallback")
        self.stub.routes["/api/sessions/new-sid-fallback/message"] = {"ok": True, "delivered": True}
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch.object(spawn_chat, "TRUST_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "SUBMIT_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "START_WAIT_SECS", 6), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(hydralib, "dossier", return_value=[{"title": "New chat"}]), \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1")
        self.assertNotEqual(res["submitted"], "sent")
        posts = [p for p, _ in self.stub.posts if p.endswith("/message")]
        self.assertEqual(len(posts), 1)
        self.assertTrue(res["started"].startswith("running"), res["started"])

    def test_main_returns_4_when_the_first_turn_is_not_confirmed_running(self):
        with mock.patch.object(spawn_chat, "spawn", return_value={
                "ok": True, "instance": "open1", "folder": str(self.folder), "trusted": [],
                "trustDialog": "not-seen", "sessionId": None, "submitted": "not-attempted",
                "started": "not-confirmed", "window": "unchanged", "url": "x"}):
            code, out, err = run_cli(spawn_chat.main,
                                     ["--folder", str(self.folder), "--prompt", "x"])
        self.assertEqual(code, 4)

    def test_a_registered_spawn_sets_the_mode_live_and_records_a_spawned_ledger_row(self):
        # Item 2a: once a session registers, spawn() drives the app's own permission picker
        # (_set_mode_live) and leaves a ledger row so unblock_prompts can trust the promise.
        sid = "new-sid-mode"
        self.stub.routes["/api/sessions/live"] = self._live_route(sid)
        self.stub.routes[f"/api/sessions/{sid}/message"] = {"ok": True, "delivered": True}
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch.object(spawn_chat, "TRUST_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "SUBMIT_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "START_WAIT_SECS", 6), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(hydralib, "dossier", return_value=[{"title": "New chat"}]), \
             mock.patch.dict(os.environ, {"ORCHESTRATOR_STATE_DIR": state.name}), \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(
                                   returncode=0,
                                   stdout="permission mode set: 'Default permissions' -> "
                                          "'Bypass permissions'\n",
                                   stderr="")) as run_mock:
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1")
        self.assertEqual(res["modeSet"],
                         "permission mode set: 'Default permissions' -> 'Bypass permissions'")
        self.assertTrue(any("-SetMode" in c.args[0] for c in run_mock.call_args_list))
        # Read the ledger file directly, by path, rather than through ledgerlib._load(): the
        # ORCHESTRATOR_STATE_DIR override above is already unwound by this point (the `with`
        # exited), so a call through ledgerlib here would silently read the wrong (real) state
        # dir instead of the temp one spawn() actually wrote to.
        ledger = json.loads((Path(state.name) / "attempts.json").read_text(encoding="utf-8"))
        rows = [r for r in ledger.get("attempts", [])
                if r.get("kind") == "spawned" and r.get("session") == sid]
        self.assertEqual(len(rows), 1)

    def test_no_title_yet_reports_and_never_sets_the_mode(self):
        # Item 2b: the app has not auto-titled the new chat yet - _set_mode_live must say so
        # and never touch the picker, rather than guess or block for real wall-clock time
        # (a fake clock stands in for time.time() so the 30s deadline resolves instantly).
        sid = "new-sid-no-title"
        self.stub.routes["/api/sessions/live"] = self._live_route(sid)
        self.stub.routes[f"/api/sessions/{sid}/message"] = {"ok": True, "delivered": True}
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)

        class _FakeClock:
            def __init__(self):
                self.t = 0.0

            def time(self):
                self.t += 1.0
                return self.t

        clock = _FakeClock()
        with mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch.object(spawn_chat, "TRUST_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "SUBMIT_ACTUATOR", Path("nope-not-here")), \
             mock.patch.object(spawn_chat, "START_WAIT_SECS", 6), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(hydralib, "dossier", return_value=[]), \
             mock.patch.object(spawn_chat.time, "time", side_effect=clock.time), \
             mock.patch.object(spawn_chat.time, "sleep"), \
             mock.patch.dict(os.environ, {"ORCHESTRATOR_STATE_DIR": state.name}), \
             mock.patch.object(spawn_chat.clilib, "run_text") as run_mock:
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1")
        self.assertIn("no title yet", res["modeSet"])
        self.assertFalse(any("-SetMode" in c.args[0] for c in run_mock.call_args_list))

    def test_main_returns_0_when_the_first_turn_is_confirmed_running(self):
        with mock.patch.object(spawn_chat, "spawn", return_value={
                "ok": True, "instance": "open1", "folder": str(self.folder), "trusted": [],
                "trustDialog": "not-seen", "sessionId": "s1", "submitted": "sent",
                "started": "running (composer submitted; engine registered)",
                "window": "unchanged", "url": "x"}):
            code, out, err = run_cli(spawn_chat.main,
                                     ["--folder", str(self.folder), "--prompt", "x"])
        self.assertEqual(code, 0)


class SpawnDuplicateTaskTest(unittest.TestCase):
    """spawn() refuses BEFORE touching anything when a visible chat already carries this
    exact task (owner, 2026-09-01: two identical 'SageThumbs codebase review' chats, 30
    minutes apart, both running - "it can't do it blind; it must always double check,
    confirm"). --force is a person's word that overrides the refusal."""

    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self._tmp.name) / "work"
        self.folder.mkdir()
        os.environ["ORCHESTRATOR_STATE_DIR"] = str(Path(self._tmp.name) / "state")
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self._start_wait = spawn_chat.START_WAIT_SECS
        spawn_chat.START_WAIT_SECS = 0
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "open1", "dir": "c:\\i\\open1", "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}

    def tearDown(self):
        spawn_chat.START_WAIT_SECS = self._start_wait
        self.stub.close()
        self._tmp.cleanup()

    def test_a_duplicate_task_is_refused_before_touching_anything(self):
        dup = [{"session_id": "s1", "title": "T", "instance": "open1", "live": True,
                "firstPrompt": "do the thing"}]
        with mock.patch.object(hydralib, "same_task_chats", return_value=dup) as same, \
             mock.patch.object(spawn_chat.subprocess, "Popen") as popen, \
             mock.patch("trust_workspace.apply_trust") as trust:
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1")
        self.assertFalse(res["ok"])
        self.assertEqual(res["duplicateOf"], dup)
        self.assertIn("already exists", res["why"])
        same.assert_called_once_with("do the thing")
        popen.assert_not_called()
        trust.assert_not_called()

    def test_force_bypasses_the_duplicate_check(self):
        with mock.patch.object(hydralib, "same_task_chats") as same, \
             mock.patch.object(spawn_chat, "_binary", return_value="claude.exe"), \
             mock.patch.object(spawn_chat.subprocess, "Popen"), \
             mock.patch("trust_workspace.apply_trust", return_value={"trusted": []}), \
             mock.patch.object(spawn_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            res = spawn_chat.spawn(str(self.folder), "do the thing", "open1", force=True)
        same.assert_not_called()
        self.assertTrue(res["ok"], res)

    def test_main_returns_5_on_a_refused_duplicate(self):
        with mock.patch.object(spawn_chat, "spawn", return_value={
                "ok": False, "duplicateOf": [{"title": "T"}],
                "why": "a chat for this exact task already exists: 'T' in open1 (running)"}):
            code, out, err = run_cli(spawn_chat.main,
                                     ["--folder", str(self.folder), "--prompt", "x"])
        self.assertEqual(code, 5)


class WindowPlacementTest(unittest.TestCase):
    """Putting a window back the way the owner had it (owner, 2026-09-01: "often I'm noticing
    you end up full screening the desktop instance"). The measurement said neither deeplink
    route moves a window, so the guard's most important property is that it is SILENT and
    harmless on the normal path - and that it can never break the delivery it wraps."""

    def test_a_placement_that_did_not_move_produces_no_note_and_no_restore(self):
        from lib import windowlib

        with mock.patch.object(windowlib, "_run", side_effect=[
                (0, '{"showCmd":1,"left":1,"top":2,"right":3,"bottom":4}'),
                (0, "unchanged (showCmd 1) - left alone")]):
            seen = []
            with windowlib.keep_placement("c:\\i\\one", note=seen.append):
                pass
        self.assertEqual(seen, [])  # the quiet path stays quiet

    def test_a_window_that_moved_is_restored_AND_leaves_evidence(self):
        from lib import windowlib

        with mock.patch.object(windowlib, "_run", side_effect=[
                (0, '{"showCmd":1,"left":1,"top":2,"right":3,"bottom":4}'),
                (0, "restored showCmd 1 for 'c:\\i\\one'")]):
            seen = []
            with windowlib.keep_placement("c:\\i\\one", note=seen.append):
                pass
        self.assertEqual(len(seen), 1)
        self.assertIn("restored", seen[0])

    def test_a_courtesy_never_breaks_the_work_it_wraps(self):
        from lib import windowlib

        with mock.patch.object(windowlib, "_run", side_effect=RuntimeError("powershell gone")):
            ran = []
            with windowlib.keep_placement("c:\\i\\one"):
                ran.append(True)
        self.assertEqual(ran, [True])

    def test_no_instance_means_nothing_to_keep(self):
        from lib import windowlib

        with mock.patch.object(windowlib, "_run") as run:
            self.assertIsNone(windowlib.capture(None))
            self.assertIsNone(windowlib.restore("c:\\i\\one", None))
        run.assert_not_called()


class PaneWordsTest(unittest.TestCase):
    """The aim rail matches what the PANE shows: a slash command renders as its arguments."""

    def test_a_slash_command_prompt_verifies_on_its_arguments(self):
        self.assertEqual(
            spawn_chat.pane_words("/orchestrate standing manager chat, run the loop"),
            "standing manager chat, run the loop")

    def test_a_plain_prompt_is_unchanged(self):
        self.assertEqual(spawn_chat.pane_words("  Review the codebase and report  "),
                         "Review the codebase and report")

    def test_a_bare_slash_command_stays_as_is(self):
        self.assertEqual(spawn_chat.pane_words("/compact"), "/compact")


if __name__ == "__main__":
    unittest.main()
