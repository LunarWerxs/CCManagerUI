#!/usr/bin/env python3
"""chips.py - ACT: start the desktop's SUGGESTED-TASK chips, locally, never blind.

THE CHIP (owner, 2026-09-01: "have you handled chips? The popup chip things that the desktop
spawns... Always 'Start locally', never in a worktree"). The desktop app plants a 'Suggested
task' card in a chat's pane - a title, a description, branch tags - with 'Dismiss suggestion',
'Start with worktree' and a 'More start options' menu ('Start locally', 'Send to cloud', 'Fix
in this session'). Starting one creates a NEW chat for that task, running at once, in the
parent's folder and permission mode (measured live: born 'Running', picker 'Bypass').

WHERE CHIPS ARE SEEN. A chip lives in the pane of the chat it belongs to, so it is visible
only while that chat is open. Two eyes feed this lane: (1) every pass scans the chat that is
OPEN in each running window (selecting nothing, flipping nothing the owner is looking at),
and (2) the doctrine lane, which selects chats anyway to confirm their permission picker,
records any chip it sees into state/chips.json. Both land here.

HOW A CHIP IS STARTED (owner, 2026-09-01: "just create a new chat using the prompt it gave
you, then dismiss the chip"): not through the app's start menu but through THE TOOLBOX'S OWN
SPAWNER - spawn_chat.spawn(the parent chat's folder, the card's title + description, the
parent's instance) - which carries every rail the menu does not: the duplicate guard on
this exact prompt (a task already open is refused, and the chip is DISMISSED, since starting
it again is the duplicate the owner forbade), bypass from birth, registration and a confirmed
first turn. Then the chip is dismissed so nobody starts it a second time by hand. The app's
own 'Start locally' remains in the actuator (proven live) as the route of last resort.

THE OTHER RAILS: the tray icon (armlib - a start is an act); never past the running cap (a
start boots an engine); never on a held chat's chip; never without the parent's folder; a
few starts per pass; and a spawn whose first turn did not confirm is reported as such,
never as done.

Usage: python chips.py                 # observe: the chips visible right now, and what would happen
       python chips.py --yes           # act (icon up, or --force by hand)
       python chips.py --json
Exit:  0 nothing to do / every start confirmed - 2 a start did not confirm - 1 daemon failure.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from lib import armlib, clilib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib
from lib import windowlib

ACTUATOR = Path(__file__).resolve().parent / "actuator" / "chip.ps1"
CHIPS_NAME = "chips.json"
# A recorded chip older than this is re-scanned before it is acted on (the card may be gone).
RECORD_STALE_SECS = 6 * 3600
STARTS_PER_PASS = 3


def _chips_path() -> Path:
    return ledgerlib._state_dir() / CHIPS_NAME


def load_records() -> list[dict]:
    try:
        raw = json.loads(_chips_path().read_text(encoding="utf-8"))
        return [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []
    except (OSError, ValueError):
        return []


def _save_records(rows: list[dict]) -> None:
    p = _chips_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def record(instance: str, chat_title: str, chip_title: str, description: str = "") -> None:
    """Remember a chip another lane saw (the doctrine pass, after selecting a chat).

    Load-filter-append-save happens under the "chips" state lock (audit AH-29, reproduced
    2026-09-05): the doctrine lane's record() and the scheduled lane's forget() run under
    different scheduler locks, so an unlocked read-modify-replace let each read the same
    stale snapshot and one's write silently erase the other's - atomic replacement stopped
    truncation but not this lost update."""
    with ledgerlib.locked("chips"):
        rows = [r for r in load_records()
                if not (r.get("instance") == instance and r.get("chat") == chat_title)]
        rows.append({"instance": instance, "chat": chat_title, "title": chip_title,
                     "description": description, "seenAt": int(time.time() * 1000)})
        _save_records(rows[-200:])


def forget(instance: str, chat_title: str) -> None:
    """See record()'s note: the same lock guards this read-modify-replace."""
    with ledgerlib.locked("chips"):
        rows = [r for r in load_records()
                if not (r.get("instance") == instance and r.get("chat") == chat_title)]
        _save_records(rows)


def _run(args: list[str], timeout: int = 90) -> tuple[int, str]:
    try:
        r = clilib.run_text(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR)] + args,
                           timeout=timeout)
        return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()
    except (OSError, subprocess.TimeoutExpired) as err:
        return 1, f"actuator error: {str(err)[:160]}"


def scan_open(inst: dict) -> dict | None:
    """The chip in the chat that is OPEN in this window, selecting nothing."""
    code, out = _run(["-Instance", str(inst.get("dir")), "-Open", "-Scan"])
    line = out.splitlines()[-1] if out else ""
    try:
        got = json.loads(line)
    except ValueError:
        return None
    if not got.get("found"):
        return None
    return {"instance": str(inst.get("name")), "dir": str(inst.get("dir")), "chat": got.get("chat") or "",
            "title": str(got.get("title") or ""), "description": str(got.get("description") or ""),
            "source": "open"}


def find_chips(fleet: dict) -> list[dict]:
    """Every chip known right now: the open chat of each running window, plus the doctrine
    lane's records (those still carry the chat title so the act can select it)."""
    found: list[dict] = []
    by_name = {str(i.get("name")): i for i in fleet.get("instances", [])}
    for inst in fleet.get("instances", []):
        if inst.get("isRunning") and inst.get("dir"):
            got = scan_open(inst)
            if got:
                found.append(got)
    now = int(time.time() * 1000)
    for r in load_records():
        inst = by_name.get(str(r.get("instance")))
        if not inst or not inst.get("isRunning"):
            continue
        if now - int(r.get("seenAt") or 0) > RECORD_STALE_SECS * 1000:
            continue
        if any(f["instance"] == r["instance"] and f["chat"] == r.get("chat") for f in found):
            continue
        found.append({"instance": str(r["instance"]), "dir": str(inst.get("dir")), "chat": str(r.get("chat") or ""),
                      "title": str(r.get("title") or ""), "description": str(r.get("description") or ""),
                      "source": "recorded"})
    return found


def already_open(chip: dict) -> str | None:
    """A visible chat already doing this task: by the suggestion's title, or by the same first
    prompt (the app composes the new chat's prompt from the card)."""
    title = chip["title"].strip().lower()
    if not title:
        return None
    for row in hydralib.visible_chats():
        if row.get("archived"):
            continue
        if str(row.get("title") or "").strip().lower() == title:
            return f"'{row.get('title')}' already open in {row.get('instance') or 'console'}"
    try:
        same = hydralib.same_task_chats(f"{chip['title']}\n{chip['description']}")
    except hydralib.DaemonError:
        same = []
    if same:
        s = same[0]
        return f"'{s.get('title')}' ({s.get('instance') or 'console'}) carries the same task"
    return None


def plan(fleet: dict) -> list[dict]:
    rows = []
    for chip in find_chips(fleet):
        why = None
        parent_sid = None
        folder = ""
        for r in hydralib.visible_chats():
            if str(r.get("instance")) == chip["instance"] and str(r.get("title") or "") == chip["chat"]:
                parent_sid = r.get("session_id")
                folder = str(r.get("cwd") or "")
                break
        if parent_sid and holdlib.why_blocked(parent_sid):
            why = "its chat is HELD - left for the owner"
        elif not folder:
            why = "its chat's folder is unknown - nowhere honest to start the task"
        dup = already_open(chip) if not why else None
        rows.append({**chip, "parentSessionId": parent_sid, "folder": folder,
                     "prompt": (chip["title"] + ("\n\n" + chip["description"] if chip["description"] else "")).strip(),
                     "action": ("leave" if why else "dismiss" if dup else "start"),
                     "why": why or (f"duplicate: {dup}" if dup else
                                    "start it locally through the toolbox's own spawner (owner: never a worktree), then dismiss the chip")})
    return rows


def _dismiss(row: dict) -> tuple[int, str]:
    with windowlib.instance_lock(row["dir"], wait_secs=60) as mine:
        if not mine:
            return 7, "window busy - next pass"
        return _run(["-Instance", row["dir"], "-Title", row["chat"], "-Dismiss"], timeout=120)


def execute(rows: list[dict]) -> list[dict]:
    results = []
    started = 0
    for row in rows:
        if row["action"] == "leave":
            results.append({**row, "ok": True, "outcome": "left"})
            continue
        if row["action"] == "dismiss":
            code, out = _dismiss(row)
            ok = code == 0
            if ok:
                forget(row["instance"], row["chat"])
            results.append({**row, "ok": ok or code == 7, "exit": code,
                            "outcome": (out.splitlines()[-1] if out else f"exit {code}")[:200]})
            continue
        if started >= STARTS_PER_PASS:
            results.append({**row, "ok": True, "outcome": f"deferred - {STARTS_PER_PASS} starts per pass"})
            continue
        try:
            running = hydralib.running_count()
        except hydralib.DaemonError as err:
            results.append({**row, "ok": False, "outcome": f"running count unreadable ({err}) - not starting blind"})
            continue
        if running >= hydralib.MAX_RUNNING_CHATS:
            results.append({**row, "ok": True, "outcome": f"deferred - the machine is at its cap ({running} of {hydralib.MAX_RUNNING_CHATS})"})
            continue
        # THE TOOLBOX'S OWN SPAWNER (owner, 2026-09-01: "just create a new chat using the prompt
        # it gave you, then dismiss the chip"): spawn_chat carries every rail the app's start
        # menu does not - the duplicate guard on this exact prompt, bypass from birth, the
        # folder the parent chat works in, registration and a confirmed first turn. Then the
        # chip is dismissed so nobody starts it a second time by hand.
        import spawn_chat

        got = spawn_chat.spawn(row["folder"], row["prompt"], row["instance"])
        if got.get("duplicateOf"):
            code, out = _dismiss(row)
            forget(row["instance"], row["chat"])
            results.append({**row, "ok": True, "spawn": got,
                            "outcome": f"already open ({got.get('why', '')[:120]}) - chip dismissed"
                                       + ("" if code == 0 else f" (dismiss: {out[-100:]})")})
            continue
        if not got.get("ok"):
            results.append({**row, "ok": False, "spawn": got, "outcome": f"spawn REFUSED: {got.get('why')}"})
            continue
        started += 1
        forget(row["instance"], row["chat"])
        new_sid = str(got.get("sessionId") or "")
        running_now = str(got.get("started") or "").startswith("running")
        if new_sid:
            ledgerlib.note("spawned", new_sid, note=f"chip from '{row['chat']}': {row['title'][:80]}")
        code, out = _dismiss(row)
        results.append({**row, "ok": bool(new_sid) and running_now, "spawn": got, "newSessionId": new_sid or None,
                        "outcome": (f"spawned {new_sid[:8] if new_sid else '(no id yet)'} in {got.get('instance')}; "
                                    f"first turn {'running' if running_now else 'NOT confirmed: ' + str(got.get('started'))}; "
                                    f"mode: {got.get('modeSet')}; chip "
                                    + ("dismissed" if code == 0 else f"NOT dismissed ({out[-80:]})"))})
    return results


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    act = "--yes" in argv
    if act:
        refusal = armlib.refuse_unless_armed(argv, "starting suggested-task chips")
        if refusal:
            print(refusal)
            act = False
    try:
        fleet = hydralib.fleet()
        rows = plan(fleet)
    except hydralib.DaemonError as err:
        print(f"chips FAILED: {err}", file=sys.stderr)
        return 1
    results = execute(rows) if act else []
    if as_json:
        print(json.dumps({"chips": rows, "results": results}, indent=2))
    else:
        if not rows:
            print("no suggested-task chip is showing in any open chat (and none recorded).")
        else:
            print(f"{len(rows)} chip(s):")
            for r in (results or rows):
                mark = ("OK " if r.get("ok") else "XX ") if results else "-  "
                print(f"  {mark}[{r['instance']}] in '{r['chat'][:40]}': {r['title'][:60]} -> {r['action']}: {r['why']}"
                      + (f" -> {r.get('outcome')}" if results else ""))
            if not act and any(r["action"] == "start" for r in rows):
                print("PLAN ONLY - add --yes to start them locally.")
    return 2 if [r for r in results if not r.get("ok")] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
