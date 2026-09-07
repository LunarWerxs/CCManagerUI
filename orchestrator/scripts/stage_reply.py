#!/usr/bin/env python3
"""stage_reply.py - ACT (state only): write down a reply for one chat. SENDS NOTHING.

This is where an AI's judgment becomes a record. The toolbox decides mechanically and hands
the waiting chats to an AI (the judgment queue); the AI reads one, decides what to say, and
stages it here. `courier.py` is what actually types it, later, as a separate deliberate act.

The staged reply carries the EVIDENCE it was based on - the chat's own last words, pulled
from the gate - so the courier can prove at send time that it is looking at the right chat,
and so a person reviewing the queue can see what the AI was answering.

Usage: python stage_reply.py <title fragment | session id> --text "the reply" [--by name] [--json]
       python stage_reply.py --list [--json]
       python stage_reply.py --cancel <delivery id> [--json]
Exit:  0 staged/listed/cancelled - 3 not resolvable or bad usage - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from lib import clilib, deliverylib
from lib import gatelib
from lib import hydralib


_TAIL_BYTES = 400_000


@dataclass
class _ParsedArgs:
    """The result of splitting argv into flags and the one positional target."""

    as_json: bool = False
    text: str | None = None
    by: str | None = None
    cancel_id: str | None = None
    do_list: bool = False
    positional: list[str] = field(default_factory=list)


def last_rendered_text(sid: str) -> str:
    """The chat's most recent rendered words, read straight from its own transcript.

    ⛔ THE GAP THIS FILLS, and it is the whole reason stalled chats were unrecoverable
    (found live 2026-09-01, on a chat frozen for seven hours): the gate reports
    `last_assistant_text` only for a FINISHED or IDLE chat. One that froze mid-tool is
    NEITHER - it still reads as 'running' - so the gate hands back nothing, the verify
    snippet comes out empty, and the courier refuses to type. The one class of chat that
    most needs waking was therefore the single class that could never be woken, and the
    refusal looked like a working safety rail rather than a dead end.

    This widens where the evidence COMES FROM; it does not weaken what the courier
    demands. The text sitting above a stuck tool call is still the last thing rendered in
    that pane, so it proves identity exactly as well as a finished turn's last line.
    """
    row = hydralib.session_row(sid) or {}
    tp = row.get("transcript_path")
    if not tp:
        # The same disk lookup the GATE got (gatelib.find_transcript_on_disk). Adding it
        # there and not here left the two halves disagreeing: a chat could be gated fine
        # from its on-disk transcript and still produce no verify snippet, so it stayed
        # unwakeable for the very reason that had just been fixed.
        tp = gatelib.find_transcript_on_disk(sid)
    if not tp:
        return ""
    try:
        p = Path(tp)
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > _TAIL_BYTES:
                f.seek(size - _TAIL_BYTES)
                f.readline()
            raw = f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
    for line in reversed(raw.splitlines()):
        if '"text"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "assistant":
            continue
        content = ((rec.get("message") or {}).get("content"))
        if not isinstance(content, list):
            continue
        texts = [b.get("text") for b in content
                 if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
        if not texts:
            continue
        joined = "\n".join(texts)
        # ⛔ A TURN THAT IS ONLY THE APP'S LIMIT BANNER IS NOT WORDS TO IDENTIFY A CHAT BY, AND
        # STOPPING ON ONE MADE WALLED CHATS UNWAKEABLE (found live 2026-09-06, on two chats
        # moved off an account that had hit its 5-hour cap). A chat killed by a usage wall ends
        # with exactly one assistant record - "You've hit your session limit - resets 10pm" -
        # which every walled chat on that account renders identically. deliverylib rightly
        # refuses it as a verify snippet, so the evidence collapsed to nothing, the courier
        # refused to type, and the actuator died on an empty -VerifyText. The class of chat
        # that most needs waking was, again, the one class that could not be woken.
        #
        # The guard is not weakened: the banner is still never used as proof. We simply keep
        # walking BACK to the last thing the chat actually said, which is on screen above it.
        if deliverylib.is_limit_banner(joined):
            continue
        return joined
    return ""


def _parse_argv(argv: list[str]) -> _ParsedArgs:
    """Split argv into the known flags plus whatever positional args are left over."""
    parsed = _ParsedArgs(as_json="--json" in argv, do_list="--list" in argv)
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--text" and i + 1 < len(argv):
            parsed.text = argv[i + 1]
            i += 2
            continue
        if a == "--by" and i + 1 < len(argv):
            parsed.by = argv[i + 1]
            i += 2
            continue
        if a == "--cancel" and i + 1 < len(argv):
            parsed.cancel_id = argv[i + 1]
            i += 2
            continue
        if not a.startswith("--"):
            parsed.positional.append(a)
        i += 1
    return parsed


def _run_list(as_json: bool) -> int:
    """Print every staged/delivered/failed/cancelled delivery row."""
    rows = deliverylib.all_rows()
    if as_json:
        print(json.dumps({"deliveries": rows}, indent=2))
    elif not rows:
        print("nothing staged - the courier has nothing to deliver")
    else:
        for r in rows:
            mark = {"staged": "·", "delivered": "✓", "failed": "✗", "cancelled": "-"}.get(r["state"], "?")
            print(f"  {mark} [{r['state']}] {r['id']}  {r.get('title') or r['session']}")
            print(f"      {r['text'][:100]}")
            if r.get("lastError"):
                print(f"      last error: {r['lastError'][:120]}")
    return 0


def _run_cancel(cancel_id: str, as_json: bool) -> int:
    """Cancel one staged delivery by id, reporting InFlight as a refusal rather than an error."""
    try:
        row = deliverylib.cancel(cancel_id)
    except deliverylib.InFlight as err:
        # Too late, and said so: a courier run has claimed it and may be typing it now.
        msg = f"NOT cancelled: {err}"
        print(json.dumps({"cancelled": False, "report": msg}, indent=2) if as_json else msg)
        return 3
    msg = (f"cancelled {cancel_id}" if row
           else f"nothing to cancel: {cancel_id} is not a staged reply")
    print(json.dumps({"cancelled": bool(row), "report": msg}, indent=2) if as_json else msg)
    return 0 if row else 3


def _resolve_target(query: str) -> tuple[dict | None, int]:
    """Resolve the CLI's chat argument to a match dict, or an exit code on failure."""
    try:
        return hydralib.resolve_one(query), 0
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        print(f"REFUSED (deterministic): {err}", file=sys.stderr)
        return None, 3
    except hydralib.DaemonError as err:
        print(f"stage FAILED: {err}", file=sys.stderr)
        return None, 1


def _gather_evidence(match: dict, sid: str) -> str:
    """What this chat actually last said, pulled from the gate rather than typed by hand,
    so the verify snippet provably comes from THIS chat. Falls back to the raw transcript
    for a chat mid-turn or stalled (see last_rendered_text)."""
    verdict = gatelib.gate_match(match, hydralib.session_row)
    evidence = ""
    if verdict:
        src = verdict.get("finished") or verdict.get("idle") or {}
        evidence = src.get("last_assistant_text") or ""
    # ⛔ THE GATE'S ANSWER IS NOT AUTOMATICALLY USABLE EVIDENCE. For a chat stopped by a usage
    # wall the gate reports the app's own limit banner as `last_assistant_text` - it IS the
    # last assistant text, honestly - but deliverylib refuses it as proof of identity, because
    # every walled chat on that account shows the same line. Non-empty-but-unusable then beat
    # the transcript fallback to the punch and the chat could not be woken at all. Treat a
    # banner-only answer as no answer and walk the transcript for what the chat really said.
    if not evidence or deliverylib.is_limit_banner(evidence):
        evidence = last_rendered_text(sid) or evidence
    return evidence


def _run_stage(query: str, text: str, by: str | None, as_json: bool) -> int:
    """Resolve the target chat, gather its evidence, and stage the reply against it."""
    match, code = _resolve_target(query)
    if match is None:
        return code

    sid = match.get("cliSessionId") or ""
    evidence = _gather_evidence(match, sid)

    entry = deliverylib.stage(
        sid, text, title=match.get("title") or "", instance=match.get("instance") or "",
        evidence=evidence, by=by or "ai",
    )
    msg = (f"staged {entry['id']} for '{entry['title']}' ({entry['instance']}):\n"
           f"  {entry['text'][:160]}\n"
           f"  verify snippet: {entry['verifyText'][:80] or '(none - the courier will refuse)'}\n"
           "  Nothing sent. Deliver with: python scripts/courier.py --yes")
    print(json.dumps({"staged": entry, "report": msg}, indent=2) if as_json else msg)
    if not entry["verifyText"]:
        print("\n⚠ no verify snippet could be derived from this chat's last words - the courier "
              "refuses to type without one, because it is what proves the right chat. Re-run "
              "after the chat has said something, or stage against a chat with a readable tail.",
              file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    parsed = _parse_argv(argv)

    if parsed.do_list:
        return _run_list(parsed.as_json)

    if parsed.cancel_id:
        return _run_cancel(parsed.cancel_id, parsed.as_json)

    if len(parsed.positional) != 1 or not parsed.text:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    return _run_stage(parsed.positional[0], parsed.text, parsed.by, parsed.as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
