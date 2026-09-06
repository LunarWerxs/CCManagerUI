"""compact_chat.py: the forced-autocompact maneuver behind full rails - console-only, floor,
quiet check, breaker, hold, and verification from the transcript's own numbers."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402
from util import run_cli  # noqa: E402

import compact_chat  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402

SID = "dddd1111-2222-3333-4444-555566667777"
NEW_SID = "dddd2222-3333-4444-5555-666677778888"


def usage_line(tokens: int) -> str:
    return json.dumps({"type": "assistant", "message": {
        "usage": {"input_tokens": tokens // 2, "cache_read_input_tokens": tokens - tokens // 2}}})


class CompactChatTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.tp = Path(self._tmp.name) / f"{SID}.jsonl"
        self.write_transcript(self.tp, 300_000)
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "A big console chat",
             "instance": None, "transcript_path": str(self.tp), "cwd": self._tmp.name,
             "last_activity_at": 1}
        ]
        # the machine-wide cap counts live chats via the dossier; nothing is live here
        self.stub.routes["/api/chats/dossier"] = {"matches": []}

    def write_transcript(self, path: Path, tokens: int, quiet_secs: float = 600):
        path.write_text(usage_line(tokens) + "\n", encoding="utf-8")
        old = time.time() - quiet_secs
        os.utime(path, (old, old))

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def ok_runner(self, marker=True, after_tokens=60_000, roll=True):
        tmp = Path(self._tmp.name)

        def run(exe, sid, window, cwd):
            new = NEW_SID if roll else sid
            target = tmp / f"{new}.jsonl"
            lines = []
            if marker:
                lines.append(json.dumps({"type": "system", "subtype": "compact_boundary"}))
            lines.append(usage_line(after_tokens))
            target.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return 0, json.dumps({"session_id": new, "result": "MAINTENANCE OK"})

        return run

    def test_compacts_verifies_and_reports_the_rolled_id(self):
        code, out, _ = run_cli(
            lambda argv: compact_chat.main(argv, runner=self.ok_runner()), [SID, "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["compacted"])
        self.assertEqual(payload["sessionId"], NEW_SID)
        self.assertGreater(payload["contextBefore"], payload["contextAfter"])
        self.assertEqual(len(ledgerlib._load()), 0)  # success clears the attempt

    def test_widens_to_the_full_census_when_the_default_window_misses_it(self):
        # AH-07: the default /api/sessions window (period=7d here) can miss a real, compactable
        # chat; main() must widen to hydralib.sessions_all() (period=all) before refusing. The
        # stub route below deliberately answers DIFFERENTLY by period, so this only passes if
        # main() actually asks twice rather than reusing the first (empty) page.
        from urllib.parse import parse_qs

        good_row = self.stub.routes["/api/sessions"][0]

        def sessions_route(method, path, query, body):
            period = parse_qs(query).get("period", [""])[0]
            return [good_row] if period == "all" else []

        self.stub.routes["/api/sessions"] = sessions_route
        code, out, _ = run_cli(
            lambda argv: compact_chat.main(argv, runner=self.ok_runner()), [SID, "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["compacted"])

    def test_shrink_without_marker_still_counts(self):
        code, out, _ = run_cli(
            lambda argv: compact_chat.main(argv, runner=self.ok_runner(marker=False, roll=False)),
            [SID, "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["compacted"])

    def test_turn_ran_but_nothing_compacted_is_exit_2_with_attempt_kept(self):
        def lazy(exe, sid, window, cwd):
            return 0, json.dumps({"session_id": sid, "result": "MAINTENANCE OK"})

        code, out, _ = run_cli(lambda argv: compact_chat.main(argv, runner=lazy), [SID])
        self.assertEqual(code, 2)
        self.assertIn("NO compaction", out)
        self.assertEqual(len(ledgerlib._load()), 1)

    def test_desktop_chat_is_refused_deterministically(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "A desktop chat",
             "instance": "2claude", "transcript_path": str(self.tp), "cwd": self._tmp.name}]
        code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 3)
        self.assertIn("DESKTOP", out)

    def test_small_context_is_honestly_not_worth_it(self):
        self.write_transcript(self.tp, 40_000)
        code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 0)
        self.assertIn("under the --min floor", out)
        self.assertEqual(len(ledgerlib._load()), 0)  # no attempt spent on a no-op

    def test_recent_activity_is_a_transient_refusal(self):
        os.utime(self.tp, None)  # touched just now
        code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 4)
        self.assertIn("mid-work", out)

    def test_hold_and_breaker_are_honored(self):
        holdlib.hold(SID, "owner is mid-review")
        self.assertEqual(run_cli(compact_chat.main, [SID])[0], 6)
        holdlib.release(SID)
        for _ in range(4):
            ledgerlib.note("compact", SID, note="drill")
        self.assertEqual(run_cli(compact_chat.main, [SID])[0], 5)

    def test_the_maintenance_turn_is_mechanically_toolless(self):
        # The no-work guarantee is a PARAMETER, not prompt words (owner law): --tools ""
        # disables every tool for the turn. This pins it so a refactor cannot quietly
        # demote it back to advice.
        import unittest.mock as mock

        with mock.patch("compact_chat.clilib.run_text") as m:
            m.return_value = mock.Mock(returncode=0, stdout="{}", stderr="")
            compact_chat.run_turn("claude.exe", SID, 100_000, self._tmp.name)
        argv = m.call_args[0][0]
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertIn("--autocompact", argv)
        self.assertIn("--resume", argv)

    def test_the_machine_wide_cap_defers_the_turn(self):
        import unittest.mock as mock

        with mock.patch.object(hydralib, "running_count", return_value=hydralib.MAX_RUNNING_CHATS):
            code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 4)
        self.assertIn("cap", out)

    def test_a_live_engine_refuses_even_though_the_transcript_is_quiet(self):
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"cliSessionId": SID, "lineageIds": [SID], "live": {"pid": 4242}}]}
        code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 4)
        self.assertIn("LIVE engine", out)

    def test_a_dossier_read_failure_is_exit_1_not_a_pass(self):
        self.stub.routes["/api/chats/dossier"] = (500, {"error": "boom"})
        code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 1)
        self.assertIn("cannot tell", out)

    def test_unknown_usage_never_reads_as_small(self):
        self.tp.write_text(json.dumps({"type": "assistant"}) + "\n", encoding="utf-8")
        old = time.time() - 600
        os.utime(self.tp, (old, old))
        code, out, _ = run_cli(compact_chat.main, [SID])
        self.assertEqual(code, 3)
        self.assertIn("unknown", out)


if __name__ == "__main__":
    unittest.main()
