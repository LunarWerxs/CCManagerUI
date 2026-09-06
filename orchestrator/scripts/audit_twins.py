#!/usr/bin/env python3
"""audit_twins.py - OBSERVE (+`--fix`): is any chat VISIBLE in two places at once?

THE COMPLAINT (owner, 2026-09-01: "it's also duplicating chats"). He was right, and the
mechanism is specific: firing the app's own `claude://resume?session=` deeplink at a profile
that ALREADY carries that chat makes the app create a SECOND desktop entry - a new chatId, the
same conversation. Measured live that day: 4 chats fleet-wide with two visible records, one of
them twice inside a single instance.

WHY A DUPLICATE IS WORSE THAN CLUTTER: the sidebar actuator identifies a row by its TITLE, and
correctly refuses to guess between two identical ones. So the moment a twin exists, that chat
can no longer be archived, renamed or delivered to through the app at all - it becomes
permanently unmanageable, and every later attempt reports an honest failure that reads like a
different bug.

THE TWO RULES FOR DECIDING WHICH COPY IS REAL, and it refuses when neither applies:
  1. SAME INSTANCE, two records -> the canonical one is the record whose file is named for the
     chat's own cli session id (local_<cliSessionId>.json - the name the app's import gives
     it). Any other file for the same conversation is a re-import artefact.
  2. DIFFERENT INSTANCES -> the daemon's sessions table says which instance the chat now
     belongs to; copies on any other instance are superseded (this is what a migration leaves
     behind when the source app re-saved the archive flag away).

⛔ IT NEVER DELETES ANYTHING. The stale copy is ARCHIVED, which is reversible, and a copy that
holds a LIVE engine is never touched at all.

Usage: python audit_twins.py [--json]      # report only
       python audit_twins.py --fix         # archive the stale copies
Exit:  0 no twins (or all settled) - 2 twins found and not fixed - 1 daemon failure.
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

from lib import armlib, clilib
from lib import hydralib
from lib import ledgerlib
from lib import stamplib

# The per-chat archive lock archive_chat.py holds for its whole act, and its stale window. Twin
# cleanup archives a copy of the SAME chat by a side path, so it takes the SAME lock: two
# lanes never drive Archive on one conversation at once (audit AH-32).
ARCHIVE_LOCK_STALE_SECS = 300


def _live_session_ids() -> set[str] | None:
    """The daemon's live session ids, or None when the daemon could not be asked. None is
    NOT an empty set: "nobody is live" and "I could not look" must never read alike to a lane
    that archives on the strength of the answer (audit AH-02/AH-32)."""
    try:
        return {s.get("sessionId")
                for s in hydralib.api_get("/api/sessions/live").get("sessions", [])}
    except hydralib.DaemonError:
        return None


def _visible_records_by_cli(fleet: dict) -> dict[str, list[dict]]:
    """Every un-archived desktop record, grouped by its raw cli session id."""
    by_cli: dict[str, list[dict]] = defaultdict(list)
    for store in stamplib.store_roots(fleet):
        for path, meta in stamplib.iter_metas(store["root"]):
            if meta.get("isArchived"):
                continue
            cli = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            by_cli[cli].append({"instance": store["instance"], "path": str(path),
                                "stem": path.stem, "title": meta.get("title") or "",
                                "createdAt": int(meta.get("createdAt") or 0)})
    return by_cli


def _uf_find(parent: dict[str, str], x: str) -> str:
    while parent.setdefault(x, x) != x:
        x = parent[x]
    return x


def _uf_union(parent: dict[str, str], a: str, b: str) -> None:
    ra, rb = _uf_find(parent, a), _uf_find(parent, b)
    if ra != rb:
        parent[rb] = ra


def _merge_by_lineage(by_cli: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """THE LINEAGE IS THE CONVERSATION, NOT THE ID (2026-09-01): a compaction or a resume rolls
    the cli session id, and the daemon keeps the chain in the dossier's lineageIds. Two
    visible records with different ids but one lineage are one chat seen twice - grouping
    by the raw id alone reported "nothing duplicated" while the owner looked at the pair."""
    parent: dict[str, str] = {}
    for cli in list(by_cli):
        try:
            for m in hydralib.dossier(cli):
                for lid in (m.get("lineageIds") or []) + (m.get("priorCliSessionIds") or []):
                    _uf_union(parent, cli, str(lid))
        except hydralib.DaemonError:
            continue
    merged: dict[str, list[dict]] = defaultdict(list)
    for cli, copies in by_cli.items():
        merged[_uf_find(parent, cli)].extend(copies)
    return merged


def _pick_keeper(cli: str, copies: list[dict], home: str | None) -> dict | None:
    """THE TWO RULES FOR DECIDING WHICH COPY IS REAL: same-instance settles on the file named
    for the chat's own cli session id; otherwise the daemon's home instance wins (rule 2 first,
    since it is checked below before falling back to the canonical filename alone)."""
    canonical_name = f"local_{cli}"
    # Rule 2 first: the daemon knows which account the chat belongs to now.
    if home and any(c["instance"] == home for c in copies):
        on_home = [c for c in copies if c["instance"] == home]
        # ...and rule 1 settles a same-instance pair.
        keep = next((c for c in on_home if c["stem"] == canonical_name), None)
        if keep is None and len(on_home) == 1:
            keep = on_home[0]
        return keep
    return next((c for c in copies if c["stem"] == canonical_name), None)


def _build_twin(cli: str, copies: list[dict], keep: dict | None,
                live_ids: set[str] | None) -> dict:
    return {
        "cliSessionId": cli, "title": copies[0]["title"],
        "copies": copies, "keep": keep,
        "stale": [c for c in copies if keep and c["path"] != keep["path"]],
        # An unreadable live registry makes every conversation LIVE for this pass: the guard
        # then refuses (it cannot trace an engine it cannot see), which is the safe side.
        "live": True if live_ids is None else cli in live_ids,
        "liveUnknown": live_ids is None,
        "why": ("" if keep else
                "cannot tell which copy is real - neither the daemon's instance nor the "
                "canonical filename picks one; settle it by hand"),
    }


def find_twins() -> list[dict]:
    """Every conversation with more than one VISIBLE (un-archived) desktop record."""
    fleet = hydralib.fleet()
    owner = {r.get("session_id"): r.get("instance") for r in hydralib.sessions()}
    live_ids = _live_session_ids()
    by_cli = _merge_by_lineage(_visible_records_by_cli(fleet))

    twins = []
    for cli, copies in by_cli.items():
        if len(copies) < 2:
            continue
        keep = _pick_keeper(cli, copies, owner.get(cli))
        twins.append(_build_twin(cli, copies, keep, live_ids))
    return twins


def find_same_task() -> list[dict]:
    """A DIFFERENT kind of duplicate (owner, 2026-09-01: two identical 'SageThumbs codebase
    review' chats, 30 minutes apart, on two accounts, both running - "we can't have this"):
    two separate conversations that carry the SAME first prompt, i.e. the same task started
    twice. Not a twin record - each is a real chat - so the remedy is a HOLD on the later
    one (no lane feeds it, nothing is killed) and a loud line, never an archive of live work.
    Groups: {task, chats: [{sessionId, title, instance, live, createdAt}], keep, later}."""
    from lib import gatelib

    try:
        live_ids = {s.get("sessionId")
                    for s in hydralib.api_get("/api/sessions/live").get("sessions", [])}
    except hydralib.DaemonError:
        live_ids = set()
    # THE STANDING MANAGERS ARE ONE LANE'S BUSINESS (2026-09-04): they all share one birth
    # prompt by design, so this lane would group them and HOLD every later one - the newest,
    # which is the live overlord. overlord.py names the spares; a person retires them.
    import overlord

    protected = overlord.protected_session_ids()
    rows = []
    for row in hydralib.visible_chats():
        sid = row.get("session_id") or ""
        tp = row.get("transcript_path") or ""
        if not sid or row.get("archived") or not tp or sid in protected:
            continue
        first = gatelib.first_user_prompt(tp)
        if len(gatelib.normalize_task(first)) < 40:
            continue  # a one-liner is not a task signature
        rows.append({"sessionId": sid, "title": row.get("title"), "instance": row.get("instance"),
                     "live": sid in live_ids, "first": first,
                     "createdAt": int(row.get("created_at") or row.get("createdAt") or 0)})
    groups: list[dict] = []
    seen: set[str] = set()
    for i, a in enumerate(rows):
        if a["sessionId"] in seen:
            continue
        same = [a] + [b for b in rows[i + 1:] if b["sessionId"] not in seen
                      and gatelib.same_task(a["first"], b["first"])]
        if len(same) < 2:
            continue
        for c in same:
            seen.add(c["sessionId"])
        # The one to KEEP is the earliest-created; when creation times are unknown, the live
        # one; when both are live, the first seen. The rest are the duplicates.
        ordered = sorted(same, key=lambda c: (c["createdAt"] or 2**62, not c["live"]))
        groups.append({"task": a["first"][:120], "chats": same, "keep": ordered[0],
                       "later": ordered[1:]})
    return groups


def fix_same_task(groups: list[dict]) -> list[dict]:
    from lib import holdlib

    done = []
    for g in groups:
        for c in g["later"]:
            if holdlib.why_blocked(c["sessionId"]):
                done.append({**c, "outcome": "already held"})
                continue
            holdlib.hold(c["sessionId"],
                         f"DUPLICATE TASK of '{g['keep'].get('title')}' ({g['keep'].get('instance')}): "
                         "the same first prompt was started twice; held so no lane feeds it - close it, "
                         "or let it finish and archive it", by="audit_twins")
            done.append({**c, "outcome": f"HELD as a duplicate of '{g['keep'].get('title')}' "
                                         f"({g['keep'].get('instance')})"})
    return done


def fix(twins: list[dict]) -> list[dict]:
    done = []
    hosts = _engine_host_dirs({t["cliSessionId"] for t in twins if t["live"]})
    for t in twins:
        # A HOLD PROTECTS THE CHAT, NOT A STALE DUPLICATE OF IT (owner, 2026-09-01: "there
        # are a few duplicate chats happening... we need some kind of check"). Only the STALE
        # copy is archived; the copy the owner is actually using is left exactly as it is. A
        # held chat that keeps a twin is unactionable by every actuator, which serves nobody.
        if not t["keep"]:
            done.append({**t, "outcome": "REFUSED - " + t["why"]})
            continue
        host = hosts.get(t["cliSessionId"]) if t["live"] else None
        for stale in t["stale"]:
            # ⛔ A LIVE ENGINE IS NEVER TOUCHED (docstring line 24-25) - but the question is
            # WHICH COPY holds it, not whether the conversation has one. That distinction is
            # the whole fix: a landing boots a fresh engine in the TARGET app straight away
            # (enginelib's own note), so a conversation-scoped guard refuses the SOURCE copy
            # forever and every account migration leaves a permanent twin - precisely the
            # state this script exists to clear. An engine traced to another instance's app
            # cannot be the one this copy is holding. An untraceable engine stays refused.
            if t.get("liveUnknown"):
                done.append({**t, "outcome": "REFUSED - the daemon's live registry could not be "
                                             "read; liveness unknown, never touched",
                             "staleCopy": stale["path"]})
                continue
            refusal = _live_copy_refusal(t["live"], host, stale["instance"])
            if refusal:
                done.append({**t, "outcome": "REFUSED - " + refusal, "staleCopy": stale["path"]})
                continue
            # THE DECISION ABOVE IS A SNAPSHOT (audit AH-32): a new engine can start on this
            # copy between it and the archive that follows - and the archive waits on a window
            # mutex for up to 60s and drives an actuator for up to 240s. So: the same per-chat
            # lock archive_chat holds (a concurrent archive of this chat defers us), and the
            # liveness question asked AGAIN once the window is ours, immediately before the act.
            recheck = _recheck_for(t["cliSessionId"], stale["instance"])
            with ledgerlib.try_locked(f"archive-{t['cliSessionId']}",
                                      stale_secs=ARCHIVE_LOCK_STALE_SECS) as ours:
                if not ours:
                    done.append({**t, "outcome": "DEFERRED - an archive of this chat is already "
                                                 "in progress (its archive lock is held); next pass",
                                 "staleCopy": stale["path"]})
                    continue
                said = _archive_copy(stale["instance"], stale["path"], t["title"], recheck=recheck)
            done.append({**t, "outcome": said, "staleCopy": stale["path"]})
    return done


def _live_copy_refusal(live: bool, host_dir: str | None, instance: str) -> str:
    """Why this STALE copy may not be archived, or '' when it may."""
    if not live:
        return ""
    if not host_dir:
        return "live chat whose engine could not be traced to an app, never touched"
    _, inst_dir = _app_running(instance)
    if inst_dir and Path(inst_dir).resolve() == Path(host_dir).resolve():
        return f"live chat - its engine runs under {instance}, never touched"
    return ""


def _recheck_for(cli: str, instance: str):
    """A closure that re-asks, from scratch, whether this copy may be archived RIGHT NOW: a
    fresh live-registry read and a fresh engine trace. Returns the refusal, or '' to proceed.
    Called after the window mutex is acquired and before the actuator (or the disk flag) runs,
    so the decision the act rests on is seconds old, not a lock-wait old."""
    def recheck() -> str:
        live_ids = _live_session_ids()
        if live_ids is None:
            return "the daemon's live registry could not be read at act time; liveness unknown"
        if cli not in live_ids:
            return ""
        host = _engine_host_dirs({cli}).get(cli)
        return _live_copy_refusal(True, host, instance)
    return recheck


def _engine_host_dirs(cli_ids: set[str]) -> dict[str, str]:
    """{cli session id: the --user-data-dir of the app whose engine it is}.

    The daemon says a conversation is live; it does not say which of its duplicate records
    is the live one, and after a migration the obvious guess is the wrong one. The engine's
    own process ancestry settles it without guessing: a chat's claude.exe is a child of its
    instance's Electron host, and that host carries the instance's --user-data-dir on its
    command line. A chain that cannot be walked yields nothing, and nothing means refuse.
    """
    if not cli_ids:
        return {}
    try:
        live = hydralib.api_get("/api/sessions/live").get("sessions", [])
    except hydralib.DaemonError:
        return {}
    pids = {str(s.get("sessionId")): int(s.get("pid") or 0)
            for s in live if str(s.get("sessionId")) in cli_ids and s.get("pid")}
    if not pids:
        return {}
    tree = _claude_process_tree()
    out = {}
    for cli, pid in pids.items():
        seen: set[int] = set()
        while pid in tree and pid not in seen:
            seen.add(pid)
            parent, cmdline = tree[pid]
            udd = _user_data_dir(cmdline)
            if udd:
                out[cli] = udd
                break
            pid = parent
    return out


def _claude_process_tree() -> dict[int, tuple[int, str]]:
    """{pid: (parent pid, command line)} for every claude.exe - engine AND Electron host."""
    import subprocess

    cmd = ("Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | "
           "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress")
    try:
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
            timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    try:
        # strict=False: a real command line can carry a raw control character, and one of
        # them made the whole tree unreadable (so every engine was "untraceable" and every
        # stale copy was refused - a silent, total failure that looked like a policy).
        rows = json.loads(r.stdout or "", strict=False)
    except ValueError:
        return {}
    if isinstance(rows, dict):
        rows = [rows]
    tree = {}
    for row in rows:
        try:
            tree[int(row["ProcessId"])] = (int(row["ParentProcessId"] or 0),
                                           str(row.get("CommandLine") or ""))
        except (KeyError, TypeError, ValueError):
            continue
    return tree


def _user_data_dir(cmdline: str) -> str:
    """The --user-data-dir an Electron host was started with ('' when it carries none)."""
    key = "--user-data-dir"
    if key not in cmdline:
        return ""
    rest = cmdline.split(key, 1)[1].lstrip("= ")
    if rest.startswith('"'):
        return rest[1:].split('"', 1)[0].strip()
    cut = rest.find(" --")
    return (rest[:cut] if cut >= 0 else rest).strip()


_ACTUATOR = Path(__file__).resolve().parent / "actuator" / "manage_desktop_chat.ps1"


def _app_running(instance: str) -> tuple[bool, str]:
    """(is that instance's app running, its --user-data-dir)."""
    try:
        for i in hydralib.fleet().get("instances", []):
            if str(i.get("name", "")).lower() == str(instance).lower():
                return bool(i.get("isRunning")), str(i.get("dir") or "")
    except hydralib.DaemonError:
        pass
    return False, ""


def _drive_archive(inst_dir: str, title: str, recheck=None) -> tuple[int, str]:
    """The app's OWN archive control on the row titled `title` in that window. Exits: 0 done -
    1 error/ambiguity - 2 invoked but the row stayed - 3 not rendered - 7 window busy -
    8 deferred: `recheck()` (asked once the window was OURS, so after any wait) said the copy
    may no longer be touched."""
    import subprocess

    from lib import windowlib

    with windowlib.instance_lock(inst_dir, wait_secs=60) as mine:
        if not mine:
            return 7, "window busy - another lane is driving it; next pass"
        why = recheck() if recheck else ""
        if why:
            return 8, why
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_ACTUATOR),
             "-Instance", inst_dir, "-Action", "Archive", "-Title", str(title)],
            timeout=240)
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-1:][0] if (r.stdout or r.stderr) else f"exit {r.returncode}"


def _flag_archived(path: str) -> str | None:
    """Flip isArchived on one meta record on disk through the shared meta mutator
    (stamplib.mutate_meta, audit AH-18/AH-32): per-record lock, pid-named temp, and a revision
    check right before the replace so a record the app rewrote underneath us is re-read rather
    than clobbered. The read-back is what earns the word "archived"."""
    def _apply(meta: dict) -> bool:
        if meta.get("isArchived") is True:
            return False
        meta["isArchived"] = True
        return True

    r = stamplib.mutate_meta(path, _apply)
    if r["error"]:
        return r["error"]
    if r["meta"] is None or not r["meta"].get("isArchived"):
        return "the flag did not stick (another writer replaced the record)"
    return None


def _archive_copy(instance: str, path: str, title: str, recheck=None) -> str:
    """Archive one stale copy the way the OWNER will actually see it go (2026-09-01, owner:
    "there's still duplicate chats"): a RUNNING app holds its chat list in memory and never
    re-reads the file, so flipping isArchived on disk - all this did until tonight - left the
    row on his screen until a restart he never does. Through the app's own control the row
    disappears now and the app writes the flag itself. A closed app gets the flag (it reads
    it on start). A row the app has not rendered cannot be reached by any control: the flag
    is set and the ghost sweep (find_ghosts) catches it the moment it renders.

    `recheck` (see _recheck_for) is asked immediately before EITHER act - inside the window
    mutex for the app's control, right before the write for the disk flag - and a non-empty
    answer defers the copy untouched."""
    running, inst_dir = _app_running(instance)
    if running and inst_dir:
        code, said = _drive_archive(inst_dir, title, recheck=recheck)
        if code == 0:
            return f"archived the stale copy in {instance} through the app's own control"
        if code == 8:
            return f"DEFERRED - {said}"
        if code == 3:
            why = recheck() if recheck else ""
            if why:
                return f"DEFERRED - {why}"
            err = _flag_archived(path)
            return (f"archived the stale copy in {instance} on disk (its row is not rendered right "
                    "now; the ghost sweep clears it through the app the moment it shows)"
                    if not err else f"could NOT flag the copy in {instance}: {err}")
        return f"the app's control REFUSED the stale copy in {instance}: {said[:160]}"
    why = recheck() if recheck else ""
    if why:
        return f"DEFERRED - {why}"
    err = _flag_archived(path)
    return (f"archived the stale copy in {instance} (app closed: disk flag)" if not err
            else f"could NOT archive the copy in {instance}: {err}")


def find_ghosts() -> list[dict]:
    """ROWS THE OWNER SEES THAT THE DISK SAYS ARE GONE. For every running app: the rendered
    sidebar rows (the actuator's -List) against that instance's metas - a title whose records
    in that instance are ALL archived is a ghost the app is still showing. A title that has
    both an archived and a live record there is ambiguous and is named, never acted on."""
    import subprocess

    fleet = hydralib.fleet()
    ghosts = []
    for inst in fleet.get("instances", []):
        if not inst.get("isRunning") or not inst.get("dir"):
            continue
        name = str(inst.get("name"))
        try:
            r = clilib.run_text(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_ACTUATOR),
                 "-Instance", str(inst["dir"]), "-List"],
                timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            continue
        rendered = []
        for line in (r.stdout or "").splitlines():
            s = line.strip()
            low = s.lower()
            for phrase in ("more options for ", "weitere optionen für ", "weitere optionen fur "):
                if low.startswith(phrase):
                    rendered.append(s[len(phrase):].strip())
                    break
        if not rendered:
            continue
        by_title: dict[str, list[bool]] = defaultdict(list)
        for store in stamplib.store_roots(fleet):
            if str(store["instance"]).lower() != name.lower():
                continue
            for path, meta in stamplib.iter_metas(store["root"]):
                by_title[str(meta.get("title") or "")].append(bool(meta.get("isArchived")))
        for title in rendered:
            flags = by_title.get(title)
            if not flags:
                continue  # no record at all: not ours to judge
            if all(flags):
                ghosts.append({"instance": name, "dir": str(inst["dir"]), "title": title,
                               "records": len(flags), "ambiguous": rendered.count(title) > 1})
    return ghosts


RENAMES_PER_PASS = 3


def find_title_collisions() -> list[dict]:
    """ONE TITLE, SEVERAL CHATS (2026-09-01: four 'Codebase review and prioritization' rows -
    the same prompt template over three repos, one generic auto-title). Not duplicates - the
    same-task rule tells them apart by their prompt bodies - but they look like duplicates to
    the owner, and the app's own controls refuse a title two rows share. Groups of visible,
    un-archived chats with different session ids wearing one exact title; each chat carries
    the repo (its cwd's last folder) that will make its name unique."""
    from lib import holdlib

    from lib import gatelib

    by_title: dict[str, list[dict]] = defaultdict(list)
    for r in hydralib.visible_chats():
        if r.get("archived") or not r.get("session_id"):
            continue
        title = str(r.get("title") or "").strip()
        if not title:
            continue
        cwd = str(r.get("cwd") or "").rstrip("\\/")
        by_title[title].append({"sessionId": r["session_id"], "instance": r.get("instance"),
                                "repo": cwd.replace("\\", "/").rsplit("/", 1)[-1] if cwd else "",
                                "transcript": str(r.get("transcript_path") or ""),
                                "held": bool(holdlib.why_blocked(r["session_id"]))})
    out = []
    for title, chats in by_title.items():
        if len({c["sessionId"] for c in chats}) < 2:
            continue
        # THE HINT that makes each name unique: the chat's folder, unless the colliding
        # chats share it (four 'Codebase review' chats all launched from D:\NEWProjects) -
        # then the repo named INSIDE the first prompt (the last path-shaped word), which is
        # how those four actually differ. No hint, no rename.
        repos = [c["repo"] for c in chats]
        for c in chats:
            hint = c["repo"] if c["repo"] and repos.count(c["repo"]) == 1 else ""
            if not hint and c["transcript"]:
                words = [w.strip("'\".,;:()[]") for w in gatelib.first_user_prompt(c["transcript"]).split()]
                paths = [w for w in words if ("\\" in w or "/" in w) and len(w) > 3]
                if paths:
                    hint = paths[-1].rstrip("\\/").replace("\\", "/").rsplit("/", 1)[-1]
            c["hint"] = hint
        hints = [c["hint"] for c in chats]
        for c in chats:
            if c["hint"] and hints.count(c["hint"]) > 1:
                c["hint"] = ""
        out.append({"title": title, "chats": chats})
    return out


def fix_title_collisions(collisions: list[dict]) -> list[dict]:
    """Rename colliding chats '<title> [<repo>]' through rename_chat (the app's own control,
    verified). Only when the repo makes the name unique; a chat whose repo is unknown, or
    two chats in one repo, are named and left. Capped per pass - a rename selects nothing
    but does drive the window."""
    import overlord
    import rename_chat
    from lib import clilib

    protected = overlord.protected_session_ids()
    done = []
    renamed = 0
    for c in collisions:
        per_instance: dict[str, list[dict]] = defaultdict(list)
        for x in c["chats"]:
            per_instance[str(x.get("instance") or "")].append(x)
        for x in c["chats"]:
            if renamed >= RENAMES_PER_PASS:
                return done
            if x["sessionId"] in protected or not x.get("instance"):
                continue  # the manager, or a console chat no window can rename
            if not x.get("hint"):
                done.append({**x, "title": c["title"],
                             "outcome": f"'{c['title'][:50]}' in {x['instance']}: nothing unique to name it by - left"})
                continue
            new_title = f"{c['title']} [{x['hint']}]"
            if len(per_instance[str(x["instance"])]) > 1:
                # TWO ROWS, ONE WINDOW, ONE TITLE (owner, 2026-09-01: "why does the darog account
                # have two chats both named..."): the app's own control cannot tell them apart by
                # name, so the top row is renamed first (a rename is harmless if it lands on the
                # other twin), the dossier says which chat took the name, and the naming is
                # corrected from there. After the first rename the other row is unique again.
                code, said = _rename_ordinal(x["instance"], c["title"], new_title, 1)
                renamed += 1
                if code != 0:
                    done.append({**x, "title": c["title"],
                                 "outcome": f"rename of a same-titled row in {x['instance']} did not land (exit {code}): {said[:120]}"})
                    continue
                took = _who_has_title(x["instance"], new_title)
                if took and took != x["sessionId"]:
                    other = next((y for y in per_instance[str(x["instance"])] if y["sessionId"] == took), None)
                    if other and other.get("hint") and other["hint"] != x["hint"]:
                        fixed = f"{c['title']} [{other['hint']}]"
                        _rename_ordinal(x["instance"], new_title, fixed, 1)
                        done.append({**other, "title": c["title"],
                                     "outcome": f"renamed to '{fixed}' in {x['instance']} (took the first name, corrected)"})
                        continue
                done.append({**x, "title": c["title"],
                             "outcome": f"renamed the top same-titled row in {x['instance']} to '{new_title}'"})
                continue
            code, said = clilib.capture(rename_chat.main, [x["sessionId"], "--to", new_title]
                                        + (["--force"] if x["held"] else []))
            renamed += 1
            done.append({**x, "title": c["title"],
                         "outcome": (f"renamed to '{new_title}' in {x['instance']}" if code == 0
                                     else f"rename of '{c['title'][:40]}' in {x['instance']} did not land (exit {code}): "
                                          f"{(said.splitlines()[-1] if said else '')[:120]}")})
    return done


def _rename_ordinal(instance: str, title: str, new_title: str, ordinal: int) -> tuple[int, str]:
    """Rename the Nth rendered row (top first) wearing `title`, through the app's control."""
    import subprocess

    from lib import windowlib

    running, inst_dir = _app_running(instance)
    if not running or not inst_dir:
        return 3, f"{instance} is not running"
    with windowlib.instance_lock(inst_dir, wait_secs=60) as mine:
        if not mine:
            return 7, "window busy"
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_ACTUATOR),
             "-Instance", inst_dir, "-Action", "Rename", "-Title", title, "-NewTitle", new_title,
             "-Ordinal", str(ordinal)],
            timeout=240)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    return r.returncode, (out.splitlines()[-1] if out else f"exit {r.returncode}")


def _who_has_title(instance: str, title: str) -> str | None:
    """The session id of the visible chat in `instance` now wearing `title` (the app re-saves
    the record after its own rename), polled briefly."""
    import time as _t

    for _ in range(6):
        _t.sleep(2)
        try:
            for r in hydralib.visible_chats():
                if (str(r.get("instance")) == instance and not r.get("archived")
                        and str(r.get("title") or "").strip() == title):
                    return str(r.get("session_id") or "") or None
        except hydralib.DaemonError:
            return None
    return None


def fix_ghosts(ghosts: list[dict]) -> list[dict]:
    done = []
    for g in ghosts:
        if g.get("ambiguous"):
            done.append({**g, "outcome": "REFUSED - two rendered rows share this title; a person picks"})
            continue
        code, said = _drive_archive(g["dir"], g["title"])
        done.append({**g, "outcome": (f"ghost row archived through the app in {g['instance']}" if code == 0
                                      else f"could NOT clear the ghost in {g['instance']}: {said[:160]}")})
    return done


def _safe_scan(fn, label: str, err_types: tuple = (hydralib.DaemonError,)) -> list[dict]:
    """Run one non-fatal scan step; on its own error types, report and carry on empty."""
    try:
        return fn()
    except err_types as err:
        print(f"audit_twins: {label} scan FAILED: {err}", file=sys.stderr)
        return []


def _resolve_fix_mode(argv: list[str]) -> tuple[bool, bool]:
    """(fix_it, disarmed). THE ARMED WINDOW (owner order, 2026-09-01): unattended acting
    needs a person's open window (`python orch.py arm`) or --force. Disarmed: fall back to
    plan-only and say so - nothing acted is not a failure, so the exit code says so too."""
    if "--fix" not in argv:
        return False, False
    refusal = armlib.refuse_unless_armed(argv, "settling duplicate chat rows")
    if refusal:
        print(refusal)
        return False, True
    return True, False


def _print_ghost_report(ghosts: list[dict], ghost_results: list[dict]) -> None:
    for g in ghost_results:
        print(f"  ghost: [{g['instance']}] {g['title'][:60]} -> {g['outcome']}")
    if ghosts and not ghost_results:
        print(f"{len(ghosts)} ghost row(s) still on screen after the disk said archived:")
        for g in ghosts:
            print(f"  [{g['instance']}] {g['title'][:60]}" +
                  (" (two rows - a person picks)" if g.get("ambiguous") else ""))


def _print_collision_report(collisions: list[dict], collision_results: list[dict]) -> None:
    for c in collision_results:
        print(f"  title: {c['outcome']}")
    if collisions and not collision_results:
        print(f"{len(collisions)} title(s) worn by more than one DIFFERENT chat (a collision, not a duplicate):")
        for c in collisions:
            print(f"  '{c['title'][:60]}' x{len(c['chats'])}: " + ", ".join(
                f"{x['instance'] or 'console'} ({x['repo'] or '?'})" for x in c["chats"]))


def _print_json_report(twins: list[dict], results: list[dict], same_task: list[dict],
                        task_results: list[dict], ghosts: list[dict], ghost_results: list[dict],
                        collisions: list[dict], collision_results: list[dict]) -> None:
    print(json.dumps({"twins": twins, "results": results,
                      "sameTask": same_task, "sameTaskResults": task_results,
                      "ghosts": ghosts, "ghostResults": ghost_results,
                      "collisions": collisions, "collisionResults": collision_results}, indent=2))


def _json_exit_code(disarmed: bool, twins: list[dict], same_task: list[dict], results: list[dict],
                     task_results: list[dict], ghost_results: list[dict]) -> int:
    ok = (disarmed or (not twins and not same_task) or results or task_results or ghost_results)
    return 0 if ok else 2


def _print_same_task_report(same_task: list[dict], task_results: list[dict]) -> None:
    print(f"{len(same_task)} task(s) started MORE THAN ONCE (same first prompt, separate chats):")
    for g in same_task:
        print(f"  {g['task'][:90]}")
        for c in g["chats"]:
            tag = "KEEP " if c is g["keep"] else "DUP  "
            # A console-only copy has no desktop instance: say so instead of leaking
            # a Python None into an owner-facing line (live smoke, 2026-09-01).
            print(f"      [{tag}] {c['instance'] or '(console, no instance)'}: "
                  f"{str(c['title'])[:50]}"
                  f"{' (running)' if c['live'] else ''}")
    for r in task_results:
        print(f"  {r['outcome']}")
    if not task_results:
        print("  -> with --fix the later copy is HELD (never archived while it may be working)")


def _print_twins_report(twins: list[dict], results: list[dict]) -> None:
    print(f"{len(twins)} chat(s) VISIBLE more than once:")
    for t in twins:
        mark = "LIVE " if t["live"] else ""
        print(f"  {mark}{t['title'][:60]}")
        for c in t["copies"]:
            tag = ("KEEP " if t["keep"] and c["path"] == t["keep"]["path"]
                   else "stale" if t["keep"] else "?????")
            print(f"      [{tag}] {c['instance']}: {c['stem'][:30]}")
        if not t["keep"]:
            print(f"      -> {t['why']}")
    for r in results:
        print(f"  {r['outcome']}")
    if not results:
        print("\nREPORT ONLY - add --fix to archive the stale copies (reversible).")
    print("\nNOTE: a stale copy under a RUNNING app is archived through the app's own control, so it "
          "leaves the screen now; a copy the app has not rendered gets the disk flag and the ghost "
          "sweep archives it through the app the moment it shows.")


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    try:
        twins = find_twins()
    except hydralib.DaemonError as err:
        print(f"audit_twins FAILED: {err}", file=sys.stderr)
        return 1
    fix_it, disarmed = _resolve_fix_mode(argv)
    results = fix(twins) if fix_it else []

    same_task = _safe_scan(find_same_task, "same-task")
    task_results = fix_same_task(same_task) if fix_it else []

    # WHAT THE OWNER SEES (2026-09-01: "there's still duplicate chats"): ghost rows a running
    # app still shows after the disk said archived, and different chats wearing one title.
    ghosts = _safe_scan(find_ghosts, "ghost", (hydralib.DaemonError, OSError))
    ghost_results = fix_ghosts(ghosts) if fix_it else []

    collisions = _safe_scan(find_title_collisions, "title")
    collision_results = fix_title_collisions(collisions) if fix_it else []

    _print_ghost_report(ghosts, ghost_results)
    _print_collision_report(collisions, collision_results)

    if "--json" in argv:
        _print_json_report(twins, results, same_task, task_results, ghosts, ghost_results,
                            collisions, collision_results)
        return _json_exit_code(disarmed, twins, same_task, results, task_results, ghost_results)

    if same_task:
        _print_same_task_report(same_task, task_results)
    if not twins:
        if not same_task:
            print("no chat is visible in two places - nothing duplicated.")
        return 0 if (disarmed or not same_task or task_results) else 2

    _print_twins_report(twins, results)
    return 0 if (disarmed or results) else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
