#!/usr/bin/env python3
"""chats.py - OBSERVE (+`--move-to`): every chat, which ACCOUNT it lives in, and move them.

The one place to answer "what have I got, and where is it?" - every chat with its instance,
the account (email + plan) behind that instance, whether its app is open, whether it is
archived, and how long since it moved. Then move any of them to another account without
looking up ids by hand.

Moving goes through migrate_chat.py's own rails, one chat at a time: holds, the live-writer
refusal, the naming door, the breaker, and the verified landing all still apply. A move is
never silent and never bulk-forced - there is deliberately NO --force here, because --force
is a person's word for ONE act (it also overrides a hold), and a batch flag would spend that
one word on every chat a substring happened to select. Held chats are moved one at a time
through migrate_chat.py, on purpose.

--idle-wait N is forwarded to each child: a desktop chat whose engine finished its turn but
has not been quiet the required 5 minutes is waited out rather than refused. It never waits
on a working or stuck engine. Default 0 - a wait is a separate word from an act, so --yes
does not imply it.

Usage:
  python chats.py                                  # every visible chat, grouped by account
  python chats.py --all                            # include archived
  python chats.py --account someone@example.com    # only that account's chats
  python chats.py --instance temp2                 # only that instance
  python chats.py --search "rolodexter"            # title contains
  python chats.py --console                        # only console-only (no desktop home)
  python chats.py --json

  python chats.py --search "rolodexter" --move-to 5claude          # PLAN the move
  python chats.py --search "rolodexter" --move-to 5claude --yes    # do it
  python chats.py --instance temp2 --move-to work --yes --max 3    # move a few at a time
  python chats.py --instance work --move-to 11 --yes --idle-wait 330   # wait out young engines
  python chats.py --instance temp2 --move-to work --yes --archived  # ALSO move archived ones

A MOVE TOUCHES UNARCHIVED CHATS ONLY, always, unless --archived says otherwise (owner,
Michael, 2026-09-05). --all is a LISTING word and widens only what you SEE; --archived is
the separate word that widens what a batch MOVES. Archived rows held back by that default
are named in the plan, never silently dropped.

Exit:  0 listed, or every attempted move landed AND left no twin behind on the source
       account - 2 some moves were refused, did not land, or landed with the source row
       still visible (a landing is not a move until the old row is gone)
       - 3 bad usage / unknown target - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass

from lib import clilib
from lib import hydralib


def account_names() -> dict[str, str]:
    """instance dir name -> the account's DISPLAY name ("Michael"), for matching by hand.

    The fleet's account block carries only an email, but people say "the Michael account", so
    `--account Michael` has to work. The names live in the usage survey, which this reads FROM
    ITS CACHE ON DISK - never a fresh survey. A listing must not fire off account checks to
    render, and a missing or stale cache degrades to matching on email alone rather than
    failing: this is a convenience for the filter, never a fact anything else depends on.
    """
    out: dict[str, str] = {}
    try:
        import json as _json
        from pathlib import Path as _Path
        raw = _json.loads((_Path(__file__).resolve().parent.parent / "state"
                           / "usage-survey.json").read_text(encoding="utf-8"))
        for row in (raw.get("survey") or {}).get("rows") or []:
            label = str(((row.get("result") or {}).get("snapshot") or {}).get("account") or "")
            name = label.split("<")[0].strip()
            key = str(row.get("id") or "").rstrip("\\/").split("\\")[-1].split("/")[-1].lower()
            if key and name:
                out[key] = name
    except Exception:  # noqa: BLE001 - the cache is an optional convenience, never a dependency
        pass
    return out


def collect(include_archived: bool, account: str | None, instance: str | None,
            search: str | None, console_only: bool) -> list[dict]:
    by_inst = hydralib.instances_by_name()
    names = account_names()
    rows = []
    # THE COMPLETE QUESTION, NOT THE LANE'S WINDOW (2026-09-05). This script's whole claim is
    # "the one place to answer what have I got, and where is it?", and a windowed answer
    # cannot make that claim: hydralib.sessions()'s default 7d window returned 21 rows the
    # day this was measured against 500 for all+archived, hiding six UNARCHIVED chats - one
    # of them live, with an engine running, active that morning. A whole-account sweep read
    # that as "no chats match" and reported the account drained while a live chat sat in it.
    # So enumerate everything and let the include_archived filter below do the choosing: the
    # filter is this script's own decision, and it can only be honest about rows it was shown.
    for r in hydralib.sessions(period="all", archived="include"):
        if r.get("archived") and not include_archived:
            continue
        inst_name = r.get("instance")
        acct = by_inst.get(str(inst_name or "").lower(), {})
        row = {
            "sessionId": r.get("session_id"),
            "title": r.get("title"),
            "instance": inst_name,
            "origin": "desktop" if inst_name else "console",
            "email": acct.get("email"),
            "accountName": names.get(str(inst_name or "").lower()),
            "plan": acct.get("plan"),
            "appRunning": acct.get("isRunning", False),
            "archived": bool(r.get("archived")),
            "lastActivityAt": r.get("last_activity_at"),
            "cwd": r.get("cwd"),
        }
        if console_only and row["origin"] != "console":
            continue
        # SUBSTRING, NOT EXACT (2026-09-02). `--account` used to demand the whole email, so
        # `--account Michael` - the name a person actually uses - returned "no chats match",
        # which is the SAME output as an account that genuinely has none. A filter typo and a
        # clean account were indistinguishable, and the false "that account is empty" is the
        # dangerous half. Matching the display name too costs nothing and removes the trap;
        # main() then says outright when a filter matched no account at all.
        if account and account.lower() not in (f"{row['email'] or ''} {row['accountName'] or ''}").lower():
            continue
        if instance and instance.lower() not in str(row["instance"] or "").lower():
            continue
        if search and search.lower() not in str(row["title"] or "").lower():
            continue
        rows.append(row)
    rows.sort(key=lambda r: (str(r["email"] or "~console"), -(r["lastActivityAt"] or 0)))
    return rows


def _ago(ms: int | None) -> str:
    if not ms:
        return "-"
    s = max(0, time.time() - ms / 1000)
    if s < 3600:
        return f"{int(s // 60)}m"
    if s < 86400:
        return f"{s / 3600:.1f}h"
    return f"{int(s // 86400)}d"


def render(rows: list[dict]) -> str:
    if not rows:
        return "no chats match."
    L = []
    groups: dict[str, list[dict]] = {}
    for r in rows:
        key = f"{r['email'] or '(console-only - no desktop home)'}"
        groups.setdefault(key, []).append(r)
    for email, chats in groups.items():
        inst = chats[0]["instance"]
        plan = chats[0]["plan"]
        running = " 🟢 open" if chats[0]["appRunning"] else (" ◦ closed" if inst else "")
        head = f"{email}" + (f"  [{inst}, {plan}{running}]" if inst else "")
        L.append(f"\n{head}   ({len(chats)} chat(s))")
        for c in chats:
            mark = "🗄" if c["archived"] else "  "
            L.append(f"  {mark} {_ago(c['lastActivityAt']):>5}  {str(c['title'] or '(untitled)')[:64]}")
            L.append(f"          {c['sessionId']}")
    L.append(f"\n{len(rows)} chat(s) across {len(groups)} account(s)/lane(s)")
    return "\n".join(L)


def move(rows: list[dict], target: str, act: bool, cap: int, idle_wait: int = 0,
         move_archived: bool = False) -> dict:
    import migrate_chat

    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        return {"error": str(err), "results": []}
    tgt = hydralib.resolve_instance(fleet, target)
    if tgt is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        return {"error": f"unknown target {target!r}. Known: {known}", "results": []}

    # ⛔ A MOVE TOUCHES UNARCHIVED CHATS ONLY (owner, Michael, 2026-09-05: "when I tell you to
    # move, only move UN archived chats. Not archived ones. Make sure that's the default.
    # Unless asked"). --all is a LISTING word: it widens what you can SEE, and before this it
    # silently widened what a batch would MOVE too. That matters far more than it sounds:
    # isArchived is Claude Desktop's RESTING state ("not on screen"), carried by 2,598 of
    # 2,611 chats when it was measured, so it is the MAJORITY of an account, not a tail.
    # `--all --move-to X --yes` therefore meant "move everything that ever existed here" -
    # on the real fleet the day this landed, 26 archived rows against 0 live ones.
    # --archived is the separate, deliberate word, exactly as --force is the word for a hold.
    # Skipped rows are NAMED in the plan, never dropped in silence: a chat that did not move
    # must never look like a chat that was not there.
    archived_skipped = [] if move_archived else [r for r in rows if r.get("archived")]
    eligible = rows if move_archived else [r for r in rows if not r.get("archived")]
    movable = [r for r in eligible
               if str(r["instance"] or "").lower() != str(tgt.get("name") or "").lower()]
    planned = movable[:cap]
    results = []
    if act:
        for r in planned:
            # --stop-idle, like the sweep's move and land lanes (migrate_chat's own manual says
            # they pass it, and this path did not - so moving any desktop chat by hand was
            # refused for "live engine" on an engine that had plainly finished, and the caller
            # had to drop down to migrate_chat.py to do the very thing this flag is for. It
            # only ever stops an engine the gate calls SAFELY IDLE; a working or stuck one
            # still refuses, and a live writer is never overridden.)
            argv_child = [r["sessionId"], "--to", str(tgt.get("name")), "--stop-idle", "--json"]
            if idle_wait:
                argv_child += ["--idle-wait", str(idle_wait)]
            # The child enforces the same archived default independently (it is reachable
            # directly, and through the MCP, without ever passing through this loop). So an
            # --archived batch has to SAY so downstream, or every row it deliberately selected
            # would come back as exit 7 and the flag would look broken rather than forwarded.
            if move_archived:
                argv_child += ["--archived"]
            code, out = clilib.capture(migrate_chat.main, argv_child)
            # Read the child's PAYLOAD, never infer the outcome from the exit code alone:
            # migrate_chat also exits 0 for "nothing to do, it already lives there", which is
            # a no-op, not a landing. `landed` is the only field that means the chat moved.
            try:
                pay = json.loads(out) if out else {}
            except (ValueError, TypeError):
                pay = {}
            landed = bool(pay.get("landed"))
            # ⛔ A MOVE IS A MOVE, AND A BATCH MUST NOT ROUND IT UP (live, 2026-09-04): nine
            # chats landed, every one left its source row visible, migrate_chat said so nine
            # times in its report - and this loop printed nine ticks, because it read only
            # `landed`. The operator believed a clean move and found the duplicates later.
            # A twin is a FAILED move here, exit code included.
            twin = landed and str(pay.get("sourceRow") or "") == "visible"
            results.append({
                "sessionId": r["sessionId"], "title": r["title"], "from": r["instance"],
                "exit": code, "ok": code == 0 and not twin, "landed": landed,
                "sourceRow": pay.get("sourceRow"),
                "stopReason": pay.get("stopReason"),
                "secs": pay.get("secs"),
                "timings": pay.get("timings"),
                "outcome": ("landed BUT the source row is still visible - a twin" if twin else
                            "landed and verified" if landed else
                            "already there (no-op)" if code == 0 else
                            "deterministic refusal" if code == 3 else
                            "live writer - never moved" if code == 4 else
                            "breaker - clear it and retry" if code == 5 else
                            "HELD by a person" if code == 6 else f"failed (exit {code})"),
                # The report carries the remedy (the breaker prints the exact attempts.py
                # line to clear it); a 160-char truncation cut it off and left the operator
                # with the bare word "breaker" and nowhere to go.
                "detail": (pay.get("report") or out or "").strip()[:600],
            })
    return {
        "target": {"instance": tgt.get("name"), "num": tgt.get("num"),
                   "isRunning": bool(tgt.get("isRunning")),
                   "email": (tgt.get("account") or {}).get("email")},
        "planned": [{"sessionId": r["sessionId"], "title": r["title"], "from": r["instance"]}
                    for r in planned],
        # COUNTED OFF `eligible`, NEVER `rows`: with the archived rows filtered out above,
        # len(rows) - len(movable) would fold every skipped archived chat into "already at
        # the target" - a count that reads as reassurance for chats that were refused. The
        # two reasons a row did not move are reported separately, because they are separate.
        "alreadyThere": len(eligible) - len(movable),
        "archivedSkipped": [{"sessionId": r["sessionId"], "title": r["title"],
                             "from": r["instance"]} for r in archived_skipped],
        "overCap": max(0, len(movable) - len(planned)),
        "results": results,
    }


_STRING_FLAGS = {"--account": "account", "--instance": "instance",
                  "--search": "search", "--move-to": "move_to"}
_NUMERIC_FLAGS = {"--max": "cap", "--idle-wait": "idle_wait"}


class _ArgError(Exception):
    """Raised once the usage/value error has already been printed; carries the exit code."""

    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class ChatArgs:
    as_json: bool
    act: bool
    include_archived: bool
    console_only: bool
    account: str | None
    instance: str | None
    search: str | None
    move_to: str | None
    cap: int
    idle_wait: int
    move_archived: bool = False   # --archived: include archived chats in a --move-to batch


def _take_string_flag(argv: list[str], i: int) -> tuple[str, str] | None:
    """If argv[i] names one of the string flags, return (field, value); else None."""
    field = _STRING_FLAGS.get(argv[i])
    if field is None:
        return None
    if i + 1 >= len(argv):
        print(__doc__.strip(), file=sys.stderr)
        raise _ArgError(3)
    return field, argv[i + 1]


def _take_numeric_flag(argv: list[str], i: int) -> tuple[str, int] | None:
    """If argv[i] is --max/--idle-wait, return (field, value); else None.

    Both take a NUMBER, and every way of getting that wrong used to be silent or fatal in
    the wrong direction: a trailing "--max" was dropped and the run proceeded on the default
    cap, "--max -1" sliced [: -1] and moved all but the last chat, and "--max abc" raised
    ValueError as a traceback instead of the documented exit 3. A flag that decides HOW MANY
    CHATS MOVE must never fail open.
    """
    flag = argv[i]
    field = _NUMERIC_FLAGS.get(flag)
    if field is None:
        return None
    if i + 1 >= len(argv):
        print(__doc__.strip(), file=sys.stderr)
        raise _ArgError(3)
    raw = argv[i + 1]
    try:
        val = int(raw)
    except ValueError:
        print(f"{flag} needs a whole number, got {raw!r}", file=sys.stderr)
        raise _ArgError(3) from None
    if val < 0:
        print(f"{flag} cannot be negative", file=sys.stderr)
        raise _ArgError(3)
    return field, val


def _parse_args(argv: list[str]) -> ChatArgs:
    """Walk argv once, filling in the value flags; unknown tokens are simply skipped."""
    fields: dict[str, object] = {"account": None, "instance": None, "search": None,
                                  "move_to": None, "cap": 10, "idle_wait": 0}
    i = 0
    while i < len(argv):
        taken = _take_string_flag(argv, i) or _take_numeric_flag(argv, i)
        if taken is None:
            i += 1
            continue
        field, value = taken
        fields[field] = value
        i += 2
    return ChatArgs(
        as_json="--json" in argv, act="--yes" in argv,
        include_archived="--all" in argv, console_only="--console" in argv,
        account=fields["account"], instance=fields["instance"], search=fields["search"],
        move_to=fields["move_to"], cap=fields["cap"], idle_wait=fields["idle_wait"],
        move_archived="--archived" in argv,
    )


def _diagnose_empty_account_filter(account: str, include_archived: bool) -> int | None:
    """--account matched zero rows: tell "no such account" apart from "account is empty"
    apart from "couldn't tell" (fleet unreachable - that case returns None to fall through
    to the normal empty-result handling).

    Built from the FLEET, not from the rows: an account with zero chats is absent from the
    rows, so checking against those would report a real, currently-empty account as
    "unknown" - swapping one wrong answer for another. Three outcomes, kept distinct.
    """
    names = account_names()
    known: dict[str, str] = {}
    try:
        for iname, acct in hydralib.instances_by_name().items():
            known[iname] = f"{names.get(iname) or ''} {acct.get('email') or ''}".strip()
    except hydralib.DaemonError:
        known = {}
    hit = [v for v in known.values() if v and account.lower() in v.lower()]
    if known and not hit:
        print(f"no ACCOUNT matches {account!r} - nothing matched the filter, which is NOT the "
              "same as an account with no chats. Known: "
              + ", ".join(sorted({v for v in known.values() if v})), file=sys.stderr)
        return 3
    if hit:
        print(f"{', '.join(sorted(set(hit)))} - matched, and it holds NO chats"
              + ("" if include_archived else " (archived ones are hidden; --all includes them)")
              + ".")
        return 0
    return None


def _refuse_no_match(search: str | None, instance: str | None, account: str | None,
                      console_only: bool) -> int:
    """A FILTER THAT MATCHED NOTHING MUST NOT EXIT 0 ON THE MOVE PATH: `--search "typo"
    --move-to work --yes` must not move nothing and report success - indistinguishable from
    "everything was already there".
    """
    picked = ", ".join(f"{k}={v!r}" for k, v in (("--search", search), ("--instance", instance),
                                                 ("--account", account),
                                                 ("--console", console_only or None)) if v)
    print(f"REFUSED: no chat matched {picked or 'the current filters'} - nothing to move.",
          file=sys.stderr)
    return 3


def _landed_ids(plan: dict, act: bool) -> set[str] | None:
    """sessionIds that actually moved, or None when this was a plan-only (dry) run."""
    return {r["sessionId"] for r in plan["results"] if r.get("landed")} if act else None


def _print_move_headline(plan: dict, act: bool, landed_ids: set[str] | None) -> None:
    t = plan["target"]
    state = "OPEN" if t["isRunning"] else "CLOSED - it would need opening first"
    print(f"target: {t['instance']} ({t['email']}) - {state}")
    # THE HEADLINE COUNTS WHAT LANDED, NOT WHAT WAS PLANNED. `planned` is fixed before a
    # single child runs, so printing it in the past tense produced the literal line
    # "3 chat(s) moved" above three refusals with nothing moved - a false green of exactly
    # the kind this toolbox exists to refuse.
    n = len(landed_ids) if act else len(plan["planned"])
    print(f"{n} chat(s) {'landed' if act else 'would move'}"
          + (f" of {len(plan['planned'])} attempted" if act and n != len(plan["planned"]) else "")
          + (f", {plan['alreadyThere']} already there" if plan["alreadyThere"] else "")
          + (f" (+{plan['overCap']} over --max)" if plan["overCap"] else ""))


def _print_move_planned_lines(plan: dict, landed_ids: set[str] | None) -> None:
    t = plan["target"]
    for p in plan["planned"]:
        mark = "  -> " if landed_ids is None else (
            "  -> " if p["sessionId"] in landed_ids else "  !! NOT MOVED  ")
        print(f"{mark}{p['from'] or 'console'} -> {t['instance']}   {str(p['title'])[:60]}")


def _print_move_result_lines(plan: dict) -> None:
    for r in plan["results"]:
        mark = "✓" if r.get("ok") else ("⚠" if r.get("landed") else "✗")
        secs = f"  ({r['secs']:.0f}s)" if isinstance(r.get("secs"), (int, float)) else ""
        print(f"  {mark} {r['outcome']}: {str(r['title'])[:56]}{secs}")
        if not r.get("ok") and r["detail"]:
            for line in r["detail"].splitlines():
                print(f"      {line}")
        if r["exit"] == 5:
            print(f"      fix: python orch.py attempts --clear migrate {r['sessionId']}")


def _print_move_footnotes(plan: dict, act: bool, idle_wait: int) -> None:
    # The one refusal a re-run WOULD cure is the one worth pointing at: a chat whose turn
    # is finished but whose five quiet minutes are not up. Say so once, with the flag,
    # rather than leaving the operator to re-run the whole batch on a guess.
    young = [r for r in plan["results"] if r.get("stopReason") == "too_soon"]
    if young and not idle_wait:
        print(f"\n{len(young)} chat(s) refused only because the engine is not quiet enough YET - "
              "re-run with --idle-wait 330 and the command waits that out itself.")
    # A SKIPPED CHAT MUST NEVER READ AS A CHAT THAT WAS NOT THERE. The archived filter is the
    # default, so the run that most needs this line is the one whose operator did not ask for
    # it and would otherwise never learn those rows existed.
    skipped = plan.get("archivedSkipped") or []
    if skipped:
        print(f"\n{len(skipped)} archived chat(s) NOT moved (archived is skipped by default; "
              "--archived includes them):")
        for r in skipped[:10]:
            print(f"  🗄 {str(r.get('title') or '(untitled)')[:64]}  [{r.get('from')}]")
        if len(skipped) > 10:
            print(f"  ... and {len(skipped) - 10} more")
    if not act:
        print("\nPLAN ONLY - nothing moved. Add --yes to do it.")


def _print_move_plan_text(plan: dict, act: bool, idle_wait: int) -> None:
    landed_ids = _landed_ids(plan, act)
    _print_move_headline(plan, act, landed_ids)
    _print_move_planned_lines(plan, landed_ids)
    _print_move_result_lines(plan)
    _print_move_footnotes(plan, act, idle_wait)


def _move_exit_code(plan: dict, act: bool) -> int:
    if not act:
        return 0
    # all() over an empty list is True, so a run that attempted nothing used to exit 0. A cap
    # that held every movable chat back is not a clean sweep - say so.
    if plan["overCap"] and not plan["results"]:
        return 2
    return 0 if all(r["ok"] for r in plan["results"]) else 2


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    try:
        args = _parse_args(argv)
    except _ArgError as err:
        return err.code

    try:
        rows = collect(args.include_archived, args.account, args.instance, args.search,
                        args.console_only)
    except hydralib.DaemonError as err:
        print(f"chats read FAILED: {err}", file=sys.stderr)
        return 1

    # A FILTER THAT MATCHED NOTHING IS NOT AN EMPTY ACCOUNT. Both used to print the same bare
    # "no chats match.", so a mistyped account read exactly like a clean one - and "that account
    # has nothing on it" is a conclusion someone acts on. Say which it was.
    if not rows and args.account:
        code = _diagnose_empty_account_filter(args.account, args.include_archived)
        if code is not None:
            return code

    if not args.move_to:
        print(json.dumps({"chats": rows}, indent=2) if args.as_json else render(rows))
        return 0

    if not rows:
        return _refuse_no_match(args.search, args.instance, args.account, args.console_only)

    plan = move(rows, args.move_to, args.act, args.cap, args.idle_wait, args.move_archived)
    if plan.get("error"):
        print(f"REFUSED: {plan['error']}", file=sys.stderr)
        return 3
    if args.as_json:
        print(json.dumps(plan, indent=2))
    else:
        _print_move_plan_text(plan, args.act, args.idle_wait)
    return _move_exit_code(plan, args.act)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
