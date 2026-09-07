"""act - move MANY chats between accounts in ONE run, sequentially, sharing every read.

WHY THIS EXISTS (owner, 2026-09-05, angry, twice): moving 13 chats took ~15 minutes and he
had to watch it. His words: "this shouldn't be a serialized thing" and "this needs to happen
in like... 10 seconds". Doing it by hand meant 13 separate move_chat calls, and that shape is
pathological three times over:

  1. THE DAEMON REFUSES CONCURRENCY ANYWAY. server/src/orchestrator.ts keys its in-flight map
     by SCRIPT NAME, so every migrate_chat run in the fleet collides on one key. Firing the
     calls in parallel does not overlap them - it returns `409 busy` for all but one and
     times sockets out on the rest. Measured live: a 6-wide parallel burst produced one
     success, one 409, and four refusals.
  2. EVERY RUN RE-PAID THE FLEET READS. Each spawn is a cold interpreter that re-reads the
     fleet, re-scans ~500 sessions on a fuzzy title, and can re-run an ~80s usage survey.
     N chats paid that N times for an answer that does not change between them.
  3. THE WAITS DID NOT OVERLAP. Per chat: 8s of bypass watch, up to 4s of re-stamp, ~3s of
     settle confirmation. None of it is work; all of it was serial.

WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO
Runs migrate_chat's OWN pipeline inside a single interpreter, BY PHASE rather than by chat
(owner, 2026-09-06: "Move the chat, then you archive, then you set the permission. Move them
all, archive them all, then set all the permissions. That would make the most sense"):

  PHASE 1  migrate_chat.move_only  - resolve, gate, import, verify. Every chat.
  PHASE 2  migrate_chat.phase_settle - settle the source row. Every chat.
  PHASE 3  ONE shared bypass watch, then phase_stamp - doctrine + verdict. Every chat.

The gates did not move and did not weaken. All of them - hold, breaker, archived,
live-writer, the quiet window - live in phase one, BEFORE the import, which is exactly why
phases two and three are safe to defer: nothing they do can decide whether a move was
allowed. Every chat is still RE-RESOLVED immediately before its own gates, never from a row
read at batch start; liveness read 90 seconds ago is not liveness, and a stale `match`
carries a pid the OS may have recycled.

What is actually saved is the waste, not the safety:
  - ONE route-lock acquisition instead of N, so nothing 409s and nothing races.
  - ONE interpreter and one warm module import instead of N cold starts.
  - The fleet, session and usage-survey caches stay warm across the whole batch, so chats
    2..N resolve off reads chat 1 already paid for.
  - ONE 8-SECOND BYPASS WATCH FOR THE WHOLE BATCH instead of one per chat. That watch is a
    once-a-second re-read of a landed record, and N of them overlap perfectly; run per chat
    they were 40 of the 189 seconds a 5-chat batch took, and they grew with the batch.
  - The chats are usable sooner: phase one ends with every chat verified in its new account,
    and what follows is tidying a move that has already happened.

⛔ THE PHASES OVERLAP THE WAITING, NEVER THE DRIVING. The source settle and the permission
picker each drive a real application window under its own instance lock, one at a time, in
phase order. Two of those at once is two scripts fighting over one sidebar.

⛔ IMPORTS ARE NOT PARALLELISED AND MUST NOT BE. /api/sessions/:id/import-desktop does not
take the daemon's act lock, the resume deeplink drives Electron's single-instance channel,
and two concurrent imports into one store can create a duplicate row that makes the chat
permanently unreachable. The per-chat import stays one at a time. This script is faster
because it stops repeating itself, NOT because it does several things at once.

⛔ A REFUSAL IS NOT A FAILURE OF THE BATCH. A chat with a live engine is skipped, reported by
name with its reason, and the batch moves on. The exit code reflects whether anything landed
and whether anything refused - it never hides a refusal behind a batch-level success.

Usage:
  python migrate_batch.py --to here --chat "first title" --chat "second title" [--json]
  python migrate_batch.py --to 8 --from 11 --all-unarchived     # every movable chat
  python migrate_batch.py --to here --chat "..." --dry-run      # plan only, moves none
  python orch.py migrate_batch --to here --all-unarchived       # the same, via the driver

Flags other than --chat/--all-unarchived are passed through to every chat's own move, so
--now, --force, --archived, --title, --idle-wait and --stop-idle mean exactly what they mean
for a single move. --title is refused for a multi-chat batch: one new name cannot be right
for several different chats.

Exit: 0 every named chat landed (or, under --dry-run, every plan resolved) - 2 the flags do
  not make sense - 4 nothing landed - 5 a PARTIAL batch: some landed, some were refused.
  5 is deliberately its own code. A batch that mostly worked must never return the same
  answer as one that entirely worked, because the refusals are the reason to look.
"""

from __future__ import annotations

import json
import sys
import time

import migrate_chat
from lib import clilib, hydralib


#: Flags this driver consumes itself; everything else is forwarded to each chat's own move.
_BATCH_ONLY = {"--chat", "--all-unarchived", "--json", "--limit"}

#: Exit codes. 0 every chat landed - 4 nothing landed - 5 a partial batch (some landed, some
#: refused). A partial batch gets its OWN code because "mostly worked" must never read to a
#: caller as "worked": the refusals are the whole point of looking.
EXIT_OK, EXIT_NONE, EXIT_PARTIAL = 0, 4, 5
#: A --from nobody has is a DETERMINISTIC refusal, code 3, exactly as migrate_chat
#: answers the same mistake. It must never collapse into EXIT_NONE: "nothing to move"
#: and "that account does not exist" are different facts and only one is safe to trust.
EXIT_REFUSED = 3


class _UnknownSource(Exception):
    """--from named no instance in the fleet."""


class _BatchArgs:
    __slots__ = ("chats", "passthrough", "as_json", "all_unarchived", "source", "limit",
                 "dry_run")

    def __init__(self) -> None:
        self.chats: list[str] = []
        self.passthrough: list[str] = []
        self.as_json = False
        self.all_unarchived = False
        self.source: str | None = None
        self.limit = 0
        self.dry_run = False


def _parse(argv: list[str]) -> _BatchArgs | int:
    """Same hand-rolled convention as migrate_chat: unknown flags are forwarded, not fatal."""
    a = _BatchArgs()
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--chat" and i + 1 < len(argv):
            a.chats.append(argv[i + 1])
            i += 2
            continue
        if tok == "--limit" and i + 1 < len(argv):
            try:
                a.limit = max(0, int(argv[i + 1]))
            except ValueError:
                print(f"--limit wants a number, got {argv[i + 1]!r}", file=sys.stderr)
                return 2
            i += 2
            continue
        if tok == "--all-unarchived":
            a.all_unarchived = True
            i += 1
            continue
        if tok == "--json":
            a.as_json = True
            i += 1
            continue
        if tok == "--dry-run":
            a.dry_run = True
            a.passthrough.append(tok)
            i += 1
            continue
        if tok == "--from" and i + 1 < len(argv):
            a.source = argv[i + 1]
            a.passthrough += [tok, argv[i + 1]]
            i += 2
            continue
        if tok not in _BATCH_ONLY:
            a.passthrough.append(tok)
        i += 1
    return a


def _movable_chats(source: str | None, limit: int) -> tuple[list[dict], str]:
    """Every UNARCHIVED desktop chat, newest first, optionally scoped to one source account.

    Deliberately reads the same rows migrate_chat resolves against rather than inventing a
    second notion of what a chat is. Archived rows are excluded here because --all-unarchived
    means what it says; a specific archived chat still moves by name with --archived.
    """
    # period="all", archived="include" is the ENUMERATOR contract hydralib.sessions spells
    # out: the windowed default hid six unarchived chats the day it was measured, one of them
    # active that morning. Archived rows are filtered here, locally, so the read stays a
    # census and only the choosing is ours.
    # --from arrives as whatever the caller typed, and the MCP ALWAYS sends a NUMBER ("27").
    # A session row carries only the instance FOLDER name ("anothuh1"), so comparing the raw
    # argument against it matched nothing for every spelling but one - and the miss was
    # SILENT: a batch scoped to a real, full account reported "nothing to move", which reads
    # exactly like "that account is already clean". Resolve it through the fleet first, the
    # way migrate_chat's own --from does, so the two paths cannot disagree about an account.
    source_name = None
    if source:
        fleet = hydralib.fleet()
        src = hydralib.resolve_instance(fleet, str(source))
        if src is None:
            known = ", ".join(f"#{i.get('num')} {i.get('name')}"
                              for i in fleet.get("instances", []))
            raise _UnknownSource(f"--from names no instance ({source!r}). Known: {known}")
        source_name = str(src.get("name") or "")
    rows = hydralib.sessions(period="all", archived="include")
    picked = []
    for row in rows:
        if row.get("archived"):
            continue
        if str(row.get("source") or "claude") != "claude":
            continue  # only Claude desktop chats have an account to move between
        inst = str(row.get("instance") or "")
        if not inst:
            continue  # not a desktop chat: nothing to move it off
        if source_name and inst.lower() != source_name.lower():
            continue
        picked.append(row)
    picked.sort(key=lambda r: -(r.get("last_activity_at") or 0))
    note = (f"{len(picked)} unarchived desktop chat(s)"
            + (f" on {source_name}" if source_name else ""))
    if limit and len(picked) > limit:
        picked = picked[:limit]
        note += f", taking the {limit} most recent"
    return picked, note


class _Item:
    """One chat's place in the batch: its query, its landing while it is still unfinished,
    and the payload it ends up printing. `landing is None` after phase one means this chat
    is DONE being touched - refused, planned, or crashed - and every later phase skips it."""

    __slots__ = ("query", "landing", "payload", "errors")

    def __init__(self, query: str) -> None:
        self.query = query
        self.landing = None
        self.payload: dict = {}
        # A later phase that raised, one line each. The landing stays alive through the
        # remaining phases (each is its own tidy-up), and the payload says what did not finish.
        self.errors: list[str] = []


def _crash(query: str, err: Exception, started: float, doing: str) -> dict:
    """A chat that raised. Never a landing, always named, and it never stops the batch."""
    return {"chat": query, "ok": False, "landed": False, "exitCode": 1,
            "report": f"{doing} raised {type(err).__name__}: {str(err)[:200]}",
            "secs": round(time.time() - started, 2)}


def _move_one(query: str, passthrough: list[str]) -> _Item:
    """PHASE ONE for ONE chat: migrate_chat's own move_only() - resolve, gate, import, verify.

    Calls the same function main() calls, so this driver still cannot drift from the
    single-chat path: every gate, the import and the read-back verify are whatever
    migrate_chat says they are today. What it does NOT do is finish the move; the source
    settle and the permission stamp are run later, across the whole batch at once.
    """
    item = _Item(query)
    started = time.time()
    try:
        outcome = migrate_chat.move_only([query, *passthrough])
    except Exception as err:  # a crash in one chat must not take the batch with it
        item.payload = _crash(query, err, started, "migrate")
        return item
    if outcome.landing is not None:
        item.landing = outcome.landing
        return item
    # A refusal or a dry-run plan: already a finished payload, nothing left to do to it.
    payload = dict(outcome.payload or {})
    payload.setdefault("report", "")
    payload["chat"] = query
    payload["exitCode"] = outcome.code
    payload.setdefault("landed", False)
    payload["ok"] = outcome.code == 0 and bool(payload.get("landed"))
    item.payload = payload
    return item


def _finish_one(item: _Item) -> None:
    """Turn a finished landing into the payload the report reads. Never raises.

    ⛔ A LANDING THAT CRASHED LATER IS STILL A LANDING (review finding, 2026-09-06). Phases two
    and three only ever run on a chat that _verify_landing_or_raise confirmed lives in the
    target account and that the mutation ledger already records as moved. Reporting such a
    chat `landed: False` sent the operator to "re-run" a move that had already happened, and
    counted a fully-landed batch as partial. So a later-phase raise keeps `landed: True`, sets
    `ok: False` with a non-zero exit code, and names exactly what did not finish.
    """
    started = time.time()
    try:
        item.payload = migrate_chat.landing_payload(item.landing)
    except Exception as err:
        item.payload = {"landed": True, "chat": item.query, "ok": False, "exitCode": 1,
                        "report": (f"LANDED but finishing raised {type(err).__name__}: "
                                   f"{str(err)[:200]} - the chat IS in its new account; "
                                   "do not re-move it"),
                        "secs": round(time.time() - started, 2)}
        item.landing = None
        return
    item.payload["chat"] = item.query
    if item.errors:
        item.payload["ok"] = False
        item.payload["exitCode"] = 1
        item.payload["unfinished"] = list(item.errors)
        item.payload["report"] = (
            "LANDED but not finished: " + "; ".join(item.errors)
            + " - the chat IS in its new account; finish the tidy-up by hand "
              "(settle the source row / stamp the mode), do not re-move it.\n"
            + str(item.payload.get("report") or ""))
        return
    item.payload["exitCode"] = 0
    item.payload["ok"] = bool(item.payload.get("landed"))


def _run_phases(items: list[_Item]) -> None:
    """PHASES TWO AND THREE, each run across EVERY chat before the next one starts.

    THE ORDER IS THE OWNER'S (2026-09-06): "Move them all, archive them all, then set all the
    permissions." Two things come out of it, and only one of them is speed:

      - The chats are USABLE sooner. Phase one ends with every chat verified in its new
        account; the settling and stamping that follow are tidying a move that has already
        happened. Interleaving them meant chat five had not moved at all until the first four
        had been fully tidied.
      - ONE BYPASS WATCH INSTEAD OF N. watch_bypass is an 8-second once-a-second re-read of a
        landed record, and N of those windows overlap perfectly. Run per chat they cost 8s x
        N - 40 of the 189 seconds a 5-chat batch took - and shared they cost 8s for any batch
        size. That is the single largest saving here and it is pure waiting, not work.

    ⛔ WHAT IS STILL SERIAL, AND MUST STAY SERIAL: the source settle and the permission picker
    each drive a real application window through its own instance lock. Two of those at once
    is two scripts fighting over one sidebar. The phases overlap the WAITING; they do not
    overlap the driving.
    """
    live = [i for i in items if i.landing is not None]
    for item in live:
        try:
            migrate_chat.phase_settle(item.landing)
        except Exception as err:
            # The chat is in its new account regardless; the settle is one tidy-up of two.
            # Its landing stays alive so the stamp phase still runs for it, and the payload
            # will say the source row is in an unknown state rather than claim a settle.
            item.errors.append(f"settling raised {type(err).__name__}: {str(err)[:200]}")
            item.landing.settle_note = (f" ⚠ Source row NOT settled - settling raised "
                                        f"{type(err).__name__}: {str(err)[:120]}.")
            item.landing.source_row = "unknown"
    if not live:
        return
    # The shared watch. It re-stamps any record the app flipped back, exactly as each chat's
    # own watch did, so this is the same guarantee bought once instead of N times.
    try:
        watched = migrate_chat.watch_bypass_many(
            [migrate_chat.landed_meta_path(i.landing) for i in live])
    except Exception:
        # ⛔ NEVER SILENTLY SKIP THE WATCH. A missing verdict means each chat watches its own
        # record below (watched=None), which is slower and correct - not faster and unproven.
        watched = {}
    for item in live:
        try:
            path = migrate_chat.landed_meta_path(item.landing)
            migrate_chat.phase_stamp(item.landing, watched=watched.get(path))
        except Exception as err:
            item.errors.append(f"stamping raised {type(err).__name__}: {str(err)[:200]}")
    for item in items:
        if item.landing is not None:
            _finish_one(item)




def _report(results: list[dict], note: str, secs: float) -> str:
    # A DRY RUN IS NOT A REFUSAL. Reporting a plan as SKIP made a clean plan read like 13
    # blocked chats, which is the same class of lie as calling a skipped step a pass.
    if results and all(r.get("dryRun") for r in results):
        lines = [f"DRY RUN: {len(results)} chat(s) planned in {secs:.0f}s"
                 + (f" ({note})" if note else "")]
        for r in results:
            first = (r.get("report") or "").splitlines()
            lines.append(f"  PLAN {(first[0] if first else r['chat'])[:170]}")
        lines.append("Nothing was moved. Re-run without --dry-run to execute.")
        return "\n".join(lines)
    landed = [r for r in results if r.get("landed")]
    clean = [r for r in landed if r.get("ok")]
    # LANDED BUT NOT FINISHED is its own bucket: these chats ARE in the new account, and the
    # "was NOT moved - re-run it" trailer below must never be printed about one of them.
    unfinished = [r for r in landed if not r.get("ok")]
    refused = [r for r in results if not r.get("landed")]
    lines = [f"{len(landed)}/{len(results)} landed in {secs:.0f}s"
             + (f" ({note})" if note else "")]
    for r in clean:
        title = r.get("title") or r["chat"]
        verdict = r.get("bypassVerdict") or "?"
        lines.append(f"  OK   {title} -> {r.get('to') or '?'} [bypass: {verdict}]")
    for r in unfinished:
        title = r.get("title") or r["chat"]
        why = (r.get("report") or "").splitlines()
        lines.append(f"  LANDED but not finished: {title} -> {r.get('to') or '?'}: "
                     f"{(why[0] if why else 'a later phase raised')[:150]}")
    for r in refused:
        why = (r.get("report") or "").splitlines()
        lines.append(f"  SKIP {r['chat']}: {(why[0] if why else 'refused')[:150]}")
    if unfinished:
        lines.append("A LANDED-but-unfinished chat IS in its new account - do not re-move it; "
                     "finish its tidy-up (settle the source row / stamp the mode) by hand.")
    if refused:
        lines.append("A skipped chat was NOT moved - re-run it once its engine is idle.")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    parsed = _parse(argv)
    if isinstance(parsed, int):
        return parsed

    note = ""
    if parsed.all_unarchived:
        try:
            rows, note = _movable_chats(parsed.source, parsed.limit)
        except _UnknownSource as err:
            # NOT EXIT_NONE. An empty batch and an account that does not exist look identical
            # to a caller who only reads `moved`, and one of them means the work is still
            # sitting there untouched.
            payload = {"ok": False, "moved": 0, "results": [],
                       "report": f"REFUSED (deterministic): {err}"}
            print(json.dumps(payload, indent=2) if parsed.as_json else payload["report"])
            return EXIT_REFUSED
        # Resolve by SESSION ID, never by title: two accounts can hold the same title, and a
        # fuzzy re-match at move time could pick the wrong one.
        parsed.chats = [str(r.get("session_id") or "") for r in rows if r.get("session_id")]

    if not parsed.chats:
        # An account that RESOLVED and is genuinely empty is a different fact from a caller
        # who named nothing, and telling the first one to "use --all-unarchived" when that is
        # exactly what it did is how a real answer gets mistaken for a usage error.
        report = (f"nothing to move: {note}" if parsed.all_unarchived and note
                  else ("nothing to move: name chats with --chat, or use "
                        "--all-unarchived (optionally with --from)"))
        payload = {"ok": False, "moved": 0, "results": [], "report": report}
        print(json.dumps(payload, indent=2) if parsed.as_json else payload["report"])
        return EXIT_NONE

    if len(parsed.chats) > 1 and "--title" in parsed.passthrough:
        print("--title renames ONE chat; it cannot be right for a batch of several.",
              file=sys.stderr)
        return 2

    t0 = time.time()
    # PHASE ONE across every chat, then the finishing phases across every chat (_run_phases).
    items = [_move_one(q, parsed.passthrough) for q in parsed.chats]
    _run_phases(items)
    results = [i.payload for i in items]
    secs = time.time() - t0

    landed = sum(1 for r in results if r.get("landed"))
    # `moved` counts LANDINGS (the chat is in its new account); `ok` demands that every chat
    # also FINISHED its tidy-up. A chat that landed and then crashed in a later phase is moved
    # and not ok, and the batch is partial - never "not moved".
    finished = sum(1 for r in results if r.get("ok"))
    # A dry run's success is "every plan resolved", not "everything landed" - nothing landed
    # by construction, and grading it against landings reports a working plan as a failure.
    planned_ok = parsed.dry_run and all(r.get("exitCode") == 0 for r in results)
    all_ok = planned_ok or finished == len(results)
    payload = {
        "ok": all_ok,
        "moved": landed,
        "asked": len(results),
        "refused": len(results) - landed,
        "unfinished": 0 if parsed.dry_run else landed - finished,
        "secs": round(secs, 2),
        "secsPerChat": round(secs / max(1, len(results)), 2),
        "dryRun": parsed.dry_run,
        "results": results,
        "report": _report(results, note, secs),
    }
    print(json.dumps(payload, indent=2) if parsed.as_json else payload["report"])
    if all_ok:
        return EXIT_OK
    return EXIT_PARTIAL if landed else EXIT_NONE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
