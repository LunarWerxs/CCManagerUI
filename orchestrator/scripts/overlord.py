#!/usr/bin/env python3
"""overlord.py - ACT: THE OVERLORD WATCHDOG - keep the standing /orchestrate chat alive.

THE HOLE THIS CLOSES (owner, 2026-09-01: "it did a little bit of work and then it stopped
... to me that very clearly says there is nothing re-arming it, which is literally the
whole point of an orchestrator"): the /orchestrate command told the AI to arm its own
5-minute background loop - WORDS TO A MODEL, exactly the fragile shape the automation
doctrine forbids. If the AI skipped the arming, or its in-chat timer died with the
session, nothing ever woke it again. This script is the MECHANICAL re-arm: Windows Task
Scheduler runs it every 5 minutes, and when the overlord chat has gone quiet while work
is waiting, it wakes it through the engine. The machine never forgets.

WHO IS THE OVERLORD: `state/overlord.json` {"sessionId": ...} when claimed explicitly
(--claim <chat>), else the newest non-archived chat titled exactly "Orchestrate" (the
title IS the claim - name the chat that and the watchdog owns it), else the newest
non-archived chat BORN FROM MANAGER_PROMPT - the toolbox's own child, whatever the app has
since titled it (the app auto-titles a reborn manager "Standing manager chat
orchestration", which is how title alone lost it, 2026-09-04).

⛔ THERE IS ONE OVERLORD (owner, 2026-09-04: "there should only ever be one orchestrator,
that has complete knowledge of all active accounts"). A second manager is never spawned
while any manager exists - rebirth CLAIMS the newest one instead. Spare managers are named
on every tick with the command that retires them; they are protected from every other lane
(protected_session_ids: never archived, moved, judged or woken unattended), so a spare can
never wake up, run /orchestrate and become a second orchestrator on its own account.

WHEN IT NUDGES - every condition must hold, and each miss is reported, never silent:
  - the overlord resolves (a missing overlord is a loud NONE, not a quiet pass)
  - it is NOT mid-turn (a working overlord is left alone)
  - it has been QUIET at least 5 minutes (NUDGE_QUIET_SECS - the task fires every 5 minutes
    and the quiet threshold matches it; see the note above the constant)
  - there IS work: staged deliveries, or a non-empty judgment queue / acting lane
  - it is not HELD, and the breaker (kind 'surface') is not suppressing futile nudges

THE NUDGE goes through the COMPOSER - staged like any reply and delivered by the
courier's own rails (verify snippet, claim, honest confirm); the composer send is what
boots a dormant or crashed chat and runs the turn. ⛔ Never via /migrate: that endpoint
delivers no prompt - it kills and reimports the chat dormant (learned live, 2026-09-01).
The machine-wide running-chat cap deliberately does NOT gate this one wake (--cap-exempt):
the overlord is the manager, and a system at its cap with a dead manager stays dead.

Usage: python overlord.py            # the scheduled-task mode: nudge if needed, else no-op
       python overlord.py --status  [--json]
       python overlord.py --claim <title fragment | session id>
Exit:  0 nudged-and-confirmed, or honestly nothing to do - 2 no overlord chat exists
       (start one: a desktop chat titled 'Orchestrate') - 5 breaker - 6 held -
       1 daemon failure or the nudge did not confirm.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from lib import armlib, clilib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib

# Owner, 2026-09-01: "it needs to check every 5 minutes or whatever, not every 30 or 60" -
# the task fires every 5 minutes AND the quiet threshold is 5 minutes, so an idle overlord
# with waiting work is woken on the very next tick, never parked for a grace period.
NUDGE_QUIET_SECS = 5 * 60
NUDGE_PROMPT = (
    "Automated watchdog wake-up: you are the standing orchestrator chat and work is "
    "waiting. Run the next full pass now: /orchestrate"
)
# A turn in flight past this long is not proof of a problem (real builds run long) - it is
# proof a JUDGMENT is due (owner, 2026-09-01: "if a background task has been running longer
# than like 30 minutes the AI should check into it ... programmatically").
LONG_RUN_SECS = 30 * 60
_LR_TAIL_BYTES = 400_000
# Widened up to this before giving up on finding a turn's start (mirrors gatelib.read_records'
# adaptive tail): a single closing record, or a very chatty turn, can push the real start of
# the current turn further back than the starting window, and reading "no record" as "nothing
# to flag" would let a genuinely stuck turn sit past 4 MB of transcript in silence.
_LR_TAIL_MAX = 4 * 1024 * 1024


@dataclass
class OverlordState:
    """The overlord's refreshed activity/dossier state for one tick - carried between
    main() and the nudge cycle so neither has to thread six loose values through calls."""
    row: dict
    sid: str
    quiet: float
    match: dict | None
    twins: list[dict]
    twin_note: str
    dup_note: str


def _ts_of(rec: dict) -> float | None:
    """A transcript record's timestamp as epoch seconds, or None. Naive stamps are read as
    UTC, which is what the daemon writes."""
    ts = rec.get("timestamp")
    if not ts:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.timestamp() if dt.tzinfo else dt.replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _lr_scan_tail(tail: str) -> tuple[float | None, float | None, bool]:
    """(turn start ts, last record ts, whether the tail ends on finished assistant text) for
    one transcript tail, scanning newest-to-oldest. Split out of long_runners() so the caller
    can widen the tail and re-scan without duplicating the record-walk."""
    started = None
    last_ts = None
    last_finished = False
    for line in reversed(tail.splitlines()):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = rec.get("type")
        if kind not in ("user", "assistant"):
            continue
        content = ((rec.get("message") or {}).get("content"))
        blocks = [b.get("type") for b in content
                  if isinstance(b, dict)] if isinstance(content, list) else []
        if last_ts is None:
            last_ts = _ts_of(rec)
            # ⛔ THE FALSE ALARM THIS KILLS (measured 2026-09-01): a chat that ANSWERED
            # and went idle still has a live process and a hours-old last human prompt,
            # so it was reported as a runaway turn every 5 minutes forever. Two of the
            # three long-runners in one wake were this - one had posted its final recap
            # seven hours earlier. The tell is the LAST record: a finished turn ends on
            # assistant TEXT, a turn still in flight ends on tool traffic. A watchdog
            # that cries wolf on finished work teaches you to ignore the one real stall.
            last_finished = (kind == "assistant" and bool(blocks)
                             and "tool_use" not in blocks)
        if kind != "user" or rec.get("isMeta"):
            continue
        if blocks and blocks[0] == "tool_result":
            continue  # a tool result is mid-turn traffic, not the turn's start
        started = _ts_of(rec)
        break
    return started, last_ts, last_finished


def long_runners() -> list[dict]:
    """Live chats whose CURRENT turn has been in flight past LONG_RUN_SECS.

    Turn start = the last REAL user prompt in the transcript (tool results also arrive as
    user-typed records and would reset the clock on every tool call - skipped). Reads the
    daemon's live endpoint; an older daemon without it simply reports none (the endpoint
    and this feature shipped together)."""
    try:
        got = hydralib.api_get("/api/sessions/live")
    except hydralib.DaemonError:
        return []
    rows = got.get("sessions", []) if isinstance(got, dict) else []
    out = []
    now = time.time()
    for s in rows:
        tp = s.get("transcriptPath")
        if not tp:
            continue
        try:
            p = Path(tp)
            size = p.stat().st_size
        except OSError:
            continue
        # ⛔ ADAPTIVE TAIL (mirrors gatelib.read_records): the fixed 400 KB window can miss the
        # turn's start entirely on a big or chatty transcript, and reading "no record" as
        # "nothing in flight" would let a genuinely stuck turn sit unflagged. Widen and re-scan
        # until a start turns up, the whole file has been read, or the cap is hit.
        window = _LR_TAIL_BYTES
        started = last_ts = None
        last_finished = False
        tail = None
        while True:
            try:
                with open(p, "rb") as f:
                    if size > window:
                        f.seek(size - window)
                        f.readline()
                    tail = f.read().decode("utf-8", errors="replace")
            except OSError:
                tail = None
                break
            started, last_ts, last_finished = _lr_scan_tail(tail)
            if started is not None or size <= window or window >= _LR_TAIL_MAX:
                break
            window *= 2
        if tail is None or started is None:
            continue
        elapsed = now - started
        if elapsed < LONG_RUN_SECS:
            continue
        silent = (now - last_ts) if last_ts else 0
        # Finished-and-quiet is the ARCHIVE lane's business, not a stall to review. Still in
        # flight, or stopped mid-tool, is the real thing - and how long it has been SILENT is
        # what separates a healthy long build (emitting constantly) from a dead one.
        if last_finished and silent >= 300:
            continue
        out.append({"sessionId": s.get("sessionId"), "name": s.get("name"),
                    "pid": s.get("pid"), "minutes": int(elapsed // 60),
                    "silentMins": int(silent // 60),
                    "state": "STALLED mid-tool" if silent >= 600 else "working"})
    return out


# THE MANAGER'S BIRTH PROMPT - the exact first prompt the toolbox gives a standing manager
# chat. It is also the duplicate key: hydralib.same_task_chats(MANAGER_PROMPT) finds a
# manager that already exists, so rebirth can never start a second one (owner order 3).
# ⛔ The app records it as a `<command-name>` record, not as this string; gatelib's
# unwrap_command reads that back. Until it did (2026-09-04) this key matched NOTHING, the
# claim branch below had never once fired live, and every rebirth was a duplicate.
MANAGER_PROMPT = ("/orchestrate standing manager chat, started by the toolbox with bypass "
                  "permissions from birth; run the standing loop as documented")


def manager_chats(exclude: set[str] | None = None) -> list[dict]:
    """Every un-archived chat born from MANAGER_PROMPT - the toolbox's own managers, whatever
    the app has since titled them - as session rows: the live one first, then those with a
    DESKTOP HOME (an instance - the only kind a composer wake can reach; a row the daemon's
    index still lists after its desktop record went is a corpse), then most recently active.
    Rows: session_id, title, instance, archived, transcript_path, last_activity_at, live.
    Raises hydralib.DaemonError like any fleet read."""
    found = hydralib.same_task_chats(MANAGER_PROMPT, exclude=exclude)
    if not found:
        return []
    by_id = {r.get("session_id"): r for r in hydralib.visible_chats()}
    rows = []
    for m in found:
        base = by_id.get(m["session_id"]) or {
            "session_id": m["session_id"], "title": m.get("title"),
            "instance": m.get("instance"), "archived": False, "transcript_path": ""}
        rows.append({**base, "live": bool(m.get("live"))})
    rows.sort(key=lambda r: (bool(r.get("live")), bool(r.get("instance")),
                             r.get("last_activity_at") or 0), reverse=True)
    return rows


# No second rebirth inside this window: the sessions index lags a spawn by minutes.
REBIRTH_COOLDOWN_SECS = 30 * 60


def rebirth(argv: list[str], as_json: bool, why: str) -> int:
    """Spawn a replacement manager and claim it - THE WATCHDOG'S LAST DUTY (live soak,
    2026-09-01: the standing manager's desktop record vanished under it; the sessions table
    still listed the chat, the dossier had no record, no process held it, and no lane can
    wake a chat with no home. Every tick then printed 'gate FAILED' while the judgment
    queue sat, which is the exact dark fleet this watchdog exists to prevent.)

    Rails: only while the icon is up (armlib; a hand run may --force); an existing manager
    with the same birth prompt is CLAIMED, never duplicated; the spawn goes through
    spawn_chat's own rails (duplicate guard, trust, bypass from birth, registration)."""
    refusal = armlib.refuse_unless_armed(argv, "the watchdog's rebirth of the manager chat")
    if refusal:
        return out({"ok": False, "report": f"NO overlord chat is reachable ({why}). {refusal}"},
                   as_json, 2)
    import spawn_chat

    # AH-31 precedence: snapshot the decision moment BEFORE reading the fleet, so a manual
    # --claim landing while this function decides is caught by _write_claim below.
    decided_at_ms = int(time.time() * 1000)
    try:
        existing = manager_chats()
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"rebirth NOT attempted: cannot read the fleet ({err})"},
                   as_json, 1)
    homeless = ""
    if existing and existing[0].get("instance"):
        # manager_chats puts a manager with a desktop home first - the only kind a composer
        # wake can reach. Claim it; never spawn beside it.
        pick = existing[0]
        sid = str(pick.get("sessionId") or pick.get("session_id") or "")
        wrote, defer_why = _write_claim(sid, pick.get("title"), manual=False,
                                        since_ms=decided_at_ms)
        if not wrote:
            return out({"ok": True, "report": (
                f"NO overlord chat was reachable ({why}) - a manager exists ('{pick.get('title')}', "
                f"{sid[:8]}) but not claimed: {defer_why}. Nothing spawned.")}, as_json, 0)
        return out({"ok": True, "report": (
            f"NO overlord chat was reachable ({why}) - but a manager already exists: claimed "
            f"'{pick.get('title')}' ({sid[:8]}) on {pick.get('instance') or 'console'}. Nothing spawned.")},
            as_json, 0)
    if existing:
        # Every manager on record is a corpse: the daemon's index still lists it, no desktop
        # record holds it, so no lane can wake it (2026-09-04: two of four were this). Say so,
        # and let the rebirth below start the one manager that can actually run.
        homeless = (f" ({len(existing)} manager row(s) exist but none has a desktop home - "
                    "nothing can wake them; they are named as spares until retired)")
    # ONE REBIRTH PER COOLDOWN (live soak, 2026-09-01): the tick right after a rebirth could
    # not yet see the new chat in the sessions index and spawned a second manager. The
    # ledger's own 'surface' row for the rebirth is the memory that survives the lag.
    now_ms = int(time.time() * 1000)
    recent = [r for r in ledgerlib._load()
              if r.get("kind") == "surface" and str(r.get("note") or "").startswith("rebirth")
              and now_ms - int(r.get("at") or 0) < REBIRTH_COOLDOWN_SECS * 1000]
    if recent:
        age = (now_ms - max(int(r.get("at") or 0) for r in recent)) // 60000
        return out({"ok": False, "report": (
            f"NO overlord chat is reachable ({why}) - but a manager was reborn {age}m ago and the "
            f"index may still be catching up; not spawning another inside {REBIRTH_COOLDOWN_SECS // 60}m. "
            "If it is really gone, `python scripts/overlord.py --claim <chat>` or wait.")}, as_json, 2)
    got = spawn_chat.spawn(str(Path(__file__).resolve().parents[1]), MANAGER_PROMPT, None)
    if not got.get("ok"):
        return out({"ok": False, "spawn": got,
                    "report": f"NO overlord chat is reachable ({why}) and the rebirth was REFUSED: "
                              f"{got.get('why')}"}, as_json, 1)
    sid = str(got.get("sessionId") or "")
    claim_note = "Not claimed: no session id registered yet - next tick finds it by its prompt."
    if sid:
        wrote, defer_why = _write_claim(sid, got.get("title") or "Orchestrate", manual=False,
                                        since_ms=decided_at_ms)
        if wrote:
            ledgerlib.note("surface", sid, note=f"rebirth: manager respawned ({why[:80]})")
            claim_note = "Claimed."
        else:
            claim_note = f"Not claimed: {defer_why} - the new chat is left as a protected spare."
    return out({"ok": bool(sid), "spawn": got, "report": (
        f"NO overlord chat was reachable ({why}){homeless} - REBORN: a new manager chat is "
        f"{'running' if str(got.get('started', '')).startswith('running') else 'starting'} in "
        f"{got.get('instance')} ({sid[:8] or 'id pending'}); mode: {got.get('modeSet')}. "
        + claim_note)},
        as_json, 0 if sid else 1)


def _ms_of(iso) -> int:
    """An ISO timestamp (the dossier's lastActivityAt) as epoch milliseconds, 0 if unreadable."""
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return 0


def _claim_path() -> Path:
    return ledgerlib._state_dir() / "overlord.json"


def _read_claim() -> dict | None:
    """The current claim file, or None if absent/unparseable. No lock needed to READ:
    _write_claim below always writes via a pid-unique temp file + os.replace (mirrors
    ledgerlib/deliverylib), which is atomic on Windows and POSIX alike, so a reader here can
    never observe a partial/interleaved write."""
    try:
        return json.loads(_claim_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_claim(sid: str, title: str | None, *, manual: bool,
                  since_ms: int | None = None) -> tuple[bool, str]:
    """THE ONE PLACE overlord.json is written (AH-31). A person's `--claim`, an adopted
    existing manager, and a freshly reborn one all used to `write_text` overlord.json
    directly and unconditionally, with no mutex - a manual claim and the scheduled tick's
    own adoption/rebirth could race, and whichever direct write landed last silently became
    the role owner. Every writer now goes through here, under
    ledgerlib.locked('overlord-claim'), with a pid-unique temp file + os.replace so a reader
    never sees a partial/empty file mid-write.

    PRECEDENCE (documented here and in the caller's report): a MANUAL claim (manual=True,
    a person's `--claim`) always wins and always writes. An AUTOMATIC writer (manual=False -
    adoption or rebirth) must pass `since_ms`, the epoch-ms moment IT decided to write, taken
    before it read the fleet. Inside the lock this re-reads the current claim; if that claim
    is itself manual and was written at or after `since_ms`, a person claimed the role during
    this automatic writer's own decision window, so the automatic write is DROPPED - returns
    (False, why) - rather than clobbering the person's deliberate choice. Returns (True, "")
    when it wrote.
    """
    p = _claim_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with ledgerlib.locked("overlord-claim"):
        if not manual and since_ms is not None:
            current = _read_claim()
            if current and current.get("manual") and int(current.get("at") or 0) >= since_ms:
                return False, (
                    f"a manual claim on '{current.get('title')}' "
                    f"({str(current.get('sessionId'))[:8]}) landed first - a person's claim "
                    "always wins over an automatic adoption/rebirth")
        tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"sessionId": sid, "title": title, "manual": bool(manual),
                                   "at": int(time.time() * 1000)}), encoding="utf-8")
        # Windows' file locking is mandatory, not advisory (POSIX rename never blocks on an
        # open reader; MoveFileEx can transiently refuse with WinError 5 if a reader has `p`
        # open the instant this fires - a Path.read_text() elsewhere does not set
        # FILE_SHARE_DELETE). Under this lock only one writer is ever mid-replace, so a few
        # short retries ride out a reader's fleeting handle instead of surfacing a false crash.
        for attempt in range(30):
            try:
                os.replace(tmp, p)
                break
            except PermissionError:
                if attempt == 29:
                    raise
                time.sleep(0.02)
    return True, ""


# A delivery that landed this recently counts as the wake: the automatic lanes do not send a
# second one (a dormant chat's boot plus its first turn easily takes this long).
RECENT_DELIVERY_SECS = 180
# The desktop app's own limit notice, as it renders in the pane - the ONLY text that means
# "this chat cannot take a turn here". Deliberately narrow: a prose mention of "quota" or
# "limit" must never move a chat (it did, once).
LIMIT_BANNER = re.compile(
    r"(?i)you(?:'|’)ve hit your (?:session|usage|weekly|daily) limit"
    r"|(?:session|usage|weekly) limit (?:reached|hit)"
    r"|limit\b.{0,40}\bresets?\b")


def protected_session_ids() -> set[str]:
    """The overlord's own chat(s): the claimed session id, every un-archived chat titled
    'Orchestrate', and every chat born from MANAGER_PROMPT (the three rules find_overlord
    uses - a spare manager is protected too, so no lane can wake it into a second
    orchestrator). The groundskeeper leaves these
    alone (review 2026-09-01): it archived the standing manager the moment an all-clear pass
    ended with a recap that claimed done - after which find_overlord returns None on every
    tick, exit 2 in a report nobody reads - and it could migrate the same chat the overlord
    was relocating itself. One owner per responsibility: the overlord moves itself and is
    never archived unattended."""
    ids: set[str] = set()
    try:
        claimed = json.loads(_claim_path().read_text(encoding="utf-8")).get("sessionId")
    except (OSError, ValueError, AttributeError):
        claimed = None
    if claimed:
        ids.add(str(claimed))
    try:
        for r in hydralib.sessions():
            if (not r.get("archived") and r.get("session_id")
                    and str(r.get("title") or "").strip().lower() == "orchestrate"):
                ids.add(str(r["session_id"]))
        # THE TOOLBOX'S OWN CHILDREN (2026-09-04): a reborn manager is titled by the app, not
        # 'Orchestrate', so title alone left every spare manager unprotected - saturate woke
        # them, the groundskeeper offered to evacuate them, the interview replied to them, and
        # each one that ran armed its own /orchestrate loop: one orchestrator per account.
        for r in manager_chats():
            if r.get("session_id"):
                ids.add(str(r["session_id"]))
    except hydralib.DaemonError:
        pass
    return ids


def find_overlord() -> dict | None:
    """The claimed session id, else the newest non-archived chat titled 'Orchestrate'."""
    claimed = None
    try:
        claimed = json.loads(_claim_path().read_text(encoding="utf-8")).get("sessionId")
    except (OSError, ValueError):
        pass
    rows = hydralib.sessions()
    if claimed:
        for r in rows:
            if r.get("session_id") == claimed and not r.get("archived"):
                return r
        # THE ID CAN ROLL UNDER THE CLAIM (2026-09-01): a migrate (the groundskeeper's
        # unstick, the quota handoff) re-lands the same conversation under a new cli session
        # id, and the dossier keeps the lineage. A claim that named the old id used to read as
        # "gone" the moment the chat was rescued - the watchdog dark precisely when it had just
        # been saved. Follow the lineage; only a chat that is truly gone or archived is None.
        try:
            m = hydralib.resolve_one(claimed)
        except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError):
            return None  # the claim points at a gone/archived chat - loud, not a fallback
        cur = str(m.get("cliSessionId") or "")
        if m.get("archived") or not cur:
            return None
        if cur == claimed:
            # THE INDEX LAGS A FRESH SPAWN (live soak, 2026-09-01): the dossier already knows
            # the chat the watchdog just reborn and claimed, but GET /api/sessions does not
            # list it for a minute or two. Reading that as "gone" made the very next tick
            # rebirth a SECOND manager - the duplicate the owner forbade. The dossier's own
            # record is the row until the index catches up.
            row = hydralib.session_row(cur)
            if row and not row.get("archived"):
                return row
            return {"session_id": cur, "title": m.get("title"), "instance": m.get("instance"),
                    "archived": False, "transcript_path": "",
                    "last_activity_at": _ms_of(m.get("lastActivityAt")), "fromDossier": True}
        row = next((r for r in rows if r.get("session_id") == cur and not r.get("archived")),
                   None) or hydralib.session_row(cur)
        return row if row and not row.get("archived") else None
    named = [r for r in rows
             if not r.get("archived") and str(r.get("title") or "").strip().lower() == "orchestrate"]
    named.sort(key=lambda r: r.get("last_activity_at") or 0, reverse=True)
    if named:
        return named[0]
    # THE TOOLBOX'S OWN CHILD (2026-09-04): a reborn manager is titled by the app ("Standing
    # manager chat orchestration"), never 'Orchestrate', so with no claim the watchdog could
    # not see the manager it had itself started - and spawned another, on whichever account
    # had the most room. The birth prompt is the durable identity; newest-active wins, and
    # the caller pins it (`adopted`) so two managers can never ping-pong the role.
    managers = [m for m in manager_chats() if m.get("instance")]  # a home, or it is a corpse
    return {**managers[0], "adopted": True} if managers else None


def current_match(sid: str) -> tuple[dict | None, list[dict]]:
    """(the CURRENT dossier record for the overlord, its un-archived twins).

    A native revive leaves the pre-revive row visible when the running app re-saves the
    daemon's archive flag away (the zombie-twin leak) - and two same-title rows make
    resolve_one refuse, which on 2026-09-01 broke the watchdog on the very chat it had
    just woken. So: newest un-archived match wins, twins are RETURNED for loud reporting
    and best-effort settling, and ambiguity never silences the watchdog."""
    try:
        matches = hydralib.dossier(sid)
    except hydralib.DaemonError:
        return None, []
    alive = [m for m in matches if not m.get("archived")]
    if not alive:
        return (matches[0] if matches else None), []
    alive.sort(key=lambda m: str(m.get("lastActivityAt") or ""), reverse=True)
    return alive[0], alive[1:]


def settle_twins(twins: list[dict]) -> str:
    """Flag superseded twin rows archived ON DISK. Honest about the limit: the app's own
    control cannot disambiguate two rendered rows sharing one title, and a RUNNING app can
    re-save this flag away - durability belongs to the daemon's reassert machinery; this
    keeps the board as clean as a watchdog can."""
    if not twins:
        return ""
    done = 0
    for t in twins:
        mp = t.get("metaPath")
        if not mp:
            continue
        try:
            meta = json.loads(Path(mp).read_text(encoding="utf-8"))
            meta["isArchived"] = True
            Path(mp).write_text(json.dumps(meta), encoding="utf-8")
            done += 1
        except (OSError, ValueError):
            pass
    return (f" ⚠ {len(twins)} zombie twin(s) of the overlord were visible; {done} flagged "
            "archived on disk (a running app can re-save them back - if one reappears, that "
            "is the daemon-side reassert gap, not a new chat).")


def _account_for_instance(accounts: list[dict], inst_name: str) -> dict | None:
    """The account row (from balance.accounts_overview) that owns this instance name."""
    return next((a for a in accounts
                 if any(str(i.get("name", "")).lower() == inst_name for i in a["instances"])),
                None)


def _limit_banner_seen(row: dict) -> str | None:
    """THE BANNER IS A SIGNAL TOO (seen live 2026-09-01: the overlord's own pane read
    "You've hit your session limit · resets 5:50pm" while the survey still called its
    account 11% used - the band said fine, three wakes in a row bounced off the banner,
    and the fleet sat unmanaged until the chat was gone). The survey measures the ACCOUNT;
    the app's limit notice in the chat's own tail measures THIS chat's ability to take a
    turn, and either one means the handoff.

    ⛔ THE BANNER'S OWN SHAPE, ON THE LAST TEXT BLOCK ONLY - never the gate's generic limit
    classifier over the whole tail (2026-09-01, an hour after this rule went in: the fresh
    manager's first sentence was "checking my own quota", the classifier matched the word,
    and the watchdog RELOCATED the chat it was meant to wake). A chat talking about quota
    is not a chat blocked by one; the app's notice is the last thing rendered and reads
    "You've hit your session limit · resets 5:50pm"."""
    from lib import deliverylib

    last_text = deliverylib.transcript_tail_text(row.get("transcript_path"), last_n=1)
    return "limit banner" if LIMIT_BANNER.search(last_text or "") else None


def _row_session_id(row: dict) -> str:
    """TWO ROW SHAPES REACH maybe_relocate, and only one of them was handled (2026-09-01).
    main() passes a SESSIONS row (`session_id`), which is why the live path works; a
    dossier match (`cliSessionId`) has no `session_id` at all, and passing one silently
    produced `/api/sessions//migrate` -> 404, reported as "handoff refused - waking in
    place". Both shapes are accepted here."""
    return str(row.get("session_id") or row.get("cliSessionId") or row.get("sessionId") or "")


def _migrate_overlord(row: dict, sid: str, dest: dict, why_move: str,
                      target: dict) -> tuple[dict, str]:
    """Perform the atomic migrate for the quota handoff. THE MIGRATE BREAKER APPLIES HERE
    TOO (review 2026-09-01). Every other mover of chats notes its attempt on the 'migrate'
    ledger; this direct call did not, so a handoff whose target kept refusing was re-posted
    every 5-minute tick forever, and the groundskeeper - which reads the same ledger before
    moving the same chat - could not see it. Same contract as migrate_chat: check, note
    before, deterministic on a 400/409, clear on success."""
    brake = ledgerlib.check("migrate", sid)
    if brake["suppressed"]:
        return row, (f" ⚠ quota handoff suppressed by the breaker ({brake['why'][:100]}) - "
                     "waking in place")
    ledgerlib.note("migrate", sid,
                   note=f"quota handoff '{row.get('title') or ''}' -> {dest.get('name')}")
    try:
        got = hydralib.api_post(f"/api/sessions/{sid}/migrate",
                                {"instance_ref": f"desktop:{dest['dir']}",
                                 "confirm_title": row.get("title")})
    except hydralib.DaemonError as err:
        if err.status in (400, 409):
            ledgerlib.note("migrate", sid, deterministic=True,
                           note=f"quota handoff {err.status}: {(err.detail or '')[:150]}")
        else:
            ledgerlib.annotate("migrate", sid, f"quota handoff failed: {str(err)[:120]}",
                               failure=True)
        return row, f" ⚠ quota handoff refused ({str(err)[:120]}) - waking in place"
    if not (isinstance(got, dict) and got.get("ok", True)):
        ledgerlib.annotate("migrate", sid, f"quota handoff said ok=false: {str(got)[:120]}",
                           failure=True)
        return row, f" ⚠ quota handoff said ok=false - waking in place"
    ledgerlib.clear("migrate", sid)
    moved = dict(row)
    moved["instance"] = dest.get("name")
    return moved, (f" QUOTA HANDOFF: its account was {why_move} - relocated to "
                   f"{dest.get('name')} ({target.get('email')}, "
                   f"peak {target.get('peakPct')}%) before the wake.")


def maybe_relocate(row: dict) -> tuple[dict, str]:
    """THE QUOTA-IMMORTAL OVERLORD (owner blessing, 2026-09-01 - the chat that halted
    itself at 81% weekly "was exactly right; hand off to a fresh account instead of
    stopping"). When the overlord's own account sits over the soft usage target, the
    WATCHDOG moves the chat to the open account with the most fill-room - the daemon's
    atomic migrate, which stops the live writer itself - and the wake then burns the fresh
    account. Mechanical, never words to a model. Every miss is a note, never a silent skip;
    an unknown usage reading never blocks the wake (progress beats purity)."""
    import balance

    try:
        survey, _src = balance.usage_rows_with_fallback()
        fleet = hydralib.fleet()
        accounts = balance.accounts_overview(survey, fleet)
    except hydralib.DaemonError:
        return row, ""
    inst_name = str(row.get("instance") or "").lower()
    mine = _account_for_instance(accounts, inst_name)
    banner = _limit_banner_seen(row)
    if not mine:
        return row, ""
    if mine.get("band") not in ("over-soft", "over-hard") and not banner:
        return row, ""
    why_move = (f"at {mine.get('peakPct')}% (over the target)" if mine.get("band") in
                ("over-soft", "over-hard") else f"showing the app's {banner} banner in its pane")
    targets = [t for t in balance.rank_next(accounts)
               if not t.get("mustOpen") and t.get("email") != mine.get("email")]
    if not targets:
        return row, (f" ⚠ its account is {why_move} but no open account has fill-room - "
                     "waking in place")
    ti = balance._target_instance(targets[0])
    dest = hydralib.resolve_instance(fleet, str((ti or {}).get("name") or ""))
    if not dest or not dest.get("dir"):
        return row, " ⚠ over-target account but the fill target's dir did not resolve - waking in place"
    sid = _row_session_id(row)
    if not sid:
        return row, (" ⚠ over-target account but this row carries no session id - waking in "
                     "place (a handoff must never post to an empty session path)")
    # ⛔ NEVER MOVE AN ACTIVE CHAT (owner, 2026-09-01: "Never... move active chats. Only chats
    # that are stopped, waiting, chilling."). A live engine - mid-turn or idle - means the
    # overlord stays put; the handoff happens once it has stopped, and until then the account
    # problem is NAMED here rather than solved by killing a process.
    try:
        live_now = hydralib.live_for(sid)
    except hydralib.DaemonError:
        live_now = None
    if live_now:
        return row, (f" ⚠ its account is {why_move}, but the chat is ACTIVE (process "
                     f"{live_now.get('pid')}) - never moved while a process holds it; it "
                     "moves once it stops")
    return _migrate_overlord(row, sid, dest, why_move, targets[0])


def pending_work() -> dict:
    """Is there anything for the overlord to do? Cheap check first (staged deliveries),
    the full batch only when that is empty."""
    from lib import deliverylib

    staged = len(deliverylib.pending())
    if staged:
        return {"any": True, "staged": staged, "why": f"{staged} staged deliver(ies)"}
    import sweep

    batch = sweep.build_batch(allow_pending=False, max_per_lane=sweep.DEFAULT_MAX_PER_LANE)
    lanes = sum(len(v["rows"]) for v in batch["lanes"].values())
    judgment = len(batch["judgmentQueue"])
    return {"any": bool(lanes or judgment), "staged": 0, "lanes": lanes, "judgment": judgment,
            "why": f"{lanes} lane act(s), {judgment} judgment question(s)"}


def nudge(row: dict, prompt: str = NUDGE_PROMPT) -> tuple[bool, str]:
    """Wake the overlord THROUGH THE COMPOSER - the one real delivery channel.

    ⛔ Never through /migrate (2026-09-01, the hard way): that endpoint does not deliver a
    prompt - it killed the chat, archived its row, and reimported it DORMANT, which put
    "Claude has crashed" on the owner's screen and left a zombie twin. The composer send is
    what boots a dormant or crashed chat and runs the turn. The wake is STAGED like any
    reply and delivered by the courier's own rails (verify snippet, claim, honest confirm),
    with the one sanctioned exemption: --cap-exempt, because a system at its cap with a
    dead manager stays dead forever."""
    import courier

    from lib import clilib
    from lib import deliverylib

    sid = row.get("session_id") or ""
    # NOT TWICE IN ONE WINDOW (review 2026-09-01): saturate plans its wakes from its own read
    # of the same fleet, and after an app restart the overlord is dormant like every other
    # chat, so both lanes could stage-and-deliver into it on the same tick. A wake that just
    # landed IS the nudge; a row already staged is reused rather than doubled.
    recent = deliverylib.recent_delivery(sid, RECENT_DELIVERY_SECS)
    if recent:
        return True, (f"already woken: delivery {recent['id']} (by {recent.get('by')}) landed "
                      f"{int((time.time() * 1000 - int(recent['deliveredAt'])) / 1000)}s ago - "
                      "not nudging twice")
    tail = deliverylib.transcript_tail_text(row.get("transcript_path"))
    verify = deliverylib._verify_snippet(tail)
    if not verify:
        return False, ("no verify snippet could be derived from the overlord's own last "
                       "words - refusing to type blind")
    entry = deliverylib.stage(sid, prompt, title=row.get("title") or "",
                              instance=row.get("instance") or "", verify_text=verify,
                              evidence=tail[-600:], by="overlord", dedupe=True)
    code, said = clilib.capture(courier.main, ["--yes", "--only", entry["id"], "--cap-exempt"])
    if code == 0:
        return True, "woken through the composer - delivered and CONFIRMED moving"
    last = said.splitlines()[-1] if said else f"exit {code}"
    return False, f"the composer wake did not land ({last[:160]})"


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def _cmd_claim(argv: list[str], as_json: bool) -> int:
    """Handle `--claim <title fragment | session id>`: pin a chat as the overlord."""
    i = argv.index("--claim")
    if i + 1 >= len(argv):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        match = hydralib.resolve_one(argv[i + 1])
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        return out({"ok": False, "report": f"claim refused: {err}"}, as_json, 2)
    sid = match.get("cliSessionId") or ""
    # A DEAD CHAT CANNOT BE THE MANAGER (live soak, 2026-09-01): a fresh manager claimed
    # "standing manager chat" by fragment and the query resolved to the OLD manager - no
    # desktop record, no process - so the claim pointed at a corpse and the watchdog went
    # dark. A claim needs a record by id or a live process; otherwise it is refused.
    try:
        by_id = hydralib.dossier(sid) if sid else []
    except hydralib.DaemonError:
        by_id = []
    if not match.get("live") and not by_id:
        return out({"ok": False, "report": (
            f"claim refused: '{match.get('title')}' ({sid[:8]}) has no desktop record and no "
            "live process - it is not a chat anyone can wake. Claim the chat you are in by its "
            "session id.")}, as_json, 2)
    # A MANUAL claim always wins (AH-31 precedence): write unconditionally, through the same
    # locked + atomic path an automatic adoption/rebirth uses, so the two can never interleave.
    _write_claim(sid, match.get("title"), manual=True)
    return out({"ok": True, "report": f"claimed: '{match.get('title')}' ({sid[:8]}) is the overlord"},
               as_json, 0)


def _locate_or_rebirth(argv: list[str], as_json: bool) -> tuple[dict | None, int | None]:
    """Find the overlord chat, or handle its absence. Returns (row, None) when the caller
    should continue with `row`, or (None, exit_code) when the caller must return that code
    immediately."""
    # AH-31 precedence: snapshot BEFORE find_overlord() reads the fleet, so a manual --claim
    # landing during this call is detected by _write_claim's adopted-pin below.
    snapshot_ms = int(time.time() * 1000)
    try:
        row = find_overlord()
    except hydralib.DaemonError as err:
        return None, out({"ok": False, "report": f"overlord check FAILED: {err}"}, as_json, 1)
    if row is None:
        why = _absence_reason()
        if "--status" in argv:
            return None, out({"ok": False, "report": (
                f"NO overlord chat is reachable ({why}). The judgment queue drains only while "
                "one runs - the watchdog's next armed tick claims an existing manager, or "
                "spawns one only when none exists.")}, as_json, 2)
        return None, rebirth(argv, as_json, why)
    if row.get("adopted") and "--status" not in argv:
        # Found by its birth prompt alone: pin it, so the role never ping-pongs between two
        # managers on activity order (a person can still --claim another). AH-31 precedence:
        # an automatic pin that loses to a newer manual claim is silently dropped here - the
        # found row still serves THIS tick, only the persisted claim file is left alone.
        wrote, defer_why = _write_claim(row.get("session_id"), row.get("title"), manual=False,
                                        since_ms=snapshot_ms)
        if not wrote:
            print(f"overlord: adoption pin deferred - {defer_why}", file=sys.stderr)
    return row, None


def _absence_reason() -> str:
    """WHY no overlord resolved, honestly. The old fixed string said 'none claimed' on every
    miss - including both live rebirths of 2026-09-03/04, where a claim EXISTED and pointed at
    a manager that had been archived under it."""
    try:
        claimed = json.loads(_claim_path().read_text(encoding="utf-8")).get("sessionId")
    except (OSError, ValueError, AttributeError):
        claimed = None
    head = (f"the claimed manager ({str(claimed)[:8]}) is archived or gone" if claimed
            else "none claimed")
    # The manager census, so the line says what the next armed tick WILL do rather than
    # denying chats that exist (first cut, live: "none born from the manager prompt" over
    # four such chats - a dead claim returns before the birth-prompt fallback on purpose).
    try:
        managers = manager_chats()
    except hydralib.DaemonError as err:
        return f"{head}, none titled 'Orchestrate', manager census unreadable ({str(err)[:60]})"
    if not managers:
        return f"{head}, none titled 'Orchestrate', none born from the manager prompt"
    homed = [m for m in managers if m.get("instance")]
    if homed:
        m = homed[0]
        return (f"{head}, none titled 'Orchestrate'; {len(managers)} chat(s) born from the "
                f"manager prompt exist - the next armed tick claims '{str(m.get('title') or '')[:40]}' "
                f"({str(m.get('session_id') or '')[:8]}) on {m.get('instance')}, spawning nothing")
    return (f"{head}, none titled 'Orchestrate'; {len(managers)} chat(s) born from the manager "
            "prompt exist but none has a desktop home, so nothing can wake them - the next armed "
            "tick spawns a fresh one")


def _duplicate_overlord_note(sid: str) -> str:
    """TWO REAL chats titled 'Orchestrate' (owner asked, 2026-09-01): the newest-active one
    is the overlord, and the spares are named LOUDLY on every tick - never silently
    ignored, never ping-ponged between."""
    try:
        others = [r for r in hydralib.sessions()
                  if not r.get("archived") and r.get("session_id") != sid
                  and str(r.get("title") or "").strip().lower() == "orchestrate"]
        seen = {r.get("session_id") for r in others}
        others += [r for r in manager_chats(exclude={sid}) if r.get("session_id") not in seen]
    except hydralib.DaemonError:
        return ""
    if not others:
        return ""
    where = "; ".join(f"'{str(r.get('title') or '')[:40]}' ({str(r.get('session_id') or '')[:8]}) "
                      f"on {r.get('instance') or 'console'}" for r in others)
    return (f" ⚠ {len(others)} SPARE manager chat(s) exist - {where}. There is ONE overlord "
            "(this one, the most recently active); the spares are protected from every other "
            "lane and never woken, so retire each with `python scripts/archive_chat.py <id> "
            "--force`, or pin a different one for good with --claim.")


def _refresh_overlord_state(row: dict, argv: list[str],
                            as_json: bool) -> tuple[OverlordState | None, int | None]:
    """Refresh activity/dossier state for the located overlord row. Returns (state, None)
    to continue, or (None, exit_code) when its desktop home turned out to be gone and a
    rebirth (or status report) already answered for this tick."""
    sid = row.get("session_id") or ""
    quiet = max(0, time.time() - (row.get("last_activity_at") or 0) / 1000)
    # The sessions INDEX lags a revive (the id rolls; the index catches up on its sweep and
    # once read 59m-stale for a chat that had moved 4 minutes earlier) - the dossier's own
    # lastActivityAt is fresh, so the FRESHER of the two wins.
    match, twins = current_match(sid)
    if match is None and "--status" not in argv:
        # The sessions table still lists the chat, but the daemon has no record of it and no
        # process holds it: its desktop home is gone (live soak, 2026-09-01). Nothing can
        # wake a chat with no home - a manager in this state is dead, and the fleet with it.
        try:
            live = hydralib.live_for(sid, [])
        except hydralib.DaemonError:
            live = None
        if not live:
            return None, rebirth(argv, as_json,
                                 f"the claimed manager ({sid[:8]}) has no desktop record and no live process")
    if match and match.get("lastActivityAt"):
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(str(match["lastActivityAt"]).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            quiet = min(quiet, max(0, time.time() - dt.timestamp()))
        except ValueError:
            pass
    twin_note = f" ⚠ {len(twins)} zombie twin(s) visible" if twins else ""
    dup_note = _duplicate_overlord_note(sid)
    return OverlordState(row=row, sid=sid, quiet=quiet, match=match, twins=twins,
                         twin_note=twin_note, dup_note=dup_note), None


def _status_payload(state: OverlordState) -> dict:
    row, sid, quiet = state.row, state.sid, state.quiet
    return {"ok": True, "sessionId": sid, "title": row.get("title"),
            "instance": row.get("instance"), "quietSecs": int(quiet),
            "twins": len(state.twins),
            "report": f"overlord: '{row.get('title')}' [{row.get('instance')}] "
                      f"({sid[:8]}), quiet {int(quiet // 60)}m{int(quiet % 60)}s"
                      f"{state.twin_note}{state.dup_note}"}


def _handoff_check_while_active(row: dict, match: dict | None) -> tuple[dict, str]:
    """⛔ THE HALTED-BUT-ANSWERING OVERLORD (2026-09-01, measured: FOUR passes lost in a
    row, fleet idle throughout). The quota handoff lived ONLY in the wake path, and the
    wake only happens when the overlord looks INACTIVE. But an overlord that has hit its
    usage ceiling does exactly what it is told to do - posts a one-line halt every pass -
    so it stays "active 1m ago" forever and the early return fires every tick. The one
    branch built to rescue it could therefore never run in the single situation it exists
    for: quota-immortality was unreachable by construction, and the honest halt the owner
    asked for became a silent death.

    So the handoff is checked HERE too, on the live path. Two guards keep it safe: it is
    skipped mid-turn (migrate stops the live writer, and killing real work to save quota is
    a worse bug than the one being fixed), and maybe_relocate itself is a no-op unless the
    account is genuinely over the band.

    ⛔ A SKIPPED HANDOFF MUST SAY SO (2026-09-01, the second half of the same bug). The
    first version of this branch skipped SILENTLY on both of its guards, so a tick that
    declined to rescue a cooked overlord printed the same "left alone" as a tick with
    nothing to do. That is how the original hole hid for hours: the log could not tell "no
    handoff needed" apart from "handoff not attempted". Every path now names itself."""
    if match is None:
        return row, (" ⚠ no dossier record resolves for it, so the quota handoff could not be "
                     "checked this tick (not a pass - the reading failed)")
    try:
        verdict_now = gatelib.gate_match(match, hydralib.session_row)
    except hydralib.DaemonError as err:
        return row, f" ⚠ gate read failed ({str(err)[:80]}) - quota handoff not checked"
    mid_turn = bool(verdict_now and verdict_now["state"] == "running"
                    and not verdict_now.get("idle"))
    if mid_turn:
        return row, (" (mid-turn: quota handoff deliberately not attempted - a migrate "
                     "stops the live writer, and killing real work to save quota is the "
                     "worse bug)")
    return maybe_relocate(row)


def _build_nudge_prompt(runners: list[dict]) -> str:
    prompt = NUDGE_PROMPT
    if not runners:
        return prompt
    lines = "\n".join(
        # .get, not [], on every optional field: this line builds the WATCHDOG's own
        # wake-up message, and a KeyError here kills the one thing whose job is to survive
        # everything else (found by a test whose fixture predated two of these fields).
        f"- {r.get('name')} ({str(r.get('sessionId'))[:8]}): in flight "
        f"{r.get('minutes', '?')}m, SILENT {r.get('silentMins', '?')}m - "
        f"{r.get('state', 'unknown')}" for r in runners[:8])
    return prompt + ("\n\nALSO REVIEW these LONG-RUNNERS (turn in flight past "
                     f"{LONG_RUN_SECS // 60} minutes - open each and judge: a healthy long "
                     "build is left alone, a stuck one gets acted on):\n" + lines)


def _run_nudge_cycle(state: OverlordState, as_json: bool) -> int:
    """The scheduled-task default: nudge the overlord if it is quiet with waiting work,
    handing off a cooked account along the way. Split out of main() so the crash backstop
    around it wraps one call instead of a hundred-line body."""
    row, sid, quiet, match = state.row, state.sid, state.quiet, state.match
    if quiet < NUDGE_QUIET_SECS:
        row, reloc = _handoff_check_while_active(row, match)
        return out({"ok": True, "report": (
            f"overlord active {int(quiet // 60)}m ago (< {NUDGE_QUIET_SECS // 60}m) - "
            "left alone" + reloc)}, as_json, 0)
    hold_why = holdlib.why_blocked(sid)
    if hold_why:
        return out({"ok": False, "report": f"overlord is HELD - not nudging: {hold_why}"},
                   as_json, 6)
    if match is None:
        return out({"ok": False, "report": "overlord gate FAILED: no dossier record resolves"},
                   as_json, 1)
    try:
        verdict = gatelib.gate_match(match, hydralib.session_row)
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"overlord gate FAILED: {err}"}, as_json, 1)
    if verdict and verdict["state"] == "running" and not verdict.get("idle"):
        # The handoff is NOT attempted here, and that is deliberate, not an oversight: a
        # migrate stops the live writer, so rescuing quota would kill the turn in flight.
        return out({"ok": True, "report": (
            "overlord is MID-TURN - working, left alone (quota handoff deliberately skipped: "
            "a migrate would kill the turn in flight)")}, as_json, 0)
    try:
        work = pending_work()
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"work check FAILED: {err}"}, as_json, 1)
    runners = long_runners()
    if runners:
        work = {**work, "any": True,
                "why": (work["why"] + f"; {len(runners)} long-runner(s) past "
                        f"{LONG_RUN_SECS // 60}m needing review")}
    if not work["any"]:
        # THE THIRD EXIT (2026-09-01). This one used to return before the handoff too, which
        # made the quiet-and-idle moment - the one moment a relocation is completely free,
        # with no turn to kill and no reply to strand - the one moment it could not happen.
        # The mid-turn gate above has already passed, so relocating here is safe by
        # construction, and moving a cooked manager BEFORE work arrives beats moving it after.
        row, reloc_idle = maybe_relocate(row)
        return out({"ok": True, "report": (
            f"overlord quiet {int(quiet // 60)}m but there is NO waiting work - left alone"
            + reloc_idle)}, as_json, 0)
    brake = ledgerlib.check("surface", sid)
    if brake["suppressed"]:
        return out({"ok": False, "breaker": brake,
                    "report": f"nudge SUPPRESSED by the breaker: {brake['why']}"}, as_json, 5)

    ledgerlib.note("surface", sid, note=f"watchdog nudge ({work['why']})")
    # THE QUOTA HANDOFF (maybe_relocate docstring): never wake the manager on a cooked
    # account when a fresh one has room.
    row, reloc_note = maybe_relocate(row)
    prompt = _build_nudge_prompt(runners)
    ok, detail = nudge(row, prompt)
    if ok:
        ledgerlib.clear("surface", sid)
        # A revive can leave a fresh zombie twin behind (current_match docstring): re-read
        # and flag whatever is now superseded, loudly.
        _, twins_after = current_match(sid)
        settled = settle_twins(twins_after)
        return out({"ok": True, "nudged": True,
                    "report": f"NUDGED '{row.get('title')}' after {int(quiet // 60)}m quiet "
                              f"({work['why']}) - {detail}.{reloc_note}{settled}{state.dup_note}"},
                   as_json, 0)
    # A failed wake still reports the quota handoff that DID happen before it.
    return out({"ok": False, "nudged": False,
                "report": f"nudge FAILED: {detail}.{reloc_note} Attempt recorded; the breaker "
                          "bounds retries."},
               as_json, 1)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv

    if "--claim" in argv:
        return _cmd_claim(argv, as_json)

    row, early = _locate_or_rebirth(argv, as_json)
    if early is not None:
        return early

    state, early = _refresh_overlord_state(row, argv, as_json)
    if early is not None:
        return early

    if "--status" in argv:
        return out(_status_payload(state), as_json, 0)

    # -- the nudge path (the scheduled-task default) --
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended nudging/relocation needs a
    # person's open window (`python orch.py arm`) or --force. Disarmed: report and touch nothing.
    refusal = armlib.refuse_unless_armed(argv, "the watchdog's nudge and handoff")
    if refusal:
        return out({"ok": True, "report": refusal}, as_json, 0)
    # ⛔ THE WATCHDOG MUST NEVER GO DARK SILENTLY (this pass): everything from here on touches
    # maybe_relocate() and the usage survey it reads, and a bad survey shape or any other
    # unexpected data used to escape as a bare traceback - a scheduled task with no one
    # watching its stderr. One broad catch around the whole nudge/relocate path turns that
    # into a loud, correctly-exited failure instead. hydralib.DaemonError keeps its own
    # specific handling inside _run_nudge_cycle, unchanged - this is the backstop for
    # everything else.
    try:
        return _run_nudge_cycle(state, as_json)
    except Exception as err:  # never a bare traceback - the watchdog must still exit loudly
        import traceback

        print(f"overlord CRASHED: {err}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
