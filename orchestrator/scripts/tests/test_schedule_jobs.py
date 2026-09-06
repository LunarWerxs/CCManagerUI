"""schedule_jobs.py: the generated wrappers and the register/remove plumbing.

The wrappers are the part that actually runs unattended, so they get the assertions: a job
that needs the daemon must SKIP itself when it is down (never run against a fleet it cannot
read), the dashboard job must no-op when the port already answers, and no job may quietly
inherit a wrong path."""

import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import schedule_jobs  # noqa: E402


class WrapperTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_every_job_writes_a_readable_wrapper_with_real_paths(self):
        for job, spec in schedule_jobs.JOBS.items():
            path = schedule_jobs.write_wrapper(job, spec)
            body = path.read_text(encoding="utf-8")
            self.assertTrue(path.exists(), job)
            # no unexpanded placeholders may reach a scheduled job
            for token in ("{scripts}", "{odin}", "{repo}"):
                self.assertNotIn(token, body, f"{job} kept {token}")
            self.assertIn(str(schedule_jobs.REPO), body, job)
            self.assertIn(job, body, job)

    def test_daemon_dependent_jobs_skip_themselves_when_it_is_down(self):
        for job, spec in schedule_jobs.JOBS.items():
            body = schedule_jobs.write_wrapper(job, spec).read_text(encoding="utf-8")
            if spec["needs_daemon"]:
                self.assertIn("7787/api/health", body, f"{job} does not check the daemon")
                self.assertIn("SKIPPED", body, f"{job} does not say it skipped")
                self.assertIn("exit /b 0", body, f"{job} fails instead of skipping")
            else:
                self.assertNotIn("SKIPPED - the AgentHydra daemon", body)

    def test_every_wrapper_actually_writes_its_log(self):
        # 2026-08-31 smoke review: the wrapper promised a log, created the folder, and never
        # redirected a byte - the hidden window ate every line, daemon-down notices included.
        for job, spec in schedule_jobs.JOBS.items():
            body = schedule_jobs.write_wrapper(job, spec).read_text(encoding="utf-8")
            self.assertIn(f'call :main >> "', body, f"{job} does not redirect into its log")
            self.assertIn(f"{job}.log", body, job)
            self.assertIn("gtr 2000000", body, f"{job} has no log rotation")
            # the :main label (the redirected block) must come after the call that routes it
            self.assertIn("\n:main\n", body, job)
            self.assertLess(body.index("call :main"), body.index("\n:main\n"), job)

    def test_pause_and_resume_drive_schtasks_change(self):
        import unittest.mock as mock

        calls = []

        def fake(args):
            calls.append(args)
            return 0, "SUCCESS"

        with mock.patch.object(schedule_jobs, "_schtasks", side_effect=fake):
            code = schedule_jobs.main(["--pause"])
        self.assertEqual(code, 0)
        # The ungated lanes never pause with the eyes (owner, 2026-09-01: the bypass check runs
        # autonomously). They used to get no /Change at all, which quietly left one stuck OFF
        # forever once anything had disabled it - chat-journal was registered while still gated,
        # one pause disabled it, and no later command could switch an "always-on" lane back on.
        # So a pause now ASSERTS their state: every gated lane gets /DISABLE, every ungated lane
        # gets /ENABLE, and one call is made per task either way.
        gated = [a for a in calls if a[-1] == "/DISABLE"]
        ungated = [a for a in calls if a[-1] == "/ENABLE"]
        self.assertEqual(len(gated), len(schedule_jobs.JOBS) - len(schedule_jobs.UNGATED_JOBS))
        self.assertEqual(len(ungated), len(schedule_jobs.UNGATED_JOBS))
        for args in calls:
            self.assertEqual(args[0], "/Change")
        for job in schedule_jobs.UNGATED_JOBS:
            name = f"Orchestrator-{job}"
            self.assertTrue(any(name in a for a in ungated), f"{name} was not kept enabled")
            self.assertFalse(any(name in a for a in gated), f"{name} was disabled by a pause")
        calls.clear()
        with mock.patch.object(schedule_jobs, "_schtasks", side_effect=fake):
            code = schedule_jobs.main(["--resume"])
        self.assertEqual(code, 0)
        for args in calls:
            self.assertEqual(args[-1], "/ENABLE")

    def test_daemon_guard_comes_before_the_lock_guard(self):
        # THE ORDER IS THE FIX (adversarial review, 2026-08-31): lock-then-guard once let a
        # daemon-down exit strand the lock forever, wedging every later tick. The old test
        # only checked both guards EXIST - this pins that the daemon check runs FIRST, so a
        # skip can never leave a lock behind.
        #
        # AH-16: the lock's mkdir/rmdir no longer lives in this wrapper's text at all - it
        # moved into lib/joblocklib.py, invoked via run_locked.py - so what this test pins is
        # now "the daemon guard runs before run_locked.py is even called".
        for job, spec in schedule_jobs.JOBS.items():
            if not (spec["needs_daemon"] and spec.get("lock")):
                continue
            body = schedule_jobs.write_wrapper(job, spec).read_text(encoding="utf-8")
            self.assertIn("run_locked.py", body, f"{job} lost its lock guard")
            self.assertLess(body.index("7787/api/health"), body.index("run_locked.py"),
                            f"{job}: the daemon guard must run BEFORE the lock is taken")

    def _assert_no_parens_in_if_blocks(self, job: str, label: str, body: str) -> None:
        depth = 0
        for n, line in enumerate(body.splitlines(), 1):
            s = line.strip()
            if depth == 0:
                if s.startswith("if ") and s.endswith("("):
                    depth = 1
                continue
            if s == ")":
                depth = 0
                continue
            self.assertNotIn("(", line, f"{label} line {n} has '(' inside an if-block: {s}")
            self.assertNotIn(")", line, f"{label} line {n} has ')' inside an if-block: {s}")

    def test_no_wrapper_puts_a_parenthesis_inside_a_cmd_if_block(self):
        # 2026-09-01: the icon guard's echo said "(python orch.py arm)" inside `if ( ... )`.
        # cmd parses the whole block before running either branch, the ')' closed it early,
        # every lane logged "nothing was unexpected at this time." and exited 255 BEFORE its
        # script ran - for an hour, on every tick, while looking like a quiet fleet.
        #
        # AH-16: this now also covers the .work.cmd a lock-carrying job's lines land in - the
        # redesign moved the LOCK's if-block out entirely (into Python), but it must not have
        # relocated the hazard into the split-off work file instead.
        for job, spec in schedule_jobs.JOBS.items():
            body = schedule_jobs.write_wrapper(job, spec).read_text(encoding="utf-8")
            self._assert_no_parens_in_if_blocks(job, f"{job}.cmd", body)
            if spec.get("lock"):
                work = schedule_jobs.work_path(job).read_text(encoding="utf-8")
                self._assert_no_parens_in_if_blocks(job, f"{job}.work.cmd", work)

    def test_every_acting_job_carries_the_icon_guard_and_the_ungated_ones_do_not(self):
        # The tray icon is the switch (owner order, 2026-09-01): every acting lane asks
        # `orch.py armed --quiet` before its python starts. The dashboard only looks, and the
        # doctrine lane only configures - his later word the same day: the bypass check runs
        # "autonomously, as long as it's programmatically". chat-journal joined them on
        # 2026-09-02: it only writes down what happened to chats, and gating it would blind the
        # record during exactly the window you later need explained (while the icon was down).
        #
        # ⛔ THIS SET IS PINNED ON PURPOSE - it is the list of lanes that run with no kill
        # switch, so growing it is a deliberate act that edits this line, never a side effect.
        # The deleted "remote" lane is why: it was ungated because it "only observes", and it
        # quietly restored phone access to the ARM switch within five minutes of the icon being
        # closed. The bar is not "harmless", it is CANNOT ACT AT ALL.
        self.assertEqual(set(schedule_jobs.UNGATED_JOBS), {"dashboard", "doctrine", "chat-journal"})
        for job, spec in schedule_jobs.JOBS.items():
            body = schedule_jobs.write_wrapper(job, spec).read_text(encoding="utf-8")
            if job in schedule_jobs.UNGATED_JOBS:
                self.assertNotIn("armed --quiet", body)
            else:
                self.assertIn('orch.py" armed --quiet', body)
                self.assertIn("DISARMED", body)

    def test_the_doctrine_lane_runs_every_two_minutes(self):
        self.assertEqual(schedule_jobs.JOBS["doctrine"]["schedule"], schedule_jobs.EVERY_2_MIN)
        self.assertEqual(schedule_jobs.EVERY_2_MIN[-1], "2")

    def test_dashboard_job_no_ops_when_the_port_already_answers(self):
        body = schedule_jobs.write_wrapper("dashboard", schedule_jobs.JOBS["dashboard"]).read_text(encoding="utf-8")
        self.assertIn("7799/data/health", body)
        self.assertIn("already serving", body)
        self.assertIn("dashboard.py", body)

    def test_reconcile_job_never_retries_unattended(self):
        # AH-16: a lock-carrying job's own command now lives in its .work.cmd (run_locked.py
        # runs that file while holding the job lock); the main wrapper only names that path.
        schedule_jobs.write_wrapper("reconcile", schedule_jobs.JOBS["reconcile"])
        work = schedule_jobs.work_path("reconcile").read_text(encoding="utf-8")
        self.assertIn("reconcile.py", work)
        self.assertNotIn("--retry", work)  # an unattended retry is what v1/v2 died of

    def test_todo_sweep_runs_odin_and_never_commits(self):
        schedule_jobs.write_wrapper("todo-sweep", schedule_jobs.JOBS["todo-sweep"])
        work = schedule_jobs.work_path("todo-sweep").read_text(encoding="utf-8")
        self.assertIn("odin.py", work)
        self.assertIn("discover", work)
        self.assertIn("loki --file --apply", work)
        for forbidden in ("git commit", "git push", "git add"):
            self.assertNotIn(forbidden, work)

    def test_task_names_are_namespaced(self):
        for job, spec in schedule_jobs.JOBS.items():
            for name in schedule_jobs.task_names(job, spec):
                self.assertTrue(name.startswith(schedule_jobs.PREFIX), name)


class WrapperExecutionTest(unittest.TestCase):
    """The static-text checks above (test_no_wrapper_puts_a_parenthesis..., etc) proved this
    once already looked right and was NOT: a stray ')' inside an if-block parsed clean by eye
    and every substring assertion still passed, while cmd silently aborted every lane with
    exit 255 for an hour (2026-09-01, see schedule_jobs.py's own docstring on the icon guard).
    Substring checks cannot catch a cmd PARSING failure. This test actually runs a generated
    wrapper through cmd.exe end to end, so the control flow is proven by execution."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    @unittest.skipUnless(sys.platform == "win32", "the generated wrappers are cmd.exe batch files")
    def test_a_daemon_down_wrapper_skips_rotates_its_log_and_never_touches_the_lock(self):
        job, spec = "reconcile", schedule_jobs.JOBS["reconcile"]
        # A port NOTHING answers, independent of whatever this machine's own fleet daemon is
        # really doing on 7787 while the suite runs (it was live and answering when this test
        # was written) - the guard's URL and message both carry the port number, so swapping
        # it everywhere keeps the generated wrapper self-consistent.
        dead_guard = schedule_jobs.DAEMON_GUARD.replace("7787", "18787")
        with mock.patch.object(schedule_jobs, "DAEMON_GUARD", dead_guard):
            wrapper = schedule_jobs.write_wrapper(job, spec)

        log = schedule_jobs._state() / "logs" / f"{job}.log"
        rotated = log.parent / f"{log.name}.1"
        lock = schedule_jobs._state() / "locks" / job

        # A fake log already past the 2MB rotation threshold...
        log.write_text("x" * 2_100_000, encoding="utf-8")
        # ...and a lock dir that already exists, standing in for "a previous run is still
        # going" - proving the daemon guard exits BEFORE the lock guard would ever see it,
        # rather than merely asserting the two lines appear in the right order in the text.
        lock.mkdir(parents=True)

        result = subprocess.run(["cmd", "/c", str(wrapper)],
                                capture_output=True, text=True, timeout=60)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(rotated.exists(), "the oversized log was never rotated")
        self.assertTrue(log.exists(), "a fresh log must exist after rotation")
        body = log.read_text(encoding="utf-8", errors="replace")
        self.assertIn("SKIPPED", body)
        self.assertIn("18787", body)
        # the lock guard's own "still going" message must never appear - the daemon guard
        # exited first, so the lock code was never reached at all
        self.assertNotIn("still going", body)
        self.assertTrue(lock.exists(), "the lock must never be taken (or released) when the "
                                       "daemon guard exits first")

    @unittest.skipUnless(sys.platform == "win32", "the generated wrappers are cmd.exe batch files")
    def test_a_lock_carrying_wrapper_actually_runs_its_work_and_releases_the_lock(self):
        # AH-16 end to end: a fabricated lock-carrying job (no daemon/arm gating, so this is a
        # pure exercise of write_work + run_locked.py + lib/joblocklib.py) really executes its
        # work through cmd, and the job lock is gone again afterward - proving the redesigned
        # lock does not simply look right in the generated text (the exact class of bug the
        # sibling test above in this class exists to catch) but actually acquires, runs under,
        # and releases cleanly for a real, successful run.
        # "dashboard" is used only because it is UNGATED (no armed-icon check to satisfy in
        # this test) - its own real spec is overridden here entirely with a synthetic one.
        job = "dashboard"
        marker = Path(self._tmp.name) / "marker.txt"
        spec = {
            "what": "AH-16 smoke test",
            "schedule": schedule_jobs.EVERY_5_MIN,
            "lines": [f'echo ran > "{marker}"'],
            "needs_daemon": False,
            "lock": True,
        }
        wrapper = schedule_jobs.write_wrapper(job, spec)
        result = subprocess.run(["cmd", "/c", str(wrapper)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(marker.exists(), "the job's own line never ran under the lock")
        lock_dir = schedule_jobs._state() / "locks" / job
        self.assertFalse(lock_dir.exists(), "the lock must be released after a clean run")


class RegistrationTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_apply_calls_schtasks_create_per_task(self):
        with mock.patch.object(schedule_jobs, "_schtasks", return_value=(0, "SUCCESS")) as st:
            results = schedule_jobs.apply_jobs({"reconcile": schedule_jobs.JOBS["reconcile"]})
        self.assertTrue(all(r["ok"] for r in results))
        args = st.call_args.args[0]
        self.assertEqual(args[0], "/Create")
        self.assertIn("/F", args)  # idempotent: re-registering replaces, never duplicates

    def test_remove_treats_a_missing_task_as_a_clean_no_op(self):
        with mock.patch.object(schedule_jobs, "_schtasks",
                               return_value=(1, "ERROR: The system cannot find the file specified.")):
            results = schedule_jobs.remove_jobs({"reconcile": schedule_jobs.JOBS["reconcile"]})
        self.assertTrue(all(r["ok"] for r in results))
        self.assertIn("was not registered", results[0]["detail"])

    def test_a_real_failure_is_reported_not_swallowed(self):
        with mock.patch.object(schedule_jobs, "_schtasks", return_value=(1, "ERROR: Access is denied.")):
            results = schedule_jobs.apply_jobs({"reconcile": schedule_jobs.JOBS["reconcile"]})
        self.assertFalse(results[0]["ok"])
        self.assertIn("Access is denied", results[0]["detail"])

    def test_unknown_job_is_refused(self):
        self.assertEqual(schedule_jobs.main(["--only", "nope"]), 3)


if __name__ == "__main__":
    unittest.main()
