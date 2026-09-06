"""actionlib - THE ACTION CATALOG: one entry per script under orchestrator/scripts/*.py, so
"is this observe or mutate, direct or unattended" stops living in each script's own docstring
prose (AH-25).

WHY THIS EXISTS. Before this file, three places separately claimed to answer "what can the
fleet do and how is it gated", and they already disagreed in code even though nothing forced
them to admit it on paper:

  - orch.py's menu inferred kind from the FIRST LINE of a docstring - "act" if the summary
    happened to start with the word "act", "observe" if it started with "observe", "other"
    otherwise. Fragile enough that migrate_batch.py, interview.py, run_locked.py and smoke.py
    were silently dropped into a leftover "other" bucket because their first line did not
    open with the exact word the parser wanted (verified live, 2026-09-05: smoke.py is a
    READ-ONLY smoke test and still landed in "other").
  - server/src/orchestrator.ts's header and mcp.ts's tool descriptions separately assert
    "every action is icon-gated".
  - lib/armlib.py's docstring separately explains the one documented escape hatch (a
    person's own --force) without naming which scripts actually reach it.

None of the three could be caught disagreeing with EACH OTHER on paper. They already
disagreed with the CODE: migrate_chat.py (and everything else CATALOG below marks
invocation="direct") never asks the tray icon anything at all - it is not "gated, with an
exception", it never imports lib/armlib in the first place. That is armlib's own documented
exception (armlib.py's module docstring, "the switch bounds the UNATTENDED path"), and this
catalog's `invocation` field is derived from the same real fact - which scripts call
armlib.refuse_unless_armed - never from a second, hand-maintained copy of that list. See
lib/armlib.GATED_SCRIPTS, and tests/test_actionlib.py, which asserts CATALOG agrees with it
by importing armlib, not by re-typing armlib's set.

THIS FILE IS NOW THE ONE SOURCE for classification. orch.py's menu and its `--catalog` JSON
dump both read CATALOG below; nothing parses a docstring's first line to decide kind or
invocation any more (the `summary` field is still pulled from each docstring's headline for
display, because that part was never the problem - the CLASSIFICATION was).

FIELDS, per entry:
  kind          "observe" (touches nothing) | "mutate" (can change something)
  invocation    "direct"     - a person's explicit request, allowed with no armed-window
                              check at all (the script never calls armlib) - migrate_chat.py's
                              documented exception, extended to every other script that is
                              likewise never reached from lib/armlib.GATED_SCRIPTS
                "unattended" - reached only from the generated scheduled wrapper, whose OWN
                              gate sits outside this process (run_locked.py: the enclosing
                              .cmd's ARM_GUARD text, not an in-process armlib call)
                "both"       - calls armlib.refuse_unless_armed itself, so the scheduled tick
                              goes through the gate and a person's own --force is the
                              documented bypass for that one run (lib/armlib.GATED_SCRIPTS)
  platforms     "windows-only" | "any" - windows-only means THIS script itself owns an
                              ACTUATOR .ps1 path and drives UI Automation directly, or (one
                              case: schedule_jobs.py) documents a non-Windows exit code of its
                              own. A script that only calls INTO a windows-only script (sweep,
                              groundskeeper, saturate, drill, fan_out, interview, undo,
                              migrate_batch, chats, audit_archived, reconcile, overlord) is
                              left "any" here with a `notes` flag rather than guessed, because
                              the transitive case is genuinely ambiguous: is a dispatcher
                              "windows-only" because of what it calls, or only its target is?
  guards        tuple of: hold, breaker, live-writer, armed-window, confirm-title, force -
                              only the guards that bound THIS script's OWN act; an observe
                              script that merely displays another lane's hold/breaker state
                              for a person to read does not list it.
  result        the exit-code contract, paraphrased from the script's own "Exit:" docstring
                              line (paraphrased, not copied verbatim, so a long line still
                              fits one entry - the exact wording lives in the script itself).
  availability  "available" | "disabled" (requires `reason` when disabled)
  summary       the one-line description orch.py's menu prints, pulled from the docstring's
                              headline (cosmetic only - not used for classification).
  notes         present only where a docstring left something genuinely ambiguous; never used
                              to dress up a guess as a fact (AH-25's own instruction).

NOTE ON `availability`: the two actions actually disabled by policy - add_queue_item and
launch_terminal_session - are MCP/TypeScript tool wrappers (server/src/mcp.ts), refused by
server/src/headless-policy.ts's headlessRunsAllowed(), which is hardcoded False with no
setting to flip (see NO_HEADLESS_REASON there). Neither is a Python script under
orchestrator/scripts/*.py, so neither gets a CATALOG entry here - every entry below is
"available". The field stays in the schema, and test_actionlib.py still requires a `reason`
on any future entry that sets availability="disabled", so a genuinely policy-disabled Python
script has somewhere honest to say so instead of the daemon inventing a second way to.
"""

from __future__ import annotations

KINDS = ("observe", "mutate")
INVOCATIONS = ("direct", "unattended", "both")
PLATFORMS = ("windows-only", "any")
GUARDS = ("hold", "breaker", "live-writer", "armed-window", "confirm-title", "force")
AVAILABILITIES = ("available", "disabled")

# The driver words (orch.py's own switch group) are not scripts and never belong in CATALOG -
# see tests/test_actionlib.py::test_driver_words_are_not_catalog_entries.
DRIVER_WORDS = frozenset({"arm", "disarm", "armed", "resume", "pause", "loop"})


CATALOG: dict[str, dict] = {
    "archive_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "live-writer", "force"),
        "result": "0 changed and verified (or nothing to do) - 2 refused by gate or by movement since deciding - 3 deterministic refusal (no match/ambiguous/no id) - 4 live writer - 5 breaker - 6 held - 7 disk-flag write pending under a running app",
        "availability": "available",
        "summary": "ACT: archive (or unarchive) ONE chat, with every rule the rewrite inherits.",
    },
    "attempts": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 ok - 3 bad usage",
        "availability": "available",
        "summary": "OBSERVE the attempt ledger; clear an entry only on a person's say-so.",
    },
    "audit_archived": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 nothing needs restoring, or --restore restored everything it could - 2 wrongly-archived chats found, or some restorations did not land - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE (and, on --restore, ACT): were recently-archived chats really done?",
        "notes": "the --restore branch drives archive_chat.py, a windows-only actuator owner with its own hold/breaker/live-writer guards; marked platform=any because THIS script owns no actuator itself - flagged rather than guessed.",
    },
    "audit_done_bar": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 nothing below the bar - 2 chats found below it - 1 fleet read failed",
        "availability": "available",
        "summary": "OBSERVE ONLY: which ARCHIVED chats never met the done-bar?",
    },
    "audit_twins": {
        "kind": "observe",
        "invocation": "both",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "armed-window", "force"),
        "result": "0 no twins, or all settled - 2 twins found and not fixed - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE (+`--fix`): is any chat VISIBLE in two places at once?",
        "notes": "docstring calls a held+twinned chat 'unactionable by every actuator' as a consequence, not a stated pre-check by this script; hold is kept in guards on the strength of --fix sharing archive_chat's rails, but flagged since the language describes an effect, not a check.",
    },
    "automation_chat": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "armed-window", "force"),
        "result": "0 both stamps verified, or --all found/stamped everything it tried - 2 partially stamped or --all had failures - 3 deterministic refusal - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: enforce the AUTOMATION DOCTRINE on ONE existing chat.",
    },
    "balance": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 plan produced - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE/PLAN ONLY: account load balancing, as a plan a person can read.",
    },
    "census": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 census plausible - 2 sanity rail tripped - 1 the read itself failed",
        "availability": "available",
        "summary": "OBSERVE ONLY: what does the fleet look like right now?",
    },
    "chats": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer"),
        "result": "0 listed, or every attempted move landed cleanly - 2 some moves were refused/did not land - 3 bad usage/unknown target - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE (+`--move-to`): every chat, which ACCOUNT it lives in, and move them.",
        "notes": "the --move-to branch runs migrate_chat.py's own rails (its hold/breaker/live-writer guards, deliberately no --force here); the plain listing has none of them.",
    },
    "chatwatch": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 always for a read or a clean snapshot - 1 the chat store could not be read at all",
        "availability": "available",
        "summary": "OBSERVE: journal every change to every desktop chat, and say WHO did it.",
    },
    "chips": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "armed-window", "force"),
        "result": "0 nothing to do, or every start confirmed - 2 a start did not confirm - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: start the desktop's SUGGESTED-TASK chips, locally, never blind.",
    },
    "cli_accounts": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 fine - 2 some accounts are not logged in yet (each named) - 1 read failure",
        "availability": "available",
        "summary": "OBSERVE (+`--create`): the accounts the CONSOLE fleet can run on.",
    },
    "cli_saturate": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "any",
        "guards": ("hold", "breaker", "armed-window", "force"),
        "result": "0 already full or every wake started - 2 some did not start - 1 read failure",
        "availability": "available",
        "summary": "ACT: keep the CONSOLE fleet full, spread evenly across EVERY account.",
    },
    "cli_send": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "force"),
        "result": "0 delivered and the chat moved - 2 sent but not confirmed - 3 refused (held/not running/no token) - 1 failure",
        "availability": "available",
        "summary": "ACT: deliver a message into a running CONSOLE chat, natively.",
    },
    "cli_sessions": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 always - this observes",
        "availability": "available",
        "summary": "OBSERVE ONLY: every CONSOLE chat, what state it is in, on which account.",
    },
    "cli_spawn": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "force"),
        "result": "0 started - 2 no usable account/over target/held - 3 bad usage - 1 launch failure",
        "availability": "available",
        "summary": "ACT: start a CONSOLE chat, visible, on a chosen account.",
    },
    "compact_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "breaker"),
        "result": "0 compacted and verified, or honestly not needed - 2 turn ran but no compaction observed - 3 deterministic refusal - 4 possibly mid-work (transient) - 5 breaker - 6 held",
        "availability": "available",
        "summary": "ACT: COMPACT one console/CLI chat's context instead of abandoning it.",
    },
    "courier": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "armed-window", "force"),
        "result": "0 everything attempted delivered and confirmed, or nothing to do - 2 something skipped or did not land - 1 daemon failure before acting",
        "availability": "available",
        "summary": "ACT: deliver staged replies into their chats, through the app's own composer.",
    },
    "dashboard": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "runs until Ctrl+C; --open launches the default browser at the page",
        "availability": "available",
        "summary": "OBSERVE ONLY: the decision dashboard, in a browser.",
    },
    "delete_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "live-writer", "force"),
        "result": "0 deleted and verified, or nothing to sweep - 2 partial - 3 refused (not found/ambiguous/held/live writer/bad usage) - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: DELETE one chat everywhere it exists - the app's store and the transcript - with an undo copy.",
    },
    "dossier": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 exactly one match - 3 none or many (deterministic) - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE ONLY: everything the daemon knows about ONE chat.",
    },
    "drill": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("live-writer", "force"),
        "result": "0 round-trip complete, fleet as found - 2 subject refused (unsuitable) - 1 a step failed",
        "availability": "available",
        "summary": "ACT (reversible): prove the act chain against the REAL daemon, and leave the",
        "notes": "the --rename branch drives the daemon's UIA actuator directly per its own docstring, and the default archive branch runs archive_chat.py's main(), inheriting its hold/breaker guards; marked platform=any because drill.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "fan_out": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "breaker", "force"),
        "result": "0 every task spawned/status read/sends delivered/members deleted, each verified - 4 partial - 2 nothing spawned at all",
        "availability": "available",
        "summary": "ACT: DISSEMINATE a task list into N desktop chats, one account each, and manage them as a group.",
        "notes": "spawns through spawn_chat.py and deletes through delete_chat.py, both windows-only actuator owners; marked platform=any because fan_out.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "gate_chat": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 gated - 3 chat not resolvable/no transcript (deterministic) - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE ONLY: gate ONE chat and print the verdict with its evidence.",
    },
    "groundskeeper": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer", "armed-window", "force"),
        "result": "0 nothing to do or everything landed - 2 something did not land (each named) - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: the two things nobody was doing to a dormant chat.",
        "notes": "its duties dispatch through migrate_chat.py and archive_chat.py, both windows-only actuator owners; marked platform=any because groundskeeper.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "harvest_todos": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "any",
        "guards": ("armed-window", "force"),
        "result": "0 wrote, or nothing to write - 1 fleet read failed, or a write failed",
        "availability": "available",
        "summary": "ACT: rescue the work left inside ARCHIVED chats into to-do markdown.",
    },
    "hold_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("breaker", "force"),
        "result": "0 done - 3 not resolvable (deterministic) or bad usage - 1 daemon failure",
        "availability": "available",
        "summary": "ACT (state only): mark a chat hands-off for the unattended machinery.",
    },
    "incidents": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 ok - 3 bad usage or unknown incident id",
        "availability": "available",
        "summary": "OBSERVE (+ --ack/--resolve) the incident ledger: grouped, deduplicated failures.",
    },
    "interview": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "force"),
        "result": "0 asked/applied cleanly - 2 some answers did not apply (each named) - 3 bad usage/malformed answers - 1 daemon failure",
        "availability": "available",
        "summary": "THE CALLOUT PROTOCOL: the orchestrator asks, an AI answers, code executes.",
        "notes": "--apply executes decisions through courier.py/unblock_prompts.py/stage_reply.py's own rails (courier and unblock_prompts are armed-window gated); marked platform=any because interview.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "list_instances": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 ok - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE ONLY: every instance, open or not, with account and usage.",
    },
    "migrate_batch": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer", "force"),
        "result": "0 every named chat landed, or under --dry-run every plan resolved - 2 the flags do not make sense - 4 nothing landed - 5 a PARTIAL batch (deliberately distinct from total success/failure)",
        "availability": "available",
        "summary": "move MANY chats between accounts in ONE run, sequentially, sharing every read.",
        "notes": "runs migrate_chat.py's own pipeline per chat inside one interpreter, inheriting its hold/breaker/live-writer guards and its windows-only actuator fallback path; marked platform=any because migrate_batch.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "migrate_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "live-writer", "force"),
        "result": "0 landed and verified - 3 deterministic refusal (not resolvable/superseded/repeatable 400) - 4 live writer - 5 breaker - 6 held - 7 archived (--archived includes it) - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: land ONE chat in a desktop instance (the account-migration move).",
    },
    "mutations": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 ok - 3 bad usage (unknown --kind, or --get with a bad/missing id)",
        "availability": "available",
        "summary": "OBSERVE the mutation ledger: every before/after record of an act this",
    },
    "name_chats": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": ("breaker",),
        "result": "0 nothing nameless, or every reachable one named - 2 some rows unreachable/flaked/left quarantined - 1 daemon/actuator failure",
        "availability": "available",
        "summary": "ACT: THE NAMING PASS - give every no-name chat in an instance a real name.",
        "notes": "docstring does not say whether a held chat is skipped by the naming pass; kept guards=(breaker,) rather than guessing hold applies.",
    },
    "open_instance": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 running (opened now or already) - 3 no such instance (deterministic) - 1 failure",
        "availability": "available",
        "summary": "ACT: start ONE desktop instance (idempotent - 'already running' is fine).",
    },
    "overlord": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer", "armed-window", "force"),
        "result": "0 nudged-and-confirmed, or honestly nothing to do - 2 no overlord chat exists - 5 breaker - 6 held - 1 daemon failure or nudge did not confirm",
        "availability": "available",
        "summary": "ACT: THE OVERLORD WATCHDOG - keep the standing /orchestrate chat alive.",
        "notes": "its nudge/handoff path can deliver through courier.py's actuator; marked platform=any because overlord.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "quit_instance": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("live-writer", "confirm-title", "force"),
        "result": "0 quit - 2 refused (live writers) - 3 no such instance (deterministic) - 1 failure",
        "availability": "available",
        "summary": "ACT: stop ONE desktop instance.",
    },
    "reconcile": {
        "kind": "observe",
        "invocation": "both",
        "platforms": "any",
        "guards": ("breaker", "live-writer", "armed-window", "force"),
        "result": "0 everything settled - 2 archives need settling, or a retry did not land - 1 daemon failure",
        "availability": "available",
        "summary": "OBSERVE (+`--retry`): did every past archive attempt actually settle?",
        "notes": "the --retry branch re-runs archive_chat.py, a windows-only actuator owner; the base read does not; marked platform=any because reconcile.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "remote": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 ok/already serving - 1 the gateway did not come up - 2 bun or the built web app is missing - 3 nothing to stop",
        "availability": "available",
        "summary": "act (machine config): THE REMOTE FRONT-END - start, stop or report the gateway",
    },
    "remote_tunnel": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 ok - 1 a Cloudflare call failed - 2 no API token in the environment - 3 bad arguments - 4 nothing configured yet",
        "availability": "available",
        "summary": "act (machine config): THE PERMANENT ADDRESS - provision, inspect or",
    },
    "rename_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "force"),
        "result": "0 renamed and verified - 3 not resolvable/not held by any instance (deterministic) - 5 breaker - 6 held - 1 daemon failure or verify failed",
        "availability": "available",
        "summary": "ACT: rename ONE chat through the running app's own Rename control.",
    },
    "run_locked": {
        "kind": "mutate",
        "invocation": "unattended",
        "platforms": "any",
        "guards": (),
        "result": "the work's own exit code, or 0 if this tick was skipped because the lock is already held - 3 bad usage",
        "availability": "available",
        "summary": "AH-16: run one scheduled lane's work under its proof-of-death job lock.",
        "notes": "invoked only by schedule_jobs.py's generated .cmd wrapper (Windows batch/VBScript), so it is windows-only in practice even though its own source drives no actuator; the armed-window check for a scheduled tick happens one layer up in the wrapper's ARM_GUARD, not via lib/armlib in-process, which is why it is not in armlib.GATED_SCRIPTS. New file (AH-16, appeared mid-session) - re-check this entry once that work lands.",
    },
    "saturate": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer", "armed-window", "force"),
        "result": "0 already full, or every wake landed - 2 some wakes did not land (each named) - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: keep the machine FULL. 18 is a FLOOR, not just a ceiling.",
        "notes": "wakes dormant chats through the composer delivery path (courier.py's actuator); marked platform=any because saturate.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "schedule_jobs": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": (),
        "result": "0 ok - 2 a task did not register/remove/change cleanly - 3 bad usage - 1 not Windows",
        "availability": "available",
        "summary": "ACT (machine config): run the orchestrator's recurring jobs on a timer.",
        "notes": "windows-only per its own documented exit contract ('1 not Windows'), not because it owns a UI-automation actuator - it drives Windows Task Scheduler/VBScript shims instead. A different windows-only mechanism than the actuator rule; flagged for a human to confirm the field still fits.",
    },
    "smoke": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 every check passed - 1 any check failed (each failure named, loudly)",
        "availability": "available",
        "summary": "READ-ONLY smoke test against the LIVE daemon: proves the whole observe chain.",
    },
    "spawn_chat": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "windows-only",
        "guards": ("breaker", "force"),
        "result": "0 spawned and its first turn confirmed - 4 spawned but first turn not confirmed - 5 refused (a visible chat already carries this task; --force insists) - 2 instance not open/resolvable/busy - 3 bad usage",
        "availability": "available",
        "summary": "ACT: start a NEW desktop chat in a folder, with its first prompt.",
    },
    "stage_reply": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 staged/listed/cancelled - 3 not resolvable or bad usage - 1 daemon failure",
        "availability": "available",
        "summary": "ACT (state only): write down a reply for one chat. SENDS NOTHING.",
    },
    "sweep": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer", "armed-window", "force"),
        "result": "0 all attempted acts verified, or nothing to do - 2 some acts refused/failed (each named with its own exit code) - 1 daemon failure before acting",
        "availability": "available",
        "summary": "ACT (batch, one invocation): execute the predetermined plan in ONE command.",
        "notes": "batches the archive/migrate/name-chats lanes, each a windows-only actuator owner; marked platform=any because sweep.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "trust_workspace": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 nothing to do or applied cleanly - 2 some writes failed - 3 bad usage",
        "availability": "available",
        "summary": "ACT (machine config): pre-trust a workspace so a chat can start in it.",
    },
    "unblock_prompts": {
        "kind": "mutate",
        "invocation": "both",
        "platforms": "windows-only",
        "guards": ("hold", "breaker", "armed-window", "force"),
        "result": "0 nothing stuck, or everything pressed - 2 something did not clear (each named) - 1 daemon failure",
        "availability": "available",
        "summary": "ACT: restart chats that stopped on a permission prompt they should",
    },
    "undo": {
        "kind": "mutate",
        "invocation": "direct",
        "platforms": "any",
        "guards": ("hold", "breaker", "live-writer", "force"),
        "result": "0 undone and verified, or genuinely nothing to do - 3 unknown/already-undone/not-undoable id, or bad usage (deterministic) - otherwise whatever code the underlying acting script itself returned, unchanged",
        "availability": "available",
        "summary": "ACT: reverse one recorded mutation through the SAME acting script that made it.",
        "notes": "the inverse it drives (archive_chat/rename_chat/migrate_chat vs. hold_chat) decides whether an actuator is involved; marked platform=any because undo.py owns no ACTUATOR constant itself - flagged rather than guessed.",
    },
    "waiting_scan": {
        "kind": "observe",
        "invocation": "direct",
        "platforms": "any",
        "guards": (),
        "result": "0 scan completed - 1 daemon failure (zero waiting chats is a real, complete answer here)",
        "availability": "available",
        "summary": "OBSERVE ONLY: which chats are waiting on a person, over REAL transcript tails.",
    },
}

# THE INVOCATION FIELD IS DERIVED, NEVER HAND-MAINTAINED TWICE (AH-25). The literal "direct" /
# "both" values written into CATALOG above are a readable starting point, but the values that
# actually ship are overwritten here from lib/armlib.GATED_SCRIPTS - the one real fact of
# which scripts call armlib.refuse_unless_armed. This is what "consult the catalog instead of
# a hardcoded exception list" means in the other direction too: the catalog itself refuses to
# hold a second, hand-typed copy of armlib's set, so the two cannot silently drift apart the
# way orch.py's prose-based menu classifier already had (migrate_batch.py, interview.py,
# run_locked.py and smoke.py all landed in a leftover "other" bucket before this file existed).
#
# run_locked.py is the one documented exception to the exception: it is reached ONLY from
# schedule_jobs.py's generated .cmd wrapper, whose OWN text (ARM_GUARD) checks `orch.py armed`
# before ever invoking it - so the gate is real, it simply is not an in-process armlib call,
# and armlib.GATED_SCRIPTS correctly does not name it. Marking it "direct" here would be
# wrong (it is never a person's stand-alone word), so it is pinned "unattended" by hand - see
# its own `notes` entry above for the full explanation.
from lib import armlib as _armlib  # local at module tail, not the top: see armlib's own

for _name, _row in CATALOG.items():
    if _name == "run_locked":
        _row["invocation"] = "unattended"
    else:
        _row["invocation"] = "both" if _armlib.requires_arm_check(_name) else "direct"
del _name, _row


def entries_by_kind(kind: str) -> list[str]:
    """Script names of one kind, in the same alpha order the menu renders them."""
    return sorted(name for name, row in CATALOG.items() if row["kind"] == kind)


def is_direct(name: str) -> bool:
    """True when CATALOG says `name` never consults the armed window at all."""
    return CATALOG[name]["invocation"] == "direct"

