"""armlib - the unattended machinery acts ONLY while the tray icon is up.

THE ORDER (owner, 2026-09-01, after the lanes spent an afternoon load-balancing his chats
without managing them): "It should never just do whatever it wants without at least some
occasional instruction... It can't be running without the status bar icon, so I can
terminate it if I want." So the status-bar icon (scripts/tray.ps1) IS the switch: while it
runs it writes a heartbeat here every few seconds; every lane that ACTS - moves, wakes,
archives, presses, stamps, writes files - checks that heartbeat first, and a stale or missing
one means "planned only, nothing acted". Close the icon and the machinery stops; there is
nothing to remember to turn off.

    python orch.py arm        # start the icon (the eyes resume with it)
    python orch.py disarm     # close the icon (the eyes pause with it)
    python orch.py armed      # is it up

The icon's own Pause keeps it visible but sets `paused` in the heartbeat, which also reads as
disarmed. No icon = disarmed, on any machine, by default. Observing (dashboard, dry loops,
--json plans) is never gated - seeing is not doing.

`--force` on a script a PERSON runs by hand is that person's word for one act and bypasses
the switch, exactly as it bypasses a hold (holdlib) - the switch bounds the UNATTENDED path.
`arm(secs)` remains as an in-process window for tests and for a headless machine with no
tray at all; the CLI does not expose it, because the owner wants the icon to be the truth.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

from lib import clilib
from lib import ledgerlib

ARM_CMD = "python orch.py arm"
# The tray writes every HEARTBEAT_SECS; a heartbeat older than STALE_SECS is a dead tray
# (killed, crashed, logged out) and reads as disarmed.
HEARTBEAT_SECS = 15
STALE_SECS = 60

# THE CANONICAL DIRECT-VS-UNATTENDED SET (AH-25). Before this, "which scripts actually ask
# the tray icon" lived nowhere as a fact you could name - it was whatever each script's own
# source happened to do (call refuse_unless_armed, or don't). These are the ones that DO: the
# scheduled lane goes through the gate on every tick, and a person's own --force is the
# documented bypass for one run by hand (this module's own docstring, "the switch bounds the
# UNATTENDED path"). Everything else - migrate_chat.py's documented exception among them -
# never imports this module at all, and is therefore "direct" by the same fact, not by a
# second list. lib/actionlib.CATALOG's `invocation` field is DERIVED from this set at import
# time (see actionlib.py's own tail), so the catalog cannot silently drift from what the code
# actually does - grep this file for `refuse_unless_armed(argv` if you ever need to re-verify
# it by hand instead of trusting the set.
GATED_SCRIPTS = frozenset({
    "audit_twins", "automation_chat", "chips", "cli_saturate", "courier",
    "groundskeeper", "harvest_todos", "overlord", "reconcile", "saturate",
    "sweep", "unblock_prompts",
})


def requires_arm_check(script_name: str) -> bool:
    """Whether `script_name` is expected to consult refuse_unless_armed - i.e. it is reached
    from the unattended scheduled lane, not only from a person's direct word. A predicate
    function rather than a bare set lookup so a caller never has to know GATED_SCRIPTS is a
    frozenset versus some other container - this is the one thing to call."""
    return script_name in GATED_SCRIPTS


def heartbeat_path() -> Path:
    return ledgerlib._state_dir() / "tray.json"


def _window_path() -> Path:
    return ledgerlib._state_dir() / "armed.json"


def parse_duration(text: str) -> int:
    """'4h' / '90m' / '2d' / '30s' / a bare number of minutes -> seconds. Raises ValueError."""
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*", str(text or ""))
    if not m:
        raise ValueError(f"not a duration: {text!r} (use 90m, 4h, 2d)")
    n, unit = float(m.group(1)), m.group(2) or "m"
    secs = n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    if secs <= 0:
        raise ValueError("a window must be longer than zero")
    return int(secs)


def _pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = clilib.run_text(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                                 timeout=20)
            return str(pid) in (out.stdout or "")
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def tray_status(now_s: float | None = None, check_pid: bool = True) -> dict:
    """What the icon says: {up, paused, pid, ageSecs, why}. `up` is a FRESH heartbeat from a
    LIVE process - a file left behind by a killed tray is not an icon."""
    now_s = now_s if now_s is not None else time.time()
    try:
        rec = json.loads(heartbeat_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"up": False, "paused": False, "pid": None, "ageSecs": None,
                "why": "the tray icon is not running"}
    at = float(rec.get("at") or 0) / 1000.0
    age = max(0.0, now_s - at)
    pid = rec.get("pid")
    if age > STALE_SECS:
        return {"up": False, "paused": bool(rec.get("paused")), "pid": pid, "ageSecs": int(age),
                "why": f"the tray icon's heartbeat is {int(age)}s old - it is gone"}
    if check_pid and pid and not _pid_alive(pid):
        return {"up": False, "paused": bool(rec.get("paused")), "pid": pid, "ageSecs": int(age),
                "why": f"the tray icon's process {pid} is not alive"}
    return {"up": True, "paused": bool(rec.get("paused")), "pid": pid, "ageSecs": int(age),
            "why": "paused from the icon's menu" if rec.get("paused") else ""}


def write_heartbeat(pid: int, paused: bool = False, now_ms: int | None = None) -> None:
    """The tray's beat (also usable by any process that wants to stand in for it)."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    p = heartbeat_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"pid": int(pid), "at": now_ms, "paused": bool(paused)}),
                   encoding="utf-8")
    os.replace(tmp, p)


def clear_heartbeat() -> None:
    try:
        heartbeat_path().unlink()
    except OSError:
        pass


def _window(now_ms: int) -> tuple[dict | None, str]:
    """(the open window, or None), plus the reason when a window file exists but lapsed."""
    try:
        rec = json.loads(_window_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, ""
    until = int(rec.get("until") or 0)
    if until > now_ms:
        return rec, ""
    return None, (f"the window opened by {rec.get('by') or 'someone'} expired "
                  f"{(now_ms - until) // 60000}m ago")


def status(now_ms: int | None = None) -> dict:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    tray = tray_status(now_ms / 1000.0)
    if tray["up"] and not tray["paused"]:
        return {"armed": True, "source": "tray", "tray": tray, "remainingSecs": 0,
                "by": "tray", "note": None, "why": ""}
    win, lapsed = _window(now_ms)
    if win:
        remaining = (int(win["until"]) - now_ms) // 1000
        return {"armed": True, "source": "window", "tray": tray,
                "remainingSecs": int(remaining), "by": win.get("by"), "note": win.get("note"),
                "why": ""}
    why = tray["why"] if not lapsed else f"{tray['why']}; {lapsed}"
    return {"armed": False, "source": None, "tray": tray, "remainingSecs": 0,
            "by": None, "note": None, "why": why}


def armed(now_ms: int | None = None) -> bool:
    return bool(status(now_ms)["armed"])


def arm(duration_secs: int, by: str = "owner", note: str = "",
        now_ms: int | None = None) -> dict:
    """An in-process window (tests, headless machines). The CLI never exposes it."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    p = _window_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    rec = {"until": now_ms + int(duration_secs) * 1000, "at": now_ms, "by": by, "note": note}
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rec), encoding="utf-8")
    os.replace(tmp, p)
    return status(now_ms)


def disarm() -> dict:
    """Close the window AND drop the heartbeat - after this nothing reads as armed until the
    tray (or a test) says otherwise."""
    for p in (_window_path(), heartbeat_path()):
        try:
            p.unlink()
        except OSError:
            pass
    return status()


def refuse_unless_armed(argv: list[str], what: str) -> str | None:
    """None when this act may go ahead; otherwise the line to print INSTEAD of acting.

    Allowed while the tray icon is up and not paused (or an in-process window is open), or
    when the caller passed --force (a person's word, by hand, for this one act)."""
    if "--force" in (argv or []):
        return None
    st = status()
    if st["armed"]:
        return None
    return (f"DISARMED - {what}: planned only, nothing acted ({st['why']}). The unattended "
            f"machinery acts only while the tray icon is up: `{ARM_CMD}` (or --force for "
            "this one run by hand).")


def refuse_unless_armed_for(script_name: str, argv: list[str], what: str) -> str | None:
    """The catalog-consulting form of refuse_unless_armed (AH-25): looks up whether
    `script_name` even needs to ask, via lib/actionlib.CATALOG's `invocation` field, instead
    of a caller having to know a second, hand-maintained list of exempt scripts. A script
    whose entry is invocation="direct" (migrate_chat.py's documented exception, and everyone
    else GATED_SCRIPTS above does not name) is waved through with no check at all - exactly
    what already happens today when such a script's own source contains no call to
    refuse_unless_armed. Anything else (invocation "both" or "unattended") is asked exactly
    as refuse_unless_armed already asks.

    This is new, additional plumbing, not a replacement for the dozen existing call sites:
    the scripts in GATED_SCRIPTS keep calling refuse_unless_armed directly, unchanged, so
    today's behaviour is untouched. This entry point exists for a caller that only knows a
    script BY NAME (orch.py's dispatch, a future daemon route reading --catalog) and wants
    one answer without importing actionlib itself."""
    from lib import actionlib  # local: actionlib imports armlib at module scope (to derive
                                # CATALOG's own invocation field), so importing it back at
                                # armlib's own module scope would be a cycle at load time.

    row = actionlib.CATALOG.get(script_name)
    if row is not None and row["invocation"] == "direct":
        return None
    return refuse_unless_armed(argv, what)
