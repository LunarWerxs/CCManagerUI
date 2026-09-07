"""mutationlib - THE MUTATION LEDGER: a before/after record and an undo path for every act
the orchestrator performs on a Desktop chat's own files.

Not related to any external project's checkpoint tooling - this is a flat, append-only JSON
log where every mutating act writes down what the target looked like immediately BEFORE it
acted and what it looked like immediately AFTER (or "unknown" when the after-state could not
be confirmed), so a wrong act - the README documents 6 of 29 chats archived wrongly in one day
under v2 - can be undone from here instead of by hand, on a screen, from memory.

archive_chat.py, rename_chat.py, migrate_chat.py, hold_chat.py and compact_chat.py each know
their own target well enough to build a before-image (they already re-read the dossier or the
hold file immediately before acting - rule 5, "a person's word is the highest input"), and
each already verifies its own after-state - rule 6 in archive_chat.py's words, "never claim an
act landed without checking". This module is just where that verification, which already
happens, gets written down instead of discarded.

NOT every act has an inverse. Compaction is lossy by design (compact_chat.py's own docstring:
"compaction itself is lossy by design - detail is summarized away") - there is no before-image
that reconstructs discarded context, so every compact mutation is recorded `undoable=False`
with the precise reason. Fabricating an inverse that does not exist would be worse than having
none: a "successful" undo that silently did nothing is the false green this whole repo's rules
exist to forbid.

State lives beside the attempt ledger, the holds file and the delivery ledger in
<repo>/state/mutations.json (override: ORCHESTRATOR_STATE_DIR), same atomic-write-plus-lock
discipline as ledgerlib/deliverylib/holdlib: a unique temp name per writer (a fixed name lets
two concurrent writers interleave bytes into one file and the mangled JSON reads back empty,
wiping the whole ledger - the exact bug ledgerlib's docstring documents finding on 2026-08-31)
then os.replace, under ledgerlib.locked("mutations") for every write.

Undo is a SEPARATE act, not a method here (undo.py, scripts/undo.py): this module only ever
records what happened and marks a row undone once its inverse has actually landed and been
verified - it does not itself drive any actuator. Recording a mutation and undoing one are
different kinds of trust; keeping them in different files keeps that boundary visible.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from lib import ledgerlib

# One kind per act this repo performs on a Desktop chat, plus the two hold-state acts (state
# only, no app UI, but still a mutation someone may want reversed). Deliberately closed, like
# ledgerlib.VALID_KINDS and deliverylib.VALID_STATES: a caller that means a NEW kind of act
# must add it here on purpose, not have a typo silently start a fresh untracked lineage.
MUTATION_KINDS = ("archive", "unarchive", "rename", "migrate", "hold", "release", "compact",
                  "delete", "undelete", "setmode")

# The inverse ACT for each kind, or None when no inverse exists. undo.py is the only reader:
# kept here, beside the kinds it maps, so the two lists cannot drift apart the way a kind list
# duplicated into a second file eventually does.
INVERSE_KIND: dict[str, str | None] = {
    "archive": "unarchive",
    "unarchive": "archive",
    "rename": "rename",       # renaming back is another rename, to the captured old title
    "migrate": "migrate",     # migrating back is another migrate, to the captured source
    "hold": "release",
    "release": "hold",
    "compact": None,          # lossy by design - see the module docstring
    "delete": "undelete",     # delete_chat.py --undo restores from its own trash copy
    "undelete": "delete",     # and deleting again is a fresh delete
    "setmode": None,          # bypassPermissions is the wanted state for every chat, so there
                              # is no act called "put it back on a prompting mode"
}


def _path() -> Path:
    return ledgerlib._state_dir() / "mutations.json"


def _load() -> list[dict]:
    try:
        raw = json.loads(_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    rows = raw.get("mutations", []) if isinstance(raw, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def _save(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"mutations": rows}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def record(
    kind: str,
    session_id: str,
    *,
    instance: str = "",
    title: str = "",
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    undoable: bool = True,
    why_not: str | None = None,
    ledger_attempt_id: str | None = None,
    undoes: str | None = None,
    now_ms: int | None = None,
) -> str:
    """Write down one mutation. Returns its id.

    `before` should be captured by the CALLER immediately before the mutating call, and
    `after` immediately after it - this function only writes what it is handed, it does not
    itself re-read the target. `after=None` means "the act may have landed but the outcome
    could not be confirmed", not "nothing changed" - callers that genuinely changed nothing
    should not call record() at all (see the acting scripts: a refusal before acting records
    nothing here, only in ledgerlib's attempt count).

    `undoable=False` DEMANDS `why_not` - never fabricate a reason, and never default one
    (ValueError forces every caller to say the real one, out loud, at the call site).
    """
    if kind not in MUTATION_KINDS:
        raise ValueError(f"unknown mutation kind {kind!r} - new acts must opt in deliberately")
    if not undoable and not str(why_not or "").strip():
        raise ValueError("undoable=False demands a why_not reason - never record a silent refusal")
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "kind": kind,
        "session": session_id,
        "instance": instance or "",
        "title": title or "",
        "before": before or {},
        "after": after,
        "undoable": bool(undoable) and INVERSE_KIND.get(kind) is not None,
        "whyNot": (why_not or ("no inverse exists for this act" if INVERSE_KIND.get(kind) is None else None)),
        "ledgerAttemptId": ledger_attempt_id,
        "undoes": undoes,
        "at": now_ms,
        "undoneAt": None,
        "undoneBy": None,
    }
    with ledgerlib.locked("mutations"):
        rows = _load()
        rows.append(entry)
        _save(rows)
    return entry["id"]


def list_mutations(session_id: str | None = None, kind: str | None = None) -> list[dict]:
    """Every mutation, newest first."""
    rows = sorted(_load(), key=lambda r: r.get("at", 0), reverse=True)
    if session_id:
        rows = [r for r in rows if r.get("session") == session_id]
    if kind:
        rows = [r for r in rows if r.get("kind") == kind]
    return rows


def get(mutation_id: str) -> dict | None:
    return next((r for r in _load() if r.get("id") == mutation_id), None)


def mark_undone(mutation_id: str, undo_mutation_id: str, now_ms: int | None = None) -> bool:
    """Link a mutation to the mutation that undid it - BOTH directions, in one write:
    `mutation_id` gets `undoneAt`/`undoneBy`, and `undo_mutation_id` (the fresh row the
    underlying acting script recorded on its own verified success - it has no idea it is
    undoing anything) gets `undoes` pointing back. Returns False when `mutation_id` is
    unknown or was already marked undone - a mutation is undone ONCE; undoing THAT undo is a
    fresh mutation of its own, linked the same way, never a second write to this row.

    Silently leaves `undoes` alone if `undo_mutation_id` is not found or already points
    somewhere - a caller mistake there must not corrupt the original's own undone marker."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    with ledgerlib.locked("mutations"):
        rows = _load()
        hit = None
        for r in rows:
            if r.get("id") == mutation_id:
                if r.get("undoneAt"):
                    return False
                r["undoneAt"] = now_ms
                r["undoneBy"] = undo_mutation_id
                hit = r
                break
        if hit is None:
            return False
        for r in rows:
            if r.get("id") == undo_mutation_id and not r.get("undoes"):
                r["undoes"] = mutation_id
                break
        _save(rows)
    return True
