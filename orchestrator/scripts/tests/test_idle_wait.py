"""--idle-wait: wait out the ONE refusal that time cures, and never any of the others.

Why this flag exists (measured 2026-09-03): moving four chats between accounts took ~20
minutes of wall clock. The mechanical move is 15-35s; nearly all the rest was a caller
re-running the command on a guess, because `stop_idle_engine` already knew the exact deficit
("quiet 253s, needs 300s") and threw it away in a refusal string. Four near-identical
refusals to discover that 47 seconds had not elapsed.

The danger in fixing it is obvious and these pin it: a wait must NEVER become a way to
outlast a rail. A working engine, a stuck engine and a live writer are not "not yet" - they
are no - and each must still refuse at today's speed, without sleeping once.
"""

import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_chat  # noqa: E402
from lib import enginelib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402
from util import isolate_state_dir  # noqa: E402

TARGET = {"name": "pap3r rotate", "num": 11, "isRunning": True}
FLEET = {"instances": [TARGET]}


def _match(live=True, instance="work"):
    return {"cliSessionId": "sid-1", "sessionId": "sid-1", "title": "Arkitekt burndown",
            "instance": instance, "live": {"pid": 4242} if live else None}


def _refusal(reason, quiet=None, needs=None):
    return {"stopped": False, "pid": 4242, "reason": reason, "quiet_secs": quiet,
            "needs_secs": needs, "why": f"refused: {reason}"}


class WaitOnlyForTooSoonTest(unittest.TestCase):
    """The loop is entered on R_TOO_SOON and on nothing else."""

    def setUp(self):
        # migrate_chat.main records its attempt in the ledger; without this that ledger was the
        # checkout's own state/ (2026-09-05, probe_state_dir.py).
        isolate_state_dir(self)

    def _run(self, stop_returns, argv_extra, match=None):
        """Drive migrate_chat.main with stop_idle_engine scripted; return (exit, sleeps)."""
        sleeps = []
        stops = list(stop_returns)
        with mock.patch.object(migrate_chat, "resolve_for_migrate",
                               return_value=match or _match()), \
             mock.patch.object(hydralib, "fleet", return_value=FLEET), \
             mock.patch.object(migrate_chat, "resolve_instance", return_value=TARGET), \
             mock.patch.object(holdlib, "why_blocked", return_value=None), \
             mock.patch.object(enginelib, "stop_idle_engine",
                               side_effect=lambda *a, **k: stops.pop(0) if len(stops) > 1 else stops[0]), \
             mock.patch.object(migrate_chat.time, "sleep", side_effect=sleeps.append):
            code = migrate_chat.main(["sid-1", "--to", "11", "--stop-idle", "--json"] + argv_extra)
        return code, sleeps

    def test_a_stuck_engine_refuses_instantly_even_with_a_big_budget(self):
        code, sleeps = self._run([_refusal(enginelib.R_STUCK)], ["--idle-wait", "300"])
        self.assertEqual(code, 4)
        self.assertEqual(sleeps, [], "a STUCK engine must not be slept on - a person decides")

    def test_a_working_engine_refuses_instantly_even_with_a_big_budget(self):
        code, sleeps = self._run([_refusal(enginelib.R_WORKING)], ["--idle-wait", "300"])
        self.assertEqual(code, 4)
        self.assertEqual(sleeps, [], "a working engine may be mid-turn; waiting is unbounded")

    def test_without_the_flag_a_young_engine_still_refuses_at_once(self):
        code, sleeps = self._run([_refusal(enginelib.R_TOO_SOON, 253, 300)], [])
        self.assertEqual(code, 4)
        self.assertEqual(sleeps, [], "the wait is OPT-IN; the default must be unchanged")

    def test_it_sleeps_the_actual_deficit_not_a_fixed_poll(self):
        """47 seconds short should sleep ~47s once, not poll blindly for minutes."""
        stops = [_refusal(enginelib.R_TOO_SOON, 253, 300),
                 {"stopped": True, "pid": 4242, "reason": enginelib.R_IDLE, "why": "idle"}]
        with mock.patch.object(migrate_chat, "_land", create=True):
            code, sleeps = self._run(stops, ["--idle-wait", "300"])
        self.assertEqual(sleeps[:1], [47], f"expected a single 47s nap, got {sleeps}")

    def test_the_budget_is_a_hard_ceiling(self):
        """A chat that never settles must give up inside the budget, never hang."""
        code, sleeps = self._run([_refusal(enginelib.R_TOO_SOON, 10, 300)], ["--idle-wait", "60"])
        self.assertEqual(code, 4)
        self.assertLessEqual(sum(sleeps), 60, f"slept past the budget: {sleeps}")


class StreamingEngineIsNotAYoungOneTest(unittest.TestCase):
    """⛔ A deficit that never shrinks is a WRITING engine, not one about to settle.

    Measured on a real sweep (2026-09-06): three chats refused after 65s, 66s and 18s of
    pure waiting - a third of the batch's wall clock - because idle_report answers
    R_TOO_SOON ("quiet for only 1s, the gate reads the tail at 15s") for a chat that is
    STREAMING just as it does for one that has finished. Every token written resets
    quiet_secs, so the deficit is re-created on every lap and the loop sleeps out its whole
    budget before refusing anyway.

    The tell is the TRAJECTORY, not the reading: sleep n seconds over a silent transcript
    and quiet comes back ~n higher. These pin both directions - the guard must fire on a
    reading that keeps resetting, and must NOT fire on one that is genuinely counting up."""

    def setUp(self):
        isolate_state_dir(self)

    def _run(self, stop_returns, argv_extra):
        sleeps = []
        stops = list(stop_returns)
        with mock.patch.object(migrate_chat, "resolve_for_migrate", return_value=_match()), \
             mock.patch.object(hydralib, "fleet", return_value=FLEET), \
             mock.patch.object(migrate_chat, "resolve_instance", return_value=TARGET), \
             mock.patch.object(holdlib, "why_blocked", return_value=None), \
             mock.patch.object(enginelib, "stop_idle_engine",
                               side_effect=lambda *a, **k: stops.pop(0) if len(stops) > 1 else stops[0]), \
             mock.patch.object(migrate_chat.time, "sleep", side_effect=sleeps.append):
            code = migrate_chat.main(["sid-1", "--to", "11", "--stop-idle", "--json"] + argv_extra)
        return code, sleeps

    def test_a_streaming_engine_gives_up_in_two_naps_not_the_whole_budget(self):
        """quiet stuck at 1s forever: refuse after IDLE_WAIT_STREAMING_LAPS, not after 300s."""
        code, sleeps = self._run([_refusal(enginelib.R_TOO_SOON, 1, 15)], ["--idle-wait", "300"])
        self.assertEqual(code, 4)
        self.assertEqual(len(sleeps), migrate_chat.IDLE_WAIT_STREAMING_LAPS,
                         f"expected {migrate_chat.IDLE_WAIT_STREAMING_LAPS} naps then a refusal, got {sleeps}")
        self.assertLessEqual(sum(sleeps), 30,
                             f"a streaming engine must not cost the whole budget: {sleeps}")

    def test_one_reset_is_not_enough_to_refuse(self):
        """A single write can be a turn's last flush. Refusing there invents a refusal for a
        chat that was seconds from movable, and a false refusal means it never moves at all."""
        stops = [_refusal(enginelib.R_TOO_SOON, 1, 15),
                 _refusal(enginelib.R_TOO_SOON, 1, 15),
                 _refusal(enginelib.R_TOO_SOON, 200, 300)]
        code, sleeps = self._run(stops, ["--idle-wait", "300"])
        # A no-regression pin, not a bug reproduction: this one stays green with the guard
        # removed, and that is the point - it fails only if the guard OVER-fires. The literal
        # 2 is the two-consecutive-resets threshold; comparing against the constant instead
        # would make the assertion move whenever the constant did, which pins nothing.
        self.assertGreater(len(sleeps), 2,
                           f"one reset followed by real progress must keep waiting: {sleeps}")
        self.assertEqual(sleeps[:2], [14, 14], f"the first two naps are the deficit: {sleeps}")

    def test_an_engine_counting_up_is_still_waited_out(self):
        """The ordinary case the flag exists for must be untouched: quiet grows every lap."""
        stops = [_refusal(enginelib.R_TOO_SOON, 253, 300),
                 _refusal(enginelib.R_TOO_SOON, 290, 300),
                 {"stopped": True, "pid": 4242, "reason": enginelib.R_IDLE,
                  "quiet_secs": 300, "needs_secs": 300, "why": "idle"}]
        with mock.patch.object(migrate_chat, "_land", create=True):
            code, sleeps = self._run(stops, ["--idle-wait", "300"])
        self.assertEqual(sleeps, [47, 10],
                         f"a growing quiet reading must not be read as streaming: {sleeps}")

    def test_the_lap_count_is_small_enough_to_be_worth_having(self):
        self.assertGreaterEqual(migrate_chat.IDLE_WAIT_STREAMING_LAPS, 2,
                                "one lap cannot tell a last flush from a stream")
        self.assertLessEqual(migrate_chat.IDLE_WAIT_STREAMING_LAPS, 3,
                             "more laps than this and the guard costs more than it saves")


class WaitArgumentTest(unittest.TestCase):
    def test_the_cap_is_enforced_and_bad_values_are_deterministic(self):
        for bad in (["--idle-wait"], ["--idle-wait", "abc"], ["--idle-wait", "-5"]):
            with mock.patch.object(hydralib, "fleet", return_value=FLEET):
                self.assertEqual(migrate_chat.main(["sid-1", "--to", "11"] + bad), 3,
                                 f"{bad} should be a deterministic refusal")

    def test_the_cap_constant_is_bounded(self):
        self.assertLessEqual(migrate_chat.IDLE_WAIT_CAP, 600,
                             "a script that can block for ages will one day wedge a lane")


class SchedulerNeverWaitsTest(unittest.TestCase):
    """⛔ The 5-minute scheduled lanes must never pass --idle-wait.

    They hold a lock; a blocking wait there starves every lane queued behind a skipped tick,
    and it stretches the gap between the tray-icon check and the act."""

    def test_no_scheduled_job_passes_the_flag(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("schedule_jobs.py", "sweep.py", "groundskeeper.py", "saturate.py"):
            text = (root / name).read_text(encoding="utf-8", errors="replace")
            self.assertNotIn("--idle-wait", text,
                             f"{name} must not wait inside a scheduled lane")


if __name__ == "__main__":
    unittest.main()
