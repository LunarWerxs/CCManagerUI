"""stamplib - the on-disk AUTOMATION STAMP for a desktop chat's meta record.

THE AUTOMATION DOCTRINE (owner, 2026-08-31): chats run bypassPermissions, keep their
previously assigned model, and use ultracode - MECHANICALLY. The owner's correction the same
day: telling the chat's AI in a prompt to "use ultracode" is wrong and unacceptable - a
model cannot set its own harness parameters from words. The desktop app stores these as
FIELDS of the chat's local_*.json meta record, verified against a real ultracode chat and
the app bundle's own reader (`sessionSettings?.ultracode === true`):

    permissionMode           "bypassPermissions"   (the daemon's /automation endpoint owns this)
    effort                   "xhigh"               (ultracode requires xhigh - the app's own
                                                    /effort ultracode sets both together)
    sessionSettings.ultracode  true

This lib owns the two fields the daemon does NOT stamp. The model field is never touched -
a chat keeps whatever model it was assigned (the doctrine's second clause).

THE CAVEAT, inherited unchanged from the permission-mode saga: under a RUNNING app the
in-memory chat record is authoritative and the app re-saves it over this file, so a stamp on
an already-booted chat may not take until the app next re-reads its store. The durable
moment is stamping a FRESH landing before its first boot - which is exactly when
migrate_chat calls this. Stamp anyway, verify by re-reading, report honestly.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from lib import ledgerlib

ULTRACODE_EFFORT = "xhigh"


def store_roots(fleet_data: dict) -> list[dict]:
    """Every desktop chat store on this machine: the fleet's instance dirs plus the regular
    (non-isolated) app's AppData store. Same surface audit_archived reads - /api/sessions is
    NOT it (that indexes CLI sessions; the metas live in each profile's own store)."""
    out = []
    for i in fleet_data.get("instances", []):
        d = i.get("dir")
        if d:
            out.append({"instance": str(i.get("name")), "root": Path(str(d)) / "claude-code-sessions",
                        "isRunning": bool(i.get("isRunning"))})
    out.append({"instance": "default",
                "root": Path.home() / "AppData" / "Roaming" / "Claude" / "claude-code-sessions",
                "isRunning": True})  # the regular app: assume running - the honest caveat side
    return out


def transcript_index(fleet_data: dict) -> dict[str, Path]:
    """session id -> its transcript file, across the regular CLI store and every instance's.

    Lives here beside store_roots because the meta records and the transcripts are two halves
    of the same lookup: a chat's meta says it exists and its transcript says what state it is
    in, and every caller that walks one needs the other.
    """
    homes = [Path.home() / ".claude" / "projects"]
    for i in fleet_data.get("instances", []):
        if i.get("dir"):
            homes.append(Path(str(i["dir"])) / "projects")
    out: dict[str, Path] = {}
    for home in homes:
        if home.exists():
            for p in home.glob("*/*.jsonl"):
                out.setdefault(p.stem, p)
    return out


def desktop_session_ids(fleet_data: dict, include_archived: bool = True) -> set[str]:
    """Every session id that has a DESKTOP record - i.e. a chat the desktop app owns.

    THE OWNERSHIP LINE BETWEEN THE TWO FLEETS (found 2026-09-01, the day the console fleet was
    built). A console chat and a desktop chat both leave a transcript under a projects/ folder
    and both register under sessions/ while running, so nothing about those files says whose
    chat it is. What does: a desktop chat has a `local_<id>.json` meta record in an instance
    store, a console chat never does. Without this test the desktop lanes tried to
    composer-deliver to a console probe (it can never be rendered, so the breaker just
    counted down), and the console floor lane would have `claude --resume`d desktop chats in
    terminals - resuming a desktop chat outside its app, which is the one thing every desktop
    memory says never to do.
    """
    out: set[str] = set()
    for store in store_roots(fleet_data):
        for path, meta in iter_metas(store["root"]):
            if not include_archived and meta.get("isArchived"):
                continue
            out.add(str(meta.get("cliSessionId") or path.stem.replace("local_", "")))
    return out


def iter_metas(root: Path):
    """(path, meta) for every readable chat meta record under one store root."""
    for p in root.glob("*/*/local_*.json"):
        try:
            yield p, json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue


def read_meta(meta_path: str | Path) -> dict:
    """The chat's meta record as the app wrote it. Raises OSError/ValueError on a bad file."""
    return json.loads(Path(meta_path).read_text(encoding="utf-8"))


def is_stamped(meta: dict) -> bool:
    return (
        (meta.get("sessionSettings") or {}).get("ultracode") is True
        and meta.get("effort") == ULTRACODE_EFFORT
    )


BYPASS = "bypassPermissions"


def is_bypass(meta: dict) -> bool:
    return meta.get("permissionMode") == BYPASS


def stamp_doctrine(meta_path: str | Path) -> dict:
    """Write BOTH doctrine stamps - permissionMode AND ultracode - into the meta record.

    ⛔ WHY THE PERMISSION STAMP IS A DISK WRITE NOW (owner, 2026-09-01: "I am getting sick of
    having to change things from manual edits to bypass permissions - you're not properly
    managing and applying permissions to threads"). Until today the ultracode half was written
    here, directly, and always worked - while the permission half went ONLY through the
    daemon's `/api/sessions/:id/automation`. That endpoint needs the daemon to know the
    session, so for any chat its index does not carry it 404s, the sweep recorded a silent
    failure, and the chat stayed on acceptEdits forever. Measured that day: 5 visible chats on
    acceptEdits, three of them landed minutes earlier by a migration.

    Two stamps, ONE write, same file the app itself uses. The daemon endpoint is still called
    by the callers that have it, as a belt-and-braces extra - it is no longer the only route.

    THE HONEST CAVEAT, unchanged: a RUNNING app holds the record in memory and can re-save
    over this. The durable moment is while the chat is DORMANT, which is why the courier
    stamps immediately before a wake and the doctrine sweep re-applies on a clock.
    """
    r = mutate_meta(meta_path, _apply_doctrine)
    if r["error"]:
        return {"changed": False, "bypass": False, "ultracode": False, "error": r["error"]}
    if not r["changed"]:
        return {"changed": False, "bypass": True, "ultracode": True, "error": None}
    got = r["meta"]
    return {"changed": True, "bypass": is_bypass(got), "ultracode": is_stamped(got),
            "error": None}


def _apply_doctrine(meta: dict) -> bool:
    """Both doctrine stamps onto one record; False when it already carries them."""
    if is_bypass(meta) and is_stamped(meta):
        return False
    meta["permissionMode"] = BYPASS
    settings = dict(meta.get("sessionSettings") or {})
    settings["ultracode"] = True
    meta["sessionSettings"] = settings
    meta["effort"] = ULTRACODE_EFFORT
    return True


META_WRITE_ATTEMPTS = 3


def mutate_meta(meta_path: str | Path, apply, *, _between=None) -> dict:
    """Read-modify-replace ONE meta record, without losing anyone else's fields (audit AH-18).

    `apply(meta)` edits the dict in place and returns True when it changed something. Around it:

      * a per-record lock (`ledgerlib.locked("meta-<stem>")`) so the toolbox's own mutators - the
        doctrine sweep, the courier's pre-wake stamp, migrate_chat's landing stamp, twin
        cleanup's archive flag - take turns instead of each replacing the whole document from
        its own snapshot;
      * a revision check IMMEDIATELY before the replace: the file's (mtime_ns, size) at read time
        must still be what is on disk. The desktop app is not a cooperating writer and rewrites
        this file from memory whenever it likes; if it did so between the read and the write,
        the document is re-read and `apply` runs again on the fresh copy, up to
        META_WRITE_ATTEMPTS times. A record that keeps changing is left exactly as its other
        writer left it, with an error saying so - never replaced from a stale snapshot.

    The temp name is pid-unique and the swap is os.replace, as before (a fixed temp name let two
    stampers interleave bytes into one file; review finding, 2026-09-01).

    Returns {changed, meta, error}: `meta` is the record as read back after a write (or as read
    when nothing needed changing); `error` is a string when the record could not be read, could
    not be written, or would not hold still. Never raises for those.

    `_between` is a test seam invoked after the read and before the revision check, standing in
    for the app writing underneath us.
    """
    p = Path(meta_path)
    try:
        with ledgerlib.locked(f"meta-{p.stem}"):
            for _attempt in range(META_WRITE_ATTEMPTS):
                try:
                    st = p.stat()
                    meta = read_meta(p)
                except (OSError, ValueError) as err:
                    return {"changed": False, "meta": None, "error": str(err)}
                revision = (st.st_mtime_ns, st.st_size)
                if not apply(meta):
                    return {"changed": False, "meta": meta, "error": None}
                if _between is not None:
                    _between()
                try:
                    now = p.stat()
                except OSError as err:
                    return {"changed": False, "meta": None, "error": str(err)}
                if (now.st_mtime_ns, now.st_size) != revision:
                    continue  # someone wrote underneath us: re-read, re-apply, never clobber
                try:
                    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
                    tmp.write_text(json.dumps(meta), encoding="utf-8")
                    os.replace(tmp, p)
                    return {"changed": True, "meta": read_meta(p), "error": None}
                except (OSError, ValueError) as err:
                    return {"changed": False, "meta": None, "error": str(err)}
            return {"changed": False, "meta": None,
                    "error": (f"{p.name} kept changing underneath the write ({META_WRITE_ATTEMPTS} "
                              "attempts); another writer is active, so it was left as they wrote "
                              "it rather than replaced from a stale copy")}
    except TimeoutError as err:
        return {"changed": False, "meta": None, "error": str(err)}


# THE ENGINE-SIDE HALF OF THE DOCTRINE (owner, 2026-09-02: "regarding the manual mode - no, I am
# quite certain you can figure it out"). The desktop launches every chat's engine with an
# explicit --permission-mode from its in-memory record, so neither the disk stamp nor
# settings.defaultMode changes what a running app's chat runs as - only its picker does, and
# that is a window. But the engine is started with --setting-sources=user,project,local, and
# permission ALLOW rules in the user settings pre-approve a tool before any prompt, in every
# mode. So an allow list covering every built-in tool and every MCP server makes the prompts
# stop fleet-wide with one file write - programmatic, invisible, no window touched. The
# label in the app may still read 'Accept edits'; the chat no longer stalls on a prompt.
ALLOW_ALL_TOOLS = (
    "Bash", "PowerShell", "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep",
    "LS", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "TodoRead", "Skill",
    "KillShell", "BashOutput", "Monitor", "Workflow", "SendMessage", "ListAgents",
    "ScheduleWakeup", "ExitPlanMode", "EnterPlanMode", "EnterWorktree", "ExitWorktree",
)
# MCP servers the desktop app wires into every engine on its own (seen on the engines'
# --allowedTools), beyond whatever ~/.claude.json configures.
DESKTOP_MCP_SERVERS = ("computer-use", "ccd_session", "ccd_session_mgmt", "ccd_directory",
                       "visualize", "Claude_Browser", "claude-in-chrome", "scheduled-tasks", "terminal")


def user_settings_path() -> Path:
    return Path.home() / ".claude" / "settings.json"


def configured_mcp_servers(claude_json: Path | None = None) -> set[str]:
    """Every MCP server name in ~/.claude.json: user scope plus each project's own."""
    p = claude_json or (Path.home() / ".claude.json")
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    names = set((d.get("mcpServers") or {}).keys())
    for pd in (d.get("projects") or {}).values():
        names |= set(((pd or {}).get("mcpServers") or {}).keys())
    return {str(n) for n in names if n}


def ensure_allow_all(settings_path: Path | None = None, servers: set[str] | None = None) -> dict:
    """Make the user settings' permissions.allow cover every tool and every MCP server.
    Merges into what is there (never removes a rule), writes atomically, keeps one backup
    the first time it changes the file. Returns {changed, added, rules, path, error}."""
    path = settings_path or user_settings_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(data, dict):
            return {"changed": False, "added": [], "rules": 0, "path": str(path),
                    "error": "settings.json is not an object - left alone"}
    except (OSError, ValueError) as err:
        return {"changed": False, "added": [], "rules": 0, "path": str(path), "error": f"unreadable: {err}"}
    perms = data.get("permissions")
    if not isinstance(perms, dict):
        perms = {}
        data["permissions"] = perms
    allow = perms.get("allow")
    if not isinstance(allow, list):
        allow = []
        perms["allow"] = allow
    wanted = list(ALLOW_ALL_TOOLS)
    server_names = servers if servers is not None else (configured_mcp_servers() | set(DESKTOP_MCP_SERVERS))
    wanted += [f"mcp__{s}" for s in sorted(server_names)]
    added = [w for w in wanted if w not in allow]
    if not added and perms.get("defaultMode") == BYPASS:
        return {"changed": False, "added": [], "rules": len(allow), "path": str(path), "error": None}
    allow.extend(added)
    perms.setdefault("defaultMode", BYPASS)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        bak = path.with_name(path.name + ".bak-doctrine")
        if path.exists() and not bak.exists():
            bak.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as err:
        return {"changed": False, "added": [], "rules": len(allow), "path": str(path), "error": f"write failed: {err}"}
    return {"changed": True, "added": added, "rules": len(allow), "path": str(path), "error": None}


def stamp_ultracode(meta_path: str | Path) -> dict:
    """Set sessionSettings.ultracode=true + effort=xhigh in the meta record, preserving every
    other field - the write is json.dumps with Python's default separators, not a byte-for-byte
    reproduction of the app's own compact formatting. Returns {stamped, already, verified,
    error} - never raises for a missing/corrupt file, because a failed stamp must be reportable
    without unwinding the act that preceded it."""
    def _apply(meta: dict) -> bool:
        if is_stamped(meta):
            return False
        settings = dict(meta.get("sessionSettings") or {})
        settings["ultracode"] = True
        meta["sessionSettings"] = settings
        meta["effort"] = ULTRACODE_EFFORT
        return True

    r = mutate_meta(meta_path, _apply)
    if r["error"]:
        return {"stamped": False, "already": False, "verified": False, "error": r["error"]}
    if not r["changed"]:
        return {"stamped": False, "already": True, "verified": True, "error": None}
    return {"stamped": True, "already": False, "verified": is_stamped(r["meta"]), "error": None}
