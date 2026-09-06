#!/usr/bin/env python3
"""schedule_jobs.py - ACT (machine config): run the orchestrator's recurring jobs on a timer.

WHY NOT AGENTHYDRA'S QUEUE (checked 2026-08-31, and it is not a gap to fix): its queue exists
to launch CHAT sessions, and headless runs are hard-refused - `headlessRunsAllowed()` returns
a literal false and the route answers 409 "AgentHydra does not run chats you cannot see (owner
law, 2026-08-27, restated 2026-08-31 - there is no setting for this)". The orchestrator's jobs
are not chats, so the law does not forbid them; they simply cannot ride a queue built for
chats. Nothing here touches the desktop app's own configuration either (owner: "not inside the
app itself").

So: WINDOWS TASK SCHEDULER, registered from this repo, running .cmd wrappers this script
generates. Each wrapper logs to state/logs/<job>.log, refuses to run when the daemon is down
(a job that cannot read the fleet must not pretend it ran), and is plain text you can read.

⛔ NOTHING FLASHES A CONSOLE (owner, 2026-08-31: "I don't want to see an active command
prompt"). Every task's action is `wscript.exe` running a generated VBScript shim that starts
its .cmd with window style 0 - invisible, no taskbar button, no focus steal. The dashboard
itself is started with pythonw.exe, which has no console at all, so it keeps serving after
the shim exits. Never register a task whose action is the .cmd directly: that is what pops a
window every five minutes.

THE JOBS (cadence set 2026-08-31 by owner: "these sweeps need to run every 5 minutes")
  dashboard   every 5 min, starts it only if the port is NOT already answering - keeps the
              read-only decision dashboard up (it dies with whatever session started it,
              which was its only real weakness). Deliberately not an ONLOGON trigger:
              schtasks refuses to register one without elevation ("Access is denied"), and a
              5-minute check needs no admin and covers the same ground within five minutes
  reconcile   every 5 min - did every past archive attempt settle? OBSERVE ONLY, never
              --retry: an unattended retry is the shape both previous orchestrators died of
  todo-sweep  every 5 min - `odin discover` (new codebases) + `odin loki --file --apply`
              (consolidate open work into each codebase's docs/todo/). Writes files; never
              stages, commits or pushes anything. This one is MINUTES long over a real
              fleet, so it holds a lockfile: a tick that finds the previous run still going
              says so and exits, rather than stacking runs on top of each other
  saturate    every 5 min - keep the machine FULL: wake dormant chats round-robin across
              accounts until the running floor is met (18 is a floor, not a ceiling)
  unblock     every 5 min - restart chats stopped on a permission prompt they should never
              have seen (bypass chats, or chats the toolbox itself promised bypass)
  twins       every 5 min - is any chat VISIBLE in two places, or the same task started
              twice? --fix retires the stale copy / HOLDS the later duplicate; never live work
  groundskeeper every 5 min - archive chats whose own recap claims done (through the
              knowledge-preservation step), evacuate STOPPED chats off burnt accounts, and
              NAME every stuck or stranded live chat - it never moves a live one. Capped per run
  overlord    every 5 min - the watchdog for the standing manager chat: nudge it awake,
              hand it off when its account hits the usage wall, never let the fleet go dark
  doctrine    every 2 MIN, ALWAYS ON - the one lane exempt from the tray icon (owner,
              2026-09-01: the bypass check "can be done autonomously, as long as it's
              programmatically"). Re-stamps bypassPermissions + ultracode across every chat
              and drives the app's own permission picker for a live chat still off-doctrine.
              Held chats are stamped too (a hold covers a chat's WORK, not its permission
              mode); archived ones are left alone

Every lane except dashboard and doctrine (UNGATED_JOBS) runs behind THE SWITCH: its wrapper
asks `orch.py armed --quiet` first and logs DISARMED when the tray icon is not up.

Usage: python schedule_jobs.py                 # what WOULD be registered (dry run)
       python schedule_jobs.py --list          # the same dry run, spelled out
       python schedule_jobs.py --apply         # write wrappers + register the tasks
       python schedule_jobs.py --status        # what is registered now, and when it last ran
       python schedule_jobs.py --pause         # THE OFF SWITCH: tasks stay registered but
                                               # stop firing until --resume (the tray uses this)
       python schedule_jobs.py --resume        # firing again
       python schedule_jobs.py --remove        # unregister everything this script created
       python schedule_jobs.py --only reconcile --apply
Exit:  0 ok - 2 a task did not register/remove/change cleanly - 3 bad usage - 1 not Windows.

THE TRAY: `scripts/tray.ps1` is the human switch for all of this - a status-bar icon with
pause/resume, open-dashboard and open-logs. `powershell -File scripts\\tray.ps1
-InstallShortcut` puts "Orchestrator" on the Desktop; double-click starts the icon.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# THE UTF-8 CONSOLE, REPEATED HERE ON PURPOSE (2026-09-01). Every other script in this repo
# inherits it from lib/__init__.py, which runs on `from lib import ...`. This script
# deliberately imports NOTHING from lib - it is the standalone bootstrap that installs the
# scheduled tasks, and must run before any of that exists - so the one-place fix cannot
# reach it. Without these lines `--help` alone dies on the no-entry sign in its own
# docstring, on a Windows cp1252 console. Duplicated deliberately; see lib/__init__.py for
# why it matters (a crash on the REPORT, after the work, is the shape being prevented).
from lib import clilib  # noqa: E402 - after the stdlib imports it needs, before anything prints

clilib.use_utf8_console()

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"
PREFIX = "Orchestrator-"

# Odin is a separate program in its own clone; the to-do sweep drives it, so its location is a
# parameter rather than an assumption. Env override for the other machine.
ODIN = Path(os.environ.get("ODIN_HOME", r"D:\NEWProjects\shared\odin"))

# The interpreters, resolved from THIS process rather than from PATH: a scheduled task runs
# with a different environment than a terminal, and "python" may not be on it at all.
PYTHON = Path(sys.executable)
PYTHONW = PYTHON.with_name("pythonw.exe")  # no console window, ever


def _state() -> Path:
    return Path(os.environ.get("ORCHESTRATOR_STATE_DIR") or (REPO / "state"))


EVERY_5_MIN = ["/SC", "MINUTE", "/MO", "5"]
# The doctrine lane's cadence - "a constant check" (owner, 2026-09-01); the lane takes seconds
# and its own lock keeps ticks from stacking.
EVERY_2_MIN = ["/SC", "MINUTE", "/MO", "2"]

JOBS: dict[str, dict] = {
    "dashboard": {
        "what": "keep the read-only decision dashboard serving on 127.0.0.1:7799",
        # Task Scheduler cannot 'ensure running', so the wrapper checks the port and no-ops
        # when it already answers. ONLOGON would need elevation, so a plain repeat instead.
        "schedule": EVERY_5_MIN,
        "lines": [
            'powershell -NoProfile -WindowStyle Hidden -Command "try { $r = Invoke-WebRequest '
            "'http://127.0.0.1:7799/data/health' -TimeoutSec 5 -UseBasicParsing; exit 0 } "
            'catch { exit 1 }"',
            "if %ERRORLEVEL%==0 ( echo [%DATE% %TIME%] already serving & exit /b 0 )",
            # pythonw.exe has NO console, so the dashboard survives the shim's exit without
            # ever owning a window. python.exe here would flash one AND die with the shim.
            'start "" /B "{pythonw}" "{scripts}\\dashboard.py" --port 7799',
            "echo [%DATE% %TIME%] started the dashboard",
        ],
        "needs_daemon": False,
        "lock": False,
    },
    # ⛔ THERE IS DELIBERATELY NO "remote" LANE HERE, and one must never be added back.
    # The remote front-end shipped with a keepalive job on this list for a few hours on
    # 2026-09-02, and it was a false kill switch: the lane was UNGATED (the gateway only ever
    # observes, so gating it looked like pedantry), which meant closing the tray icon stopped
    # the lanes and then a scheduled task quietly restored remote access within five minutes.
    # The gateway can throw the arm switch from a phone, so that is a route to arming this
    # machine with no icon on screen - the exact thing the icon exists to prevent. The tray now
    # owns the gateway's whole lifetime (scripts/tray.ps1: starts it, watchdogs it every 15s,
    # stops it on Exit) and the gateway independently stops itself when the heartbeat goes
    # stale (ORCH_TRAY_SUPERVISED). A supervisor that can act while the icon is gone belongs to
    # neither half of that design.
    "reconcile": {
        "what": "did every past archive attempt settle? (observe only - never an unattended retry)",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\reconcile.py"'],
        "needs_daemon": True,
        "lock": True,
    },
    # UNGATED ON PURPOSE, and it is the one lane where that is not a contradiction (owner,
    # 2026-09-02, after two chats turned up archived and nothing could say who did it). Every
    # other lane logs what IT did; this one logs what HAPPENED TO A CHAT, whoever did it - a
    # lane, another agent session, or a person in the app. Gating it behind the tray would
    # blind it during exactly the window you most need explained: while the orchestrator was
    # off. It reads metadata files and writes a journal; it can never act, so there is nothing
    # for the switch to protect against. (Contrast the deleted "remote" lane above, which was
    # ungated AND could arm the machine - that is the shape that must never come back.)
    "chat-journal": {
        "what": "journal every chat archived/moved/renamed anywhere, and whether WE did it",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\chatwatch.py" --quiet'],
        "needs_daemon": False,
        "lock": True,
    },
    "todo-sweep": {
        "what": "find new codebases, then consolidate open work into each codebase's docs/todo/",
        "schedule": EVERY_5_MIN,
        "lines": [
            '"{python}" "{odin}\\odin.py" discover',
            '"{python}" "{odin}\\odin.py" loki --file --apply',
        ],
        "needs_daemon": True,
        # Minutes long over a real fleet: at a 5-minute tick, runs WOULD overlap without this.
        "lock": True,
    },
    "saturate": {
        "what": "KEEP THE MACHINE FULL: wake dormant chats round-robin across accounts until "
                "the running floor is met (owner, 2026-09-01: 18 is a floor, not a ceiling, "
                "and one account must never hog it)",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\saturate.py" --yes'],
        "needs_daemon": True,
        "lock": True,
    },
    "unblock": {
        "what": "ANSWER THE PROMPTS THAT SHOULD NEVER HAVE BEEN SHOWN: a chat configured "
                "bypassPermissions that stopped on an Allow prompt is restarted (owner, "
                "2026-09-01: 'four chats currently pending on someone to push enter')",
        "schedule": EVERY_5_MIN,
        "lines": [r'"{python}" "{scripts}\unblock_prompts.py" --yes'],
        "needs_daemon": True,
        "lock": True,
    },
    "twins": {
        "what": "IS ANY CHAT VISIBLE TWICE? A re-import can leave a second record for the same "
                "conversation, and a twin makes that chat unmanageable (the sidebar actuator "
                "refuses to guess between identical titles). Archives the stale copy",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\audit_twins.py" --fix'],
        "needs_daemon": True,
        "lock": True,
    },
    "chips": {
        "what": "THE SUGGESTED-TASK CHIPS (owner, 2026-09-01: 'always Start locally, never in a "
                "worktree'): the desktop plants a Suggested task card in a chat; this starts it "
                "LOCALLY through the app's own menu - never a task already open (then it is "
                "dismissed), never past the running cap, and confirmed through the sessions index",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\chips.py" --yes'],
        "needs_daemon": True,
        "lock": True,
    },
    "groundskeeper": {
        "what": "THE DORMANT LANE: move wake-able chats OFF an account past its usage target, "
                "and archive the ones whose own recap says done (owner, 2026-09-01: 'multiple "
                "of my accounts have dormant chats just sitting there not running or archived')",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\groundskeeper.py" --yes'],
        "needs_daemon": True,
        "lock": True,
    },
    "overlord": {
        "what": "THE WATCHDOG: wake the standing /orchestrate chat when it goes quiet while "
                "work waits - the mechanical re-arm (owner, 2026-09-01: relying on the chat "
                "to arm its own timer left it dead for 48 minutes)",
        "schedule": EVERY_5_MIN,
        "lines": ['"{python}" "{scripts}\\overlord.py"'],
        "needs_daemon": True,
        "lock": True,
    },
    "doctrine": {
        "what": "THE DOCTRINE: every chat runs bypassPermissions + ultracode, re-stamped on "
                "a clock because conformance DECAYS (owner, 2026-09-01: 'all chats need to "
                "always be set to bypass permissions')",
        # Landing stamps a fresh chat, and that used to be the entire enforcement - which is
        # how 21 chats were found unstamped, 9 missing bypass itself. The stamp does not stay
        # put: under a RUNNING app the in-memory record is authoritative and re-saves over the
        # disk stamp, so a correctly-stamped fleet drifts back on its own with nobody doing
        # anything wrong (measured the day this was added: 21 stamped, 11 adrift ten minutes
        # later). An invariant that decays cannot be enforced once - it has to re-converge,
        # so this runs every TWO minutes, and WITHOUT the tray icon (UNGATED_JOBS; owner,
        # 2026-09-01: "a constant check... autonomously, as long as it's programmatically").
        # A LIVE chat off-doctrine also gets the app's own permission picker driven
        # (automation_chat.set_mode_via_app) - the disk stamp is what a running app re-saves
        # away, the picker is what it keeps. The acting sweep stamps too; this task is what
        # keeps it true when no chat is alive to sweep.
        "schedule": EVERY_2_MIN,
        "lines": ['"{python}" "{scripts}\\automation_chat.py" --all --yes'],
        "needs_daemon": True,
        "lock": True,
    },
}

DAEMON_GUARD = (
    'powershell -NoProfile -WindowStyle Hidden -Command "try { Invoke-WebRequest '
    "'http://127.0.0.1:7787/api/health' -TimeoutSec 10 -UseBasicParsing | Out-Null; exit 0 } "
    'catch { exit 1 }"\n'
    "if not %ERRORLEVEL%==0 (\n"
    "  echo [%DATE% %TIME%] SKIPPED - the AgentHydra daemon is not answering on 7787.\n"
    "  exit /b 0\n"
    ")\n"
)

# ⛔ THE ICON GUARD (owner, 2026-09-01: "it should never just do whatever it wants without at
# least some occasional instruction... it can't be running without the status bar icon"). A
# lane that ACTS runs only while the tray icon (scripts/tray.ps1) is up and beating;
# `armed --quiet` answers 0 then, 3 otherwise. Every acting script asks armlib again on its
# own (defence in depth); this guard just keeps a disarmed tick from even starting python work.
# ⛔ NO PARENTHESES INSIDE A cmd `if ( ... )` BLOCK, EVER (found 2026-09-01, the hard way):
# cmd parses the whole block before running either branch, a ')' inside the echo text closes
# the block early, and the rest of the line becomes the error "<word> was unexpected at this
# time." - the batch aborts with exit 255 BEFORE the lane script runs, on every tick, whether
# or not the branch was taken. The first cut of this guard said "(python orch.py arm)" and
# every lane logged "nothing was unexpected at this time." and did nothing, for an hour.
# The lanes that run WITHOUT the icon: the dashboard only looks, and the doctrine lane only
# configures - owner, 2026-09-01: "a constant check for any chats/threads that are not bypass
# permissions and it should auto set them to that. This can be done autonomously, as long as
# it's programmatically." Everything that touches a chat's WORK still needs the icon.
UNGATED_JOBS = ("dashboard", "doctrine", "chat-journal")

ARM_GUARD = (
    '"{python}" "{repo}\\orch.py" armed --quiet\n'
    "if not %ERRORLEVEL%==0 (\n"
    "  echo [%DATE% %TIME%] DISARMED - the tray icon is not up - start it with: python orch.py arm - nothing acted.\n"
    "  exit /b 0\n"
    ")\n"
)

# AH-16: a tick that finds the previous run still going must SAY SO and leave, never stack -
# but "still going" must be PROVEN, not merely inferred from age. The lock used to be a bare
# mkdir'd directory reclaimed once it was older than 30 minutes, with no check of who held it:
# a second wrapper invocation could steal a legitimate long-running job's lock past that
# window, and the ORIGINAL holder then unconditionally rmdir'd the lock on its own exit -
# deleting its successor's lock too. The ownership/heartbeat/reclaim logic now lives in
# lib/joblocklib.py (PID + process-creation-time ownership, reclaim only on proven death, only
# the owning token may release) and runs from Python via run_locked.py, never as raw cmd/
# PowerShell text in the wrapper - which also means the wrapper carries no `if ( ... )` block
# for this any more, so it cannot fall into the "a ')' inside the block aborts the whole batch"
# footgun documented on ARM_GUARD below.
def work_path(job: str) -> Path:
    """The plain, unguarded .cmd holding just a lock-carrying job's own command lines -
    run_locked.py invokes this while it holds the job lock. A job with lock=False never gets
    one; its lines are inlined straight into the main wrapper as before."""
    return _state() / "jobs" / f"{job}.work.cmd"


RUN_LOCKED = SCRIPTS / "run_locked.py"


def wrapper_path(job: str) -> Path:
    return _state() / "jobs" / f"{job}.cmd"


def shim_path(job: str) -> Path:
    """The VBScript that runs the .cmd with NO WINDOW. The scheduled task's action points at
    this, never at the .cmd - pointing at the .cmd is what flashes a console every tick."""
    return _state() / "jobs" / f"{job}.vbs"


def write_shim(job: str) -> Path:
    path = shim_path(job)
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = wrapper_path(job)
    # 0 = hidden window, False = do not wait. Set to True so the lock is held for the whole
    # run: wscript exits only when the job does, which is what the task's own
    # "don't start a new instance" behaviour reads.
    path.write_text(
        f"' {PREFIX}{job} - generated by scripts/schedule_jobs.py. Runs the .cmd INVISIBLY.\n"
        'Set sh = CreateObject("WScript.Shell")\n'
        f'sh.Run """{cmd}""", 0, True\n',
        encoding="utf-8",
    )
    return path


def write_wrapper(job: str, spec: dict) -> Path:
    """The .cmd the task runs. Plain text on purpose: a scheduled job you cannot read is a
    scheduled job you cannot trust."""
    path = wrapper_path(job)
    path.parent.mkdir(parents=True, exist_ok=True)
    log = _state() / "logs" / f"{job}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    body = [
        "@echo off",
        f":: {PREFIX}{job} - generated by scripts/schedule_jobs.py. Edit that, not this.",
        f":: {spec['what']}",
        # EVERYTHING the run prints lands in the log. The first cut computed this path,
        # promised it in --status, and never redirected a byte - the hidden window ate every
        # line, daemon-down SKIPPED notices included (found on the 2026-08-31 smoke review).
        # call-with-redirection routes the whole body; the size check keeps 288 runs/day
        # from growing the file forever (rotate past ~2MB, one generation kept).
        f'if exist "{log}" for %%A in ("{log}") do if %%~zA gtr 2000000 move /y "{log}" "{log}.1" >nul 2>nul',
        f'call :main >> "{log}" 2>&1',
        "exit /b %ERRORLEVEL%",
        ":main",
        f'cd /d "{REPO}"',
        f'echo [%DATE% %TIME%] --- {job} ---',
    ]
    # Order matters: every guard that can exit early runs BEFORE the lock is (attempted to be)
    # taken, so a daemon-down or disarmed tick never touches the lock at all.
    if spec["needs_daemon"]:
        body.append(DAEMON_GUARD.rstrip())
    if job not in UNGATED_JOBS:
        body.append(ARM_GUARD.replace("{python}", str(PYTHON)).replace("{repo}", str(REPO)).rstrip())
    resolved = [
        # Plain replacement, never str.format: these lines carry PowerShell blocks whose
        # braces are syntax, and format() read `try { $r = ...` as a field name and died.
        line.replace("{scripts}", str(SCRIPTS))
            .replace("{odin}", str(ODIN))
            .replace("{repo}", str(REPO))
            .replace("{pythonw}", str(PYTHONW))
            .replace("{python}", str(PYTHON))
        for line in spec["lines"]
    ]
    if spec.get("lock"):
        # AH-16: the job's own lines run in a SEPARATE, unguarded .cmd that run_locked.py
        # invokes while it holds the proof-of-death job lock (lib/joblocklib.py) - no lock
        # mkdir/rmdir text lives in this wrapper at all any more.
        write_work(job, resolved)
        body.append(f'"{PYTHON}" "{RUN_LOCKED}" {job} "{work_path(job)}"')
    else:
        body.extend(resolved)
    # Everything the job prints lands in one readable log, newest run appended.
    script = "\n".join(body) + "\n"
    path.write_text(script, encoding="utf-8")
    return path


def write_work(job: str, resolved_lines: list[str]) -> Path:
    """The plain .cmd holding one lock-carrying job's own command lines, no guards, no lock -
    run_locked.py runs this via `cmd /c` while it holds the job lock and reports its exit
    code back out. Kept in its own file (rather than inlined into a shell string) so the
    existing quoting in spec['lines'] - long paths, embedded PowerShell blocks - needs no
    second layer of escaping to cross a subprocess boundary."""
    path = work_path(job)
    path.parent.mkdir(parents=True, exist_ok=True)
    body = ["@echo off", f":: {PREFIX}{job} work - generated by scripts/schedule_jobs.py."]
    body.extend(resolved_lines)
    body.append("exit /b %ERRORLEVEL%")
    path.write_text("\n".join(body) + "\n", encoding="utf-8")
    return path


def _schtasks(args: list[str]) -> tuple[int, str]:
    r = clilib.run_text(["schtasks", *args], )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def registered() -> dict[str, dict]:
    code, out = _schtasks(["/Query", "/FO", "CSV", "/V"])
    if code != 0:
        return {}
    import csv
    import io

    found: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(out)):
        name = (row.get("TaskName") or "").strip().lstrip("\\")
        if not name.startswith(PREFIX):
            continue
        found[name] = {
            "name": name,
            "status": row.get("Status"),
            "state": row.get("Scheduled Task State"),  # Enabled / Disabled - the pause switch
            "lastRun": row.get("Last Run Time"),
            "lastResult": row.get("Last Result"),
            "nextRun": row.get("Next Run Time"),
        }
    return found


def task_names(job: str, spec: dict) -> list[str]:
    names = [f"{PREFIX}{job}"]
    if spec.get("extra_schedule"):
        names.append(f"{PREFIX}{job}-keepalive")
    return names


def set_enabled(jobs: dict[str, dict], enable: bool) -> list[dict]:
    """Pause or resume THE EYES without unregistering them: schtasks /Change keeps the task,
    its schedule and its history; a paused task simply stops firing until resumed. This is
    the owner's off switch (asked for 2026-08-31) and what the tray icon drives."""
    out = []
    for job, spec in jobs.items():
        if job in UNGATED_JOBS:
            # The dashboard only looks, the doctrine lane only configures (owner, 2026-09-01:
            # the bypass check runs "autonomously") and chat-journal only writes down what
            # happened: none of them pause with the eyes, so a closed icon never switches the
            # constant checks off.
            #
            # ENSURE ENABLED, never "untouched" (fixed 2026-09-02). Skipping these left an
            # ungated lane stuck in whatever state it was last in: chat-journal was registered
            # while it was still gated, got DISABLED by one pause, and then no pause, resume,
            # arm or disarm would ever switch it back on - a lane advertised as always-on,
            # silently dead, with every command reporting success. An always-on lane that is
            # off is a monitor that cannot fire, which is the exact failure it exists to
            # prevent, so every pass now asserts the state instead of assuming it.
            for name in task_names(job, spec):
                code, msg = _schtasks(["/Change", "/TN", name, "/ENABLE"])
                out.append({"job": job, "task": name, "ok": code == 0,
                            "detail": "always on (ungated) - kept enabled" if code == 0
                            else (msg.strip().splitlines()[-1] if msg.strip() else f"exit {code}")})
            continue
        for name in task_names(job, spec):
            code, msg = _schtasks(["/Change", "/TN", name, "/ENABLE" if enable else "/DISABLE"])
            out.append({"job": job, "task": name, "ok": code == 0,
                        "detail": msg.strip().splitlines()[-1] if msg.strip() else f"exit {code}"})
    return out


def apply_jobs(jobs: dict[str, dict]) -> list[dict]:
    out = []
    for job, spec in jobs.items():
        write_wrapper(job, spec)
        shim = write_shim(job)
        for name, sched in zip(task_names(job, spec),
                               [spec["schedule"], spec.get("extra_schedule")]):
            if sched is None:
                continue
            # ⛔ The action is the VBS shim, never the .cmd: a .cmd action pops a console
            # window on every tick, which at a 5-minute cadence is a window every 5 minutes.
            action = f'wscript.exe //B //Nologo "{shim}"'
            code, msg = _schtasks(["/Create", "/TN", name, "/TR", action, *sched, "/F"])
            out.append({"job": job, "task": name, "ok": code == 0,
                        "detail": msg.strip().splitlines()[-1] if msg.strip() else f"exit {code}"})
    return out


def remove_jobs(jobs: dict[str, dict]) -> list[dict]:
    out = []
    for job, spec in jobs.items():
        for name in task_names(job, spec):
            code, msg = _schtasks(["/Delete", "/TN", name, "/F"])
            # "cannot find the file specified" = it was not there; that is a clean no-op.
            missing = "cannot find" in msg.lower() or "does not exist" in msg.lower()
            out.append({"job": job, "task": name, "ok": code == 0 or missing,
                        "detail": "was not registered" if missing and code != 0
                        else (msg.strip().splitlines()[-1] if msg.strip() else f"exit {code}")})
    return out


def orphan_wrappers() -> list[Path]:
    """Wrapper scripts in state/jobs with no lane left in JOBS.

    Removing a lane deletes its scheduled task but leaves its .cmd/.vbs behind, and every command
    here iterates JOBS - so nothing could ever see or clean them. The retired `remote` lane left
    exactly that pair (audit, 2026-09-03): inert while unregistered, but a runnable script for a
    lane the code says must never come back. Reporting them is cheap; guessing is not required.
    """
    d = _state() / "jobs"
    if not d.is_dir():
        return []
    known = set(JOBS)
    return sorted(p for p in d.iterdir()
                  if p.suffix.lower() in (".cmd", ".vbs") and p.stem not in known)


def _select_jobs(argv: list[str]) -> tuple[dict[str, dict], int | None]:
    """Resolve --only into the job subset main() should act on.

    Returns (jobs, None) on success, or ({}, exit_code) when argv is bad enough that main()
    should stop and return exit_code without doing anything else.
    """
    if "--only" not in argv:
        return dict(JOBS), None
    i = argv.index("--only")
    if i + 1 >= len(argv):
        print(__doc__.strip(), file=sys.stderr)
        return {}, 3
    only = argv[i + 1]
    if only not in JOBS:
        print(f"unknown job {only!r} - known: {', '.join(JOBS)}", file=sys.stderr)
        return {}, 3
    return {only: JOBS[only]}, None


def _cmd_status(jobs: dict[str, dict], as_json: bool) -> int:
    live = registered()
    rows = []
    for job, spec in jobs.items():
        for name in task_names(job, spec):
            r = live.get(name)
            rows.append({"task": name, "job": job, "registered": bool(r), **(r or {})})
    if as_json:
        print(json.dumps({"tasks": rows, "logs": str(_state() / "logs")}, indent=2))
        return 0
    for r in rows:
        if r["registered"]:
            paused = "  ⏸ PAUSED (resume with --resume)" if str(r.get("state", "")).lower() == "disabled" else ""
            print(f"  [registered] {r['task']}{paused}")
            print(f"      last run {r.get('lastRun')} (result {r.get('lastResult')}) · next {r.get('nextRun')}")
        else:
            print(f"  [ missing  ] {r['task']}")
    for orphan in orphan_wrappers():
        print(f"  [ ORPHAN   ] {orphan.name} - a wrapper for a lane that no longer exists")
    print(f"\nlogs: {_state() / 'logs'}")
    return 0


def _cmd_pause_resume(jobs: dict[str, dict], argv: list[str]) -> int:
    enable = "--resume" in argv
    results = set_enabled(jobs, enable)
    word = "resumed" if enable else "paused "
    for r in results:
        # An ungated lane (dashboard, doctrine, chat-journal) is never switched off by
        # --pause/--resume: say so, instead of listing it as "paused" beside the ones that
        # were (2026-09-01: the report read as though the bypass check had been switched
        # off). Matched on "always on", the stable half of the detail - keying this on the
        # word "untouched" broke the moment that string changed to "kept enabled", and the
        # readout went straight back to claiming these lanes were paused when they were not.
        if "always on" in str(r.get("detail") or ""):
            print(f"  always on {r['task']} ({r['detail']})")
            continue
        print(f"  {word if r['ok'] else 'FAILED '} {r['task']}"
              + ("" if r["ok"] else f" - {r['detail']}"))
    if not enable and all(r["ok"] for r in results):
        print("\nThe eyes are OFF: nothing fires until --resume (or the tray's Resume).")
    return 0 if all(r["ok"] for r in results) else 2


def _cmd_remove(jobs: dict[str, dict]) -> int:
    results = remove_jobs(jobs)
    for r in results:
        print(f"  {'removed' if r['ok'] else 'FAILED '} {r['task']} - {r['detail']}")
    return 0 if all(r["ok"] for r in results) else 2


def _cmd_apply(jobs: dict[str, dict]) -> int:
    results = apply_jobs(jobs)
    for r in results:
        print(f"  {'registered' if r['ok'] else 'FAILED    '} {r['task']}")
        if not r["ok"]:
            print(f"      {r['detail']}")
    print(f"\nwrappers: {_state() / 'jobs'}   logs: {_state() / 'logs'}")
    print("Check them with --status; remove them all with --remove.")
    return 0 if all(r["ok"] for r in results) else 2


def _cmd_dry_run(jobs: dict[str, dict]) -> int:
    """Say exactly what would be created, and show the wrapper body. No flag selects this -
    it is what runs when none of --status/--pause/--resume/--remove/--apply were given."""
    print("DRY RUN - nothing registered. Re-run with --apply.\n")
    for job, spec in jobs.items():
        for name, sched in zip(task_names(job, spec), [spec["schedule"], spec.get("extra_schedule")]):
            if sched is None:
                continue
            print(f"  {name}\n      {spec['what']}\n      schedule: {' '.join(sched)}")
    print(f"\n  wrappers would be written to {_state() / 'jobs'}")
    print(f"  every run appends to {_state() / 'logs'}")
    print("  jobs that need the daemon SKIP themselves (exit 0) when it is not answering.")
    return 0


def main(argv: list[str]) -> int:
    # Import time covers this file run as its own process; main() covers a stream handed to it
    # AFTER import - clilib.capture(), orch.py's dispatch, the in-process test rails. Both, for
    # the same reason the helper exists: a crash on the REPORT, after the work, is the worst
    # shape of this bug.
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    if os.name != "nt":
        print("schedule_jobs.py registers WINDOWS scheduled tasks - this machine is not Windows.",
              file=sys.stderr)
        return 1
    as_json = "--json" in argv
    jobs, error_code = _select_jobs(argv)
    if error_code is not None:
        return error_code

    if "--status" in argv:
        return _cmd_status(jobs, as_json)
    if "--pause" in argv or "--resume" in argv:
        return _cmd_pause_resume(jobs, argv)
    if "--remove" in argv:
        return _cmd_remove(jobs)
    if "--apply" in argv:
        return _cmd_apply(jobs)
    return _cmd_dry_run(jobs)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
