# Changelog

All notable changes to AgentHydra are documented here. Entries up to v0.13.0 were written when the
project was called CC Manager UI and are left in its name, because that is what shipped. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A provenance ratchet on the agent catalog** (`scripts/checks/catalog-row-provenance.mjs`, wired
  into CI). The 58 rows in `server/src/agent-catalog.ts` say where each coding agent keeps its
  conversations, and their paths were compiled from a third-party registry rather than read from
  each tool's own source. A wrong path there is invisible by construction: a row pointing at a
  directory that does not exist produces exactly what a correct row produces on a machine where
  that tool is not installed, so it can never be told from "not installed" and lives forever. Three
  rows were checked against upstream source on 2026-09-04 and all three were wrong - Hermes Agent
  and OpenClaw both pointed at directories their projects do not have (fixed), and `aider` carried
  an empty `dirs`, unmatched on any machine without `AIDER_DIR` set (given `~/.aider`, which its
  own `main.py` writes to). Rows now carry an optional `verified: '<repo> <file> (<date>)'`, and
  the guardrail ratchets on the count so verification can only grow, fails a marker that names no
  file or date, fails a row that cannot match at all, and fails if its own parser reads fewer rows
  than the table declares.

- **`orchestrator/scripts/lib/incidentlib.py` - THE INCIDENT LEDGER**, ported from
  NousResearch/hermes-agent's `cron/incidents.py` (MIT) and adapted to this toolbox's
  JSON-rows-in-state style (no SQLite). Groups repeated failures by a normalized cause
  signature instead of leaving them as anonymous rows in the attempt ledger: the same chat
  failing the same way, or several unrelated chats failing for one shared reason, collapses
  into ONE incident (lifecycle `open` -> `acked` -> `resolved`) with a repeat count and last
  error. `ledgerlib.note()`/`annotate()` now file an incident for every deterministic or
  explicitly-flagged failure and stamp the ledger row with the incident id, so the two can be
  joined. `sweep.py` gained a SHARED-CAUSE BREAKER: 3+ consecutive same-signature failures in
  one lane halt the rest of that lane for the pass (`--breaker-threshold` to tune) instead of
  repeating a cause that will not clear chat by chat, and file one incident naming every chat
  left behind. New `python orch.py incidents` (list open/acked, `--ack`/`--resolve`, `--all`)
  surfaces it; the dashboard's `/data/incidents` route and `/data/suppressed`'s
  `incidentsOpen` count expose it there too.
- **Orchestrator: the unblock lane now classifies a stuck permission prompt before pressing
  it, tri-state (APPROVE / DENY / ESCALATE)** - our own classifier; the tri-state idea came from
  reading NousResearch/hermes-agent's `approval.py` (MIT), none of its code. Previously `unblock_prompts.py` pressed Allow on any chat whose
  configured mode was `bypassPermissions`, whatever the pending command actually was.
  It now also classifies the command against `orchestrator/scripts/lib/approvallib.py`'s
  policy (`state/approval_policy.json`, created with a WHY-comment on first run, hand-edited
  only - never inferred from a chat's own transcript text): hardline-destructive commands
  (`rm -rf`, a shared-branch hard reset, a credential path, ...) DENY and are recorded, never
  pressed; clearly safe ones (read-only inspection, build, typecheck, test, lint, git
  status/log/diff) APPROVE exactly as before; everything else ESCALATEs into a new judgment
  queue (`state/approval_escalations.json`) that `interview.py --ask` now also surfaces, so a
  person or the `/orchestrate` AI decides instead of it being pressed on a guess. The
  scheduled UNATTENDED run presses only APPROVE; an INTERACTIVE run (`--force`, a person at
  `orch.py`) may also press an ESCALATE row, after the command has been shown.
- **A mutation ledger with undo, for every act the orchestrator performs on a Desktop chat**
  (a plain before/after ledger; unrelated to any external checkpoint tooling). Until now `archive_chat.py`, `rename_chat.py`, `migrate_chat.py`,
  `hold_chat.py` and `compact_chat.py` left no before-image of what they touched, so a wrong
  archive or rename (the orchestrator's README documents 6 of 29 chats archived wrongly in one
  day under v2) could not be undone from here - only by hand, on a screen, from memory. Each of
  those five scripts now writes down what its target looked like immediately before it acted
  and immediately after (`orchestrator/scripts/lib/mutationlib.py`, same locked-JSON discipline
  as the attempt ledger and the holds file); `python orch.py mutations` lists every entry newest
  first with an `undoable` flag, and `python orch.py undo <id>` reverses one through the exact
  same rail-guarded script that performed it (unarchive, rename back, migrate back to the source
  instance, or release/re-hold), verified by that script's own fresh mutation row rather than
  trusted on exit code alone. Compaction is recorded but never undoable - it is lossy by design,
  so no inverse exists, and the reason is stated rather than guessed.
- **Startup-liveness watchdog** so a daemon that hangs during boot (a locked sqlite file, a port
  probe that never returns, an updater step that stalls) crashes and gets restarted instead of
  sitting there indistinguishable from a slow one - tray icon idle, nothing logged, until someone
  restarts it by hand an hour later. Armed at process entry (`server/src/main.ts`, before importing
  the daemon or `--instances` entrypoint), renewed at each boot phase as it's reached (db open,
  migrations, scheduler start, queue recovery, listen), and disarmed the moment the port is actually
  bound. If the deadline elapses with no renewal, it logs the last-known phase and pid to both
  stderr and `daemon.log`, then exits with a distinct code (`87`) so the tray/service supervisor
  restarts it rather than a silent hang. Deadline is `AGENTHYDRA_BOOT_DEADLINE_MS`, generous by
  default (120s full daemon, 30s `--instances`); inert under `bun test`. Idea ported in shape from
  NousResearch/hermes-agent's startup watchdog (MIT) - see `server/src/boot-watchdog.ts`.
- **Hermes Agent joins the readable session sources** (PLAN.md's DEFERRED list named it first: 241k
  GitHub stars, larger than every other deferred source combined). Hermes keeps everything in one
  SQLite file, `state.db`, at the root of `HERMES_HOME` (`~/.hermes` on POSIX, `%LOCALAPPDATA%\hermes`
  on native Windows), plus a separate `state.db` per named profile under `profiles/<name>/`. AgentHydra
  now lists, tails, exports and body-searches Hermes sessions the same way it already does OpenCode's
  shared SQLite store, with a profile standing in as the "project" grouping. Usage is priced through
  AgentHydra's own catalog by model name rather than trusting Hermes' own cost columns, so a model the
  catalog has no price for costs $0 and is flagged unpriced instead of silently taken on faith. Purely
  a reader: the queue, composer and resume-in-terminal stay Claude-only, and nothing here writes to a
  Hermes store. New: `server/src/hermes-sessions.ts`.
- **Failed queue runs are now grouped into incidents, so twenty overnight runs failing the same
  way read as one problem instead of twenty.** Ported from NousResearch/hermes-agent's cron
  incident tracker (MIT). A `failed` run (via `finalize()` or a pre-launch refusal in
  `dispatch.ts`) is recorded against `(scope, key, error signature)` - the signature survives
  timestamps, pids, and paths changing between runs of the same project, so a repeat only bumps a
  counter rather than minting a new alert. Lifecycle is `open -> acked -> resolved`; a resolved
  incident whose error recurs reopens rather than staying silently closed, and a genuinely
  different error on the same project opens a new one. Desktop/email notifications (reusing the
  existing reset-notification channels) fire on the first occurrence and on a reopen, and are
  suppressed for every repeat in between - the count still increments. The one pre-launch refusal
  that is permanent by policy (headless dispatch is currently disabled outright) is excluded from
  incident tracking entirely, so it cannot page on every dispatch attempt. New: `server/src/incidents.ts`
  (the model), an `incidents` table (`server/src/db.ts`), `GET /api/incidents`, `POST
  /api/incidents/:id/ack`, `POST /api/incidents/:id/resolve` (`server/src/routes/incidents.ts`),
  MCP tools `list_incidents` / `ack_incident` / `resolve_incident`, and a collapsed "Incidents"
  panel above the run queue with an open-count badge and ack/resolve buttons
  (`web/src/components/IncidentsPanel.vue`).
- **"Never claim an act landed without checking" - now enforced, not just documented.** This
  repo's own orchestrator rule 4, finally applied to the run queue as well. The never-retry-on-
  UNKNOWN half (a provably-never-attempted row may be re-queued; one whose outcome is unknown
  never is) is a discipline NousResearch/hermes-agent's `cron/delivery_queue.py` documents for its
  own queue; reading it prompted this, no code is shared. Two halves:
  - **The run queue.** A finished run's exit 0 no longer means `completed` by itself: the
    daemon now re-reads the run's own transcript and requires an assistant turn timestamped
    after the run started. Missing that, the run reads `unverified` - a new, distinct queue
    status shown everywhere `completed`/`failed`/etc. already are (`QueueItemCard`, the run
    viewer, `list_queue`/`get_run_events`), logged at WARN with what was missing, and never
    silently delivered to a migrated run's desktop target. A run whose failure is genuinely
    UNKNOWN (the process/pid vanished with no exit code - not a real code `claude` reported) is
    recorded as such and is never auto-retried without saying so.
  - **The orchestrator's ledger.** `ledgerlib.verify(kind, session_id, verified)` attaches a
    `true`/`false`/`None` read-back verdict to an attempt row (`unverified()` surfaces the
    `false`/unknown ones for the judgment queue). `archive_chat.py`, `rename_chat.py` and
    `migrate_chat.py` - which already re-read the target's state after acting - now record that
    verdict on the ledger instead of only reporting it; `rename_chat.py` also had a real bug this
    closed, where a failed verify READ silently collapsed to the same outcome as a verify that
    succeeded and disagreed (`unknown` was reading as `false`).

- **THE ORCHESTRATOR IS BACK IN THIS REPO - as a folder, not a rewrite** (owner order, Michael,
  2026-09-03: "migrate the orchestrator into AgentHydra so I don't have to explain that you have
  to use both"). `orchestrator/` is the v3 Python toolbox exactly as it stood in its own repo
  (`Lunarwerx/orchestrator`, now an archive): `orch.py`, `scripts/`, its 647 unit tests, and its
  remote front-end (`orchestrator/server` + `orchestrator/web`, now root workspaces). The
  2026-08-31 boundary survives - the scripts still only ever talk to the daemon over HTTP - but
  there is one surface: the daemon runs them (`server/src/orchestrator.ts`; `GET
  /api/orchestrator`, `POST /api/orchestrator/run`) and the MCP server exposes
  `orchestrator_menu`, `orchestrator_run`, `orchestrator_loop` and `orchestrator_switch`. Script
  names are validated against the menu grammar and arguments travel as an argv array, never a
  shell. Nothing there acts without the tray icon, as before. The retired v1/v2 reference trees
  (`old/`) and the duplicate `src/` + `tests/` copies did not come along: they stay reachable in
  the archived repo, and the README's postmortem paragraphs carry the lessons. Release bundles
  stage the python half beside the executable (`orchestrator/`), where the compiled daemon looks
  for it; the spawn forces UTF-8 and normalises CRLF so the second machine reads the same bytes.
  A machine that ran the standalone checkout has a written one-time cut-over (scheduled tasks,
  tray shortcut, `state/`) in orchestrator/README.md. The `/orchestrate` command that 0.37.0
  removed is back (canonical copy in `.claude/commands/`, beside `/hydra-status`), rewritten onto
  the four MCP tools instead of a path to a second repo.
- **Redeem a banked Codex reset credit from the Instances view.** A ChatGPT-account Codex login
  can bank `/usage reset` credits, each restoring the FULL 5h + weekly rate-limit windows in one
  shot - previously AgentHydra could only read the count (`rate_limit_reset_credits`), never spend
  one. The Codex row's menu now has "Redeem reset credit" (`server/src/core/codex-account.ts`'s
  `redeemCodexResetCredit`, `POST /api/codex-instances/:id/redeem-reset-credit`, MCP's
  `redeem_codex_reset_credit`), guarded the way the Codex CLI's own picker is: it refuses unless
  the busiest window is already fully used (100%) or the caller passes `force`, since redeeming
  early wastes most of a credit's value. The button disables itself with the reason when the
  already-cached quota chip shows the guard would refuse. Ported from
  `NousResearch/hermes-agent`'s `account_usage.py` (MIT, Copyright (c) Nous Research); the access
  token is read into a local binding only and never logged or returned.

### Fixed

- **A damaged instance registry is never silently replaced, and a delete never claims more than it
  did** (audit AH-01/02/03, 2026-09-05). Three related holes in how the CLI and Codex instance
  registries and the profile deletes handled failure, each reproduced against the real functions
  before it was closed. (1) Both registries read a malformed or unreadable `cli-instances.json` /
  `codex-instances.json` as an EMPTY store and their next write overwrote it, so one create after a
  corrupt read came back `ok: true` with a fresh file holding only the new record - every managed
  login identity in the old file gone, with a success message. Every read and write now goes
  through one `core/json-store.ts`: missing, corrupt and unreadable are told apart, every mutation
  refuses on a damaged file and leaves its bytes exactly as found, writes are temp-file + rename,
  and mutations hold an interprocess lock, because the quick-instance daemon writes the same files
  as the main daemon and last-writer-wins between two processes silently dropped whichever record
  landed first. Boot logs what the disk and the registry disagree about (a login dir no record
  claims, a record whose dir is gone) instead of leaving that to be discovered by hand. (2) The
  process scan behind the desktop-profile delete folded "could not enumerate" into "nothing
  running", so a transient PowerShell/CIM failure during a confirmed delete authorized removing a
  profile a running app was still writing into - its own fail-closed catch never fired because the
  scanner had swallowed the error first. The scan now says which of the two it is, and both the
  Claude and Codex deletes refuse on unknown. (3) A delete whose directory removal FAILED (a
  locked profile) dropped the registry record anyway and reported success, leaving the login on
  disk with no row to manage it from; the record now stays and the real error comes back.

- **Shared journals no longer lose each other's writes, stale UI responses are discarded, and the
  queue API cannot forge history** (audit AH-13/17/18/21/22/29/31/37, 2026-09-05). Four journals
  the toolbox's lanes share - the workspace trust file, the chip handoff list, the standing
  manager's role claim, and every chat's metadata record - were each read whole, changed, and
  replaced with no lock between lanes, so the last writer silently discarded the other's change
  (reproduced for chips: a newly seen chip vanished and a dismissed one came back). Each now
  holds a named lock around read-modify-replace and re-checks the file's revision right before
  the replace; a record the desktop app rewrote underneath is re-read and re-applied, and one that
  keeps changing is left alone with an error rather than overwritten from a stale copy. In the
  browser, queue and scheduler refreshes and the transcript tail carry request generations, so an
  old slow response can no longer resurrect a deleted row or paint the previous filter's
  transcript under new controls; the remote app's "refresh every reading" now refreshes the Rules
  and Scripts it had loaded. The queue API splits what a person may edit (title, position, start
  time) from what only the runner may write (status, pids, timestamps, exit codes, import state):
  a client can no longer mark an item running or completed, edit an active row's identity, or
  delete a row still marked running. And the session export, which by contract renders one whole
  document, now refuses a transcript over 64 MB up front with a 413 that names both sizes and
  points at the raw download, instead of claiming to stream while holding it all.

- **An outage no longer looks like an empty account, and every failed action says why** (audit
  AH-20/23/26, 2026-09-05). With every API read failing, the main app used to show "No sessions
  found", "Scheduler off" and an empty queue. Each resource now carries its own loading, error,
  stale and unavailable state: a first-load failure shows "unavailable" with a Retry, a later one
  keeps the last good data and marks it stale, and one resource's error never touches another.
  Queue run/cancel/delete and the composer's send now show the server's real error text instead
  of a bare count, and the prompt survives an unconfirmed send. The remote app retries a failed
  startup with a bounded backoff and a Retry button, tells an authentication refusal apart from an
  unreachable gateway (the former goes to login, never a reconnect loop), reports a failed
  sign-out, and shows a tunnel that died with its reason rather than as "off"; a login whose
  identity-provider discovery fails gets the gateway's retry page instead of a raw server error.

- **The toolbox's locks no longer crash under contention on Windows** (found while landing the
  above, 2026-09-05). Every lane's lock - ledgers, holds, the delivery queue, the new journal
  locks, the naming pass - is an exclusive-create of a lock file, and both helpers tolerated only
  "already exists". On Windows the previous holder's unlink leaves the file's name pending-delete
  for a few microseconds, and a create landing in that window answers "permission denied"
  instead, so a lane that owed a wait crashed: measured 42 crashes in 1,800 contended
  acquisitions across six threads. The permission-denied answer is now treated as contention
  (wait, or for the non-blocking lock, defer), and a contention test pins it. The timed-out
  toolbox run on Linux and macOS now also kills the interpreter's descendants (an actuator it
  was blocking on), not just the interpreter; Windows already did through taskkill.

- **Updates are verified before they run, long scripts cannot exhaust the daemon, and a dead
  tunnel says so** (audit AH-14/19/24/27/38/41, 2026-09-05). The compiled updater now checks a
  downloaded archive against the release's published SHA-256 manifest before extracting it or
  running anything out of it, and refuses a release that publishes no manifest; until now its
  only gate was running the download to see if it printed the right version, which is a
  compatibility check, not an integrity one. (What it proves: the bytes are the ones the release
  published. What it does not: who published them; a signed manifest is still open.) The
  orchestrator adapter bounds a script's output while reading it, keeping the last 200k
  characters of each stream and counting what it let go, instead of holding a runaway script's
  entire output in memory and trimming afterwards. The remote gateway now reports an outage when
  its tunnel connector dies after it was ready, clears the advertised URL, and cannot be talked
  back into "ready" by a late message from the dead connector. The local kit-drift check and the
  pre-commit guard cover both vendored kit targets, not just the main web root. Release smoke
  asserts the orchestrator payload is inside every archive and that test and runtime-state
  directories are not. And the README screenshot fixture matches the session DTO again, with a
  test that keeps it that way.

- **Fleet actions land once and read the right store** (audit AH-04/05/06/33/34/36, 2026-09-05).
  Six more findings, each reproduced before it was closed. The Python toolbox now finds the daemon
  the way the MCP server does (explicit URL, explicit port, then the port the daemon ACTUALLY
  bound, then 7787) and the daemon pins its own bound URL into every toolbox child it spawns - a
  daemon that had hopped off a busy 7787 used to leave its toolbox talking to whatever answered
  there. Importing a session into a desktop app now holds one claim per session across every
  entry point (direct route, migration, batch, the message route's heal): a concurrent same-target
  request waits and coalesces onto the row the first one made instead of spawning a second import
  and a second identically named row, which made every later title-aimed action on that chat
  refuse as ambiguous. Automatic reply staging checks for an existing pending reply inside the
  same lock it appends under, so two lanes planning the same wake in one window produce one row.
  The quota budget's token count walks nested subagent and workflow transcripts, which the
  transcript index already counted as separate spend; a window in which the work was delegated
  used to report no activity at all. Kilo, MiMo Code and IcodeMate sessions are read from their
  own databases in tail, list metadata, export and analytics, not from the default OpenCode one
  (they listed fine and then opened as "transcript not found"). And the in-memory metadata cache
  treats a revision as mtime AND size, as the persisted cache always did, so an append that lands
  inside the same timestamp tick is re-parsed rather than served stale.

- **Delete and undo of one chat can no longer interleave, twin cleanup re-checks liveness at the
  moment it acts, and a failed self-update no longer erases edits made while it ran** (audit
  AH-28/32/39, 2026-09-05). Three more places a decision was older than the act it authorized.
  `delete_chat` and its `--undo` now hold one per-chat lock for the whole transaction, because an
  undo that landed between the trash copy and the unlink loop was itself unlinked - both sides
  reported success and the chat was gone (reproduced with the production functions). Whichever
  arrives second now defers, refused-class exit 3, and a later undo restores everything.
  `audit_twins --fix` decided "not live" once per pass and then waited up to 60s for a window
  mutex and drove a 240s actuator on that stale answer; it now takes the same per-chat archive
  lock `archive_chat` holds, asks liveness and engine host again once the window is its own,
  defers a copy that went live meanwhile, and treats a daemon that cannot report liveness as
  unknown (refuse) rather than as an empty room. The shared source updater (kit
  `updater-engine.mjs`, synced) proved the tree clean BEFORE the pull and then, on a failed
  install/build minutes later, ran `git reset --hard` - deleting anything typed into the checkout
  meanwhile. It now re-reads the tree first: changes made during the update go into a named git
  stash before the reset and the message says so (`git stash pop` restores them); if the tree
  cannot be inspected or stashed, it does not reset and says the checkout needs a hand instead.

- **A compacted desktop chat no longer shows up as two or three chats** (owner, Michael,
  2026-09-03: "I have a feeling compacted chats or something, become multiple entries"). He was
  right, and the mechanism is specific. The desktop app rolls a chat onto a new transcript id when
  it compacts, and it does so by REPLAYING the retained history into the new file before writing
  the compaction marker - so the marker the continuation detector looks for among a transcript's
  first records sits hundreds of records deep and was never found. Measured on one chat: three
  transcripts, the marker at record 1,501 of the newest, three rows under two titles. The app
  records every retired id in its own metadata (`priorCliSessionIds`); the session list now lays
  those links over the index (`withDesktopContinuations` in `server/src/sessions.ts`, fed by
  `retiredSessionIds()` in `server/src/instance-sessions.ts`) and folds them exactly as it folds a
  detected continuation, crediting the retired ids to the survivor so instance, archive and queue
  lookups keep working. A claim made only by an ARCHIVED tombstone counts too, because after a
  migration the tombstone left behind is the only record that still remembers the lineage. On this
  machine: 28 of 2,118 chats had rolled, 37 phantom rows.
- **The orchestrator's own tests stop depending on Claude Code being installed.** Their first run
  on GitHub went red on four tests, and all four had one cause: the runner has no `claude` binary.
  `compact_chat.main` resolved the CLI *before* choosing its runner, so an injected test runner was
  never reached and the `runner=` seam only looked injectable - the executable is the real runner's
  dependency, and it is now resolved as one. The one test that genuinely asserts an installed
  binary skips loudly, naming the machine fact, and a new test pins the fallback so the
  bare-name branch is covered everywhere. These never surfaced before because the CI step that
  runs them arrived with the orchestrator and had never been pushed.
- **The release notes stop promising the two Windows downloads are otherwise identical.** The
  orchestrator ships as a FOLDER beside the executable, so like the tray toolkit it can only ride
  in the zip - an `.exe` install answers `GET /api/orchestrator` with `present:false` and its four
  MCP tools do nothing. The asset table said "Everything else is identical", which turned a silent
  omission into a written promise; it now has an orchestrator column and says what the single file
  is. The table's own comment already made this rule for the tray icon ("costs real users, who
  reasonably read a missing icon as a bug"); it now states the general form, so the next payload
  staged beside the binary cannot become a third quiet exception.
- **The orchestrator's gate no longer reads a `/compact`ed chat as "may be working" for ever.** A
  chat that finished its turn and was then compacted ends on a `<local-command-stdout>Compacted`
  record - user-role, and no model ever answers it - and the idle test accepted only a completed
  assistant turn as the newest record, so nothing could move or archive such a chat until a person
  killed its engine by hand (two chats, 2026-09-03). Local plumbing a transcript ENDS on - a slash
  command the app answered itself, its printed output, the caveat banner, a compaction summary - is
  now stripped before the tail is judged (`strip_local_tail` in `orchestrator/scripts/lib/gatelib.py`).
  A slash command still awaiting the model, and anything in flight under an auto-compaction
  summary, still read as mid-turn.
- **A chat parked at a usage wall no longer reads as "may be working".** An account out of
  budget until its reset cannot write, so its chat is stopped, waiting - the plainest case
  there is. But the wall arrives as an api_error record, which the gate's completed-turn test
  excludes, so such a chat was unmovable for as long as its engine lived, and moving it OFF the
  exhausted account is the one thing that would have helped. Quota walls only: a transient
  overload is one the engine may retry on its own, and moving a chat that is about to resume
  would rewrite a live transcript.
- **`python orch.py <script> --help` prints that script's manual.** It printed the driver's own
  docstring for every subcommand, so the menu's promise ("`orch.py <script> --help` for any of
  them") was false for all of them. The manual is read with `ast`, never by running the script, so
  the branch stays incapable of acting.
## [0.38.3] - 2026-09-03

### Added

- **A moved chat keeps what it was set to.** Model, effort, the ultracode toggle, the Chrome
  permission mode and the chat's own permission grants travel with it. Measured before the change
  on 16 moved chats: effort reset on 13, ultracode reset on 13, Chrome mode reset on 14, every one
  arriving as "manual / extra / ultracode off" for the owner to fix by hand. Not carried, on purpose:
  the permission mode (every migrated chat is bypass, the standing rule) and the enabled MCP tools
  (those ids belong to the source account's connectors).
- **Move chats to a CLOSED account without starting it.** The chat's record is written straight
  into that instance's store, a near-copy of the original, and the app finds it there, settings
  intact, when it next starts. This is the landing that needs no restart afterwards, and the flyouts
  say so: a closed target reads "Move to X" under "Not running - lands in its store, ready when it
  starts". The old "Start X and move there" step is gone with the refusal it worked around.
- For a **running** target the app still creates the record, the carried settings are merged onto it
  with the title and the bypass stamp, and the minute-by-minute sweep puts them back whenever the
  running app re-saves over them, until that app's next start makes them permanent (the same shape
  as the bypass stamp). The migrate response says which landing happened (`landing: hot | cold`)
  and which settings were carried.

## [0.38.2] - 2026-09-03

### Added

- **The move dialogs group chats by project.** Both "Move all chats to another account" (Instances)
  and the bulk "Migrate N chats" (Sessions) list what is about to move under a header per project
  folder (the same name the sessions list shows), largest group first, with a count - so eighteen
  titles read as "eleven Connections, five Agent Hydra, two TavernBag" before the click, not after.
- **Click a chat in either list to open it.** The Sessions view switches in (from Instances), the
  search box takes that session's id so the list shows exactly that one row, and it is selected.
  A chat outside the current time window widens the window to everything and selects it the
  moment the list carries it.

### Fixed

- **Migrating a chat from the web UI works again.** Since the naming law landed on 2026-08-29 the
  migrate route has required a title decision - a real new `title`, or `confirm_title` restating
  the chat's current title exactly - and the web client sent neither, so every migrate started
  from the UI, one chat or sixteen, was refused with 400 before it touched anything. The UI now
  restates each row's own title. A chat whose current title is generic ("General coding session")
  is still refused, by design: the toast names the reason, and giving that chat a real name in the
  app is the way through.
- **A failed move says why.** The bulk toasts carried "details are in the browser console"; they
  now carry the server's first reason too, and read as an error rather than a warning when nothing
  moved at all.

## [0.38.1] - 2026-09-03

### Fixed

- **Migrate destinations carry the name the Instances table shows.** The Move-all submenu, the
  migrate flyouts and their confirmation dialogs offered folder names (`5claude`, `arama`) where the
  table shows apebrain and Martin; they used `label ?? name` and skipped the account-name step the
  table's own helper takes. Found by exercising 0.38.0 in the browser.
- **The daemon says why it did not start the tray host.** A skip for "already running" or "hidden
  by setting" is logged by reason now. On the first live relaunch under 0.38.0 the skip was correct
  and its silence still read as a missing tray to the person checking the log.

## [0.38.0] - 2026-09-03

### Added

- **Move chats in bulk.** In Sessions, Ctrl/Cmd-click or Shift-click rows to pick several (this
  turns select mode on by itself), then right-click one of them: the menu leads with *Copy N
  session ids* and *Migrate N chats to another account*, behind a confirmation that names the count
  and the destination and lists the chats. In Instances, every row's menu has *Move all chats to
  another account*: every active chat on that account (not archived, not marked done), one hop to
  another, again behind a confirmation. Both move chats one at a time on purpose, because each
  migrate may stop a live run and the desktop app takes imports serially anyway; a summary toast
  says how many landed, and anything that did not is named in the browser console.
- **Migrate from the right-click menu.** A session row's context menu now carries the same *Migrate
  to another account* flyout the open chat's ⋯ menu had, so moving one chat no longer means opening
  its transcript first.
- **Right-click an instance row** to get its ⋮ menu, same items, same position.
- **Closed accounts appear in the migrate flyout.** Targets are in two groups, *Running* and *Not
  running*. A running one takes the chat as it stands; a closed one reads *Start X and move there*:
  the click opens that instance the ordinary way, waits for it to come up, then migrates. The server
  still refuses to import into a closed app on its own (the import spawn would boot it, and nothing
  opens an account without being asked); the click is the asking.
- **The daemon starts the tray host.** A release ZIP has the whole tray toolkit in `misc\`, and
  nothing started it unless you knew to run `misc\Create-Shortcut.ps1` first: double-clicking
  `AgentHydra.exe` ran the daemon, opened the UI, and never showed a tray icon, on a machine that
  did exactly what the release notes said. Now a compiled daemon that finds `misc\lunarwerx-tray.exe`
  beside itself, with the tray not hidden by setting and no host already running, starts the host,
  which attaches to the daemon (its shipped `onStrayDaemon: attach` behaviour) and shows the icon.
  The decision is a pure function with its own tests; a source checkout never gets a tray it did not
  ask for. `install.ps1`'s Start Menu shortcut now launches through the tray host too, using the kit's
  own shortcut recipe instead of a second copy that had drifted to point at the bare exe.

### Fixed

- **Migrated chats stay on `bypassPermissions`.** The stamp was always written on import, and the
  running app always re-saved `acceptEdits` over it on the chat's first wake; a bounded watcher
  fought that for ten minutes and eight restores, and a chat opened eleven minutes after migrating
  reverted for life. `reassertAutomationStamps`, which re-stamps every import-shaped chat in a
  profile and was called from nowhere but its own test, now runs every minute over every RUNNING
  instance for as long as the daemon does. Only imported chats (`local_<cliSessionId>.json`) are
  touched, never one a person created in the app. The migrate route also hands back its notice
  prompt with the `ultracode` keyword when the new-chat default is on; a first message you type
  yourself in the desktop app is yours to arm, nothing here can reach into that composer.
- **A manual *Check for updates* always asks GitHub.** The result was cached for five minutes and
  the background tick kept that cache warm, so the one click that exists to ask "right now" was the
  click most likely to be told a stale "up to date". HTTP 429 (GitHub's secondary rate limit) now
  reads as the rate limit it is rather than "couldn't reach the Releases API".
- **The single-file `.exe` says once that it has no tray icon**, by OS toast (the build hides its
  console, so nothing else lands). The flag is never synced: it is a fact about that copy's packaging.
- **Quick Instances' success notice can be dismissed**, like the error banner beside it always could.
- **A run's live output says *Reconnecting…*** when its stream drops, instead of freezing in a way
  indistinguishable from a quiet run. Not shown for a finished run, whose stream the server closes.

### Changed

- The root-level `AgentHydra.exe` and `FINDINGS-*.md` write-ups are gitignored: on a public repo an
  untracked 100 MB binary is one careless add away from being published for good.

## [0.37.0] - 2026-09-02

### Removed

- **THE ORCHESTRATOR IS GONE FROM THIS REPO, ENTIRELY** (owner order, Michael, 2026-08-31). Every
  line of it now lives in a separate program, `orchestrator/`, which talks to this daemon over
  HTTP. AgentHydra is the fleet daemon again: it knows what instances and chats exist and acts on
  one when asked. Deciding what *should* happen to a chat is no longer its business, and the HTTP
  boundary is there so the two cannot grow back together.

  Removed: 15 modules (`prestart`, `chat-gate`, `gate-actions`, `gate-sweep`, `sweep-loop`,
  `zombie-rows`, `deliveries`, `courier`, `courier-deliver`, `ui-deliver`, `holds`, `breaker`,
  `collisions`, `reconcile`, `name-untitled`) with their 16 test files; 8 MCP tools (`prestart`,
  `chat_gate`, `chat_act`, `chat_sweep`, `chat_hold`, `courier`, `deliveries`, `sweep_loop`); the
  `/api/chats/:id/gate`, `/api/chats/:id/act`, `/api/chats/sweep`, `/api/prestart`,
  `/api/deliveries`, `/api/holds`, `/api/sessions/:id/{hold,release}`, `/api/couriers*` and
  `/api/sweep-loop*` routes; the `deliveries`, `session_holds` and `action_attempt_log` tables and
  every `sweep_*` / `courier_enabled` setting; the `/orchestrate` command and `smoke:orchestrator`.

  **Why, in one line each.** It archived chats that were waiting on a person - the gate called a
  recap saying "done" finished unless the message ended in a literal `?`, so *"say the word and
  I'll start"* was filed away; 6 of 29 chats archived in one day were waiting, and one was archived
  twice, the second time by the very call trying to hand it the answer. And a 2-minute loop
  re-drove the app's Archive control for rows it could never clear (227 chats archived on disk
  under an app open for a day - those flags only re-read at restart), with no memory of failure
  anywhere, including for a refusal that was deterministic.

- **KEPT, because they are primitives the orchestrator merely used**: `chat-dossier`,
  `live-registry`, `ui-archive`, `chat-title`, the auto-resume monitor, and the
  `desktop-archive` / `import-desktop` / `chats/:id/rename` routes. The landing path and the act
  lock the monitor depends on were extracted into the new `desktop-landing.ts` before
  `gate-actions.ts` left, so the monitor still lands a homeless chat when its window resets. The
  landing deliberately no longer stages any prompt - that was orchestration and went with it.

### Added

- **The fleet can now say "this account cannot do work, and here is why" ONCE, instead of finding
  out one failed chat at a time.** It knew three separate things - closed, signed out, near its
  usage cap - in three files, so an act reported whichever its own code path happened to read.
  There is now a single verdict per instance, and it carries a signal that did not exist at all:
  **whether the app is actually answering**. `isRunning` was a process id, and a wedged Electron
  app keeps its process id and its config file, so a hung instance reported as perfectly healthy
  while every act against it failed. It also stops confusing a DAMAGED profile with a signed-out
  one - a half-written config file used to be announced as "sign it in", sending you to fix a
  login that was never broken. Closed is deliberately never a fault (it is this fleet's resting
  state), and a probe that could not run reports UNKNOWN, never "fine".

- **Slash commands, so operating this thing is not folklore.** `/orchestrate` runs the orchestrator
  pass in the required order, `/hydra-status` reports everything and touches nothing,
  `/hydra-check` runs every gate this repo has including its own CI locally. They ship with the
  repo now - the ignore rule was hiding them on one machine, which is the same defect as a memory
  that only one person can read.
  `/orchestrate` keeps the name v1 used, on purpose. The orchestrator is not a separate subsystem
  any more (retired whole on 2026-08-29, rebuilt as this daemon's own gate/act/deliver machinery),
  but it is still the same thing to the person running it, and renaming it to match the internals
  would have made the tool harder to find for no gain. The two `hydra-` commands keep that prefix
  because they are about the app and the repo, not about the orchestration pass.

- **`bun run smoke:orchestrator` proves `/orchestrate` actually works, over the transport it
  actually uses.** The command drives this app's MCP tools, and the MCP server had been registered
  nowhere at all, so every run since the command was written had silently fallen back to
  hand-driving the REST API and nothing would ever have said so. Testing the REST API proves the
  fallback. This speaks the same JSON-RPC/stdio protocol a real pass speaks, through the same
  `bun run mcp` entry, and walks the command's own steps in its own order: every named tool
  resolves, the census is sane, every lane is present, no live chat is ever acted on, the courier
  pass is not silently capped, and the queue is genuinely empty afterwards. It also pins the two
  report-level defects fixed below, which no unit test could reach because both were about what a
  LIVE report says. Report-only by default; `--act` performs the real pass. Deliberately not a CI
  step and it must never become one, since it drives the real fleet.

- **The daemon is finally supervised, instead of staying up only because someone once typed a
  command.** Every part needed to keep it alive already existed - `Ensure-Daemon.ps1` no-ops when a
  healthy daemon of ours answers and restarts it when nothing does - and nothing ever called them on
  a schedule. A census of the machine that runs the fleet found no scheduled task, no Startup
  shortcut and no Run key entry for this app; the live daemon's parent was a bare
  `cmd /c bun server/src/index.ts` from five hours earlier. That is the worst shape an outage can
  take, because orchestration does not crash loudly, it just silently stops happening while every
  automation fails one HTTP call at a time. `misc/Install-DaemonSupervisor.ps1` registers a
  scheduled task that runs the ensure script every five minutes and at logon, needing no elevation
  and storing no credentials; `-Status` reports the last tick's real exit code and `-Uninstall`
  removes it. It is deliberately the smallest possible addition: a schedule in front of the script
  that already knew how to do the work, so there is no second start path that could race the tray.

### Fixed

- **A chat put ON HOLD was still advertised as actionable on every pass.** Same split as the
  superseded bug below, in a second place: the lanes come from the gate, holds live in their own
  table, and nothing reconciled them. So a chat held precisely BECAUSE an unattended pass must not
  touch it kept being offered as "judge-then-act", which is how a hold quietly stops meaning
  anything, and the standing risk is real: a later pass reading the owner's stated preference for
  autonomy could act on the very thing the hold was protecting. A held chat's step is now
  `leave-alone`, carrying the hold's reason and the release route. It is rewritten and never
  dropped, because holds.ts is explicit that a held chat stays visible with its reason, and a hold
  outranks the superseded rewrite: archiving is exactly the unprompted deed a hold exists to
  prevent. This does not contradict `chat_act` ignoring holds, which is correct, as a direct
  request is not the machinery acting on its own initiative.

- **The pre-check could hand you an instruction the actuator refuses, forever.** `nextSteps` was
  derived from the gate, which judges a transcript on its own terms and knows nothing about
  done-marks, while `junk.supersededVisible` came from the marks table - and nothing reconciled the
  two. So a retired lineage whose transcript happened to end mid-question was filed under
  "judge-then-act", and `chat_act` (which re-gates, and does see the mark) parked it as superseded
  every single time. The advice was structurally impossible to follow and, being re-derived each
  pass, it came back forever: an orchestration that could never reach an empty queue. A superseded
  chat is now told to archive, and the reason names the route that actually works.

- **A closed account near its usage cap was reported as broken.** The usage-wall branch had no
  "is it even open?" guard, so any closed instance at 99% turned up in the unusable lane - and since
  closed is this fleet's resting state, that lane filled with accounts nobody was going to touch.
  `instance-health.ts` states the law it was breaking in its own header. The distinction is now
  explicit: DAMAGE (signed-out, no-config, unreadable profile) is still reported while closed,
  because it persists and it is precisely why a later boot would fail, whereas a transient usage
  wall only means anything about an instance that is actually open. The docs claiming "a closed
  instance is never listed" were wrong in the other direction and now describe the real rule.

- **A gating guardrail passed under `node` and failed under `bun`, which is the runtime CI uses.**
  `wmi-commandline-query-self-match.mjs` excluded itself from its own scan by comparing paths
  case-sensitively. Bun canonicalises `import.meta.url` to the real on-disk spelling while Node
  echoes the one you typed, so on a checkout reached as `...\agenthydra\...` whose folder is really
  `AgentHydra` the check stopped recognising its own file and reported the two example queries in
  its own header as violations. The existing test net could not catch it, because it drives every
  audit with a root derived from `import.meta.dir` - the same canonical spelling - so the two halves
  always agreed. Path identity is now case-folded on Windows only (on Linux and macOS two spellings
  really are two files), the main-module guard gets the same treatment because a mismatch there
  would silently skip the check entirely and exit 0, and a new test pins every check against a
  differently-cased root.

- **The delivery driver was still English-only where it mattered most, and a second audit caught
  it.** The composer - the box the whole channel types into - was found by the literal name
  `Prompt`, in a file that carries six-language lists for every other control. On a German app
  delivery would have failed at that exact line, forever, with every other rail working
  perfectly. It is now found by what it IS (an on-screen text box you can write to), which needs
  no language at all. The chat-row match had the same shape - it excluded the menu button by two
  hardcoded prefixes, English and German, so a French or Spanish app would have seen the menu and
  the row as equally valid and refused the delivery as ambiguous. It now uses the structural test
  the sibling script settled months ago.

  **And probing the real app for that fix turned up something worse.** One window had TWO
  composers, because it was showing two conversations side by side - and the code took whichever
  came first, so it could verify the right chat and then type into the other one. The composer is
  now found by climbing from the proof itself to the pane that contains it, and the Send button
  the same way. Verified against the live app: text in the left pane resolves to the left
  composer, the right to the right, and a match found in the shared sidebar - a chat PREVIEW,
  which belongs to no pane - now refuses instead of guessing.

- **An adversarial audit of the whole daemon found seven real defects; all seven are fixed.**
  Four independent reviewers went at it from different angles - what can it do wrong with nobody
  watching, what happens when things break at runtime, what is half-wired, and does it tell its
  operator the truth - and every finding was then handed to a separate agent whose only job was
  to refute it. One was refuted and dropped. These are the six that survived, plus the one the
  audit's own reviewer turned up while checking another:

  **Three could take the daemon down or drive the wrong window.** (1) The delivery actuator's
  final pre-send gate re-implemented the on-screen check instead of calling it, minus the
  offscreen filter - so the file's most important rail was the weaker of its two copies, and in
  the common path (a sidebar row we just clicked) nothing else confirms the click worked. If it
  silently no-opped, the target's own still-rendered sidebar preview satisfied the check and the
  prompt went into whatever chat was actually open. There is now ONE implementation. (2) The
  scheduler's tick had no try/catch anywhere in the file, and (3) the monitor's settings read sat
  one line above its try, in an async callback whose promise was discarded. This process answers
  an uncaught error with exit(1), so either one turned a single locked database read into the
  loss of the queue, the monitor, the courier and the API together.

  **Three more were silent rather than loud, which is worse.** (4) No `busy_timeout` was ever set,
  so SQLite threw on the FIRST lock collision rather than waiting - the fuel for both crashes
  above, and the self-updater deliberately runs two daemons together for 800ms. (5) The boot-time
  liveness probe spawned PowerShell with no deadline, and that call is what un-parks the
  scheduler and monitor: one hung WMI query left every automatic tick doing nothing for the life
  of the daemon, with no throw, no exit, and a health endpoint still answering green. (6) A
  delivery row marked `deaf` could never expire - reconcile skipped it before reaching the expiry
  check - while open rows are (correctly) never pruned and always deliverable. A stuck row was
  therefore immortal AND re-driven every five minutes forever.

  **And the courier, the one actuator that types into a real window, had no attempt cap at all** -
  archive and surface have been behind the circuit breaker since it was built. It is now behind
  it too, counted before the attempt so a crash still counts, and cleared by a delivery that
  lands. Its report also stopped lying by omission: rows past the per-pass cap were never
  visited, so they appeared in none of its lanes and a pass carrying 5 of 40 read exactly like
  one that cleared the queue. It now states what it left behind.

  The two crash-shaped defects are the same mistake twice, so they got a **guardrail instead of
  two patches**: a check that fails CI if any repeating timer's callback can throw out of itself.
  It was proven by re-introducing the real scheduler bug and watching it go red, and its
  regression fixtures are the two actual broken shapes, not synthetic near-misses.

- **Three production-readiness defects, from an audit asking "what bites in unattended daily
  use?"** (1) The courier - the thing that types into live chat windows on a timer - had no
  way to see or switch it off short of knowing a settings key existed; it is now reported in
  the sweep-loop status as `courierEnabled` and toggled through the same route, separate from
  the sweep's own switch because they authorise different things (the sweep decides, the
  courier only finishes deliveries an authorised act already staged). (2) The delivery ledger
  never pruned, so it grew forever on a daemon that runs for months; settled rows past 30 days
  are now dropped from the ALWAYS-ON courier pass rather than the off-by-default sweep tick,
  and open rows are never pruned at any age because they are work, not history. (3) The 60s
  poll called its two jobs with a bare `void`, so a synchronous throw before either function's
  own try/catch - a locked sqlite in a settings read, say - became an unhandled rejection that
  exits the process: one bad tick could kill the whole daemon instead of being skipped.

- **Rename works on non-English apps too, so the whole chat-management surface is now
  locale-independent.** The inline editor is localized as well ('Sitzungsname' on a German
  app), and - the actual blocker - Chromium materialises it LAZILY: without a fresh
  accessibility poke after the menu Invoke the element is simply not in the tree yet, which
  is what made rename look permanently impossible on that build. It is now found
  structurally (the writable Edit holding the OLD title, which separates it from the message
  composer without knowing either language) after a second poke. Renamed a real German-app
  chat end to end.

- **Six ways the courier could have delivered wrong, all found by an adversarial review of
  tonight's own code and fixed before they ever fired.** (1) The aim proof came from a
  chat's first user turn, but ~8% of sessions open with Claude Code's synthetic
  "continued from a previous conversation" preamble - identical across every such chat - so
  the actuator could have verified itself against a DIFFERENT conversation and typed there;
  compaction summaries are now skipped. (2) That same proof was matched against every
  element in the window including the sidebar's previews of OTHER chats; it must now be
  on-screen. (3) A title suffix match meant asking for 'Notes' could hit 'My Notes' - both
  scripts now REFUSE on ambiguity instead of taking the first row. (4) Re-staging a session
  only superseded a 'pending' row, so a 'deaf' one survived and the same chat could be
  delivered twice. (5) Nothing marked a row as just-sent, and the ledger cannot know until
  the app writes the receipt seconds later - a following pass would have retyped the same
  prompt; there is now a post-send cooldown, stamped on success only so refusals stay
  retryable. (6) Newest-first ordering plus a per-pass cap could starve an old row forever -
  delivery is now FIFO. Also: a failed send no longer leaves its text sitting in the owner's
  composer, and the Stop/Unarchive label tables gained their missing locales.

- **The UI archive click was silently inert on any non-English app** (found while wiring the
  courier, fixed and proven live). The row menu's accessible name is LOCALIZED - a German app
  reads "Weitere Optionen für <title>", not "More options for <title>" - so the English-prefix
  lookup found nothing and reported "the sidebar does not render <title>" for chats sitting in
  plain view. Every archive through that path was a no-op that read as a considered refusal.
  The menu is now identified STRUCTURALLY (the button that ends with the title and exposes
  ExpandCollapse), `-List` emits menu names verbatim so the caller matches by suffix against
  the exact disk title, and the context-menu ITEMS - also localized ("Archivieren",
  "Löschen") with React-churn AutomationIds - are matched against a known-label table that
  REFUSES and prints what it saw rather than guessing by position, because Delete sits
  directly below Archive. Archive verified live on the German app. Rename is NOT fixed: its
  inline editor never appears in the tree on that build, so it stays English-only and now says
  so instead of failing vaguely.

- **THREE CAPABILITIES THE RETIRED ORCHESTRATOR HAD AND THE REBUILD DID NOT** (found by
  diffing the archive branch capability-by-capability, then verifying each claimed gap):

  **Context handoff** (`context-size.ts`) - the biggest one. v1 rotated a long chat into a
  fresh thread proactively; the rebuild only helped a chat AFTER it crashed, which is the
  worst moment, because the thread that knew the plan is the one that died. A chat's current
  context is the newest request's `input + cache_read + cache_creation` tokens - the same sum
  the owner's own ctxsize tool uses, so the two cannot disagree about what "context" means -
  and chats past the warn threshold surface in the pre-start check as `handoffSoon`. A
  transcript with no usage record reads as UNKNOWN, never as zero, because an empty chat is
  the opposite of one that needs rotating. Proven live: it flagged the fullest real chat on
  the fleet at 922k tokens.

  A regression review of these three (the owner's only condition was "make sure they're not
  regressive") found the breaker could not catch its OWN motivating case, which would have
  been worse than not building it: clearing the counter on every successful archive made the
  cap unreachable for the loop where each archive genuinely succeeds and the app reverts it
  afterwards. The counter now clears only on 'surfaced' - a durable archive needs no clear,
  because the chat stops being a candidate and the window expires the count. A second defect
  fell out of the test written for that: the attempt table keyed on (kind, session,
  millisecond) and so MERGED attempts arriving in the same millisecond, under-counting exactly
  the tight loops it exists to catch. Also fixed: a suppressed row reported a fabricated
  'crashed' state instead of the chat's real one, and the handoff lane rescanned the projects
  tree for a transcript path the live registry had already resolved.

  **The circuit breaker** (`breaker.ts`) - v1 measured the failure this prevents: the same
  finished chat re-archived FOUR times in one evening, every pass individually correct (the
  archive executed, the running app re-saved the sidebar entry un-archived, the sweep saw a
  done-marked visible chat again) because nothing anywhere COUNTED. A deterministic gate makes
  a wrong verdict unlikely and does nothing about a correct verdict repeated forever. Four
  attempts per chat per action in a 6h window, on disk because a storm is exactly what causes
  a restart, cleared the moment an action sticks. It bounds the UNATTENDED path only - a deed
  the owner or an AI asks for directly is never blocked, and every suppression says what was
  held, how often it was tried, and when it frees up.

  **Same-repo collision detection** (`collisions.ts`) - a clobbering risk the owner has
  already been burned by ("work was overridden by other chats"): two live chats in one working
  tree overwrite each other, and telling one to carry on may have it commit what another is
  half-way through writing. Live chats are grouped by repository root and reported in the
  pre-start check. Report-only on purpose: two chats in one repo is often deliberate, and a
  guard that refused on this signal would refuse constantly and get switched off.

### Changed

- **`bun run test` runs its files in parallel: 34.9s -> 22.1s, a measured 1.6x** for the local
  loop. Each file already gets its own process with its own throwaway state directory, so
  there is nothing to share and nothing to race. The two slowest files were measured rather
  than guessed - dispatch.test.ts is 39% of the serial total because it drives a REAL detached
  OS process, and updater-engine.test.ts drives REAL git - and both were left alone
  deliberately: their whole value is that they are not faked.
  **CI STAYS SERIAL, and that split is the entry, not a footnote to it.** Parallel went into
  CI too and came back out the same evening, twice. Bare `--parallel` defaults to the CORE
  COUNT (32 here): 2.2x, green four runs, then three failures in dispatch.test.ts once the
  machine was busy. Pinned to four workers it passed locally three times and passed one CI
  run - then failed the next on the GitHub Windows runner, two 5s timeouts in tests that
  spawn real processes and build a real .lnk. That runner has about four slow vCPUs, so four
  workers is full saturation, and the tests that break are precisely the ones whose value is
  that they are not faked. **A green that depended on how busy the machine was is not a
  green**; locally that costs a re-run, but on a public repo it spends the credibility of
  every future red, and twelve seconds does not buy that. The honest fix, if it is ever
  revisited, is to raise those tests' own timeouts and prove it over many runs - not to widen
  the workers and hope.

- **THE COURIER'S SCHEDULER MODULE WAS DELETED** (desktop-tasks.ts and its suite, 429 lines).
  Nothing called it once the scheduler transport was demolished, and code kept for a
  hypothetical future consumer is exactly what the standing rules forbid. Git has it if the
  "start fresh work in a dormant instance" feature is ever actually built.

### Added

- **A chat can be taken off automation, one at a time, with a reason.** The fleet-wide switches
  were the only instrument available: turning the sweep off to protect ONE delicate thread
  stopped the machinery tending the other twenty, and leaving it on meant a chat someone was
  personally mid-thought in could be archived or resumed under them. A hold makes the
  unattended machinery skip exactly one chat - no archive, no surface, no delivery - while
  everything a person or an AI session asks for DIRECTLY still runs, because being asked is
  the point of asking, and a hold you cannot override is one that gets deleted in frustration
  later. It outranks the circuit breaker (an owner instruction beats a counter), it survives
  restarts, it never expires, and the reason is required and quoted back everywhere the hold
  appears, so "why has nothing happened to this chat?" answers itself six weeks later. Held
  chats stay fully visible in the pre-start check and the sweep - a chat that vanished from
  the fleet view would be worse than one that got acted on. `chat_hold` / `POST
  /api/sessions/:id/hold` / `/release`.

- **A live chat that is STUCK is now told apart from one that is busy.** Alive-and-quiet was
  reported as a single fact, so a chat frozen waiting on a background command nobody was
  present to approve looked exactly like one running a long build, and both disappeared into
  the "left alone" count. The tell (measured across five chats that froze this way): the
  newest transcript record is a tool call with no result after it, while the process is alive
  and idle past half an hour. It is deliberately narrowed to SHELL tools - file edits
  auto-approve under `acceptEdits`, so including them would flag every slow Write, and a
  detector that cries wolf gets ignored, which is worse than not having one. The verdict is
  ADVISORY: the state stays `running`, nothing acts on it, and the report says to read the
  chat first, because a genuinely long command looks identical from outside. Stalled chats
  get their own lane in the sweep report and a next-step line in the pre-start check.

- **Chats can be renamed through the app's own control, from the API.** The PowerShell layer
  gained this when the German-locale fix landed, but nothing in the daemon called it. It
  matters because an imported chat renders as 'Untitled' whatever its disk title says, which
  is both a naming-law violation and a delivery dead end - the courier aims by rendered name
  and reports those rows as no-title forever. `chat_rename` / `POST /api/chats/:id/rename`;
  generic names are refused, and an ambiguous row is refused rather than guessed at.

- **THE LOOP RUNS ITSELF** (proven 2026-08-30): with nothing touched but a staged row, the
  daemon's own 5-minute timer delivered it and the chat answered - no route call, no human.
  The sweep-loop status now records what each autonomous pass DID (`lastCourierRun`:
  delivered count plus every attempt's outcome and reason), because a timer-driven pass that
  ran and refused every row was previously indistinguishable from one that never ran, and
  "nothing happened, no error" is exactly the shape of a silently broken loop. Also banked:
  a changed DEFAULT cannot switch on an instance whose setting was explicitly stored off -
  the live daemon needed courier_enabled set, not just re-defaulted.

- **THE COURIER LOOP IS CLOSED AND ON** (courier_enabled defaults '1'). One
  `POST /api/couriers/run` now takes a staged prompt all the way to an answer with no human:
  the daemon finds the pending row, resolves its chat, derives the aim proof, types into that
  chat, the chat replies, and the ledger settles the row to delivered with the receipt -
  proven live end to end on the real fleet.
  THE SCHEDULER TRANSPORT WAS DEMOLISHED rather than left disabled: a scheduler-fired session
  is flagged unattended and the app refuses `send_message` there, so it could never deliver
  into an existing chat. Every line serving it is gone from the courier - including the
  quit/register/relaunch app CYCLING, which was risk paid for nothing. desktop-tasks.ts keeps
  the proven `fireAt` primitives (plus `ensureScheduledTasksEnabled`) for STARTING work in an
  instance, which is what that mechanism is actually good for.
  Two findings the live loop forced, both now law: a just-surfaced chat is reconciled DEAF
  within a tick (its own import parks a phantom live process), and deaf is only a dead end
  for the send_message transport - the composer drives the APP, which runs the turn - so the
  courier carries `pending` AND `deaf` rows (`deliverableDeliveries`). And the app renders an
  imported chat as "Untitled" regardless of its disk title, which stranded exactly the chats
  a courier most needs; the actuator can now identify a chat BY ITS CONTENT when the title is
  not rendered, which is safe by construction because the same on-screen proof still gates
  the send - a wrong candidate is navigated past and refused, never typed into.

- **THE DELIVERY ACTUATOR** (server/src/ui-deliver.ts + misc/Deliver-DesktopChat.ps1): the
  daemon can now put a prompt INTO a specific dormant chat and press Send, focus-free, with
  no human and no app update - the gap that had blocked the whole delivery half. It drives
  the app's own composer through UI Automation, the same mechanism the archive/rename clicks
  have used since they shipped: the composer is an `Edit` named 'Prompt' exposing a writable
  ValuePattern, and Send exposes Invoke. Proven end to end through the server module - a
  dormant chat answered "SERVER PATH ACK" with zero clicks.
  THE AIM RAILS are the entire reason this is safe, because typing into whatever had focus is
  exactly what got v1's UI injection deleted. A send happens only when: the instance matches
  by EXACT --user-data-dir; the target is reached either because it is ALREADY the open
  conversation or via its sidebar row (matched ENDS-WITH the title, since rows carry a status
  prefix like "Inaktiv <title>"); the caller's `verifyText` is VISIBLE in the conversation
  afterwards, proving the composer belongs to the intended chat (no proof = refuse, exit 4,
  never "send anyway"); the composer's SetValue reads back; and the Send button FLIPS
  disabled->enabled, which is the app's own React state confirming it saw the text (no flip =
  refuse, exit 5). A turn already in flight aborts by default rather than interrupting live
  work (exit 6). Every exit maps to a DISTINCT typed outcome - delivered / not-rendered /
  wrong-chat / composer-refused / chat-busy / error - because each implies a different next
  move. Same reach limit as the archive click: only a rendered row is actionable.

- **THE COURIER** (`GET /api/couriers`, `POST /api/couriers/run`, server/src/courier.ts + the
  courier MCP tool): the delivery ledger's fallback deliverer, and the sanctioned replacement
  for the banned relay ("you'll find other ways" - this is the other way). The daemon still
  never sends a message; for each instance with pending deliveries older than a 5-minute
  grace window it REGISTERS a one-shot task in that instance's OWN desktop-app scheduler
  (desktop-tasks.ts - written for exactly this, until now with zero callers). The app then
  fires a fresh session - the system's own hands, never one of the owner's threads - whose
  entire prompt rides inside the task's SKILL.md: the staged rows BAKED in verbatim inside
  nonce-carrying fences (content cannot forge a boundary), MCP-only delivery via the app's
  native send_message, an explicit no-shell rule (a scheduled session can freeze forever at
  an approval prompt nobody is present to click), a 24h staleness guard, and a
  no-self-archive rule. Task ids are per-instance ('orch-courier-<slug>-<hash>') because
  SKILL.md files live in the shared ~/.claude tree; signed-out instances are refused (a task
  in a stale account leaf never fires but reads as one that did) and their stuck rows block
  the disarm lane from claiming a clear queue; unroutable rows carry honest reasons.

  **THE CHANNEL IS SOLVED (2026-08-30, owner: "you will find a way around this. End of
  story." - and no app update was involved).** Extracting the desktop app's own asar and
  reading its scheduler source turned three "dead" drills into three fixable mistakes, each
  now measured rather than guessed:
    - A one-shot must be a **`fireAt` timestamp, not a cron**. Cron slots EXPIRE, so a
      single-minute cron one-shot is skipped forever the moment its exact tick is deferred by
      any startup gate; a `fireAt` row is retried every 60s tick until it fires, and the app
      then logs "Auto-disabled one-time task after fire". The old fleet-wide probe tasks only
      ever fired because they were RECURRING crons.
    - The prompt must sit at the app's **hardcoded** `~/.claude/scheduled-tasks/<taskId>/
      SKILL.md`; the task row's own `filePath` is ignored (the app's main.log said so
      outright: "Skipping ... task file not found at ...").
    - The feature is gated on `preferences.ccdScheduledTasksEnabled` in the instance's
      claude_desktop_config.json, which defaults false.
  With those three right, an externally-written task FIRES: proven live, a fired session
  replied "SCHEDULER FIRE ACK". **But a scheduler-fired session cannot relay:** it is flagged
  UNATTENDED and `ccd_session_mgmt send_message` refuses there verbatim - "This tool is
  unavailable in unattended sessions (scheduled-task runs and remote-dispatched trees)". So
  the scheduler can start work; it cannot deliver INTO an existing chat.
  **The delivery channel that DOES reach a specific dormant chat is the new
  `ui-deliver.ts` + `misc/Deliver-DesktopChat.ps1`** (see its own entry below), proven end to
  end through the server module: a dormant chat answered "SERVER PATH ACK" with zero human
  input. courier_enabled stays '0' only until the courier is rewired onto that actuator; its
  scheduler machinery now writes the correct `fireAt` shape and can ensure the feature flag:
  registration always happens against a closed app (closed = register-then-open; running =
  prove-idle-then-cycle, where "idle" is the self-kill ancestry law - every live session's
  tree verified to hang off some OTHER app, could-not-check means hold, a session appearing
  mid-check means hold, dead-pid registry residue filtered as crash evidence). Act-mode
  passes run inside the process-wide act lock (a cycle can never pull an app out from under
  a mid-flight gate deed), decide from fresh process state, never bake a row younger than
  its own grace window, reopen the app when a post-quit registration fails, cap cycling at
  45 minutes of failed attempts, and mark cleared-but-running instances disarm-pending
  instead of writing into a store the app clobbers back. Housekeeping is a re-entrancy-
  guarded 5-minute cadence plus fresh-after-tick, gated only by courier_enabled (never
  synced), with a durable lastCourierError in the sweep-loop status.

  THE RECEIPT HARDENED with it, both holes caught live by the drill: delivered now means the
  transcript gained TIMESTAMPED message records (queue-operation/user/assistant) after
  staging - the app appends timestamp-free bookkeeping (atis-latch, mode) to imported chats,
  and the old bare-mtime receipt read exactly that as a delivery that never happened. The
  tail scan widens to the whole file before concluding no-receipt (a giant trailing
  tool-result line must not bury the real records), bookkeeping records are never receipts
  even if they someday carry timestamps (warned as schema drift), and the expiry evidence
  says "no timestamped activity found" instead of claiming a vanished transcript. The
  one-shot cron's year correction is symmetric (armed Dec 31 for Jan 1 no longer reads a
  year late). Two adversarial review rounds (38 agents; 26 findings confirmed and fixed, 4
  refuted). Cleanup: 18 broken recurring courier-probe tasks the retired v1 probing had left
  registered across the whole fleet (all pointing at deleted SKILL files, firing-and-failing
  in any instance the owner opened) were removed, and the test suite no longer writes SKILL
  dirs into the real ~/.claude (taskSkillPath honors the test-state override).

- **THE DELIVERY LEDGER** (`GET /api/deliveries` + server/src/deliveries.ts + the deliveries
  MCP tool): the deterministic half of the delivery story. Every prompt the act path stages
  for a surfaced chat is now a tracked row instead of a hope - until now a surfaced chat
  whose prompt nobody sent sat dormant forever, indistinguishable from delivered-and-thinking
  (the one-shot silent-loss shape the import-retry lesson warned about). States settle from
  evidence on every read and on every standing-sweep tick: delivered (the transcript moved
  after staging - a delivered prompt lands as a user turn, so that is the receipt), deaf (a
  process started after staging but the transcript never moved - the engine-never-started
  orphan flavor, now a ledger state instead of a six-hour mystery), expired (24h unclaimed,
  reason kept). One pending row per session; a re-surface replaces the prompt. The pre-start
  check lists pendingDeliveries so outstanding sends are the first thing any orchestration
  sees. WHO SENDS is unchanged and deliberate: an AI session's native per-instance channel or
  a live-peer message - never the daemon (no channel by design), never a relay through the
  owner's working chats (banned 2026-08-28), never headless. Live-proven: a real surfaced act
  staged a real pending row, and transcript movement flipped it to delivered with the receipt
  in evidence. Adversarially reviewed pre-ship (9 findings fixed, 1 refuted): the receipt now
  reads the transcript's EXACT mtime instead of a second-rounded reconstruction that could
  both fabricate and erase receipts; a re-surface SUPERSEDES the earlier pending row with the
  reason kept instead of deleting it; deaf is semi-terminal (a late-starting engine upgrades
  it to delivered); a vanished transcript is named in the expiry evidence; and a failing
  tick-reconcile is a durable status fact, not a console line.

### Changed

- **The prestart's contradiction lane now tells the story** (owner-decoded 2026-08-30: all
  three of the first run's liveButDoneMarked entries were FALSE marks from a migration that
  never completed - the chats were never supposed to be retired, and he had resumed and
  managed them himself). Each row now carries markedAt, liveSince and the verdict the
  timestamps prove: 'revived-after-mark' (deliberately resumed after retirement) or
  'marked-while-live' (the mark landed on a chat that never even stopped). The guidance
  encoded with it: such a mark is usually the lie - read the chat's tail, then clear it via
  the done route (done:false); never archive under the running writer. The marks table's
  mixed timestamp formats (epoch-millis from the done route, ISO from older writers) are
  parsed both ways. The three false marks were cleared the same day; the post-cleanup live
  prestart reads a fully clean fleet.

- **THE PRE-START CHECK** (`GET /api/prestart` + server/src/prestart.ts + the prestart MCP
  tool; owner-ordered 2026-08-30). READ-ONLY, in the owner's required order: the CENSUS first
  (how many instances are OPEN - with plan and usage per account - then every chat across
  them), then the full pure-report gate sweep, the big-picture next step per chat (archive /
  surface-and-deliver / judge-then-act / wait-for-reset / investigate), and the junk lanes:
  done-marked lineages still visible in a sidebar (testing leftovers to archive),
  naming-law violations, and liveButDoneMarked CONTRADICTIONS - a retired lineage actively
  running, the owner's to untangle, never automation's to archive under a running writer
  (that lane exists because the very first live run found three). THE SANITY RAIL, verbatim
  from the owner: one (or zero) open instances means the census is WRONG - "I pretty much
  never only have one" - so sanity.plausible:false tells the caller to stop and investigate
  instance detection before acting on anything. Live: 885ms over the real fleet (3/18 open,
  11 chats), and its junk lane immediately caught 7 real testing leftovers - 4 were archived
  through the proven machinery on the spot, 3 were live-and-done-marked contradictions left
  for the owner by name. The post-cleanup re-run reports a clean fleet: 8 chats, all
  running/human, zero junk, zero next steps. Adversarially reviewed pre-ship (9 findings
  fixed, 4 refuted): the queue PATCH door could flip a row to new_chat without the defaults
  (closed); deadline-cut chats vanished from nextSteps (now explicit investigate rows); the
  junk dedup was weaker than the sweep's (now the same two-set rule); entries with no
  recorded transcript id silently passed both junk checks (now counted as
  identityUnresolvedCount, never guessed); and a throwing sweep discarded the census (now
  reported beside it as sweepError).

- **NEW-CHAT DEFAULTS: "Opus 5 Ultra code"** (owner-ordered 2026-08-30, decoded against the
  machine rather than guessed: no 'ultra' model or effort exists anywhere - the CLI ladder
  tops at max, and the thing a level ABOVE max is ULTRACODE, Claude Code's exhaustive session
  mode, armed by the literal keyword in the prompt). Every automated NEW chat now starts on
  model 'opus' with the ultracode keyword prepended to its first prompt
  (server/src/new-chat-defaults.ts, applied at the queue-create insert and in
  launchTerminalSession; resumes untouched; an explicit model or ultracode:false is the
  compelling-reason escape and always wins; settings new_chat_model/new_chat_ultracode sync
  across machines as preferences). SMOKE-TESTED live as the owner required: a pinned
  single-turn probe with a sanitized env confirmed --model opus launches and runs on
  claude-opus-5.

- **LOAD-BALANCING MIGRATION** (the owner's standing order: "migrate chats between accounts.
  Properly. for load balancing"). A crashed (or autonomously-answered) chat whose home account
  is PROVABLY at/over the 85% threshold right now - a fresh reading on either window
  (saturatedNow, one definition in monitor.ts) - no longer resurfaces onto that wall: it is
  MIGRATED to the best other account (highest tier, then lowest weekly; the saturated home
  excluded from the pick; the target must itself be under the threshold - hot-to-hot buys
  nothing). Mechanics are LAND FIRST, FLAG SECOND (the adversarial review confirmed a
  flag-first draft could hide the chat from every sidebar on a lost write, a thrown landing,
  or a failed restore): nothing is flagged until the new home exists, a failed or thrown
  landing owes zero cleanup and surfaces the chat at home, and a source flag that fails to
  stick is a WARNING in the result, never papered over. The target needs POSITIVE proof of
  headroom - a fresh reading under the line on both windows for a running account, the
  aged-cache standard for a closed one - so an unverified account is never migrated onto;
  stale or unknown home usage never migrates at all. Superseded now outranks every crash kind
  including the usage wall (the review caught wait-for-reset promising a resumeAt for a
  retired lineage), and a sweep act that throws becomes a parked row instead of killing the
  whole sweep. 10 review findings fixed pre-ship, 1 refuted; 9 new fixtures. Live-proven
  under real saturation: a crashed subject homed on the genuinely hot account (session 88%,
  fresh) migrated to the top-tier coolest account with its resume prompt attached, source
  store left clean - a run that also caught a real bug (the desktopHomeFor label leak, below)
  the fixtures could not.

### Fixed

- **The recurring "command prompt that says starting"** (owner-reported): every auto-update
  relaunch routed the successor daemon (a console-subsystem bun process) through WMI's
  Win32_Process.Create, whose default STARTUPINFO gives a console program a REAL, VISIBLE
  console window - the detached-spawn primitive's own header had warned about exactly this
  since 2026-07-12, and the dispatch-runner fixed it for itself on 2026-07-15, but the
  relaunch path never did. buildDetachedSpawn (kit, lunarwerx-ui 18848e7) gains an opt-in
  hideWindow (Win32_ProcessStartup ShowWindow=0); the relaunch passes it. Same fix landed in
  RepoYeti, DevWebUI and ReDesign, whose relaunch paths shared the bug; the running daemon
  was hand-swapped onto the fixed code (WMI-created, hidden, verified handle 0). The two
  other console-flashing culprits on the machine (two hourly scheduled tasks launching a
  .cmd/powershell directly) were rewrapped through a windowless wscript wrapper
  (~/.claude/tools/run-hidden.vbs), live-verified result 0.

- **desktopHomeFor leaked the instance LABEL instead of the DIR** for every index-resolved
  chat (the fallback filename walk returned a dir, the index hit returned 'pap3r'-style
  labels) - live-drill-confirmed: the gate's home-instance matching parked real homed chats
  as "not a managed instance", and the /api/sessions/:id/automation route passed the label
  into a dir-expecting stamp. Now resolved through instanceDirForLabel, the one shared
  label-to-dir mapping.

- **The STANDING sweep** (`GET/POST /api/sweep-loop`, `POST /api/sweep-loop/check`,
  server/src/sweep-loop.ts, the sweep_loop MCP tool): the daemon runs the gate sweep on a
  schedule, so the fleet is gated and the safe deeds happen with no AI awake. Monitor-pattern
  rails: OFF by default (flip `enabled` when ready); unattended-safe caps by default - archive
  unlimited (click-verified, reversible) but surface 0, because an unattended tick has no one
  to deliver a surfaced chat's prompt; the last run's full report is kept and served (bounded
  to 100 rows per lane, flagged when cut) beside lastError and an overlap-skip counter, so a
  failing or blocked loop can never impersonate a healthy idle one. Ticks stamp their own
  start (a slot blocked by an in-flight tick retries next poll instead of being silently
  consumed - review-confirmed), a manual check-now resets the schedule, and settings live in
  DEFAULT_SETTINGS + the machine-local (never-synced) list beside the monitor's switch.
  Auto-update's busy check now also refuses to relaunch the daemon while a sweep tick or ANY
  act (UIA click, instance boot/import) is in flight. Review: 11 confirmed findings fixed
  pre-ship (schedule-slot swallowing, the 1970 nextDueAt, the relaunch-mid-click hole, strict
  route validation replacing silent clamps, the absent-setting-reads-as-zero default bug
  caught live) - plus the repo's own settings-sync guard caught the four new keys
  unclassified. Also retired the leftover v1 'Orchestrate' loop chat found crashed in 5claude
  (archived by id, done-marked - waking it would have revived the retired v1 wake loop).

- **The SWEEP** (`POST /api/chats/sweep` + server/src/gate-sweep.ts + the chat_sweep MCP
  tool): gate every visible desktop chat - or exactly the given ids - and act on the verdicts
  in one call, sequentially, within caps (surface 3 by default, archive unlimited; 0s make a
  lane report-only, and 0/0 is a genuinely pure report). Running and human-interrupted chats
  are left alone; archive-candidates archive (with the click-through); crashed chats surface
  with the EXACT resume prompt and instance in the row for the caller to deliver; usage-limit
  crashes report their reset; the needs-input lane is packaged for the caller's judgment,
  never auto-acted. A wall-clock deadline lists anything it cut off as unswept. Acts now hold
  a PROCESS-WIDE lock (withActSerialized) shared by the sweep, the direct act route and the
  auto-resume monitor's landing, so two callers can never drive the app's UIA menus or
  Electron's single-instance import at the same moment - and an archive act re-checks the
  live registry right before the UI click, skipping it when a person resumed the chat
  mid-act. Adversarially reviewed pre-ship (11 confirmed findings fixed, 4 refuted): among
  them, an empty session_ids list would have detonated into a fleet-wide sweep (now sweeps
  nothing), surfaced rows lacked the very prompt the caller must deliver, rows echoed a stale
  pre-act verdict, and one transcript imported into two instances was swept twice (now
  deduped by resolved id - which the live drill then proved against the real fleet: 10 rows
  became 9). Live: fleet-wide pure report over the real machine in ~360ms, and a scoped
  acted sweep took a fabricated finished chat through archive-flag + the app's own Archive
  click, verified by id.

- **Three owner rulings on the act path, encoded (2026-08-30).** (1) Auto-archive under a
  RUNNING app now CLICKS the app's own Archive itself (server/src/ui-archive.ts driving
  misc/Manage-DesktopChat.ps1) so the chat leaves the sidebar immediately - with hard safety
  rails: the click fires only when the chat's real disk title is rendered exactly once in that
  instance's sidebar (rendered names are in-memory and can differ from disk - measured), and
  success is verified BY ID on disk afterwards, never by title; anything else is an honest
  no-click and the flag sticks at that instance's next restart. (2) An ALL-CLOSED fleet may now
  open an account when a chat needs a home - and any account automation opens must itself have
  a KNOWN cached reading under the 85% threshold ("just make sure that it is underneath our
  threshold"): no reading means no boot, and a saturated closed home parks with the reason.
  (3) Account-tier preference: Max 20x > Max 5x > Max > Pro > everything else
  (fleet-instances.ts planRank), applied before the lowest-weekly-usage rule everywhere the
  landing picker chooses - "We always will prefer the highest one. AKA Max 20x. and the lowest
  usage." A chat's own pinned instance still outranks tier.

  Adversarially reviewed before shipping (8 confirmed findings, all fixed): the DEFAULT
  %APPDATA% Claude install was structurally invisible to both instance discovery and the UI
  tool's process scan (no --user-data-dir flag), so the owner's primary app could never
  receive the click and was falsely reported durable - the PS1 now recognizes a flagless main
  process as the default profile, and unmanaged profiles get the click attempt (the tool
  itself answers whether the app runs); the PS1's -Instance substring match could hit the
  wrong instance (i1 vs i10) - path-shaped hints now match exactly; "make sure it is
  underneath our threshold" now demands PROOF on both windows (a session reading, or a cache
  older than the 5-hour window itself - the normal state of a closed app); exit 2 from the
  click tool polls the disk flag instead of discarding a click that merely lagged; titles are
  matched VERBATIM end to end (trimming made exact-name clicks miss); stderr from the tool
  rides along so a thrown UIA call is diagnosable. Live: full click loop proven on the real
  machine three ways (refused when ambiguous, clicked-and-verified by id, idempotent re-act
  settles), and planRank verified against all 18 real accounts' labels.

- **Orchestrator rebuild, piece 9: ACTING ON GATE VERDICTS** (`POST /api/chats/:id/act` +
  server/src/gate-actions.ts + the chat_act MCP tool; owner-ordered 2026-08-30: "yes gate
  verdicts should be acted on"). The act call re-runs the gate itself (a caller-supplied state
  is never trusted) and performs the deterministic deed: running or human-interrupted chats are
  left alone; a finished archive-candidate gets its archive flag written with durability
  reported honestly (a running app's memory-wins caveat is stated, never hidden); a crashed
  chat is SURFACED dormant into a running desktop app - re-imported into its own home, or
  landed in the best-headroom instance when homeless - and the result carries the deterministic
  resume prompt the caller must deliver through the app's native message channel (the measured
  wake path; the daemon deliberately has no messaging channel of its own); a usage-limit crash
  waits for its reset instead of re-hitting the wall. The needs-input-review lane carries the
  ONE AI step by contract: the caller supplies decision autonomous (with the answer text - the
  owner's stated preference) or human, and the server only executes that judgment.

  **THE 85% OVERFLOW RULE** (owner, 2026-08-30, hard-coded at 85 by his word -
  LANDING_OVERFLOW_PCT): landing may open a CLOSED signed-in instance only when every OPEN
  candidate has PROVABLY exceeded 85% on either the 5-hour or the weekly window - proof means
  a fresh reading, so automation never boots an app on a stale number or a guess; and NOT
  vacuous - with nothing open at all the rule cannot truthfully hold, so an all-closed fleet
  parks honestly (adversarial review caught the first cut treating it as vacuously true). A
  usage-limit crash reports the BINDING window's reset (a pegged weekly wins over a sooner
  5-hour reset - the same review caught the first cut always preferring the session reset),
  and a signed-out home instance parks instead of being booted or imported into. One
  definition (closedLandingEligible +
  pickLandingInstance in monitor.ts, now returning mustOpen) shared by the act path and the
  auto-resume monitor's landing, whose delivery now routes through the same
  landSessionInDesktop. Verified: 28 fixture tests over every deed and the overflow
  boundaries; live drill on the real machine - a real running session left alone, a finished
  homeless subject honestly at rest, and a crashed fabricated subject landed for real into
  running instance #13 (metadata created by the app, titled per the naming law,
  bypassPermissions stamped), then retired through the app's own UI.

### Fixed

- **Four review-confirmed misclassification holes in the piece-8 gate** (adversarial review of
  fe8907a; each pinned by a regression test). (1) A single closing record larger than the 64KB
  tail window parsed as zero records and gated as crashed mid-turn - the read now grows the
  window (x4 up to 4MB, matching fleet's classifier) until a record speaks or the whole file is
  read. (2) An assistant record with prefacing text AND a dangling tool_use counted as a
  completed turn - a transcript ending on a tool call whose result never landed is now crashed
  mid-turn regardless of text. (3) A done-recap merely QUOTED in a code fence or blockquote
  faked done:yes and routed real waiting-on-input chats to archive-candidate - recap detection
  now reads a view with fenced blocks and >-quoted lines stripped (recapView). (4) A sidechain
  record appended after the real last turn hijacked the verdict - isSidechain records are
  skipped. Gate tests 14 -> 18, suite green.

- **A RUNNING instance could read as "not running" to the import/archive path when the caller
  spelled the dir with forward slashes** (defaultInstanceRunning compared dirs without
  normalizing slash style). Found live during the owner's account-switch drill: temp1 was up
  for hours while importSessionToDesktop refused with instance-not-running. Both comparison
  sides now normalize. The drill then completed end to end: a chat created on one account
  (visible terminal pinned to its credentials, marker reply verified) imported into another
  account's running desktop app and archived there through the app's own UI.

### Added
- **Orchestrator rebuild, piece 8: THE GATE** (`GET /api/chats/:id/gate` +
  server/src/chat-gate.ts + the chat_gate MCP tool; owner-specified). The mandatory
  pre-action call: one deterministic answer to what state a chat is in. running (process
  alive - leave it; quietSecs reported since long quiet can be background work), crashed
  (died without finishing: mid-turn on an unanswered message or closing tool traffic,
  usage-limit, overload, refused, error - the resume candidates; dead-pid registry residue
  is cited as evidence, restored from v1's orphan detection), or finished - pre-classified
  by stated rules into archive-candidate (recap claims done, nothing asked),
  needs-input-review (awaiting an answer; the ONE AI judgment in the design - can it be
  answered autonomously, the owner's preference, or must a human decide - with the evidence
  packaged: lastAssistantText, doneClaim, endsWithQuestion), or human (deliberately
  interrupted). A session with no transcript gates to 404 - what cannot be gated cannot be
  acted on. The adaptive tail reader is now shared (one definition) between fleet and gate.
  Verified: 14 fixtures covering every state, kind and lane; live: all 6 running sessions
  gate as running, 8 real non-live transcripts classify correctly (finished work ->
  archive-candidate done:yes, an interrupted chat -> human, a killed drill -> crashed
  mid-turn). Suite 1341/0; both localci legs clean.

- **Consolidation pass over the rebuild day (owner-ordered review): deduplicate, simplify,
  enforce.** One definition now exists for each thing four modules had grown privately: the
  path comparison key (new server/src/path-key.ts - two of the day's review-confirmed bugs
  were this helper done slightly differently), the transcript-record text extractor (moved
  beside classifyEnding in session-ending.ts), and the automated landing-title chain
  (resolveAutomatedTitle in chat-title.ts, shared by the queue import and the monitor
  landing). enqueueResume's dead migrate-on-limit machinery (unused override param, four
  permanently-false branches, write-orphaned import columns, a comment narrating removed
  behavior) is gone. The chat tool is renamed misc/Manage-DesktopChat.ps1 (it archives,
  unarchives, renames and lists), all references updated, and a new drift-guard test binds
  its hand-copied naming regexes to chat-title.ts's canonical patterns so the two can never
  silently diverge - a keep-in-sync comment is not a mechanism. Stale tombstone lines about
  terminal resumes corrected; the three fabricated drill transcripts deleted from the
  transcript store. Suite 1326/0, localci clean.

- **Orchestrator rebuild, piece 7: NO CONSOLE IN AUTOMATION** (owner ruling, 2026-08-29:
  console is only ever for chats a person deliberately created in a console; a chat with no
  desktop home is MIGRATED to a desktop, never resumed in a terminal). The monitor's
  terminal-resume path is deleted: a homeless due resume now LANDS in a desktop app by
  import - target picked deterministically (its own pinned instance when running, else the
  running signed-in instance with the most fresh weekly headroom, ties by permanent #num;
  closed instances are never opened), named per the naming law, and the row closes honestly
  ('landed in instance #N; resume it there') or parks with the reason when no target or no
  real name exists. ResumeSurface's vocabulary is now native|land - there is no 'terminal'
  member to regress back to. The migrate route's terminal fallback is likewise deleted:
  every migration lands in the target app. launch-terminal remains a user-explicit primitive
  only. Verified: 4 landing-pick fixtures (pinned-wins incl. slash-style, headroom ranking,
  stale-usage demotion, honest-null) + surface pins + suite 1325/0 + live inventory showing
  zero console sessions on the machine.

- **Orchestrator rebuild, piece 6: focus-free in-app RENAME** (misc/Archive-DesktopChat.ps1
  -Action Rename -NewTitle; owner-picked - fixes the 'lands as Untitled in the running
  window' display boundary). Drives the app's OWN Rename control: menu item Invoke, the
  inline editor's ValuePattern.SetValue (focus-free), and a posted WM_KEYDOWN Enter to the
  render widget as the commit - no SetForegroundWindow, no cursor. Because the app performs
  the rename, it is the one name-write a running app cannot undo: disk and app memory agree
  afterwards (verified live both directions). -NewTitle enforces the naming law (generic
  non-names refused, canonicalized matching mirroring chat-title.ts). Commit loop verifies
  the editor holds the text and retries the posted Enter (it can race the editor's first
  paint); the editor is searched across every top-level pane (it can live outside the main
  window subtree). Proven live on a disposable subject: imported titled, rendered generic
  in-memory, renamed via the tool, row + disk both showing the new name, then archived.
  Also: the five leftover v1 courier chats on the temp1 account were archived durably
  (disk flags + a clean instance cycle via the lifecycle primitives).

- **Piece 5 hardened by adversarial review (2 confirmed bypasses closed).** The queue's
  auto-import path landed chats with a null or generic title, never passing the route
  contract - the law now holds at the CHOKEPOINT: importSessionToDesktop itself refuses a
  generic/missing title (no bypass flag), and the automated path resolves a real name
  deterministically (row title, else the session list's title) or fails honestly in the
  queue row. And generic names disguised with zero-width characters or doubled whitespace
  ('Untitled' + U+200B, 'new  chat') now canonicalize before matching. Both pinned by
  regression tests.
- **Orchestrator rebuild, piece 5: the naming requirement** (server/src/chat-title.ts;
  owner directive: a chat must never land with a generic name). import-desktop and migrate
  now REQUIRE a title decision: `title` (a real, non-generic, non-plumbing name) or
  `confirm_title` (the current title restated exactly - accepted only when that title is a
  real name, and a mismatch is refused WITHOUT echoing the actual title, so review is proven
  by reading, not by copying the error). One definition of generic/plumbing now shared with
  the title janitor. The MCP import tool speaks the contract. Verified: 7 contract fixture
  tests plus a live, CONSOLE-FREE drill (owner rule: no console windows without a very good
  reason) - a fabricated minimal transcript walked all three refusal doors, landed with the
  required title, disk title verified exact, then archived through the app's own UI.


- **Piece 4 hardened by adversarial review (2 confirmed bugs fixed, 1 more taken).** The
  `identityStale` flag was structurally unreachable - resolveAccount's cache guard already
  discards an identity whose uuid mismatches the fresh login (accounts-stale-login.test.ts
  pins it), so both sides of the comparison were always equal; the flag is removed rather
  than shipped dead. resolveAccount's noNetwork path decrypted the OS token cache per call
  before ever checking noNetwork - every fleet read paid an OS decrypt per instance; the
  check is hoisted so noNetwork does zero decrypt (grant-derived fallback fields honestly
  null for never-cached instances). And /api/fleet's sections now fail independently: a
  broken store nulls its own section and names itself in `errors` instead of 500ing the
  whole observation.
- **Orchestrator rebuild, piece 4: account identity** (`instances` key on `GET /api/fleet`,
  server/src/fleet-instances.ts, plus per-session `instanceRef` attribution in fleet.ts;
  owner-picked). Deterministic, read-only, ZERO NETWORK: every desktop instance with its
  permanent #num, name/label, dir, 'desktop:<dir>' ref, running state + pid, fresh loginUuid
  (who is signed in RIGHT NOW), and the cached token-free identity (email/plan) from
  resolveAccount's no-network path. `identityStale` flags an instance re-logged into a
  different account than the cache describes - reported, never hidden. Live sessions now carry
  which instance hosts them, closing the identity joint between sessions, usage refs and
  instances. Start/stop deliberately stays with the existing tested primitives
  (openInstance/quitInstance and their routes); observation observes. Verified: 5 fixture
  tests (identity join, stale flag, unknown honesty, resolver-failure tolerance, #num
  ordering), a live identity read (18 instances, each with email+plan, 498ms, running set
  matching the process list), and a live lifecycle drill on instance #2: identified ->
  started (pid confirmed, identity unchanged) -> quit (8 processes, graceful) -> confirmed
  closed.

- **Piece 3 hardened by adversarial review (3 confirmed bugs fixed before the piece counts as
  done).** Sequential git calls stacked their 3s timeouts (measured ~48s worst case across four
  hung repos); all calls now run concurrently - across cwds, across repos, and the three facts
  within a repo - so the worst case is one timeout width (live fleet read: 216ms -> 86ms).
  Unconditional lowercasing of dedupe keys silently VANISHED one of two case-differing repos on
  case-sensitive filesystems; folding is now platform-gated (win32 only, test-overridable). A
  failed branch read reported detached:false / offMain:false as if known; both are now null
  when the branch is unknown. Each fix is pinned by a regression test (in-flight-overlap
  counter, case-sensitivity pair, null honesty), plus a new test pinning that usage ordering
  ranks by the weekly limit only.
- **Orchestrator rebuild, piece 3: git hygiene** (`git` key on `GET /api/fleet`,
  server/src/fleet-git.ts; owner-picked). Deterministic and read-only: for every repo the live
  sessions work in (deduped by `rev-parse --show-toplevel`), the branch, detached state,
  offMain flag (work happens on main - standing owner rule), `status --porcelain` dirty count,
  and commits ahead of upstream (null when no upstream). Every fact is git's own answer, never
  an inference; a git failure yields nulls plus the error string - "0 dirty" and "could not
  ask" must not look alike - and each command carries a 3s timeout so a lock contest with a
  concurrent session cannot wedge the endpoint. Dirtiest first, deterministic. Verified: 8
  tests against REAL git fixtures (non-repo, clean main, dirty+feature branch, detached HEAD,
  cwd dedupe, real-upstream ahead=2, failure honesty, ordering; all with explicit spawn
  timeouts) plus a live read matching direct `git status` counts exactly (216ms for the fleet).

- **Orchestrator rebuild, piece 2: per-account usage bands** (`usage` key on `GET /api/fleet`,
  server/src/fleet-usage.ts; owner-picked). Deterministic and read-only over the existing
  usage cache - no probes, no network, zero AI. Bands are the proven vocabulary (ok < 80 <=
  elevated < 85 <= high < 90 <= critical) as named constants, deliberately not settings until
  a piece that ACTS on bands needs tuning. Reset times prefer the API path's exact ISO
  timestamp over parsed text; missing data bands as 'unknown', never as fine; staleness
  (cache entry older than 30 min = not being refreshed) is a reported fact, never a filter -
  the real cache carries weeks-old entries and hiding them would make "no data" look like
  "fine". Worst-first deterministic ordering. Verified: 5 fixture tests (band edges exactly
  at 80/85/90, ISO-vs-text reset derivation, staleness incl. undated, unknown banding,
  repeatable ordering) plus a live read of the real cache (24 entries, 1.3ms) matching the
  raw JSON values.

- **Orchestrator rebuild, piece 1: the fleet observation core** (`GET /api/fleet`,
  server/src/fleet.ts). Owner-led rebuild doctrine now binding on every piece: one feature at
  a time, comprehensively verified before the next, and as programmatic as humanly possible -
  deterministic code over AI inference wherever a rule can be stated. This piece is 100%
  deterministic and read-only: which sessions are live (pid-validated registry) and what state
  each is in - transcript ending through the SAME classifyEnding vocabulary the session list
  already trusts (complete / interrupted / usage-limit / overload / refused / error), plus
  quiet time, sorted quietest-first. Adaptive tail window (64KB growing to 4MB) because real
  transcripts carry multi-MB single lines; torn first lines are dropped, unreadable files are
  reported rather than hidden, and the usage probe is filtered by its exact scratch cwd.
  Verified: 8 fixture tests (every ending class, window growth past a 100KB record, torn-line
  rule, probe filter, deterministic ordering), plus a live read of this machine's real fleet -
  7 sessions in 8.6ms, matching the peer registry exactly. Zero AI, zero writes, zero settings.

- **misc/Archive-DesktopChat.ps1: archive a chat in a RUNNING desktop app - immediately,
  durably, and FOCUS-FREE - by driving the app's own sidebar controls** (owner's mechanism,
  2026-08-29). Wakes the Electron accessibility tree (MSAA poke on the render widgets - a UIA
  query alone sees bare panes), then opens the row's "More options" menu via
  `ExpandCollapsePattern.Expand()` and fires "Archive" via `InvokePattern.Invoke()`. Both are
  pure UI-Automation calls: no SetForegroundWindow, no cursor, and Invoke targets that exact
  element so it can never hit the "Delete" item beneath Archive (safer than the coordinate-
  click first cut it replaced). The app performs the archive itself, so the row leaves the
  sidebar instantly and the flag survives the app's memory re-saves - what the disk-flag path
  could never give under a running app. Two measured limits: reach is RENDERED rows only
  (collapsed/virtualized rows aren't in the tree; the tool expands the chat's group to help,
  and reports exit 3 rather than faking it); and CDP is not an alternative - Claude Desktop
  EXITS when launched with `--remote-debugging-port` (proven A/B), so it refuses remote
  debugging. Proven live on 5claude (disk flag flipped, verified); `-List` enumerates rendered
  rows. The desktop-archive endpoint's running-app note now names it.

### Removed

- **The v1 orchestrator, whole** (owner order, 2026-08-29: retire it and rebuild from the
  ground up). The watcher daemon, worklist, courier ladder, circuit breaker, reviewer
  journal, self-test, Codex watcher, agent chats, proposal ledger, placement balancer,
  backlog sweep and new-chat opening policy; the `/api/orchestrator/*` HTTP surface; seven
  MCP tools; the settings UI panel and its locale; the shipped `/orchestrate`, `/orcstop`,
  `/orcstart` commands and their installer; sixteen test files. The complete final state is
  archived on the `archive/orchestrator-v1` branch (tag `orchestrator-v1-final`); see
  docs/ORCHESTRATOR-RETIRED.md for what was kept and why. Session primitives survive:
  migrate, import-desktop, desktop-archive, automation stamping, launch-terminal, the chat
  dossier (now without ledger/kv joins, reading the live registry from the extracted
  `live-registry.ts`), and the auto-resume monitor in its pre-orchestrator shape (scheduled
  terminal resumes; desktop threads are closed out honestly as "ready in its app" -
  migrate-on-limit and proposal-gated native revives are gone). Existing databases keep
  their now-inert `orchestrator_*` tables and `orch_*` rows; fresh installs never create
  them.

### Added

- **The agent-chat courier: the sanctioned replacement for the banned relay rung** (9f48041).
  The relay ban (5505a09) honestly parked every delivery into another instance's dormant
  chats; the owner's follow-up was that the removal must not cripple any functionality. Each
  instance now gets ONE system-owned courier chat, marker-titled "Orchestrator agent - do not
  use" (`server/src/orch-agent.ts`), whose only job is performing composed delivery steps
  inside its own instance. `computeRoute` gained the rung: target dormant elsewhere AND that
  instance has a LIVE agent chat -> a `SendMessage` to the AGENT chat carrying the target's
  real chatId and a fenced verbatim payload. Admission is the title marker and nothing else;
  a working chat there is never a route, and a test now pins the ban itself. The janitor
  sweep surfaces "instance X has no agent chat" as `seed-agent` proposals through the normal
  action gate; the executor seeds into the instance's own profile dir, records a kv stamp,
  and verifies bypassPermissions against the app-boot re-save race (4d17558) before the boot
  step goes out. Rails: the monitor never counts the courier as a working chat (no idle/
  nudge/handoff items, no concurrency slot), it never occupies a repo, the janitor and the
  archive executor refuse to retire it while its instance still has other chats, a courier
  whose title the app wiped gets a pending rename back instead of a duplicate, and its
  deliveries verify by the same contract as every delivery: the TARGET's transcript must
  move. The dry run prints an `agent chat:` line per instance so "no courier" and "quiet
  instance" can never look alike. Extended the same night by the courier-TASK line
  (`orchestrator-courier.ts` + `desktop-tasks.ts`, 37210ab..bebc457, concurrent sessions):
  an instance with nothing awake at all now QUEUES the delivery for a scheduled courier task
  the app itself fires inside that account, so the agent-chat rung is the live-courier fast
  path and the parked-forever case is gone; seed-agent proposals stand down where the
  courier task covers the instance (c916bbb).

- **The circuit breaker: live loops now trip to ONE owner escalation instead of running
  forever.** Measured 2026-08-28: the same finished chat was re-archived four times in one
  evening (every archive executed and verified; the running app re-saved the entry un-archived
  and the janitor asked again), and the same idle item was re-proposed and re-rejected three
  times in ~40 minutes - correct passes, zero counters. `server/src/orchestrator-breaker.ts`
  adds three brakes, state in `orchestrator_kv` so counts survive daemon restarts: (1) attempt
  counters at proposal creation - past 4 new rows per (kind, session) in a 6-hour sliding
  window the ask is refused and becomes one `loop_break` attention item stating the loop and
  its history; (2) exponential backoff on revive deliveries per target session (2min doubling
  to 30min), reset the moment a delivery VERIFIES, with an in-backoff approval parking as
  "approved but parked" and the wait visible in the item's constraints; (3) a repeat-hash on
  rulings - the same item drawing the same decision three times folds into the owner
  escalation and is withheld from later worklists. The breaker suppresses proposing and paces
  delivery, never overrides a ruling, and every suppression is loud: the worklist gained a
  `suppressed[]` list and the dry run's `wouldSuppress` carries the same lines, read straight
  from kv so they hold even between ticks. Patterns: systemd StartLimitIntervalSec/Burst,
  claude_code_agent_farm backoff, CrewAI max_iterations, Cloudzy's repeated-action hash.
  Regression tests pin both measured shapes.

- **The reviewer is a ROLE, not a chat: the journal + seed make reviewer death a non-event.**
  Measured twice on 2026-08-28: the reviewer loop died with its host chat (a phantom archive,
  then a process kill) and the fleet halted until a human typed /orchestrate.
  `GET /api/orchestrator/reviewer-journal` is the compact successor briefing the server
  already maintains (recent rulings with their notes, in-flight items with their saved
  verbatim steps, standing context); `GET /api/orchestrator/reviewer-seed` (`?format=text`)
  composes it into a ready-to-paste opening prompt that briefs ANY fresh chat as the
  replacement - revival is replay-into-whichever-window-is-free, never
  resurrect-one-specific-chat (pattern: OpenHands' EventLog replay, Anthropic's memory
  checkpoint, AG2's rehydrate-by-name). While the no-reviewer check is stalled,
  `meta.reviewer.fix` names the seed endpoint. Neither endpoint stamps `lastReviewerAt`
  (they are read precisely while the reviewer is dead), the journal records without
  deciding (the action gate is untouched), and the seed is delivered by whoever boots the
  new chat - never relayed - with the bypass stamp verified before boot.

- **The chat dossier: one query, everything the system knows about a chat.**
  `GET /api/chats/dossier?q=<title fragment or any id>` (MCP `chat_dossier`) joins the four
  stores that each held a quarter of the answer - desktop metadata (archive flag read fresh
  off disk, lineage ids across auto-compact rolls), the orchestrator ledger, done-marks, and
  the live registry. Built after "what happened to that chat" took an hour of hand-joins;
  it takes seconds now, and it reports disk truth beside ledger claims so their disagreement
  is visible instead of being the lie you act on.

- **The orchestrator dry run: see the plan before anything acts.**
  `GET /api/orchestrator/dryrun` (`?format=text` for the rendered layout; MCP
  `orchestrator_dryrun`; `/orc-dryrun` from any chat) shows every open window with its chats
  and usage bands, every item a reviewer would be asked to rule on with its exact question
  and evidence, what the server would handle itself, and what it would suppress - computed
  with ZERO writes: no acks, no cooldowns, and deliberately no reviewer stamp, because a
  probe that stamps `lastReviewerAt` once masked a dead reviewer loop for an hour. Owner
  ask, verbatim: "tell me what it would do with every chat and every open window... so I
  can tell you no that's wrong."

- **`POST /api/sessions/:id/automation`** stamps a desktop chat's permission mode to
  `bypassPermissions` (owner rule, 2026-08-28: every migrated chat MUST be bypass before it
  starts; all chats default to bypass). Callers verify via the dossier and re-stamp until it
  reads back, because a running app re-saves the old mode.

### Removed

- **The relay rung, by owner ban** (2026-08-28, verbatim: "REMOVE THE RELAY TASK
  FUNCTIONALITY... Don't just fucking message other chats"). `computeRoute` no longer
  composes courier steps that borrow a live working chat to deliver into its instance; a
  dormant chat in another instance now parks honestly as unreachable until a reviewer exists
  inside that instance. A working chat is someone's thread of work, not the orchestrator's
  errand runner. The sanctioned replacement - a dedicated orchestrator-owned agent chat per
  instance - is designed and in flight.

- **`/orchestrate full`: the orchestrator can now find work nobody has started.** Until now it
  was entirely reactive. It asked questions about the chats that already existed (is this one
  dead, has that one finished) and never the other question, so a fleet whose every chat was
  healthy read as a fleet with nothing left to do, while the repositories themselves carried
  unticked task boxes, FIXMEs added last week, and gates that had not been run since the code
  changed. Full mode adds a slow, read-only sweep of the repositories and turns what it finds
  into ordinary proposals: a quality gate the repo declares and that has not been green since
  HEAD moved (`breaking`), FIXME/HACK/BUG/XXX comments that were not there at the previous
  sweep (`warning`), and unticked `- [ ]` boxes in a repo's task files (`chore`). The reviewer
  rules on each one and starts a visible desktop chat to do it, exactly as it does for every
  other kind of work.

  Turn it on with `/orchestrate full` (`all` and `forward` also work), off with
  `/orchestrate off`, or with the toggle in Settings. The mode is stored server-side rather
  than in the chat, because the reviewer reschedules itself with the bare literal
  `/orchestrate` and an argument would not survive its next wake.

  Four things it deliberately does NOT do, each of which would have been the easy version.
  It never runs a repository's own scripts: a daemon that executes arbitrary repo commands on
  a timer reinstalls dependencies under a chat that is mid-edit and runs whatever a freshly
  pulled package.json says, so running the gate belongs to the visible chat, which can also
  tell a real failure from a missing local secret. It never reports an old marker as new:
  every repo is baselined on first sight, keyed by content rather than line number, so years
  of accumulated `HACK:` comments never arrive as news. It never starts work in a repository
  another chat is standing in, enforced in code and re-checked by the reviewer. And an item
  reported failed three times stops being offered and becomes a line for the owner, because an
  item nothing can fix would otherwise be re-proposed forever, which looks like diligence and
  is a loop. New settings: `workMode`, `backlogRoots`, `backlogScanMins`, `backlogMaxOpen`,
  `backlogIncludeTodoMarkers`; new prompt template `workStart`; new endpoints
  `POST /api/orchestrator/backlog/scan` and `.../backlog/resolved`.

- **The feed now says whether anyone is actually reviewing.** The watcher cannot detect its own
  uselessness: it keeps ticking and the feed keeps looking healthy whether or not anything
  reads it. This project's maintenance session opened with 19 proposals queued and nobody
  deciding them, and it happened again the same night, with a reviewer working one shift and
  then vanishing while everything looked fine for five hours afterwards. `meta.reviewer`
  reports when a reviewer last DID something, in words. Liveness is measured by work (rulings,
  execution reports, acks) rather than by a process existing, so a reviewer that booted and
  then froze at an approval prompt does not count as present, and it only flags a problem when
  there is a backlog, because silence with an empty queue is just idle.

- **Load balancing across accounts** (`loadBalance`, ON by default). The rubric has always said
  "spread across the top eligible rows round-robin, never stack one account", and nothing could
  carry it out: the routing table is a pure function of the usage cache, that cache refreshes
  about once a minute, and so every placement decided inside one window saw identical readings
  and picked the identical account. Round-robin is not something a stateless sort can do. Three
  changes fix it. Placements are now WRITTEN DOWN, recorded at the primitive that makes them
  (seed, terminal launch, migrate) so a placement counts whether the monitor, the reviewer or the
  owner made it, plus `POST /api/orchestrator/placement` for the one path the primitives cannot
  see, a turn delivered natively into a chat that already exists. The 5-HOUR window is now read
  the way the weekly one always was, with `sessionResetsAt`/`sessionResetsSoon` on every row, so
  an account whose window is minutes from wiping counts as capacity rather than load (the row
  still reports the true percentage: the exemption changes ranking, never measurement). And the
  ledger breaks ties, ONLY ties: load is bucketed into coarse 20-point tiers and recency reorders
  inside a tier and nowhere else, so a colder account always wins outright however recently it
  was used. That narrowness is the safety argument, and a test named for it fails if it ever
  stops being true. Turning the setting off restores the previous ranking exactly.
- **One placement decision, in one place.** `pickPlacement()` is now the only definition of "an
  account that may take work". The auto-resume monitor carried its own inline copy of that filter
  while the reviewer carried a prose description of it in its rubric, which is one policy in
  three places, free to drift in all of them. The feed serves the answer as `placement`: the
  recommendation, the reason in words, and every account passed over WITH the reason, so a
  placement can be argued with rather than merely trusted.

- **The reviewer owns renames for anything it can reach.** The title janitor writes a name to
  disk, which is the durable answer for a CLOSED instance and futile for a running one: the
  app holds its chat list in memory and re-saves the file when the chat next boots, so only an
  app restart made the name appear. It now reports WHICH chats it renamed inside a running
  app, and those are served in the feed as `renames` for the reviewer to rename through the
  app itself, which is instant and which the app cannot overwrite. The restart stays as the
  fallback, so a fleet with no reviewer running is no worse off. The list is persisted rather
  than recomputed, because the sweep only reports what it changed and a recomputed list would
  empty itself within one cycle.

### Fixed

- **The `bypassPermissions` stamp on a seeded chat no longer stays lost after the app's boot
  re-save: the disk copy is kept true and made permanent at the next app restart.** A seeded or
  imported chat is created by the app with `acceptEdits`, which prompts on every shell command,
  and the app's in-memory record is authoritative while it runs: on the chat's first wake it
  re-saves that record over our stamp and the engine runs unstamped. Measured 2026-08-29
  01:58 UTC: a freshly seeded chat was booted ~15 seconds after seeding, invoked its skill
  correctly, and froze forever at its FIRST PowerShell approval prompt, the zero-click deadlock
  the stamp exists to prevent, and the same disk-vs-app-memory race as the archive-flag fix
  before it. That broke reviewer bootstrap and every full-mode work seed whose opening prompt
  runs shell.

  Two convergence mechanisms now close it as far as it can be closed from outside the app. Every
  import starts a bounded watch (`reassertChatAutomation`) that rewrites the stamp whenever the
  running app flips it back, bounded by a time window, a restore cap and a miss cap, so the file
  stops testifying to the wrong mode. And the archive-visibility restart's quit-then-reopen
  window, the one moment a daemon write provably enters app memory, now re-stamps every
  import-shape chat in the store (`reassertAutomationStamps`); app-created chats are never
  touched, since their mode can be the owner's deliberate UI choice. After that restart the app
  itself re-saves `bypassPermissions`, so the stamp is durable for life; this also heals the
  imports clobbered before the mechanism existed (census 2026-08-27: 26 of 30 fleet-wide). What
  remains app-owned, stated in ORCHESTRATOR.md: a chat woken before any app restart still runs
  its first turn on `acceptEdits`, because no external write can reach the app's memory sooner.
  The import URL and the message channel expose no permission surface (both checked).

- **A stale command fingerprint could permanently freeze the installed `/orchestrate` rubric.**
  The boot refresh tells our own out-of-date copy apart from a copy you edited by comparing the
  file against the fingerprint of what AgentHydra last wrote. That record was only ever adopted
  when it was missing entirely, so a file that already matched the shipped text while the record
  named an older version stayed mis-recorded. Nothing looked wrong until the next release changed
  the rubric, at which point the same file read as your edit and was never refreshed again. Found
  on a real machine: the installed `/orchestrate` was byte-identical to what shipped, and the
  recorded hash was not. A file whose bytes ARE the shipped text is now always adopted, which is
  safe by construction because there is no edit of yours to lose.

- **A six-hour-dead reviewer reported as merely idle.** The health check counted only PROPOSALS as
  work waiting, so with none open it said "nothing is waiting to be decided, so silence here means
  idle rather than absent" no matter how long the silence had run. Measured 2026-08-27: the
  reviewer's process was gone from the live registry and its transcript's last line was written at
  07:50, while a rename had sat in the feed waiting for it that entire time. The owner spotted it
  from the outside and asked exactly the right question, that a reviewer should have said
  something about a live chat by now, so it is probably broken.

  A rename is work only a reviewer can do, because the app overwrites a title written to disk, and
  it was invisible to the very check that exists to notice an absent reviewer. The count is now
  everything the reviewer owes an action on, and the feed resolves the rename list once so what
  the reviewer is shown and what it is judged against cannot disagree. The "only a backlog makes
  silence meaningful" rule stays, because a check that fires on healthy input stops being read;
  the bug was never that rule, it was measuring the backlog with too narrow a ruler.

- **A handed-off resume reported itself finished before the work started.** Opening a visible
  terminal returns the instant the window is spawned, because nothing is piped and nothing is
  waited on, and the monitor wrote that result straight into the queue row as
  `status = completed, exit_code = 0, finished_at = now`. So a resume was recorded as a clean
  successful run at the moment it began, and the same fabricated zero went in on the native
  branch, where all that had happened was a proposal being raised for the reviewer to decide.
  Redirecting more traffic onto those branches to satisfy the no-headless law made an existing
  lie louder rather than causing it.

  The row's own job, actioning a scheduled resume, genuinely is finished, so `completed` stays.
  The exit code does not: there is no exit code for work we handed off and stopped watching, so
  it is null now, and the UI already renders that as simply no badge. A launch that FAILED keeps
  a real non-zero code, because that outcome is ours. The terminal branch also records which of
  the two happened, the way the native branch already did; before this the row read identically
  whether a window opened or the launch failed outright. This codebase had already named the
  failure in `types.ts`: conflating "the work finished" with "you can see it" is exactly how
  something goes missing while nothing looks wrong.

### Changed

- **`/delayo` and `/resumeo` are now `/orcstop` and `/orcstart`** (owner request). The pair
  stops and starts the orchestrator on the thread you type it in, and the new names say that
  instead of rhyming; nothing about what they do has changed.

  The old files are REMOVED rather than left behind, because a retired command is not inert: the
  old file is complete and still posts a hold, so a machine that kept both would offer four
  commands for two actions and the retired pair would keep working forever with nothing
  maintaining it. Only our OWN unedited copy is deleted, matched against the fingerprint recorded
  when we wrote it; a copy you edited is kept and reported, on the same rule that governs a
  refresh. Uninstalling sweeps the old names too, since an uninstall that leaves a working
  `/delayo` behind has not uninstalled anything.

- **An auto-resume can no longer be scheduled somewhere it can never run.** Banning headless runs
  closed the door; it did not tell the auto-resume monitor to stop walking into it. Two of that
  monitor's routing branches fell through to a headless dispatch, so after the ban those resumes
  were scheduled, dispatched and refused on every single attempt, which is a resume that can never
  happen. One branch was the `queue` preference, the classic invisible run, and that one at least
  was an explicit choice. The other was doing quiet damage under the DEFAULT setting: a `desktop`
  preference over a thread with no `desktop:` instance ref, a CLI-instance thread or one with no
  ref at all, cannot be delivered natively, and rather than say so it went invisible.

  The rule is total now and has no fallthrough: a due resume either wakes the thread natively in
  its own app, or it opens a visible terminal. Both paths already existed and are proven, so
  nothing had to be invented to close the hole; `queue` simply resolves to the nearest thing that
  can be watched. The decision is a pure `resumeSurfaceFor()`, exported and tested, whose return
  type has only those two members, so the law holds by construction rather than by a branch
  someone could add back. `monitor.ts` no longer imports `dispatchItem` at all, and that absence
  is the real guard: the monitor now has no way to start an invisible run, rather than merely
  choosing not to.

- **No headless chats, at all** (owner law, 2026-08-27: "We should never have any headless chats.
  No headless."). The surface-purity guard added the day before was the weaker half of this: it
  asked only whether a thread already lived in a desktop app, so an orphaned CLI thread, a
  migrate-on-limit resume or a scheduled run still became a conversation nobody could watch. It
  also could not tell "this has no desktop home" from "I could not find one", and read both as
  permission. The property worth banning is INVISIBLE, not cross-surface.

  `dispatchItem` now refuses every headless run, at the one chokepoint all five call sites funnel
  through, and the per-row `allow_headless` override no longer buys a way past: an override that
  defeats "never" is the old behaviour behind a flag. A refused run fails with a reason naming the
  law, so it shows in the queue instead of vanishing. What runs instead was already built and
  proven rather than promised: the reviewer delivers turns natively into a chat's own app, and a
  visible terminal covers work with no app to go back to. The `/usage` probe is deliberately not
  covered, because it asks the CLI a question and reads a number back rather than holding a
  conversation. The one remaining switch, `dispatch_allow_headless`, is off unless deliberately
  set, and its polarity is inverted from every other setting here on purpose: absence means the
  ban applies, so a fresh install and a wiped settings table both mean no headless.

  Three of this area's tests changed sides rather than being deleted, which is the honest record
  of a policy reversal: a brand-new chat and an explicit `allow_headless` override used to be
  asserted to COMPLETE, and are now asserted to be refused. A new test proves nothing is spawned
  before the refusal, so "refused" cannot quietly mean "killed shortly after starting".

  `POST /api/queue` refuses at the point of ASKING too, not only at the point of running. The
  chokepoint is still the enforcement, but without this the route would accept the row, hand back
  an id, and let the caller discover the problem later: a dead end with a receipt. Verified live,
  409 with the reason, no row created, and `force: true` does not change the answer.

### Fixed

- **A shipped command fix could never reach the reviewer that reads it.** The rubric the reviewer
  runs is installed into `~/.claude/commands`, and the only automatic install ran on first enable
  with force off, whose own comment reads "an existing copy is never touched here". Nothing ever
  ran after an update, so a release could change the rubric and the installed copy would sit at
  whatever version first landed. Measured 2026-08-27: the live copy predated the previous day's
  fixes, so the reviewer was still being told to construct chat ids as `local_<sessionId>` - the
  exact bug fixed in this changelog, which had never reached the only file the reviewer opens.

  The daemon now records a fingerprint of the copy it writes, which is what separates the two
  cases the old three-way answer ran together: a file the owner edited, whose edits are the newer
  intent and are still never overwritten, and our own previous version, left behind because a
  release moved on without it. On boot it refreshes the second kind only. It never creates a file
  that way, so a machine that never switched the orchestrator on does not silently gain commands.

- **The ultracode opt-in was a toggle wired to nothing.** `newChatUltracode` was stored, read
  back, patched over the HTTP API and MCP, and rendered as a switch whose own hint reads
  "Prepends the 'ultracode' opt-in keyword to every orchestrator-started chat, so it runs in
  exhaustive mode". Nothing ever put the word anywhere. An audit of all six paths that start a
  chat (terminal launch, desktop seed, the auto-resume monitor, the prompt catalogue, the
  headless queue, the reviewer's own native delivery) found zero code sites that concatenated
  it, and the only thing carrying the promise out was a line of prose in the reviewer's rubric
  asking it to read a boolean and remember a rule. The owner spotted it from the outside: new
  chats came up on the right model at max effort with the opt-in silently doing nothing.

  It rotted because of an asymmetry worth naming. Its two siblings, `newChatModel` and
  `newChatEffort`, are real CLI flags, so their wiring is visible in the argv of every launch
  and could not quietly stop working. Ultracode has no flag and no settings key at all: the
  only way to ask for it is the literal word in the prompt text, which is exactly the kind of
  wiring that can be missing and look present. `server/src/new-chat-opening.ts` is now the one
  definition, for the same reason `pickPlacement()` is one definition, and the daemon applies
  it in the terminal-launch primitive so every caller inherits it, never on a `--resume`. For
  the deliveries no server code can reach, the feed serves the answer instead of the rule as
  `newChatPrefix`, the same move `placement` makes. The guard is a test that flips the setting
  and proves the output changes, since that is the only thing a keyword-in-prose can be checked
  by; three of its assertions fail against the old behaviour.

- **One swept probe transcript could blank the whole session list.** The `/usage` probe's sweep
  and the session scanner race by construction: `pruneUsageProbeTranscripts()` deletes .jsonl
  files out of a project folder that the scanner also enumerates, so the daemon routinely
  removes files it is itself part-way through reading, and there is no lock to take or ordering
  to arrange because the probe runs on its own timer. The read threw on the miss, and the throw
  escaped into `/api/sessions`, killing the request and every row already parsed for it. Seen in
  the live daemon log on 2026-08-27 as `ENOENT ... at async parseMeta`, whose two anonymous
  frames are `toSummary` and `mapPooled`'s worker, which is the list path exactly. The warm-up
  at the bottom of sessions.ts had always caught this ("an unreadable transcript just stays
  uncached"); the list path and `getSession` had not. `scanMeta` now returns
  `ScannedMeta | null`, so a vanished transcript is simply not a session and its row is omitted,
  and the type is what forces all three call sites to say so rather than a comment asking them
  to. A miss is never cached, so a file that reappears parses normally on the next pass.

- **The reviewer was told to build chat ids, so it addressed chats that do not exist.** Its
  first real shift landed 0 of 4 relayed deliveries: the rubric said to target
  `local_<sessionId>`, which is right only for IMPORTED chats, while a chat the app created is
  filed under the app's own id - 1,325 of 1,343 chats here. Revive proposals now carry
  `evidence.chatId`, the id the app's own tools take, and the rubric says to use it verbatim
  and never construct one. The bridge already existed inside the store scan and was thrown
  away.
- **Proposals could outlive their targets.** Open rows stand for up to 48 hours, so four
  approved revives pointed at chats archived in the meantime and the reviewer spent a relay
  round finding out. Every tick now retires open proposals whose chat has been archived, the
  same test the detectors already apply before proposing.
- **Two unattended terminal launches could still deadlock on a shell approval.** The
  auto-resume monitor's visible window and the `terminal` handoff surface both open while
  nobody is watching and neither asked for a permission mode, which is the exact freeze proved
  live this session. Both now request `bypassPermissions`.
- **Renaming a seeded chat before its first turn was wasted work**, and the rubric asked for it
  in that order. A delivery boots the chat and the app rewrites its metadata on boot, so the
  title has to go on afterwards; doing it first and clearing the entry left the chat unnamed
  with nothing tracking it.

- **A session running a long command was reported as idle, and the reviewer told it to move
  on.** Field report from the reviewer itself: it was handed a session as idle while that
  session was mid-commit-and-push, and "resume working on whatever you recommend next" is an
  actively damaging thing to say to a session halfway through a push. Quiet time measures the
  TRANSCRIPT, so a gate that prints nothing until it finishes (that repo's test run is ~130s
  against a 150s idle threshold) is indistinguishable from a chat waiting for input. The
  evidence to tell them apart was already computed and only annotated, so a chat with a tool
  in flight now gets four idle windows of grace, floor ten minutes, before it counts as
  pending at all. A blanket suppression was tried first and was wrong: it also hid a session
  quiet for three hours whose task was still writing, which is exactly what the feed is for.

- **A launched terminal could hang forever while reporting success. Fixed, and the cause was a
  slash.** Starting the orchestrator's reviewer opened a window, asked whether the folder was
  trusted, and waited on a keypress that by the zero-click law can never come, while the API
  had already returned ok. Trust is recorded per project path as a literal key, and across the
  whole config every forward-slash key was false while every backslash key was true: the CLI
  resolves cwd to forward slashes and reads trust there, while something else wrote the other
  form, so 61 of 114 projects read as untrusted and long-trusted folders were asked about
  forever. `launch-terminal` now mirrors an existing trust decision onto BOTH spellings, still
  refuses loudly for a folder never trusted in any form rather than answering the security
  question for the owner, and accepts `permission_mode` so an unattended window does not stop
  on shell approvals. A launch that had hung three times then registered in seven seconds, and
  the reviewer ran its loop with shell commands returning results. Starting a reviewer now
  takes no human action.

- **A seeded chat could end up named after AgentHydra's own plumbing.** Found by the owner on
  his sidebar: two chats seeded during one session read as "General coding session" and
  "[orchestrator] This thread was seeded by AgentHydra for a new task. The task prompt arrives
  as the next...". Same cause both times. A seeded chat's first user message is fabricated so
  the chat has something to boot from, the app wipes the real title on that first boot, and the
  title scanner then derives a new one from the only text present: the preamble. Two fixes,
  because either alone leaves a hole. The janitor now treats an "[orchestrator] ..." title as
  replaceable and refuses to write one. And the seed, which knows the title that was actually
  asked for, parks it as a pending native rename instead of leaving the scanner to reinvent a
  name from a transcript that is barely more than plumbing.

- **The kit-drift guard was reporting green having compared nothing.** The checkout moved down
  into `app/`, so `check:kit` pointed one directory short of the sibling kit; and even once the
  path was corrected, the kit's own config still described the old layout, so the app was SKIPPED
  and the run then printed "every app copy matches the kit" and exited 0. All four kit apps were
  affected, and one of them had already corrected its path and was still getting the false green.
  A skipped app is no longer a passing app: under `--check --app <name>` a skip is now fatal, and
  a fleet check names what it did not check instead of claiming full coverage. The guard now
  really does compare 698 files across the four apps.

### Documented

- **The approval-stall deadlock is now characterised by experiment, and per-chat stamping
  cannot fix it.** Seeded a chat, watched the states: the unattended stamp lands, the app
  overwrites it within 9 seconds of the chat's first boot, a manual re-stamp holds while idle
  and is overwritten again on the very next turn. The clobber is every-boot, and a delivery is
  a boot, so a stamped import is unattended exactly until it first does anything. The reviewer
  rubric now asks for file-tools-only in the FIRST message of every revive rather than as a
  fallback after a stall is detected.
- **The approval-stall deadlock was understood backwards, and is now measured.** The belief was
  that chats the desktop app creates itself land on a mode that prompts. A census of the real
  fleet (1,362 chats, new `scripts/permission-mode-census.mjs`) says the opposite: chats the
  app creates are 100% unattended, and it is the chats WE import that are not, at 13%. The
  unattended stamp is written and then lost when the app re-saves that metadata on the chat's
  first boot, the same clobber that eats titles. A per-folder preference in the app's config
  looked like the durable fix and was ruled out by the same census. The docs no longer imply
  the stamp works; it held 4 times in 30.

- **The cross-instance RELAY is verified**, for the first time since it was written: there had
  never been a live chat outside the reviewer's own instance to test it with. Relaying a MESSAGE
  works exactly as documented, end to end, including booting the dormant target's engine.
- **The archive ladder's relay rung was over-claimed, and is corrected.** Sending a message needs
  no approval; archiving ALWAYS prompts its user by design. So that rung is agent to HUMAN to
  agent: the relaying chat's own user consents, and the orchestrator cannot delegate that. A chat
  that declines is correct, and looking for a peer who would say yes is laundering. The finding
  came from a normal-permissions chat refusing; a reviewer in bypass would have made the same
  call with no prompt and concluded the rung was universal, which it is not.
- **Codex staying observe-only is a decision, not an unfinished feature.** Resuming a rollout in
  a visible terminal cannot preserve surface purity, because a rollout carries no record of which
  frontend wrote it and Desktop and CLI share one `CODEX_HOME`; and there is no live-writer guard
  for Codex, so a resume could double-write a transcript the Desktop app holds open.

## [0.36.0] - 2026-08-26

### Changed

- **The action gate: nothing acts blind anymore** (owner law). Every action the machinery
  wants - a revive, an archive, an import, a "you crashed, please resume" - is now a
  PROPOSAL the orchestrator AI must check first. The daemon's detectors (crash orphans,
  stranded transcripts, deaf processes, usage-window resets, the archive janitor, the
  visibility sweep) write proposals with full evidence; the reviewer rules on each with a
  recorded reason, executes the approved ones itself, and reports the outcome. The ledger is
  served in the feed and audited for a day after each decision, and decide-then-execute is
  enforced by the API.
- **Surface purity** (owner law, same day): desktop stays desktop, CLI stays CLI, headless
  stays headless. The v0.35 auto-revive mechanism - a headless `--resume` imported back into
  the app - is DELETED, not disabled, and the queue-with-import-back pattern is retired
  everywhere. Desktop chats get their turns through the desktop app's own message channel,
  which boots a dormant chat's engine and runs the turn visibly (proven live: zero clicks,
  zero headless processes). New work is SEEDED as a real desktop chat
  (`POST /api/sessions/seed-desktop`) and delivered the same way. The monitor's
  usage-window resumes of desktop threads became revive proposals too.
- **The reviewer rubric rewritten around the new shape** - one delivery ladder (native
  same-instance, peer to live chats, relay into other instances, wait visibly when no
  native route exists), proposals decided first on every wake, and the conflicting
  queue-era flows removed. Shorter than what it replaces.

### Added

- **An orchestration self-test you can run any time**, which reports `visualChecks: false`
  rather than implying it looked at a screen. Every rail in this feature was added
  because something silently did the wrong thing on the real machine while the unit tests
  stayed green, so this runs the real guards against real state and reports what held: the
  watcher completes a pass, the surface guard recognises the chats that actually exist here,
  the action gate refuses to act before the AI has ruled, archiving and titling work, imports
  refuse a closed instance and a live session, every prompt resolves, and the reviewer command
  is installed. Safe to run against a live fleet by construction - every artifact it touches
  is one it created, under sacrificial ids in a throwaway directory. It found a real bug on
  its first run (below). An opt-in deep mode additionally seeds one real chat to prove the
  app-facing half works, then archives it.
- **A screenshot endpoint, so a claim about the screen can be looked at.** Everything else the
  daemon reports is read from disk, and disk is not the screen - the gap is where the archive
  that stayed visible and the title that got wiped both lived. `POST /api/screenshot` writes a
  PNG and returns the path; the caller reads it. It interprets nothing on purpose: it is a
  camera, not a judge, and the reviewer is now told to use it after archives and migrations
  rather than treating it as a last resort. A deep self-test run leaves one attached.
- **Codex threads appear in the same attention feed.** AgentHydra manages both agents but the
  orchestrator watched only one, so a Codex thread that stopped mid-work was invisible to the
  machinery that babysits every Claude chat. Codex rollouts are now classified the same way
  (finished, interrupted, stopped mid-turn, with the recap captured) and carried in one feed.
  Observe-only and labelled as such: Codex exposes no message channel, so every item says
  `deliverable: false` rather than inviting a nudge that would go nowhere.
- **A retired thread writes its knowledge down before it is archived** (owner rule). A chat
  being closed out as finished is the last place its own knowledge exists, so it gets one
  final turn asking it to bring the repo's markdown current: what it did, what is verified
  versus merely attempted, what is outstanding, and the gotchas a future session would have
  to rediscover. It is explicitly allowed to answer "nothing here is worth keeping". A
  MIGRATED thread is not asked, because it is continuing rather than ending. The wording is
  an editable prompt like all the others.

### Changed

- **One cached index instead of six separate walks of the chat store, and the housekeeping
  sweep is six times faster** (8.5s to 1.4s; the archive sweep alone went from 1.7s to 7ms).
  Measured, not guessed: an ordinary watch pass was already 132ms, so the time was all in the
  ten-minute housekeeping - and specifically in a regression from teaching the lookup to match
  both on-disk chat shapes, which made every miss re-read all 2,130 metadata files. The scan
  was already cached and already reading every file; it now keeps what the callers need and
  indexes each chat under both of its possible ids, so one scan answers every question.

### Fixed

- **A newly created chat showed as "General coding session" until renamed.** Seeding writes a
  title into metadata that the running app overwrites the moment the chat first boots - caught
  by looking at the sidebar in a screenshot, which is the only thing that could have caught it,
  since every on-disk check said the title was correct. Seeding now reports that the title is
  not durable, and the reviewer renames through the app immediately after, which shows on
  screen instantly.
- **Archiving no longer reports success for a chat that is still on screen.** Asking the app
  itself right after the call showed the truth: disk said archived, the app still said not
  archived, and the chat stayed in the sidebar. The endpoint now says so - the flag is
  written, the chat is still visible, a restart is queued and fires when that instance has no
  live sessions. It matters most for the instance the reviewer runs in, which can never reach
  zero live sessions because the reviewer is itself one, so there the app own archive is the
  only thing that actually retires a chat.
- **Archiving a chat only worked for one chat in eighty.** It matched the metadata filename,
  which is how an IMPORTED chat is filed; a chat the owner started in the app is filed under
  the app's own id with the session id inside. So the archive endpoint returned
  "no-desktop-chat-found" and quietly did nothing for 1,325 of 1,343 real chats - the same
  blindness fixed in the surface guard days earlier, in a second place nobody had checked.
  Found by the new self-test on its first real run, which is precisely what it is for.
- **A chat frozen at a permission prompt is now diagnosed as that**, instead of being
  reported as "waiting on dead background tasks" - the wrong diagnosis and the wrong fix.
  The app creates imported chats in a mode that auto-approves file edits but prompts on every
  shell command, and a prompt the remote owner can never click is a silent deadlock: alive,
  idle, nothing in any log. It is indistinguishable from thinking unless you ask whether this
  chat's mode prompts for the tool it is sitting on, which is exactly what the watcher now
  asks. Imports also request the unattended mode, and the reviewer's fix is to revive with
  file tools only.
- **A desktop chat can no longer be continued by a headless run, at the chokepoint.** This is
  the owner's reported failure ("every chat you were migrating from desktop to desktop ended
  up being migrated to a headless thing that I couldn't see"), and an audit of the live
  database found 11 real cases. The guard now sits in the ONE function every headless run
  passes through, so all six callers (the HTTP route, run-due, the retry sweep, the
  scheduler, the monitor, migrate) are covered by one rule instead of five ways in; a route
  check alone would have left the other five open. New chats are exempt by design, and a
  single explicit override is recorded on the row for the owner's own deliberate calls.
- **Migrating a chat between accounts no longer burns a headless turn.** Transcripts are
  shared across instances, so a move is just "archive the old entry, import into the new
  one"; the old design ran a one-turn notice through the queue first, which is precisely how
  a migrated chat spent its first turn invisible. The endpoint also stopped advertising that
  the moved chat "awaits an activation click", which the zero-click law forbids.
- **The test suite no longer reads the developer's real desktop-instance store**, so instance
  discovery is deterministic instead of depending on which apps happen to be installed.
- **The sidebar-repaint restart can no longer kill a live chat.** Its "zero live sessions"
  guard compared a real-cased instance path against a lowercased one with strict equality,
  matched nothing, and had therefore NEVER actually protected anyone - it quit and reopened
  the work app under a live mid-turn chat (the owner had to hand-resume it). Three
  independent layers now: case-insensitive path identity everywhere, no restarts at all
  while any live session has no mapped instance ("unknown account" rows), and direct
  process-ancestry proof that no live session's process tree hangs off the app about to be
  quit - with "could not check" treated as "do not restart".
- **"Revive:" titles can no longer stick to a chat.** The revive era's queue prefix joined
  the title peelers, so a re-imported thread wears its real name, never the plumbing's
  (found live: an architect chat re-wearing "CLICK TO RESUME" through an import).
- **One database, not one per way you started the app.** A source checkout kept its state in
  the repo's `server/data` while a packaged build used `~/.agenthydra/data`, so `bun run start`
  and the installed daemon were the same app reading two different sqlite files: settings, the
  queue, orchestrator acks, `/delayo` holds and the done-mark ledger all diverged silently, and
  forensics run against the wrong file answered confidently and wrongly (measured on the live
  pair: one held 22 done-marks, 24 queue rows and 46 acks; the other had no orchestrator tables
  at all). Both modes now resolve to `~/.agenthydra/data`, a checkout's existing `server/data`
  is migrated across on first run (by copy when the two live on different volumes, which is the
  normal Windows layout), and `/api/health` reports `dataDir`, `dbPath` and `dataDirNotice` so
  "which database is this daemon using" is answered by looking. When BOTH already hold state
  nothing is moved or merged: the per-user directory wins and the other is named out loud.
- **An OpenCode session write inside one filesystem tick can no longer be cached away.** Two
  writes can share a single mtime granule, so the second looked like no write at all to a
  cache keyed on mtime. It only reproduced inside a full-suite run, because it needs an
  earlier read in the same process to prime the cache.

## [0.35.4] - 2026-08-26

### Fixed

- **Renamed chats appear renamed NOW.** The title janitor fixed names on disk, but a running
  app keeps showing the old name until it restarts - so freshly named chats still read
  "General coding session" on screen (owner report). Title renames now feed the same
  sidebar-visibility restart the archive flow uses: the affected app restarts the moment it
  has zero live sessions, and the new names show.

## [0.35.3] - 2026-08-26

### Changed

- **The zero-click law.** Owner order: clicking is impossible for him, permanently (he
  operates over Remote Desktop while traveling). Nothing may wait on the owner clicking,
  activating, or dismissing anything: chips are STARTED by the machinery through the queue,
  handoff continuations on the desktop surface run as queue turns with import-back instead
  of "click it once to start" handovers, and only true blockers are surfaced - as status
  text, never as controls. Written into the reviewer rubric's hard rails and the
  architecture doc.

## [0.35.2] - 2026-08-25

### Fixed

- **A just-revived chat can no longer be re-flagged deaf 150 seconds later.** Every
  queue-revive re-imports the chat as a fresh passive process, which the deaf detector would
  flag again almost immediately. A 30-minute quiet floor on the deaf test turns the cycle
  into "revive again only once it has genuinely sat" - a sane work cadence for chats with
  pending work - and the reviewer retires finished threads so the cycle converges.

## [0.35.1] - 2026-08-25

### Added

- **Archived means gone from the sidebar NOW.** A running app repaints its sidebar only at
  startup, so archive flags written from outside used to wait for "whenever that app next
  restarts". Every archive (janitor, API, migrate) now queues an archive-visibility restart:
  the janitor restarts the affected app the moment it has zero live sessions (nothing to
  interrupt; the real non-isolated Claude profile is never touched; at most once an hour per
  app), and the archived chats vanish immediately after.

## [0.35.0] - 2026-08-25

### Changed

- **Auto-revive now runs through the queue, not the keyboard.** The owner operates over
  Remote Desktop while traveling: his remote input kept the user-idle safety gate closed
  whenever he was connected, and a disconnected session locks the console where synthetic
  input cannot land - so UI injection was structurally the wrong tool. Revives now run as a
  one-turn resume through the queue with the revive prompt (the exact migrate-flow pattern in
  production since v0.29), landed back into the chat's desktop app by the finalize import.
  Needs neither the screen nor the keyboard, works connected or disconnected, and the turn's
  own transcript is the engine verification. The UI-injection path remains in the codebase
  but no longer drives.

## [0.34.4] - 2026-08-25

### Fixed

- **Session ROLL discovered, and the re-import loop it caused killed.** A desktop chat that
  continues rolls onto a NEW underlying session id while its sidebar entry keeps the original
  id in its filename. Every lookup keyed by the new id then reports the original as
  "invisible", so the visibility sweep re-imported (and re-titled) an already-visible chat
  every cycle - caught within minutes by the per-import logging added one release earlier.
  Visibility is now judged by the entry FILE (roll-proof) plus liveness, and revive's engine
  verification watches the chat's own metadata activity as well as the transcript, so a
  revive that rolls the session still verifies. The clobbered chat title was restored.

## [0.34.3] - 2026-08-25

### Fixed

- **The chat-row search waits for the app's accessibility tree to wake up.** Chromium builds
  it lazily on the first query, so the first revive attempt on a freshly-queried window saw
  only the window frame and safely aborted (chat-row-not-found). The search now retries over
  ~10s while the tree warms; aborts also report the tree size seen, and the visibility sweep
  logs each imported session id so a re-import loop can never hide behind a count.

## [0.34.2] - 2026-08-25

### Fixed

- **Auto-revive can no longer type into the wrong window, or blind.** First-night lesson:
  focusing a window can fail silently, and the deep link opens a chat's process without
  switching the visible chat - so a revive could type into the void (verified caught by the
  engine check, which correctly refused to call it success). Now nothing is EVER typed
  unless the target window verifiably holds focus (re-checked right before each keystroke
  batch), the chat's own sidebar row is located by title through the accessibility tree and
  clicked, and the composer is found the same way. Any of those missing aborts the attempt -
  fail safe, retry later, never mistype.
- **Scratchpad runs stay out of the sidebar.** The visibility sweep imported a temp-folder
  working session, which auto-revive then dutifully woke. Temp/scratchpad runs are excluded.

## [0.34.1] - 2026-08-25

### Fixed

- **A reviewer's ack can no longer blindfold auto-revive.** Found live within the hour of
  shipping: the reviewer acked a dead chat's item "awaiting click" (its old playbook), which
  suppressed the item from the feed, and auto-revive read only the suppressed feed - so the
  one chat the owner was asking about stayed dead while everything else got revived. Revive
  candidates are now captured before ack suppression: acks shape the reviewer's reading
  list, never the reviver's to-do list. The feed meta shows `revivePending` so the queue is
  observable.

## [0.34.0] - 2026-08-25

### Added

- **Auto-revive: the orchestrator starts dead chats itself.** The platform only runs a
  desktop chat's turn from its own composer, so imports and restarts left chats that a human
  had to click and type at - and one sat six hours untouched. The daemon now does the
  click-and-type at OS level: it opens the chat in its app, pastes the revive prompt,
  presses Enter, and only claims success after the transcript verifiably grows. Hard gates:
  never while you have touched the keyboard in the last 45 seconds, never over a chat whose
  transcript is actively growing, never a retired lineage, never a closed account. On by
  default (Settings toggle to turn off), Windows only, one attempt per minute with backoff.
- **Live-but-deaf detection.** Delivery plumbing spawns real processes whose engine never
  starts; they masqueraded as ordinary idle chats while reviewer nudges queued into a void
  forever (the Glimmer chat's six hours). Deterministic test now: a process with no
  transcript record newer than its own spawn time has never run a turn - flagged for
  auto-revive, and the reviewer is forbidden from messaging it.
- **The visibility sweep: no invisible chats.** Any completed queue run from the last 48h
  whose session has no desktop entry anywhere is imported into its owning running instance's
  app, where the deaf detector and auto-revive take over - everything the machinery starts
  ends up visible and running on screen.

## [0.33.0] - 2026-08-25

### Added

- **The orchestrator's prompts are yours to edit.** Every message the machinery sends into a
  chat (the resume nudge, handoff request, dead-tasks intervention, hard-cutoff order,
  overload retry, commit and branch nudges, crash revival, migration notice) is now a named
  template under Settings -> Automation -> Orchestrator -> Prompts. The shipped texts stay
  the defaults; edit any of them and your wording is what gets sent, blank one (or hit
  Reset) and the default returns, so future shipped improvements still land. The reviewer
  reads its outgoing texts from the live feed, so edits apply on its next wake.
- **Settings grew tabs: General and Automation.** The scheduler, orchestrator, and
  auto-resume monitor moved to an Automation tab; deep links (the composer's tomorrow gear,
  the queue drawer) flip the tab and land on their section as before.
- **Remove & disable.** One button (and `POST /api/orchestrator/uninstall-command`, MCP
  `orchestrator_uninstall_command`) turns the orchestrator off and deletes its three shipped
  slash-command files; Reinstall puts the shipped versions back.
- **Stranded chats are found, not just crashed ones.** A normal PC restart shuts sessions
  down gracefully, which deletes the registry residue the crash detector reads, so a chat
  could sit "CLICK TO RESUME" through a restart, invisible (found live: the owner's
  architect chat). A transcript-store scan (48h window, ~60ms) now surfaces any non-live,
  un-archived desktop chat whose tail ends mid-turn as the same orphaned scenario.
- **5-hour load balancing.** The routing table is now sorted running -> weekly band
  (reset-soon counts healthy) -> lowest 5-hour session % -> lowest weekly %, and the
  reviewer spreads same-wake placements across the top rows, so no single account's 5-hour
  window gets hammered while others sit cold.

### Fixed

- **"Max running chats" edits from Settings now persist.** The settings route dropped the
  `maxActiveChats` field on its allowlist, so the UI accepted the number and the daemon
  forgot it.

## [0.32.0] - 2026-08-25

### Added

- **A concurrency cap for orchestrated chats, default Unlimited.** `maxActiveChats` (Settings ->
  Orchestrator -> "Max running chats", 0 = unlimited) caps how many chats may actively work at
  once across the whole fleet. Past the cap, idle chats wait their turn and rotate round-robin:
  the chat idle longest gets the next free slot, and a nudged chat re-enters at the back of the
  line, so everyone cycles through fairly with no extra bookkeeping. The watcher marks the
  overflow `waitingForSlot` (the reviewer skips those without acking, so they resurface the
  moment a slot frees) and publishes `runningChats`/`slotsFree` in the feed meta. Only
  resume-to-work nudges and new work are gated; answering a chat's question, handoff
  continuations (replacements, not additions), and crash revives never wait.

## [0.31.0] - 2026-08-25

### Added

- **Restart recovery: a session whose process died mid-work is found and revived.** A computer
  restart (or crash, or kill) used to make chats simply vanish from the orchestrator's view,
  because the live-registry scan silently dropped dead-pid entries. A registry file that
  outlived its process is now read as what it is: evidence of an un-graceful death with the
  thread unfinished. Each becomes an `orphaned` attention item and the reviewer revives it per
  the surface preference (desktop: the chat still sits in its sidebar, one click; terminal: a
  visible `--resume` window) with a verify-first prompt, since a killed session's last writes
  may be half-applied. Superseded, finished, and owner-archived residue is cleaned instead of
  reported, so the whole flow self-heals as chats come back to life.
- **One lineage, one continuation: the duplicate-work guard.** Chats were found overwriting
  each other's work: two sessions continuing the same task. The done-mark ledger
  (`session_marks`, keyed by session id) is now enforced in code. A done-marked (handed
  off/migrated/closed) session generates no nudge items, is never a hygiene addressee, and
  every revival path (terminal resume, desktop import, migrate, the monitor's scheduled
  auto-resumes) refuses it with 409 `superseded`; `force:true` exists for deliberate
  resurrections only. The reviewer rubric orders every handoff mark-first, so a crash
  between collecting a handoff and starting its successor leaves a recoverable gap rather
  than an unrecoverable duplicate.
- **The archive janitor: done-marked chats get archived, continuously.** Any session the flow
  itself marked finished (handed off, migrated onward, closed out) has its desktop entries
  archived on the same ~10-minute cycle as the title janitor, instead of sitting open in the
  sidebar after their work moved on. Keyed on the done-mark and nothing else, because
  prose-reading guesses wrongly and hides live work. The standing caveat applies: a running
  app shows the change after it next restarts.
- **The title janitor: thread names are managed continuously, not fixed once.** Plumbing-created
  desktop chats (imports, migrations) land "Untitled" or with a generic AI name; every ~10
  minutes the watcher now hands the scanner's real title to any desktop entry that has none.
  A person's rename always outranks it, and generic candidates are never written.
- **The deaf-chat revive.** An imported chat the owner never clicked is live-but-deaf to peer
  messages. `POST /api/sessions/:id/migrate` now takes an optional `prompt`, so the reviewer
  revives such a chat by same-instance re-dispatch: the nudge runs as a real turn on its own
  account and the chat lands back imported, awake. The rubric detects deafness by a nudge that
  produces no transcript movement.
- **Minimum plan is a dropdown** (Max 20× / Max 5× / Pro) in the Orchestrator settings instead
  of a free-text box.
- **Parked threads are listed, and can be unparked, from Settings.** A `/delayo` hold has no
  expiry, but the app only ever showed a COUNT of them - so the only way to lift one was to
  remember which chat you parked and type `/resumeo` inside it. The Orchestrator group now lists
  each parked thread with its name, repo and how long ago, each with an Unpark button, and shows
  up only when something is parked. (Three real threads were sitting parked, from one to three
  hours, when this was built.)

### Fixed

- **A chat that could not be delivered to the desktop app is no longer just lost.** Importing a
  finished run into an instance's app only works while that app is RUNNING - firing it at a
  closed one would boot that account, so it correctly refuses. But that refusal was terminal:
  one line in the console, and the work never appeared anywhere while its queue row still read
  "completed". Since overnight migration exists precisely for when nobody is watching, "their
  app happened to be shut right then" was enough to silently lose the whole delivery. A
  completed run is now armed rather than fired once: an always-on sweep retries every minute
  until it lands, gives up after 24 hours unreachable, and records the last refusal either way.
  The queue shows a badge on a finished run whose chat has not appeared yet, so a waiting or
  abandoned delivery is visible instead of inferred. Covers all three import paths - the migrate
  menu, migrate-on-limit and the desktop handoff surface. A delivery that lands but cannot write
  the chat's title counts as delivered: the conversation is in the app, and re-firing would not
  name it any better.

## [0.30.0] - 2026-08-25

### Added

- **Dead background tasks no longer excuse a chat forever.** A session that looks "waiting on
  background tasks" used to be skipped indefinitely by the reviewer; sessions were found sitting
  9-12 hours on tasks whose output had stopped. The watcher now reads each session's task-output
  mtimes: transcript AND task outputs both silent past `staleTaskMins` (default 120) flags the
  chat as stuck on dead tasks, and the /orchestrate rubric sends an intervention ("check the
  tasks, kill or restart, continue; do not go back to waiting") instead of deferring. Task
  files carry no liveness metadata, so this is deliberately a silence judgment - a wedged-alive
  task after two silent hours deserves the same poke.
- **A limit-migrated chat now lands in the borrowed account's desktop app.** Migrate-on-limit
  moved a 5-hour-walled run onto another account and it kept working, but headlessly: nothing
  imported it, so the owner never saw it anywhere. The migrated resume now carries the same
  `import_to`/`import_title` the "Migrate to another account" menu route uses, so `finalize()`
  delivers the completed run into that instance's app as a visible chat. A same-account
  auto-resume still imports nothing (its chat is already where it belongs, and transcripts are
  shared), and unlike the menu route this one does not archive the old entries first - it fires
  unattended, and archive-then-failed-import would leave the thread visible in no app at all.
  Chat titles are peeled back to the thread's own name, so a third stop no longer reads
  "Migrated resume: Auto-resume: Ship the parser".

## [0.29.0] - 2026-08-25

### Added

- **The orchestrator: a watcher that babysits every open Claude chat** (`docs/ORCHESTRATOR.md`).
  Off by default. A deterministic daemon pass reads the CLI's live-session registry and each live
  chat's transcript tail every minute and publishes an attention feed: chats idle and pending
  input (with the recap to judge from), chats whose context is past a handoff threshold, per-
  account usage band crossings/spikes with a reset-soon exemption, repos left dirty with all
  their sessions idle, off-main branches, and offered task chips. `GET/POST /api/orchestrator`,
  `POST /api/orchestrator/ack`, `POST /api/orchestrator/check`, plus matching MCP tools
  (`get_orchestrator`, `set_orchestrator`, `orchestrator_ack`, `orchestrator_check`). The
  judgment half is an interactive reviewer chat running the shipped `/orchestrate` command
  (`docs/orchestrate-command.md`), because peer messaging is only available to interactive
  sessions - measured, and written into the docs. The command file ships inside the daemon
  (bundled into compiled builds): enabling the orchestrator installs it to
  `~/.claude/commands/` when absent, and `POST /api/orchestrator/install-command` (or the
  `orchestrator_install_command` MCP tool) installs or force-refreshes it on any machine; an
  edited copy is never overwritten without force.

- **Handoff continuations are visible now: launch a new session in a real terminal window.**
  `POST /api/sessions/launch-terminal` (+ the `launch_terminal_session` MCP tool) opens an
  interactive `claude` in a visible terminal, pinned to an instance's account, with the prompt
  delivered byte-exact via a temp file. Unlike a headless queue run it appears on screen, joins
  the live peer registry, and stays steerable by the orchestrator (proven end-to-end: launch →
  register → cross-session message → reply). The launcher prefers the pinned instance's own
  bundled CLI (the globally installed npm CLI, at 2.1.220, registered but hosted no messaging
  socket) and starts from a sanitized environment (a daemon restarted from inside a Claude
  session leaked that session's CLAUDE_CODE_* vars into launches: child-session marker,
  transcript saving off, wrong account).
- **The orchestrator feed now carries the desktop fleet as a routing table** (`instances`:
  running state, account, plan, weekly %, band, reset-soon, staleness). Open means running -
  a running instance with zero chats is open capacity (the first live run undercounted exactly
  that case). New reviewer policy settings: `openInstances` (`never` by default /
  `when-exhausted`), `openMinPlan`, `reviewerReservePct` (the reviewer's own account stays
  under 75% so it can always keep orchestrating), `handoffSurface` (`terminal` / `queue`).

- **`/delayo` and `/resumeo`: park a thread, unpark a thread.** Typed in any chat, `/delayo`
  marks that session held: the watcher generates no items for it (no resume nudges, no
  handoffs, no hygiene pings) until `/resumeo` lifts the hold. Holds persist across restarts,
  never expire on their own, and are listed in the feed (`holds`) so a parked thread stays
  visible as parked. `POST /api/orchestrator/hold` + the `orchestrator_hold` MCP tool are the
  API form; both commands ship in the daemon and install alongside `/orchestrate`.

- **Desktop-chat archiving** (`POST /api/sessions/:id/desktop-archive` + the
  `archive_desktop_chat` MCP tool): flips the desktop's own per-chat metadata flag in every
  profile that carries the chat. Honest caveat carried in the response: an instance whose app
  is running shows the change only after that app next restarts; for closed instances it is
  reliable. The /orchestrate handoff flow now archives the old chat's desktop entry alongside
  the done-mark.
- **Imports keep their titles.** The desktop app derives no title at import time (three
  migrated threads all landed as "Untitled"), so `import-desktop` now takes a `title` and
  writes it into the chat's metadata the moment the app creates it - the same `{title,
  titleSource}` pair the app's own rename writes. The /orchestrate flow passes the original
  thread's title on every import. Session-management note that shipped alongside: a chat in
  the SAME instance as an agent can be renamed and archived live through the app's own session
  tools; cross-instance changes go through the metadata (visible on that app's next restart).
- **Migrate a chat to another account, from the chat's own menu.** Every Claude chat's "…" menu
  gained "Migrate to another account": a flyout of running instances (with their accounts);
  picking one stops the chat's live process if it has one, archives its old desktop entries,
  runs a one-turn migration under the new account, and auto-imports the chat into that
  instance's desktop app under its real title (`POST /api/sessions/:id/migrate`; the
  queue-completion import hook `import_to`/`import_title` does the landing, so nothing polls).
- **Migrate-on-limit: a 5-hour-limited run keeps working on another account.** Off by default
  (`migrateOnLimit` in the Orchestrator settings): when a run hits its 5-hour limit but its
  weekly is fine, the auto-resume monitor resumes it immediately on another running account
  with headroom instead of parking it until the reset; the original account rejoins the pool
  once its window resets. Falls back to the scheduled resume when no viable target exists.
- **Settings gained an Orchestrator section** (between Scheduler and the auto-resume monitor):
  the watcher's master switch with a live status line (live chats / pending items / parked
  threads), new-chat model+effort+ultracode, handoff surface, open-instances policy with the
  minimum plan, and the tuning numbers behind an Advanced disclosure - every knob the API had
  that the UI did not.
- **New-chat defaults: every orchestrator-started chat runs Opus 5 at max effort with the
  `ultracode` opt-in by default.** Settings `newChatModel` / `newChatEffort` /
  `newChatUltracode` govern handoff continuations, chip launches, and terminal launches; the
  /orchestrate rubric applies them on every dispatch, and `launch-terminal` gained an
  `--effort` pass-through.
- **`import-desktop` refuses instances that are not running.** Aimed at a closed instance the
  import spawn would not fail - it would BOOT that instance (measured; a display-name-derived
  path started a sixth desktop app). The endpoint now enforces the same open-instances-only
  rule the reviewer routing follows.

### Fixed

- **One exotic character in one process's arguments no longer blinds instance detection.**
  Windows PowerShell 5.1 encodes piped output in the legacy codepage, so a command line
  containing e.g. "→" came back with raw SUB control bytes that unparsed the whole
  `Get-CimInstance` JSON; the wmic fallback does not exist on current Windows, and every
  instance read as not-running. The scan now forces UTF-8 output and defensively strips raw
  control bytes before parsing.
- **An unset numeric setting no longer clamps to its minimum.** `Number('') === 0` is finite, so
  a settings key with no stored value and no `DEFAULT_SETTINGS` entry came out as the MIN clamp
  instead of the intended default. The orchestrator registers its defaults and its reader also
  treats the empty string as "unset" outright.

## [0.28.0] - 2026-08-20

### Added

- **"Copy session file location" can now put a prompt and the session's name on the clipboard too.**
  The bare path is a fact about the disk, and it is not the thing people do next with it: they hand
  the session to another agent and ask it to carry on, which needs what the conversation was CALLED
  and a sentence to open with. Both are switches under Settings -> Appearance -> Advanced, both
  default on, and the prompt is editable (pre-filled "Resume where we left off"). A live preview in
  the settings row shows exactly what will land on the clipboard, because a clipboard format
  described in prose is one nobody can picture.

  Turning both off gives back the bare path, byte for byte - a test pins that, because this action
  shipped long before the settings did and a path with anything appended stops working the moment
  it is pasted into a terminal. An empty prompt adds nothing rather than a leading blank line, and
  an untitled session contributes no blank line either.

### Fixed

- **The usage-limit badge now disappears when the session is no longer stuck at the limit.** It was
  shown for any session that had EVER hit a wall, which meant a chat that hit one in the morning and
  was finished in the afternoon still wore it - and a badge that never clears stops meaning "this
  one needs you", which is the only thing it is for. It now appears only while the wall is still the
  last thing in the transcript, which is exactly the `pending` verdict the detector already
  computed. Self-clearing, too: resuming a session appends to its file, the scan re-runs, and the
  badge goes on its own. "Ever hit a limit" is still reachable, as a filter, where a historical
  question belongs.

## [0.27.0] - 2026-08-20

### Added

- **A split conversation now says WHY it split, on the row.** 0.26.0 labelled the parts and guessed
  at the cause in a tooltip ("usually because it was interrupted and resumed"), which was a guess
  wearing the clothes of a fact. The cause is not a guess: it is the last thing that happened in the
  file, and it is written there. Across the 30 multi-transcript conversations on this machine the
  superseded parts ended 18x on the user pressing stop, 6x on a safety filter refusing the message,
  3x on an ordinary turn that was picked up again later, and 2x on a server overload (529).

  So the chip carries it: **"part 1 of 2 · you stopped it"**, or "· server was overloaded", or "· a
  safety filter refused it". The last part says nothing extra, because it has nothing to explain.
  The full sentence is on hover. The reason is on the row rather than only in the tooltip because
  the question it answers is asked by LOOKING, not by hovering.

  The reason rides the scan that already reads every record, so it costs no extra I/O, and it goes
  through the same evidence gate as the usage-limit badge: only the CLI's own report counts. A
  conversation that merely discusses being overloaded did not end that way. The interrupt marker in
  particular is anchored and accepted only on a user turn, because the runtime writes it as the
  whole content of one - an assistant repeating the phrase is quoting it, and a row claiming "you
  stopped it" when nobody did would spend the credibility of every other reason next to it. That
  distinction is a test, and it caught the loose first version.

## [0.26.0] - 2026-08-20

### Added

- **A conversation stored as several transcripts now says so, instead of looking like several
  chats.** Interrupt a session and resume it and the CLI does not keep writing to the same file: it
  opens a new transcript, replays the history and carries on. One conversation therefore becomes
  two or three rows with the same title, different message counts, and no visible relationship  - 
  which is what "why is this here twice?" looks like from the outside. Those rows now carry a
  "part 1 of 2" chip explaining that they are one conversation split by an interruption.

  **They are labelled rather than folded, and that was a measurement rather than a preference.**
  Hiding all but the fullest copy is the obvious fix and it is wrong. Across all 36 duplicate
  transcripts on a real store, EVERY older copy held turns the newer one did not - and they were
  not bookkeeping, they were things the user had typed, usually the last thing said before the
  interruption ("See you soon.", "skip domains4sale.uk,, do the rest"), which the resumed file
  never carried over. Not one of the 36 could have been absorbed without deleting somebody's words,
  so nothing is hidden.

  The grouping key is the first message's uuid, captured on the scan that already reads every
  record. A uuid is unique, so two transcripts whose first message is the same message necessarily
  share that history - no content comparison, no reading a second file, and no reliance on the
  title, which genuinely different chats routinely share. Copies are numbered oldest first, so the
  numbering reads chronologically and the message count grows with it.

## [0.25.2] - 2026-08-20

### Fixed

- **Most of the "Unknown account" rows turned out to be a second copy of a chat already in the
  list, and they can now be named.** Reading all 64 of them settled what they actually were: none
  was a subagent, three were continuations of a compacted chat, and 27 were the same conversation
  stored twice - same folder, same minute, and 93-100% of the smaller transcript's messages present
  in the larger, checked by message id rather than by title. Claude Desktop keeps its record
  pointing at one copy, so the other copy has no id to be found by, and that is the one that showed
  up with nothing against it.

  The origin join added in 0.25.1 was already the right instrument; its window was just far too
  narrow. Desktop stamps a chat's creation time when it opens the chat, while the CLI stamps its
  first turn only once the model has answered, and on a cold start that gap is seconds, not
  milliseconds. Widening it from 2s to 60s takes the unattributed rows from 64 to 13.

  60s is measured, not chosen for feeling right. Every candidate width was run against the ~300
  sessions Desktop DOES link by id, asking not "how many does this recover" but "does it ever
  contradict an account we already know": 60s is correct on 305 of them with zero wrong answers and
  zero ambiguous origins, the first ambiguity appears at 120s, and the first wrong answer at 240s.
  The constant carries that table, and a test pins the boundary in both directions so widening it
  has to be a deliberate decision with the cross-check re-run.

  Three of the twin pairs share a title and share no messages at all - different conversations that
  happen to be called the same thing. That is exactly why this join keys on where and when a
  conversation began and never on what it is called.

## [0.25.1] - 2026-08-20

### Fixed

- **A session with no account no longer looks like a session whose account we forgot to draw.** The
  chip naming which Claude instance ran a conversation was simply omitted when we did not know, and
  an omitted chip is invisible: on a real store that was 64 of the newest 400 sessions, all of them
  launched from Desktop, showing nothing at all where the account belongs. Worse, the chip before it
  is the session's SIZE, so on those rows "Marathon" became the last word on the line and read like
  somebody's name. The account chip is now always present for a Claude session, saying "Unknown
  account" with a tooltip explaining that Claude Desktop kept no record rather than that AgentHydra
  is hiding one - and the size chip explains on hover that it is a size, from message count and
  elapsed time, and not a name.

- **19 of those 64 turned out to be knowable after all.** Desktop links its metadata to a transcript
  by session id, and for these it had written no such row. It had, however, written down the same
  conversation's working directory and creation instant. Matching on those two - and ONLY where the
  answer is unique, never where two accounts could both claim it - recovers the account without
  going near the title match this module has always refused, because two chats in one project are
  routinely called the same thing while a folder plus a millisecond timestamp is not a coincidence
  that happens. The remaining 45 have no Desktop record anywhere on disk, verified by searching
  every store it keeps, so "unknown" there is the true answer and not a gap.

- **The instance filter and the instance chip can no longer disagree.** They were answering from
  different places: the filter looked through every id a row speaks for, while the chip asked only
  about the surviving one. Both now go through a single resolver, so a row the filter returns always
  displays the account it was filtered by.

## [0.25.0] - 2026-08-20

### Added

- **The sessions a usage limit killed are now a list you can pull up.** AgentHydra could already
  tell that a conversation had died at a quota wall - that is how the auto-resume monitor decides
  what to restart - but the only place that verdict surfaced was the monitor's own to-do list,
  which hides anything already resolved. So "which of my chats got cut off, and which are still
  sitting there?" had no answer. It does now: **List options -> Usage limits** narrows the session
  list to the conversations a wall stopped, or to the ones *still* stopped at one, and every row
  carries a badge with the provider's own notice on hover ("You've hit your weekly limit · resets
  3am"). On the machine this was written against that is 79 sessions, 40 of them still parked.
  Over MCP the same thing is `list_rate_limited_sessions`, plus a `rateLimited` scope on
  `list_sessions` and a `limit_stop` field on every session row.

  The judgment behind it was not re-implemented for the list. It was lifted out of the monitor's
  tail-reader into one shared accumulator, so the badge and the auto-resume queue physically cannot
  disagree, and it keeps that reader's hard-won evidence rule: only the CLI's own error report
  counts, never model prose or tool output, because the loose version marked every run that merely
  TALKED about rate limits. A transient 529 is still not a usage limit. Claude only - Codex and
  OpenCode record an error, but not in a form worth trusting, and a false badge is worse than a
  missing one.

  It costs nothing to compute. The list scanner already JSON-parses every record of every
  transcript to work out a title and a message count; the verdict rides along on that pass and is
  persisted with it, so the filter is a SQLite query rather than a thousand file reads. Cached
  scans now carry a version stamp, because a row written before the scanner learned this would
  answer "was this rate limited?" with NULL forever - and a NULL there reads as "no", which would
  have shipped as an empty list on a machine full of stopped sessions.

- **An MCP client can finally read ALL the local chat history, rather than the last day of it.**
  `list_sessions` had no time parameter and the route it calls defaults to 24 hours, so an agent
  asked to go through "all my chat histories" issued the only call available to it and got one
  day - 19 rows out of 1,231 here - with nothing to indicate anything had been withheld. The tool
  now takes `period`, explicit `since`/`until` bounds, `offset` for paging past the 500-row
  ceiling, `project`, `instance` and `archived`, and its description states the 24-hour default in
  its first sentence, because a parameter only helps a client that knows it needs one. `foreign`
  joined the `source` enum as well, so the conversations from Cursor, Windsurf, Zed, Copilot CLI
  and the rest are addressable rather than invisible.

  New `list_projects` is the index of the index: every folder that has conversations in it, with a
  session count and a per-provider breakdown, read from the transcript index rather than from any
  transcript. A thousand sessions collapse to a few dozen rows, which is small enough to hand to an
  agent whole - and it is how a client finds out what "all" contains before querying it.

### Fixed

- **Searching conversation bodies now finds the ones from Cursor, Windsurf, Zed, Copilot and the
  rest.** Body search streams each transcript line by line and JSON-parses every line - right for
  Claude and Codex, and wrong for the fourth reader, whose stores are directories of JSON, one big
  JSON document, or a database. Not a line of those parses as a record, so every one was skipped and
  the file reported zero matches. These rows were already in the sweep, so the miss was silent: the
  session was listed, searched, and declared clean. Measured on a real store before the fix, a
  9-line Copilot workspace yielded 0 parseable lines and 0 usable events; after it, one ordinary
  word turned up 11 of these sessions. Search now asks each store's own adapter, exactly as the
  transcript view and the exporter already did. A confident zero is the worst answer a search can
  give, because it is the one that makes the caller stop looking.

- **Every session now says where its title came from.** Threads were turning up under names their
  owner did not recognise, and there was no way to ask the app which of the four title sources had
  produced one. Rows carry `title_source` (`custom` / `ai` / `store` / `envelope` / `message` /
  `id`) and the UI puts it on the title's tooltip. The case worth naming is `envelope`: when the
  first turn arrives wrapped in a pseudo-tag carrying a `name` attribute - `<scheduled-task
  name="nightly-sweep">` - that name becomes the title, so the string was chosen by whatever wrote
  the wrapper (a scheduler, a hook, a harness) and may match nothing the user has ever named. Those
  rows now print the tag beside the title instead of leaving an unattributable label sitting there.

## [0.24.3] - 2026-08-18

### Fixed

- **Two windows of AgentHydra can now be on two different tabs.** Opening a second window to watch
  Sessions beside Instances did not work: clicking a tab in one window moved the other window to
  the same tab, live. Which tab you were on was a single `localStorage` key, and the storage helper
  behind it listens for the browser's cross-window `storage` event by default - two windows of the
  app are the same origin, so every click was broadcast to the other one. That key was doing two
  different jobs at once, and they have been split. Which tab THIS window is showing now lives in
  `sessionStorage`, the one storage scoped the way people expect: it survives a reload (an update,
  a restart, a stray F5 - the reason the tab was ever remembered), the browser copies it into a
  duplicated tab so the duplicate opens on what you were looking at, and from that moment the two
  windows are independent, because sessionStorage has no cross-window event to leak through. Which
  tab a BRAND-NEW window opens on is still the shared, daemon-mirrored preference, so a first
  launch - or a launch on a hopped port with an empty localStorage - still lands where you left
  off. A window that has been somewhere is never relocated by anything but its own user, and a
  click made while that shared value is still being fetched now beats the answer it is racing.

## [0.24.2] - 2026-08-15

### Fixed

- **Quitting from the tray icon while an update is installing no longer leaves you with no app at
  all.** Applying an update starts the replacement daemon and shuts the old one down 800ms later.
  For that fraction of a second the replacement was a CHILD of the daemon on its way out, and the
  tray's Quit does not stop one process, it force-kills a whole process tree. A Quit landing in
  that window therefore killed the outgoing daemon and the incoming one together. Neither
  `detached: true` nor `.unref()` removes a child from its parent's tree on Windows, which is
  exactly why the shared launch helper the browser and editor launches already went through
  exists; the relaunch simply never used it. Measured directly: with the old spawn the replacement
  dies to a tray-style tree-kill, with the new one it survives.
- **The relaunch now survives Windows throwing away the environment.** That launch helper hands the
  process off to Windows' own process-creation service, which does not pass on environment
  variables, and the port and the "you are the replacement" signal were both environment
  variables. Left as they were, the replacement would have concluded it was an ordinary second
  copy, seen the outgoing daemon still answering, and exited, which is the zero-daemons failure
  again by a different route. Both now travel as command-line arguments, which that service does
  deliver, with the environment kept as a fallback for macOS and Linux.

## [0.24.1] - 2026-08-15

### Fixed

- **An update no longer moves the daemon to a different port and kills the tab you had open.** The
  auto-update relaunch handed its successor `PORT`, the port this daemon *preferred*, rather than
  the port it was actually serving on. Those are the same number only until something else takes the
  preferred port once; from then on every update aimed the successor at the wrong one, and the
  successor uses that value for both of its jobs. So it waited out its full 8-second handoff timeout
  on a socket its predecessor never held and nobody was going to release, and then bound the
  preferred port instead of the one your browser was talking to, so the open dashboard's event
  stream died against a daemon that was otherwise perfectly healthy. That is the "localhost keeps
  breaking and I have to restart it by hand" report: the runtime pointer follows the new port, the
  window does not, and relaunching the executable just finds the new daemon answering and exits
  without opening anything. In one field log all eleven auto-update relaunches moved off the
  configured port, ten of them after burning the full 13 seconds of both port waits. The successor
  is now given the bound port, so the wait applies to the socket actually being released and the
  daemon holds one address across updates.
- **Dropdown menus are as wide as their widest item, not as wide as the button that opened them.**
  The kit's `DropdownMenuContent` pinned its width to `--reka-dropdown-menu-trigger-width`, so a
  menu hanging off an icon button was ~30px wide, i.e. clamped to the `min-w-32` floor, and every
  label wrapped onto two or three lines. Nobody noticed because each usage site passed a fixed
  `w-52`/`w-56`/`w-72` that overrode it, which is the other half of the same bug: fifteen hand-picked
  widths that pad short menus out and go stale the moment the labels change. The binding is gone
  (`SelectContent` keeps its own on purpose, because a select panel really should match its field),
  and every usage site's `w-N` became `max-w-N`, so no menu can be wider than it is today and
  anything shorter shrinks. The transcript ⋯ menu went 274px → 203px, list options 224px → 212px,
  the instance filter submenu 320px → 209px, with nothing wrapping. Same fix ContextMenuContent
  received for the same reason; it lives in `lunarwerx-ui`, so the other kit apps pick it up on
  their next sync.

### Changed

- **An open chat's toolbar is four buttons instead of nine, and the composer's run settings are
  icons until you change one.** The header row above a transcript had grown to find, display, open,
  save, copy-file, copy-path, reopen-in-terminal, session-id and close. It shares a wrapping flex
  with the session title and its metadata, so on any narrow pane that row of icons pushed the
  title's own line out of the way, and nine unlabelled glyphs is a row you read rather than aim at.
  Find, copy-the-path and copy-the-session-id stay out, because those are the ones you reach for
  mid-read or paste into another tool; close stays out because a close button belongs nowhere else.
  Everything else moved into a ⋯ menu, the same treatment the session list's own toolbar already
  had. The display toggles keep their trigger's "something is hidden" state on the ⋯ button, so a
  filtered transcript still says so while collapsed. Menu rows carry no explanatory second line:
  the labels are full sentences already, and a menu that explains every row is one you read rather
  than aim at. The path button did stop sharing the clipboard glyph with the session-id button next
  to it, since two identical glyphs side by side are indistinguishable at icon size.

  In the composer, model, effort and permissions are overrides on top of what the chat is already
  running with, and the common case is that none of them are set, so three chips reading
  "Model · Effort · Permissions" spent the row's width naming dimensions rather than stating facts.
  Each is now an icon while it sits at the default and grows a label only once you override it, with
  a rich tooltip carrying the name and what it does. The row reads as "what did I change". Account
  and working directory name a fact rather than an override, so they keep their labels wherever
  there is room. The whole row is a container query, not a viewport one, because the sessions
  sidebar is drag-resizable and a wide window can still leave this box narrow: at 392px every label
  drops and the row is nine icons on one line. The queue builder, where a new chat is started and
  nothing is inherited, keeps its full labels.

- The kit drift-check is now reachable as `check:local`, a name a pre-push runner can look for. It
  is the one gate GitHub structurally cannot run, since it compares this app's synced copies against
  a private sibling repo a public workflow can never check out, so its only enforcement was a
  pre-commit hook that `--no-verify` skips and that silently does nothing on a machine without the
  sibling checkout. Developer-facing only; nothing about the app changes.

## [0.24.0] - 2026-08-15

### Added

- **One conversation is now one row, however many files Claude Code split it into.** Three rows
  titled "rQubit T10-M06 v1 piece hash parity" with 823, 1071 and 3179 messages were not three
  chats and were not subagents. They were one conversation that ran out of context twice: 881
  message uuids appear in more than one of those files, 96.4% of the smallest. When Claude Code
  compacts a session it does not keep writing to the same transcript, it opens a NEW file with a
  NEW session id, replays a summary of what came before, and carries on; resuming a compacted
  session does it again. Every one of those files is a legitimate transcript with its own id, so an
  index keyed on session id, which is the only key the store offers, saw three conversations and
  listed three rows. On this machine 94 of 1,208 conversations are continuations, so this was never
  a one-off.

  What links them is a `logicalParentUuid` on the continuation's opening record, naming the message
  in the previous transcript it was compacted from. That target is an ordinary message sitting
  anywhere in the parent (82% of the way through, in the case above), not a header, so resolving it
  means reading candidate transcripts. That work happens BETWEEN sweeps, never inside one, and its
  answers are written to disk: a transcript's history cannot change once written, so each link is
  resolved at most once ever. The search tries candidates in order of how close their last-write
  time is to the continuation's, because a compaction is immediately followed by the continuation
  that replaces it, so the parent is almost always the first file opened.

  The row that survives is the LAST in the chain, because that is where the conversation actually
  is: clicking it opens what you were doing, not the truncated original. Superseded transcripts stay
  in the index exactly as subagents do, so nothing that counts tokens or money loses sight of them,
  and a transcript whose successor is missing is kept rather than hidden, because it is then the
  only surviving evidence that the conversation happened.

## [0.23.1] - 2026-08-14

### Fixed

- **Opening a chat took 16 to 23 seconds, and how big the chat was had nothing to do with it.** A
  672 KB conversation was as slow as a 12.6 MB one, which is the tell: the wait was never the file,
  it was the queue in front of it. AgentHydra keeps an index of every transcript on the machine,
  23,000 files and 8.9 GB on the machine this was found on, and building it takes seconds. The
  index stamped itself with a clock reading taken **before** that build and then trusted it for two
  seconds, so a snapshot was already ~9 s old the instant it was stored and could never once be
  considered fresh. Every request therefore scheduled another rebuild, forever. Worse, the rebuild
  that was described as running in the background used the **synchronous** builder, which holds
  Bun's event loop for its entire duration, so `/api/health`, a route that reads nothing at all,
  answered in 6.6 seconds. The daemon spent essentially all of its time rebuilding an index it
  could never keep, and every request queued behind that.

  A snapshot is now stamped when the sweep **finishes**, which is when it actually became true, and
  is trusted for 10 s: comfortably longer than a sweep, and deliberately just under the 12 s
  session-list poll, because a lifetime longer than the poll consuming it leaves the list a full
  cycle behind. Revalidation goes through the async builder, and the sync and async paths now share
  one in-flight guard instead of two that could not see each other. A lookup for a session that is
  not in the snapshot (a chat created moments ago, or a deleted one the UI is still polling) no
  longer buys a blocking whole-store scan: the routes that can wait now await a sweep that yields.

  Two stores were re-read from scratch on every sweep and are now kept against file mtime and size:
  VS Code Copilot, whose chats have to be JSON-parsed in full because that is the only place their
  titles live (5.2 s for 355 chats, the single largest slice), and OpenCode, whose listing sizes
  each session with a subquery that walks the whole message table once per row (939 ms). The VS Code
  reader also yields while it parses, so the first sweep after launch cannot freeze the app.

  Measured on the same machine, same three chats: opening a chat 16,540-23,211 ms → 1-5 ms; a warm
  sweep ~9,500 ms → ~1,050 ms; the worst event-loop stall in steady state ~9,000 ms and continuous →
  64 ms; the stall on the first cold sweep after launch 6,490 ms → 1,523 ms. A CI guardrail now
  fails the build if the index is stamped before its own sweep, if its lifetime drops below the time
  a sweep takes, if it exceeds the poll that consumes it, or if revalidation goes back to the
  blocking builder.

- **The chat pane and the session list could stack up requests against a slow server.** Neither poll
  checked whether its previous request had come back, so a server that answered slower than the
  interval asking it accumulated a queue of identical questions whose answers were all discarded but
  the last. The newest, the only one that mattered, waited behind every stale one. Both now
  hold off while a request is outstanding. The session list **coalesces** rather than skips, because
  every filter control calls the same refresh: dropping one would leave the list showing the old
  filter until the next tick. A chat read that fails after you have already clicked away no longer
  blanks the conversation you moved to.

- **`bun run dist` said `EACCES: permission denied` when the real problem was that AgentHydra was
  running.** Windows cannot unlink a running executable, so wiping `dist/` fails whenever a
  previously built AgentHydra is still up, which is the normal state on a machine where the app is
  installed from this checkout. The error named a permission and a directory, so it sent you
  looking at ACLs and elevation; the actual fix is to quit one process. The wipe now goes file by
  file (one lock cannot take the whole clear down with it) and, when something is locked, names the
  offending process and its pid, plus the `--outfile` escape hatch for building without touching
  the running app. Verified against a real lock, not a simulated one: a running `dist/AgentHydra.exe`
  now produces `pid 85060  D:\...\dist\AgentHydra.exe` and the command to end it.

## [0.23.0] - 2026-08-13

### Fixed

- **An agent can now tell which of your accounts it is spending.** `whoami` read one environment
  variable, `CLAUDE_CONFIG_DIR`, and fell back to the default `~/.claude` login when it was unset.
  That is right for a CLI instance and wrong for **every Claude Desktop session**, which sets no
  such variable at all: the account is chosen by the Electron host's `--user-data-dir`. So a Desktop
  agent reported `instance: null` and the default login while actually spending a different
  account's quota, and `check_my_usage` then read that default login's `.credentials.json` and came
  back `check_failed` with every percentage null. An agent asking "how much do I have left?" got no
  answer, about the wrong account.

  Identification is now layered and stops at the first signal that lands: `CODEX_HOME` →
  `CLAUDE_CONFIG_DIR` → `CLAUDE_CODE_EXECPATH` → the instance folder holding this session's
  `claude-code-sessions/**/<hostSessionId>.json` → the parent `claude.exe`'s image path → the
  grandparent Electron host's `--user-data-dir`. `CLAUDE_CONFIG_DIR` deliberately outranks the
  desktop signals, because when it is set that is the credential `claude` uses, even in a terminal
  opened from inside a Desktop instance.

  **The obvious fixes are all wrong, and each was tried first.** Identifying by the session's own
  transcript fails because a Desktop-instance session still writes to the DEFAULT
  `~/.claude/projects/…`: that proves where a session LOGS, not which account PAYS. Reading
  `~/.claude.json`'s `oauthAccount.emailAddress` fails because it is the machine's default login,
  not the running session's credential; it looks authoritative and is not. And reading
  `CLAUDE_CODE_EXECPATH` alone fails **only where it matters**: a stdio MCP server gets a reduced
  environment without it, so that detector passes every shell test and then does nothing in
  production. Hence the session-file and process-ancestry layers, and hence the regression test
  built on the exact environment an MCP server really sees.

  Nothing is asserted without proof. Every answer carries `confidence` (`exact` when a signal named
  the credential store, `assumed` when it is the default login by elimination, `none` when this is
  not Claude Code at all), the `method` that won, the literal `clues` that produced it (an env
  value, a file path, a pid), and everything `ruledOut` and why. A `warning` appears only when the
  answer is uncertain or when two signals disagree, so its absence is itself the signal that a
  number can be quoted without a hedge. Collapsing "I could not tell" into "it is the default
  login" is precisely how the original bug reported a confident wrong account.

- **`check_my_usage` reads the desktop credential store.** A desktop instance keeps its token in
  Electron safeStorage, not in a `.credentials.json`, so the old `configDir` read could not open it
  even when pointed at the right folder. The self-check now routes through the instance number and
  its full credential chain (own token → linked CLI login → dispatch account), which is the same
  path `/api/usage?instance=N` already used. An unmanaged desktop user-data dir is answered
  in-process for the same reason.

### Added

- **AgentHydra now ships its own operating rules to every agent, so a human never has to type
  them.** Two channels, because they reach different moments:

  The MCP `initialize` handshake returns `instructions` (the shared engine gained an optional
  passthrough, so every sibling app can do this too). The client shows that block to the model once
  per session, **before it calls anything**. That timing is the entire point: a tool description is
  only read once the model has already decided to call that tool, which is useless for the two
  behaviours that matter, checking quota BEFORE the expensive thing and saving your work BEFORE
  being cut off. Neither is discoverable from a tool list. It is deliberately short, and a test
  caps its length: it rides in context on every request of the session, so each line is rent, and a
  guidance block that grows a line at a time ends up skimmed instead of read.

  And every usage or identity answer now carries a `nextStep`: ONE line naming the single action to
  take, ordered by urgency so the most expensive mistake is always the sentence shown. `advice`
  already described the situation; this is the instruction, at the top level, because an agent
  reading a nested object has to decide for itself what a severity implies and the decision it
  skips when busy is exactly the one that costs the task. When the account could not be confirmed
  the line suppresses the account name entirely rather than guessing: a confident wrong
  attribution gets acted on, a missing one gets questioned.

- **`usage_budget {}` with no arguments budgets the caller.** It used to throw unless you named an
  instance, dir or account, which meant the one caller who most needs a burn rate, an agent deciding
  whether it can finish, had to already know its own instance number, and a Desktop session had no
  way to learn it. The response carries an `identity` block naming the account it measured.

- **`/api/usage/budget?configDir=…`.** The plain `~/.claude` login belongs to no instance and no
  dispatch account, so it could get a percentage from `/api/usage` but never a burn rate, which is
  the number that actually decides whether to keep working.

- **Rate-limit `tier` on every instance row** (`Pro`, `Max 5×`, `Max 20×`), beside the existing
  `plan`. They answer different questions and can disagree: `plan` is what the subscription is
  called (an org seat reads "Team"), `tier` is what the quota is. Headroom differs by roughly 20×
  between Pro and Max 20×, so pacing cannot be read off the plan name.

## [0.22.0] - 2026-08-13

### Fixed

- **OpenCode subagents are no longer listed as separate conversations.** OpenCode is the one store
  that keeps a subagent as a row in the same `session` table as a real chat, told apart only by a
  `parent_id` column this repo never read. So a single six-way review filled the sidebar with seven
  near-identical rows, one conversation and six `(@investigator subagent)`, and on the machine this
  was found on, 45 of 92 OpenCode sessions were subagents. Claude and Codex already reach this
  verdict in `server/src/transcript.ts`; OpenCode now reaches it one layer later, in the list
  builder, for the reason below.

  **The obvious fix would have deleted money.** Those child rows carry their own tokens, 1.74M of
  them, about a sixth of all OpenCode spend, against models the parent never ran (21 of 45 children
  used a different model). The analytics scan walks every index row by id, so dropping subagents
  from the index would have silently removed that spend from every total, and `findTranscript`
  would have stopped resolving them for the open, export and delete routes. They stay indexed and
  are filtered only where the list of *conversations* is built, so totals and lookups are untouched.

  Two edges are handled rather than assumed away. A store without the column (an older OpenCode, or
  Kilo, which writes this same SQLite) would have thrown into the one `catch` that guards the
  listing and returned an empty array, reporting **no sessions at all** rather than no subagents; a
  `pragma` probe asks before naming the column. And parentage that does not form a tree (a row
  claiming itself, or two rows claiming each other) would have seen an existing parent on every side
  and hidden all of them, so ownership is resolved by walking the chain to a real top-level session:
  anything else keeps its row, on the existing rule that nothing may be silently unowned.

### Added

- **A session row says when it stands for a fan-out.** Rows that spawned subagents now carry a
  `5 subagents` chip. Hiding 45 rows with nothing on screen to account for them is how a fix reads
  as data loss, and the count is credited to the top-level session rather than to the immediate
  parent, so a chain two deep still reports on the row a reader can actually see.

## [0.21.0] - 2026-08-13

### Added

- **The background warm now finishes.** It was a single 120-second burst, which covered a whole
  store back when the scan read 1,229 Claude transcripts; now that it also reads their 16,579
  subagent transcripts, one burst reaches about a third of the store and stops. That left the
  analytics tab showing a partial answer with no sign anything would ever complete it, and a Rescan
  button the user was expected to keep pressing. It now runs in bounded chunks with a pause between
  them until the store is covered, and stops the moment a chunk makes no progress.

- **`bun run audit`: prove the numbers against the store.** Three counting errors shipped in one
  day and every one of them passed a green test suite, which is the part worth fixing. A unit test
  over a hand-written fixture pins the behaviour its author believed in; when the belief is wrong,
  the fixture encodes the same wrong belief and the test agrees enthusiastically.

  So the audit does two things a unit test cannot. It **accounts for every file**: each transcript
  in each store is either indexed as a session, attached to one, or excluded for a NAMED reason,
  and anything left over is a failure by definition, because nobody decided about it. And it
  **recounts the tokens by a second implementation** that shares no code with the first: no import
  of the usage parser, no call into the analytics scanner, enforced by a test that reads the source.
  Two implementations only catch a wrong assumption while they are genuinely two.

  It found real problems on its first run. Cowork's sandbox keeps a whole Claude Code home of its
  own, so a run's directory holds the audit log, the CLI's own transcript and that session's
  subagent tree; the file check reported them unowned. Chasing that surfaced two more: the store
  scanner skipped dot-directories, so those nested transcripts were invisible to the indexer
  entirely, and some Cowork runs write no audit log at all, so their nested transcript has to become
  the session rather than attach to one that is not there.

- **Prices are downloaded rather than frozen into the build.** A hand-typed price table is correct
  on the day it is written and decays from then on: providers cut prices, and every model missing
  from the table was reported as unpriced. AgentHydra now pulls LiteLLM's public price catalogue
  (about 3,600 models across OpenAI, Anthropic, DeepSeek, xAI, Google, Moonshot and the rest), caches
  it beside the database, and re-checks it daily. The table shipped with the build is still there
  and still answers on a first run, an offline machine, or a failed download; a downloaded price
  simply wins when one is in force. Either way the analytics header now says which it is and how old
  the rates are, because a dollar figure without its price date is a number nobody can audit.

  Service-tier variants (batch, flex, priority, long-context bands) are deliberately ignored: a
  stored transcript does not record which tier a request used, so picking one would be a guess
  dressed as precision.

- **OpenAI models are priced.** GPT-5.6 Sol/Terra/Luna/Cyber, the 5.5, 5.4, 5.3-codex, 5.2, 5.1 and
  5 families, at published rates. Codex spend now carries a dollar figure instead of a token count,
  and the cache rates are modelled properly: cached input at a tenth, and cache *writes* free
  before GPT-5.6 and 1.25x from 5.6 on, which are genuinely different numbers rather than one
  averaged one.

- **A model routed as `provider/model` prices as the model behind it.** OpenCode records what it
  routed to (`openai/gpt-5.5`, `deepseek/deepseek-v4-pro`), which missed a table keyed on bare ids
  even where both sides plainly agreed. The exact id is still tried first. Bedrock and Vertex ids
  still do not match, which is correct: those are partner-operated with their own pricing.

- **Five more tools are read, not just detected.** Each got an adapter built against real files
  rather than a guessed schema:

  **Claude Cowork** turned out to be the easiest and the biggest: it runs Claude Code inside a
  sandbox and keeps the run's own transcript at `local_<id>/audit.jsonl`, and those records are
  Claude Code's exactly, model id, message id and a full usage block included. So it needed a path
  pattern, not a parser, and its sessions arrive with full transcripts, costs and analytics like any
  other Claude session.

  **Grok**, **Kimi**, **VS Code Copilot**, **Copilot CLI** and **Zed** share nothing with those
  three stores or with each other, but they do share the one thing that matters: a list of
  conversations that can be read, and no per-token usage to account for. They get one new reader
  between them and a small adapter each. Their sessions are listed, readable, searchable and
  exportable, and contribute nothing to the spend charts, because none of these tools records what
  a turn cost. Copilot bills credits and never writes a token count at all. A zero there would be a
  claim the work was free.

  Copilot CLI is the honest exception even among those: it stores state and checkpoints but no
  conversation, so its sessions carry everything the store does record (repository, branch, folder,
  both timestamps) and open to its checkpoint list rather than to a transcript.

  A session row now shows which PRODUCT wrote it rather than which format it happens to share, so a
  Grok chat is labelled Grok and a Cowork run is not filed under Claude Code.

- **Speculative support for the wider agent ecosystem.** Where a tool keeps its conversations is now
  a table of about sixty entries rather than three constants, with paths compiled from the registry
  in [agentsview](https://github.com/kenn-io/agentsview) (MIT), covering Windows, macOS and Linux.
  Tools that write a format AgentHydra already reads are indexed for real, with full transcripts and
  analytics: **OpenClaude** (Claude Code's JSONL), **TraeX** (byte-compatible Codex rollouts), and
  **Kilo, MiMo Code and IcodeMate** (OpenCode's SQLite under other filenames). Sessions now record
  which *product* wrote them, not only which format, so a fork is not mislabelled as its parent.

  Everything else (Gemini CLI, Copilot, Cursor, Amp, Qwen, Zed, Warp, Goose and some forty more)
  is **detected and listed** with its store location, file count and last activity, marked as not
  yet readable, with the reason where there is one (Antigravity and Trae encrypt their conversations;
  Copilot and the IDE integrations bill credits rather than tokens). Listing them is the point:
  silence would read as "AgentHydra looked and found nothing", which is a different claim entirely.

  One store root is deliberately narrow: Gemini CLI is looked for under `.gemini/tmp` rather than
  `.gemini`, because the parent also holds settings and the entire Antigravity tree, and pointing at
  it reported hundreds of files for a Gemini CLI that had never been run.

  These entries are speculative and bounded by construction. A path that does not exist costs one
  filesystem check and produces nothing; a format claim that turns out to be wrong yields a store
  that parses to zero sessions. Neither can affect the three stores that were already supported.

### Fixed

- **A third of Codex spend was filed under a model that does not exist.** Codex announces the model
  in one event and the token count in another, and does not guarantee the naming comes first: of
  4,860 rollouts on the machine this was found on, 2,067 spend tokens before ever naming a model,
  and 331 billion tokens were landing under a placeholder id called `codex` that no price table
  could ever match. Those turns are now attributed to the model their own file names moments later,
  falling back to the model the rest of that rollout used, and only staying unknown when nothing in
  it ever said.

- **Claude spend was also UNDERSTATED, by more than half, and for a different reason.** A Task-tool
  subagent gets its own transcript, nested under the session that spawned it, and makes its own API
  calls with its own usage blocks. The index only ever globbed one level deep, so none of it was
  counted. Measured here: 1,229 top-level transcripts hold 64.5 billion tokens and **16,552 subagent
  transcripts hold another 89.8 billion**, so the totals were reporting 42% of real Claude spend.

  Those files now attach to the session that spawned them and are read as part of it. They are still
  not session rows: a subagent is an implementation detail of the turn behind it, and listing
  thousands of them would bury the conversations. Summing them is safe in a way it explicitly is not
  for Codex, because every Claude record carries its own request id and the duplicate check below is
  shared across all of a session's files.

- **A long window charts by month instead of by day.** Past seventy bars a day-by-day chart stops
  being readable and becomes a texture. The rollup keys off how many buckets there actually are, so
  a sparse "all time" still shows its days.

- **Claude spend was overstated by 57%, since long before this cycle.** Claude Code does not write
  one transcript record per assistant reply. It writes one PER CONTENT BLOCK, and stamps the same
  complete `usage` object on every one, so a reply that says something and then makes two tool calls
  is three records each claiming the full input, cache-read and output of the single request behind
  them. Every total built by summing records charged that request three times.

  Measured across 1,230 transcripts here: 445,317 assistant records carry usage, but only 185,264
  distinct requests. The naive sum reports 148.8 billion tokens where the real figure is 64.6
  billion. Of a 5,000-group sample, 4,997 are identical copies rather than a growing partial count,
  so this is content-block fan-out and not streaming.

  A request is now charged once, keeping the largest output figure recorded for it, which also
  handles the rarer streaming case where an early record carries a partial count and the final one
  the billed count. Everything downstream moves with it: session costs, the analytics totals, the
  hour grid (which now counts replies rather than records) and the quota calibration, whose numerator
  and denominator both come from this parser and so stay self-consistent.

  Not fixed, and stated rather than hidden: a resumed session copies its parent's earlier messages
  into its own transcript, so a request billed once can appear in two sessions. That is another
  10.8 billion tokens, about 7% of the naive total. Per-session totals cannot see across sessions,
  and the quota window (which reads several files at once) now does dedupe across them.

- **Codex spend was overstated by 53x, by a "fix" in this same unreleased cycle.** Codex writes one
  rollout file per execution thread, and it looks exactly as though each file carries that thread's
  own spend, so summing a conversation's files looks like the cure for an undercount. It is not.
  `total_token_usage` is a SESSION-WIDE running total that every thread writes into its own file, so
  each rollout replays the whole conversation's counter from the beginning.

  Measured rather than reasoned: in one real conversation the main rollout and three sub-agent
  rollouts all open at exactly the same totals, and three sub-agents that ran inside a nine-minute
  window each record 5,090 counter events climbing to 552 million tokens. No nine-minute thread
  makes five thousand API calls; they are one counter seen four times. Summing 679 files turned a
  700-million-token conversation into 92.9 billion, and the store total from 11.9 billion into 637
  billion, which wrongly made Codex look like the largest provider on that machine.

  A conversation is now the LARGEST of its rollouts, never the sum. Across 109 real conversations
  that is the main rollout 107 times; the two exceptions are conversations whose main rollout
  stopped being written before a sub-agent did, and taking the maximum gets those right too. Because
  the extra files are copies rather than spend, they are no longer read at all, which also removes
  gigabytes of pointless I/O from every scan.

- **The statistics were Claude-only.** Codex and OpenCode sessions reported zero tokens, which read
  as "you have not used them" rather than "we did not look". Both record their spend; they simply
  record it in shapes the Claude parser does not understand. On this machine that was **12.2 billion
  Codex tokens across 136 sessions** and 57 OpenCode sessions, all previously invisible.

  Codex has two traps in it. It writes a RUNNING total alongside a per-turn delta, and summing the
  deltas overcounts, because the same turn is emitted more than once: measured 5% high on a real
  3,476-event rollout. It also counts cached input INSIDE its input figure where Anthropic reports
  it alongside, and on a real session that cached part is 98% of the input, so taking it at face
  value double-counts nearly everything. OpenCode needed no parser at all, only a read: its totals
  are already columns on its session row, and it computes its own cost, which is now used rather
  than recomputed.

- **Models with no published price showed as $0.** That is not "we could not price this", it is
  "this was free", which for a month of GPT usage is simply false. The cost chart now lists only
  what it can actually cost, and names the rest underneath with their token counts.

### Added

- **Where the tokens went.** Fresh input, cached input, cache writes and output, as a share and as
  four numbers. They cost wildly different amounts per token, so the split explains a bill in a way
  the total never can: on a real store, cached reads are 97% of all volume.

- **Tokens by tool,** so which of Claude, Codex and OpenCode is doing the work is answerable at a
  glance.

### Changed

- **The concurrency chart's hover pointed at the wrong place.** An SVG with a viewBox is scaled to
  fit and centred inside a wider element, so mapping the pointer across the element's full width
  read every position as further right than it was: over a hundred pixels of error at the left edge
  of a wide card. Both time charts are now drawn at exactly the width they are given, so one unit is
  one pixel, nothing is letterboxed, and neither chart clips or scrolls.

- **Charts have proper hover cards.** They used the browser's own tooltip, which waits about a
  second before appearing, so sweeping across a heatmap (which is how a heatmap is read) showed
  nothing at all. The cards appear on the pointer event and carry context rather than a repeat of
  the label: an hour cell says its share of the week and its day and hour totals, the day chart says
  its share of the window and the busiest day, and the concurrency line says what changed since the
  previous point. Cells keep an accessible name, so the grid is not mouse-only.

- **The folded "N more" rows expand.** Every ranked chart hid its tail with no way to see it. The
  scale still spans the whole list, so revealing the tail never resizes the bars already on screen.

- **Analytics can be filtered by provider** (Anthropic, OpenAI, DeepSeek and the rest), derived from
  the model id, so a store with five vendors in it can be read one vendor at a time.

- **The hour-of-week grid is square and fills its card.** Its cells were stretching into rectangles
  on a wide card, which stopped it reading as a calendar.

- **The recently-edited feed is readable.** It was absolute paths in a monospace column, so every
  row began with the same thirty characters and the useful part sat off to the right. It now leads
  with the filename, tags the file type, collapses repeated edits to one row with a count, and says
  how long ago.

## [0.20.0] - 2026-08-13

### Added

- **An Analytics tab: where the time and the money went.** The scanner that builds the session list
  already opens every transcript and reads every line, works out a title, and throws the rest away.
  It now keeps the totals: tokens per model, a sparse day and hour histogram, tool counts, and four
  counters. On a real 1,435-session store that is **556 KB**, a fraction of a percent of the
  transcripts it describes. It is emphatically not a full-text index: not one word of a message is
  stored, and every value is a number or a key that came from a tool name, a model id or a date.

  The tab answers cost by day, by model, by project and by dispatching account; when in the week the
  work actually happens; how many sessions were running at once; the tool mix; which files have been
  edited lately; and which sessions are worth a second look because a tool failed repeatedly, the
  edits churned, or the context was compacted. There is also `--spend --json` for scripts, and
  `get_spend` / `get_activity` / `get_recent_edits` / `get_run_cost` over MCP.

  **Cost per queued run is the one AgentsView structurally cannot do.** It did not dispatch the work,
  so it cannot tell which turns belong to which run. AgentHydra recorded the session id and the exact
  instants the run started and finished, so a run's cost is simply that session's own per-turn usage
  restricted to that window. It is computed on demand and never stored, which is what makes it
  impossible for it to drift from the session's own total.

  Two honest limits, both stated in the app rather than only in the code. The costs are published
  list prices, and a subscription plan is not billed per token, so they answer "what would this have
  cost on the API". And "agent hours" is engaged time (the gaps between turns, each capped), not
  wall clock, because a session left open over lunch is not six hours of work.

  No charting library was added. The charts are hand-written SVG, and the palette is a validated one:
  the kit's own chart colours fail a colourblind-safety check in light mode, with two of its five
  slots indistinguishable even to full-colour vision.

- **A session you can hand to someone.** The only export was the raw `.jsonl`, which is complete and
  unreadable. Sessions now save as Markdown, or as one self-contained HTML file that opens in any
  browser with nothing beside it. Both cover the WHOLE session rather than the window the viewer
  shows, because a silently truncated document is worse than none: the reader has no way to know
  what is missing. The raw file is still there, and is still the only lossless one.

  Secrets in recognisable formats are replaced on the way out, and the document says so in its own
  header rather than only in the code. That is the same guardrail the ChatGPT context pack has
  always used, now shared between them instead of copied.

- **What a session printed that it should not have.** A transcript keeps whatever scrolled past,
  including the time a tool echoed a key. The session header now shows a count when there is one,
  with a redacted list of what and where. It matches unmistakable formats only (private keys, AWS
  key ids, provider tokens), so a count of zero is not a clean bill of health and the UI says that
  too. There is no reveal button, and no endpoint that could serve one: the transcript is already
  open one panel away, so revealing here would only add a second place credentials live.

- **Reopen a finished session in a terminal.** You could type into a running session but not sit
  back down in a finished one. The session header now runs `claude --resume` in a new terminal.
  Where no terminal can be opened (an unusual Linux setup, a machine where the CLI is not on PATH),
  the command lands on your clipboard instead, because a feature that fails silently on an odd setup
  is worse than one that hands you the string.

- **Which sessions AgentHydra queued, and which you drove by hand.** Known exactly rather than
  guessed: every dispatch names the session id on the command line, so this is a fact the daemon
  already had. Each row now says which it is, and the list can narrow to either. Narrowing is always
  something you ask for; nothing is hidden on our initiative.

- **A dot for how live each session is,** working / idle / stale, derived from the same timestamp the
  list is already sorted by and sitting right next to it. It is a claim about file activity, not
  about whether a person is present, which is the only thing a transcript can honestly support.

- **Session shape: quick, standard, deep, marathon, automation.** Two sessions with similar titles
  can be a two-minute question and a six-hour build. Shape is worked out from the message count and
  the elapsed time together, taking whichever makes the session notable: thirty messages over six
  hours is a long sitting, three hundred in ten minutes is a grind, and counting messages alone
  would call the first one "quick". Also a filter.

- **Keyboard shortcuts, and a `?` sheet that lists them.** There was no shared layer and no way to
  discover a binding. The sheet is generated from what is actually registered, and a view's
  shortcuts unregister when it unmounts, so it cannot list something that is not really there.
  Ctrl/Cmd+F finds in the open session, Ctrl/Cmd+K jumps to the filter, Ctrl/Cmd+1 and +2 switch
  tabs, Escape backs out one step.

- **`--version --json`**, emitting a schema-versioned object with the version, the commit and the
  build time. Auto-update is a `git pull`, so two machines can sit on the same version number and
  different code; the commit is the field that tells them apart. Release binaries carry a stamp
  applied at compile time (asking git at runtime would describe whatever checkout the exe was copied
  into), and a source checkout answers from git, where that IS the build. Still no database
  and still no port, so the fast path is intact.

- **A one-line Windows install** that verifies what it downloaded. `install.ps1` detects the
  architecture, fetches the release ZIP and its published SHA-256, and refuses to unpack anything on
  a mismatch or a missing checksum entry. There is no skip switch, because a checksum you can opt
  out of is decoration. It installs under `%LOCALAPPDATA%`, so it never asks for Administrator.

- **A long session can now be read.** Two things were missing and they compound: there was no way to
  change what a transcript shows, and no way to find anything inside the one on screen.

  A **Display** menu in the session header now controls both what is fetched and how densely it is
  drawn: *only what I typed*, *show tool activity*, *show reasoning*, and a *compact layout*. The
  filters are applied on the daemon **before** the turn window is counted, which is the whole point:
  asking for a person's turns on a 2,000-message session returns their last few dozen questions, not
  whatever handful survives a filter over the last 40 mixed turns. Reasoning blocks are newly
  *visible* at all (they were unconditionally discarded before, so there was no way to see what a
  model had been thinking), and they stay off by default, because they are the bulkiest and least
  skimmable part of a transcript. Every choice persists and is mirrored through the daemon, so it
  survives the port hop that gives the browser a fresh origin. Also on the MCP `tail_session` tool,
  where `humanOnly` is the cheapest way for an agent to find out what a session was actually asked
  to do.

  **Find in session** (the toolbar's magnifier, or Ctrl+F) searches the open transcript with a match
  count, next/previous and Escape to close. It is client-side over what is already loaded, so there
  is no request behind a keystroke. Matching is done against what the reader sees rather than the
  underlying HTML: a message containing `a & b` is `a &amp; b` by the time it is markup, and a
  search that ignores that finds nothing for `&` and a phantom hit for `amp`. Tag names, class
  names and link targets are never matched, and the only tag highlighting adds is `<mark>` around
  text that is still escaped, so it cannot turn inert transcript text into live markup.

- **An open session now shows what it cost.** Every assistant turn in a transcript records its own
  token usage, and the daemon was already parsing those blocks, but only inside a quota lookback
  window and only to derive a percentage denominator, so there was no token count and no dollar
  figure anywhere in the product. The session header now carries both, computed on demand by
  streaming that one file: no new table, no new column, nothing written to disk. Cache reads and
  cache writes are priced separately, and cache writes are further split by TTL, because a one-hour
  write costs twenty times a read; collapsing them into one "input" rate produces a number that
  looks precise and means nothing. Prices ship bundled and dated (no network call, ever), and a
  model with no published price is reported as unpriced rather than guessed at: its tokens still
  count, and the cost is marked as a floor. Also on `GET /api/sessions/:id/usage`. Claude sessions
  only, because Codex and OpenCode record their spend in their own shapes and a second parser is how
  two numbers start disagreeing.

- **Transcripts read as markdown, with highlighted code, and no new dependency.** Replies rendered
  as one undifferentiated wall of plain text: no headings, no lists, no code blocks. They now render
  properly, and fenced code is syntax-highlighted. A census of 150 real transcripts decided the
  scope: of 682 code fences, 57% carry no language tag at all and five families (JS/TS, Python,
  JSON, shell, plus untagged) cover 99%, so a grammar library would have been most of a megabyte
  serving a 1% tail. The renderer and the highlighter are about 300 lines between them and add
  nothing to `package.json`.

  Transcript text is untrusted, so the safety property is stated plainly and tested: the source is
  HTML-escaped ONCE, before any markdown is interpreted, which means every tag in the output was
  written by the renderer and none can come from the transcript. There is no sanitiser to configure
  and no gap between what a parser accepts and what a sanitiser strips. A model that writes a script
  tag gets a visible script tag. Links are limited to http, https, mailto and in-page targets, so a
  `javascript:` URL renders as plain text.

- **You can see which overnight runs died, without opening any of them.** The daemon has always had
  ground truth on this: the detached runner reports the child's exit code and the run's status is
  finalized from it, so nothing is inferred from a transcript. It was only ever shown as an exit
  number on a card. The finished list now filters to "only the ones that didn't finish", covering
  everything terminal that isn't a completion (failed, canceled, rate-limited, overloaded), because
  from "did the work happen?" those are the same answer. The run viewer shows how its run ended
  instead of just stopping. And `get_run_events` now returns the outcome alongside the events, so an
  agent reading a log that simply stops can tell a short answer from a crash or a kill.

- **Content search is instant, from a 13 MB index that stores none of your text.** A full-text
  index was previously declined because it drops a large file on the user's machine. Measuring the
  store first showed why that was only half right: of 389 MB of searchable text, 88% is tool output
  (file reads, greps, build logs) and only 46 MB is conversation. So this indexes what was said and
  skips what was pasted, and holds it contentlessly, meaning the index alone with no second copy of
  the text. Measured on a real 4.4 GB store: **13.2 MB for 1,359 sessions**, roughly a quarter of a
  percent of what it covers, versus around 200 MB to index everything. Searches drop from seven
  seconds covering a fifth of the store to well under a second covering all of it.

  It is an accelerator, never a dependency. Missing, half-built or deleted, the streaming scan
  answers exactly as before; the index only takes over once it covers 98% of the store, and it
  builds in the background rather than inside anyone's request. Its two real limits are stated on
  every answer rather than hidden: it matches whole words and phrases rather than substrings, and
  it does not cover tool output. Both the web UI and the `search_sessions` tool say which path
  answered and offer the exhaustive scan; a regex search always takes the scan. `GET` and `DELETE
  /api/search-index` report its size and remove it, and it rebuilds itself from the transcripts. Settings
  shows its size and offers to delete it, because an index you cannot see or remove is a different
  promise from one you can.

- **Agents can search transcripts, and can tell a miss from a timeout.** The MCP server had 37 tools
  and not one of them searched: an agent could list, get and tail sessions, but could not find one
  by something said inside it. `search_sessions` now exposes the body search that the web UI has
  always had. It also had to stop lying by omission. The search runs under a seven-second budget
  and returned a bare list, so "this text is nowhere on your machine" and "we gave up early" were
  the same answer. Every caller now gets `budgetExhausted`, `limitReached` and the file counts
  behind them, and the UI says so above the results. This is not theoretical: on a real store of
  1,357 transcripts a search reached 126 of them before the budget expired, so the old answer was
  a 9% sample presented as a complete one.

### Fixed

- **Content search was returning "session not found" for everyone.** `GET /api/sessions/search` was
  registered after `GET /api/sessions/:id`, and the parameterised route wins, so every advanced
  search in the web UI resolved to a lookup for a session literally called "search" and 404ed. The
  search route now sits above it, with a comment saying why it has to stay there.

- **The README screenshot run works again.** Its fixture table had no entry for `/api/ui-prefs` or
  `/api/notifications/events`, so those requests escaped to whatever daemon happened to be running
  and the capture refused to keep the images. That refusal is correct: a fixture gap is how real
  session data reaches a public screenshot. Both are stubbed now.

## [0.19.3] - 2026-08-11

### Fixed

- **Tooltips are reachable on a phone.** Reka UI ignores touch pointers on hover, so on a touch-only
  device every tooltip here was dead, including the toolbar labels `IconTooltip` puts on icon-only
  controls and, worst of all, the info icons: a setting's description lives behind that icon and
  nowhere else, so on mobile the text simply did not exist. Info icons now disclose on a single tap
  and close on a tap outside, a second tap, or a scroll. Every other tooltip opens on a
  press-and-hold, so a plain tap still runs the control's action exactly as before, and the click
  ending a hold is swallowed so nothing fires behind the tooltip. Sliding a finger abandons the
  hold, leaving scrolling alone. Mouse and pen behaviour is untouched: the gestures key off the
  event's own pointer type, not a device media query, so a touchscreen laptop keeps hover and merely
  gains them. From the shared UI kit; reported against RepoYeti as
  [#16](https://github.com/LunarWerxs/RepoYeti/issues/16).

## [0.19.2] - 2026-08-10

### Changed

- **The periodic update check now doubles as an anonymous install ping.** The compiled distribution
  already hit `api.github.com/repos/LunarWerxs/AgentHydra/releases/latest` on a timer to look for a
  newer release. That call now goes to Studio's app-ping proxy instead, which relays the same GitHub
  JSON back verbatim (so every reader of the response is unchanged) and logs one row per hit: a
  random per-install id, the app version, and a coarse OS tag. Update-checking itself adds zero
  extra network traffic to get fleet-wide install/version telemetry out of it, the same wiring
  QuickDictate and AnatomyOf already run in prod. From that request the server also derives and
  stores a coarse location (country, region, city, timezone), the network's ASN, locale, and a
  truncated user agent, never an IP address, hostname, username, file path, account, or email.
  `AGENTHYDRA_NO_PING=1` (also the default for dev/test/CI runs) opts out; the update check then
  falls back to asking GitHub directly, carrying no install id and no telemetry params, so
  update-checking never depends on the ping being allowed. README's old "no telemetry" claim is
  replaced with this disclosure.

## [0.19.1] - 2026-08-10

### Fixed

- **The system-tray icon is back in the Windows download.** Packaged builds have shipped without it
  since 0.12.0: the 0.11.2 release prep trimmed "sidecars" from the bundle and took the `misc\` tray
  toolkit with them. The daemon contains no tray code at all, so with those files gone there was
  nothing left to draw an icon, and no combination of settings could bring one back. The ZIP carries
  the toolkit again, the release smoke test now fails if it ever goes missing, and both READMEs say
  plainly that the icon comes from the shortcut rather than from `AgentHydra.exe`.
- **The tray icon survives an Explorer restart.** When the Windows shell restarts it destroys every
  tray icon and expects each app to add its own back. The native launcher never listened for that
  broadcast, so the icon disappeared for the rest of the session while AgentHydra kept running
  normally, and relaunching the shortcut only re-opened the UI. It listens now, and re-adds the icon.
- **A tray icon that fails to appear at startup now retries instead of giving up.** The launcher
  assumed its first attempt had worked. If it had not (most often because the taskbar did not exist
  yet, on a launcher started at logon), the five-second health tick believed the icon was already
  showing and never tried again. It records the real result and retries.
- **A packaged build no longer tries to run `bun install` on itself.** The launcher's first-run
  bootstrap is meant for a source checkout; in a release bundle none of the files it looks for exist,
  so every step fired, on the one layout guaranteed to have no Bun.

## [0.19.0] - 2026-08-10

### Changed

- **Every remembered layout choice now survives a port change, not just the usage filter.** The tab
  you were on, the three Instances tables' collapse states, the sessions period / provider /
  archived filters, transcript verbosity, body-search case sensitivity and the sidebar width all
  lived in browser storage only, so they reset on any launch where the daemon had to hop to another
  port. They go through the same daemon-side store as the usage filter now. Values still paint from
  the browser cache first, and a key the store has never seen is seeded from whatever this browser
  already had, so nothing anyone has already set is lost on the way in.
  - The mirror carries short strings as well as switches and numbers, and a string preference
    declares its own value set. The store is a plain file, and an unrecognised value reaching a tab
    strip or a filter dropdown would render a control with nothing selected.
  - These preferences moved out of the components that read them and into one module
    (`composables/useUiPrefs.ts`). A mirrored ref has to outlive its component: registration is
    keyed, so only the first mount's ref is the mirrored one, and views behind a tab unmount every
    time you switch away.
  - Not included, deliberately: the theme (owned by the shared kit under its own un-namespaced key,
    which this store does not accept) and the locale (English is the only catalog that ships).

### Fixed

- **The usage filter stops forgetting whether it was on.** The cross-window store added in 0.18.0 is
  the only memory the app has on a hopped port (the daemon moves to 7788/7789/… whenever its
  preferred one is busy, and a new port is a new browser origin with an empty `localStorage`), so
  every way of losing a write to it shows up as "my filter is off again". Three were open, and each
  one is silent by nature: nothing throws, nothing logs, the switch is just back where it started.
  - **A choice made while the first read was still in flight was dropped, then overwritten.** The
    window paints from `localStorage` (defaults, on a port it has never seen), so the filter reads as
    off; clicking it on in those first moments hit a watcher that deliberately pushes nothing before
    the store has been read, and then hydrate applied the stored value on top. The click undid itself
    a beat after it was made. Such a change is now recorded the instant it happens, hydrate leaves it
    alone, and it is sent as soon as the read lands. The rule it was protecting is untouched: a
    window still never pushes before it has read the store.
  - **A read that failed once failed forever.** A window opened by a daemon that is still starting
    can ask before the socket answers, and there was no retry and no second hydrate, so that window
    ran on its local cache for the rest of its life, which on a fresh origin means defaults.
    It now retries three times over ~750 ms, which nothing waits on.
  - **A push cancelled by the closing window was silently reverted.** Toggling something and closing
    the window straight after killed the request along with the document, and since the store is
    authoritative the next launch handed the old value back. Unconfirmed changes are now queued
    rather than assumed sent: the next change carries them, and `pagehide` hands whatever is left to
    `sendBeacon`, which outlives the page.
  - A preference registered *after* the store is read (a lazily-loaded view) now receives it too.
    Nothing is loaded that late today, but hydrate runs once per window, so the failure mode was one
    import away and would have looked exactly like the bugs above.

## [0.18.1] - 2026-08-09

### Fixed

- **A detached launch no longer breaks on a path containing `&`, `|`, `^`, or a space.** Windows
  launches that must outlive the daemon (a desktop shortcut, the relaunch an auto-update performs on
  itself) go through the shared kit's detached-spawn helper. It prefers WMI, and when WMI refuses it
  fell back to handing an already-quoted command line to `cmd.exe /c start ""`. That put a *second*
  parser in the path, and cmd re-parses `&`, `|` and `^`, all of which are perfectly legal in an
  NTFS path. A repo or profile directory containing one was re-split on its way to `CreateProcess`,
  so the fallback that exists to keep a launch working was the thing that broke it. The fallback is
  now `Start-Process -FilePath … -ArgumentList @(…)`, which never involves cmd.
  - **Each argument is pre-quoted, because `Start-Process` does not do it for you.** Windows
    PowerShell space-*joins* `-ArgumentList` without quoting elements that contain spaces, so a
    plain `C:\Program Files\…` element reached the child as three separate arguments, corrupting
    the successor daemon's own arguments, which is precisely the failure this fallback is for.
  - Nothing here changes the WMI path, which is what almost every launch actually takes; this only
    repairs the branch taken when WMI is unavailable or blocked.

### Internal

- **The console-window guardrail no longer reads prose as code.** `scripts/checks/spawn-console-window.mjs`
  is a text scan, and it had no notion of comments, so a *sentence* naming a spawn counted as one.
  The fix above ships a header explaining which shell `spawn("powershell")` resolves to, and that
  alone turned CI red against a file containing no spawn call at all. Comments are now blanked
  before the scan, index-for-index so reported line numbers still line up. Regex literals are
  tracked too, and that half is not optional: a `"` inside a character class (`!/[ \t\n\v"]/`, in
  the very file being scanned) opened a string that never closed, which inverts code and string for
  the rest of the file and produces false positives rather than misses.

## [0.18.0] - 2026-08-07

### Added

- **Quick Instances gets the quota columns and the usage filter, and remembers how you left them in
  the full manager.** The compact window showed a single weekly badge and no way to act on it. It
  now carries both readings (5h and week) behind the same usage-mode toggle the Instances tab uses,
  and the same "set aside the accounts I've used up" filter, with dim/hide and per-window
  thresholds. It is the same state, not a copy: both surfaces read one shared singleton, and the
  filter rule itself has only ever had one implementation.
  - **The state is mirrored through the daemon**, which is what makes "remembers" true. Quick
    Instances normally opens on the running daemon's port, but with no daemon it starts its own
    server on a *different* port, and a browser scopes `localStorage` per origin, port included. So
    the window that ran standalone landed on a blank slate every time. A small store
    (`~/.agenthydra/ui-prefs.json`, served by both daemons) now holds the handful of keys; the
    server wins on load and `localStorage` stays as the instant-paint cache. A first run seeds the
    store from whatever the browser already had, so existing settings carry over rather than
    trickling in as controls are touched.
- **The app checks for updates on its own, and says so where you can see it.** Auto-*apply* is off
  by default because it restarts the daemon, but that flag also gated the *check*, and the only
  other code that ever asked was the Settings screen's own mount. Run an older build and never open
  Settings, and nothing ever told you. Checking and applying are now separate: the loop always
  checks, applying stays opt-in and unchanged, and a newer version puts a dot on the Settings
  button. A manual check feeds the same signal, so the hint is never staler than what you have
  already been shown.
- **The update tells you what it is doing.** Clicking the version to update bound a spinner to one
  request that legitimately covers minutes on a source checkout (a pull, then a dependency reinstall,
  then a web build), and reported nothing until it finished, so a healthy slow update and a hung one
  looked identical. The compiled path now streams its download and reports real progress
  (`Downloading v0.17.0… 62% (22/36 MB)`), then extraction, verification and install; the source
  path reports its phase and says why it takes a few minutes. The apply request is also bounded at
  20 minutes, so the spinner always ends: a daemon that restarts itself mid-apply (which a compiled
  apply does on purpose) used to leave it turning until the user reloaded the page.

### Fixed

- **Clicking update on a downloaded release no longer spins forever after the update has already
  succeeded.** This was the actual cause, and it is not slowness: a compiled apply is only a few
  seconds of work (measured on the real v0.17.0 asset: 2.3 s to download, 0.5 s to extract). But the
  daemon deliberately restarts itself afterwards, and it began that restart 250 ms after writing the
  response, exiting about a second later. A browser that had not finished reading by then lost the
  socket, the request failed, and the spinner turned on an update that had in fact completed. The
  restart now waits three seconds, and the page independently recovers by polling the daemon's
  health and reporting the version that comes back, so the outcome is reported either way.

- **Toasts have a close button.** `<Toaster>` was mounted without `close-button`, and vue-sonner
  defaults it off, so no toast in the app could be dismissed except by waiting. It showed worst on
  the plain ones ("Auto-updates enabled"), which carry no action button either and so had no
  controls at all. The kit's wrapper already shipped the glyph and pinned it top-right; it was
  simply never switched on.
- **Opening the app no longer resolves every instance over the network.** The sessions list, the
  queue drawer and the composer all pull the shared instance singleton just to put a name on a chip,
  and each one triggered a full identity resolve of every instance. Measured on a 15-instance
  install: 15 profile calls, 4-wide, ~1.4 seconds of continuous requests, to label chips the on-disk
  cache answers in about 25 ms. Those callers now read the cache; only the Instances tab, the
  screen that is *about* accounts, resolves for real, and a login that provably changed is still
  corrected immediately. Now 1 network resolve, done in under 0.6 s.
- **The Instances tab no longer probes every account's quota at once on open.** It fired one forced
  probe per instance from a single unbounded `Promise.all` the moment the lists arrived. Measured
  at 14 simultaneous requests, the slowest taking 8.8 seconds, on every open. The server already
  keeps a usage cache that survives restarts and re-sweeps on its own timer, so the table has
  numbers immediately; only readings that have aged out are re-checked now, two at a time with a
  stagger. Now 2 probes instead of 14.
- **A crashed daemon no longer costs half a second on the next boot.** The single-instance guard
  re-probes three times before concluding nothing is running, which is right when a daemon might be
  alive but busy, and pointless when `runtime.json` names a process that no longer exists. The
  tombstone case is now detected directly. Boot after a hard kill: ~1,420 ms → ~920 ms.
- The full manager's toast stylesheet loaded on its own round trip after the app and i18n chunks,
  rather than alongside them.

## [0.17.0] - 2026-08-07

### Added

- **Every instance now has a permanent number, and you can talk to the MCP server in numbers.**
  Until now nothing an instance carried was usable as a spoken or written handle: a Claude Desktop
  instance is identified by its folder path, a Claude CLI or Codex instance by a random uuid. Worse,
  the folder name is not even reliable: sign a profile into a different account than the one it was
  named after and it keeps showing the old name (this machine has exactly that, the folder
  `3claude` is signed into the account labelled `4claude`, and vice versa). So "check instance 7's
  usage" was a sentence with nothing behind it. Now `#7` is a real identifier.
  - **One sequence across all three families** (Desktop, CLI, Codex), so a bare `7` never needs a
    kind beside it. Assigned on first sight and **never reused**: a number retired by a deleted
    instance stays retired, because the whole value of the handle is that a note saying "instance 7"
    still means the same account next month. A cold start numbers the fleet in sorted-ref order, so
    the same set of instances numbers identically on any machine.
  - **Visible where you read it**: a `#N` chip on every row of all three instance tables, and a
    header on every row's ⋯ menu naming which instance the menu belongs to. Both copy on click.
  - **Accepted where you act**: every MCP tool that addresses an instance takes `instance`, which
    accepts the number (`7`, `#7`), the dir/id, a `desktop:<dir>`/`cli:<id>` ref, or an unambiguous
    name. The legacy `dir` / `id` parameters are unchanged, so nothing that already worked broke.
  - **Three new MCP tools**: `list_instance_numbers` (the whole fleet, one flat numbered list with
    each account's email and plan), `resolve_instance` (confirm which account a reference means
    before spending its quota; its errors distinguish an unknown number from a retired one),
    and `whoami` (which numbered instance THIS process is, matched from its own
    `CLAUDE_CONFIG_DIR`/`CODEX_HOME`).
  - `check_my_usage` now reports `instance` alongside the numbers, so an agent can say "instance #7
    is at 84% weekly" instead of an unattributed percentage. `list_usage` rows carry `num` too.
  - `usage_budget` gained the `instance` form, which incidentally **fixes a gap**: it previously
    only accepted a desktop dir or a dispatch account, so a CLI or Codex login could not get a
    budget at all. A CLI instance's token spend is now measured against its own config dir rather
    than defaulting to the `~/.claude` login, which belongs to a different account.
  - A queue item's `instance_ref` accepts a number too; it is expanded to a real ref before the item
    is stored, so a pinned run can never fail to resolve later, at dispatch time, with nobody
    watching.
  - New REST routes: `GET /api/instance-numbers`, `/api/instance-numbers/resolve?ref=`,
    `/api/instance-numbers/whoami?configDir=`, plus `instance=` on `/api/usage` and
    `/api/usage/budget`.
- **The usage filter can now set aside an account for its 5-hour window as well, on its own
  threshold.** A spent 5-hour session means you cannot use an account *right now*; a spent weekly
  cap means you cannot use it *at all*. Those are different questions, and the filter could only ask
  one of them at a time: the old "Measure against Weekly / 5h / Either" tri-toggle shared a single
  number across both windows, so "set it aside at 80% of the week, but already at 50% of this
  session" was not expressible (owner-reported).
  - Each window is now its own switch with its own threshold, and a row is set aside when **either**
    line is crossed. **Weekly** stays on by default; **Also 5-hour usage** is opt-in, because that
    window refills the same day and filtering on it by default had rows leaving the table and coming
    back over an afternoon.
  - A stored `Weekly` / `5h` / `Either` choice carries over to the pair of switches that behaves
    identically, so nobody's filter silently re-points at a different window on upgrade. An
    unreadable or missing threshold lands on the default rather than on 0, which as a threshold
    would have meant "set aside every account that has any reading at all".
  - The toolbar button says the whole rule (`80% · 5h 65%`), so a dimmed table explains itself
    without opening the flyout.
  - **Fixed**: the "every instance is filtered" empty state told you to *lower* the threshold, which
    hides more rows, not fewer.

### Changed

- **The usage flyout is laid out as labelled sections over cards** rather than one run of
  hairline-divided rows. With two windows, each carrying a switch and a threshold, an
  undifferentiated list left no way to see which threshold belonged to which switch. Each window is
  now a card that visibly contains its own controls, its threshold reads as a value display, and a
  slider sits beside the presets for setting a figure that isn't one of the four.

## [0.16.2] - 2026-08-06

### Added

- **A Codex Desktop you didn't create through this app is now listed.** The table only ever showed
  instances created here, so someone running a perfectly normal Codex Desktop saw "No Codex
  instances found" (owner-reported). The default install is now always listed, running or not,
  because its identity lives in CODEX_HOME on disk and is readable either way; a Codex Desktop found
  running from any other unrecognized profile is listed too. Both are flagged external and offer no
  actions, mirroring `isExternal` on the Claude side, since they have no store row to act on.
  - The default install could never have matched before: its profile is the shipped app's own
    Electron path (`%APPDATA%\Codex\web\Codex` on Windows), not the `<CODEX_HOME>/desktop` layout
    this app imposes on instances it creates. A running instance is matched on the path its own
    process announces, so no platform guessing is involved when it counts.
- **Codex / ChatGPT instances now have a real identity, a plan, and a quota reading.** Until now a
  Codex row carried exactly one identity signal, `loggedIn`, which was literally "does auth.json
  exist", so every row looked alike no matter which account or plan was behind it. The table now
  has **Account**, **Usage** and **Plan** columns, matching the Claude tables.
  - Identity comes from `<CODEX_HOME>/auth.json`, which is plain JSON rather than a safeStorage
    blob, so there is no decrypt step: the email, name, plan, account id, org and subscription end
    date are read straight from the id_token's claims. That read is cheap enough to attach to every
    row on every list, so the Account column fills in on first paint with no per-row request.
  - Quota comes from the endpoint the Codex CLI's own status screen uses
    (`GET /backend-api/codex/usage`), which answers identity AND rate limits in one call. The
    windows are mapped onto the SAME `UsageSnapshot` the Claude rows use, so Codex inherits the
    whole existing quota surface: the chip, the countdowns, the usage filter, the superseded-window
    rule below. Windows are filed by their reported LENGTH, never by primary/secondary: a Plus
    account reports its single 7-day window as `primary_window`, so position would have mislabelled
    an entire plan tier as a 5-hour session.
  - The live `plan_type` wins over the token's `chatgpt_plan_type` claim, which is a mint-time
    snapshot. This is the same evidence rule the Claude-side fix below arrives at, applied from the
    start rather than after a regression.
  - An `OPENAI_API_KEY` login is labelled "API key" rather than rendered as a broken ChatGPT login:
    it is a valid Codex auth with no subscription and therefore no plan or quota to report.

### Changed

- **A 5-hour reset no longer notifies for an account you have filtered out.** The weekly cap is what
  actually blocks an account, so a session window coming back while weekly is still spent announces
  a change you cannot act on. Reset notifications now skip a 5-hour rollover when that account's
  weekly usage is at or above a threshold, defaulting to 80, the same line the Instances usage
  filter uses to set a row aside. Weekly resets are never skipped, an unknown weekly figure never
  silences anything, and the threshold is its own control in Settings › Notifications.

### Fixed

- **A free account no longer shows as "Max 20×".** Owner-reported: an account that is
  `organization_type: "claude_free"`, `billing_type: "none"`, `has_claude_max: false` was labelled
  Max 20×. The cause was the previous release's own fix, which promoted the OAuth grant to top
  evidence on the premise that Anthropic re-mints it on every token refresh. It does not. Measured
  by decrypting all eleven local token caches and diffing each against its live profile, the grant
  is a snapshot from whenever it was minted and is stale in **both** directions: the free account
  carried three unexpired grants all still claiming `subscriptionType: "max"` /
  `rateLimitTier: "default_claude_max_20x"`, while two genuinely-paid accounts carried a `max_5x`
  grant tier against an org reporting `max_20x`.
  - The plan now comes from `organization.organization_type`, which the profile API recomputes on
    every call. It settles the plan family outright; the rate-limit tier only refines a `claude_max`
    family into 5× or 20×, and the grant is demoted to an offline fallback.
  - Both prior findings still hold and are still respected: a paid Pro account really does report
    the generic `default_claude_ai` tier (0.16.1), and `has_claude_max` / `has_claude_pro` really do
    stay true after an account lapses (2026-07-22). Neither can decide the label any more, so
    neither can be wrong about it.
  - `organization_type` is cached alongside the rest of the identity, so the offline/no-network path
    reaches the same answer instead of falling back to the stale grant.
- **The account one-liner no longer leaks a raw tier string.** The Quick view showed
  `Michael <blogitech@gmail.com> · default_claude_ai` for any account whose tier is the generic
  value. It now shows the same reconciled label the Plan column does.
- **A usage reading whose window has already reset no longer poses as current.** The same instance
  sat at "100% · resets now" from an eleven-day-old cached snapshot: the countdown said *now*
  (formally true, the instant had passed) and the percentage kept asserting a window that had rolled
  over days earlier. A limit whose reset is more than a couple of minutes past is now treated as
  superseded: the chip reads as no-data, the countdown blanks rather than saying "now", and the usage
  filter counts it as unknown so a fully-reset account can never stay hidden behind a number that no
  longer applies. This is distinct from the existing 30-minute "stale" dimming, which still shows
  the last known reading because it is still a reading of the current window.

## [0.16.1] - 2026-08-06

### Fixed

- **A paid account no longer shows as "Free".** Two independent faults in the same evidence chain,
  both owner-reported and both verified against real accounts:
  - The rate-limit tier was read from the profile's ORGANIZATION (`organization.rate_limit_tier`),
    which for a personal org is routinely the generic `default_claude_ai` even on a paid plan. That
    generic value was preferred unconditionally over the OAuth grant's own tier, so a Max 20x
    account whose grant plainly said `default_claude_max_20x` had its only specific answer thrown
    away and rendered as Free. A specific tier now wins wherever it comes from, and the generic
    value is only settled for when nothing better exists.
  - A generic tier was itself treated as proof of a free account. It is not: an actively-paid Pro
    account reports `default_claude_ai` on its grant too (confirmed by decrypting the token cache:
    subscriptionType `pro`, unexpired). A generic tier now means "this signal knows nothing" and
    falls through to the grant's subscription type; it only resolves to Free when there is no
    subscription evidence behind it at all, which is the genuine free-account shape.
  - The 2026-07-22 finding that motivated the old behaviour still stands, because it was about a
    different field: the profile's `has_claude_max` / `has_claude_pro` booleans stay true for an
    account that lapsed back to free. Those are entitlement history rather than current state, and
    they can no longer overwrite a grant that says otherwise; they are consulted only when there is
    no grant to ask.

## [0.16.0] - 2026-08-06

### Added

- **Usage filter.** With the quota columns on, a funnel button appears in the Instances toolbar:
  set a percentage and the instances at or above it are dimmed, so the accounts you can still work
  on are the ones that read clearly. A **Hide instead of dim** switch drops them from the table
  outright; both tables then say "4 of 11 · 7 hidden" in their heading, because an instance that
  silently stopped being listed reads as a bug rather than as the filter working.
  - **Measure against** picks the window the threshold applies to. It defaults to *Weekly*, the
    Usage column: that is the cap that decides whether an account is worth starting on. *5h* reads
    the shorter session window and *Either* takes whichever of the two is closest to its cap, both
    of which are opt-in, since a 5-hour reading comes back the same day and would otherwise have
    rows dropping out and back in over an afternoon.
  - An instance that has never been checked is never filtered. An unknown reading is not a full one,
    and treating it as one would quietly remove a perfectly usable account from the table.
  - The filter lives and dies with usage mode: switching back to the process columns restores a
    plain table, so a dimmed row always has the control that explains it visible in the same toolbar.
- **Expanding and collapsing a section animates.** The two instance tables, the Codex table and the
  queue card's run viewer used to appear and vanish between frames, with a rotating chevron as the
  only sign anything had happened. They now open and close over 0.22s, matching the speed the kit's
  collapsibles already used elsewhere in the app, and honour `prefers-reduced-motion`.
  - This needed a component of its own rather than the kit's `ExpandTransition`, which keeps
    `overflow: hidden` on its wrapper permanently. An element with a non-visible overflow becomes
    the scrollport that `position: sticky` resolves against, so wrapping a table in it silently
    stops the header sticking, which is exactly why these tables had no animation to begin with.
    The local one clips only while the transition is actually running, i.e. the one moment nothing
    is being scrolled. Popovers and focus rings inside an expanded block stop being cut off at its
    edge as a side effect.

### Fixed

- **Reset toasts no longer deal themselves into the wrong slots, or jitter under the pointer.**
  vue-sonner (2.0.9, the current release) positions its stack from a heights array it keeps beside
  the rendered toasts, and each toast measures itself in an effect that awaits a tick. Raise two in
  the same tick and those measurements come back in the reverse of the raise order while the array
  blindly prepends each one, so every card's offset is attributed to a different card. Measured
  here with three at once: the front toast got the middle card's offset and the middle one got zero.
  With a backlog of ten it threw the front toast ~817px up, past the top of the window and out from
  under the pointer, which collapses the stack, puts the toast back under the pointer and re-expands
  it: the up-down-up-down jitter, at hover speed. Toasts are now raised one macrotask apart, which
  is enough for each measurement to land before the next card mounts.
- **A backlog of resets is one toast, not ten.** Above three at once (the window was closed while
  several accounts rolled over) they collapse into a single "N quota windows reset" card whose
  action acknowledges the batch. Ten 20-second cards timed out before they could be read, and the
  stack's expanded height is the sum of all of them, so a hover unfurled something taller than the
  window. Every event is still in the list the header badge counts.
- **The Instances tab stopped starting a PowerShell process every few seconds.** Listing instances
  needs each Claude process's command line, which on Windows means
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process ..."`: measured here at ~490ms, of
  which ~130ms is the shell starting and ~260ms is the WMI query. That ran per request, and the tab
  polls every 4 seconds, with the Codex table running a near-identical second query on its own 5s
  timer. So for as long as the app was open it was starting shells, forever, and every one of those
  half-seconds sat on the request path, first paint included. `GET /api/instances` went from ~490ms
  to ~5ms on the same machine and the same data.
  - The scan is now one shared snapshot. Concurrent callers join a single in-flight query instead of
    each starting a shell; a result under 3s old is reused outright; an older one is returned
    immediately while a refresh runs behind it, so the tick that pays for the scan is never the tick
    that waits for it. Nothing here holds a timer, so closing the UI stops the scanning dead.
  - Everything that ACTS on the answer still enumerates for real: launching, quitting, focusing, and
    the guard that refuses to delete a running instance. Launching and quitting also drop the
    snapshot, so the row you just clicked updates on the next poll rather than when a TTL expires.
- **The account column fills at page load instead of a second and a half later.** Every instance's
  identity was resolved over the network, one strictly after another, and on a fresh load nothing is
  resolved yet, so eleven accounts meant eleven serial round trips. The locally cached identity is
  now painted first (25ms for all eleven, against ~1.5s for the same eleven over the network) and
  the live resolve follows behind it, a few at a time, correcting anything that has changed.

### Changed

- **The Instances tab opens on the quota columns.** "How much have I got left" is the question the
  table gets opened for; PID, uptime and memory answer "is the process healthy", which is the rarer
  follow-up. The toolbar toggle still swaps back in one click. This is a genuine default change
  rather than a flipped flag: `useStorage` writes its default on first read, so every install that
  had ever rendered the tab already carried an explicit `false` on disk and changing the default
  alone would have reached nobody. The mode moved to a new key, leaving the old one as a dead
  entry, on the same reasoning as the usage filter's `scope2`.
- **Inter is served by the app, not fetched from Google.** The shared kit's base stylesheet opens
  with an `@import` of `fonts.googleapis.com`, and a remote `@import` at the head of a
  render-blocking stylesheet blocks first paint on a round trip to the internet. Free on a warm HTTP
  cache, which is why it went unnoticed, but dead time on a first run or after a cache eviction and
  an outright stall with no network, on a local desktop app that otherwise never needs to be online.
  The two Latin subsets of Inter's variable woff2 now ship under `web/public/fonts/`. Same typeface,
  no flash of fallback text, and the app renders offline.
  - The kit copy is left byte-identical (its sync tool compares and rewrites synced files as text,
    so it cannot carry font binaries without being reworked first); the remote import is stripped
    from this app's CSS at build time instead. Any sibling app can adopt the same two files and
    stylesheet block, and if they all do, that is the point to teach the kit about binaries.

- **Settings that belong to a screen now live on that screen.** Usage auto-refresh (and its
  interval) moved into the new usage flyout, and the provider switches that decide which instance
  tables are drawn moved into a **Sections** flyout beside them. Both are still in Settings; these
  are the same components rendered twice over the same state, not copies, so flipping either surface
  moves the other. A setting nobody can find is a setting nobody knows exists.

## [0.15.0] - 2026-08-05

### Added

- **Reset notifications.** The app already kept every instance's quota percentage warm; it now
  tells you the moment a window rolls over. The detection does not poll for a percentage that
  dropped: the usage endpoint reports the reset instant *in advance*, so a rollover is a wall-clock
  comparison against a timestamp already on record, and a timer is armed for that exact instant
  rather than waiting on the next 15-minute sweep. Percentages are integers and can sit still for
  an hour, which is why a delta-based detector would be both late and ambiguous here.
  - Native OS notifications (a Windows toast under AgentHydra's own registered app identity, so it
    appears in Windows' Notifications settings like any other app; `osascript` on macOS,
    `notify-send` on Linux). These fire from the daemon, so they reach you with the app in the tray.
  - **Keep reminding me** re-raises an unacknowledged reset on an interval and makes the toast
    sticky instead of letting it fade after a few seconds. Bounded by a repeat cap and a hard
    expiry, so a forgotten toggle cannot outlive its usefulness.
  - Optional **email**, through your own SMTP server (implicit TLS or STARTTLS, AUTH LOGIN/PLAIN).
    The password is DPAPI-sealed at rest and is never returned by the settings API.
  - Pending resets survive a restart. The one notification most worth having is the one that fires
    at 3am, which is exactly when an auto-update restart is most likely to have cycled the process.
  - Settings → Notifications, with a **Send a test notification** button so the plumbing can be
    proven now rather than five hours from now.

- **Usage mode** in the Instances tab. One toolbar toggle swaps the process columns (PID, uptime,
  memory) for the quota ones across every table on the tab. Each window renders as a bar of the
  WAIT: its length is how much of the window is still to run, its colour bands that same fraction
  (green, amber, red), and the time remaining is written inside it. Length and colour are one number
  rendered twice, so a short green bar reads as "nearly back" without being decoded. The bands are
  proportional rather than absolute: on the weekly window they land where the intuitive day
  boundaries are (under a day green, one to two days amber, beyond that red), and the 5-hour session
  window gets the same scale instead of reading green throughout and carrying no signal. The burn
  percentage keeps its own column and rides under each bar as a caption. The per-model weekly
  sub-limit is not given a column of its own (it shares the weekly reset instant, so its bar would
  be a copy of the weekly one); it is still in the usage badge's breakdown.

### Changed

- The usage badge now opens its breakdown on **hover** as well as on click, and the breakdown
  carries live "resets in" countdowns alongside the raw reset times. Hovering never steals focus.
- Usage chips in the instances tables read `92%` rather than `92% wk`: the column heading already
  names the window, so the suffix was repeating it once per row. The quick-instances window keeps
  its suffix, having no headings to carry it.
- An instance's folder moved out of a permanent second line under its name and into the row's
  tooltip, halving the height of every row. The tooltip is now on every row rather than only
  running ones, since the folder is what it is mostly for.
- The Instances/Sessions tab you were last on is remembered across reloads.

### Fixed

- **A CLI instance carried across the CC Manager UI rename lost its login.** Each record stored its
  `CLAUDE_CONFIG_DIR` as an absolute path written once at creation. The rename moved the folder but
  nothing rewrote that string, so the record pointed at a directory that no longer existed: it read
  as permanently signed out, and a re-login would have written fresh credentials back under the dead
  `~/.ccmanagerui` folder. The path is now re-derived on read, persisted once at startup, and any
  credentials still sitting at the old location are carried across.
- The CLI instances heading showed a bare `(0)` when every CLI instance was linked to a desktop
  instance and therefore rendered on that account's row instead. It now reads `(0 of 1)`, so the
  shortfall explains itself even while the section is collapsed.

## [0.14.0] - 2026-08-04

### Changed

- **CC Manager UI is now AgentHydra.** The old name described a Claude Code manager, and the app
  has read Codex and OpenCode sessions for several releases. The upgrade is designed to be
  uneventful:
  - `~/.ccmanagerui` is moved to `~/.agenthydra` the first time the new build starts, carrying the
    run queue, settings, instance labels and the accounts cache. The move only runs when the new
    directory does not exist yet, and any failure (a pre-rename daemon still holding the pointer
    file, a permission problem) falls back to reading the old directory where it stands rather than
    starting from empty state.
  - `server/data/ccmanagerui.db` is renamed to `agenthydra.db` in place, with its `-wal`/`-shm`
    sidecars, and falls back to the old filename if the file is locked.
  - Every `CCMANAGERUI_*` environment variable is still accepted as a fallback for its
    `AGENTHYDRA_*` replacement. This is load-bearing for exactly one upgrade: the last CC Manager UI
    release spawns its successor with `CCMANAGERUI_RELAUNCH=1`, and without the fallback that
    auto-update would land in the zero-daemons race the relaunch flag exists to prevent.
  - Saved UI preferences (`ccmanagerui.*` in localStorage) are copied to the `agenthydra.*`
    namespace before the app mounts, so sidebar width, provider scope, collapse state and locale
    all survive.
  - The Windows executable, tray script and icon are renamed to `AgentHydra.*`. Release archives
    keep their existing wrapper-directory layout so the updater in older builds still recognises
    them. Desktop shortcuts pointing at the old exe need re-creating once.
- **New logo.** A three-headed hydra replaces the figure mark, on a tile split between the existing
  orange and a new sage green. The app's accent colour and the rest of the theme are unchanged.

### Fixed

- Deleting a dispatch account no longer leaves CLI instances pointing at it. The association is a
  copy of the account's id and label kept in the CLI instances file rather than a database link, so
  removing the account left both behind: the instance kept showing a badge naming an account that
  was gone, and its usage check quietly failed because the id no longer resolved to anything. The
  account is now detached from every CLI instance that used it when it is deleted, and any instance
  already pointing at a missing account is shown as unassociated the next time the list loads.
- Deleting a dispatch account now also clears the rest of what was kept under its name: its last
  usage reading, its stored usage history, and its per-account auto-resume setting. Only the queue's
  reference to an account was ever cleaned up automatically, so the others accumulated with every
  account removed and could be re-applied to a new account that happened to reuse the same id.
- An instance signed into a different account kept showing the previous account's email, name and
  plan. Resolved identities were cached per instance folder and treated as final: nothing compared
  them against the account the profile was actually signed into, and nothing re-checked them once
  resolved, so the old identity survived every offline read and every poll until someone pressed
  Refresh. Identity is now checked against the instance's current login, a cached identity that
  belongs to another account is discarded rather than displayed, and a sign-in change is picked up
  on its own within seconds. A resolved identity is also re-checked periodically, so an email, name
  or plan changed at claude.ai catches up without a restart.
- An open Codex or OpenCode session showed no reply box and no reason for it. Only the `claude` CLI
  can be handed a prompt, so the composer is deliberately dropped for the other two sources, but
  nothing stood in its place and the gap read as a failed render rather than a boundary. Those
  sessions now say they are read-only here and name the tool to carry the conversation on in.

## [0.13.0] - 2026-07-30

### Added

- **Quick instance mode** opens a compact Claude/Codex instance launcher without starting the
  session scanner, database, queue, scheduler, monitor, usage refresh, settings sync, or updater.
  Launch it with `CCManagerUI.exe --instances`, `bun run instances`, the generated
  **CCManagerUI Instances** shortcut, or the shortcut action in Settings.

### Fixed

- The Sessions list no longer stalls the app on first load. Every transcript it showed was being
  read and parsed from scratch on each daemon start, all of them at once. On a store of ~1,100
  transcripts that meant a 4.6-second wait for the first list and a jump from 101 MB to 3.1 GB of
  memory. Parsed transcript metadata is now cached on disk, so a restart is warm; the list reads at
  most a dozen transcripts at a time instead of two hundred; and the daemon warms the newest ones in
  the background at startup. Same store, same list: 0.35 seconds and a bounded footprint.
- Sessions list latency no longer grows with the size of your transcript folder. Building the file
  index globs the whole store and stats every file, and that ran inside requests, so each refresh
  paid a folder-sized tax (145 ms for 1,255 transcripts, and rising). The index is now served from
  the last snapshot and re-swept in the background, which takes routine refreshes from ~150 ms to
  ~3 ms. Looking up a session that is genuinely missing still re-sweeps, at most once every two
  seconds, so a newly created transcript is still found straight away.

## [0.12.2] - 2026-07-28

### Changed

- Resuming a Claude Desktop chat now automatically uses the desktop instance that owns that chat,
  rather than an unrelated ambient CLI login. The composer makes that default visible and lets you
  deliberately choose the ambient login, another signed-in desktop or CLI instance, or a saved
  credential account.
- Archived conversations are shown by default, session source badges are easier to distinguish,
  and the composer makes scheduling the primary Queue action while keeping immediate queueing one
  click away.

### Fixed

- Weekly Claude quota walls are now recognized from the CLI's structured rate-limit event and
  human notice, so affected runs are parked as rate-limited and can be resumed after reset instead
  of being reported as ordinary failures.
- Composer and queue-builder option menus no longer render empty model, effort, or permission
  entries.

## [0.12.1] - 2026-07-26

### Added

- **Codex Desktop instances can now run side by side.** Each managed Codex instance launches the
  desktop app with its own `CODEX_HOME` and `CODEX_ELECTRON_USER_DATA_PATH`, so work, personal, and
  client OpenAI logins have independent windows and local state. The Instances view reports which
  desktops are running and can open, focus, or quit each one; CLI launch/login remains available on
  the same row.
- **Provider settings and manual ChatGPT handoff.** Claude Desktop, Claude CLI, Codex Desktop, and
  Codex CLI surfaces can be shown independently. An opt-in composer action creates a bounded,
  secret-screened repository context attachment, copies the task prompt, and opens ChatGPT without
  automating the user's account or submission.

### Changed

- Version tags now publish their tested platform bundles automatically using the matching
  versioned changelog section. Release retries update the existing release in place instead of
  deleting it or leaving another unpublished draft.
- Windows releases now expose an icon-bearing, single-file GUI executable while retaining a
  compact ZIP for automatic updates. The web UI is embedded, so no loose `web` or `node_modules`
  folders are needed beside the executable.
- Connections settings sync now uses the multi-device-safe 1.2 engine, with atomic first-account
  seeding, conflict-safe nested patches, token-isolated caching, and a five-second final flush that
  cancels a stuck token or network request instead of delaying shutdown indefinitely.

### Fixed

- Codex sessions now match the chats shown by Codex Desktop: canonical sidebar titles come from
  `session_index.jsonl`, while subagent rollout files no longer appear as separate sessions with
  duplicated titles and forked chat history. Child-agent rollouts remain implementation details of
  their parent chat.
- Release builds now honor both spaced and `--option=value` arguments, so every platform compiler
  writes into the versioned one-executable bundle that the smoke and publication jobs validate.

## [0.11.1] - 2026-07-23

### Changed

- Completed session-sharing research and the obsolete CLI/monitor handoff were consolidated into
  the live reference and source safety comments; their standalone Markdown notes were removed.

### Fixed

- The Windows shortcut integration test now allows cold PowerShell/COM startup the same bounded
  time as the equivalent launcher test, preventing a correct run from failing at the five-second
  default by a few milliseconds.

## [0.11.0] - 2026-07-23

### Added

- **Claude, Codex, and OpenCode conversations now share one Sessions view.** Every row is
  source-tagged and the list, full-body search, transcript tail, done marks, REST API, and MCP
  session tools all understand provider identity. Codex reads active and archived rollout JSONL;
  OpenCode CLI and Desktop are both covered through the SQLite store they share. Injected Codex
  runtime blocks and provider reasoning records stay out of the human transcript.
- **Codex CLI instances can be managed alongside Claude instances.** Create an isolated
  `CODEX_HOME`, open `codex login` for the user, launch it in a terminal, rename it, or delete it
  with exact-name confirmation. The REST API and MCP expose the same lifecycle.

### Changed

- **Provider browsing cannot leak into Claude execution.** Queue/session composers, rate-limit
  discovery, and Desktop-instance filtering remain explicitly Claude-only, while Codex and
  OpenCode are read-only conversation sources. OpenCode's database is never offered as a raw
  transcript download.
- **OpenCode full-body search now filters and extracts text inside SQLite.** Large tool payloads
  are no longer loaded and parsed in JavaScript; against the 260 MB local store this reduced the
  measured search allocation from roughly 49 MiB to 5 MiB.
- **Development now uses Bun's native parallel workspace runner.** Removing `concurrently`
  eliminates a redundant dependency and its shell-command dependency chain. Biome, Hono, Vue,
  Tailwind, Lucide, and other compatible dependencies move to their current non-breaking releases.
- **Manually added dispatch credentials remain portable SQLite values.** The app briefly sealed
  this one column with Windows DPAPI during the pre-release hardening pass, but that added
  machine/user coupling without changing the local database threat model enough to justify it.
  A compatibility migration converts any such rows back when the same Windows user can decrypt
  them; the per-user state directory and database still receive restrictive filesystem modes.
- The completed Codex/ChatGPT/OpenCode research note and the original merge plan were removed after
  their work was implemented and verified.

### Fixed

- Session metadata caching now replaces an active transcript's previous parse instead of retaining
  one cache entry for every appended turn.
- Scheduler and monitor numeric settings are finite and bounded, and changing the scheduler poll
  interval now updates the live timer immediately rather than waiting for a restart.
- Filesystem containment uses resolved path components instead of string prefixes, preventing a
  sibling such as `instances-elsewhere` from being treated as a child of `instances`.
- Queue writes reject malformed statuses, booleans, positions, account references, and launch
  options before they can create invalid persisted state or reach a terminal command.
- A selected dispatch account that cannot be read now fails the run instead of silently falling
  back to the ambient login.
- Child-process tests use the exact Bun executable running the suite, avoiding Windows `bun.cmd`
  quote loss in updater fixtures.

### Security

- The passwordless daemon now refuses every non-loopback bind host, and OAuth callback origins are
  restricted to the same loopback set. API bodies are capped at 2 MiB.
- User-supplied session-search regular expressions are length-bounded and structurally checked
  before execution, preventing synchronous catastrophic backtracking from bypassing the search
  deadline.
- Terminal launch model and effort values are allowlisted before crossing the shell boundary.
- GitHub Actions defaults to read-only repository contents; only the release job receives write
  access.

## [0.10.0] - 2026-07-23

### Added

- **A session's original file location can be copied as text.** The transcript header and the
  session row's right-click menu now include **Copy the session file location to the clipboard**.
  It resolves the original file server-side, so the copied value is the exact absolute `.jsonl`
  path rather than a path reconstructed from the session id.
- **Settings can shut down the complete app.** A two-click power control beside the Settings close
  button exits the daemon and signals the tray host to quit too. Previously, stopping the daemon
  from the web UI left the tray watchdog running, so it could immediately start the daemon again.
- **Codex, ChatGPT and OpenCode support has a concrete scoping document.** The new research note
  records the session-store formats found on this machine, the Claude-specific seams in the current
  architecture, the feasibility of Codex transcript support, and the remaining OpenCode storage
  blocker so future implementation can start from verified evidence.
- **`bun run screenshots` regenerates the README images.** They used to be taken by hand against a
  throwaway daemon, which is why they sat two releases out of date showing a theme the app no longer
  had. The command starts its own web server on a private port, drives headless Chrome, and writes
  one PNG per view at a viewport sized to that view's shell. Since the images are public, it does
  not point a daemon at a synthetic home directory; it replaces `fetch` before the SPA boots so every
  `/api/` response is invented and no daemon runs at all. A request that finds no fixture is
  recorded and **fails the run**, so a fixture gap cannot quietly put live data into a committed
  image, and each shot carries a predicate that must hold before the shutter fires, so a stale
  fixture fails loudly instead of producing a screenshot of empty loading skeletons.
- **The shared tray launcher can forward dropped files and folders.** Paths dropped onto a shortcut
  are passed to adapters through an opt-in environment variable, without changing ordinary launches
  or breaking apps whose adapters do not consume drops.

### Changed

- **Settings puts the everyday controls up front.** Theme selection moves into the panel header,
  beside the new shutdown control. Tooltip visibility and the transcript-editor override move under
  an Appearance **Advanced** disclosure, leaving portable mode, tray visibility and instance-table
  visibility as the immediately visible choices.
- **The version number is now the update status and control.** It is green when current, amber when
  an update can be applied, and red when checking is blocked or no update source exists. Hovering
  explains the state; clicking checks again or applies an available update. This replaces the
  separate status rows and update buttons.
- **Generic Anthropic tiers are treated as Free.** `default_claude_ai` is the active free/default
  tier even when historical `has_claude_max` or `has_claude_pro` flags remain true after a paid plan
  expires. The Instances Plan column now trusts a specific live tier first, treats a generic tier as
  Free, and uses the historical plan flags only when no tier is available.
- **The README screenshots now match the current interface.** Sessions, Instances and Queue were
  recaptured against synthetic data on the Claude-aligned theme; their captions now include the
  Plan column and the finished-run state actually shown.

## [0.9.0] - 2026-07-21

### Changed

- **The interface follows Claude's own surfaces.** The window used to be a single near-black sheet:
  every region painted the same token and leaned on hairline borders for structure, so there was
  effectively one shade on screen. There are now three grounds, using Claude's values directly: the
  top bar and session list as the darkest chrome, the working area a step above it, and cards,
  popovers and table headers raised above that. The accent moves from magenta to Claude's dusty rose.
  The greys are deliberately neutral; an earlier revision of this work derived them and landed a
  visible brown cast on every surface instead.
- **The accent is no longer used as a background wash.** The selected session row and your own chat
  bubbles were tinted with the accent at 10–15%, which composites over a dark ground into a muddy
  maroon rather than reading as a highlight. Both are the neutral raised grey now, and the accent is
  kept for things that are actually accents (Send, Queue, checked states).
- **Text fields paint their own surface.** The kit draws them at 30% alpha, so the token never
  reached its real value: the search and composer boxes came out darker than intended and had no
  visible edge, and the composer additionally drew a filled field inside its own filled box. Text
  fields now paint the surface outright and carry a real outline, while outline buttons and badges
  keep the translucent fill that suits them.

### Fixed

- The release workflow no longer trips GitHub's Node 20 deprecation warning: `upload-artifact`,
  `download-artifact` and `setup-qemu-action` move to their current majors.

## [0.8.0] - 2026-07-21

### Added

- **The Instances table has a Plan column.** The account type (Free, Pro, Max, Max 20×, …) now has
  its own sortable column to the right of Usage, instead of being tucked on the end of the account
  cell. The value is worked out server-side from two signals, because neither is reliable alone: an
  account's rate-limit tier is sometimes a generic passthrough even for a paid plan (a real Max
  account can arrive labelled `default_claude_ai`), so the normalized plan is used as the fallback
  and a raw internal string is never shown; the column reads as a bare dash only when the plan
  genuinely can't be determined.

### Changed

- **Usage refreshes on load.** Opening the Instances view now re-checks every desktop and CLI
  instance's usage right away, instead of showing the last cached numbers until you pressed "Refresh
  all usage". Reading quota does not consume any, so this costs nothing.
- **The account cell shows a name, not an address.** It used to print the full email (and the tier);
  it now shows the account's short name, reveals the email on hover, and hands the tier to the new
  Plan column.
- **The README now shows the app.** It had no screenshots at all, so the only way to find out what
  the thing looked like was to install it. There are now three, one per view, captured from a
  throwaway daemon pointed at a synthetic home directory so no real session titles, account
  addresses or filesystem paths ship in a public image. The surrounding copy is organised around
  those views rather than around the architecture.
- Biome no longer walks `.claude/`, which holds generated local artifacts, the same exclusion
  `.arkitect/reports` already had. A stale codemap stamp file could fail `bun run lint` locally
  while CI, which checks out fresh, stayed green.
- **0.5.0 has its own section again.** Its entries had been written into 0.6.0's, so the changelog
  described two releases as one and no `[0.5.0]` heading existed. Each entry is now filed under the
  tag that actually shipped it, checked against the commit that introduced the code rather than
  against where the prose sat. Wording is unchanged; two changes that had never been recorded at all
  (the scheduler status chip becoming a link, and the vendored-library export-drift guard) are now
  listed.

## [0.7.0] - 2026-07-18

### Added

- **The session list now has a time window, set to the last 24 hours.** This list answers "what am
  I working on", and a transcript store that has been filling up for months answers that question
  worse the further back it reaches. The `...` menu gains a **Time period** filter (24 hours, 7
  days, 30 days, all time). Like the instance and archived filters, it is applied before the
  newest-N cap rather than after, so widening the window genuinely reaches further back instead of
  reshuffling the same rows. If the list comes up empty because of the window, it says so and
  offers a one-click switch to all time, rather than looking broken.
- **Finished runs can be cleared out of the queue.** The queue accumulated every completed,
  failed and cancelled run forever, and the only way to get rid of them was to delete each card by
  hand. The finished-runs disclosure now carries a Clear button, with a two-click confirm (the
  same pattern Settings uses for Disconnect) since it is a bulk delete.
- **The scheduler indicators are now the way to reach the scheduler.** The on/off indicator in the
  queue drawer was the one place you would notice the scheduler was off, and it was not clickable.
  Both it and the header chip now open Settings at the scheduler section, and the section pulses
  briefly on arrival, because a scroll that lands mid-page on a column of near-identical cards
  otherwise leaves you guessing which one you were sent to.
- **Instances and CLI instances are collapsible.** Plenty of people use only the desktop app or
  only the CLI, and had to keep scrolling past the other table. Each heading is now a toggle, and
  the choice is remembered.
- **Queueing a run for later uses the same picker as the chat composer.** "Run at" in the queue
  builder was a bare date-and-time box, so saying "in a few hours" meant working out and typing a
  full wall-clock date. It now opens the composer's picker (in 5 hours, tomorrow at your configured
  time, hour and 10-minute steppers, or an exact date), and the two surfaces share one component
  instead of two copies of the same idea. It has also moved out of Advanced options and up beside
  Account, for the same reason Account sits there: when a run happens is a decision people make up
  front, not a tuning knob.

### Changed

- **The instance editor applies as you type.** It used to show a miniature preview of the row
  inside the dialog, which is a worse answer to "what will this look like" than the real row
  sitting right behind the dialog. Name, icon and colour now persist as you change them and the
  table updates live; the preview and its explanatory paragraph are gone, and the button says Done
  rather than Save, because there is nothing left for it to save.
- **The transcript editor setting hides its input until you want it.** Auto-detect already picks
  the right editor for anyone with VS Code, Cursor, Notepad++ or Sublime installed, so the setting
  showed an empty box asking for an absolute path to solve a problem most people did not have. The
  row now states which editor will actually open a transcript; the path field, a Custom badge and a
  "back to auto-detect" action appear only if you go looking.
- **The two create buttons are icons until you hover them.** "Create instance" in both tables now
  shows a plus and expands to its label on hover or focus, matching the queue drawer's New run
  button, so one long label no longer sets the width of a toolbar of icons.
- **Settings no longer has an Accounts section.** It only ever listed leftover manually pasted
  credentials, which is nobody's normal path since accounts arrived by signing an instance in, so
  in practice it rendered as an empty box telling you to go to the Instances tab. A section whose
  content is a redirect is not a setting. Accounts are still managed on the Instances tab, and the
  per-account auto-resume overrides still list them where they mean something.

### Fixed

- **Most sessions were named after a warning notice instead of their contents.** The list showed
  the same string over and over: "&lt;local-command-caveat&gt;Caveat: The messages below were
  generated by the user while running local commands. DO NOT respond...". On this machine that was
  103 of the newest 200 sessions. A session's title falls back to its first user message, and
  nothing checked whether that message was the CLI talking to itself. Claude Code writes that
  caveat as an ordinary user turn flagged `isMeta`, and the code that knows how to drop such turns
  was already there, applied to the transcript preview but not to the title. The title now goes
  through the same filter. A session whose real prompt arrives wrapped in a tag, such as a
  scheduled task, is unwrapped to its name rather than dropped.
- **The list was full of sessions that were never conversations.** Checking your remaining quota
  sometimes has to launch the real `claude` binary to ask, and that launch opens a session and
  writes a transcript: roughly 3 KB holding a caveat, a `/usage` command line and nothing else. On
  this machine 127 of the newest 300 sessions were these. Three fixes, because one was not enough:
  transcripts with no substantive turn are no longer listed at all; the quota probe now runs in a
  directory of its own so its transcripts never land among real work; and it deletes them after
  itself. Sessions with real content are unaffected, whatever their size.
- **The auto-resume monitor listed work that was long finished.** Rows were written when a resume
  was scheduled and then never revisited, so a resume that had completed, been cancelled, or whose
  queue entry had since been deleted still reported "Scheduled, resumes ~09:14" indefinitely, and
  the Done state the interface could display was one the daemon had no way to reach. Rows are now
  reconciled against what actually happened to the resume, and the list shows only what still needs
  something to happen. A failed resume is kept and asks for attention, rather than being quietly
  filed away. Sessions you have archived are also excluded, and auto-resume no longer picks them
  up at all: archiving is you saying you are finished with it.
- **Advanced options in the queue builder was quietly broken.** Each of the Model, Effort and
  Permission dropdowns offered a "Default" entry with an empty value, which throws in the
  underlying component, and the failure took out everything rendered after it in that section. It
  went unnoticed because the visible casualties were the very dropdowns causing it, so the section
  looked sparse rather than broken. The account picker beside them had hit this same trap earlier
  and been fixed; the other three had been missed.
- **Settings had one seam with no gap, and one list with no separators.** The auto-resume monitor
  sat flush against the scheduler card above it, because a wrapper element added to support a deep
  link broke the page's spacing chain. The per-account rows inside the monitor lost their dividing
  lines for a closely related reason. Both are fixed, and the rest of the app was swept for the
  same pattern.
- **A single instance could occupy several rows in the usage cache.** The cache keyed each entry
  by the instance's directory as spelled by the caller, and on Windows one folder can be spelled
  several ways, so `C:\Users\...`, `c:\users\...` and `C:/Users/...` each opened their own entry. A
  reading stored under one spelling was invisible to a lookup using another, so a warm cache still
  missed and re-ran the check. Keys are normalized now.

## [0.6.0] - 2026-07-17

### Fixed

- **"Filter by instance" opened nothing and froze the whole app.** Clicking it appeared to do
  nothing, and then no other control responded until you pressed Escape. Both halves were the same
  bug. reka positions a popup by walking the Vue component tree for the nearest popper root, and the
  menu was wrapped AROUND its own tooltip, so the tooltip claimed the anchor and the menu's popper
  never got one. The menu really did open; it just rendered at floating-ui's unpositioned
  `translate(0, -200%)`, which is off-screen above the window. Being a modal menu, it also set
  `pointer-events: none` on the page while it was "open", which is what made everything else stop
  responding. The popper root now lives inside the tooltip, so each anchors to its own element. The
  advanced-search popover next to it was broken in exactly the same way and had simply been failing
  in silence, because a popover is not modal and so froze nothing; it is fixed too. A repo guardrail
  now fails the build on that nesting, and it is tested against both the broken and the fixed shape,
  because the previous guard for this encoded the wrong cause and crashed on import without ever
  running.
- **"Open the session file" asked which app to use instead of just opening.** `.jsonl` has no file
  association on a stock Windows machine, so handing the path to the OS default handler made Windows
  pop its "How do you want to open this file?" picker. The app now names an editor itself: it uses
  the first one it finds (VS Code, Cursor, Notepad++, Sublime) and falls back to Notepad, which
  always exists, so the picker can never appear. macOS opens the default text editor. A new
  **Transcript editor** setting overrides the choice, and a path that points at nothing falls back to
  auto-detect rather than leaving the button silently dead.

### Added

- **Right-click a session.** The sidebar list now has its own context menu: mark as done, open the
  transcript, open or copy the session file, and copy the title, folder or id. Right-clicking acts
  on the row under the pointer without selecting it, so it never loads a transcript you did not ask
  for.
- **Mark a session as done.** A way to say "I have dealt with this" without losing it: the row keeps
  its place in the list and just stops competing for attention (a check, a struck-through title, and
  dimmed). Marks are stored by the app itself rather than in the browser, so they survive a cleared
  browser store. Deliberately not a filter. "Clear all done marks" appears in the list menu once
  anything is marked.
- **Archived sessions are recognised, and hidden by default.** The app now reads Claude's own archive
  flag. Archived is the large majority of a real transcript store, so including them buries the live
  work; that same ratio is why the control is three-way (Hidden, Shown, Only archived) rather than a
  checkbox, since finding one archived session in a mixed list is hopeless. The scope is applied
  before the newest-N cap, so hiding archived returns a full list of live sessions instead of the
  handful that survived the cap.
- **One list-options menu.** The sessions toolbar had grown a row of icon buttons, and each new
  toggle squeezed the search field. Refresh, multi-select, the instance filter and the archive scope
  now live in a single "⋯" menu, which lights up whenever something is narrowing the list, so a
  filter set once and forgotten can no longer read as an empty list with no visible cause.
- **A CI guard against vendored-library export drift**, so the break this release had to
  fix cannot recur silently.

## [0.5.0] - 2026-07-16

### Fixed

- **Stray console windows could flash on an ordinary click.** Spawning a console program on Windows
  allocates a console unless the spawn says otherwise, and nothing here said otherwise. It stayed
  invisible only because the tray happens to launch the daemon with a window-less console that child
  processes inherit; started any other way (from a terminal, from Explorer, as the portable exe) the
  same clicks flashed a real window. Every such spawn now states the intent explicitly, so the
  outcome no longer depends on how the app was started. The worst of them was the periodic usage
  check: it runs `claude` on a timer, and where the packaged `claude.exe` is missing that resolves to
  a `.cmd` batch file, which runs through `cmd.exe`. On those machines it was a CMD window blinking
  on a schedule with no click to blame it on. A guardrail now enforces both directions of the rule,
  since hiding a *graphical* program instead hides the window it was supposed to open.
- **A run could be stuck "running" forever after a crash, and cancelling it could kill an unrelated
  program.** When CC Manager UI restarts, it re-adopts runs that outlived it, and it is careful not
  to trust a dead runner's recorded process id (Windows recycles those numbers, so it may now belong
  to something else entirely). That care never actually happened: the liveness probe searched running
  processes for the run's spec file *by command line*, and the search itself carried that text in its
  own command line, so it always found itself and always answered "still alive". Every Windows
  reattach therefore trusted a stale id. If that id had been recycled by a live program, the run
  waited on it forever (a session stuck "busy" with nothing running), and pressing Cancel would have
  killed that innocent program. The probe now excludes itself, and the tail loop no longer re-adopts
  the id the reattach deliberately refused; it fails the run cleanly instead, with the work it did
  manage still on disk.
- **A 529 overload was treated as your rate limit, so the run died instead of retrying.** `529
  Overloaded` means Anthropic's servers are saturated and it clears in seconds; a session limit
  means your own 5-hour allowance is spent and only time fixes it. Both wear the word "limit", and
  `dispatch.ts` matched them with ONE pattern list, so a run killed by a few-second server hiccup
  was filed `rate_limited` and parked against a reset that had nothing to do with it, while the same
  message sent from the desktop app (which just retries) went straight through. They are now told
  apart (`rate-limit-signal.ts`), and a transient overload is **retried automatically**: three
  tries over ~35s, backing off, before it gives up as its own new `overloaded` status, which is
  neither `failed` (nothing is wrong with the run) nor `rate_limited` (your quota is fine). The
  retry only fires when the run produced no output first, so it can never silently re-do work you
  already paid for; it is DB-backed, so a daemon restart mid-backoff resumes rather than forgets;
  and it is deliberately not behind the scheduler or monitor switches, which are off by default and
  govern hours-scale autonomy, this just finishes the run you started ten seconds ago.
  Ambiguous text still classifies as a quota wall, the conservative default. A migration relabels
  rows already mis-filed by the old detector. The auto-resume monitor now only ever sees a genuine
  quota stop, so it can no longer park a 529 against a five-hour reset that was never coming.
- **The composer claimed "this session is busy" the moment you hit send, with nothing running.**
  `submit()` awaits a queue refresh, and the server doesn't answer until the run is already marked
  `running`, so sending a message flipped the banner on within the very same click, and it then
  announced that the message "will queue and start on its own" about one that had just started
  running immediately. The hint now only shows while there is actually a draft it could apply to,
  which is the only time it says anything useful.
- **The auto-resume monitor was blind to every session it hadn't launched itself.** It only ever
  looked at `queue_items` rows with status `rate_limited`, and the only thing that can set that
  status is a run the daemon spawned and tailed, so a session you started yourself (a bare `claude`
  in a terminal, or the desktop app) that died on a 5-hour limit had a transcript on disk, no queue
  row, and no path to the resume list at all. The list said "Nothing to resume right now" while real
  sessions sat at the wall, and hand-queueing them was the only recourse. The monitor now also
  *finds* stops on disk (`rate-limit-discovery.ts`): it checks transcripts touched in the last 12
  hours for the CLI's own limit notice sitting at the tail with nothing after it, which is exactly
  what "still stopped" looks like. Found stops go through the same rails as any other, the weekly
  usage gate, the per-session attempt cap, the resume buffer, the idempotency check, and carry a
  **Found** badge so a session the app went looking for never reads as one you queued. Detection
  reuses `dispatch.ts`'s existing `isApiErrorEvent` gate unchanged, so the 2026-07-15 false-positive
  class (a run that merely *mentions* "quota" or "529") cannot come back at machine scale. Still
  behind the monitor's off-by-default switch.
- **A downloaded transcript was named after the session's UUID, not the session.** `Save a copy` now
  writes `<session title>.jsonl`, falling back to the id only when a title has nothing
  filesystem-safe left in it. One shared `safeTranscriptFilename` (new
  `@ccmanagerui/server/filenames` export) backs both the download link and the server's
  `Content-Disposition`, because the browser honours the link's name only same-origin and the header
  only cross-origin, so fixing one alone would have left the other broken. It strips the characters
  Windows rejects, refuses the reserved device names (`CON`, `COM1`…), trims the trailing dots
  Windows drops silently, and sends the header as RFC 5987 `filename*` so an emoji or non-Latin
  title names the file properly instead of throwing on an invalid header value.

### Added

- **CI actually typechecks now, and it covers the tests too.** The job had been named
  "lint · typecheck · build · test" since day one while never running a typecheck, and something
  had already slipped through: the portable-window exports (`appWindowPlacementKey`,
  `hasRememberedBounds`, `quoteWinArg`) went undeclared for two commits, which nothing noticed
  because nothing looked. `tests/` was outside every tsconfig for the same reason, so a test could
  only fail at runtime; wiring it in immediately caught a real error in a new fixture. All 34 test
  files across the three test directories are covered now.
- **Copy the session file to the clipboard.** A new button beside "save a copy" puts the `.jsonl`
  FILE on the clipboard, not its text, so Ctrl+V into a folder, a chat or an email pastes the
  actual file, named after the session rather than its uuid. A web page cannot do this at all (no
  clipboard type maps to a native file-drop, by design), so the daemon does it; Windows and macOS
  only, since Linux has no cross-desktop convention for it.
- **A 10-minute stepper in the composer's "queue for later".** The hours stepper now sits next to a
  minutes one that steps in 10s, and a single button queues the combined delay ("In 1h 30m"). With
  both, the fixed **In 15 min** and **In 1 hour** presets were redundant, 1h is the stepper's
  default and anything shorter is a couple of taps, so they are gone; **In 5 hours** and
  **Tomorrow** remain.
- **The scheduler status chip in the header is now a link** to the setting it reports on.

### Changed

- **Pink means "you can click this now".** In the composer's "queue for later" popover, **Queue
  for then** was pink even before a date was picked, when it did nothing. It is now grey until
  you pick one. The hours/minutes button beside it had the same flaw at 0h 0m and follows the
  same rule.
## [0.4.0] - 2026-07-16

### Added

- **The portable window opens at a usable size instead of filling the screen.** A window the
  dedicated Chromium profile had never seen opened at roughly the whole work area, about
  1905x2092 on a 4K display. Both open paths, the daemon and the tray, now ask for 1060x800 on a
  first run and yield to the profile's saved placement ever after, so a size you picked yourself
  always wins. The width is measured rather than guessed: the binding constraint is not the
  1000px shell but the sessions sidebar, which rail-collapses below a 1024px viewport, so
  1024 plus about 16px of window frame is the floor and 1060 clears it with slack.
- **A launch onto an already-running portable profile now sizes correctly too.** Chromium ignores
  both `--window-size` and the saved placement when an instance is already running on that
  profile: the forwarded `--app` window simply inherits the running window's geometry. The daemon
  cannot fix that from outside, so it now tags the window's URL with the size it should have
  (`POST /api/portable-window`) and the page corrects itself once at startup, before first paint.
  Gated to real `--app` windows and a no-op on an un-hinted URL, so an ordinary browser tab is
  untouched. A maximized window deliberately sends no hint.

### Changed

- **The loopback guard is now one shared, audited implementation.** The guard that stops a
  malicious web page from driving the local API was the app's own copy. It now consumes the same
  primitive as the other LunarWerx daemons, so a security-critical decision lives in one reviewed
  place instead of four drifting ones. Behaviour is unchanged for real clients. The shared version
  additionally allows a request carrying no `Host` header, which a browser always sends, so this
  only affects non-browser tools.

### Fixed

- **The release build was broken while the typecheck passed.** The vendored copy of the
  portable-window helper was a stale snapshot missing an export that the code importing it already
  declared, so `tsc` was satisfied and `bun build --compile` failed with "No matching export". The
  vendored file is back in sync, and the window-size applier now has behavioural test coverage
  rather than type-only coverage.

## [0.3.0] - 2026-07-16

### Security

- **Fixed a drive-by remote-code-execution hole in the local API.** The daemon binds localhost and
  its API had no cross-site protection, so any web page you visited while it was running could quietly
  POST to it, queuing a `claude` run with `--permission-mode bypassPermissions`, an attacker-chosen
  prompt and directory, using your own logged-in credentials with no approval prompt, or read your
  session transcripts. The daemon now rejects browser cross-site requests (via `Sec-Fetch-Site` /
  `Origin` / `Host`, which also defeats the "simple request" CORS bypass and DNS rebinding) while
  still allowing the app's own UI, the dev server, and non-browser tools (the tray, MCP clients).
  `permission_mode` is now validated server-side before it can ever reach the CLI.

### Added

- **Real executables on every release.** A tag push cross-compiles self-contained binaries (Bun
  embedded, no install step) for Windows x64, Linux x64/arm64, and macOS x64/arm64, smoke-tests each
  on real hardware for its OS, and attaches them to a draft GitHub release. The binary carries every
  process mode as a subcommand (`--version`, `--mcp`, the detached dispatch runner), keeps state under
  `~/.ccmanagerui/`, serves the SPA from a sidecar `web/dist/`, and the Windows zip ships the tray
  toolkit (no Bun on PATH required).
- **Packaged builds now self-update.** A compiled build checks GitHub Releases, downloads the newer
  platform bundle, verifies the new binary runs before swapping it in place, and relaunches, the
  same Settings check/apply/auto-update controls the source build has. (Source builds still self-update
  via `git`.)
- **Run queued work as any signed-in instance, no token pasting.** The queue's "Run as" picker lists
  every signed-in desktop/CLI instance; the runner extracts that instance's own OAuth token at spawn
  time and fails the run with a clear "signed out?" message rather than silently falling back to the
  ambient login. Signing in on the Instances tab is now how accounts get added, the Settings
  paste-a-token form is gone (existing credentials still work; the raw API remains for headless use).
- **CLI sign-in on every instance row**, from the row's actions menu (create-on-demand when no CLI
  login is linked yet), replacing the single inline table sub-line.

### Fixed

- **Quitting could kill your real Claude Desktop chat.** The External row (the regular,
  non-isolated Claude Desktop) can no longer be quit with one click: the server refuses the
  default profile dir without an explicit confirmation (`confirmExternal`, the quit-side analog
  of Delete's existing guard), and the UI routes it through a warning dialog. The "Browser
  Dance" copy now names ISOLATED instances and says outright that your regular Claude Desktop
  should stay open, the old "quit every other running instance" wording steered a user into
  closing a real conversation.
- **The MSIX warning banner could be flat wrong.** `manageable` now also accepts a LIVE running
  Claude process (carrying `--user-data-dir`) as proof of a working classic install, the
  authoritative `Get-AppxPackage` probe runs (and overrides) when filesystem leftovers from an
  uninstalled MSIX would otherwise pin the verdict forever, the classic binary resolves via the
  stable Squirrel stub first (versioned `app-<ver>` dirs are replaced on every update), and the
  banner re-verifies fresh after any successful open/create and every 60s while visible, so
  "install the classic build" actually clears it once you do.
- **A run pinned to a specific account could silently run as the wrong one.** A queued run pinned to
  an instance whose sign-in had expired, been deleted, or whose reference was malformed used to fall
  back to the ambient login without a word; auto-resuming such a run dropped the pin entirely. Both
  now fail loudly (or carry the pin forward) instead of quietly using different credentials.
- **A queued run's account wasn't shown on its card**, and editing a run whose pinned account had been
  deleted silently reverted it to ambient on save. The card now shows the instance it will run as (or
  "deleted instance"), and the editor shows a clear disabled "deleted instance" option instead of
  quietly changing the run.
- **Deleting a desktop instance could orphan its linked CLI login** into an invisible, unmanageable
  state; a failed "Sign in CLI" left a stray CLI instance behind. Both are cleaned up now.
- **A run recovered after a restart could briefly be double-dispatched**: the scheduler and
  auto-resume monitor could fire before the daemon finished re-adopting runs that survived the
  restart. They now wait for that to complete.

- **A run that merely TALKED about rate limits was marked rate-limited.** The detector matched its
  patterns against every event of a run, tool inputs and tool results included, so an agent that
  grepped for "session limit", or read a file whose line 529 scrolled past, finished as
  `rate_limited` despite exiting 0 with the job done. (Both such rows in the shipped database were
  this; `\b529\b` had matched a line number.) Only the CLI's own report counts now: a synthetic
  API-error message, an errored terminal `result`, or stderr, never model prose, tool inputs, or
  tool results. Runs already mislabeled this way are repaired on startup, along with the auto-resume
  bookkeeping that existed only to babysit them.
- **The auto-resume monitor did nothing at all unless you had added an account.** A run with no
  dispatch account, the default, since the accounts table is empty until you paste a token in, was
  parked at "needs you, no dispatch account on the run" on sight, on the grounds that its usage
  couldn't be gated and its auth couldn't be injected. Neither was true: an ambient run uses the
  login `claude` already has, which needs no injection to resume and whose quota reads straight from
  its config dir (the same read `check_my_usage` already did). Ambient runs now go through the usage
  gate like any other, so the monitor actually resumes them.
- **Sending a message opened a console window that stayed on screen for the whole run.** The detached
  runner is created through WMI, which applies default startup info, so `bun` (a console app) got a
  real, visible window; the daemon's own `windowsHide` only ever covered the short-lived PowerShell.
  Beyond the eyesore, closing that stray window killed the runner and `claude` mid-turn, and the run
  then finalized as a bare "failed, exit -1". It is created hidden now.
- **The session view showed conversation the CLI was having with itself.** Resuming a session whose
  last turn died on an API error makes `claude` append a canned "Continue from where you left off." /
  "No response requested." pair, same millisecond, no model call. Rendered as real turns they read
  as though a prompt had been sent and refused. They're filtered; the rate-limit notice, the one
  synthetic message that explains anything, still shows.
- **"exit -1" now says what it means.** It is our own code for "the process vanished before it
  finished", never something `claude` reported, and the paths that produce it recorded nothing to
  say so. They now explain themselves, and the badge reads "interrupted" instead of a number nobody
  can look up. Transcribing an event can also no longer throw and take the tail loop down with it.

### Changed

- **Finished runs fold away in the queue.** Completed, failed, canceled, and rate-limited items move
  behind a "Show N finished" disclosure instead of crowding the list, and the header counts what is
  still pending rather than the all-time total. The per-item card moved to `QueueItemCard.vue`.
- **The composer's busy warning says what will happen to your message.** It stated a rule ("a session
  with a run in progress gets its message queued instead of sent") and left you to guess whether the
  message was about to run or stuck. It now says which, start on its own when the current run
  finishes, or wait for you to press Run when the scheduler is off, and why two runs can't share a
  session.
- **Queuing a run resumes a session from a searchable list instead of a pasted UUID.** The run
  builder's "session to resume" field is now a searchable picker over the same session list the
  sidebar shows (sorted most-recently-active first), each row carrying the friendly title, its
  folder/branch/last-activity, and the opaque id tucked to the side (click it to copy). It supports
  multi-select: pick several sessions and one queued run is created per session, sharing the same
  prompt and options. A new `SessionPicker.vue` backs it.
- **The run builder leads with three fields, not thirteen.** Model, effort, permission, account,
  run-at, fork, and the resume title/folder overrides now live behind an "Advanced options"
  disclosure; the common path is just the session (or new-chat title + folder) and the prompt. The
  "New chat from scratch" toggle is hidden when editing an existing item (editing never converts a
  run's kind). Long prompts no longer push the dialog off-screen, the prompt box caps its height and
  every dialog now scrolls instead of overflowing the viewport.
- **Settings is one scrolling page.** The General / Scheduler / Accounts tabs were merged: Accounts
  is now a section rather than a tab, and Scheduler folds in with everything else. "Show desktop /
  CLI instances" moved from Usage to Appearance (it's a display choice). The auto-resume monitor's
  tuning numbers (max attempts, resume buffer) moved behind an Advanced disclosure and, along with
  the monitored-runs list and per-account overrides, collapse away entirely when the monitor is off.
  The monitor's empty state now explains that a run only appears there after it stops on a rate limit
  (an empty list doesn't mean monitoring is off). A deep link (the composer's "tomorrow" gear) now
  scrolls to the Scheduler section instead of switching a tab.
- **The queue toolbar's scheduler indicator is an icon with a hover, not a text pill**, and shows
  both on and off states at a glance. The redundant "Queue resume" button was removed, "New run"
  already opens the builder in resume mode.

### Added

- **A quota percentage is now quantified into something you can plan with.** "98% used" is not a
  decision: 98% with a reset in 20 minutes is fine, while 98% with a reset in four days at 1%/hour
  means being cut off mid-task in about two hours. Same number, opposite action. Anthropic publishes
  no quota size (`limit_dollars` / `used_dollars` / `remaining_dollars` are all null on a
  subscription, and there are no token counts anywhere in the response), so the numbers are derived
  instead. `server/src/usage-history.ts` keeps the readings the background sweep already takes and
  differentiates them into a burn rate, an hours-of-headroom figure, and `exhaustsBeforeReset`, the
  one field that actually decides anything. `server/src/usage-tokens.ts` counts what was really spent
  from the Claude Code transcripts (which do carry exact per-turn token counts and the model), and
  `server/src/usage-budget.ts` divides one by the other to MEASURE the size of one percent in tokens,
  reported as "~N more assistant turns" because an agent can reason about turns but cannot predict its
  own raw token totals. New `usage_budget` MCP tool and `GET /api/usage/budget`.
- **The usage MCP tools now work with the app closed.** `check_my_usage`, `list_usage` and
  `usage_budget` need nothing the daemon uniquely owns (the OAuth tokens are files on disk, the quota
  endpoint is a plain HTTPS GET, the transcripts are local JSONL), so when the daemon is not running
  they execute in-process instead of failing. The queue and dispatch tools deliberately do not get
  this: they mutate shared sqlite state and supervise real processes, where a second uncoordinated
  executor would be a correctness bug, so they still fail loudly and say why.
- **Usage checks now hit the quota endpoint directly instead of spawning `claude`.** The CLI's own
  `/usage` screen is just a GET against `https://api.anthropic.com/api/oauth/usage`, Bearer-authenticated
  with an OAuth access token; calling it ourselves (`server/src/usage-api.ts`) skips booting the
  ~250 MB Bun-compiled `claude` binary entirely. Measured on one machine: the old spawn path took
  9,353 / 9,262 / 9,218ms per check, the direct GET took 372 / 424 / 169ms, roughly 25 to 50x faster.
  It is also richer than the text screen: `resets_at` is a real ISO-8601 timestamp (the text screen
  prints a yearless human string like "Jul 19, 3:59am"), `severity` (normal/warning/critical) is
  computed server-side instead of guessed from a threshold, and a per-model weekly sub-limit carries
  its own name via `scope.model.display_name`. Reading usage costs no quota: it is a read, not an
  inference call. The `claude -p "/usage"` spawn remains as a fallback for the cases the direct path
  can't serve: no OAuth token in hand, an account configured with an API key instead (the endpoint is
  OAuth-only), or the server rejecting the token with 401 (expired); the daemon deliberately does not
  refresh the token itself, since rotating the user's refresh token could break their real login, so an
  expired token falls back to the CLI's own refresh instead.
- **CLI instances can be linked to a desktop instance.** `CliInstance.associatedDesktopDir` records
  that a CLI instance and a desktop instance are the same Anthropic account under two independent
  logins, so each can serve as the other's usage-check fallback when one token is expired or missing:
  a desktop instance's chain is its own token, then a linked CLI instance's login, then a dispatch
  account matching the email; a CLI instance's chain is its own login, then an associated dispatch
  account, then a linked desktop instance's token. New `link_cli_instance_to_desktop` MCP tool.
- **Background auto-refresh of usage, on by default.** A staggered sweep keeps every instance's usage
  number warm without a manual refresh, skipping any instance with no usable credential up front. Each
  check costs about 300ms and no quota, so polling on a loop is no longer the liability it was when it
  meant spawning `claude`. Toggle and interval live in Settings → General, alongside separate toggles to
  show or hide the desktop and CLI instances tables.
- **Usage responses carry an `advice` verdict.** Every usage check (`check_usage`, `check_my_usage`,
  `list_usage`, the UI's usage cell) now includes `{ severity, bindingPct, shouldOffload, safeToFanOut,
  advice }` alongside the raw percentages, so a caller does not have to re-derive "is this bad" from
  thresholds itself. `shouldOffload: true` means the caller is close to being cut off mid-task.
- **`check_my_usage` now works from a normal Claude Code session, not only a CLI instance.** It falls
  back to the default `~/.claude` login when `CLAUDE_CODE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` is unset,
  which previously made the self-check error out for the everyday case of the session the user is
  actually talking to. New `list_usage` MCP tool surveys every managed instance (desktop and CLI) at
  once, each with its own `advice` verdict, for picking an account with headroom before routing heavy
  work.
- **A CLI login is now a usable usage-check source in its own right.** `<CLAUDE_CONFIG_DIR>/.credentials.json`
  is plain JSON (`claudeAiOauth.accessToken` plus `.scopes`, no DPAPI/safeStorage layer), so a CLI
  instance that has run `/login` gives a usage-capable token directly, independent of any desktop
  instance.
- **CLI instances.** A CLI instance is a `CLAUDE_CONFIG_DIR` associated with an account and logged in
  once, the command-line counterpart to a desktop instance (which isolates via `--user-data-dir`).
  The Instances view now manages them alongside desktop instances: create one (the app makes its
  config dir), open a terminal to use it, a one-click "Log in" helper that opens a terminal for you to
  run `/login` (the app never performs the login itself), associate it with a dispatch account, rename,
  and a guarded delete. Persisted as plain JSON under `~/.ccmanagerui`, never a token.
- **Usage-check subsystem.** Read an account's remaining Claude subscription quota (session 5-hour %,
  weekly all-models %, and per-model weekly %) by running `claude -p "/usage"` with the account's auth
  injected. A DESKTOP instance is polled using its OWN decrypted OAuth token (never persisted), so it
  works with no dispatch account and no CLI login; a registered dispatch account or a logged-in CLI
  instance also work. The desktop token cache holds two grants (a full CLI grant and a profile-only
  grant); the usage path deliberately selects the `user:inference`-scoped grant, since the profile
  grant runs `/usage` but returns no numbers. The probe also sets `CLAUDE_CODE_OAUTH_SCOPES` from
  that grant: without it `claude` quietly stops treating `/usage` as a command and prints a cost
  summary with no percentages, which only shows up when the daemon runs outside a Claude Code
  session (for example the tray, launched from Explorer). Surfaced three ways: a per-row usage cell in the
  Instances table (the binding weekly % color-coded, with a hover breakdown), a `check_usage` MCP
  tool, and a `check_my_usage` self-check any agent can call. Checks are on demand (each spawns a real
  `claude`) and cached with an age; a no-data result shows ", " with a reason rather than silently.
- **AI self-check guidance.** `docs/AI_USAGE_SELFCHECK.md` plus a README note teach agents that they
  can read their own quota and that the weekly all-models % is the binding cap to pace by.
- **Auto-resume monitor (opt-in, off by default).** A session killed mid-work by a 5-hour rate limit
  can auto-resume once the window clears, gated on the weekly cap not being maxed. Detection reuses the
  existing structured `rate_limited` run status; a resume is a normal queued `--resume` run scheduled
  for just after the reset. Safety rails: a per-session resume cap, idempotent scheduling, a global
  switch plus per-account overrides, and a status chip ("resumes ~HH:MM" / "blocked: weekly maxed" /
  "needs human"). Settings and `get_monitor` / `set_monitor` MCP tools expose it.

## [0.2.0] - 2026-07-13

### Added

- **Per-instance icon and color.** Every row in the Instances table now shows a customizable glyph
  in place of the old green status dot. An "Edit" action (in the row's ⋮ menu) lets you pick an icon
  from a curated set and a color from a fixed palette, with a live preview; a running instance keeps
  a small pulsing badge on the icon's top-right corner, and a stopped one dims. Instances you have
  not customized get a stable, distinct default derived from their folder, so the table reads at a
  glance.

### Changed

- **An instance is named after the account it is signed into, not the folder it lives in.** The
  folder name was only ever a guess at the identity, and it stops being true the moment a profile is
  signed into an account other than the one it was named after, nothing prevents that drift and
  nothing corrects it. On the machine this was built against, the folder called `claude` was signed
  into `6claude@lunarwerx.com` and had been reading as "claude" the whole time, while two other
  instances had been hand-relabelled to their accounts precisely to paper over the same problem. So
  the resolved account's name (its profile name, else the local part of its email) is now the
  default, ahead of the folder name; an explicit label you set still wins over both, and the folder
  name remains the last resort for an instance with no resolved identity. The dir is still shown
  under each name, so two profiles on one account stay distinguishable. `SessionsView` reads the
  same shared instance list rather than fetching its own, so a session's instance chip and the
  Instances table can no longer disagree about what the same instance is called.
- **Accounts resolve themselves; the "Resolve" button is gone.** Resolving reads `config.json` and
  the token cache off disk, so a stopped instance resolves exactly as well as a running one, but
  auto-resolution was gated on `isRunning`, which meant a stopped instance sat there offering a
  button that would have worked on the first click, every time. That is a chore, not a choice. Every
  instance now resolves on its own, running or not, and an instance with no identity yet (logged
  out, offline) is retried once a minute so signing one in surfaces without a restart. The inline
  button and its ⋮ entry are both removed; the toolbar's Refresh now force-re-resolves every account
  live, which is the only case a manual action was ever good for (a stale cached identity). Resolving
  no longer marks the row busy, it changes nothing about the instance, and flagging it made the
  row's buttons flicker un-clickable whenever a background resolve was in flight.
- **The Instances table's quota numbers stay current while you watch them.** The background sweep
  refreshes the server's usage cache every 15 minutes, but the UI only ever pulled that cache once,
  on mount, so an open Instances tab kept showing its first reading and went quietly stale for as
  long as you left it open. It now pulls on the same 4-second cycle the instance list already
  refreshes on, measured firing in lockstep with it. This is a read of the server's own cache: no
  probe, no `claude`, no request to Anthropic, and no quota spent, so there was no reason to do it
  once and hope. The "Refresh all usage" tooltip no longer claims each check "spawns a real claude
  process", which stopped being true when checks became a direct ~300ms API read.
- **Fewer rules on the Instances screen.** The two tables abutted, separated only by a hairline
  sitting flush against the desktop table's last row, which read as one continuous table whose last
  rows happened to have different columns. They are now separated by space instead, and both section
  toolbars lost their bottom border, the sticky table header immediately below each one already
  draws that line, so the second rule was weight for nothing. This matches Sessions, Queue, and the
  app header, which were borderless already. The row separators stay; they are the ones doing work.
- **Renaming an instance is now instant and works while it is running.** A rename used to move the
  instance's on-disk profile folder, which Windows will not allow while Claude Desktop holds it open.
  The name is now a display label kept as UI metadata (`~/.ccmanagerui/instance-meta.json`, never a
  secret) that overlays the folder name wherever it is shown; the folder keeps its original name as
  the stable id that sessions are tagged by. The old `POST /api/instances/:dir/rename` folder-rename
  route was replaced by `POST /api/instances/:dir/meta` (display label, icon, and color in one call).
- **A running instance's row leads with Focus.** For a running instance the primary button is now
  "Focus" (bring its window to the front); "Quit" moved into the ⋮ menu, so the common action is one
  click and the destructive one is deliberate. The ⋮ menu was widened so "Create desktop shortcut"
  no longer wraps.
- **Header and panel cleanup.** Removed the redundant "New run" button from the app header (it
  already lives in the queue drawer), and dropped two divider lines (below the queue drawer's toolbar
  and below the sessions search box). The sessions list and its instance filter now show each
  instance's display label.

### Fixed

- **A burn rate of "zero" no longer means "work freely".** The reported percentage is an INTEGER, so a
  burn of 0.8%/hour does not tick the number for over an hour. The first cut of the forecast measured
  that flat stretch, concluded the burn was zero, and reported "you will never hit the cap" while
  sitting at 98% used. That is a false green light, the single most expensive way the feature can be
  wrong, since an agent keeps working and is cut off mid-task holding unsaved context. The burn rate is
  now a RANGE: a measured delta of `d` could truly be as much as `d + 1` given integer rounding, so the
  upper bound is `(d + 1) / hours`, which is always above zero. Every derived figure (`headroomHours`,
  `exhaustsAt`, `exhaustsBeforeReset`, and the token budget's denominator) is computed from that upper
  bound, making the forecast deliberately pessimistic. The asymmetry is the point: a needless warning
  costs a moment of caution, a false green light costs the whole task. The measurement floor also rose
  from a 20-minute to a 45-minute span, below which an integer percentage simply cannot resolve a slow
  burn and the answer is honestly reported as unknown rather than as zero.
- **Rebuild.bat could leave a STALE daemon serving old code while reporting success.** It found the
  daemon solely by the port recorded in `~/.<app>/runtime.json`; with that pointer missing it printed
  "App does not appear to be running", killed nothing, and relaunched the shortcut, which no-ops
  against the tray's single-instance mutex. Nothing then checked the outcome, so the build was fresh on
  disk while the process serving it was hours old (found in the wild at 10h39m). The pointer is now
  only a hint: `misc/Restart-Daemon.ps1` probes every bun/node listener's `/api/health` and stops only
  processes that identify themselves as this app (`service` === package.json `name`, the same contract
  the single-instance guard uses), which both finds an orphan the pointer forgot and cannot kill a
  sibling app. `misc/Wait-Daemon.ps1` then asserts the daemon now answering actually started AFTER the
  restart, because "the daemon is up" proves nothing when the stale one was up the whole time.
- **Mutating API routes no longer 500 on an odd request body.** A body that is valid JSON but not an
  object (a bare `null`, a number, or a string) used to crash the handler with a 500; every mutating
  route now runs the body through a shared object guard and degrades gracefully. Creating a new
  instance also starts it with a clean appearance, so reusing a name never resurrects a deleted
  instance's old label, icon, or color.

## [0.1.0] - 2026-07-13

### Added

- **Queued `claude` runs now survive quitting (or auto-updating) CC Manager UI.** A dispatched run
  used to be a direct child of the daemon, so a tray Quit (which force tree-kills the daemon) or an
  auto-update relaunch killed the run mid-flight and left it stuck marked "running". Now the daemon
  launches each run through a detached supervisor (`server/src/dispatch-runner.ts`) that owns the
  `claude` process and streams its output to a per-run log file the daemon tails; the run keeps
  executing to completion even with the daemon gone. On the next launch the daemon **reattaches** , 
  rebuilds the run's events from its log and resumes the live view, or records the final status if it
  finished while the daemon was down (`reattachRuns`, `server/src/dispatch.ts`). On Windows the
  supervisor is created via WMI (`Win32_Process.Create`) so it escapes the daemon's job object;
  verified end-to-end that a run survives a `taskkill /T /F` of the daemon and a graceful shutdown,
  then reattaches and completes. The run's account secret is read from the DB by the supervisor (never
  written to disk), and cancel still works (it kills `claude`; the run finalizes as "canceled").
- **Auto-update waits for the queue to go idle.** Auto-update relaunches the daemon; even though runs
  now survive that, it now defers applying an update while any dispatch run is in flight (rechecked
  the next interval), so a relaunch never churns a live run's stream (`server/src/auto-update.ts`).
- **Per-instance desktop shortcuts.** Each row's ⋮ menu on the Instances tab gained
  **Create desktop shortcut**, which drops a launcher on the desktop that opens that one
  instance directly (`Claude --user-data-dir=<dir>`) without going through the manager. On
  Windows it writes a `.lnk` (via `WScript.Shell`) whose target is the STABLE root
  `claude.exe` Squirrel stub, so the shortcut keeps working after Claude Desktop updates to a
  new versioned build, and it takes its icon from the stable `app.ico`; macOS gets a
  `.command` script and Linux a `.desktop` entry. Values are passed to PowerShell through the
  environment (never string-interpolated), and the failure path reuses the same MSIX-aware
  message as Open (`POST /api/instances/:dir/shortcut`, `server/src/core/shortcut.ts`).
- **Rename an instance.** Each row's ⋮ menu on the Instances tab gained **Rename**, which opens a
  dialog (prefilled with the current name) to give a stopped instance a new name, renaming its
  profile folder in place. It runs through the same guards as delete: refused while the instance
  is running, for the protected default profile, for external instances, and on an invalid or
  colliding name (`POST /api/instances/:dir/rename`, `server/src/core/lifecycle.ts`).
- **Live per-instance memory and uptime.** The Instances table's Uptime column now fills in from
  each running instance's process start time, and the former (always-empty) Size column is
  replaced by **Memory**, the summed working set across the instance's whole Electron process
  tree (main plus renderer/gpu/utility children). Both are read from the same `Win32_Process`
  snapshot the table already takes each poll (`WorkingSetSize` plus `CreationDate`), so there is
  no extra process scan.
- **Brand icon everywhere.** The orange CC Manager UI mark is now the browser favicon
  (`web/public/favicon.svg` + a `favicon.ico` fallback) and the tray/taskbar icon. The old
  `misc/Make-Icon.ps1` drew a placeholder violet ">_" tile programmatically; it now rebuilds
  `misc/CCManagerUI.ico` from the committed `misc/CCManagerUI-icon.png` master (re-rendered from
  the favicon), matching the sibling apps' icon-generator convention.
- **Sessions across every Claude Desktop instance, with an instance filter.** Each desktop
  instance keeps per-session metadata whose `cliSessionId` names the CLI transcript in the
  shared `~/.claude/projects` store; the daemon now scans those to label every session with
  its instance (`instance`: an `~/.claude-instances` dir name, "default" for the main
  install, or null for plain CLI). The sidebar shows the instance on each row and gained a
  filter dropdown (All / Default / each instance / CLI-other) that scopes the list
  SERVER-side, before the newest-200 cap, so a quiet instance's older sessions finally
  surface (`GET /api/sessions?instance=`).
- **Open / save the raw session file.** Two transcript-header buttons: one opens the
  session's `.jsonl` with the OS default handler on the daemon's machine
  (`POST /api/sessions/:id/open-file`), the other downloads a copy through the browser
  (`GET /api/sessions/:id/file`, works over remote access too).
- **Favicon.** The app finally has one (`web/public/favicon.svg`).
- **Update remote wired up.** Repository published at `LunarWerxs/ccmanagerui`, so the
  Settings Updates panel checks against something real instead of reporting that updates
  can't be checked.
- **Chat composer on the Sessions tab.** An open transcript now has a message box at the
  bottom, like a chat: type, press Enter, and the message is dispatched to that session
  immediately (a queue item is created and run in one step). Option chips under the input
  (model, effort, permissions, account, working directory) all default to "inherit" and only
  need touching for an override; the working directory defaults to the session's own. A
  Queue button adds the message to the queue instead, and a clock button offers "queue for
  later" presets (15 min / 1 h / 4 h / tomorrow 9:00) plus a date-time picker. Sessions with
  a run already in progress queue new messages instead of double-resuming.
- **Multi-select messaging.** A select toggle above the session list turns rows into
  checkboxes (with select-all over the current filter); the composer then targets every
  checked session, so "send `resume` to five chats" is one message and one click, creating
  one queue item per session, each in its own working directory.
- **Scheduled queue items.** Queue items gained an optional "Run at" time (`not_before`
  column): the scheduler skips them until the time passes, without blocking later items.
  Scheduled cards show a "runs HH:MM" badge; manual Run still fires immediately.
- **Edit queued items.** Non-running queue cards now have an edit button that opens the
  builder dialog prefilled (including the new Run-at field) and saves via PATCH.
- **Live transcript follow.** While the selected session has an active queue run, the
  transcript refreshes on its own (and once more when the run starts or finishes), so
  replies stream into the open chat without pressing Refresh.
- **Per-session run lock.** The daemon now refuses to start a second run against a session
  that already has one active (manual Run returns 409, the scheduler skips to the next
  eligible item), so two `claude --resume` children can never interleave writes to the
  same transcript. The composer treats that 409 as "queued" rather than "failed".
- **Run due (n) button in the queue drawer.** One click dispatches every currently-due
  queued item at once (`POST /api/queue/run-due`). Like the per-card Run button it ignores
  the scheduler's enabled/spacing/concurrency limits, but it honors the per-session lock:
  items whose session is (or just became) busy stay queued and are reported as skipped.

### Fixed

- **Quitting CC Manager UI no longer closes the Claude Desktop instances it launched.** The
  Windows tray host quits by tree-killing the daemon's whole process tree
  (`taskkill /PID <daemon> /T /F`), and instances were spawned as direct children of the daemon,
  so Quit dragged every open Claude instance down with it. Neither `.unref()` nor Bun's
  `detached: true` breaks the Windows process tree; the launch now goes through a `cmd /c start ""`
  hand-off that re-parents the instance out of the daemon's tree, so it survives Quit
  (`server/src/core/instances.ts` `buildInstanceLaunch`, `server/tests/instances-launch.test.ts`).
  macOS already detached via `open`; Linux now spawns with `detached: true` (setsid).
- **The Instances ⋮ "More actions" menu opens again.** Its trigger had been wrapped in a
  tooltip, and the nested `TooltipTrigger`/`DropdownMenuTrigger` (both `as-child`) swallowed the
  click so the menu never opened, while the zero-delay tooltip itself was intrusive. The kebab
  is now a bare dropdown trigger with an `aria-label`, it opens on click, with no tooltip.
- **The Instances refresh icon no longer spins on every poll.** The list silently re-polls every
  4 s and the spinner was tied to that `loading` flag, so it flickered constantly and read as a
  constant spin. Background poll ticks are now silent; the icon spins only on a first load or a
  user-initiated refresh.
- **Instance discovery no longer breaks on profile paths that contain a space.** When an
  instance's `--user-data-dir` has a space (a space in the Windows user name, or a space in the
  instance name itself), `Bun.spawn`/libuv wraps the whole `"--user-data-dir=C:\a b\c"` token in
  quotes, and the previous command-line parser truncated the path at the first space, so the
  running instance was mis-matched (it showed as "stopped" or as a stray external row). The
  `core/process.ts` parser now handles all three quotings (unquoted, value-quoted, and
  whole-token-quoted), see `tests/process-parse.test.ts`.
- **Composer toasts render as real toasts.** The "Queued N message(s)" confirmation showed as
  bare unstyled text lines: vue-sonner v2 ships its styling as a separate stylesheet that was
  never imported. `main.ts` now imports `vue-sonner/style.css`, so every toast gets its card,
  border, and shadow back.
- **Open drawers no longer cover the header buttons.** The top bar now shares the push-panel
  padding shift with the main content (plus its own 16px), so New run / Queue / theme /
  Settings slide left to stay clickable instead of disappearing under the settings or queue
  drawer.
- **Push panels no longer crush the centered shell (kit-wide).** The settings/queue drawers
  dock to the viewport's right edge, but the content shift now equals only the panel's
  actual overlap with the centered app shell (zero on a wide monitor) instead of the full
  panel width. This removes the dead band that squeezed the Instances table to half size
  and nudged the Sessions placeholder left whenever Settings was opened.
- Built SPA now talks to the daemon over same-origin relative URLs instead of a hardcoded
  `http://localhost:7787`, so the UI keeps working when the daemon port-hops off its preferred
  port. Dev (Vite) behavior is unchanged; `VITE_API_BASE` still overrides both.
- Free-port probe (`find-free-port`) is now loopback-aware: it no longer picks a port that's
  only bound on another interface, closing a race where the daemon could report itself bound to
  a port a different loopback-only process (e.g. `wrangler dev`) was already holding.

### Changed

- **The composer lost its top divider line** (the transcript column stays borderless).
- **Queue moved from a tab to a slide-in drawer.** The queue now opens as a right-side push
  drawer from a header button (with the running-count badge), so the list rides alongside
  the Sessions or Instances view instead of replacing it. Only one drawer (queue or
  settings) is open at a time.
- **Settings split into tabs.** The Settings panel now groups its sections under three tabs
  (General / Scheduler / Accounts) using the shared kit's segmented tab bar, instead of one
  long scroll. General holds appearance, updates, and auto-update; the "Save settings" footer
  stays visible on every tab and still flushes the scheduler form.
- **One Updates group, and it explains itself.** The separate Auto-update section merged into
  the Updates group (the auto-check toggle and interval sit right under the manual check).
  The cryptic "No update source" row now reads "Updates can't be checked" with a visible
  explanation (no Git remote linked; add one or set `CCMANAGERUI_UPDATE_REPO`), and the
  auto-update rows gray out while there is no source to check.
- **Queue resume lives in the queue drawer.** The transcript header's primary button now
  opens/closes the queue drawer; the "Queue resume" action (builder in resume mode) moved
  into the drawer's toolbar next to New run. "Show tool activity" shrank from a labeled
  switch to an icon toggle (pressed = tool events shown), matching the ID button beside it.
- **Multi-select banner is count-only.** "Sending to N sessions" no longer tries to list every
  target's title (they always truncated into noise).
- **Drawer headers/footers lost their divider lines (kit-wide).** The shared panel shell no
  longer draws a border under its title bar or above its footer.
- **Header cleanup**: the scheduler pill left the top bar (its toggle plus counts and interval
  controls already live in Settings → Scheduler); the Queue page now shows a small "Scheduler
  on" chip whenever it's enabled, so auto-dispatch is still visible where it matters. The
  "New run" header button is now a compact plus icon that expands on hover/keyboard focus to
  reveal its label (same pattern as DevWebUI's top bar), and the Queue page title gained an
  info hint explaining what the queue is and that nothing runs by itself while the scheduler
  is off.
- **Default port moved 8787 → 7787.** 8787 collided with both another local dev server and
  `wrangler dev`'s default. Set `PORT` to override; the daemon still hops to the next free port
  if its preferred one is busy and records where it landed in `~/.ccmanagerui/runtime.json`.

### Added

- **MSIX install warning (Instances tab)**: the daemon now detects which Claude Desktop build
  is installed on Windows (`GET /api/desktop-install`, `server/src/core/desktop-install.ts`).
  Anthropic's current download page ships a ~7 MB `ClaudeSetup.exe` bootstrapper that installs
  the MSIX package under the ACL-locked `C:\Program Files\WindowsApps`; that build can't be
  launched with `--user-data-dir`, so instance create/open can't work with it. When only the
  MSIX build (or no Claude Desktop at all) is present, the Instances tab shows a warning
  banner linking the classic ~217 MB Squirrel installer
  (`https://claude.ai/api/desktop/win32/x64/exe/latest/redirect`).
  `CCMANAGERUI_FAKE_DESKTOP_INSTALL` (msix-only | none | ok) forces the detection result for
  dev/testing.
- **Portable mode**: a server-persisted setting (Settings → Appearance → Portable window) that
  opens CC Manager UI in its own chromeless Chromium app window (`msedge`/`chrome --app=`, no
  tabs or address bar) instead of a browser tab. Applies both to the in-app toggle (`POST
  /api/portable-window`) and the desktop tray launcher, which now opens the UI through the
  portable-mode-aware `Open-AppUi` helper. The window gets its own dedicated Chromium profile
  (`~/.ccmanagerui/portable-profile`, `--user-data-dir`) so it remembers its size/position
  across launches instead of sharing the main browser profile; both open paths derive the same
  profile dir from `runtime.json`'s location.
- **MCP stdio server** (`server/src/mcp.ts`, `bun run mcp`), exposes CC Manager UI's
  sessions/queue/instances API over MCP stdio for use from Claude Code / Claude Desktop.
- **Background auto-update loop**: an opt-in daemon-wide timer that checks the update remote on
  a schedule and, when a newer commit is available and the working tree is clean, pulls +
  reinstalls + rebuilds + self-relaunches so the running daemon stays current unattended. Off by
  default; never touches a dirty working tree.
- Repo hygiene pass to bring the tree up to the standard of its LunarWerx siblings: CI
  (`.github/workflows/ci.yml`, lint + typecheck + build + test on ubuntu/windows), an Architect
  config (`.arkitect/`) with a gating bundle-weight-budget check, an MIT `LICENSE`,
  `.editorconfig`, `bunfig.toml`, and a documented `.env.example`.
