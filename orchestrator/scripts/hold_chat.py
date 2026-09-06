#!/usr/bin/env python3
"""hold_chat.py - ACT (state only): mark a chat hands-off for the unattended machinery.

A hold is the owner's "I am working this one, leave it alone" switch. It outranks every gate
verdict and the breaker, demands a reason, keeps the chat visible everywhere, and never
blocks a deed a person asks for directly (act scripts still obey --force).

Usage: python hold_chat.py <title fragment | session id> --reason "why" [--hours N] [--json]
       python hold_chat.py <title fragment | session id> --release [--json]
       python hold_chat.py --list [--json]
Exit:  0 done - 3 not resolvable (deterministic) or bad usage - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import clilib, holdlib
from lib import hydralib
from lib import mutationlib


def _parse_hold_flags(argv: list[str]) -> tuple[str | None, float | None, list[str]]:
    """Decides --reason's value, --hours' value, and which argv entries are positional args."""
    reason = None
    hours = None
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--reason" and i + 1 < len(argv):
            reason = argv[i + 1]
            i += 2
            continue
        if a == "--hours" and i + 1 < len(argv):
            hours = float(argv[i + 1])
            i += 2
            continue
        if not a.startswith("--"):
            args.append(a)
        i += 1
    return reason, hours, args


def _print_held_list(as_json: bool) -> None:
    """Decides whether to print the held list as json, empty-state text, or a summary."""
    rows = holdlib.held()
    if as_json:
        print(json.dumps({"holds": rows}, indent=2))
    elif not rows:
        print("no chat is held - the machinery may act on anything its gate allows")
    else:
        print(f"{len(rows)} chat(s) HELD (the unattended machinery leaves these alone):")
        for r in rows:
            print(f"  {r['session']}")
            print(f"    {holdlib.why_blocked(r['session'])}")


def _release_hold(match: dict, sid: str, instance: str, as_json: bool) -> int:
    """Decides whether a release actually lifted a hold, and records/prints the outcome."""
    # MUTATION LEDGER: the before-image is the hold entry that is about to be lifted,
    # read immediately before release() acts - captured here rather than trusting the
    # bool release() returns, because release() itself prunes-and-saves and the entry it
    # is about to drop is not handed back.
    title = match.get("title")
    before_entry = holdlib.check(sid)
    was = holdlib.release(sid)
    if was and before_entry:
        mutationlib.record("release", sid, instance=instance, title=str(title),
                           before=before_entry, after=None, undoable=True)
    msg = (f"released: '{title}' is back under the machinery's care"
           if was else f"nothing to do: '{title}' was not held")
    print(json.dumps({"released": was, "sessionId": sid, "report": msg}, indent=2) if as_json else msg)
    return 0


def _apply_hold(match: dict, sid: str, instance: str, reason: str, hours: float | None,
                 as_json: bool) -> int:
    """Decides the hold's expiry, then records and prints the newly-applied hold."""
    title = match.get("title")
    # Before-image: whatever hold (if any) already covered this chat - a fresh hold overwrites
    # it, so undo (release) restores "unheld", never a prior hold this call did not know about.
    before_entry = holdlib.check(sid)
    until = int((time.time() + hours * 3600) * 1000) if hours else None
    entry = holdlib.hold(sid, reason, until_ms=until)
    mutationlib.record("hold", sid, instance=instance, title=str(title),
                       before=before_entry or {}, after=entry, undoable=True)
    msg = f"HELD: '{title}' - {holdlib.why_blocked(sid)}"
    print(json.dumps({"held": True, "entry": entry, "report": msg}, indent=2) if as_json else msg)
    return 0


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    do_list = "--list" in argv
    do_release = "--release" in argv
    reason, hours, args = _parse_hold_flags(argv)

    if do_list:
        _print_held_list(as_json)
        return 0

    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        match = hydralib.resolve_one(args[0])
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        print(f"REFUSED (deterministic): {err}", file=sys.stderr)
        return 3
    except hydralib.DaemonError as err:
        print(f"hold FAILED: {err}", file=sys.stderr)
        return 1
    sid = match.get("cliSessionId") or ""
    instance = str(match.get("instance") or "")

    if do_release:
        return _release_hold(match, sid, instance, as_json)

    if not reason:
        print("a hold DEMANDS a reason: --reason \"why this chat is hands-off\"", file=sys.stderr)
        return 3
    return _apply_hold(match, sid, instance, reason, hours, as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
