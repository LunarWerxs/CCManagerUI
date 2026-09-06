#!/usr/bin/env python3
"""name_chats.py - ACT: THE NAMING PASS - give every no-name chat in an instance a real name.

The naming law (owner, standing): no chat sits in his sidebar with a generic name. Fresh
imports land NAMELESS (meta title null) and render as 'General coding session' / 'Untitled';
N of them are indistinguishable on screen, so the stock renamer refuses. This pass names them
LIVE, no restart, via the probe technique proven 11/11 on 2026-08-31:

  1. actuator/rename_first.ps1 renames the FIRST reachable no-name row to a unique PROBE name
     (safe precisely because the rows are indistinguishable - we don't care which one it hits),
  2. the running app re-saves that chat's meta within seconds, revealing WHICH cliSessionId
     took the probe,
  3. the daemon's own rename endpoint then sets that chat's REAL name (the probe name is
     unique on screen, so the stock actuator is unambiguous),
  4. repeat until no no-name row is reachable.

WHERE REAL NAMES COME FROM (division of labor): the intended-title map - the caller's word
(sweep passes each landed chat's session title) or the daemon's sessions table. A chat whose
only known title is itself generic gets a quarantine name ('Recovered chat <id> (needs a
name)') and is reported under needsJudgment: writing a GOOD name from content is the AI's
job, and this script never invents one.

Usage: python name_chats.py <instance> [--json]        # names every reachable no-name chat
Exit:  0 nothing nameless, or every reachable one named - 2 some rows unreachable/flaked or
       left with quarantine names - 1 daemon/actuator failure.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from lib import clilib, hydralib
from lib import ledgerlib

PS1 = Path(__file__).resolve().parent / "actuator" / "rename_first.ps1"
MAX_PASSES = 20
PROBE_PREFIX = "naming pass probe"
# One naming pass per instance at a time: two processes driving the same window race the
# probes and can misattribute names (review finding). Stale locks release after this long.
LOCK_STALE_SECS = 15 * 60


@contextlib.contextmanager
def _instance_lock(instance: str):
    lock = ledgerlib._state_dir() / f"naming-{instance.lower()}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        if lock.exists() and time.time() - lock.stat().st_mtime > LOCK_STALE_SECS:
            lock.unlink(missing_ok=True)
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
    except (FileExistsError, PermissionError):  # PermissionError = the previous holder's pending delete (Windows); busy, not broken - see ledgerlib.locked
        yield False
        return
    try:
        yield True
    finally:
        lock.unlink(missing_ok=True)

# The naming law's deny-list, mirroring the daemon's chat-title.ts patterns plus this
# toolbox's own probe/quarantine names. A None/empty title is generic by definition.
_GENERIC = re.compile(
    r"^(untitled|general coding session|new (chat|session)|\[plumbing\].*"
    r"|landing fix probe.*|naming pass probe.*|recovered chat .*)$",
    re.IGNORECASE,
)
# What the probe LOOP goes after: the app-made no-names. Quarantine names stay OUT - they are
# generic by law (so a later, better-informed pass can still rename them via extra_titles),
# but re-probing one this pass would loop forever re-quarantining the same chat.
_PROBE_TARGETS = re.compile(
    r"^(untitled|general coding session|new (chat|session)"
    r"|landing fix probe.*|naming pass probe.*)$",
    re.IGNORECASE,
)


def is_generic_title(title: object) -> bool:
    t = str(title or "").strip()
    return not t or bool(_GENERIC.match(t))


def _needs_probe(title: object) -> bool:
    t = str(title or "").strip()
    return not t or bool(_PROBE_TARGETS.match(t))


def store_dir_for(instance: str) -> Path | None:
    for i in hydralib.fleet().get("instances", []):
        if str(i.get("name", "")).lower() == instance.lower():
            d = i.get("dir")
            return Path(str(d)) / "claude-code-sessions" if d else None
    return None


def scan_metas(store: Path, cache: dict | None = None) -> list[dict]:
    """Every meta record in the store, parsed - THROUGH an mtime-keyed cache when the caller
    passes one. The pass polls the store every second waiting for the app to re-save ONE
    file, and used to re-read and re-parse every meta on every tick (~K*21*M parses per pass;
    efficiency pass, 2026-08-31). The cache lives for one name_pass() call only, in memory -
    an mtime that has not advanced is the same bytes; a file that changed is always re-read."""
    out = []
    for p in store.glob("*/*/local_*.json"):
        try:
            st = p.stat()
        except OSError:
            continue
        # (mtime_ns, size) - mtime alone let two writes inside one filesystem timestamp
        # tick serve STALE bytes (probe-then-real-title back to back; caught by the suite's
        # own order-flake, 2026-09-01). Same-instant AND same-length is the residual hole,
        # and a title change virtually never preserves byte length.
        key = (st.st_mtime_ns, st.st_size)
        hit = cache.get(p) if cache is not None else None
        if hit is not None and hit[0] == key:
            meta = hit[1]
        else:
            try:
                meta = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue  # mid-write or corrupt: skip WITHOUT caching, so it is re-tried
            if cache is not None:
                cache[p] = (key, meta)
        out.append(meta)
    return out


def nameless_rows(store: Path, cache: dict | None = None) -> list[dict]:
    out = []
    for meta in scan_metas(store, cache):
        if meta.get("isArchived"):
            continue
        if _needs_probe(meta.get("title")):
            out.append({"sid": str(meta.get("cliSessionId") or ""), "title": meta.get("title")})
    return out


def sid_holding_title(store: Path, title: str, cache: dict | None = None) -> str | None:
    for meta in scan_metas(store, cache):
        if meta.get("title") == title:
            return str(meta.get("cliSessionId") or "")
    return None


def intended_titles(extra: dict[str, str] | None = None) -> dict[str, str]:
    """sid -> real title. The caller's word (extra) wins; the sessions table fills the rest -
    but only with titles that pass the naming law themselves."""
    out: dict[str, str] = {}
    for row in hydralib.sessions():
        sid = str(row.get("session_id") or "")
        title = str(row.get("title") or "")
        if sid and not is_generic_title(title):
            out[sid] = title
    for k, v in (extra or {}).items():
        if not is_generic_title(v):
            out[k] = v
    return out


def _run_probe(instance: str, probe: str) -> tuple[int, str]:
    from lib import windowlib

    # The probe drives the app's sidebar; put the window back if that moved it (the naming
    # pass had its own lock and no placement courtesy - owner, 2026-09-01: "something full
    # screened one of the accounts again").
    with windowlib.keep_placement(instance):
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(PS1),
             "-Instance", instance, "-NewTitle", probe],
            timeout=240,
        )
    return r.returncode, (r.stdout or "").strip()


def _daemon_rename(sid: str, title: str) -> tuple[int, str]:
    import rename_chat

    from lib import clilib

    return clilib.capture(rename_chat.main, [sid, "--to", title])


def _empty_pass_result(why: str) -> dict:
    return {"named": [], "needsJudgment": [], "flakes": [], "remaining": None, "why": why}


def _rename_quarantined_chats(store: Path, meta_cache: dict, titles: dict[str, str],
                               daemon_rename) -> list[dict]:
    """Quarantined chats first: their sid is already known, so when a better-informed map
    now carries a real name, rename directly - no probe needed. (Without this, a quarantine
    name was forever: nothing ever revisited it. Review finding.)"""
    named = []
    for meta in scan_metas(store, meta_cache):
        title = str(meta.get("title") or "")
        sid = str(meta.get("cliSessionId") or "")
        if (not meta.get("isArchived") and sid and titles.get(sid)
                and re.match(r"^recovered chat ", title, re.IGNORECASE)):
            code, _out = daemon_rename(sid, titles[sid])
            if code == 0:
                named.append({"sid": sid, "title": titles[sid]})
    return named


@dataclass
class _PassState:
    """Mutable tally threaded through one probe loop (name_pass docstring). Kept as one
    object, not five loose locals, so the per-round helper below can update it without a
    fistful of return values."""

    named: list[dict] = field(default_factory=list)
    needs_judgment: list[dict] = field(default_factory=list)
    flakes: list[str] = field(default_factory=list)
    consecutive_flakes: int = 0

    def flake(self, msg: str) -> bool:
        """Record a flake and report whether the pass should give up (3 in a row)."""
        self.flakes.append(msg)
        self.consecutive_flakes += 1
        return self.consecutive_flakes >= 3


def _await_probe_sid(store: Path, probe: str, meta_cache: dict, poll_secs: float) -> str | None:
    """Poll the store until the meta holding the probe's title shows up, or poll_secs elapses."""
    deadline = time.time() + poll_secs
    sid = None
    while time.time() < deadline:
        sid = sid_holding_title(store, probe, meta_cache)
        if sid:
            break
        time.sleep(1)
    return sid


def _run_probe_round(instance: str, probe: str, store: Path, meta_cache: dict,
                      titles: dict[str, str], poll_secs: float, probe_runner, daemon_rename,
                      state: _PassState) -> bool:
    """Drive one probe/reveal/rename cycle, updating `state` in place. Returns True when the
    caller's probe loop should stop (nothing reachable, or 3 flakes in a row)."""
    code, out = probe_runner(instance, probe)
    if code == 3:
        return True  # nothing reachable (collapsed/virtualized rows are reported as remaining)
    if code != 0:
        give_up = state.flake(out.splitlines()[-1] if out else f"probe exit {code}")
        if not give_up:
            time.sleep(2)
        return give_up
    state.consecutive_flakes = 0

    sid = _await_probe_sid(store, probe, meta_cache, poll_secs)
    if not sid:
        # One raced row (e.g. the app auto-titled it mid-probe) must not starve the rest of
        # the batch - record it and keep going (review finding).
        return state.flake(f"probe '{probe}' landed on screen but no meta picked it up in {poll_secs:.0f}s")

    want = titles.get(sid)
    if not want:
        # Naming from content is the AI's job - quarantine, report, never invent.
        want = f"Recovered chat {sid[:8]} (needs a name)"
        state.needs_judgment.append({"sid": sid, "quarantineTitle": want,
                                     "why": "no non-generic title known for it - an AI should read it and name it"})
    code, out = daemon_rename(sid, want)
    if code == 0:
        state.named.append({"sid": sid, "title": want})
        return False
    return state.flake(f"{sid[:8]}: stuck at probe '{probe}' ({out.splitlines()[0][:100] if out else code})")


def name_pass(
    instance: str,
    extra_titles: dict[str, str] | None = None,
    probe_runner=None,
    daemon_rename=None,
    store: Path | None = None,
    poll_secs: float = 20,
) -> dict:
    """Run the pass. Returns {named, needsJudgment, flakes, remaining, why}."""
    probe_runner = probe_runner or _run_probe
    daemon_rename = daemon_rename or _daemon_rename
    store = store or store_dir_for(instance)
    if store is None or not store.exists():
        return _empty_pass_result(f"no chat store found for instance '{instance}'")

    titles = intended_titles(extra_titles)
    # One mtime-keyed parse cache for the WHOLE pass (scan_metas docstring) - in memory,
    # never persisted: the win is the poll loop's per-second rescans, not cross-run reuse.
    meta_cache: dict = {}

    with _instance_lock(instance) as got_lock:
        if not got_lock:
            return _empty_pass_result(
                f"another naming pass is already driving '{instance}' - refusing to race it")

        state = _PassState()
        state.named.extend(_rename_quarantined_chats(store, meta_cache, titles, daemon_rename))

        # Probe names must be unique ACROSS processes and passes - a 1-second stamp collided
        # between overlapping runs (review finding).
        stamp = f"{os.getpid()}-{uuid.uuid4().hex[:6]}"

        for n in range(1, MAX_PASSES + 1):
            if not nameless_rows(store, meta_cache):
                break
            probe = f"{PROBE_PREFIX} {stamp}-{n}"
            if _run_probe_round(instance, probe, store, meta_cache, titles, poll_secs,
                                 probe_runner, daemon_rename, state):
                break

        remaining = nameless_rows(store, meta_cache)
    return {
        "named": state.named,
        "needsJudgment": state.needs_judgment,
        "flakes": state.flakes,
        "remaining": remaining,
        "why": ("clean" if not remaining and not state.flakes else
                "some rows remain - collapsed/virtualized rows are out of UIA reach, or passes flaked; rerun, or scroll them into view"),
    }


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 1
    try:
        result = name_pass(args[0])
    except hydralib.DaemonError as err:
        print(f"naming pass FAILED: {err}", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        for r in result["named"]:
            print(f"named {r['sid'][:8]} -> '{r['title']}'")
        for r in result["needsJudgment"]:
            print(f"⚠ {r['sid'][:8]} quarantined as '{r['quarantineTitle']}' - {r['why']}")
        for f in result["flakes"]:
            print(f"flake: {f}")
        rem = result["remaining"]
        print(f"{len(result['named'])} named, {len(result['needsJudgment'])} need an AI-written name, "
              f"{len(rem) if rem is not None else '?'} still nameless ({result['why']})")
    if result["remaining"] is None:
        # No store found, or another pass already holds the lock: the pass never ran, so
        # this is NOT "nothing nameless" - exit 1 per the docstring, not a false 0 (review finding).
        return 1
    ok = not result["flakes"] and not result["remaining"] and not result["needsJudgment"]
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
