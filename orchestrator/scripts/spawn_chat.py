#!/usr/bin/env python3
"""spawn_chat.py - ACT: start a NEW desktop chat in a folder, with its first prompt.

THE CHIP QUESTION (owner, 2026-09-01: "are you capable of spinning off chips when the AI
spawns them, or do we need to build that capability?"). A background-task CHIP is a desktop
UI affordance: an AI flags follow-up work, a chip appears, and the OWNER clicks it to spin a
new session. The click is the whole point of a chip, and its state lives in the app's own UI
store - not a file anything else may drive. So the chips themselves stay his.

But a chip's PAYLOAD is only three things: a folder, a prompt, and a title. That the
orchestrator CAN do, mechanically and visibly, with the app's own deeplink - decoded from
the app bundle 2026-09-01:

    claude://code/new?prompt=<text>&folder=<path>        (`q` is accepted for `prompt`)

Invoked against a specific instance's --user-data-dir, Electron's single-instance lock
forwards it to that RUNNING app, which opens a new chat in that folder with the prompt in
place. Zero clicks, no headless process, visible where the owner watches - the same shape as
the claude://resume import the landing lane already relies on.

⛔ TRUST FIRST, ALWAYS. A folder the app does not trust stops on a modal no rail can answer,
so this pre-trusts the workspace (trust_workspace.py) before it spawns. Refusing to spawn
into an untrusted folder would just be the old stall with extra steps.

Usage: python spawn_chat.py --folder <path> --prompt "<text>" [--instance <name>] [--force] [--json]
       (--instance defaults to the account with the most fill-room, per the usage bands)
Exit:  0 spawned and its first turn confirmed running - 4 spawned, but the first turn is NOT
       confirmed (`submitted` / `started` say why; check the app) - 5 REFUSED: a visible chat
       already carries this exact task (--force insists) - 2 the instance is not open / not
       resolvable / its window busy - 3 bad usage - 1 daemon failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from lib import clilib, hydralib
from lib import windowlib

MODE_ACTUATOR = Path(__file__).resolve().parent / "actuator" / "approve_prompt.ps1"


def _set_mode_live(session_id: str, inst: dict, prompt: str) -> str:
    """Set a just-registered chat's permission mode to REQUIRED_MODE through the app's own
    picker (approve_prompt.ps1 -SetMode). The chat is identified by the title the app gave it
    (polled - the auto-title lands a few seconds after the first send) and by its own first
    words on screen (the prompt). Returns a one-line outcome; never raises."""
    if not MODE_ACTUATOR.exists():
        return "actuator missing"
    from lib import deliverylib

    title = ""
    deadline = time.time() + 30
    while time.time() < deadline and not title:
        try:
            ms = hydralib.dossier(session_id)
            title = str((ms[0].get("title") if ms else "") or "")
        except hydralib.DaemonError:
            title = ""
        if not title:
            time.sleep(3)
    if not title:
        return "no title yet - the doctrine lane sets the mode on its next pass"
    verify = deliverylib._verify_snippet(pane_words(prompt))
    args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(MODE_ACTUATOR),
            "-Title", title, "-Instance", str(inst.get("dir") or inst.get("name") or ""),
            "-Select", "-SetMode", REQUIRED_MODE]
    if verify:
        args += ["-VerifyText", verify]
    try:
        with windowlib.instance_lock(inst.get("dir"), wait_secs=60) as mine:
            if not mine:
                return "window busy - the doctrine lane sets the mode on its next pass"
            r = clilib.run_text(args, timeout=180)
    except Exception as err:  # a mode step must never unwind a spawn that already happened
        return f"actuator error: {str(err)[:120]}"
    said = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
    return (said[-1][:160] if said else f"exit {r.returncode}")


DEEPLINK = "claude://code/new"
# The permission mode every chat must be born with (owner doctrine: bypassPermissions,
# always) - the app's own label for it, as its composer picker shows it.
REQUIRED_MODE = "Bypass permissions"
TRUST_ACTUATOR = Path(__file__).resolve().parent / "actuator" / "trust_dialog.ps1"
SUBMIT_ACTUATOR = Path(__file__).resolve().parent / "actuator" / "submit_composer.ps1"
# How long to wait for a spawned chat to register before giving up on auto-starting it.
START_WAIT_SECS = 90


def _binary() -> str | None:
    """The desktop binary, resolved the same way the daemon's own import path resolves it."""
    for c in (Path.home() / "AppData/Local/AnthropicClaude/claude.exe",):
        if c.exists():
            return str(c)
    root = Path.home() / "AppData/Local/AnthropicClaude"
    apps = sorted(root.glob("app-*/claude.exe"), reverse=True)
    return str(apps[0]) if apps else None


def pick_instance() -> dict | None:
    """The open account with the most room under its fill ceiling (the usage bands)."""
    import balance

    survey, _src = balance.usage_rows_with_fallback()
    fleet = hydralib.fleet()
    ranked = [a for a in balance.rank_next(balance.accounts_overview(survey, fleet))
              if not a.get("mustOpen")]
    for a in ranked:
        ti = balance._target_instance(a)
        if ti:
            inst = hydralib.resolve_instance(fleet, str(ti.get("name")))
            if inst and inst.get("isRunning"):
                return inst
    return None


def _refuse_if_duplicate(prompt: str, force: bool) -> dict | None:
    """⛔ NEVER START THE SAME TASK TWICE (owner, 2026-09-01: two identical 'SageThumbs codebase
    review' chats, 30 minutes apart, both running - "it can't do it blind; it must always
    double check, confirm"). A chat already carrying this exact first prompt anywhere in the
    fleet, live or dormant, means this spawn is a duplicate. Returns a refusal dict, or None to
    let the spawn proceed."""
    if force:
        return None
    dups = hydralib.same_task_chats(prompt)
    if not dups:
        return None
    d = dups[0]
    return {"ok": False, "duplicateOf": dups,
            "why": (f"a chat for this exact task already exists: '{d.get('title')}' in "
                    f"{d.get('instance')} ({'running' if d.get('live') else 'dormant'})"
                    f"{' +%d more' % (len(dups) - 1) if len(dups) > 1 else ''} - not "
                    "starting a second one (--force is a person's word to insist)")}


def _resolve_target(instance: str | None) -> tuple[dict | None, dict | None]:
    """Resolve the instance to spawn into. Returns (inst, error) - exactly one of the two is
    None: an inst to proceed with, or an error dict ready to return from spawn()."""
    fleet = hydralib.fleet()
    inst = hydralib.resolve_instance(fleet, instance) if instance else pick_instance()
    if not inst:
        return None, {"ok": False, "why": f"no resolvable open instance"
                                          f"{f' matching {instance!r}' if instance else ''}"}
    if not inst.get("isRunning"):
        return None, {"ok": False, "why": f"instance '{inst.get('name')}' is not open - the "
                                          "deeplink is forwarded to a RUNNING app; open it first"}
    return inst, None


def _live_session_ids() -> set:
    """The session ids visible right now, best-effort - used as the 'before' snapshot so a
    freshly-registered session can be told apart from one that already existed."""
    try:
        return {s.get("sessionId")
                for s in hydralib.api_get("/api/sessions/live").get("sessions", [])}
    except hydralib.DaemonError:
        return set()


def _poll_trust_dialog(folder: str, inst: dict) -> str:
    """...and answer the desktop app's own trust modal for `folder`, if one appears. The file
    write the caller already did is the CLI's list; the DESKTOP app keeps its own and asks
    anyway (measured 2026-09-01), so the honest mechanical answer is the app's own control -
    scoped to THIS folder AND THIS instance (-Instance, same as _set_mode_live and
    _submit_composer pass), never a blind click (see actuator/trust_dialog.ps1's aim rail).
    Returns 'not-seen' (no actuator, no dir to aim at, or the modal never appeared),
    'answered', or 'refused-other-folder' (someone else's dialog - never touched)."""
    if not TRUST_ACTUATOR.exists():
        return "not-seen"
    if not inst.get("dir"):
        # No --user-data-dir to aim the actuator's -Instance at - nothing to scope the scan
        # to, so don't guess (2026-09-06).
        return "not-seen"
    deadline = time.time() + 20
    while time.time() < deadline:
        time.sleep(3)
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(TRUST_ACTUATOR), "-Folder", folder,
             "-Instance", str(inst.get("dir") or "")],
            timeout=120,
        )
        if r.returncode == 0:
            return "answered"
        if r.returncode == 4:
            return "refused-other-folder"
    return "not-seen"


def _submit_composer(inst: dict, prompt: str) -> tuple[str, str]:
    """SUBMIT THE PRE-FILLED COMPOSER (owner, 2026-09-01: "have it automatically handle spawned
    chats/chips"). The deeplink types the prompt and stops there, so a spawned chat would sit
    forever with its work written and never started (measured 2026-09-01: no engine ever
    registered). The submit actuator presses Send on the composer whose text IS our prompt -
    the strongest aim proof available, since a brand-new chat has no title or conversation to
    verify against. Returns (submitted, submit_note)."""
    if not SUBMIT_ACTUATOR.exists():
        return "not-attempted", ""
    if not inst.get("dir"):
        # REFUSE rather than pass an empty -Instance: an unscoped actuator call can hit a
        # DIFFERENT window's composer, not merely fail (2026-09-06).
        return "refused: instance has no --user-data-dir to aim the actuator at", ""
    time.sleep(6)  # let the deeplink paint the composer
    submitted = "not-attempted"
    submit_note = ""
    for _ in range(6):
        # BORN IN BYPASS (2026-09-01): a deeplink chat starts in the app's default mode and no
        # disk stamp sticks while it lives, so it stalled on its first shell call. The actuator
        # sets the app's own permission picker to bypass BEFORE pressing Send, and refuses
        # (exit 6) rather than start a chat that will only stall - a refused spawn is a report;
        # a stuck chat is a mess.
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(SUBMIT_ACTUATOR), "-Contains", prompt[:60],
             "-Instance", str(inst.get("dir") or ""),
             "-RequireMode", REQUIRED_MODE],
            timeout=180,
        )
        # The actuator's own last lines ride along in the report: "permission mode set:
        # 'Default permissions' -> 'Bypass permissions'" is the proof the chat was born right,
        # and its absence is the first thing to read when it was not.
        said = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
        submit_note = " | ".join(s[:120] for s in said[-3:])
        if r.returncode == 0:
            return "sent", submit_note
        submitted = f"exit {r.returncode}"
        if r.returncode == 6:
            # the mode could not be set: say exactly what the actuator saw
            tail = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
            submitted = f"exit 6 - {tail[-1][:160] if tail else 'permission mode not set'}"
            return submitted, submit_note
        time.sleep(5)
    return submitted, submit_note


def _drive_spawn_window(inst: dict, folder: str, prompt: str, binary: str) -> dict:
    """Everything that pokes the instance's window for one spawn: send the deeplink, answer the
    trust modal, submit the composer - ONE DRIVER PER WINDOW (windowlib.instance_lock), since
    the deeplink, the trust dialog and the composer submit all poke this instance's window, and
    another lane driving it in the same moment (a courier send, an unblock press) is how text
    lands in the wrong pane. The window placement is restored afterward regardless of outcome.
    Returns {'ok': False, 'why': ...} if the window was busy, else {'ok': True, 'url',
    'dialog', 'submitted', 'submit_note', 'window_note'}."""
    if not inst.get("dir"):
        # REFUSE rather than lock on an empty key - instance_lock(None, ...) would not be
        # keyed to anything real, so it could not actually stop a second lane driving the
        # SAME window this one is about to poke (2026-09-06).
        return {"ok": False,
                "why": f"instance '{inst.get('name')}' has no --user-data-dir - refusing to "
                       "drive its window"}
    with windowlib.instance_lock(inst.get("dir"), wait_secs=120) as mine:
        if not mine:
            return {"ok": False, "why": (f"{inst.get('name')}'s window is busy - another lane "
                                         "is driving it right now; retry in a minute")}
        # Note how the owner had this window before we hand the app a deeplink, so it can be
        # put back if handling one moves it (windowlib; measured not to on this route, kept as
        # the guard that would catch it if the app's behaviour ever changes). Restored in the
        # finally, so an actuator timeout can no longer leave the window wherever the app put
        # it (the restore used to sit on the success return only).
        placement = windowlib.capture(inst.get("dir"))
        window_note = "unchanged"
        try:
            url = (f"{DEEPLINK}?prompt={urllib.parse.quote(prompt)}"
                   f"&folder={urllib.parse.quote(folder)}")
            subprocess.Popen([binary, f"--user-data-dir={inst.get('dir')}", url],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            dialog = _poll_trust_dialog(folder, inst)
            submitted, submit_note = _submit_composer(inst, prompt)
        finally:
            window_note = windowlib.restore(inst.get("dir"), placement) or "unchanged"
    return {"ok": True, "url": url, "dialog": dialog, "submitted": submitted,
            "submit_note": submit_note, "window_note": window_note}


def _await_new_session(folder: str, before_ids: set, inst: dict) -> tuple[str | None, str | None]:
    """Wait for the new session to REGISTER (it appears in the live registry with our folder as
    its cwd). A spawn that never registers is reported honestly, never claimed.

    THE APP DOES NOT ALWAYS HONOUR THE FOLDER (measured 2026-09-01, three spawns in a row): the
    deeplink chat opened and ran, but in the instance's own scratch workspace
    (...\\<instance>\\scratch-workspaces\\...), so a cwd==folder test reported "not-confirmed"
    for a chat that was live and answering. A brand-new session in a scratch workspace of the
    app we just poked IS our chat - taken, and REPORTED as landed in scratch so nobody reads the
    folder as trusted-and-used when it was not. Returns (session_id, landed_in), both None if
    nothing registered inside START_WAIT_SECS."""
    deadline = time.time() + START_WAIT_SECS
    want = str(Path(folder).resolve()).replace(chr(92), "/").lower()
    while time.time() < deadline:
        time.sleep(5)
        try:
            live = hydralib.api_get("/api/sessions/live").get("sessions", [])
        except hydralib.DaemonError:
            continue
        new = [s for s in live if s.get("sessionId") not in before_ids]
        fresh = [s for s in new
                 if str(s.get("cwd") or "").replace(chr(92), "/").lower() == want]
        scratch = [s for s in new
                   if "scratch-workspaces" in str(s.get("cwd") or "").replace(chr(92), "/").lower()
                   and str(inst.get("dir") or "").replace(chr(92), "/").lower()
                   in str(s.get("cwd") or "").replace(chr(92), "/").lower()]
        if fresh or scratch:
            session_id = (fresh or scratch)[0].get("sessionId")
            landed_in = "folder" if fresh else "scratch-workspace (the app ignored --folder)"
            return session_id, landed_in
    return None, None


def _start_first_turn(session_id: str, inst: dict, prompt: str, submitted: str,
                       folder: str) -> tuple[str, str]:
    """Get the new session's first turn actually running, then BORN RIGHT, THEN KEPT RIGHT
    (2026-09-01): set its permission mode through the app's own control - the new-chat view
    shows no permission picker until the chat exists, so a deeplink chat starts in the app's
    default mode and no disk stamp sticks while it lives; now that it exists, this is the one
    write the running app does not re-save away. Also records the spawn in the ledger as THE
    PROVENANCE RECORD: this chat was born by the toolbox with bypass PROMISED, so if it still
    stalls on a prompt in default mode, unblock_prompts may answer it on the strength of this
    record - a person never chose that mode, the spawner did. Returns (started, mode_set)."""
    if submitted == "sent":
        # The composer submit already started the first turn - registering IS the proof.
        # POSTing the prompt to the session as well queued the identical prompt a second time
        # (review 2026-09-01: two starters stacked, where one was meant as a fallback), so the
        # chat ran its whole task twice.
        started = "running (composer submitted; engine registered)"
    else:
        # FALLBACK STARTER: no actuator pressed Send, so deliver the prompt through the
        # daemon's message endpoint - the peer channel for a live session, no UI.
        try:
            got = hydralib.api_post(f"/api/sessions/{session_id}/message",
                                    {"text": prompt, "confirm_secs": 90}, timeout=180)
            started = ("running" if (isinstance(got, dict) and got.get("delivered"))
                       else "typed-not-confirmed")
        except hydralib.DaemonError as err:
            started = f"first-turn delivery failed ({(err.detail or str(err))[:100]})"
    mode_set = _set_mode_live(session_id, inst, prompt)
    from lib import ledgerlib
    ledgerlib.note("spawned", session_id, note=f"spawn_chat: {folder}; mode: {mode_set[:80]}")
    return started, mode_set


def spawn(folder: str, prompt: str, instance: str | None, force: bool = False) -> dict:
    refusal = _refuse_if_duplicate(prompt, force)
    if refusal is not None:
        return refusal

    inst, error = _resolve_target(instance)
    if error is not None:
        return error

    binary = _binary()
    if not binary:
        return {"ok": False, "why": "no desktop binary found to send the deeplink to"}

    # TRUST FIRST (docstring): a chat in an untrusted folder stalls on a human dialog.
    import trust_workspace

    trust = trust_workspace.apply_trust([folder], act=True)

    before_ids = _live_session_ids()

    drive = _drive_spawn_window(inst, folder, prompt, binary)
    if not drive["ok"]:
        return drive
    url = drive["url"]
    dialog = drive["dialog"]
    submitted = drive["submitted"]
    submit_note = drive["submit_note"]
    window_note = drive["window_note"]

    session_id, landed_in = _await_new_session(folder, before_ids, inst)
    started = "not-confirmed"
    mode_set = "not-attempted"
    if session_id:
        started, mode_set = _start_first_turn(session_id, inst, prompt, submitted, folder)

    return {"ok": True, "instance": inst.get("name"), "folder": folder,
            "landedIn": landed_in,
            "trusted": trust["trusted"], "trustDialog": dialog,
            "sessionId": session_id, "submitted": submitted, "submitNote": submit_note,
            "started": started, "modeSet": mode_set,
            "window": window_note,
            "url": url[:120]}


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    folder = prompt = instance = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--folder" and i + 1 < len(argv):
            folder = argv[i + 1]; i += 2; continue
        if a == "--prompt" and i + 1 < len(argv):
            prompt = argv[i + 1]; i += 2; continue
        if a == "--instance" and i + 1 < len(argv):
            instance = argv[i + 1]; i += 2; continue
        i += 1
    if not folder or not prompt:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    if not Path(folder).is_dir():
        print(f"REFUSED: {folder!r} is not a directory - a chat cannot start there",
              file=sys.stderr)
        return 3

    try:
        result = spawn(folder, prompt, instance, force="--force" in argv)
    except hydralib.DaemonError as err:
        print(f"spawn FAILED: {err}", file=sys.stderr)
        return 1

    # `ok` only says the instance and binary resolved; whether the first turn actually
    # STARTED is `started`. The human-readable line and the exit code say which (review
    # 2026-09-01: the success sentence and exit 0 used to print for a chat that never ran).
    running = str(result.get("started") or "").startswith("running")
    if as_json:
        print(json.dumps(result, indent=2))
    elif result["ok"]:
        extra = f" (trusted {len(result['trusted'])} folder(s) first)" if result["trusted"] else ""
        if running:
            # Say what happened to the permission mode too - it was computed all along and
            # only the JSON carried it (live smoke, 2026-09-01: the mode had to be confirmed
            # through the dossier by hand).
            print(f"spawned a new chat in {result['instance']} at {result['folder']}{extra}. "
                  f"Its first turn is running ({result['started']}); "
                  f"permission mode: {result.get('modeSet', 'not-attempted')}.")
        else:
            print(f"spawned a new chat in {result['instance']} at {result['folder']}{extra} - "
                  f"but its first turn is NOT confirmed: submitted={result['submitted']}, "
                  f"started={result['started']}. Check the app.", file=sys.stderr)
    else:
        print(f"REFUSED: {result['why']}", file=sys.stderr)
    if not result["ok"]:
        return 5 if result.get("duplicateOf") else 2
    return 0 if running else 4


def pane_words(prompt: str) -> str:
    """The prompt as the pane renders it (a slash command shows its ARGUMENTS) - the one rule
    lives in gatelib.pane_words; every aim rail (spawn, unblock, doctrine) reads it there."""
    from lib import gatelib

    return gatelib.pane_words(prompt)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
