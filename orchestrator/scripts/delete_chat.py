#!/usr/bin/env python3
"""delete_chat.py - ACT: DELETE one chat everywhere it exists - the app's store and the transcript - with an undo copy.

OWNER RULE (2026-09-04): "all ping requests or account identification requests must be deleted
after they are created, and not left in the account." A probe chat - a fan-out drill, a PONG, a
which-account-am-I check - is not work, and archiving it still leaves it in that account's
store. This is the delete, and no probe may be started without it (fan_out delete uses it).

WHAT "EVERYWHERE" MEANS: the desktop app's meta record, in EVERY profile that carries one (a
migrated chat leaves an archived twin behind), the CLI transcript (~/.claude/projects or an
instance's own projects/), which is what makes the chat exist for AgentHydra's session list at
all, and every sidecar named after the session. A session with a transcript but no desktop
record is deletable too - that is exactly what a console probe looks like.

DELETING A CHAT IN THE APP IS NOT THIS (measured 2026-09-04 on both drill chats): the app's own
Delete removes its meta record, kills the engine, writes `<sid>.desktop-released.json`
("reason": "delete") beside the transcript - and leaves the TRANSCRIPT. The chat is gone from
the sidebar and still on the disk, still in AgentHydra's list. This script finishes that job:
the transcript and the marker go too, and a session that has only a marker left still resolves.

THE RAILS, in order:
  - ONE chat (title fragment or session id); ambiguity is a refusal, never a guess.
  - A HOLD is hands-off; --force is a person's word past it.
  - A LIVE WRITER is never deleted under. --stop-idle stops an IDLE engine first, through the
    same enginelib rails migrate_chat uses (never a working or stuck one); without the flag a
    live chat is refused.
  - THE UNDO COPY COMES FIRST: every meta record and the transcript are copied into
    state/trash/<sessionId>/ with a manifest naming where each came from. Only then does
    anything go: the app's OWN Delete control for every RUNNING profile that holds it (the one
    write a running app will not re-save away - a file removed under a running app can come
    back from its memory), then the files themselves, straight away when no app holds them.
    `--undo <sessionId>` puts everything back from the manifest.
  - VERIFIED, never claimed: the dossier must show no record and the transcript must be gone
    (the daemon's meta cache gets a few seconds to notice). Anything left is named.

Usage: python delete_chat.py <chat> [--stop-idle] [--force] [--json]
       python delete_chat.py --undo <sessionId> [--json]
       python delete_chat.py --released [--yes] [--json]   # THE SWEEP: every chat the APP deleted
                                                          # whose transcript or marker is still on
                                                          # disk - listed by default, --yes deletes
Exit:  0 deleted and verified (or nothing to sweep) - 2 partial (something remains; the report
       names it) - 3 refused (not found / ambiguous / held / live writer / bad usage / another
       delete or undo of the same chat still running) - 1 daemon failure.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import time
from pathlib import Path

from lib import clilib, enginelib, gatelib, holdlib, hydralib, ledgerlib, mutationlib
from lib import stamplib, windowlib

ACTUATOR = Path(__file__).resolve().parent / "actuator" / "manage_desktop_chat.ps1"
TRASH = "trash"
# The daemon caches desktop meta for ~15 s; the verify polls that long before it calls a
# lingering record real.
VERIFY_SECS = 25
# ONE delete or undo per chat at a time (audit AH-28, reproduced 2026-09-05): a delete paused
# right after its trash copy while an undo restored the manifest, then went on through its
# unlink loop and removed the just-restored transcript - and BOTH reported success, leaving
# deletion as the final state after an undo. The per-window UI mutex serializes one desktop
# window, not the transcript files, the trash dir, or the undo. This lock covers the whole
# transaction. Stale after 15 minutes: the slowest honest delete is a 60s window wait plus a
# 240s actuator per running profile, then the verify, so a live holder is never mistaken for a
# crashed one and its lock stolen mid-act (the archive lane learned that the hard way at 30s).
DELETE_LOCK_STALE_SECS = 900
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _busy(session_id: str, verb: str) -> dict:
    return {"ok": False, "code": 3, "sessionId": session_id, "deferred": True,
            "why": f"another delete or undo of this chat is still running - {verb} deferred; "
                   "retry once it finishes"}


def trash_dir(session_id: str) -> Path:
    return ledgerlib._state_dir() / TRASH / session_id


# --- what exists -----------------------------------------------------------------------------

def meta_records(fleet_data: dict, session_id: str) -> list[dict]:
    """Every desktop meta record that names this session, across every store on the machine."""
    out = []
    for store in stamplib.store_roots(fleet_data):
        for path, meta in stamplib.iter_metas(store["root"]):
            sid = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            lineage = [str(x) for x in (meta.get("lineageIds") or [])]
            if sid == session_id or session_id in lineage:
                out.append({"path": path, "instance": store["instance"],
                            "isRunning": bool(store["isRunning"]), "meta": meta})
    return out


def transcript_paths(fleet_data: dict, session_id: str, row: dict | None = None) -> list[Path]:
    """The transcript file(s) for this session: the daemon's row first, then the disk."""
    found: list[Path] = []
    if row is None:
        row = hydralib.session_row(session_id)
    for cand in ((row or {}).get("transcript_path"),
                 gatelib.find_transcript_on_disk(session_id),
                 stamplib.transcript_index(fleet_data).get(session_id)):
        if not cand:
            continue
        p = Path(str(cand))
        if p.exists() and p not in found:
            found.append(p)
    return found


def project_roots(fleet_data: dict | None = None) -> list[Path]:
    """Every projects/ tree a transcript or its sidecar can live in: the CLI's own
    (~/.claude/projects) AND each isolated instance's `<dir>/projects` - the same set
    stamplib.transcript_index walks (review 2026-09-05: scanning the default one alone
    reports "clean" for an isolated account's leftovers). A fleet read that fails narrows the
    sweep to the default root and says so in the caller's report rather than raising."""
    roots = [gatelib._PROJECTS_ROOT]
    if fleet_data is None:
        try:
            fleet_data = hydralib.fleet()
        except hydralib.DaemonError:
            fleet_data = {}
    for i in fleet_data.get("instances", []):
        d = i.get("dir")
        if d:
            p = Path(str(d)) / "projects"
            if p not in roots:
                roots.append(p)
    return roots


def sidecar_paths(session_id: str, transcripts: list[Path],
                  fleet_data: dict | None = None) -> list[Path]:
    """Every OTHER file named after this session beside its transcript(s) and under every
    projects root - the desktop app leaves `<sid>.desktop-released.json` behind when it lets a
    session go (measured 2026-09-04: both drill chats' transcripts were gone and those two
    sidecars still sat there). A deleted chat leaves no file that carries its id."""
    dirs = {t.parent for t in transcripts}
    for root in project_roots(fleet_data):
        try:
            if root.exists():
                dirs.update(p.parent for p in root.glob(f"*/{session_id}.*"))
        except OSError:
            continue
    out: list[Path] = []
    for d in dirs:
        try:
            for p in sorted(d.glob(f"{session_id}.*")):
                if p.is_file() and p not in transcripts and p not in out:
                    out.append(p)
        except OSError:
            continue
    return out


def resolve(query: str) -> tuple[dict | None, str | None, str | None]:
    """(match, session_id, refusal). A bare session id with no desktop record still resolves
    (match None) when the daemon knows a transcript for it, or any file on disk still carries
    the id - a console probe's shape, or a sidecar a previous delete could not see."""
    q = str(query or "").strip()
    try:
        match = hydralib.resolve_one(q)
        return match, str(match.get("cliSessionId") or ""), None
    except hydralib.ChatNotFound:
        if _UUID.match(q):
            row = hydralib.session_row(q)
            if row or gatelib.find_transcript_on_disk(q) or sidecar_paths(q, []):
                return None, q, None
        return None, None, f"no chat matches {q!r}"
    except hydralib.AmbiguousChat as err:
        return None, None, f"ambiguous - {err}"


def _live_block(session_id: str, match: dict | None) -> dict | None:
    """The live-process block, from the dossier when there is a record, else from the live
    registry (a console probe has no dossier row but very much can have a writer)."""
    if match is not None:
        return match.get("live")
    try:
        for s in hydralib.api_get("/api/sessions/live").get("sessions", []):
            if s.get("sessionId") == session_id:
                return {"pid": s.get("pid"), "name": s.get("name"),
                        "startedAt": s.get("startedAt"), "cwd": s.get("cwd")}
    except hydralib.DaemonError:
        raise
    return None


# --- the undo copy ---------------------------------------------------------------------------

def copy_to_trash(session_id: str, records: list[dict], transcripts: list[Path],
                  sidecars: list[Path] | None = None) -> dict:
    d = trash_dir(session_id)
    d.mkdir(parents=True, exist_ok=True)
    items = []
    for i, r in enumerate(records):
        name = f"meta-{i}.json"
        shutil.copy2(r["path"], d / name)
        items.append({"kind": "meta", "src": str(r["path"]), "name": name,
                      "instance": r["instance"]})
    for i, t in enumerate(transcripts):
        name = f"transcript-{i}.jsonl"
        shutil.copy2(t, d / name)
        items.append({"kind": "transcript", "src": str(t), "name": name})
    for i, s in enumerate(sidecars or []):
        name = f"sidecar-{i}{''.join(s.suffixes)[-40:] or '.bin'}"
        shutil.copy2(s, d / name)
        items.append({"kind": "sidecar", "src": str(s), "name": name})
    manifest = {"sessionId": session_id, "at": time.time(), "items": items}
    (d / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def undo(session_id: str) -> dict:
    """Restore from the trash manifest - under the same per-chat lock the delete holds, so a
    restore can never land in the middle of a delete's unlink loop (audit AH-28)."""
    with ledgerlib.try_locked(f"delete-{session_id}", stale_secs=DELETE_LOCK_STALE_SECS) as ours:
        if not ours:
            return _busy(session_id, "undo")
        return _undo_locked(session_id)


def _undo_locked(session_id: str) -> dict:
    d = trash_dir(session_id)
    try:
        manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": False, "code": 3, "why": f"no undo copy for {session_id} under {d}"}
    restored, failed = [], []
    for item in manifest.get("items", []):
        src = Path(item["src"])
        try:
            src.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(d / item["name"], src)
            restored.append(str(src))
        except OSError as err:
            failed.append(f"{src}: {err}")
    # The restore is a mutation of its own ("undelete"), so undo.py can confirm it landed
    # from a fresh ledger row the way it confirms every other inverse (review 2026-09-05).
    mutationlib.record("undelete", session_id, before={"trash": str(d)},
                       after={"restored": restored, "failed": failed} if not failed else None)
    return {"ok": not failed, "code": 0 if not failed else 2, "sessionId": session_id,
            "restored": restored, "failed": failed,
            "note": "the app's memory may still lack a restored record until it restarts"}


# --- the act ---------------------------------------------------------------------------------

def ui_delete(instance_dir: str, title: str) -> tuple[int, str]:
    """The running app's OWN Delete control (the actuator's Delete action: kebab -> Delete ->
    the app's confirm button, every step by label, never by position). Exits: 0 row gone -
    1 error/ambiguity - 2 invoked but the row stayed - 3 not rendered - 7 window busy."""
    if not ACTUATOR.exists():
        return 1, f"the UIA actuator is missing at {ACTUATOR}"
    with windowlib.instance_lock(instance_dir, wait_secs=60) as mine:
        if not mine:
            return 7, "that instance's window is busy - another lane is driving it; retry"
        with windowlib.keep_placement(instance_dir):
            r = clilib.run_text(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR),
                 "-Title", str(title), "-Instance", str(instance_dir), "-Action", "Delete"],
                timeout=240,
            )
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def _remove(path: Path) -> str | None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as err:
        return f"{path}: {err}"
    return None


def verify_gone(session_id: str, transcripts: list[Path], wait_secs: int = VERIFY_SECS) -> list[str]:
    """What is still there, after giving the daemon's meta cache time to notice. Empty = gone.
    Sidecars are re-globbed rather than remembered: a file the app writes DURING the delete
    (its release marker) must count too."""
    deadline = time.time() + wait_secs
    while True:
        remaining = []
        try:
            for m in hydralib.dossier(session_id):
                remaining.append(f"desktop record in {m.get('instance')}"
                                 f"{' (archived)' if m.get('archived') else ''}")
        except hydralib.DaemonError as err:
            remaining.append(f"dossier unreadable ({err.detail or err}) - not verified")
        for t in transcripts:
            if t.exists():
                remaining.append(f"transcript {t}")
        for s in sidecar_paths(session_id, transcripts):
            remaining.append(f"sidecar {s}")
        if not remaining or time.time() >= deadline:
            return remaining
        time.sleep(3)


def _stop_engine(session_id: str, match: dict | None, live: dict) -> dict:
    m = dict(match) if match else {"cliSessionId": session_id}
    m["live"] = live
    bg = enginelib.background_work(m)
    quiet = (enginelib.NOW_QUIET_SECS if bg.get("scanned") and not bg.get("outstanding")
             else enginelib.IDLE_STOP_SECS)
    report = enginelib.stop_idle_engine(m, min_quiet_secs=quiet)
    if not report.get("stopped") and report.get("reason") == enginelib.R_TOO_SOON \
            and 0 < int(report.get("needs_secs") or 0) <= 60:
        time.sleep(int(report["needs_secs"]) + 1)
        report = enginelib.stop_idle_engine(m, min_quiet_secs=quiet)
    return report


def delete(query: str, stop_idle: bool = False, force: bool = False,
           instance_hint: str | None = None) -> dict:
    """`instance_hint` (number / name / dir) names the RUNNING app that rendered this chat
    when no meta record has reached the disk yet - measured 2026-09-04: a deeplink-spawned
    chat answered, the app logged its session mapping, and wrote no local_*.json for minutes.
    Without the hint such a chat has only a transcript to delete and the app's sidebar keeps
    the row from memory; with it, the app's own Delete control is driven there too."""
    match, sid, refusal = resolve(query)
    if refusal or not sid:
        return {"ok": False, "code": 3, "why": refusal or "no session id"}
    # The lock is taken by session id, which is the only name a delete and an undo share, and
    # held through the trash copy, the app's own control, the unlinks, the verify and the
    # mutation record. A second delete or an undo arriving meanwhile is DEFERRED, never run
    # alongside (audit AH-28 - see DELETE_LOCK_STALE_SECS).
    with ledgerlib.try_locked(f"delete-{sid}", stale_secs=DELETE_LOCK_STALE_SECS) as ours:
        if not ours:
            return _busy(sid, "delete")
        return _delete_locked(match, sid, stop_idle, force, instance_hint)


def _delete_locked(match: dict | None, sid: str, stop_idle: bool, force: bool,
                   instance_hint: str | None) -> dict:
    title = str((match or {}).get("title") or "")
    held = holdlib.why_blocked(sid)
    if held and not force:
        return {"ok": False, "code": 3, "why": held, "sessionId": sid}
    engine = None
    live = _live_block(sid, match)
    if live is not None:
        if not stop_idle:
            return {"ok": False, "code": 3, "sessionId": sid,
                    "why": f"LIVE writer (pid {live.get('pid')}) - pass --stop-idle to stop an "
                           "IDLE engine first (a working or stuck one still refuses)"}
        engine = _stop_engine(sid, match, live)
        if not engine.get("stopped"):
            return {"ok": False, "code": 3, "sessionId": sid, "engine": engine,
                    "why": f"engine not stopped: {engine.get('why')}"}
    fleet_data = hydralib.fleet()
    row = hydralib.session_row(sid)
    records = meta_records(fleet_data, sid)
    transcripts = transcript_paths(fleet_data, sid, row)
    sidecars = sidecar_paths(sid, transcripts)
    if not records and not transcripts and not sidecars:
        return {"ok": False, "code": 3, "sessionId": sid,
                "why": "nothing on disk for this chat - already gone?"}
    title = title or str((row or {}).get("title") or "")
    manifest = copy_to_trash(sid, records, transcripts, sidecars)
    ui = []
    seen_dirs: set[str] = set()
    for r in records:
        if not r["isRunning"]:
            continue
        inst_dir = str(r["path"].parents[3])
        if inst_dir.lower() in seen_dirs:
            continue
        seen_dirs.add(inst_dir.lower())
        row_title = title or str(r["meta"].get("title") or "")
        code, said = (1, "no title to find the row by") if not row_title else ui_delete(inst_dir, row_title)
        ui.append({"instance": r["instance"], "exit": code, "said": said[-300:]})
    if not records and instance_hint:
        hinted = hydralib.resolve_instance(fleet_data, str(instance_hint))
        if hinted and hinted.get("isRunning") and hinted.get("dir"):
            if title:
                code, said = ui_delete(str(hinted["dir"]), title)
            else:
                code, said = 1, "no title to find the row by (the daemon knows none for it)"
            ui.append({"instance": hinted.get("name"), "exit": code, "said": said[-300:],
                       "hinted": True})
    problems = []
    for r in records:
        err = _remove(r["path"])
        if err:
            problems.append(err)
    for t in transcripts:
        err = _remove(t)
        if err:
            problems.append(err)
    # the app may write its release marker while the files above go: sweep the sidecars LAST,
    # re-globbed, so a marker born mid-delete is caught here rather than reported as left
    time.sleep(1)
    late = [s for s in sidecar_paths(sid, transcripts) if s not in sidecars]
    for s in sidecars + late:
        err = _remove(s)
        if err:
            problems.append(err)
    remaining = verify_gone(sid, transcripts) + problems
    before = {"records": [str(r["path"]) for r in records],
              "transcripts": [str(t) for t in transcripts],
              "sidecars": [str(s) for s in sidecars + late],
              "trash": str(trash_dir(sid)), "title": title}
    mutationlib.record("delete", sid, instance=str((match or {}).get("instance") or ""),
                       title=title, before=before, after={"remaining": remaining})
    ledgerlib.note("delete", sid,
                   note=f"delete_chat{' (--force)' if force else ''}: {len(records)} record(s), "
                        f"{len(transcripts)} transcript(s)"
                        f"{'; remaining: ' + '; '.join(remaining) if remaining else ''}")
    ok = not remaining
    return {"ok": ok, "code": 0 if ok else 2, "sessionId": sid, "title": title,
            "trash": str(trash_dir(sid)), "records": before["records"],
            "transcripts": before["transcripts"], "sidecars": before["sidecars"],
            "ui": ui, "engine": engine,
            "remaining": remaining, "manifestItems": len(manifest["items"]),
            "note": (None if not ui or all(u["exit"] == 0 for u in ui) else
                     "a running app did not confirm the delete through its own control; the files "
                     "are gone, but that app may re-save the record from memory until it restarts")}


# --- the sweep: what the app's own Delete left behind ----------------------------------------

def released_leftovers(fleet_data: dict | None = None) -> list[dict]:
    """Every `<sid>.desktop-released.json` marker under EVERY projects root (the CLI's and each
    isolated instance's), with whether the transcript beside it still exists. Each row is a
    chat the app let go of (the marker's `reason` says why - "delete" is the owner's own Delete
    click) that is still on the disk, still in AgentHydra's list. Measured 2026-09-04: 14
    markers, 12 transcripts lingering."""
    out: list[dict] = []
    markers: list[Path] = []
    for root in project_roots(fleet_data):
        try:
            if root.exists():
                markers.extend(sorted(root.glob("*/*.desktop-released.json")))
        except OSError:
            continue
    for m in markers:
        sid = m.name.split(".")[0]
        if not _UUID.match(sid):
            continue
        try:
            reason = str(json.loads(m.read_text(encoding="utf-8")).get("reason") or "?")
        except (OSError, ValueError):
            reason = "?"
        t = m.with_name(f"{sid}.jsonl")
        size = t.stat().st_size if t.exists() else 0
        out.append({"sessionId": sid, "marker": str(m), "reason": reason,
                    "transcript": str(t) if t.exists() else None, "sizeBytes": size,
                    "project": m.parent.name})
    return out


def sweep_released(act: bool = False) -> dict:
    """List (default) or delete (act=True) every released leftover, each through delete()
    with every rail it has - a chat that somehow still has a live engine is refused and
    named, never stopped from here."""
    try:
        fleet_data = hydralib.fleet()
        roots_note = None
    except hydralib.DaemonError as err:
        fleet_data = {}
        roots_note = (f"fleet unreadable ({err.detail or err}): only the default projects root "
                      "was swept - isolated instances' leftovers are NOT covered by this run")
    rows = released_leftovers(fleet_data)
    results = []
    for r in rows:
        if not act:
            results.append({**r, "deleted": None})
            continue
        res = delete(r["sessionId"], stop_idle=False, force=False)
        results.append({**r, "deleted": bool(res.get("ok")), "code": res.get("code"),
                        "why": res.get("why"), "remaining": res.get("remaining"),
                        "trash": res.get("trash")})
    return {"act": act, "count": len(rows),
            "withTranscript": sum(1 for r in rows if r["transcript"]),
            "bytes": sum(r["sizeBytes"] for r in rows), "results": results,
            "roots": [str(r) for r in project_roots(fleet_data)],
            **({"note": roots_note} if roots_note else {})}


def sweep_exit_code(report: dict) -> int:
    if not report["act"] or not report["results"]:
        return 0
    return 0 if all(r.get("deleted") for r in report["results"]) else 4


# --- CLI -------------------------------------------------------------------------------------

def _render_sweep(report: dict) -> str:
    if not report["results"]:
        return ("nothing left behind: no released markers under "
                f"{len(report.get('roots') or [])} projects root(s)"
                + (f"\n  ! {report['note']}" if report.get("note") else ""))
    lines = [f"{report['count']} chat(s) the app let go of still on disk, "
             f"{report['withTranscript']} with a transcript ({report['bytes'] // 1024} KB)"
             + ("" if report["act"] else " - listed only; --yes deletes them")]
    if report.get("note"):
        lines.append(f"  ! {report['note']}")
    for r in report["results"]:
        state = ("" if r.get("deleted") is None else
                 ("  deleted" if r.get("deleted") else f"  NOT deleted: {r.get('why') or r.get('remaining')}"))
        lines.append(f"  {r['sessionId']}  {r['reason']:<7} {r['sizeBytes'] // 1024:>7} KB  "
                     f"{r['project'][:48]}{state}")
    return "\n".join(lines)


def _render(res: dict) -> str:
    if not res.get("ok") and res.get("code") == 3:
        return f"REFUSED: {res.get('why')}"
    lines = [("deleted" if res.get("ok") else "PARTIAL") +
             f": {res.get('title') or res.get('sessionId')} ({res.get('sessionId')})"]
    if res.get("restored") is not None:
        return ("restored: " + ", ".join(res["restored"])) + (
            ("\nFAILED: " + "; ".join(res["failed"])) if res.get("failed") else "")
    for u in res.get("ui") or []:
        lines.append(f"  app {u['instance']}: exit {u['exit']} - {u['said'].splitlines()[-1] if u['said'] else ''}")
    lines.append(f"  removed {len(res.get('records') or [])} record(s), "
                 f"{len(res.get('transcripts') or [])} transcript(s); undo copy in {res.get('trash')}")
    for r in res.get("remaining") or []:
        lines.append(f"  STILL THERE: {r}")
    if res.get("note"):
        lines.append(f"  note: {res['note']}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    if "--released" in argv:
        try:
            report = sweep_released(act="--yes" in argv)
        except hydralib.DaemonError as err:
            print(f"sweep FAILED: {err}", file=sys.stderr)
            return 1
        print(json.dumps(report, indent=2) if as_json else _render_sweep(report))
        return sweep_exit_code(report)
    if "--undo" in argv:
        i = argv.index("--undo")
        sid = argv[i + 1] if i + 1 < len(argv) else ""
        if not sid or sid.startswith("--"):
            print(__doc__.strip(), file=sys.stderr)
            return 3
        res = undo(sid)
        print(json.dumps(res, indent=2) if as_json else _render(res))
        return res["code"]
    words = [a for a in argv if not a.startswith("--")]
    if len(words) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        res = delete(words[0], stop_idle="--stop-idle" in argv, force="--force" in argv)
    except hydralib.DaemonError as err:
        print(f"delete FAILED: {err}", file=sys.stderr)
        return 1
    print(json.dumps(res, indent=2) if as_json else _render(res))
    return res["code"]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
