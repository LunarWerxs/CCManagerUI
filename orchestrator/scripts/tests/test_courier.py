"""deliverylib + stage_reply + courier: the staging ledger and the delivery rails.

The courier types into live chats, so its refusals are the important tests: never mid-turn,
never without a verify snippet, never past a hold or the breaker, and never claimed delivered
without the chat actually moving."""

import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

import courier  # noqa: E402
from lib import armlib  # noqa: E402
from lib import bandlib  # noqa: E402
from lib import deliverylib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402

SID = "cccc9999-1111-2222-3333-444455556666"
DONE_WAITING = ("Here is what I found.\n"
                "## Am I 100% done?\n- No, the deploy step is still open.\n"
                "Shall I go ahead and run it?")


from util import run_cli  # noqa: E402


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_stage_requires_text(self):
        with self.assertRaises(ValueError):
            deliverylib.stage(SID, "   ")

    def test_verify_snippet_comes_from_the_chats_own_last_words(self):
        e = deliverylib.stage(SID, "yes go ahead", evidence=DONE_WAITING)
        self.assertIn("Shall I go ahead", e["verifyText"])
        self.assertEqual(e["state"], "staged")

    def test_lifecycle_states(self):
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        self.assertEqual([r["id"] for r in deliverylib.pending()], [e["id"]])
        deliverylib.note_attempt(e["id"])
        self.assertEqual(deliverylib.get(e["id"])["attempts"], 1)
        deliverylib.mark_delivered(e["id"])
        self.assertEqual(deliverylib.get(e["id"])["state"], "delivered")
        self.assertEqual(deliverylib.pending(), [])

    def test_failed_can_be_requeued_but_delivered_cannot(self):
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        deliverylib.mark_failed(e["id"], "actuator refused")
        self.assertEqual(deliverylib.get(e["id"])["state"], "failed")
        self.assertIsNotNone(deliverylib.requeue(e["id"]))
        self.assertEqual(deliverylib.get(e["id"])["state"], "staged")
        deliverylib.mark_delivered(e["id"])
        self.assertIsNone(deliverylib.requeue(e["id"]))

    def test_a_terse_chat_still_gets_a_snippet_but_a_tiny_one_is_refused(self):
        # A whole last turn of "WINDOW TEST OK" is identifiable; three characters are not.
        e = deliverylib.stage(SID, "go", evidence="WINDOW TEST OK")
        self.assertEqual(e["verifyText"], "WINDOW TEST OK")
        e2 = deliverylib.stage(SID, "go", evidence="ok")
        self.assertEqual(e2["verifyText"], "")

    def test_the_longest_line_wins_when_none_is_long_enough(self):
        e = deliverylib.stage(SID, "go", evidence="hi\nWINDOW TEST OK\nbye")
        self.assertEqual(e["verifyText"], "WINDOW TEST OK")

    def test_cancel_only_touches_staged(self):
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        self.assertIsNotNone(deliverylib.cancel(e["id"]))
        self.assertIsNone(deliverylib.cancel(e["id"]))

    def test_cancel_raises_inflight_when_a_courier_claim_is_fresh(self):
        # 2026-09-01: a courier run may already be typing this row - "cancelled" would be a
        # lie the ledger later contradicts with "delivered".
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        claim = deliverylib.claim_path(e["id"])
        claim.mkdir(parents=True)
        try:
            with self.assertRaises(deliverylib.InFlight):
                deliverylib.cancel(e["id"])
            self.assertEqual(deliverylib.get(e["id"])["state"], "staged")
        finally:
            claim.rmdir()

    def test_stage_reply_cli_reports_not_cancelled_when_claimed(self):
        import stage_reply

        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        claim = deliverylib.claim_path(e["id"])
        claim.mkdir(parents=True)
        try:
            code, out, _ = run_cli(stage_reply.main, ["--cancel", e["id"]])
        finally:
            claim.rmdir()
        self.assertEqual(code, 3)
        self.assertIn("NOT cancelled", out)

    def test_mark_delivered_and_failed_never_touch_an_already_cancelled_row(self):
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        deliverylib.cancel(e["id"])
        self.assertIsNone(deliverylib.mark_delivered(e["id"]))
        self.assertIsNone(deliverylib.mark_failed(e["id"], "whatever"))
        row = deliverylib.get(e["id"])
        self.assertEqual(row["state"], "cancelled")
        self.assertIsNone(row["lastError"])

    def test_dedupe_returns_the_existing_staged_row(self):
        e1 = deliverylib.stage(SID, "go", evidence=DONE_WAITING, dedupe=True)
        e2 = deliverylib.stage(SID, "go again", evidence=DONE_WAITING, dedupe=True)
        self.assertEqual(e2["id"], e1["id"])
        self.assertTrue(e2["reused"])
        self.assertEqual(len(deliverylib.pending(SID)), 1)

    def test_without_dedupe_a_second_stage_writes_a_second_row(self):
        e1 = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        e2 = deliverylib.stage(SID, "go again", evidence=DONE_WAITING)
        self.assertNotEqual(e1["id"], e2["id"])
        self.assertEqual(len(deliverylib.pending(SID)), 2)

    def test_recent_delivery_finds_a_row_delivered_moments_ago(self):
        now_ms = int(time.time() * 1000)
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        deliverylib.mark_delivered(e["id"], now_ms=now_ms - 10_000)  # 10s ago
        found = deliverylib.recent_delivery(SID, 180, now_ms=now_ms)
        self.assertIsNotNone(found)
        self.assertEqual(found["id"], e["id"])

    def test_recent_delivery_ignores_an_old_delivery(self):
        now_ms = int(time.time() * 1000)
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        deliverylib.mark_delivered(e["id"], now_ms=now_ms - 3600_000)  # 1h ago
        self.assertIsNone(deliverylib.recent_delivery(SID, 180, now_ms=now_ms))


class RunActuatorTest(unittest.TestCase):
    """A hung actuator must read as an ordinary (code, why) failure - never an uncaught
    subprocess.TimeoutExpired that would skip mark_failed and the results row entirely."""

    def test_a_timeout_is_a_normal_failure_tuple_not_an_exception(self):
        with mock.patch("pathlib.Path.exists", return_value=True), \
             mock.patch.object(courier.subprocess, "run",
                               side_effect=courier.subprocess.TimeoutExpired(
                                   cmd="deliver_desktop_chat.ps1", timeout=courier.ACTUATOR_TIMEOUT_SECS)):
            code, out = courier._run_actuator("t", "temp1", "msg", "verify")
        self.assertEqual(code, 1)
        self.assertIn("timed out", out)


class CourierRailTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.tp = Path(self._tmp.name) / "t.jsonl"
        self._write_tail(DONE_WAITING, age=600)
        self.live = None
        stub = self.stub

        def dossier_route(method, path, query, body):
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [{"instance": "temp1", "chatId": "c1", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "A waiting chat",
                                 "archived": False, "lastActivityAt": self.activity,
                                 "live": self.live}]}

        self.activity = "T1"
        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "A waiting chat",
             "instance": "temp1", "transcript_path": str(self.tp), "last_activity_at": 1}
        ]
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "temp1", "dir": "c:\\i\\temp1", "isRunning": True, "signedIn": True,
             "account": {"email": "a@x.com", "planLabel": "Max 20×"}}]}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _write_tail(self, text, age=600, tool_use=False):
        content = [{"type": "text", "text": text}] if text else []
        if tool_use:
            content.append({"type": "tool_use", "name": "Bash", "input": {}})
        self.tp.write_text(json.dumps({"type": "assistant", "message": {"content": content}}) + "\n",
                           encoding="utf-8")
        old = time.time() - age
        os.utime(self.tp, (old, old))

    def _stage(self, **kw):
        return deliverylib.stage(SID, kw.pop("text", "Yes, go ahead."),
                                 title="A waiting chat", instance="temp1",
                                 evidence=DONE_WAITING, **kw)

    def test_a_waiting_chat_is_deliverable(self):
        e = self._stage()
        ok, why, match = courier.deliverable(e)
        self.assertTrue(ok, why)
        self.assertEqual(match["cliSessionId"], SID)

    def test_never_into_a_turn_in_flight(self):
        self._write_tail("working on it", age=5, tool_use=True)
        self.live = {"pid": 99, "name": "w"}
        e = self._stage()
        ok, why, _ = courier.deliverable(e)
        self.assertFalse(ok)
        self.assertIn("IN FLIGHT", why)

    def test_an_idle_live_chat_is_the_normal_target(self):
        self.live = {"pid": 99, "name": "w"}   # alive but quiet, turn completed
        e = self._stage()
        ok, why, _ = courier.deliverable(e)
        self.assertTrue(ok, why)

    def test_never_without_a_verify_snippet(self):
        e = deliverylib.stage(SID, "go", title="A waiting chat", evidence="")
        ok, why, _ = courier.deliverable(e)
        self.assertFalse(ok)
        self.assertIn("no verify snippet", why)

    def test_a_live_chat_needs_no_verify_snippet(self):
        # Live smoke, 2026-09-01: a chat whose last words were 'PONG' (too short for a
        # snippet) was undeliverable although a LIVE chat takes the message through its own
        # peer pipe - native input, nothing to aim. The snippet is the composer's rail only.
        self.live = {"pid": 99, "name": "w"}
        e = deliverylib.stage(SID, "go", title="A waiting chat", evidence="")
        ok, why, _ = courier.deliverable(e)
        self.assertTrue(ok, why)

    def test_a_hold_stops_delivery(self):
        holdlib.hold(SID, "I am answering this one myself")
        e = self._stage()
        ok, why, _ = courier.deliverable(e)
        self.assertFalse(ok)
        self.assertIn("HELD", why)

    def test_the_breaker_stops_a_futile_loop(self):
        for _ in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("deliver", SID)
        e = self._stage()
        ok, why, _ = courier.deliverable(e)
        self.assertFalse(ok)
        self.assertIn("breaker", why)

    def test_a_crashed_chat_is_a_delivery_target_the_send_is_the_revive(self):
        # 2026-09-01: the composer send BOOTS a dormant/crashed chat and runs the turn (the
        # daemon's own measurement) - so delivering the reply IS the resume, and the old
        # "resume it first" refusal applied only to the phantom native route.
        self._write_tail("", age=600)  # no completed turn -> crashed
        e = self._stage()
        ok, why, _ = courier.deliverable(e)
        self.assertTrue(ok, why)

    def test_skipped_replies_stay_staged_never_failed(self):
        holdlib.hold(SID, "mine")
        e = self._stage()
        report = courier.run(5, None, act=True)
        self.assertEqual(report["results"], [])
        self.assertEqual(len(report["skipped"]), 1)
        self.assertEqual(deliverylib.get(e["id"])["state"], "staged")

    def test_the_daemon_message_endpoint_is_preferred_and_trusted_only_when_it_confirms(self):
        # The REAL message endpoint (2026-09-01): one daemon call types, self-heals an
        # unrendered row, and confirms from the transcript. The local actuator is only the
        # older-daemon fallback (a 404).
        e = self._stage()
        self.stub.routes[f"/api/sessions/{SID}/message"] = {
            "ok": True, "typed": True, "delivered": True, "detail": "transcript growing"}
        with mock.patch.object(courier, "_run_actuator") as act:
            report = courier.run(5, None, act=True)
        act.assert_not_called()
        self.assertTrue(report["results"][0]["ok"])
        self.assertEqual(deliverylib.get(e["id"])["state"], "delivered")
        posts = [b for p, b in self.stub.posts if p.endswith("/message")]
        self.assertEqual(posts[0]["text"], "Yes, go ahead.")
        self.assertTrue(posts[0]["verify_text"])

    def test_an_unconfirmed_endpoint_answer_is_an_honest_failure(self):
        e = self._stage()
        self.stub.routes[f"/api/sessions/{SID}/message"] = {
            "ok": False, "typed": True, "delivered": False, "detail": "transcript did not grow"}
        with mock.patch.object(courier, "_run_actuator") as act:
            report = courier.run(5, None, act=True)
        act.assert_not_called()
        self.assertFalse(report["results"][0]["ok"])
        self.assertEqual(deliverylib.get(e["id"])["state"], "failed")

    def test_the_courier_never_posts_migrate(self):
        # 2026-09-01, the hard way: /migrate delivers NO prompt - it kills and reimports the
        # chat dormant (message lost, zombie twin, "Claude has crashed"). The composer is
        # the one delivery channel; this pins that no delivery ever touches /migrate again.
        self._stage()
        with mock.patch.object(courier, "_run_actuator", side_effect=self._moving_actuator()):
            report = courier.run(5, None, act=True)
        self.assertTrue(report["results"][0]["ok"])
        self.assertEqual([p for p, _ in self.stub.posts if "/migrate" in p], [])

    def test_a_boot_from_dormant_counts_as_movement(self):
        # A composer send into a dormant chat boots its engine; the live registry shows the
        # fresh process before the first transcript write - that boot IS movement.
        e = self._stage()
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        calls = {"n": 0}

        def fake_live(sid, matches=None):
            calls["n"] += 1
            return None if calls["n"] == 1 else {"pid": 99, "name": "x", "startedAt": 1}

        with mock.patch.object(courier.hydralib, "live_for", side_effect=fake_live), \
             mock.patch.object(courier, "_run_actuator", return_value=(0, "typed")):
            report = courier.run(5, None, act=True)
        self.assertTrue(report["results"][0]["ok"])
        self.assertEqual(deliverylib.get(e["id"])["state"], "delivered")

    def test_the_machine_wide_cap_defers_deliveries_round_robin(self):
        # Owner, 2026-08-31: at most 18 chats running machine-wide; a delivery past the cap
        # DEFERS (stays staged for the next 5-minute cycle) rather than waking a 19th.
        e = self._stage()
        with mock.patch.object(hydralib, "running_count",
                               return_value=hydralib.MAX_RUNNING_CHATS), \
             mock.patch.object(courier, "_run_actuator") as m:
            report = courier.run(5, None, act=True)
        m.assert_not_called()
        self.assertTrue(report["skipped"][0]["why"].startswith("concurrency cap"))
        self.assertEqual(deliverylib.get(e["id"])["state"], "staged")
        # one slot free -> it goes
        with mock.patch.object(hydralib, "running_count",
                               return_value=hydralib.MAX_RUNNING_CHATS - 1), \
             mock.patch.object(courier, "_run_actuator", side_effect=self._moving_actuator()):
            report = courier.run(5, None, act=True)
        self.assertTrue(report["results"][0]["ok"])

    def test_the_cap_counts_WAKES_not_messages(self):
        """THE CAP DECLINED TO DELIVER ON ITS OWN ARITHMETIC (found live 2026-09-06).

        The machine-wide cap exists because "every delivery can wake a chat", so N deliveries
        could add N runners. But a delivery to a chat that is ALREADY RUNNING adds nobody - it
        is a message into an engine the snapshot has already counted. Two chats sitting inside
        the very 18 the cap was measuring were refused a message for reaching it.

        The notion was already here: deliverable() returns `wakes`, and the PER-ACCOUNT share
        honoured it while this machine-wide gate did not. Both count the same thing now.
        """
        self._stage()
        # already running, and idle - the normal live target
        self.live = {"pid": 4242}
        self.stub.routes["/api/sessions/live"] = {
            "count": hydralib.MAX_RUNNING_CHATS, "sessions": [{"sessionId": SID}]}
        with mock.patch.object(hydralib, "running_count",
                               return_value=hydralib.MAX_RUNNING_CHATS), \
             mock.patch.object(courier, "_run_actuator",
                               side_effect=self._moving_actuator()):
            report = courier.run(5, None, act=True)
        self.assertTrue(report["results"], "a message to an ALREADY-RUNNING chat adds no "
                                           "concurrency and must not be held by the cap")
        self.assertTrue(report["results"][0]["ok"])

    def test_the_cap_still_defers_a_delivery_that_would_WAKE_a_chat(self):
        """The other half, and the one that must never regress: at the cap, a chat with no live
        engine can only be a wake, so it still defers and stays staged."""
        e = self._stage()
        self.live = None
        self.stub.routes["/api/sessions/live"] = {"count": hydralib.MAX_RUNNING_CHATS,
                                                  "sessions": []}
        with mock.patch.object(hydralib, "running_count",
                               return_value=hydralib.MAX_RUNNING_CHATS), \
             mock.patch.object(courier, "_run_actuator") as m:
            report = courier.run(5, None, act=True)
        m.assert_not_called()
        self.assertTrue(report["skipped"][0]["why"].startswith("concurrency cap"))
        self.assertIn("wake", report["skipped"][0]["why"])
        self.assertEqual(deliverylib.get(e["id"])["state"], "staged")

    def test_an_unknown_liveness_read_fails_CLOSED_at_the_cap(self):
        """⛔ Unknown liveness must be treated as a wake. A daemon read that fails must never
        become a reason to deliver past the cap - that would turn an outage into an override."""
        e = self._stage()
        self.live = {"pid": 4242}
        with mock.patch.object(hydralib, "running_count",
                               return_value=hydralib.MAX_RUNNING_CHATS), \
             mock.patch.object(hydralib, "running_by_instance",
                               side_effect=hydralib.DaemonError(
                                   "/api/sessions/live", None, "live registry unreachable")), \
             mock.patch.object(courier, "_run_actuator") as m:
            report = courier.run(5, None, act=True)
        m.assert_not_called()
        self.assertTrue(report["skipped"][0]["why"].startswith("concurrency cap"))
        self.assertEqual(deliverylib.get(e["id"])["state"], "staged")

    def test_a_claimed_delivery_is_never_double_sent(self):
        # Adversarial review, 2026-08-31: two overlapping courier runs could both pick up
        # the same staged row. The claim (an atomic mkdir) makes delivery at-most-once.
        e = self._stage()
        lock = ledgerlib._state_dir() / "locks" / f"deliver-{e['id']}"
        lock.mkdir(parents=True)
        try:
            with mock.patch.object(courier, "_run_actuator") as m:
                report = courier.run(5, None, act=True)
            m.assert_not_called()
            self.assertFalse(report["results"][0]["ok"])
            self.assertIn("another courier run", report["results"][0]["outcome"])
            self.assertEqual(deliverylib.get(e["id"])["state"], "staged")
        finally:
            lock.rmdir()

    def test_delivery_confirmed_only_when_the_chat_moves(self):
        e = self._stage()
        activity = {"n": 0}

        def fake_actuator(title, instance, message, verify):
            self.activity = "T2"   # the chat moved
            activity["n"] += 1
            return 0, "delivered"

        with mock.patch.object(courier, "_run_actuator", side_effect=fake_actuator):
            report = courier.run(5, None, act=True)
        self.assertTrue(report["results"][0]["ok"])
        self.assertEqual(deliverylib.get(e["id"])["state"], "delivered")
        # success clears the breaker count
        self.assertFalse(ledgerlib.check("deliver", SID)["suppressed"])

    def test_sent_but_not_moved_is_never_claimed_delivered(self):
        e = self._stage()
        with mock.patch.object(courier, "_run_actuator", return_value=(0, "typed")), \
             mock.patch.object(courier, "CONFIRM_SECS", 1):
            report = courier.run(5, None, act=True)
        self.assertFalse(report["results"][0]["ok"])
        self.assertIn("NOT confirmed", report["results"][0]["outcome"])
        row = deliverylib.get(e["id"])
        self.assertEqual(row["state"], "failed")
        self.assertIn("did not move", row["lastError"])

    def test_actuator_failure_is_recorded_with_its_reason(self):
        e = self._stage()
        with mock.patch.object(courier, "_run_actuator",
                               return_value=(1, "AMBIGUOUS: 2 rendered chats end with that title")):
            report = courier.run(5, None, act=True)
        self.assertFalse(report["results"][0]["ok"])
        self.assertIn("AMBIGUOUS", deliverylib.get(e["id"])["lastError"])

    def test_one_rows_unexpected_exception_does_not_abandon_the_next_row(self):
        # Hardening, 2026-09-01: an unhandled exception mid-send used to escape run() entirely
        # and abandon every LATER planned row, unrecorded and un-retried. Two staged replies,
        # the first one's actuator raises - the second must still be attempted and delivered.
        sid_b = SID[:-1] + "7"
        stub = self.stub

        activity = {SID: "T1", sid_b: "T1"}

        def dossier_route(method, path, query, body):
            q = dossier_query(query)
            if q not in (SID, sid_b):
                return {"matches": []}
            return {"matches": [{"instance": "temp1", "chatId": q, "cliSessionId": q,
                                 "lineageIds": [q], "title": f"chat {q}", "archived": False,
                                 "lastActivityAt": activity[q], "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": sid, "archived": False, "title": f"chat {sid}", "instance": "temp1",
             "transcript_path": str(self.tp), "last_activity_at": 1}
            for sid in (SID, sid_b)
        ]
        e1 = self._stage()
        e2 = deliverylib.stage(sid_b, "go", title=f"chat {sid_b}", instance="temp1",
                               evidence=DONE_WAITING)

        calls = {"n": 0}

        def flaky_actuator(title, instance, message, verify):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("boom - a bug in the send path, not a refusal")
            activity[sid_b] = "T-moved"
            return 0, "delivered"

        with mock.patch.object(courier, "_run_actuator", side_effect=flaky_actuator):
            report = courier.run(5, None, act=True)

        by_id = {r["id"]: r for r in report["results"]}
        self.assertFalse(by_id[e1["id"]]["ok"])
        self.assertIn("unexpected", by_id[e1["id"]]["outcome"])
        self.assertIn("boom", deliverylib.get(e1["id"])["lastError"])
        # the SECOND row was still attempted and delivered - the exception did not abort the loop
        self.assertTrue(by_id[e2["id"]]["ok"])
        self.assertEqual(deliverylib.get(e2["id"])["state"], "delivered")

    def test_the_staged_count_is_measured_before_acting(self):
        # A run that delivered everything must not report "nothing staged" (live-run bug).
        self._stage()
        with mock.patch.object(courier, "_run_actuator", side_effect=self._moving_actuator()):
            report = courier.run(5, None, act=True)
        self.assertEqual(report["staged"], 1)
        self.assertTrue(report["results"][0]["ok"])

    def _moving_actuator(self):
        def fake(title, instance, message, verify):
            self.activity = "T-moved"
            return 0, "delivered"

        return fake

    def test_plan_only_sends_nothing(self):
        self._stage()
        with mock.patch.object(courier, "_run_actuator") as m:
            code, out, _ = run_cli(courier.main, [])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("PLAN ONLY", out)

    def test_the_per_account_share_is_counted_forward_within_one_run(self):
        # 2026-09-01: three staged replies for three DORMANT chats on one account all passed
        # "0 < share" against a snapshot taken once, and woke all three - up to 2.5x the
        # ceiling. The share must be counted FORWARD as the loop itself plans wakes.
        sid_a, sid_b, sid_c = (SID[:-1] + c for c in ("1", "2", "3"))
        stub = self.stub

        def dossier_route(method, path, query, body):
            q = dossier_query(query)
            if q not in (sid_a, sid_b, sid_c):
                return {"matches": []}
            return {"matches": [{"instance": "temp1", "chatId": q, "cliSessionId": q,
                                 "lineageIds": [q], "title": f"chat {q}", "archived": False,
                                 "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": sid, "archived": False, "title": f"chat {sid}", "instance": "temp1",
             "transcript_path": str(self.tp), "last_activity_at": 1}
            for sid in (sid_a, sid_b, sid_c)
        ]
        entries = [deliverylib.stage(sid, "go", title=f"chat {sid}", instance="temp1",
                                     evidence=DONE_WAITING)
                   for sid in (sid_a, sid_b, sid_c)]
        with mock.patch.object(bandlib, "per_account_share", return_value=2):
            report = courier.run(5, None, act=False)
        self.assertEqual(len(report["planned"]), 2)
        self.assertEqual({p["id"] for p in report["planned"]},
                         {entries[0]["id"], entries[1]["id"]})
        skip = next(s for s in report["skipped"] if s["id"] == entries[2]["id"])
        self.assertTrue(any(w in skip["why"] for w in ("share", "hogging")), skip["why"])

    def test_only_one_message_per_chat_is_planned_per_run(self):
        e1 = self._stage()
        e2 = self._stage(text="Also go ahead.")
        report = courier.run(5, None, act=False)
        self.assertEqual(len(report["planned"]), 1)
        self.assertEqual(report["planned"][0]["id"], e1["id"])
        skip = next(s for s in report["skipped"] if s["id"] == e2["id"])
        self.assertIn("already planned in this run", skip["why"])

    def test_deliver_one_refuses_a_row_cancelled_after_planning(self):
        # 2026-09-01 review: run() plans from one snapshot and sends serially; a cancel that
        # lands in that window must stop the send, not be overwritten by a stale "delivered".
        e = self._stage()
        ok, why, match = courier.deliverable(e)
        self.assertTrue(ok, why)
        deliverylib.cancel(e["id"])
        result = courier.deliver_one(e, match)
        self.assertFalse(result["ok"])
        self.assertIn("no longer staged", result["outcome"])
        posts = [p for p, _ in self.stub.posts if p.endswith("/message")]
        self.assertEqual(posts, [])

    def test_yes_without_an_armed_window_refuses_and_delivers_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --yes alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        e = self._stage()
        with mock.patch.object(courier, "_run_actuator") as m:
            code, out, _ = run_cli(courier.main, ["--yes"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)
        self.assertEqual(deliverylib.get(e["id"])["state"], "staged")

    def test_yes_with_an_armed_window_delivers_as_before(self):
        armlib.arm(3600)
        e = self._stage()
        self.stub.routes[f"/api/sessions/{SID}/message"] = {
            "ok": True, "typed": True, "delivered": True, "detail": "transcript growing"}
        code, out, _ = run_cli(courier.main, ["--yes"])
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)
        self.assertEqual(deliverylib.get(e["id"])["state"], "delivered")

    def test_stage_reply_cli_records_evidence_from_the_gate(self):
        import stage_reply

        code, out, _ = run_cli(stage_reply.main, [SID, "--text", "Yes, deploy it."])
        self.assertEqual(code, 0)
        row = deliverylib.pending()[0]
        self.assertEqual(row["text"], "Yes, deploy it.")
        self.assertIn("Shall I go ahead", row["verifyText"])


if __name__ == "__main__":
    unittest.main()


class WalledChatIsWakeableTest(unittest.TestCase):
    """A chat killed by a USAGE WALL could never be woken, which is the one class of chat that
    most needs waking (found live 2026-09-06, on two chats moved off an account at its cap).

    The mechanism, and why each half is right on its own:
      - deliverylib refuses the app's rate-limit banner as a verify snippet, correctly: every
        walled chat on one account renders the identical line, so it identifies an ACCOUNT and
        never a conversation, and the snippet's whole job is proving which pane is on screen.
      - a walled chat's LAST assistant record is nothing but that banner.
    Together they produced no evidence at all, the courier refused to type, and the actuator
    died on an empty -VerifyText. The fix keeps the refusal and walks BACK to what the chat
    actually said - which is still on screen, directly above the banner.
    """

    BANNER = "You've hit your session limit · resets 10pm (America/Chicago)"
    REAL = "Run A finished: 424 of 492 readers succeeded and 68 failed on 529 server overload."

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tp = Path(self._td.name) / "walled.jsonl"

    def tearDown(self):
        self._td.cleanup()

    def _write(self, *texts):
        with open(self.tp, "w", encoding="utf-8") as f:
            for t in texts:
                f.write(json.dumps({"type": "assistant",
                                    "message": {"content": [{"type": "text", "text": t}]}}) + "\n")

    def test_the_banner_is_still_refused_as_proof_of_identity(self):
        """The guard this fix must NOT weaken: the banner names an account, not a chat."""
        self.assertTrue(deliverylib.is_limit_banner(self.BANNER))
        self.assertEqual(deliverylib._verify_snippet(self.BANNER), "")

    def test_a_real_reply_that_merely_mentions_a_limit_is_still_usable(self):
        """The migration chats discuss session limits constantly. Length is what separates the
        app's one-line banner from a chat's own words about one; matching alone is not enough."""
        wordy = ("I stopped the fan-out because the account was near its session limit, and the "
                 "remaining 44 reads are queued against the parts directory rather than lost, "
                 "so nothing has to be recomputed when the window resets at the top of the hour.")
        self.assertFalse(deliverylib.is_limit_banner(wordy),
                         "matching the phrase is not enough - the banner is SHORT, and length "
                         "is what separates the app's line from a chat writing about one")
        self.assertNotEqual(deliverylib._verify_snippet(wordy), "",
                            "a chat's own paragraph about a limit is still its own words")

    def test_the_transcript_walk_skips_a_banner_only_turn(self):
        self._write(self.REAL, self.BANNER)
        import stage_reply
        with mock.patch.object(stage_reply.hydralib, "session_row",
                               return_value={"transcript_path": str(self.tp)}):
            got = stage_reply.last_rendered_text("any-sid")
        self.assertEqual(got, self.REAL, "stopping on the banner is what made walled chats stuck")
        self.assertNotEqual(deliverylib._verify_snippet(got), "")

    def test_the_gates_banner_answer_does_not_beat_the_transcript(self):
        """The half that actually bit: the gate honestly reports the banner as
        `last_assistant_text`, and non-empty-but-unusable evidence short-circuited the
        transcript fallback before it ever ran."""
        self._write(self.REAL, self.BANNER)
        import stage_reply
        with mock.patch.object(stage_reply.gatelib, "gate_match",
                               return_value={"state": "idle",
                                             "idle": {"last_assistant_text": self.BANNER}}), \
             mock.patch.object(stage_reply.hydralib, "session_row",
                               return_value={"transcript_path": str(self.tp)}):
            ev = stage_reply._gather_evidence({"cliSessionId": "any-sid"}, "any-sid")
        self.assertEqual(ev, self.REAL)
        self.assertNotEqual(deliverylib._verify_snippet(ev), "",
                            "with no usable snippet the courier refuses and the chat stays stuck")
