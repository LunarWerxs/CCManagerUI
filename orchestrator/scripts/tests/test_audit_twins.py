"""audit_twins.py: two different kinds of duplicate chat, and the report/--fix contract.

find_twins() catches a chat visible in two DESKTOP RECORDS at once (a re-import artefact);
find_same_task() catches the SAME TASK started in two separate real chats (owner, 2026-09-01:
two identical review chats, 30 minutes apart, both running). Neither ever deletes anything -
find_twins's stale copy is archived (reversible), find_same_task's later chat is only HELD.
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

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

import audit_twins  # noqa: E402
from lib import armlib  # noqa: E402

# Captured BEFORE any test patches it: LiveCopyGuardTest replaces audit_twins._archive_copy in
# setUp, and the one test there that needs the real function swaps this back in under a nested
# patch - never by stopping the class-level patch (stop + re-start in a cleanup left the mock
# armed for every module loaded after this one in a single-process run; found 2026-09-05 when
# test_bands_and_groundskeeper's twin tests saw "archived" instead of the real outcome).
_REAL_ARCHIVE_COPY = audit_twins._archive_copy
from lib import hydralib  # noqa: E402

from util import run_cli  # noqa: E402

# A real task signature: long enough (>= 60 chars) to clear find_same_task's own 40-char floor
# after normalization, and nowhere near any boilerplate prefix.
TASK_A = ("Please refactor the payment retry logic so failed charges are retried with backoff "
          "and logged clearly for support to review later")
# The launcher prepends the working folder before the prompt it fires (measured 2026-09-01):
# same task, same chat in spirit, a different literal string.
TASK_B_PREFIXED = "D:\\x\\app " + TASK_A
TASK_C_DIFFERENT = ("Investigate why the nightly export job silently drops rows over ten "
                     "thousand and fix the pagination bug end to end")
# The toolbox's own sweep opener - identical text sent to many chats on purpose, never a
# duplicate of itself (is_boilerplate_task must catch it before same_task ever compares text).
SWEEP_OPENER = ("ultracode\n\n/orchestrate The standing sweep opened this session because there "
                "is queued work waiting for you to pick up and finish carefully")


class FindSameTaskTest(unittest.TestCase):
    """find_same_task / fix_same_task / main()'s text report over that lane."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)  # so --fix (and fix_same_task) act instead of refusing
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot", "dir": str(self.root / "hot"),
             "isRunning": True, "signedIn": True},
            {"num": 2, "name": "cool", "dir": str(self.root / "cool"),
             "isRunning": True, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.stub.routes["/api/sessions"] = []
        self.stub.routes["/api/chats/dossier"] = {"matches": []}
        # store_roots() also globs a "default" AppData store off Path.home() - keep the test
        # off this machine's real desktop chats entirely.
        self._home = mock.patch("pathlib.Path.home", return_value=self.root / "nohome")
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _row(self, sid, instance, text, created_at, title="Chat"):
        tp = self.root / f"{sid}.jsonl"
        tp.write_text(json.dumps({"type": "user", "message": {"content": text}}) + "\n",
                      encoding="utf-8")
        return {"session_id": sid, "title": title, "instance": instance, "archived": False,
                "transcript_path": str(tp), "createdAt": created_at}

    def test_find_same_task_groups_the_prefixed_duplicate_only(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-a", "hot", TASK_A, 1_000_000, "Task A"),
            self._row("s-b", "cool", TASK_B_PREFIXED, 1_001_800, "Task B (dup, 30min later)"),
            self._row("s-c", "cool", TASK_C_DIFFERENT, 1_002_000, "A different task"),
            self._row("s-d", "hot", SWEEP_OPENER, 1_003_000, "Sweep opener 1"),
            self._row("s-e", "cool", SWEEP_OPENER, 1_003_100, "Sweep opener 2"),
        ]
        groups = audit_twins.find_same_task()
        self.assertEqual(len(groups), 1)
        g = groups[0]
        self.assertEqual(g["keep"]["sessionId"], "s-a")  # the earlier createdAt
        self.assertEqual([c["sessionId"] for c in g["later"]], ["s-b"])
        grouped = {c["sessionId"] for grp in groups for c in grp["chats"]}
        self.assertNotIn("s-c", grouped)  # genuinely different task
        self.assertNotIn("s-d", grouped)  # boilerplate sweep opener
        self.assertNotIn("s-e", grouped)  # ditto, even though identical to s-d

    def test_standing_manager_chats_are_never_a_same_task_group(self):
        # They share one birth prompt by design; grouping them would HOLD every later one -
        # i.e. the live overlord. overlord.py names the spares instead (2026-09-04).
        import overlord

        recorded = ("<command-message>orchestrate</command-message>\n<command-name>/orchestrate"
            "</command-name>\n<command-args>"
            + overlord.MANAGER_PROMPT.split(" ", 1)[1] + "</command-args>")
        self.stub.routes["/api/sessions"] = [
            self._row("m-1", "hot", recorded, 1_000_000, "Standing manager chat orchestration"),
            self._row("m-2", "cool", recorded, 1_001_000, "Manager chat cool (retired)"),
        ]
        self.assertEqual(audit_twins.find_same_task(), [])

    def test_fix_same_task_holds_the_later_chat_and_never_archives(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-a", "hot", TASK_A, 1_000_000, "Task A"),
            self._row("s-b", "cool", TASK_B_PREFIXED, 1_001_800, "Task B (dup)"),
        ]
        meta_dir = self.root / "cool" / "claude-code-sessions" / "p" / "c"
        meta_dir.mkdir(parents=True, exist_ok=True)
        meta_path = meta_dir / "local_s-b.json"
        meta_path.write_text(json.dumps(
            {"cliSessionId": "s-b", "isArchived": False, "title": "Task B (dup)"}),
            encoding="utf-8")

        from lib import holdlib

        done = audit_twins.fix_same_task(audit_twins.find_same_task())
        self.assertEqual(len(done), 1)
        self.assertIn("HELD as a duplicate", done[0]["outcome"])
        self.assertIn("DUPLICATE TASK", holdlib.why_blocked("s-b"))
        self.assertFalse(json.loads(meta_path.read_text(encoding="utf-8"))["isArchived"])

        # a second pass over the same groups must not re-hold - it recognizes the hold already
        # in place and says so, rather than acting again.
        done2 = audit_twins.fix_same_task(audit_twins.find_same_task())
        self.assertEqual(len(done2), 1)
        self.assertEqual(done2[0]["outcome"], "already held")
        self.assertFalse(json.loads(meta_path.read_text(encoding="utf-8"))["isArchived"])

    def test_main_dry_run_reports_and_fix_holds_and_says_HELD(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-a", "hot", TASK_A, 1_000_000, "Task A"),
            self._row("s-b", "cool", TASK_B_PREFIXED, 1_001_800, "Task B (dup)"),
        ]
        code, out, _ = run_cli(audit_twins.main, [])
        self.assertEqual(code, 2)
        self.assertIn("task(s) started MORE THAN ONCE", out)
        self.assertIn("KEEP", out)
        self.assertIn("DUP", out)

        code2, out2, _ = run_cli(audit_twins.main, ["--fix"])
        self.assertEqual(code2, 0)
        self.assertIn("HELD as a duplicate", out2)

    def test_main_with_nothing_duplicated_prints_that_and_exits_0(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-only", "hot", TASK_A, 1_000_000, "Solo task"),
        ]
        code, out, _ = run_cli(audit_twins.main, [])
        self.assertEqual(code, 0)
        self.assertIn("nothing duplicated", out)


class FindTwinsLineageTest(unittest.TestCase):
    """find_twins(): two desktop records with DIFFERENT cli ids but one lineage are one twin."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.home_inst = "home_inst"
        self.other_inst = "other_inst"
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": self.home_inst, "dir": str(self.root / "home"),
             "isRunning": True, "signedIn": True},
            {"num": 2, "name": self.other_inst, "dir": str(self.root / "other"),
             "isRunning": True, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self._home = mock.patch("pathlib.Path.home", return_value=self.root / "nohome")
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _meta(self, instance_dir_name, cli_id, created_at=1_000_000, title="Twin chat"):
        d = self.root / instance_dir_name / "claude-code-sessions" / "p" / "c"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"local_{cli_id}.json").write_text(json.dumps(
            {"cliSessionId": cli_id, "isArchived": False, "title": title,
             "createdAt": created_at}), encoding="utf-8")

    def test_lineage_merge_makes_one_twin_group_and_keeps_the_home_copy(self):
        a_id, b_id = "cli-aaaa", "cli-bbbb"
        self._meta("home", a_id, created_at=1_000_000)
        self._meta("other", b_id, created_at=1_005_000)
        # the daemon says A's cli id now belongs to the home instance.
        self.stub.routes["/api/sessions"] = [
            {"session_id": a_id, "instance": self.home_inst, "archived": False}]

        def dossier_route(method, path, query, body):
            q = dossier_query(query)
            if q == a_id:
                return {"matches": [{"cliSessionId": a_id, "lineageIds": [a_id, b_id]}]}
            if q == b_id:
                return {"matches": [{"cliSessionId": b_id, "lineageIds": [b_id]}]}
            return {"matches": []}

        self.stub.routes["/api/chats/dossier"] = dossier_route

        twins = audit_twins.find_twins()
        self.assertEqual(len(twins), 1)
        t = twins[0]
        self.assertEqual(len(t["copies"]), 2)
        self.assertIsNotNone(t["keep"])
        self.assertEqual(t["keep"]["instance"], self.home_inst)
        self.assertEqual(t["keep"]["stem"], f"local_{a_id}")
        self.assertEqual(len(t["stale"]), 1)
        self.assertEqual(t["stale"][0]["instance"], self.other_inst)


class LiveCopyGuardTest(unittest.TestCase):
    """WHICH COPY holds the live engine - the guard that used to answer per CONVERSATION.

    THE BUG (live, 2026-09-04): nine chats were migrated between accounts. Landing a chat boots
    a fresh engine in the TARGET app straight away (enginelib's own note), so every one of them
    read as "live", the conversation-scoped guard refused every SOURCE copy, and the move left
    nine permanent twins - the exact state this script exists to clear, produced by the script
    that clears it. The engine's process ancestry answers the real question: whose app is it a
    child of.
    """

    CLI = "cli-moved"
    ENGINE_PID = 4242
    HOST_PID = 37360

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.target_dir = str(self.root / "target")
        self.source_dir = str(self.root / "source")
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "target", "dir": self.target_dir,
             "isRunning": True, "signedIn": True},
            {"num": 2, "name": "source", "dir": self.source_dir,
             "isRunning": True, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [
            {"sessionId": self.CLI, "pid": self.ENGINE_PID}]}
        self.stub.routes["/api/sessions"] = []
        self._home = mock.patch("pathlib.Path.home", return_value=self.root / "nohome")
        self._home.start()
        self.archived = []
        self._arch = mock.patch.object(
            audit_twins, "_archive_copy",
            side_effect=lambda instance, path, title, **kw: self.archived.append(instance) or "archived")
        self._arch.start()

    def tearDown(self):
        self._arch.stop()
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _twin(self):
        return {"cliSessionId": self.CLI, "title": "Moved chat", "live": True, "why": "",
                "keep": {"instance": "target", "path": self.target_dir + "/a.json",
                         "stem": "local_" + self.CLI},
                "stale": [{"instance": "source", "path": self.source_dir + "/a.json",
                           "stem": "local_" + self.CLI}]}

    def _tree_hosted_by(self, user_data_dir):
        """An engine whose parent is the Electron host started with that --user-data-dir."""
        return {self.ENGINE_PID: (self.HOST_PID, "claude.exe --type=renderer"),
                self.HOST_PID: (0, "claude.exe --user-data-dir=" + user_data_dir)}

    def test_engine_under_the_KEEPER_frees_the_stale_copy(self):
        with mock.patch.object(audit_twins, "_claude_process_tree",
                               return_value=self._tree_hosted_by(self.target_dir)):
            done = audit_twins.fix([self._twin()])
        self.assertEqual(self.archived, ["source"])
        self.assertEqual(done[0]["outcome"], "archived")

    def test_engine_under_the_STALE_copy_is_never_touched(self):
        with mock.patch.object(audit_twins, "_claude_process_tree",
                               return_value=self._tree_hosted_by(self.source_dir)):
            done = audit_twins.fix([self._twin()])
        self.assertEqual(self.archived, [])
        self.assertIn("its engine runs under source", done[0]["outcome"])

    def test_an_untraceable_engine_stays_refused(self):
        with mock.patch.object(audit_twins, "_claude_process_tree", return_value={}):
            done = audit_twins.fix([self._twin()])
        self.assertEqual(self.archived, [])
        self.assertIn("could not be traced", done[0]["outcome"])

    def test_a_dead_conversation_is_archived_without_asking_about_engines(self):
        twin = {**self._twin(), "live": False}
        with mock.patch.object(audit_twins, "_claude_process_tree", return_value={}):
            done = audit_twins.fix([twin])
        self.assertEqual(self.archived, ["source"])
        self.assertEqual(done[0]["outcome"], "archived")

    # --- audit AH-32: the liveness decision must not be older than the act ----------------

    def test_a_live_registry_that_cannot_be_read_refuses_every_copy(self):
        twin = {**self._twin(), "live": True, "liveUnknown": True}
        with mock.patch.object(audit_twins, "_claude_process_tree", return_value={}):
            done = audit_twins.fix([twin])
        self.assertEqual(self.archived, [])
        self.assertIn("liveness unknown", done[0]["outcome"])

    def test_find_twins_marks_liveness_unknown_when_the_daemon_cannot_say(self):
        self.stub.routes["/api/sessions/live"] = lambda m, p, q, b: (503, {"error": "not now"})
        twin = audit_twins._build_twin("x", [{"title": "t", "path": "a", "stem": "s", "instance": "i"},
                                             {"title": "t", "path": "b", "stem": "s2", "instance": "j"}],
                                       None, audit_twins._live_session_ids())
        self.assertTrue(twin["liveUnknown"])
        self.assertTrue(twin["live"])

    def test_an_archive_already_in_progress_for_the_chat_defers_the_twin_fix(self):
        from lib import ledgerlib

        twin = {**self._twin(), "live": False}
        with ledgerlib.try_locked(f"archive-{self.CLI}", stale_secs=300) as ours:
            self.assertTrue(ours)
            done = audit_twins.fix([twin])
        self.assertEqual(self.archived, [])
        self.assertTrue(done[0]["outcome"].startswith("DEFERRED"))
        self.assertIn("archive lock", done[0]["outcome"])
        # The lock is released again once fix() is done with the copy (no leftover .lock).
        done_after = audit_twins.fix([twin])
        self.assertEqual(self.archived, ["source"])
        self.assertEqual(done_after[0]["outcome"], "archived")

    def test_a_copy_that_goes_live_between_plan_and_act_is_deferred_untouched(self):
        # The plan saw a DEAD conversation. By the time the window mutex is ours, an engine is
        # running under the STALE copy's own app. The actuator must not fire and no flag may
        # be written; the outcome says so.
        twin = {**self._twin(), "live": False}
        stale_meta = Path(self.source_dir) / "a.json"
        stale_meta.parent.mkdir(parents=True, exist_ok=True)
        stale_meta.write_text(json.dumps({"cliSessionId": self.CLI, "title": "Moved chat",
                                          "isArchived": False}), encoding="utf-8")
        import contextlib

        @contextlib.contextmanager
        def window_is_ours(_inst_dir, wait_secs=60):
            yield True

        actuator_runs = []
        # The real _archive_copy / _drive_archive this once, under a NESTED patch so the
        # class-level mock comes back on exit (see _REAL_ARCHIVE_COPY above).
        with mock.patch.object(audit_twins, "_archive_copy", _REAL_ARCHIVE_COPY), \
             mock.patch("lib.windowlib.instance_lock", side_effect=window_is_ours), \
             mock.patch.object(audit_twins, "_claude_process_tree",
                               return_value=self._tree_hosted_by(self.source_dir)), \
             mock.patch.object(audit_twins.clilib, "run_text",
                               side_effect=lambda *a, **k: actuator_runs.append(a)):
            done = audit_twins.fix([twin])
        self.assertEqual(actuator_runs, [])
        self.assertTrue(done[0]["outcome"].startswith("DEFERRED"), done[0]["outcome"])
        self.assertIn("its engine runs under source", done[0]["outcome"])
        self.assertFalse(json.loads(stale_meta.read_text(encoding="utf-8"))["isArchived"])

    def test_the_disk_flag_uses_a_writer_owned_temp_name_and_verifies_the_result(self):
        meta = self.root / "m.json"
        meta.write_text(json.dumps({"cliSessionId": "z", "isArchived": False}), encoding="utf-8")
        self.assertIsNone(audit_twins._flag_archived(str(meta)))
        self.assertTrue(json.loads(meta.read_text(encoding="utf-8"))["isArchived"])
        self.assertEqual(sorted(p.name for p in self.root.iterdir() if p.name.startswith("m.json")),
                         ["m.json"])  # no fixed-name .json.tmp and no pid temp left behind
        err = audit_twins._flag_archived(str(self.root / "missing.json"))
        self.assertIsNotNone(err)


class ProcessTreeReadingTest(unittest.TestCase):
    """_claude_process_tree / _user_data_dir - the two places a wrong answer is SILENT."""

    def _tree_from(self, stdout):
        import types

        with mock.patch.object(
                audit_twins.clilib, "run_text",
                return_value=types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")):
            return audit_twins._claude_process_tree()

    def test_a_control_character_in_a_command_line_does_not_blank_the_whole_tree(self):
        """The real failure: one raw control byte in one command line made json.loads throw,
        every engine became untraceable, and the total refusal looked like a policy decision
        rather than a parse error."""
        rows = ('[{"ProcessId":1,"ParentProcessId":0,"CommandLine":"claude.exe --user-data-dir=D:/x"},'
                '{"ProcessId":2,"ParentProcessId":1,"CommandLine":"claude.exe ' + chr(1) + ' --type=x"}]')
        tree = self._tree_from(rows)
        self.assertEqual(len(tree), 2)
        self.assertEqual(tree[2][0], 1)

    def test_a_single_process_comes_back_as_an_object_not_an_array(self):
        tree = self._tree_from('{"ProcessId":9,"ParentProcessId":0,"CommandLine":"claude.exe"}')
        self.assertEqual(list(tree), [9])

    def test_unreadable_output_is_an_empty_tree_never_a_crash(self):
        self.assertEqual(self._tree_from("not json at all"), {})

    def test_user_data_dir_is_read_in_every_form_the_host_writes_it(self):
        cases = {
            "claude.exe --user-data-dir=c:/i/6claude": "c:/i/6claude",
            "claude.exe --user-data-dir c:/i/6claude": "c:/i/6claude",
            'claude.exe --user-data-dir "c:/my instances/6" --type=gpu': "c:/my instances/6",
            "claude.exe --user-data-dir=c:/i/6claude --type=gpu": "c:/i/6claude",
            "claude.exe --type=renderer": "",
        }
        for cmdline, expected in cases.items():
            self.assertEqual(audit_twins._user_data_dir(cmdline), expected, cmdline)


if __name__ == "__main__":
    unittest.main()
