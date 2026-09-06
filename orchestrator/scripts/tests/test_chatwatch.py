#!/usr/bin/env python3
"""Does chatwatch actually FIRE? (the guard-that-never-fired problem)

A monitor whose output is always "nothing changed" reads exactly like a monitor over a quiet
fleet, and the difference only shows up on the day it mattered. So every event kind is provoked
against a throwaway chat store and asserted, including the attribution, which is the whole point
of the tool: an archive this orchestrator can prove is its own must be credited to it, and one
it cannot must say EXTERNAL rather than inventing a culprit.

Run: python scripts/tests/test_chatwatch.py

It is also on the suite's gate: `ChatwatchTest` below runs main() under unittest. Until
2026-09-05 this file had no TestCase at all, so `python -m unittest discover` collected NOTHING
from it and every check here was invisible to the gate - a guard that never fired, inside the
file written to catch guards that never fire. `tests/test_collection_guard.py` (audit AH-42)
now fails the suite on any tracked `test_*.py` that collects as zero cases, so a test module
cannot go quiet like this again.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"   {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def write_chat(root: Path, instance: str, chat_id: str, *, session_id: str,
               title: str, archived: bool) -> Path:
    d = root / instance / "claude-code-sessions" / "profile" / "win"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"local_{chat_id}.json"
    p.write_text(json.dumps({
        "sessionId": f"local_{chat_id}", "cliSessionId": session_id, "title": title,
        "isArchived": archived, "lastActivityAt": int(time.time() * 1000),
    }), encoding="utf-8")
    return p


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="chatwatch-test-"))
    try:
        chats, state = tmp / "instances", tmp / "state"
        state.mkdir(parents=True, exist_ok=True)
        os.environ["ORCH_INSTANCES_ROOT"] = str(chats)
        os.environ["ORCHESTRATOR_STATE_DIR"] = str(state)

        import chatwatch

        write_chat(chats, "acct-a", "aaa", session_id="sess-a", title="Alpha", archived=False)
        write_chat(chats, "acct-a", "bbb", session_id="sess-b", title="Beta", archived=False)
        check("baseline is not an event storm", chatwatch.main([]) == 0)
        check("baseline journalled nothing", not chatwatch.read_journal())

        # An archive this orchestrator can PROVE is its own.
        now = int(time.time() * 1000)
        (state / "attempts.json").write_text(json.dumps({"attempts": [
            {"kind": "archive", "session": "sess-a", "at": now},
        ]}), encoding="utf-8")
        write_chat(chats, "acct-a", "aaa", session_id="sess-a", title="Alpha", archived=True)
        # ...and one it cannot.
        write_chat(chats, "acct-a", "bbb", session_id="sess-b", title="Beta", archived=True)
        chatwatch.main(["--quiet"])
        ev = chatwatch.read_journal()
        arch = {e["sessionId"]: e for e in ev if e["kind"] == "archived"}
        check("both archives were caught", len(arch) == 2, f"got {len(arch)}")
        check("its own archive is credited to it",
              arch.get("sess-a", {}).get("by") == "orchestrator:archive",
              str(arch.get("sess-a", {}).get("by")))
        check("an archive it cannot prove says EXTERNAL",
              arch.get("sess-b", {}).get("by") == "EXTERNAL",
              str(arch.get("sess-b", {}).get("by")))

        # Unarchive, rename, move, vanish.
        write_chat(chats, "acct-a", "bbb", session_id="sess-b", title="Beta renamed", archived=False)
        (chats / "acct-a" / "claude-code-sessions" / "profile" / "win" / "local_aaa.json").unlink()
        write_chat(chats, "acct-b", "aaa2", session_id="sess-a", title="Alpha", archived=False)
        chatwatch.main(["--quiet"])
        kinds = {e["kind"] for e in chatwatch.read_journal()}
        check("unarchive fires", "unarchived" in kinds, str(sorted(kinds)))
        check("rename fires", "renamed" in kinds, str(sorted(kinds)))
        check("a move reads as ONE move, not a vanish + an appear",
              "moved" in kinds and "appeared" not in kinds, str(sorted(kinds)))
        moved = [e for e in chatwatch.read_journal() if e["kind"] == "moved"][0]
        check("the move names both ends",
              moved.get("fromInstance") == "acct-a" and moved.get("instance") == "acct-b",
              json.dumps(moved))

        # A quiet pass must stay quiet - the other half of a trustworthy monitor.
        chatwatch.main(["--quiet"])
        before = len(chatwatch.read_journal())
        chatwatch.main(["--quiet"])
        check("an unchanged store journals nothing", len(chatwatch.read_journal()) == before)

        # An unreadable store must FAIL loudly, never report "all clear".
        shutil.rmtree(chats)
        check("a missing chat store is an error, not an all-clear", chatwatch.main([]) == 1)

        # THE TWO UNGATED LISTS MUST AGREE. They live in different languages (schedule_jobs.py
        # and tray.ps1) and this file's own history says a comment is not enough to keep them
        # in step: tray.ps1 once named 4 tasks while 9 were registered, so "Pause the eyes"
        # left five lanes firing behind an icon that read PAUSED. Drift the other way is what
        # this check caught on the day chat-journal was added - it registered ungated and the
        # tray paused it anyway, silently un-doing the whole point of the lane.
        import schedule_jobs

        tray = (HERE.parent / "tray.ps1").read_text(encoding="utf-8")
        line = next((ln for ln in tray.splitlines() if ln.startswith("$AlwaysOn")), "")
        in_tray = {p.strip().strip("'\"") for p in
                   line.split("@(", 1)[-1].rstrip(")").split(",") if p.strip()}
        in_py = {f"Orchestrator-{j}" for j in schedule_jobs.UNGATED_JOBS}
        check("tray.ps1 $AlwaysOn matches schedule_jobs.UNGATED_JOBS", in_tray == in_py,
              f"tray={sorted(in_tray)} python={sorted(in_py)}")
        return 1 if FAILS else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class ChatwatchTest(unittest.TestCase):
    """The gate's view of this file: every check() above must pass, with the state dir private
    (see util.isolate_state_dir) and the PASS/FAIL lines kept out of the runner's output."""

    def test_every_chatwatch_check_passes(self):
        from util import isolate_state_dir

        isolate_state_dir(self)
        del FAILS[:]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main()
        self.assertEqual(code, 0, "chatwatch checks failed: " + ", ".join(FAILS) + "\n" + out.getvalue())
        self.assertEqual(FAILS, [])


if __name__ == "__main__":
    code = main()
    print(f"\n{'FAILED: ' + ', '.join(FAILS) if FAILS else 'all chatwatch checks passed'}")
    sys.exit(code)
