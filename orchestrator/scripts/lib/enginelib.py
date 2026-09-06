"""enginelib - stop an IDLE desktop engine deliberately, so a stopped chat can move.

THE PROBLEM IT CLOSES (live smoke, 2026-09-01): the desktop app keeps a chat's claude.exe
alive indefinitely after the turn ends - 12+ minutes idle after a one-word answer, and a
freshly landed chat boots one straight away. migrate_chat's rule 2 (the import rewrites the
transcript, so a live writer refuses, force included) is right, but read against that fact
it meant NO desktop chat could ever move or be archived unattended: every one of them has a
writer, forever. The owner's order draws the line elsewhere: "Never move active chats. Only
chats that are stopped, waiting, chilling." A chat that finished its turn and has sat quiet
for minutes is chilling. Its engine is not working; it is waiting.

So this module is the one place that turns "idle" into "stopped", on purpose, with the same
evidence the gate uses:

  - the gate must say the engine is alive AND idle (its newest record is a completed
    assistant turn, or a tool call that predates this engine - nothing is in flight);
  - it must have been quiet for at least IDLE_STOP_SECS (a long quiet can be background
    work; five minutes after a completed turn is not);
  - a STUCK or mid-turn engine is never touched - that is the owner's line, and killing it
    would lose work.

Then the process is stopped (taskkill, the whole tree) and the daemon's own liveness read is
polled until it no longer lists the chat, so the caller acts on a confirmed state, never on
the kill having been issued. The transcript is already flushed by then - the engine had
finished writing minutes earlier - which is why this is safe where killing a mid-turn engine
is not. The desktop simply shows the chat as not running, and the next instruction (or a
landing elsewhere) resumes it with a fresh engine.

Callers: migrate_chat --stop-idle (the sweep's move and land lanes pass it) and archive_chat.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time

from lib import clilib
from lib import gatelib
from lib import hydralib

# A completed turn followed by this much silence is a chat that is waiting, not working.
IDLE_STOP_SECS = 300
# THE FAST WINDOW (owner, 2026-09-04: a hand move "should have taken seconds, not minutes").
# The 300s above exists to tell "waiting" from "background work" by TIME, because that was
# the only signal. background_work() reads the signal itself - a background task the CLI
# launched and has not yet reported back - so a person's move (migrate_chat --now) of a
# chat with a finished turn and NO outstanding task needs only this much quiet: enough for
# the app to flush its last write, not five minutes of nothing. The unattended lanes never
# pass --now; an outstanding task keeps the standing window even for a person.
NOW_QUIET_SECS = 15
# How long to wait for the daemon to stop listing the chat as live after the kill.
STOP_CONFIRM_SECS = 20

# Reason codes - the machine half of `why`. A caller deciding what to do next must branch on
# these, NEVER on the prose: string-sniffing a refusal is how "STUCK, a person decides" ends
# up treated like "quiet for 40s, come back later".
#
# ⛔ ONLY R_TOO_SOON is satisfiable by waiting. Every other code is a refusal that more time
# cannot cure - R_WORKING may become idle eventually but the wait is unbounded, and R_STUCK
# is explicitly a person's call. Anything that loops on this enum must test for R_TOO_SOON
# by equality and let every other code fall straight through to the refusal.
R_NO_ENGINE = "no_engine"
R_UNREADABLE = "gate_unreadable"
R_UNGATEABLE = "ungateable"
R_NOT_RUNNING = "not_running"
R_STUCK = "stuck"
R_WORKING = "working"
R_TOO_SOON = "too_soon"
R_IDLE = "idle"


def usage_wall_notice(match: dict) -> str | None:
    """The limit notice the chat is parked on, or None. Reads the daemon's session row: its
    `limit_stop` is set only from the CLI's own error record, and `pending` means nothing
    followed it - the chat is still sitting at the wall. Any failure to read is None: an
    unknown is never a wall."""
    sid = match.get("cliSessionId") or match.get("sessionId") or ""
    if not sid:
        return None
    try:
        row = hydralib.session_row(sid) or {}
    except hydralib.DaemonError:
        return None
    stop = row.get("limit_stop") or {}
    if isinstance(stop, dict) and stop.get("pending"):
        return str(stop.get("notice") or "usage limit")
    return None


def idle_report(match: dict, min_quiet_secs: int = IDLE_STOP_SECS,
                idle_after_secs: int = gatelib.IDLE_AFTER_SECS) -> dict:
    """{idle, reason, why, quiet_secs, needs_secs}: may this engine be stopped right now?

    `match` is a resolved dossier match (hydralib.resolve_one) with its live block. Answers
    idle=False for anything the gate cannot read, anything mid-turn, anything stuck, and
    anything quiet for less than `min_quiet_secs` - `reason` says which, in one word a
    caller can branch on, and `needs_secs` is set ONLY on R_TOO_SOON, where the deficit is
    a real number of seconds rather than an open question.

    `idle_after_secs` is how long the gate waits before it even reads the tail (gatelib's
    180s by default). A chat quieter than that used to come back R_WORKING ("may be
    working"), which no wait could cure - so --idle-wait refused a 100s-quiet chat at once
    and the caller re-ran on a guess. The gate not having LOOKED yet is exactly the one
    refusal time cures, so it is R_TOO_SOON now, with the deficit spelled out."""
    def no(reason: str, why: str, **extra) -> dict:
        return {"idle": False, "reason": reason, "why": why,
                "quiet_secs": None, "needs_secs": None, **extra}

    live = match.get("live")
    if not live:
        return no(R_NO_ENGINE, "no engine is alive - nothing to stop")
    # A USAGE WALL NEEDS NO QUIET WINDOW (live, 2026-09-04): a chat that has hit its account's
    # limit is the one chat you most want to move, and the wall arrives as the transcript's
    # LAST record, so the engine is parked - it is not writing and cannot write until the
    # account resets. The quiet minimum exists to tell "waiting" from "background work";
    # that distinction does not exist behind a wall. Before this, moving such a chat meant
    # waiting out 180s for the gate to even read the tail and 300s more for this window - five
    # minutes of nothing for a chat whose state was already certain. The daemon's own
    # `limit_stop.pending` is the evidence (it trusts only the CLI's own error record, never
    # prose), so the read is one per-id GET; a failed read falls through to the gate.
    wall = usage_wall_notice(match)
    if wall:
        return {"idle": True, "reason": R_IDLE, "usage_wall": True,
                "why": f"idle: parked at a usage wall ({wall[:90]}) - it cannot write until the account resets",
                "quiet_secs": None, "needs_secs": 0}
    try:
        verdict = gatelib.gate_match(match, hydralib.session_row, idle_after_secs=idle_after_secs)
    except hydralib.DaemonError as err:
        return no(R_UNREADABLE, f"the gate could not read the chat ({err}) - not stopping blind")
    if verdict is None:
        return no(R_UNGATEABLE, "the transcript cannot be gated - not stopping blind")
    if verdict.get("state") != "running":
        return no(R_NOT_RUNNING,
                  f"the gate says {verdict.get('state')}, not a live engine - nothing to stop")
    if verdict.get("stalled"):
        return no(R_STUCK,
                  f"the engine looks STUCK, not idle ({verdict['stalled'].get('why', '')[:120]}) - a person decides")
    idle = verdict.get("idle")
    if not idle:
        gate_quiet = verdict.get("quiet_secs")
        if isinstance(gate_quiet, int) and gate_quiet < idle_after_secs:
            # The gate has not read the tail yet - nothing is known either way, and the
            # only thing missing is seconds. Waitable, with the deficit stated.
            return {"idle": False, "reason": R_TOO_SOON,
                    "why": f"quiet for only {gate_quiet}s - the gate reads the tail at "
                           f"{idle_after_secs}s; giving it time",
                    "quiet_secs": gate_quiet, "needs_secs": int(idle_after_secs)}
        return no(R_WORKING,
                  f"the engine is alive and may be working ({verdict.get('cause', '')[:140]})")
    quiet = int(idle.get("quiet_secs") or 0)
    if quiet < min_quiet_secs:
        return {"idle": False, "reason": R_TOO_SOON,
                "why": f"idle for only {quiet}s (needs {min_quiet_secs}s) - giving it time",
                "quiet_secs": quiet, "needs_secs": int(min_quiet_secs)}
    return {"idle": True, "reason": R_IDLE,
            "why": (f"idle: finished its turn and quiet {quiet}s"
                    + (" (pending call predates this engine)" if idle.get("orphaned_tool_call") else "")),
            "quiet_secs": quiet, "needs_secs": int(min_quiet_secs)}


def idle_verdict(match: dict, min_quiet_secs: int = IDLE_STOP_SECS) -> tuple[bool, str]:
    """(idle, why) - the long-standing 2-tuple shape, over idle_report's richer answer."""
    report = idle_report(match, min_quiet_secs)
    return report["idle"], report["why"]


def stop_idle_engine(match: dict, min_quiet_secs: int = IDLE_STOP_SECS,
                     idle_after_secs: int = gatelib.IDLE_AFTER_SECS) -> dict:
    """Stop the chat's idle engine and CONFIRM it is gone. Returns
    {stopped: bool, pid, why, reason, quiet_secs, needs_secs, confirmedSecs}. Never touches a
    working or stuck engine. `reason` is idle_report's code, so a caller can tell the one
    refusal that time cures (R_TOO_SOON) from every refusal that it does not."""
    report = idle_report(match, min_quiet_secs, idle_after_secs)
    idle, why = report["idle"], report["why"]
    pid = (match.get("live") or {}).get("pid")
    # The refusal carries the machine-readable reason and, on R_TOO_SOON, the exact deficit -
    # so a caller that is allowed to wait can sleep the right number of seconds instead of
    # guessing, and a caller that is not can still tell a stuck engine from a young one.
    refusal = {"stopped": False, "pid": pid, "why": why, "reason": report["reason"],
               "quiet_secs": report["quiet_secs"], "needs_secs": report["needs_secs"]}
    if not idle:
        return refusal
    try:
        clilib.run_text(["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                       timeout=30)
    except (OSError, ValueError, subprocess.TimeoutExpired) as err:
        return {**refusal, "why": f"taskkill failed: {err}"}
    sid = match.get("cliSessionId") or match.get("sessionId") or ""
    t0 = time.time()
    while time.time() - t0 < STOP_CONFIRM_SECS:
        try:
            if not hydralib.live_for(sid):
                return {**refusal, "stopped": True, "reason": R_IDLE, "why": why,
                        "confirmedSecs": round(time.time() - t0, 1)}
        except hydralib.DaemonError:
            pass  # a flaky read is not a confirmation either way - keep polling
        time.sleep(1)
    return {**refusal,
            "why": f"taskkill was issued for pid {pid} but the daemon still lists the chat as live "
                   f"after {STOP_CONFIRM_SECS}s - not proceeding on an unconfirmed stop"}


# --- background work: the signal the 300s window was standing in for ---------------------
#
# The CLI reports a backgrounded job in the tool_result it hands the model, and reports the
# job's end as a <task-notification> user record naming the same id. Three launch shapes are
# known (all measured from real transcripts, 2026-09-04):
#   "Command running in background with ID: b0439z7jg. Output is being written to ..."
#   "Command did not complete within its 120s timeout and was moved to the background (ID: bmm552lv7)."
#   "Workflow launched in background. Task ID: wjc1a4d2l"
# and the one end shape:
#   <task-notification>\n<task-id>bmm552lv7</task-id>\n...
# A launch with no later notification is work the engine is still waiting on - stopping it
# there loses the result. A launch the engine cannot parse an id out of is treated as
# outstanding forever (unknown is not "none").
_BG_LAUNCH_ID = re.compile(r"\bbackground\b.{0,80}?\b(?:Task ID|ID)\s*:\s*([A-Za-z0-9_-]{4,})",
                           re.IGNORECASE | re.DOTALL)
_BG_LAUNCH_WORD = re.compile(r"\b(?:running in|launched in|moved to the) background\b", re.IGNORECASE)
# A SUBAGENT started in the background is the fourth launch shape (measured 2026-09-04): its
# tool_result carries "agentId: a0178ab05b4bf4940 (internal ID ...)" and says the agent "is
# working"; its end arrives as the same <task-notification> with that hex id. A FINISHED
# foreground agent's result can carry an agentId too (for SendMessage), so the id alone is not a
# launch - only an id beside the still-working phrase is.
_BG_AGENT_ID = re.compile(r"\bagentId:\s*([A-Za-z0-9_-]{6,})")
_BG_AGENT_WORKING = re.compile(r"agent is (?:still )?working|will be notified|notified when", re.IGNORECASE)
_BG_NOTIFIED = re.compile(r"<task-notification>.{0,200}?<task-id>\s*([A-Za-z0-9_-]+)\s*</task-id>",
                          re.DOTALL)
# A transcript bigger than this is read from its tail only: a job launched megabytes ago and
# never reported is possible, but so is a scan that takes longer than the wait it replaces.
BG_SCAN_MAX_BYTES = 24 * 1024 * 1024


def _blocks_text(ev: dict) -> list[tuple[str, str]]:
    """(kind, text) for every content block that can carry a launch or a notification."""
    out: list[tuple[str, str]] = []
    msg = ev.get("message") if isinstance(ev.get("message"), dict) else None
    content = msg.get("content") if msg else None
    if isinstance(content, str):
        out.append(("text", content))
        return out
    for b in content if isinstance(content, list) else []:
        if not isinstance(b, dict):
            continue
        kind = str(b.get("type") or "")
        if kind == "tool_result":
            c = b.get("content")
            if isinstance(c, str):
                out.append(("tool_result", c))
            elif isinstance(c, list):
                out.append(("tool_result", " ".join(str(x.get("text") or "") for x in c
                                                    if isinstance(x, dict))))
        elif kind == "text":
            out.append(("text", str(b.get("text") or "")))
    return out


def _locate_transcript(match: dict, transcript_path: str | None) -> tuple[str | None, dict | None]:
    """Decide which transcript to scan, or hand back the scanned=False result if none exists."""
    if transcript_path is None:
        try:
            transcript_path = gatelib.transcript_for_match(match, hydralib.session_row)
        except hydralib.DaemonError as err:
            return None, {"scanned": False, "outstanding": [], "launched": 0, "notified": 0,
                    "why": f"could not locate the transcript ({err})"}
    if not transcript_path or not os.path.exists(transcript_path):
        return None, {"scanned": False, "outstanding": [], "launched": 0, "notified": 0,
                "why": "no transcript on disk to scan"}
    return transcript_path, None


def _record_background_event(ev: dict, engine_started, launched: dict, notified: set) -> int:
    """Fold one transcript event into launched/notified; returns 1 for an unparsed job, else 0."""
    unparsed = 0
    for kind, text in _blocks_text(ev):
        for nid in _BG_NOTIFIED.findall(text):
            notified.add(nid)
        if kind != "tool_result":
            continue
        is_job = bool(_BG_LAUNCH_WORD.search(text))
        is_agent = bool(_BG_AGENT_WORKING.search(text)) and bool(_BG_AGENT_ID.search(text))
        if not (is_job or is_agent):
            continue
        if gatelib._predates({"ts": ev.get("timestamp")}, engine_started):
            continue  # a job of a previous engine: dead, not outstanding
        ids = (_BG_LAUNCH_ID.findall(text) if is_job else []) + \
              (_BG_AGENT_ID.findall(text) if is_agent else [])
        if ids:
            for lid in ids:
                launched[lid] = True
        else:
            unparsed += 1
    return unparsed


def _summarize_background_scan(launched: dict, notified: set, unparsed: int) -> dict:
    """Turn collected launch/notify state into the scanned=True result, ids and prose alike."""
    outstanding = sorted(i for i in launched if i not in notified)
    if unparsed:
        outstanding.append(f"unparsed x{unparsed}")
    why = ("no background job outstanding" if not outstanding else
           f"{len(outstanding)} background job(s) launched and not yet reported back: "
           + ", ".join(outstanding[:5]))
    return {"scanned": True, "outstanding": outstanding, "launched": len(launched),
            "notified": len(notified), "why": why}


def background_work(match: dict, transcript_path: str | None = None) -> dict:
    """Is this chat's engine waiting on a background job it launched?

    Returns {scanned, outstanding: [ids], launched, notified, why}. `scanned` False means the
    transcript could not be read at all - a caller must then keep the standing window, never
    treat it as "no background work". Launches recorded BEFORE the live engine started are
    dead (a resume boots a fresh process; the old jobs' notifications will never arrive) and
    are not counted, the same rule gatelib applies to a pending tool call."""
    transcript_path, early_result = _locate_transcript(match, transcript_path)
    if early_result is not None:
        return early_result
    live = match.get("live") or {}
    engine_started = gatelib._epoch_s(live.get("startedAt") or live.get("startedAtMs"))
    launched: dict[str, bool] = {}   # id -> still outstanding
    unparsed = 0
    notified: set[str] = set()
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, "rb") as f:
            if size > BG_SCAN_MAX_BYTES:
                f.seek(size - BG_SCAN_MAX_BYTES)
                f.readline()  # drop the partial first line
            for raw in f:
                if b"background" not in raw and b"task-notification" not in raw and b"agentId:" not in raw:
                    continue
                try:
                    ev = json.loads(raw.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    continue
                if not isinstance(ev, dict) or ev.get("isSidechain") is True:
                    continue
                unparsed += _record_background_event(ev, engine_started, launched, notified)
    except OSError as err:
        return {"scanned": False, "outstanding": [], "launched": 0, "notified": 0,
                "why": f"transcript unreadable ({err})"}
    return _summarize_background_scan(launched, notified, unparsed)
