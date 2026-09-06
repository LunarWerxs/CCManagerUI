#!/usr/bin/env python3
"""fan_out.py - ACT: DISSEMINATE a task list into N desktop chats, one account each, and manage them as a group.

THE ASK (owner, 2026-09-04): "if I start a single chat and tell it to do something that involves
checking or linting six or seven different planes, can it orchestrate those chats into other
accounts and manage them?" Before this the answer was "by hand": read the usage survey, pick
accounts, run spawn_chat seven times, remember seven session ids, tail seven transcripts - and
there was no MCP tool at all to send a follow-up into any of them. Worse, the two MCP tools that
LOOK like the answer (add_queue_item, launch_terminal_session) are refused on every call by the
no-headless law, so an agent reading the tool list tried them first and got nowhere. This
script is the one call, and MCP `fan_out` / `fan_out_status` / `fan_out_send` wrap it.

WHAT IT DOES, and every rail it keeps:
  - RANKS accounts by real room the way balance.py does (fill ceiling minus the account's peak
    across 5-hour / weekly / binding; an unknown or stale reading is never room), OPEN
    instances first, ONE task per account by default. SPREAD, NEVER DUMP (owner, 2026-08-31).
  - SPAWNS each chat through spawn_chat.py - the app's own claude://code/new deeplink into a
    RUNNING desktop app, trust pre-written, composer submitted, bypass set at birth - so every
    chat is VISIBLE in a sidebar the owner reads. Nothing headless, ever.
  - ONE AT A TIME. Each spawn drives a window through the accessibility tree; two lanes driving
    two windows in the same second is how text lands in the wrong pane. Sequential is slower
    (~30-90 s per chat) and correct.
  - REMEMBERS the group in state/fanouts.json, so `status` reads every member's gate verdict
    (working / idle / stalled / finished / crashed) with its last words, and `send` delivers one
    follow-up into all of them through the daemon's message route (native peer channel for a
    live chat, the composer for a dormant one), holds respected.
  - A duplicate of a chat that ALREADY EXISTS in the fleet is refused per task (the same
    double-check spawn_chat runs); two tasks in the SAME spec may share a prompt on purpose
    (seven planes, one instruction), so that check runs HERE, once per task, against the fleet
    as it was before this group started.
  - Closed accounts are used only with --open-closed (opening an app is the last resort - owner
    rule); a task with no account left is reported UNASSIGNED, never silently dropped.

This is a PERSON's act, like migrate_chat: it runs when asked and does not need the tray icon.
The `title` on a task is the group's own label for that member (what `status` prints); the
desktop app titles the chat itself from its first prompt, and no UI rename is attempted.

STEERING GOES THROUGH THE COMPOSER, NOT THE PEER PIPE (measured 2026-09-04, this script's own
first drill): the native peer channel accepted a follow-up into both spawned chats, neither
chat ever processed it, and one engine exited holding it - "delivered" was an enqueue record,
not a turn. A chat nobody has clicked drains peer messages only after a person interacts with
it. So `send` first stops each member's IDLE engine (enginelib, the same rails migrate_chat
uses; a working or stuck engine refuses and that member is skipped with the reason) and lets
the daemon's message route boot the chat through the app's own composer, which is the send
that starts a turn and is verified from the transcript.

A DRILL MUST BE DELETED AFTERWARDS (owner rule, 2026-09-04: "all ping requests or account
identification requests must be deleted after they are created and not left in the
account"). `delete <group>` runs delete_chat.py on every member - the app's own Delete
control where the app is running, the meta record and the transcript everywhere, an undo copy
first - so a probe fan-out leaves nothing in any account.

Usage: python fan_out.py --spec <file.json | '{"tasks":[...]}'> [--per-account N]
                         [--exclude <inst>]... [--only <inst>]... [--open-closed]
                         [--dry-run] [--force] [--json]
       python fan_out.py list [--json]
       python fan_out.py status [<group>] [--json]          # the latest group when omitted
       python fan_out.py send <group> --text "..." [--only <sessionId>]... [--force] [--json]
       python fan_out.py delete <group> [--force] [--json]  # every member chat, everywhere
Spec:  {"tasks": [{"title": "...", "folder": "<dir>", "prompt": "..."}, ...], "group": "<name>"}
       (a bare list of tasks is accepted too; `title` is optional)
Exit:  0 every task spawned and its first turn confirmed / status read / every send delivered /
         every member deleted and verified
       4 partial: some members not confirmed, refused or unassigned; some sends not delivered;
         some members not deleted
       2 nothing spawned at all (no account with room, or every spawn refused) / nothing to
         send to or delete
       3 bad usage, bad spec, or unknown group - 1 daemon failure.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import balance
import delete_chat
import spawn_chat
from lib import clilib, enginelib, gatelib, holdlib, hydralib, ledgerlib

STATE_FILE = "fanouts.json"
# How long to wait for a closed instance we were told to open to report running, and how long
# between looks.
OPEN_WAIT_SECS = 90
OPEN_POLL_SECS = 5
# How much of a member's last words `status` carries (the whole text stays in its transcript).
LAST_TEXT_CHARS = 600
# The message route's own confirm window; the call waits that long for the chat to move. A
# composer send boots a fresh engine first, which is why it is the route's own 120s default.
SEND_CONFIRM_SECS = 120


# --- the group ledger ------------------------------------------------------------------------

def _path() -> Path:
    return ledgerlib._state_dir() / STATE_FILE


def _load() -> list[dict]:
    try:
        rows = json.loads(_path().read_text(encoding="utf-8"))
        return rows if isinstance(rows, list) else []
    except (OSError, ValueError):
        return []


def _save(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _upsert(group: dict) -> None:
    """Write one group record, replacing any earlier copy with the same id. Serialized
    across processes (ledgerlib.locked), atomic on disk (_save)."""
    with ledgerlib.locked("fanouts"):
        rows = [r for r in _load() if r.get("id") != group["id"]]
        rows.append(group)
        _save(rows)


def groups() -> list[dict]:
    return sorted(_load(), key=lambda g: str(g.get("createdAt") or ""))


def find_group(group_id: str | None) -> dict | None:
    """By id, by name, or the LATEST when nothing is named. An id prefix is enough."""
    rows = groups()
    if not rows:
        return None
    if not group_id:
        return rows[-1]
    want = group_id.strip().lower()
    for g in reversed(rows):
        if str(g.get("id", "")).lower() == want or str(g.get("name") or "").lower() == want:
            return g
    hits = [g for g in rows if str(g.get("id", "")).lower().startswith(want)]
    return hits[-1] if len(hits) == 1 else None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_group_id() -> str:
    return f"fo-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"


# --- the spec --------------------------------------------------------------------------------

def parse_spec(raw: str) -> dict:
    """A path to a JSON file, or JSON text. Returns {"group": name|None, "tasks": [...]} with
    every task validated: folder (an existing directory), prompt (non-empty), title (optional,
    defaulted from the prompt). Raises ValueError with the exact complaint."""
    text = raw
    p = Path(raw)
    try:
        if p.is_file():
            text = p.read_text(encoding="utf-8")
    except OSError as err:
        raise ValueError(f"cannot read spec file {raw!r}: {err}") from err
    try:
        data = json.loads(text)
    except ValueError as err:
        raise ValueError(f"spec is neither a JSON file nor JSON text: {err}") from err
    if isinstance(data, list):
        data = {"tasks": data}
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        raise ValueError('spec must be {"tasks": [...]} or a bare list of tasks')
    if not data["tasks"]:
        raise ValueError("spec has no tasks")
    tasks = []
    for i, t in enumerate(data["tasks"]):
        if not isinstance(t, dict):
            raise ValueError(f"task {i} is not an object")
        folder = str(t.get("folder") or t.get("cwd") or "").strip()
        prompt = str(t.get("prompt") or "").strip()
        if not folder:
            raise ValueError(f"task {i} has no folder")
        if not Path(folder).is_dir():
            raise ValueError(f"task {i}: {folder!r} is not a directory - a chat cannot start there")
        if not prompt:
            raise ValueError(f"task {i} has no prompt")
        title = str(t.get("title") or "").strip() or prompt.splitlines()[0][:60]
        tasks.append({"title": title, "folder": str(Path(folder).resolve()), "prompt": prompt})
    name = str(data.get("group") or "").strip() or None
    return {"group": name, "tasks": tasks}


# --- the targets -----------------------------------------------------------------------------

def _resolve_nums(fleet_data: dict, refs: list[str]) -> set:
    """Instance refs (number, name, dir, label, email) -> the set of instance nums. An
    unresolvable ref is a ValueError: a filter that silently matches nothing is how work
    lands on the account it was meant to avoid."""
    out = set()
    for r in refs:
        inst = hydralib.resolve_instance(fleet_data, r)
        if not inst:
            raise ValueError(f"no instance matches {r!r}")
        out.add(inst.get("num"))
    return out


def rank_targets(exclude: list[str] | None = None, only: list[str] | None = None,
                 open_closed: bool = False) -> dict:
    """The accounts that may take a chat, best room first: OPEN instances first (in room
    order), then - only with open_closed - the closed ones. Returns {"targets": [...],
    "source": survey|cache-fallback|unavailable, "skipped": [why each other account was
    left out]} so a short list is explainable."""
    survey, source = balance.usage_rows_with_fallback()
    fleet_data = hydralib.fleet()
    only_nums = _resolve_nums(fleet_data, only or [])
    excl_nums = _resolve_nums(fleet_data, exclude or [])
    ranked = balance.rank_next(balance.accounts_overview(survey, fleet_data))
    targets: list[dict] = []
    skipped: list[dict] = []
    seen_nums = set()
    for acct in ranked:
        ti = balance._target_instance(acct)
        inst = hydralib.resolve_instance(fleet_data, str(ti.get("name"))) if ti else None
        if not inst:
            skipped.append({"account": acct.get("email"), "why": "no signed-in instance"})
            continue
        num = inst.get("num")
        seen_nums.add(num)
        label = f"#{num} {inst.get('name')}"
        if only_nums and num not in only_nums:
            skipped.append({"instance": label, "why": "not in --only"})
            continue
        if num in excl_nums:
            skipped.append({"instance": label, "why": "--exclude"})
            continue
        if acct.get("mustOpen") and not open_closed:
            skipped.append({"instance": label, "why": "closed (pass --open-closed to use it)"})
            continue
        targets.append({
            "num": num, "name": inst.get("name"), "dir": inst.get("dir"),
            "email": acct.get("email"), "plan": acct.get("plan"),
            "roomPct": acct.get("roomPct"), "peakPct": acct.get("peakPct"),
            "isRunning": bool(inst.get("isRunning")), "mustOpen": bool(acct.get("mustOpen")),
        })
    # Accounts the ranking dropped (no room, unknown reading) are named too, so "only two
    # targets" never reads as "only two accounts exist".
    for inst in fleet_data.get("instances", []):
        if inst.get("num") in seen_nums:
            continue
        skipped.append({"instance": f"#{inst.get('num')} {inst.get('name')}",
                        "why": "no room, or no fresh successful usage reading"})
    return {"targets": targets, "source": source, "skipped": skipped}


def plan(tasks: list[dict], targets: list[dict], per_account: int = 1) -> list[dict]:
    """Round-robin the tasks over the targets, at most `per_account` each, best room first:
    task 1 -> best, task 2 -> next, ... and only when every target has one does a second
    round start. A task with no target left is UNASSIGNED (target None), reported, never
    dropped."""
    cap = max(1, int(per_account or 1))
    taken = {t["num"]: 0 for t in targets}
    out = []
    cursor = 0
    for i, task in enumerate(tasks):
        chosen = None
        for _ in range(len(targets)):
            cand = targets[cursor % len(targets)] if targets else None
            cursor += 1
            if cand and taken[cand["num"]] < cap:
                chosen = cand
                taken[cand["num"]] += 1
                break
        out.append({"index": i, "task": task, "target": chosen})
    return out


# --- spawning --------------------------------------------------------------------------------

def _open_and_wait(target: dict, *, clock=time.monotonic, sleep=time.sleep) -> str | None:
    """Open a closed instance and wait for it to report running. Returns None when it is up,
    else why not.

    Look first, sleep after, never past the deadline, and look ONE more time once it has passed.
    The old loop tested the clock before each look, so an instance that came up during the last
    sleep was reported as never running - a verdict that depended on where the wall clock fell,
    not on the instance. `clock` (monotonic: a clock step cannot shorten or stretch the wait) and
    `sleep` are injectable so a test drives the wait without waiting."""
    try:
        import urllib.parse
        hydralib.api_post(f"/api/instances/{urllib.parse.quote(str(target['dir']), safe='')}/open")
    except hydralib.DaemonError as err:
        return f"open failed: {err.detail or err}"
    deadline = clock() + OPEN_WAIT_SECS
    while True:
        try:
            inst = hydralib.resolve_instance(hydralib.fleet(), str(target["num"]))
        except hydralib.DaemonError:
            inst = None
        if inst and inst.get("isRunning"):
            return None
        left = deadline - clock()
        if left <= 0:
            return f"opened, but not running after {OPEN_WAIT_SECS}s"
        sleep(min(OPEN_POLL_SECS, left))


def _member(assignment: dict) -> dict:
    task = assignment["task"]
    target = assignment["target"]
    return {
        "index": assignment["index"],
        "title": task["title"],
        "folder": task["folder"],
        "prompt": task["prompt"],
        "instance": (f"#{target['num']} {target['name']}" if target else None),
        "instanceNum": target["num"] if target else None,
        "sessionId": None,
        "state": "planned" if target else "unassigned",
        "why": None if target else "no account with room left for this task",
    }


def _spawn_state(res: dict) -> tuple[str, str | None]:
    if not res.get("ok"):
        return "refused", str(res.get("why") or "spawn refused")
    if not res.get("sessionId"):
        return "not-registered", (f"the app never registered a new session (submitted: "
                                  f"{res.get('submitted')}; {res.get('submitNote') or ''})".strip())
    started = str(res.get("started") or "")
    if started.startswith("running"):
        return "spawned", None
    return "spawned-unconfirmed", f"registered, but the first turn is not confirmed: {started}"


def spawn_group(spec: dict, assignments: list[dict], force: bool = False,
                dry_run: bool = False) -> dict:
    """Spawn every assigned task, one at a time, recording the group after each so a crash
    half-way still leaves a readable record. Dry run: the plan only, nothing written."""
    group = {
        "id": _new_group_id(), "name": spec.get("group"), "createdAt": _now_iso(),
        "dryRun": bool(dry_run), "members": [_member(a) for a in assignments], "sends": [],
    }
    if dry_run:
        return group
    _upsert(group)
    spawned_ids: set = set()
    for a, m in zip(assignments, group["members"]):
        target = a["target"]
        if not target:
            continue
        if not force:
            # THE FLEET DOUBLE-CHECK, minus this group's own members (a shared prompt across
            # the group's tasks is the point of a fan-out, not a duplicate).
            try:
                dups = hydralib.same_task_chats(m["prompt"], exclude=spawned_ids)
            except hydralib.DaemonError as err:
                dups = []
                m["note"] = f"duplicate check failed ({err.detail or err}); spawned anyway"
            if dups:
                d = dups[0]
                m["state"] = "refused-duplicate"
                m["why"] = (f"a chat for this exact task already exists: '{d.get('title')}' in "
                            f"{d.get('instance')} ({'running' if d.get('live') else 'dormant'})"
                            " - --force is a person's word to insist")
                m["duplicateOf"] = dups
                _upsert(group)
                continue
        if target.get("mustOpen") or not target.get("isRunning"):
            why = _open_and_wait(target)
            if why:
                m["state"] = "open-failed"
                m["why"] = why
                _upsert(group)
                continue
            m["opened"] = True
        # force=True here lifts ONLY spawn_chat's own duplicate check, which this loop has
        # already run with the group's members excluded; every other rail in spawn() stays.
        try:
            res = spawn_chat.spawn(m["folder"], m["prompt"], str(target["num"]), force=True)
        except hydralib.DaemonError as err:
            res = {"ok": False, "why": f"daemon failure during spawn: {err.detail or err}"}
        m["state"], m["why"] = _spawn_state(res)
        m["sessionId"] = res.get("sessionId")
        m["spawn"] = {k: res.get(k) for k in ("started", "submitted", "submitNote", "landedIn",
                                              "modeSet", "trustDialog", "window")
                      if k in res}
        m["spawnedAt"] = _now_iso()
        if m["sessionId"]:
            spawned_ids.add(m["sessionId"])
        _upsert(group)
    return group


def spawn_exit_code(group: dict) -> int:
    members = group.get("members", [])
    spawned = [m for m in members if m.get("state") == "spawned"]
    with_session = [m for m in members if m.get("sessionId")]
    if not with_session:
        return 2
    if len(spawned) == len(members):
        return 0
    return 4


# --- status ----------------------------------------------------------------------------------

def _load_row_and_live(out: dict, sid: str) -> tuple[dict | None, object]:
    """Reads the session row and liveness for sid, recording any read failure onto out
    (liveness's own failure note wins if both reads fail, matching the original order)."""
    row = None
    try:
        row = hydralib.session_row(sid)
    except hydralib.DaemonError as err:
        out["note"] = f"session read failed: {err.detail or err}"
    try:
        live = hydralib.live_for(sid)
        out["liveKnown"] = True
    except hydralib.DaemonError as err:
        live = None
        out["liveKnown"] = False
        out["note"] = f"liveness unread: {err.detail or err}"
    return row, live


def _unknown_liveness_status(out: dict, tp: str | None) -> dict:
    """Fills the report for a session whose liveness could not be determined."""
    # LIVENESS UNKNOWN IS NOT "NOT LIVE" (hydralib.live_for's own contract; review
    # 2026-09-05): gating with live=None would print a confident finished/crashed verdict
    # for a chat that may still be working. Report the last words, never a verdict.
    out["state"] = "unknown"
    out["quietSecs"] = gatelib.quiet_secs_of(tp) if tp else None
    try:
        text = gatelib.last_assistant_text(gatelib.read_records(tp)) if tp else ""
    except OSError:
        text = ""
    out["lastText"] = text[-LAST_TEXT_CHARS:] if text else ""
    return out


def _finalize_gated_status(out: dict, tp: str, verdict: dict) -> dict:
    """Fills the report fields derived from a completed gate verdict."""
    out["quietSecs"] = verdict.get("quiet_secs")
    if verdict.get("state") == "running":
        out["state"] = ("stalled" if verdict.get("stalled")
                        else "idle" if verdict.get("idle") else "working")
    else:
        out["state"] = verdict.get("state")  # finished | crashed
    out["cause"] = verdict.get("cause")
    fin = verdict.get("finished") or {}
    if fin:
        out["doneClaim"] = fin.get("done_claim")
        out["endsWithQuestion"] = fin.get("ends_with_question")
    try:
        text = gatelib.last_assistant_text(gatelib.read_records(tp))
    except OSError:
        text = ""
    out["lastText"] = text[-LAST_TEXT_CHARS:] if text else ""
    return out


def _member_status(m: dict) -> dict:
    sid = m.get("sessionId")
    out = {"index": m.get("index"), "title": m.get("title"), "instance": m.get("instance"),
           "sessionId": sid, "spawnState": m.get("state"), "why": m.get("why")}
    if not sid:
        out["state"] = m.get("state")
        return out
    if m.get("deleted"):
        out["state"] = "deleted"
        out["trash"] = (m.get("deleteReport") or {}).get("trash")
        return out
    row, live = _load_row_and_live(out, sid)
    tp = (row or {}).get("transcript_path") or gatelib.find_transcript_on_disk(sid)
    out["chatTitle"] = (row or {}).get("title")
    if not out["liveKnown"]:
        return _unknown_liveness_status(out, tp)
    verdict = gatelib.gate(sid, tp, live) if tp else None
    if verdict is None:
        out["state"] = "ungateable" if tp else "unknown"
        out["quietSecs"] = None
        return out
    return _finalize_gated_status(out, tp, verdict)


def status(group: dict) -> dict:
    members = [_member_status(m) for m in group.get("members", [])]
    counts: dict[str, int] = {}
    for m in members:
        counts[m.get("state") or "?"] = counts.get(m.get("state") or "?", 0) + 1
    return {"id": group["id"], "name": group.get("name"), "createdAt": group.get("createdAt"),
            "dryRun": group.get("dryRun", False), "counts": counts, "members": members,
            "sends": group.get("sends", [])}


# --- send ------------------------------------------------------------------------------------

def _quiesce(sid: str) -> dict:
    """Stop the member's IDLE engine so the daemon's message route reaches the app's
    composer (the docstring says why the peer pipe is not a send for a spawned chat). Returns
    {state: not-live | stopped | refused | unknown, ...}. A working or stuck engine is never
    touched: that is `refused`, with enginelib's reason, and the caller skips the member."""
    try:
        matches = hydralib.dossier(sid)
    except hydralib.DaemonError as err:
        return {"state": "unknown", "why": f"dossier unreadable: {err.detail or err}"}
    match = next((m for m in matches
                  if m.get("cliSessionId") == sid or sid in (m.get("lineageIds") or [])), None)
    if match is None and len(matches) == 1:
        match = matches[0]
    live = (match or {}).get("live")
    if live is None:
        return {"state": "not-live"}
    bg = enginelib.background_work(match)
    quiet = (enginelib.NOW_QUIET_SECS if bg.get("scanned") and not bg.get("outstanding")
             else enginelib.IDLE_STOP_SECS)
    rep = enginelib.stop_idle_engine(match, min_quiet_secs=quiet)
    if (not rep.get("stopped") and rep.get("reason") == enginelib.R_TOO_SOON
            and 0 < int(rep.get("needs_secs") or 0) <= 60):
        time.sleep(int(rep["needs_secs"]) + 1)
        rep = enginelib.stop_idle_engine(match, min_quiet_secs=quiet)
    if rep.get("stopped"):
        return {"state": "stopped", "pid": rep.get("pid"), "why": rep.get("why")}
    return {"state": "refused", "reason": rep.get("reason"), "why": rep.get("why")}


def _short_last_line(sid: str) -> str:
    """The chat's last on-screen line when it is SHORTER than the route's own verify floor
    (10 characters), else "". The composer send proves it found the right pane by matching a
    line of the chat's own last words; the route derives that from the transcript and refuses
    to type blind when every line is too short - which is exactly what a terse reply ("PONG",
    "Done.") looks like. A supplied short line is the route's documented placeholder for that
    case; a long one is never supplied, so the route's own derivation stays in charge."""
    try:
        row = hydralib.session_row(sid)
    except hydralib.DaemonError:
        row = None
    tp = (row or {}).get("transcript_path") or gatelib.find_transcript_on_disk(sid)
    if not tp:
        return ""
    try:
        text = gatelib.last_assistant_text(gatelib.read_records(tp))
    except OSError:
        return ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return ""
    last = re.sub(r"[`*_#>]", "", lines[-1]).strip()
    return last if 0 < len(last) < 10 else ""


def send(group: dict, text: str, only: list[str] | None = None, force: bool = False) -> dict:
    """One follow-up into every member with a session (or the `only` ones): the member's idle
    engine is stopped first (_quiesce), then the daemon's message route boots the chat through
    the app's own composer and confirms the turn from the transcript. Holds are respected
    unless --force (a person's word)."""
    only_set = {s.strip() for s in (only or []) if s.strip()}
    results = []
    for m in group.get("members", []):
        sid = m.get("sessionId")
        if not sid:
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": None,
                            "delivered": False, "skipped": "no session"})
            continue
        if only_set and sid not in only_set:
            continue
        if m.get("deleted"):
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "skipped": "deleted"})
            continue
        held = holdlib.why_blocked(sid)
        if held and not force:
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "skipped": held})
            continue
        eng = _quiesce(sid)
        if eng.get("state") == "refused":
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "engine": eng,
                            "skipped": f"engine {eng.get('reason')}: {eng.get('why')}"})
            continue
        body = {"text": text, "confirm_secs": SEND_CONFIRM_SECS, "allow_stop_idle": True}
        short = _short_last_line(sid)
        if short:
            body["verify_text"] = short
        try:
            got = hydralib.api_post(f"/api/sessions/{sid}/message", body,
                                    timeout=SEND_CONFIRM_SECS + 150)
            got = got if isinstance(got, dict) else {}
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": bool(got.get("delivered")), "route": got.get("route"),
                            "detail": got.get("detail"), "engine": eng})
        except hydralib.DaemonError as err:
            detail = f"{err.detail or err}"
            entry = {"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                     "delivered": False, "error": detail, "engine": eng}
            if "no desktop chat holds" in detail:
                # Measured 2026-09-04: a spawned chat answered, its app logged the session
                # mapping, and wrote no local_*.json for minutes - the row exists only in the
                # app's memory, and the daemon's route finds a chat by that record.
                entry["hint"] = ("the app has not written this chat's record to disk yet (it "
                                 "renders the row from memory); retry once it has, or open the "
                                 "chat in the app once")
            elif "already holds text" in detail:
                entry["hint"] = ("the chat's composer holds a draft that is not ours; the "
                                 "actuator never overwrites one - clear it in the app, then retry")
            results.append(entry)
    record = {"at": _now_iso(), "text": text[:200], "results": results}
    group.setdefault("sends", []).append(record)
    _upsert(group)
    return record


def send_exit_code(record: dict) -> int:
    attempted = [r for r in record["results"] if not r.get("skipped")]
    if not attempted:
        return 2
    return 0 if all(r.get("delivered") for r in attempted) else 4


# --- delete ----------------------------------------------------------------------------------

def delete_group(group: dict, force: bool = False) -> dict:
    """delete_chat.py on every member this group spawned: engine stopped if idle, the app's
    own Delete where the app runs, record + transcript gone everywhere, undo copy first."""
    results = []
    for m in group.get("members", []):
        sid = m.get("sessionId")
        base = {"index": m.get("index"), "title": m.get("title"), "sessionId": sid}
        if not sid:
            results.append({**base, "deleted": False, "skipped": "no session"})
            continue
        if m.get("deleted"):
            results.append({**base, "deleted": True, "skipped": "already deleted"})
            continue
        try:
            # the instance this group spawned the chat into: the app that renders it even
            # before its record reaches the disk
            res = delete_chat.delete(sid, stop_idle=True, force=force,
                                     instance_hint=(str(m["instanceNum"])
                                                    if m.get("instanceNum") else None))
        except hydralib.DaemonError as err:
            res = {"ok": False, "code": 1, "why": f"daemon failure: {err.detail or err}"}
        m["deleted"] = bool(res.get("ok"))
        m["deleteReport"] = {k: res.get(k) for k in ("code", "why", "trash", "remaining", "ui",
                                                     "engine", "note") if k in res}
        results.append({**base, "deleted": bool(res.get("ok")), "code": res.get("code"),
                        "why": res.get("why"), "remaining": res.get("remaining"),
                        "trash": res.get("trash"), "note": res.get("note")})
    with_session = [r for r in results if r.get("sessionId")]
    if with_session and all(r.get("deleted") for r in with_session):
        group["deletedAt"] = _now_iso()
    _upsert(group)
    return {"id": group["id"], "name": group.get("name"), "results": results}


def delete_exit_code(record: dict) -> int:
    attempted = [r for r in record["results"] if r.get("sessionId") and not r.get("skipped")]
    if not attempted:
        return 2
    return 0 if all(r.get("deleted") for r in attempted) else 4


# --- CLI -------------------------------------------------------------------------------------

def _take_values(argv: list[str], flag: str) -> list[str]:
    out = []
    i = 0
    while i < len(argv):
        if argv[i] == flag and i + 1 < len(argv):
            out.append(argv[i + 1])
            i += 2
            continue
        i += 1
    return out


def _take_value(argv: list[str], flag: str) -> str | None:
    vals = _take_values(argv, flag)
    return vals[-1] if vals else None


def _positional(argv: list[str]) -> list[str]:
    """Words that are neither flags nor a flag's value."""
    valued = {"--spec", "--per-account", "--exclude", "--only", "--text"}
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in valued:
            i += 2
            continue
        if a.startswith("--"):
            i += 1
            continue
        out.append(a)
        i += 1
    return out


def _print_plan(group: dict, ranking: dict) -> None:
    print(f"fan-out {group['id']}{' (' + group['name'] + ')' if group.get('name') else ''}"
          f"{' - DRY RUN, nothing spawned' if group.get('dryRun') else ''}")
    print(f"  targets from the {ranking.get('source')} usage survey: "
          + ", ".join(f"#{t['num']} {t['name']} (room {t['roomPct']}%"
                      f"{', closed' if t.get('mustOpen') else ''})" for t in ranking["targets"])
          if ranking["targets"] else "  targets: NONE - no account has room")
    for m in group["members"]:
        line = f"  [{m['index']}] {m['title'][:50]:<50} -> {m.get('instance') or 'UNASSIGNED'}"
        line += f"  {m['state']}"
        if m.get("sessionId"):
            line += f"  {m['sessionId']}"
        if m.get("why"):
            line += f"  ({m['why'][:120]})"
        print(line)


def _print_status(s: dict) -> None:
    print(f"fan-out {s['id']}{' (' + s['name'] + ')' if s.get('name') else ''} "
          f"created {s.get('createdAt')}: " + ", ".join(f"{k} {v}" for k, v in s["counts"].items()))
    for m in s["members"]:
        line = f"  [{m['index']}] {m['title'][:40]:<40} {m.get('instance') or '-':<22} {m.get('state')}"
        if m.get("quietSecs") is not None:
            line += f"  quiet {m['quietSecs']}s"
        if m.get("cause"):
            line += f"  - {m['cause'][:80]}"
        print(line)
        if m.get("lastText"):
            tail = m["lastText"].strip().splitlines()
            print("      " + (tail[-1][:140] if tail else ""))
        elif m.get("why"):
            print(f"      {m['why'][:140]}")


def _cmd_list(as_json: bool) -> int:
    """Prints every recorded fan-out group as one summary line (or as JSON rows)."""
    rows = [{"id": g["id"], "name": g.get("name"), "createdAt": g.get("createdAt"),
             "dryRun": g.get("dryRun", False),
             "members": len(g.get("members", [])),
             "spawned": sum(1 for m in g.get("members", []) if m.get("sessionId")),
             "sends": len(g.get("sends", []))} for g in groups()]
    if as_json:
        print(json.dumps({"groups": rows}, indent=2))
    else:
        for r in rows:
            print(f"{r['id']}  {r.get('name') or '-':<24} {r['createdAt']}  "
                  f"{r['spawned']}/{r['members']} spawned, {r['sends']} sends")
        if not rows:
            print("no fan-outs recorded")
    return 0


def _cmd_status(words: list[str], as_json: bool) -> int:
    """Looks up the named group and prints its members' current status."""
    group = find_group(words[1] if len(words) > 1 else None)
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    s = status(group)
    if as_json:
        print(json.dumps(s, indent=2))
    else:
        _print_status(s)
    return 0


def _cmd_send(argv: list[str], words: list[str], as_json: bool, force: bool) -> int:
    """Validates the send arguments, then delivers the text and reports per-member results."""
    text = _take_value(argv, "--text")
    if len(words) < 2 or not text or not text.strip():
        print(__doc__.strip(), file=sys.stderr)
        return 3
    group = find_group(words[1])
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    record = send(group, text.strip(), _take_values(argv, "--only"), force=force)
    if as_json:
        print(json.dumps({"id": group["id"], **record}, indent=2))
    else:
        for r in record["results"]:
            print(f"  [{r.get('index')}] {str(r.get('title'))[:40]:<40} "
                  f"{'delivered' if r.get('delivered') else 'NOT delivered'}"
                  f"  {r.get('route') or ''} {r.get('skipped') or r.get('error') or r.get('detail') or ''}")
    return send_exit_code(record)


def _cmd_delete(words: list[str], as_json: bool, force: bool) -> int:
    """Looks up the named group and deletes its spawned members, reporting the outcome."""
    if len(words) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    group = find_group(words[1])
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    record = delete_group(group, force=force)
    if as_json:
        print(json.dumps(record, indent=2))
    else:
        for r in record["results"]:
            print(f"  [{r.get('index')}] {str(r.get('title'))[:40]:<40} "
                  f"{'deleted' if r.get('deleted') else 'NOT deleted'}"
                  f"  {r.get('skipped') or r.get('why') or ''}"
                  f"{'  STILL THERE: ' + '; '.join(r['remaining']) if r.get('remaining') else ''}")
    return delete_exit_code(record)


def _cmd_spawn(argv: list[str], force: bool, as_json: bool) -> int:
    """Parses --spec, ranks targets, plans assignments, and spawns the new fan-out group."""
    spec_raw = _take_value(argv, "--spec")
    if not spec_raw:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        spec = parse_spec(spec_raw)
        per_account = int(_take_value(argv, "--per-account") or 1)
        ranking = rank_targets(exclude=_take_values(argv, "--exclude"),
                               only=_take_values(argv, "--only"),
                               open_closed="--open-closed" in argv)
    except ValueError as err:
        print(f"REFUSED: {err}", file=sys.stderr)
        return 3
    assignments = plan(spec["tasks"], ranking["targets"], per_account)
    group = spawn_group(spec, assignments, force=force, dry_run="--dry-run" in argv)
    if as_json:
        print(json.dumps({**group, "targets": ranking["targets"],
                          "skippedTargets": ranking["skipped"],
                          "usageSource": ranking["source"]}, indent=2))
    else:
        _print_plan(group, ranking)
    if group.get("dryRun"):
        return 0 if all(m.get("state") == "planned" for m in group["members"]) else 4
    return spawn_exit_code(group)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    words = _positional(argv)
    cmd = words[0] if words and words[0] in ("list", "status", "send", "delete") else None

    try:
        if cmd == "list":
            return _cmd_list(as_json)
        if cmd == "status":
            return _cmd_status(words, as_json)
        if cmd == "send":
            return _cmd_send(argv, words, as_json, force)
        if cmd == "delete":
            return _cmd_delete(words, as_json, force)
        return _cmd_spawn(argv, force, as_json)
    except hydralib.DaemonError as err:
        print(f"fan_out FAILED: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
