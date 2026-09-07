#!/usr/bin/env python3
"""automation_chat.py - ACT: enforce the AUTOMATION DOCTRINE on ONE existing chat.

THE DOCTRINE (owner, 2026-08-31): chats run bypassPermissions wherever possible, keep
whatever model they were previously assigned (this script never touches model), and use
ultracode - MECHANICALLY, never by telling the chat's AI in a prompt (owner correction,
same day: a model cannot set its own harness parameters from words).

Two stamps, both verified:
  1. bypassPermissions - the daemon's own primitive (POST /api/sessions/:id/automation).
  2. ultracode - sessionSettings.ultracode=true + effort=xhigh written into the chat's
     meta record on disk (stamplib), the same fields the app itself writes for
     /effort ultracode.

Fresh landings get both stamps automatically from migrate_chat; THIS script is for chats
that already live in the desktop. THE CAVEAT (inherited from the permission-mode saga):
under a RUNNING app the in-memory record is authoritative and can re-save over both
stamps; disk converges at the app's next store re-read. The report says so whenever the
chat's app is running - stamped-on-disk is claimed, durable-in-the-running-app is not.

FLEET-WIDE ENFORCEMENT (`--all`): the doctrine says "always make sure WHERE POSSIBLE the
chats are running bypass" - one-chat stamping cannot keep a fleet conformant, so --all
enumerates every desktop chat store on disk (the same surface the archive audit reads),
lists every non-archived chat missing either stamp, and with --yes stamps them all: held
chats are stamped too (a hold blocks work on a chat, never its configuration), archived
chats are left alone, and every row reports which stamp it was missing and whether its
app's re-save can lag the result. The single-target path below applies the same rule.

Usage: python automation_chat.py <title fragment | session id> [--force] [--json]
       python automation_chat.py --all [--yes] [--json]     # fleet-wide: plan, then enforce

--force on ONE chat drives the target app's OWN permission picker (set_mode_via_app), which
is the only thing that can set the mode of a chat in a RUNNING app - a disk stamp is invisible
to it until that app's next process boot. It is the remedy migrate_chat names when a move ends
`disk-only`. Gated on --force for the same reason the fleet pass gates its picker on the icon:
selecting the chat's row flips what the owner is looking at, so it takes a by-hand act.
Exit:  0 both stamps verified on disk (running-app caveat reported when it applies; a held
         chat is stamped and noted, never refused for the hold alone), or --all found
         nothing missing / stamped everything it tried -
       2 partially stamped (one took, one did not - each named), or --all had failures -
       3 deterministic refusal (no desktop record / no metaPath: land it first, the
         landing stamps it) - 1 daemon failure.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib
from lib import stamplib


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def survey_fleet(fleet: dict) -> list[dict]:
    """Every non-archived desktop chat missing a stamp, straight off the disk stores."""
    rows = []
    for store in stamplib.store_roots(fleet):
        if not store["root"].exists():
            continue
        for path, meta in stamplib.iter_metas(store["root"]):
            if meta.get("isArchived"):
                continue
            missing = []
            if meta.get("permissionMode") != "bypassPermissions":
                missing.append("bypass")
            if not stamplib.is_stamped(meta):
                missing.append("ultracode")
            if not missing:
                continue
            rows.append({
                "sessionId": str(meta.get("cliSessionId") or ""),
                "title": meta.get("title"),
                "instance": store["instance"],
                "appRunning": store["isRunning"],
                "missing": missing,
                "metaPath": str(path),
            })
    return rows


MODE_ACTUATOR = Path(__file__).resolve().parent / "actuator" / "approve_prompt.ps1"
REQUIRED_MODE = "Bypass permissions"  # the app's own label for bypassPermissions
# One picker attempt per chat per this long (the attempt selects the chat's row, which flips
# the owner's view of that window); the lane itself runs every two minutes.
MODE_RETRY_SECS = 10 * 60
# THE APP IS THE TRUTH FOR A RUNNING APP (owner, 2026-09-01: "I have a ton of chats set to
# manual or accept edits, so it's clear you're not changing all of the chats"). A running app
# holds every chat's mode in memory and never re-reads the file, so the disk stamp this lane
# wrote and then re-read as "0 missing" was invisible in the app. A chat in a running app
# counts as ON DOCTRINE only once the app's own picker has said so (or shown bypass already);
# that confirmation is kept per chat in state/mode-confirmed.json and dropped the moment the
# disk record reads anything but bypass again (the app re-saved its real, wrong mode).
PICKER_PER_TICK = 4
CONFIRMED_NAME = "mode-confirmed.json"


def _confirmed_path() -> Path:
    return ledgerlib._state_dir() / CONFIRMED_NAME


def load_confirmed() -> dict:
    try:
        raw = json.loads(_confirmed_path().read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_confirmed(data: dict) -> None:
    p = _confirmed_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def mark_confirmed(sid: str, how: str) -> None:
    # Load-mutate-save under one lock (audit AH-30): a successful picker recording its verdict
    # and the fleet pass dropping a stale confirmation for ANOTHER chat used to read the same
    # snapshot and the loser erased the winner's entry - the next tick then re-ran a picker on
    # a chat that had already confirmed, and the compliance report undercounted.
    with ledgerlib.locked("mode-confirmed"):
        data = load_confirmed()
        data[sid] = {"at": int(time.time() * 1000), "how": how[:160]}
        _save_confirmed(data)


def drop_confirmed(sid: str) -> None:
    with ledgerlib.locked("mode-confirmed"):
        data = load_confirmed()
        if sid in data:
            del data[sid]
            _save_confirmed(data)


def running_rows(fleet: dict) -> list[dict]:
    """Every non-archived desktop chat whose app is RUNNING, with its disk mode - the set the
    picker has to confirm one by one."""
    rows = []
    for store in stamplib.store_roots(fleet):
        if not store["isRunning"] or not store["root"].exists():
            continue
        for path, meta in stamplib.iter_metas(store["root"]):
            if meta.get("isArchived"):
                continue
            rows.append({
                "sessionId": str(meta.get("cliSessionId") or ""),
                "title": meta.get("title"),
                "instance": store["instance"],
                "appRunning": True,
                "missing": ["bypass"] if meta.get("permissionMode") != "bypassPermissions" else [],
                "metaPath": str(path),
            })
    return rows


def _mode_retry_status(sid: str) -> str | None:
    """A RATE LIMIT, NOT A BREAKER (owner, 2026-09-01: "a constant check for any chats not in
    bypass permissions, auto-set them - autonomously, as long as it's programmatically").
    -Select flips what the owner is looking at in that window, so one attempt per chat per
    MODE_RETRY_SECS - but never a six-hour suppression: a picker hidden behind a pending
    prompt clears the moment unblock_prompts presses it, and the next pass must try again.
    None when the chat may be tried now; otherwise the 'tried Nm ago' message."""
    now_ms = int(time.time() * 1000)
    recent = [r for r in ledgerlib._load()
              if r.get("kind") == "mode" and r.get("session") == sid
              and now_ms - int(r.get("at") or 0) < MODE_RETRY_SECS * 1000]
    if not recent:
        return None
    age_min = (now_ms - max(int(r.get("at") or 0) for r in recent)) // 60000
    return f"tried {age_min}m ago - next try after {MODE_RETRY_SECS // 60}m"


def _verify_text_for_row(row: dict, fleet: dict) -> str:
    """Its own last words; failing those, its FIRST prompt as the pane renders it (a slash
    command shows its arguments) - the picker refused the reborn manager on its raw
    '/orchestrate ...' prompt (live soak, 2026-09-01).
    SEVERAL of the chat's own lines, any one of which on screen proves the chat ('|||'
    separated, the actuator's rule): the pane renders markdown and shows the END of a long
    message, so a single snippet missed real chats ("pane does not show its own words")."""
    from lib import deliverylib, gatelib

    tp = stamplib.transcript_index(fleet).get(str(row.get("sessionId") or ""))
    if not tp:
        return ""
    tail = deliverylib.transcript_tail_text(str(tp))
    alts: list[str] = []
    for cand in (deliverylib._verify_snippet(tail),
                 deliverylib._verify_snippet("\n".join(tail.splitlines()[:-1]) if tail else ""),
                 deliverylib._verify_snippet(gatelib.pane_words(gatelib.first_user_prompt(str(tp))))):
        if cand and cand not in alts:
            alts.append(cand)
    return "|||".join(alts)


def _actuator_args(row: dict, inst_dir: str, verify: str) -> list[str]:
    args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(MODE_ACTUATOR),
            "-Title", str(row.get("title") or ""), "-Instance", inst_dir,
            "-Select", "-SetMode", REQUIRED_MODE]
    if verify:
        args += ["-VerifyText", verify]
    return args


def _run_actuator(args: list[str], inst_dir: str):
    """Runs the actuator under the instance's window lock. Returns (returncode, output_lines)
    on completion, or a str error message; never raises."""
    from lib import windowlib

    try:
        with windowlib.instance_lock(inst_dir, wait_secs=60) as mine:
            if not mine:
                return "window busy - next pass"
            r = clilib.run_text(args, timeout=180)
    except Exception as err:  # configuration is never worth crashing the lane over
        return f"actuator error: {str(err)[:120]}"
    said = (str(r.stdout or "") + str(r.stderr or "")).strip().splitlines()
    return r.returncode, said


def _record_chip_lines(said: list[str], row: dict) -> list[str]:
    """A chip seen on the way past (the actuator prints 'CHIP: <title>' when the selected
    chat's pane carries a Suggested task card): hand it to the chips lane, which starts it
    locally on its own clock. Never an act here."""
    for line in said:
        if line.startswith("CHIP: "):
            try:
                import chips

                chips.record(str(row.get("instance") or ""), str(row.get("title") or ""), line[6:].strip())
            except Exception:  # a note-taking courtesy must never fail the mode step
                pass
    return [line for line in said if not line.startswith("CHIP: ")]


def _finalize_mode_attempt(sid: str, returncode: int, last: str) -> None:
    if returncode == 0:
        ledgerlib.clear("mode", sid)  # set (or already right): no reason to wait next time
        mark_confirmed(sid, last)     # the app itself said bypass - THIS is the verdict
    else:
        ledgerlib.annotate("mode", sid, last, failure=True)


def set_mode_via_app(row: dict, fleet: dict, force: bool = False) -> str:
    """THE ROUTE FOR A LIVE CHAT (2026-09-01): a running app holds the chat's record in memory
    and re-saves it over any disk stamp, so a live chat off-doctrine stays off-doctrine until
    the app itself is told. The app's own permission picker (a Button in the composer toolbar
    named for the current mode) IS that telling - approve_prompt.ps1 -SetMode drives it with
    the same aim rails as a press (exact instance dir, the chat open, its own words on screen).
    Returns the actuator's last line; never raises.

    `force` skips the MODE_RETRY_SECS rate limit, and ONLY a by-hand act may pass it. That
    limit exists because -Select flips what the owner is looking at, so a LANE must not drive
    the same chat twice in ten minutes. A migration is not a lane tick: the human asked for
    this chat to move, right now, and a move that cannot set the mode is the whole defect
    being fixed here (owner, 2026-09-05: "moving the chats is required to set the permissions
    to bypass permissions ... I had to do that manually"). Same carve-out the fleet pass
    already grants `--force` (_run_fleet_pass)."""
    if not MODE_ACTUATOR.exists():
        return "actuator missing"

    sid = str(row.get("sessionId") or "")
    retry = None if force else _mode_retry_status(sid)
    if retry is not None:
        return retry
    ledgerlib.note("mode", sid, note=f"picker -> {REQUIRED_MODE} for '{row.get('title') or ''}'")

    inst = hydralib.resolve_instance(fleet, str(row.get("instance") or "")) or {}
    inst_dir = str(inst.get("dir") or row.get("instance") or "")
    verify = _verify_text_for_row(row, fleet)
    args = _actuator_args(row, inst_dir, verify)

    outcome = _run_actuator(args, inst_dir)
    if isinstance(outcome, str):
        return outcome
    returncode, said = outcome
    said = _record_chip_lines(said, row)
    last = said[-1][:160] if said else f"exit {returncode}"
    _finalize_mode_attempt(sid, returncode, last)
    return last


def _fetch_live_ids(fleet: dict) -> set:
    """The daemon's own view of which sessions are live, read (and discarded if unreachable)
    purely to keep this pass's daemon round-trip identical to before the refactor."""
    try:
        return {s.get("sessionId") for s in
                hydralib.api_get("/api/sessions/live").get("sessions", [])}
    except hydralib.DaemonError:
        return set()


def _maybe_ensure_allow_all(act: bool) -> dict:
    """THE ENGINE-SIDE HALF, programmatic and ungated (stamplib.ensure_allow_all): allow rules
    in the user settings pre-approve every tool in every mode, so a chat the app still runs
    as 'Accept edits' stops stalling on prompts without any window being touched."""
    if act:
        return stamplib.ensure_allow_all()
    return {"changed": False, "added": [], "rules": 0, "error": None}


def _stamp_rows(rows: list[dict]) -> list[dict]:
    """THE DISK WRITE IS THE STAMP, both halves, in one go (stamplib.stamp_doctrine). The
    permission half used to go only through the daemon endpoint, which 404s for any chat its
    index does not carry - so those chats sat on acceptEdits forever while the sweep quietly
    recorded a failure. The endpoint is now the extra, not the route."""
    results = []
    for r in rows:
        got = stamplib.stamp_doctrine(r["metaPath"])
        bypass_ok, uc_ok = got["bypass"], got["ultracode"]
        if r["sessionId"]:
            try:  # best-effort: tells the daemon so its own cache agrees
                hydralib.api_post(f"/api/sessions/{r['sessionId']}/automation", {})
            except hydralib.DaemonError:
                pass
        results.append({**r, "ok": bypass_ok and uc_ok,
                        "bypassStamped": bypass_ok, "ultracodeStamped": uc_ok,
                        "viaApp": "", "error": got["error"]})
    return results


def _pending_in_app_rows(in_app: list[dict], confirmed: dict) -> list[dict]:
    """Every chat in a running app the app has not yet confirmed - the set the picker pass has
    to drive one by one. A confirmation is dropped (disk and the passed-in `confirmed`, in
    place) the moment the disk reads anything but bypass again (the app re-saved its real
    mode), so the next tick drives that chat once more. Missing-on-disk first."""
    pending: list[dict] = []
    for r in in_app:
        sid = r["sessionId"]
        if not sid:
            continue
        if r["missing"] and sid in confirmed:
            drop_confirmed(sid)
            confirmed.pop(sid, None)
        if sid not in confirmed:
            pending.append(r)
    pending.sort(key=lambda r: (not r["missing"], str(r.get("title") or "")))
    return pending


def _run_picker_pass(pending: list[dict], fleet: dict) -> list[dict]:
    """THE PICKER PASS - the app is the truth for a running app (PICKER_PER_TICK, above): a
    few pending chats per tick get their row selected and the app's own picker set, until all
    of them are confirmed."""
    picked: list[dict] = []
    tried = 0
    for r in pending:
        if tried >= PICKER_PER_TICK:
            break
        said = set_mode_via_app(r, fleet)
        if not said.startswith("tried "):
            tried += 1
        picked.append({**r, "viaApp": said})
    return picked


def _missing_header(rows: list[dict], held: list[dict]) -> str:
    return (f"{len(rows)} chat(s) missing a stamp ({len(held)} of them HELD - stamped anyway: "
            "a hold covers a chat's work, not its permission mode)")


def _inapp_confirmation_line(in_app: list[dict], still: list[dict], act: bool, ui_ok: bool) -> str:
    if act and ui_ok and still:
        suffix = f" ({PICKER_PER_TICK} tried per tick)"
    elif act and still:
        suffix = " - the picker pass touches the app and waits for the tray icon"
    else:
        suffix = ""
    return (f"in-app: {len(in_app) - len(still)} of {len(in_app)} chat(s) in running apps "
            f"CONFIRMED through the app's own picker; {len(still)} pending{suffix}")


def _picker_report_lines(picked: list[dict]) -> list[str]:
    return [f"  picker [{p['instance']}] {p['title']}: {p['viaApp']}" for p in picked]


def _settings_line(settings: dict) -> str:
    if settings.get("error"):
        return f"engine settings: FAILED ({settings['error']})"
    if settings.get("changed"):
        return (f"engine settings: added {len(settings['added'])} allow rule(s) "
                f"({settings['rules']} total) - every tool and MCP server pre-approved in every mode")
    return f"engine settings: {settings['rules']} allow rule(s) already cover every tool and MCP server"


def _row_report_lines(rows: list[dict], act: bool) -> list[str]:
    lines = []
    for r in rows:
        mark = ("✓" if r.get("ok") else "✗") if act else "-"
        caveat = " [app running - re-save can lag]" if r["appRunning"] else ""
        via = f" | picker: {r['viaApp']}" if r.get("viaApp") else ""
        lines.append(f"  {mark} [{r['instance']}] {r['title']}: missing {'+'.join(r['missing'])}{caveat}{via}")
    return lines


def enforce_all(act: bool, as_json: bool, ui_ok: bool = False) -> int:
    """`ui_ok`: may this pass DRIVE THE APP (select chats, set pickers)? Only while the tray
    icon is up, or --force by hand. Owner, 2026-09-01, after the picker pass flipped his
    windows with the icon down: "I made it very clear I can't run that... and I didn't
    authorize you to start one yet." The disk stamp is the programmatic, invisible half he
    allowed to run on its own; touching his windows is an act like any other."""
    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"automation --all FAILED: {err}"}, as_json, 1)
    rows = survey_fleet(fleet)
    # Read the running apps' disk records BEFORE stamping: a record the app re-saved to its
    # real (wrong) mode is the evidence that drops a confirmation, and the stamp below would
    # paper over it.
    in_app = running_rows(fleet)
    _fetch_live_ids(fleet)
    # ⛔ A HOLD DOES NOT EXEMPT A CHAT FROM ITS PERMISSION MODE (owner, 2026-09-01: "I am
    # getting sick of having to change things from manual edits to bypass permissions"). A
    # hold means do not act on the chat's WORK - no messages, no archive, no move. The
    # doctrine stamps are CONFIGURATION, they change nothing the chat is doing, and the held
    # chats are precisely the ones he sits in and has to fix by hand. So they are stamped too,
    # and nothing else about them is touched.
    held = [r for r in rows if r["sessionId"] and holdlib.why_blocked(r["sessionId"])]
    todo = list(rows)
    settings = _maybe_ensure_allow_all(act)
    results = _stamp_rows(todo) if act else []

    confirmed = load_confirmed()
    pending = _pending_in_app_rows(in_app, confirmed)
    picked: list[dict] = []
    if act and ui_ok:
        picked = _run_picker_pass(pending, fleet)
        confirmed = load_confirmed()
    still = [r for r in pending if r["sessionId"] not in confirmed]
    failed = [x for x in results if not x["ok"]]

    lines = [_missing_header(rows, held), _inapp_confirmation_line(in_app, still, act, ui_ok)]
    lines += _picker_report_lines(picked)
    if act:
        lines.append(_settings_line(settings))
    lines += _row_report_lines(results if act else todo, act)
    if not act and todo:
        lines.append("PLAN ONLY - add --yes to stamp them.")
    return out({"ok": not failed, "missing": len(rows), "held": len(held),
                "stamped": sum(1 for x in results if x["ok"]), "failed": len(failed),
                "inApp": len(in_app), "confirmedInApp": len(in_app) - len(still),
                "pendingInApp": [{"sessionId": r["sessionId"], "title": r["title"],
                                  "instance": r["instance"], "missing": r["missing"]} for r in still],
                "picker": picked, "settings": settings,
                "rows": results if act else todo, "report": "\n".join(lines)},
               as_json, 0 if not failed else 2)


def _run_fleet_pass(argv: list[str], as_json: bool) -> int:
    """⛔ THE DISK STAMP IS NOT GATED BY THE ICON (owner, 2026-09-01, the same evening the icon
    became the switch): "a constant check for any chats/threads that are not bypass
    permissions and it should auto set them to that. This can be done autonomously, as long as
    it's PROGRAMMATICALLY." The stamp is configuration written to disk - it touches no chat's
    work and no window - so it runs with or without the icon, every two minutes (schedule_jobs
    UNGATED_JOBS).
    ⛔ THE PICKER PASS IS (same owner, later that night, after it flipped his windows with the
    icon down: "I didn't authorize you to start one yet"): selecting chats and driving the
    app's picker is an act on his screen like any other, so it waits for the icon - or --force
    by hand."""
    from lib import armlib

    ui_ok = armlib.refuse_unless_armed(argv, "the doctrine lane's in-app picker pass") is None
    return enforce_all(act="--yes" in argv, as_json=as_json, ui_ok=ui_ok)


def _stamp_single_target(match: dict, fleet: dict, as_json: bool, force: bool = False) -> int:
    """The single-chat doctrine stamp (both halves, one disk write) plus the daemon's own
    primitive as a best-effort extra - the same shape as the fleet pass's `_stamp_rows`, for
    exactly one chat, with the fuller report a single target warrants."""
    session_id = match.get("cliSessionId") or ""
    title = match.get("title")

    meta_path = match.get("metaPath")
    if not match.get("instance") or not meta_path:
        return out(
            {
                "ok": False,
                "report": (
                    f"REFUSED (deterministic): '{title}' has no desktop meta record to stamp "
                    "(console-only, or the dossier gave no metaPath). Land it with "
                    "migrate_chat.py - the landing stamps it."
                ),
            },
            as_json,
            3,
        )

    # (No icon gate here either - see the --all path: configuration runs autonomously.)

    # ⛔ A HOLD DOES NOT EXEMPT A CHAT FROM ITS PERMISSION MODE (owner, 2026-09-01) - the same
    # doctrine as enforce_all above. A hold means do not act on the chat's WORK; the stamps
    # below are CONFIGURATION, so a hold is reported, never a reason to refuse the stamp.
    hold_why = holdlib.why_blocked(session_id)

    app_running = any(
        str(i.get("name", "")).lower() == str(match.get("instance", "")).lower()
        and i.get("isRunning")
        for i in fleet.get("instances", [])
    )

    ledgerlib.note("automation", session_id, note=f"stamp '{title}'")

    # THE DISK WRITE IS THE STAMP, both halves, in one go (stamplib.stamp_doctrine) - the same
    # route the fleet pass uses. The single-chat path used to send the permission half only
    # through the daemon's endpoint, which 404s for any chat the index does not carry, and
    # then reported "stamped" off the daemon's word while the meta on disk still said
    # acceptEdits (found 2026-09-01 by the test for the owner's "auto set them" order).
    got_disk = stamplib.stamp_doctrine(meta_path)
    bypass_ok = bool(got_disk["bypass"])
    uc_ok = bool(got_disk["ultracode"])
    # "already set" when the record needed no write at all (stamp_doctrine: changed=False and
    # both halves verified) - the idempotent case a report must not dress up as a change.
    uc = {"already": (not got_disk.get("changed")) and uc_ok and bypass_ok,
          "error": got_disk.get("error")}
    # ...and the daemon's own primitive as the extra, so its cache agrees (best-effort; it
    # never changes the verdict - the disk is the truth, exactly as in the fleet pass).
    try:
        hydralib.api_post(f"/api/sessions/{session_id}/automation", {})
    except hydralib.DaemonError:
        pass
    got = {"error": got_disk.get("error") or "disk stamp did not verify"}

    # ⛔ --force ON ONE CHAT DRIVES THE APP'S OWN PICKER, because for a RUNNING app nothing
    # else can set the mode (set_mode_via_app). Without this the single-target path could only
    # ever write disk and then print a caveat saying so, which made it useless as the remedy
    # migrate_chat points at - the caller ran it, got exit 0, and the chat still opened on a
    # prompting mode. Gated on --force for the same reason the fleet pass gates its picker on
    # the icon: -Select flips what the owner is looking at, so it takes a by-hand act.
    via_app = ""
    if app_running and force:
        via_app = set_mode_via_app(
            {"sessionId": session_id, "title": title,
             "instance": match.get("instance") or "", "metaPath": meta_path},
            fleet, force=True)
    app_confirmed = session_id in load_confirmed()

    caveat = (
        (f" APP-CONFIRMED via its own picker ({via_app})." if app_confirmed else
         (f" ⚠ its app is RUNNING and the picker did not confirm ({via_app}) - disk is "
          "stamped, the live chat may still open on a prompting mode." if force else
          " CAVEAT: its app is RUNNING, so the in-memory record can re-save over these until "
          "the app next re-reads its store - disk is stamped, the live chat may lag. Pass "
          "--force to drive the app's own picker, the only thing that sets a live chat."))
        if app_running
        else ""
    )
    held_note = (
        f" [HELD: {hold_why} - stamped anyway, a hold covers the chat's work, not its "
        "permission mode]"
        if hold_why
        else ""
    )
    # Both halves say "already set" for the no-write case: a record that carried bypass
    # before we looked was not "stamped" by us (live smoke, 2026-09-01: the report claimed a
    # change the disk never saw).
    parts = [
        "bypassPermissions " + ("already set" if uc["already"] else "stamped" if bypass_ok
                                else f"FAILED ({str(got)[:120]})"),
        "ultracode " + ("already set" if uc["already"] else "stamped" if uc_ok else f"FAILED ({uc['error']})"),
    ]
    ok = bypass_ok and uc_ok
    if ok:
        ledgerlib.clear("automation", session_id)
    return out(
        {
            "ok": ok,
            "held": bool(hold_why),
            "bypassStamped": bypass_ok,
            "ultracodeStamped": uc_ok,
            "appRunning": app_running,
            "appConfirmed": app_confirmed,
            "report": f"'{title}'{held_note}: {'; '.join(parts)}.{caveat}",
        },
        as_json,
        0 if ok else 2 if (bypass_ok or uc_ok) else 1,
    )


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    if "--all" in argv:
        return _run_fleet_pass(argv, as_json)
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    try:
        match = hydralib.resolve_one(args[0])
        fleet = hydralib.fleet()
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        return out({"ok": False, "report": f"REFUSED (deterministic): {err}"}, as_json, 3)
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"automation stamp FAILED: {err}"}, as_json, 1)

    return _stamp_single_target(match, fleet, as_json, force="--force" in argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
