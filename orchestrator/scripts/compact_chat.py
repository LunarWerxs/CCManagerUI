#!/usr/bin/env python3
"""compact_chat.py - ACT: COMPACT one console/CLI chat's context instead of abandoning it.

Sometimes the answer to a full context is a fresh chat; sometimes (owner, 2026-08-31) it is
worth COMPACTING the one that exists. There is no supported on-demand headless /compact
(checked against the docs, 2026-08-31), but the same pass CAN be forced: resume the saved
session headlessly with a small --autocompact window and a do-nothing prompt, and the
engine's own auto-compact fires before the turn runs. This script owns that maneuver plus
the rails around it.

SCOPE - CONSOLE/CLI SESSIONS ONLY. A desktop chat is REFUSED (deterministic): resuming it
outside its app would fork the conversation behind the app's back (the same reason imports
refuse live sessions). Desktop chats compact through their app's own autocompact; and the
owner never restarts the apps, so nothing here touches them.

WHAT A RUN COSTS, honestly: one real model turn on the session's account, and compaction
itself is lossy by design - detail is summarized away. Pick subjects accordingly; the
--min floor keeps it away from small chats where a fresh start is free.

THE NO-WORK GUARANTEE IS MECHANICAL, not words (owner law, 2026-08-31: never rely on
prompt advice where a parameter exists): the turn runs with `--tools ""`, the CLI's
documented switch that disables EVERY tool - the model cannot run a command, edit a file,
or continue work no matter how it reads the prompt. The prompt text is just an honest
label for the transcript.

VERIFICATION: context is measured from the transcript's own usage stamps before and after;
success = a compact marker in the continued transcript OR a real shrink. The continuation
keeps whatever session id the engine reports (same id, or a rolled one - both are handled
and reported).

Usage: python compact_chat.py <session id | title fragment> [--window N] [--min N] [--json]
       --window N   the autocompact budget handed to the engine (default 100000 tokens)
       --min N      refuse-as-unnecessary floor: contexts under this are not compacted
                    (default 150000 tokens)
Exit:  0 compacted and verified (or honestly not needed - under --min) - 2 the turn ran but
       no compaction was observed (context vs window reported) - 3 deterministic refusal
       (desktop chat, unknown chat, missing transcript/cwd) - 4 possibly mid-work (recent
       transcript activity; transient) - 5 breaker - 6 held - 1 failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib
from lib import mutationlib

DEFAULT_WINDOW = 100_000
DEFAULT_MIN = 150_000
QUIET_SECS = 180  # matches the gate's idle threshold: newer activity = possibly mid-work
TURN_TIMEOUT_SECS = 1800  # compaction of a huge context is a long model pass
TAIL_BYTES = 4_000_000  # usage stamps live near the end; never read a 500MB transcript whole
COMPACT_MARKERS = ("compact_boundary", "isCompactSummary")
MAINTENANCE_PROMPT = (
    "This is an automated context-maintenance turn from the orchestrator (tools are disabled "
    "for this turn). Nothing is asked of you. Reply with exactly: MAINTENANCE OK"
)


def context_tokens(transcript: str | Path) -> int | None:
    """The chat's current context size, from the LAST usage stamp in its transcript tail.
    None when no stamp is readable - unknown must never read as 'small'."""
    p = Path(transcript)
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # drop the partial line the seek landed in
            tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in reversed(tail.splitlines()):
        if '"usage"' not in line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        usage = ((row.get("message") or {}).get("usage")) or row.get("usage") or {}
        total = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        )
        if total:
            return total
    return None


def resolve_claude() -> str | None:
    """The claude CLI executable, overridable for odd installs via ORCHESTRATOR_CLAUDE_EXE."""
    override = os.environ.get("ORCHESTRATOR_CLAUDE_EXE")
    if override:
        return override
    for name in ("claude.cmd", "claude.exe", "claude"):
        hit = shutil.which(name)
        if hit and not hit.lower().endswith(".ps1"):  # a .ps1 shim is not directly runnable
            return hit
    # the npm shim's own target, the standard install location
    exe = Path.home() / "AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    return str(exe) if exe.exists() else None


def run_turn(exe: str, session_id: str, window: int, cwd: str) -> tuple[int, str]:
    """The forced-autocompact resume turn. Returns (exit code, stdout)."""
    r = clilib.run_text(
        [exe, "-p", "--resume", session_id, "--autocompact", str(window),
         # MECHANICAL no-work guarantee (docstring): every tool disabled for this turn.
         "--tools", "",
         "--output-format", "json", MAINTENANCE_PROMPT],
        timeout=TURN_TIMEOUT_SECS, cwd=cwd,
    )
    return r.returncode, (r.stdout or "") + (("\n" + r.stderr) if r.returncode != 0 else "")


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


@dataclass
class Outcome:
    """One step's verdict: the human-readable report, the process exit code, whether the
    step counts as success, and any extra fields the JSON payload should carry (breaker
    details, token counts, the rolled session id, ...). Every early-return branch of the
    old monolithic main() produced exactly this shape by hand; giving it a name lets each
    branch live in its own small function instead of one long one."""
    report: str
    code: int
    ok: bool = False
    extra: dict = field(default_factory=dict)


def emit(outcome: Outcome, as_json: bool) -> int:
    payload = {"ok": outcome.ok, "report": outcome.report, **outcome.extra}
    return out(payload, as_json, outcome.code)


def parse_args(argv: list[str]) -> tuple[bool, int, int, list[str]]:
    """Pull --json/--window/--min out of argv; everything else is a positional arg."""
    as_json = "--json" in argv
    window, floor = DEFAULT_WINDOW, DEFAULT_MIN
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--window" and i + 1 < len(argv):
            window = int(argv[i + 1]); i += 2; continue
        if a == "--min" and i + 1 < len(argv):
            floor = int(argv[i + 1]); i += 2; continue
        if not a.startswith("--"):
            args.append(a)
        i += 1
    return as_json, window, floor, args


def resolve_target_row(rows: list[dict], query: str) -> tuple[dict | None, Outcome | None]:
    """Match a session by exact id, else by a case-insensitive title fragment."""
    hits = [r for r in rows if r.get("session_id") == query]
    if not hits:
        q = query.lower()
        hits = [r for r in rows if q in str(r.get("title") or "").lower()]
    if not hits:
        return None, Outcome(f"REFUSED (deterministic): no session matches {query!r}", 3)
    if len(hits) > 1:
        names = ", ".join(f"[{h.get('instance') or 'console'}] {h.get('title')}" for h in hits[:6])
        return None, Outcome(f"REFUSED (deterministic): {len(hits)} sessions match: {names}", 3)
    return hits[0], None


def check_session_eligible(row: dict, sid: str, title: str) -> Outcome | None:
    """Refusals that need only the daemon's row: desktop scope, and the owner's hold."""
    if row.get("instance"):
        return Outcome(
            f"REFUSED (deterministic): '{title}' lives in the DESKTOP ({row['instance']}). "
            "Resuming it outside its app would fork the conversation behind the app's back. "
            "Desktop chats compact through their app's own autocompact.", 3)
    hold_why = holdlib.why_blocked(sid)
    if hold_why:
        return Outcome(f"REFUSED: {hold_why}", 6, extra={"held": True})
    return None


def locate_transcript_and_cwd(row: dict, title: str) -> tuple[Path | None, str | None, Outcome | None]:
    """The two filesystem facts a resume needs: a readable transcript and a cwd that
    still exists."""
    transcript = row.get("transcript_path") or ""
    tp = Path(transcript)
    if not transcript or not tp.exists():
        return None, None, Outcome(
            f"REFUSED (deterministic): '{title}' has no readable transcript at {transcript!r}", 3)
    cwd = row.get("cwd") or ""
    if not cwd or not Path(cwd).is_dir():
        return None, None, Outcome(
            f"REFUSED (deterministic): '{title}' worked in {cwd!r}, which no longer exists - "
            "a resume there cannot run", 3)
    return tp, cwd, None


def check_liveness(sid: str, title: str, tp: Path) -> Outcome | None:
    """Refuse a resume while the chat might still be working: a transcript touched too
    recently, or (review 2026-09-01) one whose engine is provably still alive even though
    it has been quiet - a session parked at its prompt, or inside a long tool call, writes
    nothing for minutes while its process lives, and a second `--resume` against a live
    session forks the transcript both then append to, the very thing imports refuse. The
    fleet has the pid-checked signal (migrate_chat refuses on it); ask it. Unknown never
    reads as "not live"."""
    quiet = time.time() - tp.stat().st_mtime
    if quiet < QUIET_SECS:
        return Outcome(
            f"REFUSED: '{title}' wrote to its transcript {int(quiet)}s ago - possibly mid-work. "
            f"Retry once it has been quiet {QUIET_SECS}s.", 4)
    try:
        live = hydralib.live_for(sid)
    except hydralib.DaemonError as err:
        return Outcome(
            f"compact FAILED: cannot tell whether '{title}' holds a live engine ({err}) - "
            "unknown never reads as 'not live'", 1)
    if live:
        return Outcome(
            f"REFUSED: '{title}' still holds a LIVE engine (pid {live.get('pid')}) even though "
            f"its transcript has been quiet {int(quiet)}s - a second --resume would fork it. "
            "Retry once the session has exited.", 4)
    return None


def check_capacity(sid: str) -> Outcome | None:
    """The two reasons a compact turn must wait rather than run: the breaker tripped for
    this session, or the machine-wide concurrency cap is full (a compact turn IS a running
    chat for its duration)."""
    brake = ledgerlib.check("compact", sid)
    if brake["suppressed"]:
        return Outcome(f"SUPPRESSED by the breaker: {brake['why']}", 5, extra={"breaker": brake})
    try:
        running = hydralib.running_count()
    except hydralib.DaemonError as err:
        return Outcome(
            f"compact FAILED: cannot count running chats ({err}) "
            "- an unknown count never reads as room under the cap", 1)
    if running >= hydralib.MAX_RUNNING_CHATS:
        return Outcome(
            f"REFUSED: {running} chat(s) already running - the machine-wide cap is "
            f"{hydralib.MAX_RUNNING_CHATS}. Transient; retry on a later cycle.", 4)
    return None


def resolve_runner_and_exe(runner) -> tuple[object, str, Outcome | None]:
    """THE EXECUTABLE IS THE REAL RUNNER'S DEPENDENCY, NOT THIS FUNCTION'S (2026-09-03). An
    INJECTED runner does not shell out to claude at all, so resolving the CLI before choosing
    the runner made the `runner=` seam only look injectable: on any machine without Claude
    Code installed, main() would exit 1 here and the injected runner would never be reached.
    That is every CI runner, and it turned three unit tests into a machine-state check - they
    passed on a developer box and could not pass on GitHub's, which is the kind of red that
    teaches people to ignore the build."""
    run = runner or run_turn
    exe = resolve_claude()
    if exe is None:
        if run is run_turn:
            return run, "", Outcome(
                "compact FAILED: no claude CLI found (set ORCHESTRATOR_CLAUDE_EXE)", 1)
        exe = ""  # an injected runner supplies its own; it is handed the empty string honestly
    return run, exe, None


def execute_turn(run, exe: str, sid: str, window: int, cwd: str, title: str,
                  before: int) -> tuple[str, Outcome | None]:
    """Record the attempt, then run the forced-autocompact turn. Returns the runner's raw
    stdout on success, or an Outcome describing why it did not get that far."""
    ledgerlib.note("compact", sid, note=f"'{title}' ~{before // 1000}k -> window {window // 1000}k")
    try:
        code, said = run(exe, sid, window, cwd)
    except subprocess.TimeoutExpired:
        return "", Outcome(
            f"compact turn TIMED OUT after {TURN_TIMEOUT_SECS}s - attempt recorded; the "
            "session may still be finishing, check it before retrying", 1)
    if code != 0:
        return "", Outcome(
            f"compact turn FAILED (claude exit {code}): {said.strip()[:300]} - attempt recorded", 1)
    return said, None


def verify_compaction(said: str, sid: str, tp: Path, before: int, title: str, window: int,
                       instance: str = "") -> Outcome:
    """Verify from the artifacts, not the exit code: the continued transcript must show a
    compact marker or a real shrink.

    MUTATION LEDGER: recorded `undoable=False` unconditionally - compaction is lossy BY
    DESIGN (module docstring), so even a verified compaction has no inverse: the discarded
    context cannot be reconstructed from the summary that replaced it. Recorded only when the
    turn actually ran and something (or nothing observable) resulted, never on an earlier
    refusal - a chat under --min or otherwise never touched leaves no row (see main())."""
    new_sid = sid
    try:
        payload = json.loads(said)
        new_sid = payload.get("session_id") or sid
    except json.JSONDecodeError:
        pass
    target = tp if new_sid == sid else tp.parent / f"{new_sid}.jsonl"
    marker = False
    if target.exists():
        try:
            with open(target, "rb") as f:
                size = target.stat().st_size
                if size > TAIL_BYTES:
                    f.seek(size - TAIL_BYTES)
                blob = f.read().decode("utf-8", errors="replace")
            marker = any(m in blob for m in COMPACT_MARKERS)
        except OSError:
            pass
    after = context_tokens(target) if target.exists() else None
    shrunk = after is not None and after < before * 0.6
    # "unknown" is not "0k": a tail with no readable usage stamp yet (normal right after a
    # compact boundary) must not print as a measured zero.
    after_txt = f"~{after // 1000}k" if after is not None else "unknown (no usage stamp yet)"

    if marker or shrunk:
        mutationlib.record(
            "compact", new_sid, instance=instance, title=str(title),
            before={"contextTokens": before}, after={"contextTokens": after}, undoable=False,
            why_not="compaction is lossy by design - the discarded context is summarized "
                    "away and cannot be reconstructed, so no inverse exists",
        )
        ledgerlib.clear("compact", sid)
        rolled = "" if new_sid == sid else f" (session id rolled to {new_sid})"
        return Outcome(
            f"COMPACTED and verified: '{title}' ~{before // 1000}k -> {after_txt} tokens{rolled}.",
            0, ok=True,
            extra={"compacted": True, "contextBefore": before, "contextAfter": after,
                   "sessionId": new_sid})
    return Outcome(
        f"the turn ran but NO compaction was observed: '{title}' measured "
        f"~{before // 1000}k before, {after_txt} after, window "
        f"{window // 1000}k, no compact marker. Attempt recorded - check the "
        "window against the context before retrying.",
        2, ok=False,
        extra={"compacted": False, "contextBefore": before, "contextAfter": after,
               "sessionId": new_sid})


def main(argv: list[str], runner=None) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json, window, floor, args = parse_args(argv)
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    try:
        rows = hydralib.sessions()
    except hydralib.DaemonError as err:
        return emit(Outcome(f"compact FAILED: {err}", 1), as_json)

    row, outcome = resolve_target_row(rows, args[0])
    if row is None:
        # THE SEVEN-DAY LIST IS A SEARCH, NOT A CENSUS (audit AH-07): a target older than the
        # window is still a real, compactable chat. Widen to the whole census once before
        # refusing, so an explicit id or title resolves however old it is.
        try:
            rows = hydralib.sessions_all()
        except hydralib.DaemonError as err:
            return emit(Outcome(f"compact FAILED: {err}", 1), as_json)
        row, outcome = resolve_target_row(rows, args[0])
    if outcome:
        return emit(outcome, as_json)
    sid = row.get("session_id") or ""
    title = row.get("title")

    outcome = check_session_eligible(row, sid, title)
    if outcome:
        return emit(outcome, as_json)

    tp, cwd, outcome = locate_transcript_and_cwd(row, title)
    if outcome:
        return emit(outcome, as_json)

    outcome = check_liveness(sid, title, tp)
    if outcome:
        return emit(outcome, as_json)

    before = context_tokens(tp)
    if before is None:
        return emit(Outcome(
            f"REFUSED (deterministic): '{title}' has no readable usage stamp - context size "
            "unknown, and unknown never reads as small", 3), as_json)
    if before < floor:
        return emit(Outcome(
            f"nothing to do: '{title}' is at ~{before // 1000}k tokens, under the --min floor "
            f"of {floor // 1000}k - a fresh chat is cheaper than a lossy compact",
            0, ok=True, extra={"compacted": False, "contextTokens": before}), as_json)

    outcome = check_capacity(sid)
    if outcome:
        return emit(outcome, as_json)

    run, exe, outcome = resolve_runner_and_exe(runner)
    if outcome:
        return emit(outcome, as_json)

    said, outcome = execute_turn(run, exe, sid, window, cwd, title, before)
    if outcome:
        return emit(outcome, as_json)

    return emit(verify_compaction(said, sid, tp, before, title, window,
                                   instance=str(row.get("instance") or "")), as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
