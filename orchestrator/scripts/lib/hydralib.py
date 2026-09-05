"""hydralib - the ONE shared seam between the orchestrator scripts and the AgentHydra daemon.

Deliberately tiny and boring. Every script imports this and little else that is shared, so the
whole point of the one-script-per-functionality layout survives: a change to archive_chat.py
cannot break migrate_chat.py, and a change HERE is understood to touch everything, which is why
this file holds nothing but transport and chat resolution.

No third-party dependencies anywhere in scripts/ - stdlib only, so any Python 3.9+ runs them.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PORT = 7787


def _runtime_pointer_url(env, home: Path | None) -> str:
    """The URL the daemon recorded in <config dir>/runtime.json when it bound its port, or ''.
    The config dir is AGENTHYDRA_HOME when set, else ~/.agenthydra - the same rule the daemon's
    own config.ts applies. A missing or unreadable pointer is simply '' (the caller falls back);
    a stale one from a crashed daemon is caught by the first request failing, as it is for MCP."""
    root = (env.get("AGENTHYDRA_HOME") or "").strip()
    base = Path(root) if root else (home or Path.home()) / ".agenthydra"
    try:
        info = json.loads((base / "runtime.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    url = info.get("url") if isinstance(info, dict) else None
    return str(url).rstrip("/") if isinstance(url, str) and url.startswith("http") else ""


def resolve_base_url(env=None, home: Path | None = None) -> str:
    """Where the daemon is, in the SAME precedence the MCP server uses (server/src/mcp.ts
    daemonBase): an explicit AGENTHYDRA_URL, else an explicit AGENTHYDRA_PORT, else the port
    the daemon ACTUALLY bound (its runtime.json pointer, which follows an auto-hop off a busy
    7787), else the static default.

    Audit AH-04 (2026-09-05): this used to be `AGENTHYDRA_URL or 7787` and nothing else, so a
    daemon that had hopped ports had a toolbox that looked healthy (the menu needs no daemon)
    while every fleet read failed - or, with an older daemon still on 7787, read the wrong one.
    The daemon now also pins AGENTHYDRA_URL into the children it spawns; this is the standalone
    half, for a script run from a shell."""
    env = os.environ if env is None else env
    url = (env.get("AGENTHYDRA_URL") or "").strip()
    if url:
        return url.rstrip("/")
    port = (env.get("AGENTHYDRA_PORT") or "").strip()
    if port.isdigit():
        return f"http://127.0.0.1:{int(port)}"
    pointer = _runtime_pointer_url(env, home)
    if pointer:
        return pointer
    return f"http://127.0.0.1:{DEFAULT_PORT}"


BASE = resolve_base_url()
TIMEOUT_SECS = float(os.environ.get("AGENTHYDRA_TIMEOUT_SECS", "30"))

# THE TEST SEAM, AND WHY THE SUITE NEEDS ONE (measured 2026-09-05). The unit tests' stub daemon
# answered over a real loopback socket, so every call here opened one TCP connection and left it
# in TIME_WAIT for about two minutes. Windows hands out 16,384 ephemeral ports; the 908-test
# orchestrator suite burns thousands of them per run, and beside another socket-heavy suite the
# pool ran dry: `connect` failed, the daemon read as down, and whichever test was mid-call went
# red with nothing on stdout to say why (one fan-out listing test in a full run on a busy machine,
# green in thirty isolated runs). A stub registers an in-process handler under its base URL; a
# request to that BASE is dispatched in-process and opens no socket, so the suite no longer
# depends on the machine's free port pool. Any other BASE takes the real transport, so a test that
# points at a dead port still gets a real connection failure. Production registers nothing here.
INPROC: dict[str, Callable[[str, str, bytes | None], tuple[int, bytes]]] = {}


class DaemonError(RuntimeError):
    """The daemon answered with a failure. A failed read must never print as an empty fleet."""

    def __init__(self, path: str, status: int | None, detail: str):
        super().__init__(f"{path} -> {'HTTP ' + str(status) if status else detail}")
        self.path = path
        self.status = status
        self.detail = detail


class ChatNotFound(LookupError):
    """No chat matches the query. Deterministic: retrying the same query cannot succeed."""

    def __init__(self, query: str):
        super().__init__(f"no chat matches {query!r}")
        self.query = query


class AmbiguousChat(LookupError):
    """More than one chat matches. Deterministic: retrying the same query cannot succeed.

    v2's commonest futile retry was exactly this shape (two sidebar rows sharing a title),
    so it gets its own type: callers stop after ONE attempt and say which chats collided.
    """

    def __init__(self, query: str, matches: list[dict]):
        titles = ", ".join(f"[{m.get('instance')}] {m.get('title')}" for m in matches[:6])
        super().__init__(f"{len(matches)} chats match {query!r}: {titles}")
        self.query = query
        self.matches = matches


def _send(method: str, path: str, data: bytes | None, timeout: float) -> tuple[int, bytes]:
    """(HTTP status, raw body) for one request to BASE - over the wire, or from the in-process
    stub registered for BASE (INPROC above). Only a transport failure raises here; the status is
    the caller's to judge, so both transports feed the same mapping in _request."""
    inproc = INPROC.get(BASE)
    if inproc is not None:
        try:
            return inproc(method, path, data)
        except DaemonError:
            raise
        except Exception as e:  # a stub route that blows up is the daemon hanging up mid-answer
            raise DaemonError(path, None, f"stub route failed: {e!r}") from None
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        method=method,
        headers={"accept": "application/json", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        try:
            detail = e.read()
        except Exception:
            detail = b""
        return e.code, detail
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise DaemonError(path, None, f"{e} - is the daemon running? try: curl {BASE}/api/health") from None


def _request(method: str, path: str, body: dict | None = None, timeout: float | None = None) -> dict | list:
    data = json.dumps(body).encode() if body is not None else None
    status, raw = _send(method, path, data, timeout if timeout else TIMEOUT_SECS)
    if status >= 400:
        raise DaemonError(path, status, raw.decode(errors="replace")[:500])
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise DaemonError(path, None, f"non-JSON response: {raw[:200]!r}") from None


def api_get(path: str) -> dict | list:
    return _request("GET", path)


def api_post(path: str, body: dict | None = None, timeout: float | None = None) -> dict | list:
    """`timeout` overrides TIMEOUT_SECS for endpoints that legitimately run long.

    The default 30s suits a read. It does NOT suit an endpoint that does real UI work and
    then WATCHES for a result - and the message endpoint does exactly that, so the caller
    has to say so (see courier's send, and the 2026-09-01 note there)."""
    return _request("POST", path, body if body is not None else {}, timeout=timeout)


def health() -> dict:
    return api_get("/api/health")  # type: ignore[return-value]


def fleet() -> dict:
    return api_get("/api/fleet")  # type: ignore[return-value]


def sessions() -> list[dict]:
    """Every chat the daemon knows, normalized to a plain list of rows.

    A 200 whose body does not carry the expected shape RAISES rather than returning [] - a
    degraded payload ({"error": ...}, a renamed field) must never print as an empty fleet.
    """
    # ASK FOR THE WEEK, NOT THE LAST DAY (2026-09-01). With no parameters this endpoint
    # answers the previous 24 HOURS, capped at 200 rows - a UI default that is exactly wrong
    # for a census: a chat quiet since yesterday vanished from every lane and was reported as
    # "no readable transcript". Measured the same day: 24h = 23 rows (1 of the 4 known-lost
    # chats present), 7d = 52 (all 4), 30d = 235, all = 324. A week is the horizon a chat can
    # plausibly still be resumed on; 'all' would drag months of dead history into every lane
    # and swamp the judgment queue. Archived rows stay hidden on purpose (every lane filters
    # on `archived`, and the zombie-twin records would flood them).
    got = api_get("/api/sessions?period=7d&limit=500")
    if isinstance(got, list):
        return got
    if isinstance(got, dict) and isinstance(got.get("sessions"), list):
        return got["sessions"]
    raise DaemonError("/api/sessions", None, f"unexpected response shape: {str(got)[:200]!r}")


def dossier(query: str) -> list[dict]:
    """GET /api/chats/dossier?q= - the one query for 'what is the state of chat X'.

    Matches carry: instance, chatId, cliSessionId, priorCliSessionIds, lineageIds, title,
    archived, doneMark, lastActivityAt, live ({pid,name,startedAt,cwd} or null), metaPath.
    An empty matches list is a real answer (no such chat); a response WITHOUT a matches list
    is not, and raises.
    """
    path = f"/api/chats/dossier?q={urllib.parse.quote(query)}"
    got = api_get(path)
    if isinstance(got, dict) and isinstance(got.get("matches"), list):
        return got["matches"]
    raise DaemonError("/api/chats/dossier", None, f"unexpected response shape: {str(got)[:200]!r}")


def resolve_one(query: str) -> dict:
    """Resolve a query (title fragment or session id) to EXACTLY one chat, or refuse.

    Zero or many matches raise typed, deterministic errors - the caller must stop after one
    attempt, never retry, and say which chats collided. That rule is inherited from v2's
    postmortem: the UI tool correctly refuses to disambiguate two rows sharing a title, and
    v2 retried that refusal forever.
    """
    return choose_match(query, dossier(query))


def choose_match(query: str, matches: list[dict]) -> dict:
    """resolve_one's judgment over an ALREADY-FETCHED match list, so a caller that has
    narrowed the dossier's answer itself (migrate_chat --from scopes it to one instance) gets
    exactly the same twin/lineage rules rather than a second copy of them."""
    if not matches:
        raise ChatNotFound(query)
    if len(matches) > 1:
        # A retired twin (an ARCHIVED source copy left behind by a migration) must not make
        # its live successor unreachable: when exactly one match is un-archived, that one IS
        # the chat (found live 2026-08-31: six staged replies bounced because each chat had
        # an archived duplicate record). Two VISIBLE copies remain a refusal - that is real
        # ambiguity, and the zombie-row cleanup owns it, never a guess here.
        alive = [m for m in matches if not m.get("archived")]
        if len(alive) == 1:
            return alive[0]
        # ONE LINEAGE, MANY RECORDS is the zombie-twin shape (a running app resurrects the
        # archived source row after every migrate/reimport), not ambiguity: every record IS
        # the same chat, so the newest one - current title, current metaPath - answers for
        # it (bit live 2026-09-01: the overlord's own wake bounced off its twin). TWO
        # DIFFERENT chats (distinct cliSessionIds) stay a refusal.
        ids = {m.get("cliSessionId") for m in (alive or matches)}
        if len(ids) == 1:
            pool = alive or matches
            return max(pool, key=lambda m: str(m.get("lastActivityAt") or ""))
        raise AmbiguousChat(query, matches)
    return matches[0]


def resolve_instance(fleet_data: dict, wanted: str) -> dict | None:
    """Match a --to/instance argument against num, name, or dir - exact, case-insensitive.

    Lives HERE, not in an act script: open_instance, quit_instance, sweep and balance all
    need it, and importing it from migrate_chat made those four scripts share migrate's fate
    on any change (review finding: the one-script-per-functionality property was quietly
    false for those edges). Shared judgment belongs in a lib; actions stay individual.
    """
    w = str(wanted).strip().lower().lstrip("#")
    for i in fleet_data.get("instances", []):
        if str(i.get("num")) == w:
            return i
        if str(i.get("name", "")).lower() == w:
            return i
        if str(i.get("dir", "")).lower() == w:
            return i
    # A person names an account by its LABEL ("Anuthuyr") or its EMAIL far more often than
    # by its folder; both are on the fleet row, so accept them - exact and unambiguous, like
    # the daemon's own resolver. Tried after the folder spellings so nothing above changes.
    hits = [i for i in fleet_data.get("instances", [])
            if str(i.get("label") or "").lower() == w
            or str((i.get("account") or {}).get("email") or "").lower() == w]
    return hits[0] if len(hits) == 1 else None


def instances_by_name() -> dict[str, dict]:
    """The fleet keyed by LOWERCASE instance name - the one account-attribution map.

    Was built twice (dashboard._instances_by_name, chats._accounts_by_instance) with slightly
    different fields until the 2026-08-31 standardization pass; this is the superset both
    needed. NOTE: fleet rows carry NO usage - weeklyPct here is whatever the row happens to
    say (usually absent); real usage comes from usage_survey() only.
    """
    out: dict[str, dict] = {}
    for i in fleet().get("instances", []):
        name = str(i.get("name") or "")
        acct = i.get("account") or {}
        out[name.lower()] = {
            "num": i.get("num"),
            "name": name,
            "dir": i.get("dir"),
            "isRunning": bool(i.get("isRunning")),
            "signedIn": bool(i.get("signedIn")),
            "email": acct.get("email"),
            "plan": acct.get("planLabel"),
            "weeklyPct": (i.get("usage") or {}).get("weeklyPct"),
        }
    return out


def session_row(session_id: str) -> dict | None:
    """The row for one cli session id, or None.

    ⛔ PER-ID FIRST, THE LIST SECOND (2026-09-01). This used to scan `sessions()`, which is
    GET /api/sessions with no parameters - and that endpoint defaults to a 24-HOUR window,
    hides archived rows, and caps at 200. So any chat quiet for more than a day was simply
    not in the answer, this returned None, every caller read `.get("transcript_path")` off
    an empty dict, and the gate reported "cannot be gated (no readable transcript)". Four
    real chats - 2 MB, 11 MB, 295 KB and 386 KB of transcript sitting on disk - were skipped
    by every lane for that reason. The daemon was never wrong; the question was. The per-id
    route (GET /api/sessions/:id) is not windowed and carries the same row shape, so it is
    asked first; the list scan remains only as the fallback for a daemon without it."""
    if session_id:
        try:
            got = api_get(f"/api/sessions/{urllib.parse.quote(session_id)}")
            if isinstance(got, dict) and got.get("session_id") == session_id:
                return got
        except DaemonError as err:
            if err.status not in (404,):
                raise
    for row in sessions():
        if row.get("session_id") == session_id:
            return row
    return None


def usage_survey(max_age_secs: int | None = None) -> dict:
    """GET /api/usage/survey - every login's usage in ONE call (the daemon's own whole-fleet
    sweep). Rows carry {kind, num, id, label, result:{snapshot:{account, session(=5-hour),
    weekAll, weekModel, capturedAt}, reason}, advice:{severity, bindingPct, shouldOffload,
    safeToFanOut, advice}}. Slow-ish (the daemon may re-check accounts) - seconds, not ms.

    ⚠ THIS is where usage lives. /api/fleet instance rows carry NO usage field at all - an
    early cut of the census read i.usage.weeklyPct off fleet rows and printed '-' forever.

    Its own timeout is LONG on purpose: a warm survey answers in ~20 s, a cold one (fresh
    daemon, accounts needing re-checks) can blow past the default 30 s cap - which rendered
    as 'usage read failed' on the owner's dashboard (2026-08-31).

    SHARED ACROSS PROCESSES for one tick (live smoke, 2026-09-01): the survey measured ~80 s
    on this fleet, and sweep, saturate, groundskeeper, the overlord and balance each paid it
    separately every 5 minutes - the single slowest leg of every planning lane. A copy
    younger than `max_age_secs` (default SURVEY_CACHE_SECS) is served from
    state/usage-survey.json instead, stamped "cachedAgeSecs" so a caller can label it.
    Pass max_age_secs=0 for a fresh call. A cache read that fails in any way falls through to
    the live call - the cache can only ever make this faster, never wronger.
    """
    if max_age_secs is None:
        max_age_secs = SURVEY_CACHE_SECS
    path = _survey_cache_path()
    if max_age_secs:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            age = time.time() - float(raw.get("at", 0))
            survey = raw.get("survey")
            if 0 <= age <= max_age_secs and isinstance(survey, dict) \
                    and isinstance(survey.get("rows"), list):
                survey["cachedAgeSecs"] = int(age)
                return survey
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    got = _request("GET", "/api/usage/survey", timeout=240)
    if isinstance(got, dict) and isinstance(got.get("rows"), list):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps({"at": time.time(), "survey": got}), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            pass  # a cache that cannot be written is just a slower next tick
        return got
    raise DaemonError("/api/usage/survey", None, f"unexpected response shape: {str(got)[:200]!r}")


# One tick's worth: the lanes fire every 5 minutes, so a survey under 4 minutes old is the
# same measurement the previous lane just took - re-taking it costs ~80 s and changes nothing.
SURVEY_CACHE_SECS = 240


def _survey_cache_path() -> Path:
    from lib import ledgerlib  # the one state-dir rule (ORCHESTRATOR_STATE_DIR) lives there

    return ledgerlib._state_dir() / "usage-survey.json"


def usage_cache() -> dict:
    """GET /api/usage/cache - the daemon's cached usage snapshots, instant, checks nothing.
    Keys look like 'desktop:<dir>' / 'cli:<uuid>' / 'codex:<name>'. A row can be STALE
    (capturedAt says when) and a missing key means never measured - never 'plenty left'."""
    got = api_get("/api/usage/cache")
    if isinstance(got, dict) and isinstance(got.get("cache"), dict):
        return got
    raise DaemonError("/api/usage/cache", None, f"unexpected response shape: {str(got)[:200]!r}")


# THE MACHINE-WIDE CONCURRENCY CAP (owner, 2026-08-31: "for the sake of not murdering my
# computer... a total of say 18 chats across the entire computer running at one time. If we
# hit that limit we just pause and come back - cycling round robin"). Anything that WAKES a
# chat (a delivery, a native revive, a compact turn) checks running_count() first; a
# deferred wake stays staged and the 5-minute cycle retries it - that IS the round robin.
MAX_RUNNING_CHATS = 18


def _live_endpoint() -> dict | None:
    """Raw GET /api/sessions/live, shape-checked: {count: int, sessions: list}.

    The validated lookup shared by running_count() and running_by_instance() (extracted
    2026-09-01: running_by_instance() used to call the raw endpoint directly with none of this
    checking, so a malformed 200 would have silently answered with no live sessions at all -
    the exact 'unknown reads as room under the cap' failure this file forbids everywhere else).
    Returns None on a 404 (older daemon: caller falls back to _live_ids_via_walk()). Any other
    failure, or a 200 missing either field, RAISES - unknown must never read as empty."""
    try:
        got = api_get("/api/sessions/live")
        if isinstance(got, dict) and isinstance(got.get("count"), int) and isinstance(got.get("sessions"), list):
            return got
        raise DaemonError("/api/sessions/live", None,
                          f"unexpected response shape: {str(got)[:200]!r}")
    except DaemonError as err:
        if err.status != 404:
            raise
    return None


def _live_ids_via_walk() -> set[str]:
    """Fallback for a daemon without /api/sessions/live: one dossier lookup per chat."""
    ids: set[str] = set()
    for row in sessions():
        if row.get("archived"):
            continue
        sid = row.get("session_id") or ""
        if sid and live_for(sid) is not None:
            ids.add(sid)
    return ids


def running_count() -> int:
    """How many chats hold a LIVE engine process right now, fleet-wide.

    Endpoint-first: GET /api/sessions/live (added to the daemon 2026-08-31 on the owner's
    word) reads the same pid-checked registry the dossier's `live` field answers from, so
    the two can never disagree - one call instead of one dossier walk per chat. A 404
    means an older daemon: fall back to the walk. Any other failure RAISES - an unknown
    count must never read as room under the cap."""
    got = _live_endpoint()
    if got is not None:
        return got["count"]
    return len(_live_ids_via_walk())


def console_session_ids() -> set[str]:
    """Session ids the CONSOLE fleet can PROVE are its own - positive evidence only.

    Two proofs, either suffices: the session's transcript lives under a console account's
    config dir (a directory under the cli-instances root, never the regular ~/.claude which
    the desktop app also writes into), or its live registry record says the CLI started it
    (`entrypoint` other than the desktop app's). A dormant transcript under ~/.claude with no
    other evidence is NOT claimed - the daemon imports console sessions into desktop stores on
    its own, so ambiguity resolves to the desktop side, which is where such a chat ends up.
    """
    from lib import peerlib

    root = Path(os.environ.get("ORCH_CLI_ACCOUNTS")
                or (Path.home() / ".agenthydra" / "cli-instances"))
    ids: set[str] = set()
    dirs = [Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))]
    if root.exists():
        dirs += [d for d in root.iterdir() if d.is_dir()]
    for d in dirs:
        # proof 1: anything under a dedicated console account dir is console-born
        if d != dirs[0]:
            proj = d / "projects"
            if proj.exists():
                ids.update(p.stem for p in proj.glob("*/*.jsonl"))
        # proof 2: the registry names the entrypoint
        try:
            for rec in peerlib.live_sessions(d, check_alive=False):
                ep = str(rec.get("entrypoint") or "")
                if ep and not ep.startswith("claude-desktop") and rec.get("sessionId"):
                    ids.add(str(rec["sessionId"]))
        except OSError:
            continue
    return ids


def visible_chats() -> list[dict]:
    """EVERY chat the owner can see in a sidebar - not just the ones the daemon indexes.

    ⛔ THE BLIND SPOT THIS CLOSES (owner, 2026-09-01: "why are there so many that haven't been
    touched in hours - open - like sweep ones which haven't been in days"). Every lane iterated
    /api/sessions, which indexes CLI sessions and on a real fleet listed 17 chats while the
    desktop stores held 30 UNARCHIVED ones. The other 13 - including sweep reports two and
    three days old - were invisible to saturate, to the groundskeeper and to the courier alike,
    so nothing woke them, nothing archived them, and they simply sat there. They were not being
    ignored on purpose; they were never in the list.

    So: the daemon's rows FIRST (they carry its own metadata), then every un-archived desktop
    meta record it did not mention, with its transcript resolved from disk. Same shape either
    way - session_id / title / instance / transcript_path / archived - so callers need no
    special case. `source` says which half a row came from, for honest reporting.
    """
    from lib import stamplib

    daemon_rows = sessions()
    try:
        fleet_data = fleet()
    except DaemonError:
        return [{**r, "source": "daemon", "fleet": "desktop"} for r in daemon_rows]

    # ⛔ THE DESKTOP LANES OWN DESKTOP CHATS ONLY. The daemon's index is a CLI-session index,
    # so once a console fleet exists it also lists console-born sessions - which have no
    # sidebar row anywhere and can never be composer-delivered to. Left in, saturate spent
    # its breaker on a console probe (measured 2026-09-01).
    #
    # POSITIVE EVIDENCE ONLY. "No desktop meta record" was the first test, and it was wrong
    # twice over: the daemon imports console sessions into a desktop store on its own (the
    # probe grew a meta within minutes), and on any machine with the regular app's store
    # present but a fixture fleet, every session looked console-born and the desktop lanes
    # went blind. A session is console-born when the CONSOLE FLEET can prove it: its
    # transcript lives under a console account's config dir, or its live registry record
    # says it was started by the CLI rather than by the desktop app. Anything else stays here.
    console_ids = console_session_ids()
    rows: list[dict] = []
    seen: set[str] = set()
    for r in daemon_rows:
        sid = r.get("session_id") or ""
        if sid and sid in console_ids:
            continue  # console-owned: the console lanes' business
        if sid:
            seen.add(sid)
        rows.append({**r, "source": "daemon", "fleet": "desktop"})

    tpath = stamplib.transcript_index(fleet_data)
    extra: dict[str, dict] = {}
    for store in stamplib.store_roots(fleet_data):
        for path, meta in stamplib.iter_metas(store["root"]):
            if meta.get("isArchived"):
                continue
            sid = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            if not sid or sid in seen:
                continue
            row = extra.setdefault(sid, {
                "session_id": sid, "title": meta.get("title") or "",
                "instance": store["instance"], "archived": False,
                "transcript_path": str(tpath[sid]) if sid in tpath else "",
                "source": "desktop-store", "fleet": "desktop",
            })
            if meta.get("title") and not row["title"]:
                row["title"] = meta["title"]
    rows.extend(extra.values())
    return rows


def same_task_chats(prompt: str, exclude: set[str] | None = None) -> list[dict]:
    """Every VISIBLE chat whose own first prompt is this task - the double-check every
    spawner runs before starting one (owner, 2026-09-01: two identical 'SageThumbs codebase
    review' chats, 30 minutes apart, both running - "it can't do it blind; it must always
    double check, confirm"). Rows: session_id, title, instance, live, startedAt."""
    from lib import gatelib

    if not str(prompt or "").strip():
        return []
    try:
        live = {s.get("sessionId") for s in api_get("/api/sessions/live").get("sessions", [])}
    except DaemonError:
        live = set()
    out: list[dict] = []
    for row in visible_chats():
        sid = row.get("session_id") or ""
        if not sid or row.get("archived") or (exclude and sid in exclude):
            continue
        tp = row.get("transcript_path") or ""
        if not tp:
            continue
        first = gatelib.first_user_prompt(tp)
        if first and gatelib.same_task(first, prompt):
            out.append({"session_id": sid, "title": row.get("title"),
                        "instance": row.get("instance"), "live": sid in live,
                        "firstPrompt": first[:160]})
    return out


def running_by_instance() -> tuple[set[str], dict[str, int]]:
    """(live session ids, {instance name -> how many of its chats are running}).

    The spread rule needs a per-ACCOUNT count, not just a fleet total: 11 running is healthy
    when it is 2-3 apiece and is a hog when six sit on one account (measured 2026-09-01, and
    that account then hit 100% on its 5-hour window). Lives here because saturate, the
    courier and the groundskeeper all ask the same question, and two copies of it would drift.

    Shares running_count()'s _live_endpoint() lookup rather than the raw endpoint call, so this
    degrades on an older daemon (404 fallback via _live_ids_via_walk()) and never silently reads
    a malformed 200 as "nothing running" instead.
    """
    got = _live_endpoint()
    if got is not None:
        live = {s.get("sessionId") for s in got["sessions"] if s.get("sessionId")}
    else:
        live = _live_ids_via_walk()
    per: dict[str, int] = {}
    # visible_chats, not sessions(): the daemon's index misses chats that are nonetheless in a
    # sidebar and running, so the per-account totals used to sum to well under the live count
    # (21 running reported as 12 spread across accounts) - and a balancer reading those numbers
    # is balancing a fiction.
    for row in visible_chats():
        if row.get("session_id") in live and row.get("instance"):
            per[row["instance"]] = per.get(row["instance"], 0) + 1
    return live, per


def live_for(session_id: str, matches: list[dict] | None = None) -> dict | None:
    """The live-process block for one chat, resolved the safe way.

    Identity can rotate (compaction rolls the cli session id), so a match counts through ANY
    of its identity fields; and when the single resolved match names none of them, it is still
    THE match for the query - trust its liveness over an assumption of 'no writer'. Raises
    DaemonError when the dossier read fails: liveness unknown must never read as 'not live'.
    """
    if matches is None:
        matches = dossier(session_id)
    for m in matches:
        if (
            m.get("cliSessionId") == session_id
            or session_id in (m.get("lineageIds") or [])
            or session_id in (m.get("priorCliSessionIds") or [])
        ):
            return m.get("live")
    if len(matches) == 1:
        return matches[0].get("live")
    return None
