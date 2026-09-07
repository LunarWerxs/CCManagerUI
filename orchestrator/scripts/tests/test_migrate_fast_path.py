"""The fast path of a hand move (owner, 2026-09-04: "Slower than I wanted. Figure out how to make
this faster. In the future. Way faster. I use this function frequently.").

Moving 'Arkitekt cleanup' off Martin's account took ~70s of tool time and a dozen model round
trips around it: which instance is "Martin", list its chats to find the spelling, load the tool
schemas, read --help, check quota, run, verify. The mechanical move was 15s of that; 55s was the
standing 300s quiet window, waited out for a chat whose transcript already showed nothing in
flight. These pin what closes the gap:

  - the title is matched fuzzily and re-resolved through the dossier by id;
  - --from scopes the search to one account, and refuses to move a chat that only has an
    archived twin there;
  - --now reads background work off the transcript instead of inferring it from silence, and
    keeps the standing window the moment a job IS outstanding;
  - --to best ranks real headroom and never picks the source or a walled account;
  - --dry-run posts nothing;
  - bypassPermissions is re-read from disk after the landing and re-stamped if the app's boot
    re-save took it away - the payload says what the disk said LAST.
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
from lib import enginelib, gatelib, holdlib, hydralib, stamplib  # noqa: E402
from stubdaemon import StubDaemon, dossier_query  # noqa: E402
from util import run_cli  # noqa: E402

SID = "6c5aacb4-477b-4c65-8fc2-025cfc067e78"
SID2 = "caa76548-4eb4-4f15-813f-5729e2a735fe"


def fleet():
    return {"instances": [
        {"num": 8, "name": "another_meh", "label": None, "dir": "c:\\i\\another_meh",
         "ref": "desktop:c:\\i\\another_meh", "isRunning": True, "signedIn": True,
         "account": {"email": "martin@example.com", "planLabel": "Max 20×"}},
        {"num": 36, "name": "anutha23", "label": "Darragh", "dir": "c:\\i\\anutha23",
         "ref": "desktop:c:\\i\\anutha23", "isRunning": True, "signedIn": True,
         "account": {"email": "darragh@example.com", "planLabel": "Max 20×"}},
        {"num": 12, "name": "pap3r rotate2", "label": None, "dir": "c:\\i\\pap3r rotate2",
         "ref": "desktop:c:\\i\\pap3r rotate2", "isRunning": False, "signedIn": True,
         "account": {"email": "dhruv@example.com", "planLabel": "Max 5×"}},
        {"num": 2, "name": "2claude", "label": None, "dir": "c:\\i\\2claude",
         "ref": "desktop:c:\\i\\2claude", "isRunning": True, "signedIn": True,
         "account": {"email": "ape@example.com", "planLabel": "Pro"}},
    ]}


class FuzzyScoreTest(unittest.TestCase):
    def test_a_misspelling_still_names_the_chat(self):
        self.assertGreaterEqual(migrate_chat.fuzzy_title_score("arkitecht cleanup", "Arkitekt cleanup"),
                                migrate_chat.FUZZY_WORD_RATIO)

    def test_a_different_chat_sharing_one_word_does_not(self):
        self.assertLess(migrate_chat.fuzzy_title_score("arkitecht cleanup", "Arkitechts design critic expansion"),
                        migrate_chat.FUZZY_WORD_RATIO)

    def test_case_and_punctuation_are_never_the_difference(self):
        self.assertEqual(migrate_chat.fuzzy_title_score("ARKITEKT-CLEANUP", "arkitekt cleanup"), 1.0)

    def test_empty_never_matches(self):
        self.assertEqual(migrate_chat.fuzzy_title_score("", "Anything"), 0.0)
        self.assertEqual(migrate_chat.fuzzy_title_score("x", ""), 0.0)

    def test_pick_refuses_a_tie_between_two_different_chats(self):
        rows = [{"session_id": "a", "title": "Arkitekt cleanup", "instance": "x"},
                {"session_id": "b", "title": "Arkitekt cleanup", "instance": "y"}]
        self.assertEqual(len(migrate_chat._fuzzy_pick("arkitecht cleanup", rows)), 2)

    def test_pick_takes_a_clear_winner(self):
        rows = [{"session_id": "a", "title": "Arkitekt cleanup", "instance": "x"},
                {"session_id": "b", "title": "Arkitechts design critic expansion", "instance": "x"}]
        got = migrate_chat._fuzzy_pick("arkitecht cleanup", rows)
        self.assertEqual([r["session_id"] for r in got], ["a"])


class ActTestBase(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = fleet()
        # ⛔ NO TEST MAY REACH THE REAL PICKER. confirm_bypass_in_app drives a PowerShell
        # actuator against a live Electron window; a unit test that calls it would take the
        # window lock, steal focus and set a mode on somebody's real chat. Patched here rather
        # than per-test so a test ADDED later cannot forget - the default answer is the
        # honest one for a fake instance dir, "the picker could not confirm".
        self.picker_calls = []

        def _no_picker(row, _fleet):
            self.picker_calls.append(row)
            return "REFUSED: no window (test)"

        self._patches = [mock.patch.object(migrate_chat, "BYPASS_WATCH_SECS", 0),
                         mock.patch.object(migrate_chat, "confirm_bypass_in_app", _no_picker),
                         mock.patch.object(migrate_chat, "_pretrust_workspace", lambda *_a, **_k: None)]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def posts_to(self, suffix):
        return [b for p, b in self.stub.posts if p.endswith(suffix)]


class FuzzyResolveTest(ActTestBase):
    """A misspelled title finds the chat through the sessions table, then comes back through
    the dossier BY ID - with its live block, which a bare table row does not have."""

    def _dossier_by_id_only(self):
        def route(method, path, query, body):
            q = dossier_query(query)
            if q == SID:  # the dossier knows the chat by id, not by the misspelled fragment
                return {"matches": [{"instance": "another_meh", "chatId": "local_x", "cliSessionId": SID,
                                     "lineageIds": [SID], "title": "Arkitekt cleanup", "archived": False,
                                     "lastActivityAt": "T1", "live": {"pid": 77}}]}
            return {"matches": []}
        self.stub.routes["/api/chats/dossier"] = route
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "title": "Arkitekt cleanup", "instance": "another_meh", "archived": False},
            {"session_id": SID2, "title": "Arkitechts design critic expansion", "instance": "another_meh",
             "archived": False},
        ]

    def test_misspelling_resolves_and_carries_the_live_block(self):
        self._dossier_by_id_only()
        m = migrate_chat.resolve_for_migrate("arkitecht cleanup")
        self.assertEqual(m["cliSessionId"], SID)
        self.assertEqual(m["live"], {"pid": 77})  # re-resolved through the dossier, not the bare row

    def test_from_scopes_the_table_search(self):
        self._dossier_by_id_only()
        with self.assertRaises(hydralib.ChatNotFound):
            migrate_chat.resolve_for_migrate("arkitecht cleanup", "anutha23")
        self.assertEqual(migrate_chat.resolve_for_migrate("arkitecht cleanup", "another_meh")["cliSessionId"], SID)

    def test_nothing_close_is_still_not_found(self):
        self._dossier_by_id_only()
        with self.assertRaises(hydralib.ChatNotFound):
            migrate_chat.resolve_for_migrate("completely different words")


class FromScopeTest(ActTestBase):
    """--from: a title two accounts share is one chat once the account is named; the same
    title with no account named is the deterministic refusal it always was."""

    def _two_accounts_same_title(self):
        def route(method, path, query, body):
            q = dossier_query(query)
            if q in ("Burndown", SID, SID2):
                return {"matches": [
                    {"instance": "another_meh", "chatId": "local_a", "cliSessionId": SID, "lineageIds": [SID],
                     "title": "Burndown", "archived": False, "lastActivityAt": "T1", "live": None},
                    {"instance": "anutha23", "chatId": "local_b", "cliSessionId": SID2, "lineageIds": [SID2],
                     "title": "Burndown", "archived": False, "lastActivityAt": "T2", "live": None},
                ] if q == "Burndown" else [
                    {"instance": "another_meh" if q == SID else "anutha23", "chatId": "local_a",
                     "cliSessionId": q, "lineageIds": [q], "title": "Burndown", "archived": False,
                     "lastActivityAt": "T1", "live": None}]}
            return {"matches": []}
        self.stub.routes["/api/chats/dossier"] = route

    def test_unscoped_is_ambiguous(self):
        self._two_accounts_same_title()
        code, out, _ = run_cli(migrate_chat.main, ["Burndown", "--to", "2", "--json"])
        self.assertEqual(code, 3)
        self.assertIn("REFUSED", json.loads(out)["report"])
        self.assertEqual(self.stub.posts, [])

    def test_scoped_moves_the_named_accounts_copy(self):
        self._two_accounts_same_title()
        self.stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        # after the import the dossier must show the chat in the target for verify to pass
        real = self.stub.routes["/api/chats/dossier"]

        def after(method, path, query, body):
            got = real(method, path, query, body)
            if self.posts_to("/import-desktop"):
                for m in got["matches"]:
                    if m["cliSessionId"] == SID:
                        m["instance"] = "2claude"
            return got
        self.stub.routes["/api/chats/dossier"] = after
        code, out, _ = run_cli(migrate_chat.main, ["Burndown", "--from", "8", "--to", "2", "--json"])
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.posts_to("/import-desktop")), 1)
        self.assertIn(f"/api/sessions/{SID}/import-desktop", [p for p, _ in self.stub.posts])
        payload = json.loads(out)
        self.assertEqual(payload["from"], "another_meh")
        self.assertEqual(payload["toNum"], 2)

    def test_from_naming_no_instance_is_deterministic(self):
        self._two_accounts_same_title()
        code, out, _ = run_cli(migrate_chat.main, ["Burndown", "--from", "nobody", "--to", "2", "--json"])
        self.assertEqual(code, 3)
        self.assertIn("--from names no instance", json.loads(out)["report"])

    def test_from_accepts_a_label_and_an_email(self):
        f = fleet()
        self.assertEqual(migrate_chat.resolve_instance(f, "Darragh")["num"], 36)
        self.assertEqual(migrate_chat.resolve_instance(f, "MARTIN@example.com")["num"], 8)
        self.assertEqual(migrate_chat.resolve_instance(f, "#36")["num"], 36)

    def test_only_an_archived_twin_on_the_named_account_says_where_the_chat_really_is(self):
        def route(method, path, query, body):
            return {"matches": [
                {"instance": "another_meh", "chatId": "local_a", "cliSessionId": SID, "lineageIds": [SID],
                 "title": "Burndown", "archived": True, "lastActivityAt": "T1", "live": None},
                {"instance": "anutha23", "chatId": "local_b", "cliSessionId": SID, "lineageIds": [SID],
                 "title": "Burndown", "archived": False, "lastActivityAt": "T2", "live": None},
            ]}
        self.stub.routes["/api/chats/dossier"] = route
        with self.assertRaises(hydralib.ChatNotFound) as ctx:
            migrate_chat.resolve_for_migrate("Burndown", "another_meh")
        self.assertIn("anutha23", str(ctx.exception))


def _write_transcript(path: Path, lines: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")


def _tool_result(text: str, ts: str) -> dict:
    return {"type": "user", "timestamp": ts,
            "message": {"content": [{"type": "tool_result", "content": text}]}}


def _notification(task_id: str, ts: str) -> dict:
    return {"type": "user", "timestamp": ts,
            "message": {"content": [{"type": "text",
                                     "text": f"<task-notification>\n<task-id>{task_id}</task-id>\n"
                                             f"<status>completed</status>\n</task-notification>"}]}}


LAUNCH = "Command running in background with ID: {id}. Output is being written to: C:\\x\\{id}.output. You will be notified when it completes."
MOVED = "Command did not complete within its 120s timeout and was moved to the background (ID: {id}). Output is being written to: C:\\x\\{id}.output."
WORKFLOW = "Workflow launched in background. Task ID: {id}\nSummary: rank things"
AGENT = ("(Internal metadata - never quote.)\nagentId: {id} (internal ID - do not mention to user. Use SendMessage "
         "with to: '{id}' to continue this agent.)\nThe agent is working in the background; you will be notified.")
AGENT_DONE = "The report is above.\nagentId: {id} (internal ID - do not mention to user. Use SendMessage to continue this agent.)"


class BackgroundWorkTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.path = Path(self._td.name) / "t.jsonl"
        self.match = {"cliSessionId": SID, "live": {"pid": 1, "startedAt": "2026-09-05T01:00:00Z"}}

    def tearDown(self):
        self._td.cleanup()

    def bg(self):
        return enginelib.background_work(self.match, str(self.path))

    def test_a_launch_with_no_notification_is_outstanding(self):
        _write_transcript(self.path, [_tool_result(LAUNCH.format(id="b0439z7jg"), "2026-09-05T01:10:00Z")])
        got = self.bg()
        self.assertTrue(got["scanned"])
        self.assertEqual(got["outstanding"], ["b0439z7jg"])

    def test_a_notified_launch_is_not(self):
        _write_transcript(self.path, [_tool_result(LAUNCH.format(id="b0439z7jg"), "2026-09-05T01:10:00Z"),
                                      _notification("b0439z7jg", "2026-09-05T01:12:00Z")])
        got = self.bg()
        self.assertEqual(got["outstanding"], [])
        self.assertEqual((got["launched"], got["notified"]), (1, 1))

    def test_all_four_launch_shapes_are_read(self):
        _write_transcript(self.path, [
            _tool_result(LAUNCH.format(id="b0439z7jg"), "2026-09-05T01:10:00Z"),
            _tool_result(MOVED.format(id="bmm552lv7"), "2026-09-05T01:10:01Z"),
            _tool_result(WORKFLOW.format(id="wjc1a4d2l"), "2026-09-05T01:10:02Z"),
            _tool_result(AGENT.format(id="a0178ab05b4bf4940"), "2026-09-05T01:10:03Z"),
        ])
        self.assertEqual(self.bg()["outstanding"],
                         ["a0178ab05b4bf4940", "b0439z7jg", "bmm552lv7", "wjc1a4d2l"])

    def test_a_finished_agents_id_is_not_a_launch(self):
        _write_transcript(self.path, [_tool_result(AGENT_DONE.format(id="a0178ab05b4bf4940"), "2026-09-05T01:10:00Z")])
        self.assertEqual(self.bg()["outstanding"], [])

    def test_a_job_of_a_previous_engine_is_dead_not_outstanding(self):
        _write_transcript(self.path, [_tool_result(LAUNCH.format(id="bold"), "2026-09-05T00:30:00Z"),
                                      _tool_result(LAUNCH.format(id="bnew"), "2026-09-05T01:30:00Z")])
        self.assertEqual(self.bg()["outstanding"], ["bnew"])

    def test_unknown_engine_start_counts_everything(self):
        self.match["live"] = {"pid": 1}
        _write_transcript(self.path, [_tool_result(LAUNCH.format(id="bold"), "2026-09-05T00:30:00Z")])
        self.assertEqual(self.bg()["outstanding"], ["bold"])

    def test_a_launch_whose_id_cannot_be_read_is_outstanding_forever(self):
        _write_transcript(self.path, [_tool_result("Command running in background. You will be notified.",
                                                   "2026-09-05T01:10:00Z")])
        self.assertEqual(self.bg()["outstanding"], ["unparsed x1"])

    def test_prose_about_backgrounds_is_not_a_launch(self):
        _write_transcript(self.path, [_tool_result("The card fill paints the background colour of the page",
                                                   "2026-09-05T01:10:00Z")])
        self.assertEqual(self.bg()["outstanding"], [])

    def test_a_missing_transcript_is_not_scanned_and_never_reads_as_clear(self):
        got = enginelib.background_work(self.match, str(self.path / "nope"))
        self.assertFalse(got["scanned"])
        self.assertEqual(got["outstanding"], [])

    def test_sidechain_records_are_ignored(self):
        rec = _tool_result(LAUNCH.format(id="bside"), "2026-09-05T01:10:00Z")
        rec["isSidechain"] = True
        _write_transcript(self.path, [rec])
        self.assertEqual(self.bg()["outstanding"], [])


class NowWindowTest(unittest.TestCase):
    MATCH = {"cliSessionId": SID, "live": {"pid": 1}}

    def test_without_now_the_standing_window_applies_and_nothing_is_scanned(self):
        with mock.patch.object(enginelib, "background_work") as scan:
            mq, ia, bg = migrate_chat.quiet_window(self.MATCH, False)
        self.assertEqual((mq, ia, bg), (enginelib.IDLE_STOP_SECS, gatelib.IDLE_AFTER_SECS, None))
        scan.assert_not_called()

    def test_now_with_nothing_outstanding_is_the_fast_window(self):
        clear = {"scanned": True, "outstanding": [], "launched": 2, "notified": 2, "why": "none"}
        with mock.patch.object(enginelib, "background_work", return_value=clear):
            mq, ia, bg = migrate_chat.quiet_window(self.MATCH, True)
        self.assertEqual((mq, ia), (enginelib.NOW_QUIET_SECS, enginelib.NOW_QUIET_SECS))
        self.assertIs(bg, clear)

    def test_now_with_a_job_outstanding_keeps_the_standing_window(self):
        busy = {"scanned": True, "outstanding": ["b1"], "launched": 1, "notified": 0, "why": "1 job"}
        with mock.patch.object(enginelib, "background_work", return_value=busy):
            mq, ia, _ = migrate_chat.quiet_window(self.MATCH, True)
        self.assertEqual((mq, ia), (enginelib.IDLE_STOP_SECS, gatelib.IDLE_AFTER_SECS))

    def test_now_with_an_unscannable_transcript_keeps_the_standing_window(self):
        unknown = {"scanned": False, "outstanding": [], "launched": 0, "notified": 0, "why": "no file"}
        with mock.patch.object(enginelib, "background_work", return_value=unknown):
            mq, ia, _ = migrate_chat.quiet_window(self.MATCH, True)
        self.assertEqual((mq, ia), (enginelib.IDLE_STOP_SECS, gatelib.IDLE_AFTER_SECS))

    def test_now_implies_stop_idle(self):
        parsed = migrate_chat._parse_migrate_argv([SID, "--to", "2", "--now"])
        self.assertTrue(parsed.stop_idle)
        self.assertTrue(parsed.now)


class YoungQuietIsWaitableTest(unittest.TestCase):
    """A chat quieter than the gate's own read threshold used to be R_WORKING - a refusal no
    wait could cure, so --idle-wait gave up on a 100s-quiet chat at once. The gate not having
    looked yet is the one thing time cures: it is R_TOO_SOON with the deficit stated."""

    MATCH = {"cliSessionId": SID, "title": "T", "instance": "a", "live": {"pid": 4242}}

    def test_quiet_under_the_gates_threshold_is_too_soon_not_working(self):
        verdict = {"state": "running", "idle": None, "stalled": None, "cause": "alive (quiet 100s)",
                   "quiet_secs": 100, "live": {"pid": 4242}}
        with mock.patch.object(hydralib, "session_row", return_value=None), \
             mock.patch.object(gatelib, "gate_match", return_value=verdict):
            rep = enginelib.idle_report(self.MATCH)
        self.assertEqual(rep["reason"], enginelib.R_TOO_SOON)
        self.assertEqual((rep["quiet_secs"], rep["needs_secs"]), (100, gatelib.IDLE_AFTER_SECS))

    def test_the_fast_window_is_passed_through_to_the_gate(self):
        verdict = {"state": "running", "idle": {"quiet_secs": 20}, "stalled": None, "cause": "idle",
                   "quiet_secs": 20, "live": {"pid": 4242}}
        with mock.patch.object(hydralib, "session_row", return_value=None), \
             mock.patch.object(gatelib, "gate_match", return_value=verdict) as gate:
            rep = enginelib.idle_report(self.MATCH, enginelib.NOW_QUIET_SECS, enginelib.NOW_QUIET_SECS)
        self.assertTrue(rep["idle"])
        self.assertEqual(gate.call_args.kwargs.get("idle_after_secs"), enginelib.NOW_QUIET_SECS)

    def test_a_working_engine_past_the_threshold_is_still_working(self):
        verdict = {"state": "running", "idle": None, "stalled": None, "cause": "alive (quiet 400s)",
                   "quiet_secs": 400, "live": {"pid": 4242}}
        with mock.patch.object(hydralib, "session_row", return_value=None), \
             mock.patch.object(gatelib, "gate_match", return_value=verdict):
            rep = enginelib.idle_report(self.MATCH)
        self.assertEqual(rep["reason"], enginelib.R_WORKING)


class BestTargetTest(unittest.TestCase):
    def survey(self):
        def row(num, week, sess, severity="normal"):
            return {"kind": "desktop", "num": num, "id": f"c:\\i\\{num}", "label": str(num),
                    "result": {"snapshot": {"weekAll": {"pct": week}, "session": {"pct": sess}}, "reason": "ok"},
                    "advice": {"severity": severity, "bindingPct": week}}
        return {"rows": [row(8, 36, 77), row(36, 0, 0), row(12, 0, 3), row(2, 2, 3),
                         {"kind": "cli", "num": 99, "id": "x", "label": "cli", "result": {"snapshot": {}}, "advice": {}}]}

    def test_picks_the_running_account_with_the_most_real_headroom_never_the_source(self):
        target, ranked = migrate_chat.best_target(fleet(), "another_meh", self.survey())
        self.assertEqual(target["num"], 36)
        self.assertNotIn(8, [r["num"] for r in ranked])
        # a closed Max 5x at 0% (500 headroom) ranks below every running one; a Pro at 2% is 98
        self.assertEqual([r["num"] for r in ranked], [36, 2, 12])

    def test_a_walled_five_hour_window_and_an_unknown_read_are_not_headroom(self):
        s = self.survey()
        s["rows"][1]["result"]["snapshot"]["session"]["pct"] = 100     # #36 walled right now
        s["rows"][3]["advice"]["severity"] = "unknown"                  # #2 never read
        target, ranked = migrate_chat.best_target(fleet(), "another_meh", s)
        self.assertEqual([r["num"] for r in ranked], [12])
        self.assertEqual(target["num"], 12)

    def test_no_candidate_is_none(self):
        target, ranked = migrate_chat.best_target(fleet(), None, {"rows": []})
        self.assertIsNone(target)
        self.assertEqual(ranked, [])

    def test_tier_multiplier_reads_the_digits_even_when_the_times_sign_is_mojibaked(self):
        self.assertEqual(migrate_chat._tier_multiplier({"account": {"planLabel": "Max 20Ã—"}}), 20)
        self.assertEqual(migrate_chat._tier_multiplier({"account": {"planLabel": "Max 5×"}}), 5)
        self.assertEqual(migrate_chat._tier_multiplier({"account": {"planLabel": "Pro"}}), 1)
        self.assertEqual(migrate_chat._tier_multiplier({}), 1)


class DryRunTest(ActTestBase):
    def test_dry_run_plans_and_posts_nothing(self):
        def route(method, path, query, body):
            return {"matches": [{"instance": "another_meh", "chatId": "local_a", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "Arkitekt cleanup", "archived": False,
                                 "lastActivityAt": "T1", "live": None}]}
        self.stub.routes["/api/chats/dossier"] = route
        with mock.patch.object(holdlib, "why_blocked", return_value="HELD by audit_twins: duplicate"):
            code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "36", "--now", "--dry-run", "--json"])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertTrue(payload["dryRun"])
        self.assertFalse(payload["landed"])
        self.assertEqual((payload["from"], payload["toNum"]), ("another_meh", 36))
        self.assertIn("HELD", payload["report"])
        self.assertIn("DRY RUN", payload["report"])
        self.assertEqual(self.stub.posts, [])

    def test_dry_run_to_best_names_the_ranking(self):
        def route(method, path, query, body):
            return {"matches": [{"instance": "another_meh", "chatId": "local_a", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "T", "archived": False,
                                 "lastActivityAt": "T1", "live": None}]}
        self.stub.routes["/api/chats/dossier"] = route
        survey = BestTargetTest().survey()
        with mock.patch.object(hydralib, "usage_survey", return_value=survey):
            code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "best", "--dry-run", "--json"])
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertEqual(payload["toNum"], 36)
        self.assertEqual(payload["targetChoice"]["ranked"][0]["num"], 36)
        self.assertEqual(self.stub.posts, [])


class BypassWatchTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.meta = Path(self._td.name) / "local_x.json"
        self.meta.write_text(json.dumps({"cliSessionId": SID, "permissionMode": "bypassPermissions",
                                         "sessionSettings": {"ultracode": True}, "effort": "xhigh"}),
                             encoding="utf-8")

    def tearDown(self):
        self._td.cleanup()

    def test_a_boot_resave_that_flips_the_mode_is_re_stamped_and_reported(self):
        clock = {"t": 0.0}
        reads = {"n": 0}

        def sleep(_s):
            clock["t"] += 1.0
            reads["n"] += 1
            if reads["n"] == 1:  # the app's boot re-save, one second in
                m = json.loads(self.meta.read_text(encoding="utf-8"))
                m["permissionMode"] = "acceptEdits"
                self.meta.write_text(json.dumps(m), encoding="utf-8")

        got = migrate_chat.watch_bypass(str(self.meta), watch_secs=3, sleep=sleep, clock=lambda: clock["t"])
        self.assertEqual(got, {"mode": stamplib.BYPASS, "flips": 1, "stable": True,
                               "ultracode": True})
        self.assertEqual(json.loads(self.meta.read_text(encoding="utf-8"))["permissionMode"], stamplib.BYPASS)

    def test_a_record_that_stays_bypass_is_reported_without_flips(self):
        got = migrate_chat.watch_bypass(str(self.meta), watch_secs=0)
        self.assertEqual(got, {"mode": stamplib.BYPASS, "flips": 0, "stable": True,
                               "ultracode": True})

    def test_an_app_resave_that_drops_ULTRACODE_is_re_stamped_too(self):
        """THE FALSE GREEN THIS CLOSES (measured 2026-09-06 on five just-moved chats): the
        watch only ever guarded permissionMode, so a re-save that kept bypass and dropped
        ultracode went unnoticed and the move still reported "bypassPermissions + ultracode
        stamped". Four of five chats were sitting with ultracode gone minutes later."""
        clock = {"t": 0.0}
        reads = {"n": 0}

        def sleep(_s):
            clock["t"] += 1.0
            reads["n"] += 1
            if reads["n"] == 1:  # the app re-saves ITS view: bypass kept, ultracode absent
                m = json.loads(self.meta.read_text(encoding="utf-8"))
                m["sessionSettings"] = {}
                m["effort"] = None
                self.meta.write_text(json.dumps(m), encoding="utf-8")

        got = migrate_chat.watch_bypass(str(self.meta), watch_secs=3, sleep=sleep,
                                        clock=lambda: clock["t"])
        self.assertTrue(got["ultracode"], "the ultracode half must be defended, not just bypass")
        self.assertEqual(got["flips"], 1)
        back = json.loads(self.meta.read_text(encoding="utf-8"))
        self.assertTrue(back["sessionSettings"]["ultracode"])
        self.assertEqual(back["effort"], "xhigh")

    def test_an_unreadable_record_is_not_claimed_as_bypass(self):
        got = migrate_chat.watch_bypass(str(self.meta.with_name("gone.json")), watch_secs=0)
        self.assertIsNone(got["mode"])
        self.assertFalse(got["stable"])

    def test_many_records_share_ONE_window_and_each_keeps_its_own_verdict(self):
        """The shared watch a batch uses. N of these windows overlap perfectly, so running
        them serially spent 8s x N waiting for the same 8 seconds. What must NOT change is
        the answer: every path gets the verdict its own record earned."""
        other = self.meta.with_name("other.json")
        other.write_text(json.dumps({"cliSessionId": "other", "permissionMode": "acceptEdits"}),
                         encoding="utf-8")
        clock = {"t": 0.0}
        naps = {"n": 0}

        def sleep(_s):
            clock["t"] += 1.0
            naps["n"] += 1

        got = migrate_chat.watch_bypass_many([str(self.meta), str(other)], watch_secs=2,
                                             sleep=sleep, clock=lambda: clock["t"])
        # ONE window, not one per record: two seconds of watching, not four.
        self.assertEqual(naps["n"], 2)
        self.assertEqual(got[str(self.meta)], {"mode": stamplib.BYPASS, "flips": 0,
                                               "stable": True, "ultracode": True})
        # The off-doctrine record was re-stamped, exactly as a lone watch would have.
        self.assertEqual(got[str(other)]["flips"], 1)
        self.assertTrue(got[str(other)]["stable"])
        self.assertEqual(json.loads(other.read_text(encoding="utf-8"))["permissionMode"],
                         stamplib.BYPASS)

    def test_an_unreadable_record_in_a_shared_watch_is_reported_not_dropped(self):
        """A missing key would read to the caller as "nobody watched for me" and quietly earn
        a fresh 8s watch; it must come back as an unclaimed verdict instead."""
        gone = str(self.meta.with_name("gone.json"))
        got = migrate_chat.watch_bypass_many([str(self.meta), gone], watch_secs=0)
        self.assertIn(gone, got)
        self.assertIsNone(got[gone]["mode"])
        self.assertFalse(got[gone]["stable"])

    def test_an_empty_shared_watch_is_not_an_error(self):
        self.assertEqual(migrate_chat.watch_bypass_many([], watch_secs=0), {})


class LandingPayloadTest(ActTestBase):
    def test_a_landing_reports_the_mode_the_disk_said_last(self):
        with tempfile.TemporaryDirectory() as td:
            meta = Path(td) / "local_y.json"
            meta.write_text(json.dumps({"cliSessionId": SID, "title": "T", "permissionMode": "acceptEdits"}),
                            encoding="utf-8")
            stub = self.stub

            def route(method, path, query, body):
                acted = any("/import-desktop" in p for p, _ in stub.posts)
                q = dossier_query(query)
                if q != SID and q not in "T":
                    return {"matches": []}
                return {"matches": [{"instance": "2claude" if acted else "another_meh", "chatId": "local_y",
                                     "cliSessionId": SID, "lineageIds": [SID], "title": "T", "archived": False,
                                     "lastActivityAt": "T1", "live": None, "metaPath": str(meta)}]}

            stub.routes["/api/chats/dossier"] = route
            stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
            stub.routes[f"/api/sessions/{SID}/automation"] = {"ok": True}
            code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "2", "--now", "--json"])
            self.assertEqual(code, 0, out)
            payload = json.loads(out)
            self.assertEqual(payload["permissionMode"], stamplib.BYPASS)
            # ⛔ A RUNNING TARGET THAT THE APP NEVER CONFIRMED IS NOT A GREEN (owner,
            # 2026-09-05, the third hand-fix). The disk agreeing with itself for the whole
            # watch is exactly what this payload used to call bypassStamped=True, and the
            # chat still opened on a prompting mode because the app holds the mode in memory.
            self.assertEqual(payload["bypassVerdict"], "disk-only")
            self.assertFalse(payload["bypassStamped"])
            self.assertIn(SID, payload["bypassRemedy"])
            self.assertIn("BYPASS NOT VERIFIED", payload["report"])
            self.assertEqual(len(self.picker_calls), 1)  # it TRIED the app first
            # no live engine: nothing was stopped, so no quiet window was ever decided or scanned
            self.assertNotIn("quietWindowSecs", payload)
            self.assertNotIn("backgroundTasks", payload)
            self.assertEqual((payload["from"], payload["to"], payload["toNum"]), ("another_meh", "2claude", 2))
            self.assertEqual(json.loads(meta.read_text(encoding="utf-8"))["permissionMode"], stamplib.BYPASS)

    def _land_into(self, landed_instance: str, to_arg: str, meta_mode: str = "acceptEdits"):
        """Land SID into one instance and return (payload, metaPath). Shared by the verdict
        tests below, which differ only in whether that instance's app is running."""
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        meta = Path(td.name) / "local_y.json"
        meta.write_text(json.dumps({"cliSessionId": SID, "title": "T", "permissionMode": meta_mode}),
                        encoding="utf-8")
        stub = self.stub

        def route(method, path, query, body):
            acted = any("/import-desktop" in p for p, _ in stub.posts)
            q = dossier_query(query)
            if q != SID and q not in "T":
                return {"matches": []}
            return {"matches": [{"instance": landed_instance if acted else "another_meh",
                                 "chatId": "local_y", "cliSessionId": SID, "lineageIds": [SID],
                                 "title": "T", "archived": False, "lastActivityAt": "T1",
                                 "live": None, "metaPath": str(meta)}]}

        stub.routes["/api/chats/dossier"] = route
        stub.routes[f"/api/sessions/{SID}/import-desktop"] = {"ok": True}
        stub.routes[f"/api/sessions/{SID}/automation"] = {"ok": True}
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", to_arg, "--now", "--json"])
        self.assertEqual(code, 0, out)
        return json.loads(out), meta

    def test_the_apps_own_picker_confirming_IS_the_green(self):
        """The one green available while the target app runs. A confirmation is the app's own
        verdict (set_mode_via_app writes it on actuator exit 0), never a disk read."""
        import automation_chat

        def _confirms(row, _fleet):
            automation_chat.mark_confirmed(row["sessionId"], "MODE SET 'Accept edits' -> 'Bypass permissions'")
            return "MODE SET 'Accept edits' -> 'Bypass permissions'"

        with mock.patch.object(migrate_chat, "confirm_bypass_in_app", _confirms):
            payload, _ = self._land_into("2claude", "2")
        self.assertEqual(payload["bypassVerdict"], "app-confirmed")
        self.assertTrue(payload["bypassStamped"])
        self.assertEqual(payload["bypassRemedy"], "")
        self.assertNotIn("BYPASS NOT VERIFIED", payload["report"])

    def test_a_CLOSED_target_is_adopted_at_boot_and_never_touches_the_picker(self):
        """A closed app reads its store at its own boot - the one write that provably enters
        app memory - so the disk stamp IS the mode it will open with. Driving a picker at a
        window that does not exist would be nonsense, so it must not even be attempted."""
        payload, meta = self._land_into("pap3r rotate2", "12")
        self.assertEqual(payload["bypassVerdict"], "adopted-at-boot")
        self.assertTrue(payload["bypassStamped"])
        self.assertEqual(self.picker_calls, [])
        self.assertEqual(json.loads(meta.read_text(encoding="utf-8"))["permissionMode"], stamplib.BYPASS)


if __name__ == "__main__":
    unittest.main()
