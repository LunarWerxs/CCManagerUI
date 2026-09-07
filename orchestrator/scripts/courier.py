#!/usr/bin/env python3
"""courier.py - ACT: deliver staged replies into their chats, through the app's own composer.

THE LAST MANUAL LANE, CLOSED. Everything else the toolbox does ends at a decision; this is
what turns a decided reply into words in a chat. It sends only what `stage_reply.py` wrote
down, and it never composes anything itself: what to say is judgment (the AI's), delivering
it is mechanics (this).

THE RAILS, in the order they are checked, because the order is the design:

  1. HELD?          a person's hands-off switch outranks everything. Skipped, stays staged.
  2. BREAKER?       'deliver' attempts are counted like every other act; a futile loop stops.
  3. RESOLVE        the chat must resolve to exactly one row (ambiguity is a deterministic
                    refusal, never a guess).
  4. NEVER MID-TURN a chat whose turn is IN FLIGHT is never interrupted for the COMPOSER
                    route. (The peer channel is safe mid-turn: it enqueues natively and the
                    chat drains it after the current turn - like any SendMessage.) An IDLE
                    live chat is the normal target; a DORMANT/CRASHED chat is one too - the
                    composer send boots its engine (delivery IS the revive).
  5. DELIVER        the daemon's /message endpoint picks the channel: THE OFFICIAL PEER
                    CHANNEL for a live session (native input queue, no UI), the composer for
                    a dormant/crashed one (which it also boots).
  6. VERIFY TEXT    the composer route refuses to type until it SEES a snippet of this chat's
                    own last words in the pane it selected (the peer route needs none - the
                    token authenticates and the session id addresses).
  7. CONFIRM MOVED  a send is not a delivery. The chat must be observed to MOVE (a growing
                    transcript) before this is called delivered. If it cannot be confirmed,
                    say so - never claim.

Usage: python courier.py                      # plan only: what would be delivered, and why
       python courier.py --yes [--max N]      # deliver (default cap 5 per run)
       python courier.py --yes --only <id>    # one specific staged reply
       (--cap-exempt: with --only, skip the machine-wide running cap - the overlord
        watchdog's wake only, because a system at its cap with a dead manager stays dead)
Exit:  0 everything attempted was delivered and confirmed (or nothing to do) - 2 something was
       skipped or did not land (each named) - 1 daemon failure before acting.
"""

from __future__ import annotations

import contextlib
import dataclasses
import json
import subprocess
import sys
import time
from pathlib import Path

from lib import armlib, clilib
from lib import bandlib
from lib import deliverylib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib
from lib import windowlib

# THE COMPOSER ACTUATOR LIVES HERE NOW (owner, 2026-09-01: "relocate it into the orchestrator
# - I own both codebases"). It was misc/Deliver-DesktopChat.ps1 in AgentHydra, a PUBLIC repo,
# where the script that types into the owner's chats sat inside another lane's rewrite. The
# daemon's own /message endpoint still runs its copy; this one is the orchestrator's.
ACTUATOR = Path(__file__).resolve().parent / "actuator" / "deliver_desktop_chat.ps1"
DEFAULT_MAX = 5
# How long to watch for the chat to move after sending before giving up on confirming it.
# A composer send into a DORMANT or CRASHED chat boots its engine first (that boot is the
# revive), so the window covers an engine start, not just an append.
# A DORMANT chat must BOOT before its first byte lands; 60s reported healthy wakes as
# unconfirmed on a busy machine (measured 2026-09-01). The daemon endpoint watches for
# this long on our behalf.
CONFIRM_SECS = 150
# A per-delivery CLAIM older than this belongs to a dead courier run and is reclaimable
# (send pipeline worst case: actuator timeout 300s + confirm 25s + margin).
CLAIM_STALE_SECS = deliverylib.CLAIM_STALE_SECS
# How long the local composer actuator (the older-daemon fallback) gets before we give up on
# it. A hang here must read as an ordinary actuator failure, not an uncaught exception that
# skips straight past mark_failed and the results row every other refusal gets.
ACTUATOR_TIMEOUT_SECS = 300


@contextlib.contextmanager
def _claim(delivery_id: str):
    """At-most-once delivery across OVERLAPPING courier runs (adversarial review,
    2026-08-31: a row stays 'staged' for its whole send pipeline, so two runs could both
    pick it up and the chat gets the same reply twice). An atomic mkdir is the claim; a
    stale claim (dead run) is broken loudly; the claim always lifts afterwards - the ROW
    state (delivered/failed/staged) stays the durable truth, the claim is only the moment's
    mutex. Yields False when another live run holds it: skip, never wait."""
    path = deliverylib.claim_path(delivery_id)  # one definition: cancel() reads it too
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in (1, 2):
        try:
            path.mkdir()
            break
        except FileExistsError:
            try:
                if attempt == 1 and time.time() - path.stat().st_mtime > CLAIM_STALE_SECS:
                    path.rmdir()
                    continue
            except OSError:
                continue  # it vanished: the other run just finished - retry the claim
            yield False
            return
    try:
        yield True
    finally:
        try:
            path.rmdir()
        except OSError:
            pass


def _activity_of(session_id: str, transcript_path: str | None = None) -> tuple[str | None, int]:
    """(lastActivityAt, transcript size) - the two independent signals that a chat moved.

    `transcript_path` is stable across a 25s confirm window, so deliver_one resolves it once
    and threads it in - the poll loop was paying a full /api/sessions fetch every 2s just to
    re-derive it (efficiency pass, 2026-08-31). The time-VARYING signals (dossier's
    lastActivityAt, the file's stat) are still read fresh on every call."""
    try:
        matches = hydralib.dossier(session_id)
    except hydralib.DaemonError:
        return None, 0
    last = matches[0].get("lastActivityAt") if matches else None
    if transcript_path is None:
        row = hydralib.session_row(session_id)
        transcript_path = (row or {}).get("transcript_path")
    size = 0
    if transcript_path:
        try:
            size = Path(transcript_path).stat().st_size
        except OSError:
            size = 0
    return last, size


# ⛔ THERE IS NO "_native_deliver" ANY MORE, AND THERE MUST NOT BE ONE (2026-09-01). The
# function that stood here posted /api/sessions/:id/migrate believing the prompt ran as the
# chat's resume turn. It does not - the endpoint's own comment says "the PROMPT is not
# delivered here", and the daemon's monitor calls zero-click delivery "a future piece". What
# the call really did was KILL the chat's process, archive its row, and reimport it DORMANT:
# message lost, zombie twin left visible, "Claude has crashed" on the owner's screen. His
# overlord chat measured the damage exactly: "zero of ten replies reached a chat". /migrate
# is for MIGRATIONS; the composer actuator below is the one real delivery channel, and its
# send is also what boots a dormant or crashed chat (the daemon's own 2026-08-26 measurement).


def _run_actuator(title: str, instance: str, message: str, verify: str) -> tuple[int, str]:
    if not ACTUATOR.exists():
        return 1, f"the delivery actuator is missing at {ACTUATOR}"
    args = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR),
        "-Title", title, "-Message", message, "-VerifyText", verify,
        "-IfBusyAbort",          # a chat that started working mid-flight aborts the send
        "-SearchByContent",      # imported chats can render untitled; content is the identity
    ]
    if instance:
        args += ["-Instance", instance]
    try:
        r = clilib.run_text(args, timeout=ACTUATOR_TIMEOUT_SECS)
    except subprocess.TimeoutExpired:
        # A hung actuator is a delivery failure like any other (rows above return (1, why))
        # - never an exception that escapes deliver_one and skips mark_failed/the results row.
        return 1, f"actuator timed out after {ACTUATOR_TIMEOUT_SECS}s"
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def deliverable(entry: dict, session_lookup=None, _holds=None, _ledger_rows=None,
                _bands=None, _per_instance=None, _share=None) -> tuple[bool, str, dict | None]:
    """Can this staged reply go RIGHT NOW? Returns (ok, why_not, match).

    The three snapshot params exist for run()'s planning loop, which gates many entries
    against ONE read of the sessions table / holds file / attempt ledger taken at the top of
    that same call (efficiency pass, 2026-08-31; ledgerlib's own suppressed() already works
    this way). Scoped to one planning loop only - deliver_one's at-send checks stay fresh."""
    sid = entry["session"]
    why_held = holdlib.why_blocked(sid, _holds=_holds)
    if why_held:
        return False, f"the chat is HELD: {why_held}", None
    brake = ledgerlib.check("deliver", sid, _rows=_ledger_rows)
    if brake["suppressed"]:
        return False, f"breaker: {brake['why']}", None
    try:
        match = hydralib.resolve_one(sid)
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        return False, f"deterministic: {err}", None
    except hydralib.DaemonError as err:
        return False, f"daemon read failed: {err}", None
    # THE VERIFY SNIPPET IS THE COMPOSER'S RAIL, NOT THE PEER CHANNEL'S (live smoke,
    # 2026-09-01): a LIVE chat takes the message through its own peer pipe - native input,
    # no UI, nothing to aim - so a chat whose last words were 'PONG' or 'Done.' (too short
    # for a snippet) was undeliverable for no reason. Only a chat with no live engine falls
    # to the composer, and only there is typing without proof how a reply lands in someone
    # else's work. If the engine dies between this plan and the send, the daemon's own
    # composer route still refuses to type blind - an honest failure, never a blind act.
    if not entry.get("verifyText") and not match.get("live"):
        return False, ("no verify snippet and no live engine - the composer would have nothing "
                       "to prove it found the right chat, and typing without that proof is how "
                       "a reply lands in someone else's work"), None

    # THE USAGE BANDS, AT THE DOOR EVERY REPLY GOES THROUGH (owner, 2026-09-01: "one of my
    # accounts hit 100% on the 5 hour - thought you had rules against that"). The policy was
    # real and was consulted only by saturate's planner, so every other lane fed accounts
    # without ever asking. A message is a TURN, and a turn is burn - so the gate is here, on
    # the one path all of them share. There is deliberately no exemption flag: an account
    # past its target does not become affordable because a caller is in a hurry.
    inst_name = match.get("instance")
    ok_band, why_band = bandlib.may_take_work(inst_name, _bands)
    if not ok_band:
        return False, f"{why_band} - staged, not lost; move it or wait for the reset", match

    verdict = gatelib.gate_match(match, session_lookup or hydralib.session_row)
    if verdict is None:
        return False, "the chat cannot be gated (no readable transcript), so its state is unknown", match
    if verdict["state"] == "running" and not verdict.get("idle"):
        # THE LIVE RAIL. Idle-but-alive is waiting and is the normal target; mid-turn is
        # working and is never interrupted.
        return False, f"its turn is IN FLIGHT ({verdict['cause']}) - never interrupt a live turn", match
    # A CRASHED chat IS a delivery target now (2026-09-01): the composer send is what boots
    # a dormant or crashed chat's engine and runs the turn (the daemon's own 2026-08-26
    # measurement) - so delivering the reply IS the resume. The old refusal assumed a typed
    # reply "goes nowhere", which was true only of the phantom native route.

    # THE SPREAD RULE, as a per-account ceiling. Waking a DORMANT chat adds a runner to that
    # account; a running chat taking another turn does not, so only the former is capped. This
    # is what stops one account quietly accumulating the whole machine (six chats of eleven,
    # on the day it burned its 5-hour window to 100%) while four others sat near zero.
    if verdict["state"] != "running" and _per_instance is not None and _share:
        held = _per_instance.get(str(inst_name), 0)
        if held >= _share:
            return False, (f"account '{inst_name}' already runs {held} chat(s) - its share of "
                           f"the machine is {_share}; waking another there is hogging, not "
                           "balancing. Staged and retried next cycle"), match
    # `wakes` tells run() whether this delivery ADDS a runner to the account, so its planning
    # loop can count the share forward (a running chat taking another turn adds none).
    return True, "", {**match, "wakes": verdict["state"] != "running"}


def _ensure_doctrine(sid: str, match: dict) -> str:
    """Stamp bypassPermissions + ultracode on a DORMANT chat, immediately before waking it.

    WHY HERE AND NOT ONLY ON A CLOCK (owner, 2026-09-01: "not setting bypass permissions...
    when a chat asks for permission to run something because you forgot to set the
    permissions"). The doctrine sweep writes the stamp on a 5-minute clock, and a RUNNING app
    re-saves its in-memory copy straight over it - the daemon says so in its own response. So
    the only moment the stamp is genuinely durable is while the chat is DORMANT, and the most
    valuable such moment is the instant before it boots. That is here.

    A chat that boots without it stops on a permission prompt, holds a running slot doing
    nothing, and looks alive while it waits - which is exactly the failure the owner hit.
    Best-effort by design: a stamp that cannot be written must never cancel the delivery, but
    it is reported, never swallowed.
    """
    if match.get("live"):
        return ""  # a live app owns the record; stamping under it just gets re-saved away
    said = []
    try:
        got = hydralib.api_post(f"/api/sessions/{sid}/automation", {})
        if not (isinstance(got, dict) and got.get("ok")):
            said.append("bypass stamp refused")
    except hydralib.DaemonError as err:
        said.append(f"bypass stamp failed ({str(err)[:60]})")
    meta = match.get("metaPath")
    if meta:
        try:
            from lib import stamplib

            got2 = stamplib.stamp_doctrine(meta)
            if not (got2["bypass"] and got2["ultracode"]):
                said.append("doctrine stamp incomplete")
        except Exception as err:  # a stamp is a courtesy, never a blocker
            said.append(f"ultracode stamp failed ({str(err)[:60]})")
    return ("; " + ", ".join(said)) if said else ""


@dataclasses.dataclass
class _BeforeState:
    """The chat's movement signals at T-0, before anything is sent. Rail 7 (deliver_one's
    docstring) proves delivery by watching these change, never by trusting the send itself."""

    tpath: str | None
    activity: str | None
    size: int
    live: dict | None


def _reject_if_unstaged(entry: dict) -> dict | None:
    """None when this row is still staged and safe to send; the skip result otherwise.

    THE ROW IS RE-READ AT SEND TIME (review 2026-09-01). run() plans from one snapshot of
    the queue and then sends serially, each send taking minutes; a person who cancels a
    queued reply in that window - the moment one typically notices a wrong reply - was told
    "cancelled" while this run still sent it from the stale in-memory dict and then wrote
    "delivered" over the cancel. Nothing is typed unless the row is STILL staged now.
    """
    fresh = deliverylib.get(entry["id"])
    if not fresh or fresh.get("state") != "staged":
        state = (fresh or {}).get("state") or "gone"
        return {"id": entry["id"], "ok": False,
                "outcome": f"skipped - no longer staged ({state})",
                "detail": "it was cancelled or settled by another run between planning and "
                          "sending; nothing was typed"}
    return None


def _capture_before_state(sid: str) -> _BeforeState:
    """Snapshot the chat's movement signals once, fresh at send time; the confirm loop reuses
    the transcript path (it cannot change inside the confirm window, and re-deriving it cost
    a full sessions fetch per 2s poll tick)."""
    tpath = (hydralib.session_row(sid) or {}).get("transcript_path")
    activity, size = _activity_of(sid, tpath)
    try:
        live = hydralib.live_for(sid)
    except hydralib.DaemonError:
        live = None
    return _BeforeState(tpath=tpath, activity=activity, size=size, live=live)


def _send_via_daemon(entry: dict, match: dict, sid: str, before: _BeforeState,
                     doctrine_note: str) -> dict | None:
    """THE ROUTE: the daemon's message endpoint (POST /api/sessions/:id/message), which picks
    the right channel by itself - and prefers THE OFFICIAL PEER CHANNEL (owner, 2026-09-01:
    "why don't we use the old method"). For a LIVE session it injects into the chat's own
    peer-messaging pipe exactly as one session's SendMessage reaches another: native input
    queue, NO UI, no composer click. Only a dormant/crashed chat (no pipe) falls to the
    composer, which can BOOT it and self-heals an unrendered row via claude://resume. An
    older daemon (404) falls back to driving the local composer actuator (deliver_one's
    caller does this: this function returns None to say so).
    ⛔ NEVER /migrate for delivery: it delivers no prompt - it kills and reimports the chat
    dormant (2026-09-01: message lost, zombie twin, "Claude has crashed").

    Returns the final result dict when this attempt settles the delivery (success or an
    honest failure); None when an older daemon (404) leaves the composer as the only path.
    """
    title = match.get("title") or entry.get("title") or ""
    try:
        # THE CLIENT MUST OUTWAIT THE SERVER (2026-09-01). This endpoint is not a read: it
        # selects the row, re-renders it if the sidebar virtualized it away (two 8s waits),
        # types, and then WATCHES up to confirm_secs for the transcript to grow. We ask it
        # for a CONFIRM_SECS window (150s), so the call can honestly take ~150-270s - against
        # hydralib's 30s default. The client gave up first and wrote "failed" while the daemon was still
        # working and the message may already have been typed, which is the worst possible
        # record: a delivery that happened, filed as one that did not, and therefore a
        # candidate for being sent AGAIN. The confirm window itself is load-bearing (it
        # covers an engine boot for a dormant chat), so the timeout moves, not the window.
        got = hydralib.api_post(f"/api/sessions/{sid}/message",
                                {"text": entry["text"], "verify_text": entry.get("verifyText") or "",
                                 "confirm_secs": CONFIRM_SECS},
                                timeout=CONFIRM_SECS + 120)
        if isinstance(got, dict) and got.get("delivered"):
            deliverylib.mark_delivered(entry["id"])
            ledgerlib.clear("deliver", sid)
            via = str(got.get("route") or "daemon")
            return {"id": entry["id"], "ok": True,
                    "outcome": f"delivered ({'native peer channel' if via == 'peer' else 'composer'}, "
                               "via the daemon) and confirmed",
                    "detail": (str(got.get("detail") or f"'{title}' took the message")
                               + doctrine_note)[:250]}
        # typed-but-unconfirmed or endpoint refusal: honest failure, never a silent retry
        deliverylib.mark_failed(entry["id"], f"daemon message endpoint: {str(got)[:300]}")
        return {"id": entry["id"], "ok": False, "outcome": "the daemon endpoint did not confirm",
                "detail": str((got or {}).get("detail") or (got or {}).get("error") or got)[:200]}
    except hydralib.DaemonError as err:
        # THE PEER DEAD-LETTER FALLBACK (2026-09-01, measured). The daemon's peer route
        # writes the reply into a live session's pipe, reports "wrote", and then fails to
        # confirm - and it deliberately will NOT composer-type after that, to avoid a
        # duplicate into a live chat. Sound reasoning, wrong premise here: the message never
        # arrives at all. Checked directly across four chats over 25 minutes - the text
        # appears ZERO times in their transcripts and one transcript did not grow by a single
        # byte - while a genuine peer message from another session DID reach a chat the same
        # night. So the daemon's hand-rolled injection is writing bytes nothing consumes, and
        # every live chat became undeliverable: the owner's "chats sitting idle" in one line.
        #
        # The guard against duplicates is kept, not discarded - it is just made evidential.
        # We already recorded before.size at T-0, so we can PROVE nothing landed before
        # typing: if the transcript grew at all, the peer message may have taken and we
        # refuse exactly as the daemon intended. Falling back on proof is not the same as
        # ignoring the warning.
        peer_dead = (err.status == 422 and "wrote-but-no-transcript-growth" in (err.detail or ""))
        if peer_dead:
            _, size_now = _activity_of(sid, before.tpath)
            if size_now > before.size:
                deliverylib.mark_failed(
                    entry["id"],
                    f"daemon message endpoint: {err} | {err.detail} - and the transcript DID "
                    "grow, so the peer message may have landed; not typing a possible duplicate")
                return {"id": entry["id"], "ok": False,
                        "outcome": "peer did not confirm, but the chat moved - not risking a duplicate",
                        "detail": (err.detail or str(err))[:200]}
            ledgerlib.note("deliver", sid,
                           note=f"peer route dead-lettered {entry['id']}; transcript unchanged "
                                f"at {before.size} bytes - falling back to the composer")
            return None
        if err.status not in (404,):
            # RECORD THE REASON, NOT JUST THE NUMBER (2026-09-01). DaemonError.__str__ is
            # "<path> -> HTTP 422" and nothing more, while the composer's actual refusal -
            # "not rendered in any searched running instance", the actuator tail, the verify
            # text it looked for - rides on .detail. Logging str(err) threw all of it away,
            # so ten dead deliveries recorded ten identical "HTTP 422" lines and the ledger
            # could not say why a single chat had gone idle. A failure record that cannot
            # explain the failure is only bookkeeping.
            deliverylib.mark_failed(
                entry["id"],
                f"daemon message endpoint: {err}"
                + (f" | {err.detail}" if err.detail else ""))
            return {"id": entry["id"], "ok": False, "outcome": "the daemon endpoint refused",
                    "detail": (err.detail or str(err))[:200]}
        return None  # 404 = older daemon without the endpoint: drive the actuator locally.


def _wait_for_movement(sid: str, before: _BeforeState) -> bool:
    """CONFIRM: the keystroke is not the delivery. Watch for the chat to actually move - a
    growing transcript, a fresh lastActivityAt, or (a boot from dormant) a changed live-
    registry entry, which shows there before the first transcript write."""
    deadline = time.time() + CONFIRM_SECS
    while time.time() < deadline:
        after_activity, after_size = _activity_of(sid, before.tpath)
        if (after_activity and after_activity != before.activity) or after_size > before.size:
            return True
        try:
            after_live = hydralib.live_for(sid)
        except hydralib.DaemonError:
            after_live = None
        if after_live and after_live != before.live:
            return True
        time.sleep(2)
    return False


def _deliver_via_actuator(entry: dict, match: dict, sid: str, before: _BeforeState,
                          doctrine_note: str) -> dict:
    """The composer fallback (an older daemon, 404, with no /message endpoint): drive the
    local actuator directly, then rail 7 - refuse to call it delivered until the chat moves."""
    title = match.get("title") or entry.get("title") or ""
    instance = match.get("instance") or entry.get("instance") or ""
    code, out = _run_actuator(title, instance, entry["text"], entry["verifyText"])
    if code != 0:
        deliverylib.mark_failed(entry["id"], f"composer: {out or f'exit {code}'}")
        return {"id": entry["id"], "ok": False, "outcome": "the composer refused",
                "detail": (out.splitlines()[-1] if out else f"exit {code}")[:160]}
    if not _wait_for_movement(sid, before):
        deliverylib.mark_failed(
            entry["id"],
            "the actuator reported it typed and sent, but the chat did not move within "
            f"{CONFIRM_SECS}s - NOT claiming delivery")
        return {"id": entry["id"], "ok": False, "outcome": "sent but NOT confirmed",
                "detail": "the chat did not move; re-check it by hand before re-staging"}
    deliverylib.mark_delivered(entry["id"])
    ledgerlib.clear("deliver", sid)  # success clears - the brake is for futility
    # doctrine_note rides on EVERY success path (its docstring: reported, never swallowed).
    return {"id": entry["id"], "ok": True, "outcome": "delivered (daemon) and confirmed",
            "detail": (f"'{title}' took the message and started moving" + doctrine_note)[:250]}


def deliver_one(entry: dict, match: dict) -> dict:
    """Send it, then prove the chat moved. Every outcome is recorded on the ledger."""
    sid = entry["session"]
    title = match.get("title") or entry.get("title") or ""
    rejected = _reject_if_unstaged(entry)
    if rejected is not None:
        return rejected
    before = _capture_before_state(sid)
    ledgerlib.note("deliver", sid, note=f"deliver {entry['id']} to '{title}'")
    deliverylib.note_attempt(entry["id"])
    # THE LAST DURABLE MOMENT (_ensure_doctrine): stamp the chat before the send boots it.
    doctrine_note = _ensure_doctrine(sid, match)
    settled = _send_via_daemon(entry, match, sid, before, doctrine_note)
    if settled is not None:
        return settled
    return _deliver_via_actuator(entry, match, sid, before, doctrine_note)


def _verify_of(report: dict, delivery_id: str) -> str:
    """The verify text a planned row is actually carrying, for the placeholder warning."""
    for r in deliverylib.all_rows():
        if r.get("id") == delivery_id:
            return str(r.get("verifyText") or "")
    return ""


def run(max_deliveries: int, only: str | None, act: bool, running_now: int | None = None,
        cap_exempt: bool = False) -> dict:
    queue = deliverylib.pending()
    if only:
        queue = [e for e in queue if e["id"] == only]
    planned, skipped, results = [], [], []
    if queue:
        # THE MACHINE-WIDE CAP (hydralib.MAX_RUNNING_CHATS): every delivery can wake a chat,
        # so deliveries beyond the cap DEFER - they stay staged and the next 5-minute cycle
        # retries them, which is the owner's round robin. `running_now` lets sweep hand in
        # the count its plan already measured; standalone runs count fresh.
        if cap_exempt and only:
            running_now = running_now if running_now is not None else -1
            allowed_new = len(queue)  # the manager's wake (docstring); single --only rows only
        else:
            if running_now is None:
                running_now = hydralib.running_count()
            allowed_new = max(0, hydralib.MAX_RUNNING_CHATS - running_now)
        # ONE snapshot for the whole planning loop, scoped to THIS run() call only (a later
        # run takes its own): the sessions table becomes an O(1) lookup instead of a full
        # fetch-and-scan per entry, and the two small state files are read once, mirroring
        # ledgerlib.suppressed()'s own pattern. deliver_one's at-send reads stay fresh.
        by_id = {r.get("session_id"): r for r in hydralib.sessions()}
        holds_snapshot = holdlib._load()
        ledger_snapshot = ledgerlib._load()
        # ONE usage read and ONE per-account running count for the whole planning loop - the
        # survey is the slow call in this toolbox, and a per-entry re-read would make the band
        # gate cost more than the deliveries it guards.
        bands_snapshot = bandlib.snapshot()
        try:
            live_ids, per_instance = hydralib.running_by_instance()
        except hydralib.DaemonError:
            live_ids, per_instance = None, None
        open_accounts = len({str(i.get("name")) for i in hydralib.fleet().get("instances", [])
                             if i.get("isRunning")})
        share = bandlib.per_account_share(open_accounts, hydralib.MAX_RUNNING_CHATS)
        # THE SHARE IS COUNTED FORWARD (review 2026-09-01, the same shape saturate's planner
        # already had). The snapshot says what runs NOW; each dormant wake this loop plans
        # adds a runner the snapshot cannot see, so three staged replies for one account at
        # zero all passed "0 < share" and woke three chats there in a single run - up to
        # 2.5x the ceiling this rule exists for. The running copy is what deliverable reads.
        would_run = dict(per_instance) if per_instance is not None else None
        # ONE MESSAGE PER CHAT PER RUN. Two lanes can each stage a wake for the same chat in
        # the same window (saturate and the overlord both plan from their own reads); the
        # second row stays staged and is re-judged next cycle, when the first has landed and
        # the chat is no longer dormant.
        chats_planned: set[str] = set()
        # ⛔ THE CAP COUNTS WAKES, NOT MESSAGES (found live 2026-09-06, and the inconsistency was
        # already visible in this very loop). The cap exists because "every delivery can wake a
        # chat", so N deliveries could add N runners - but a delivery to a chat that is ALREADY
        # RUNNING adds nobody. It is a message into an engine the snapshot has already counted.
        # Counting it anyway refused to talk to two chats that were themselves inside the 18 the
        # cap was measuring, which is the cap declining to deliver on its own arithmetic.
        #
        # The notion needed was already here and already documented: deliverable() returns
        # `wakes` (verdict state != running) precisely so run()'s planning knows whether a
        # delivery ADDS a runner - and the PER-ACCOUNT share below honours it while this
        # machine-wide gate did not. Now both rails count the same thing.
        wakes_planned = 0
        for entry in queue:
            if len(planned) >= max_deliveries:
                break
            # The cheap half of the gate, so a capped queue does not pay for a transcript read
            # per row: a chat with no live engine can ONLY be a wake, so it is refused here.
            # ⛔ FAIL CLOSED. live_ids is None when the daemon read failed - unknown liveness is
            # treated as a wake, which is exactly the behaviour this gate had before.
            if wakes_planned >= allowed_new and (live_ids is None or entry["session"] not in live_ids):
                skipped.append({**entry, "why": (
                    f"concurrency cap: {running_now} chat(s) running plus {wakes_planned} "
                    f"wake(s) planned reaches the machine-wide {hydralib.MAX_RUNNING_CHATS} "
                    "and this chat has no live engine, so delivering would add one - "
                    "deferred, stays staged; the next 5-minute cycle retries it")})
                continue
            if entry["session"] in chats_planned:
                skipped.append({**entry, "why": (
                    "another reply to this chat is already planned in this run - one message "
                    "per chat per cycle; it stays staged and is re-judged next cycle")})
                continue
            ok, why, match = deliverable(entry, session_lookup=by_id.get,
                                         _holds=holds_snapshot, _ledger_rows=ledger_snapshot,
                                         _bands=bands_snapshot, _per_instance=would_run,
                                         _share=share)
            if not ok:
                skipped.append({**entry, "why": why})
                continue
            # The authoritative half: `wakes` is the gate's own verdict, not our liveness
            # snapshot, so a chat that looked live a moment ago but is not running by the time
            # it is gated still counts against the cap.
            if match.get("wakes") and wakes_planned >= allowed_new:
                skipped.append({**entry, "why": (
                    f"concurrency cap: {running_now} chat(s) running plus {wakes_planned} "
                    f"wake(s) planned reaches the machine-wide {hydralib.MAX_RUNNING_CHATS} - "
                    "deferred, stays staged; the next 5-minute cycle retries it")})
                continue
            planned.append((entry, match))
            chats_planned.add(entry["session"])
            if match.get("wakes"):
                wakes_planned += 1
            if would_run is not None and match.get("wakes"):
                k = str(match.get("instance"))
                would_run[k] = would_run.get(k, 0) + 1
    if act:
        for entry, match in planned:
            # THE LOOP MUST OUTLIVE ANY ONE ROW'S EXCEPTION (hardening, 2026-09-01: "must work
            # reliably for hours on end"). Without this, a raise anywhere in the send path - a
            # claim-dir race, a windowlib surprise, anything not already caught below - escaped
            # run() entirely and abandoned every LATER staged reply in `planned` unrecorded and
            # un-retried until the next cycle happened to re-plan them. Treat it like any other
            # delivery failure: mark it, report it, and keep going.
            try:
                # The per-delivery CLAIM (_claim docstring): overlapping courier runs must
                # never send the same staged reply twice.
                with _claim(entry["id"]) as ours:
                    if not ours:
                        results.append({"id": entry["id"], "ok": False,
                                        "outcome": "skipped - another courier run holds this delivery",
                                        "detail": "its claim is present and fresh; the row stays "
                                                  "staged unless that run lands it"})
                        continue
                    # ONE DRIVER PER WINDOW (windowlib.instance_lock): a composer send and another
                    # lane's sidebar click on the same instance must never interleave. Busy means
                    # skip - the row stays staged and the next cycle retries it.
                    with windowlib.instance_lock(match.get("instance"), wait_secs=120) as mine:
                        if not mine:
                            results.append({"id": entry["id"], "ok": False,
                                            "outcome": "skipped - that instance's window is busy",
                                            "detail": "another lane is driving it right now; the "
                                                      "row stays staged for the next cycle"})
                            continue
                        # PUT THE WINDOW BACK (windowlib): a delivery can make the daemon re-render
                        # a virtualized row through the app's own deeplink, and the app raises
                        # itself when it handles one. Placement is noted before and restored after,
                        # and the restore prints - a silent guard would tell us nothing the next
                        # time the owner sees a window where he did not leave it.
                        with windowlib.keep_placement(
                                match.get("instance"),
                                note=lambda said, t=match.get("title"): print(
                                    f"  window: {said} after delivering to '{t}'")):
                            res = deliver_one(entry, match)
                            # WHY IT DIDN'T STICK, onto the breaker's own row (ledgerlib.annotate).
                            # deliver_one already records the reason on the DELIVERY, but the
                            # breaker reads the ATTEMPT ledger, so its verdict used to arrive
                            # reasonless. One place, after the fact, so no return path can forget
                            # it - and an annotate, never a second note, so the attempt count
                            # stays honest.
                            if not res.get("ok"):
                                ledgerlib.annotate(
                                    "deliver", entry["session"],
                                    f"{res.get('outcome') or 'failed'}: {res.get('detail') or ''}",
                                    failure=True)
                            results.append(res)
            except Exception as exc:  # noqa: BLE001 - the last resort, see comment above
                deliverylib.mark_failed(entry["id"], f"unexpected: {exc}")
                results.append({"id": entry["id"], "ok": False,
                                "outcome": "unexpected error while delivering",
                                "detail": str(exc)[:200]})
    return {
        # The count BEFORE acting: reading it afterwards reported "nothing staged" on a run
        # that had just delivered everything, which reads as a failure (seen on the first
        # live delivery).
        "runningNow": running_now,
        "staged": len(queue),
        "planned": [{"id": e["id"], "title": e.get("title") or m.get("title"),
                     "instance": m.get("instance"), "text": e["text"][:120]}
                    for e, m in planned],
        "skipped": [{"id": s["id"], "title": s.get("title"), "why": s["why"]} for s in skipped],
        "results": results,
        "overCap": max(0, len(queue) - len(planned) - len(skipped)),
    }


@dataclasses.dataclass
class _Args:
    as_json: bool
    act: bool
    only: str | None
    cap: int
    cap_exempt: bool


def _parse_args(argv: list[str]) -> "_Args | int":
    """The CLI flags, parsed once. Returns an _Args, or an int exit code when parsing itself
    must end the run (a malformed --only)."""
    as_json = "--json" in argv
    act = "--yes" in argv
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended acting needs a person's open
    # window (`python orch.py arm`) or --force. Disarmed: fall back to plan-only and say so.
    if act:
        refusal = armlib.refuse_unless_armed(argv, "delivering staged replies")
        if refusal:
            print(refusal)
            act = False
    only = None
    if "--only" in argv:
        i = argv.index("--only")
        if i + 1 >= len(argv):
            print(__doc__.strip(), file=sys.stderr)
            return 2
        only = argv[i + 1]
    cap = DEFAULT_MAX
    if "--max" in argv:
        cap = int(argv[argv.index("--max") + 1])
    return _Args(as_json=as_json, act=act, only=only, cap=cap, cap_exempt="--cap-exempt" in argv)


def _print_placeholder_warning(report: dict) -> None:
    """A PLACEHOLDER IDENTITY CHECK IS NOT AN IDENTITY CHECK, and it must not pass in
    silence (found live 2026-09-01: three staged replies carried the verify text "x",
    one character, staged by the saturate job). Rail 6 exists so the actuator refuses
    to type until it SEES this chat's own words in the pane it picked - a single "x"
    matches essentially any pane, so for those rows the rail was off while still
    appearing to be on, and one of them reported "typed, but the transcript did not
    grow". Left unblocked deliberately: a brand-new chat has no prior words to match,
    which is presumably why the placeholder exists. But it is now SAID, every time."""
    weak = [p for p in report["planned"]
            if len(str(_verify_of(report, p["id"]))) < deliverylib.MIN_VERIFY_LEN]
    if weak:
        print(f"  ⚠ {len(weak)} of these carry a PLACEHOLDER identity check shorter than "
              f"{deliverylib.MIN_VERIFY_LEN} chars - the wrong-chat guard cannot really "
              "bite on them. Fine for a chat with no words yet; wrong for any other.")


def _print_report(report: dict, act: bool) -> None:
    """The human-readable rendering of a run() report. Kept apart from main() so the CLI
    plumbing (arg parsing, exit codes) is not tangled with what gets printed."""
    if not report["staged"]:
        print("nothing staged - the courier has nothing to deliver.")
    # ⛔ COUNT WHAT LANDED, NOT WHAT WAS ATTEMPTED (2026-09-01). This printed
    # len(planned) under the word "delivered" - but `planned` is the INTENT, formed
    # before a single send. A run where the composer refused one of two replies still
    # announced "2 reply(ies) delivered" and listed the refused chat among them, with the
    # actual "✗ the composer refused" three lines below, contradicting the headline. The
    # whole design of this script is that a send is not a delivery (rail 7); its own
    # summary was the one place that forgot, which is the worst place for it - the
    # headline is what gets read and pasted into a report.
    ok_ids = {r["id"] for r in report["results"] if r["ok"]} if act else None
    landed = len(ok_ids) if act else len(report["planned"])
    print(f"{landed} reply(ies) {'delivered' if act else 'would be delivered'}"
          + (f" (+{report['overCap']} over the per-run cap)" if report["overCap"] else ""))
    _print_placeholder_warning(report)
    for p in report["planned"]:
        mark = "" if ok_ids is None else ("  -> " if p["id"] in ok_ids else "  !! NOT DELIVERED ")
        print(f"{mark or '  -> '}[{p['instance']}] {p['title']}")
        print(f"     {p['text']}")
    for s in report["skipped"]:
        print(f"  SKIPPED {s['title'] or s['id']}: {s['why']}")
    for r in report["results"]:
        mark = "✓" if r["ok"] else "✗"
        print(f"  {mark} {r['outcome']} - {r['detail']}")
    if not act and report["planned"]:
        print("\nPLAN ONLY - nothing sent. Add --yes to deliver.")


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    parsed = _parse_args(argv)
    if isinstance(parsed, int):
        return parsed

    try:
        report = run(parsed.cap, parsed.only, parsed.act, cap_exempt=parsed.cap_exempt)
    except hydralib.DaemonError as err:
        print(f"courier FAILED before acting: {err}", file=sys.stderr)
        return 1

    if parsed.as_json:
        print(json.dumps(report, indent=2))
    else:
        _print_report(report, parsed.act)
    if not parsed.act:
        return 0
    failed = [r for r in report["results"] if not r["ok"]]
    return 2 if (failed or report["skipped"]) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
