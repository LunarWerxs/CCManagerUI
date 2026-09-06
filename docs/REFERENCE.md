# Reference

Everything the README deliberately leaves out. The README is for deciding whether you want this;
this file is for running, configuring and hacking on it.

- [MCP server](#mcp-server)
- [Claude Desktop session mapping](#claude-desktop-session-mapping)
- [Config (env)](#config-env)
- [ChatGPT handoff](#chatgpt-handoff)
- [Keeping the daemon alive](#keeping-the-daemon-alive)
- [Auto-update](#auto-update)
- [Instance appearance](#instance-appearance)
- [Stack](#stack)
- [Layout](#layout)
- [Checks](#checks)

Agents looking for the quota tools specifically want [AI_USAGE_SELFCHECK.md](AI_USAGE_SELFCHECK.md).

## MCP server

The daemon's REST API is also exposed over MCP stdio (`server/src/mcp.ts`, or `bun run mcp`), so
agents (Claude Code, Claude Desktop, Cursor) can drive sessions, the run queue, accounts, the
scheduler, and instances the same way the web UI does. Start the daemon first; the MCP server
follows its actual bound port via the runtime pointer, overridable with `AGENTHYDRA_URL` (full base
URL) or `AGENTHYDRA_PORT`.

```json
{
  "mcpServers": {
    "agenthydra": {
      "command": "bun",
      "args": ["run", "--cwd", "<path-to-agenthydra>", "mcp"]
    }
  }
}
```

### Register it at USER scope, not project scope

For Claude Code, the one-liner below is the supported way to write that entry, and the **scope is
load-bearing**:

```sh
claude mcp add --scope user agenthydra -- bun run --cwd <path-to-agenthydra> mcp
```

User scope is load-bearing: it makes the tools available from any directory, not only from
inside this checkout. A project-scoped registration gives the server its tools in this repo and
nowhere else, which is the same as not having them.

That is not hypothetical. On 2026-08-30 the server was found registered **nowhere at all**, not at
user scope, not in a single project. The server itself was fine the whole time (all tools
present); it had simply never been plugged in. If anything reports that it is driving the daemon
over HTTP directly, this registration is missing on that machine.

Verify with `claude mcp list`. The entry should say `✔ Connected`. A session already open when you
register it will not see the new tools; its tool list is fixed at startup, so start a new one.

Tools cover sessions (list / get / tail / search / export across Claude, Codex, OpenCode, Hermes and
the foreign readers), project discovery (`list_projects`), chats a usage limit cut off
(`list_rate_limited_sessions`), the queue (list / add /
update / run / cancel / events), accounts (secrets always masked), the scheduler (get / set),
Claude Desktop instances (list / launch / quit), Claude CLI instances, and Codex CLI/Desktop
instances (list / create / CLI launch / login helper / desktop open / focus / quit / redeem a
banked `/usage reset` credit via `redeem_codex_reset_credit`), usage-check (`check_usage`,
`check_my_usage`), the auto-resume monitor (get / set), an update check, and the orchestrator
(`orchestrator_menu`, `orchestrator_run`, `orchestrator_loop`, `orchestrator_switch` - see [The
orchestrator](#the-orchestrator) below), plus **`move_chat`** - the one-call account move
(`{chat, from?, to?}`: fuzzy title, account by name/number/label/email, `to` defaults to `"here"`
and accepts `"best"`; every landing is stamped `bypassPermissions` and the mode is read back from
disk - see [Moving chats](MOVING-CHATS-BETWEEN-ACCOUNTS.md#the-fast-path-one-call)), and
**`fan_out`** / **`fan_out_status`** / **`fan_out_send`** - one task list spread over OTHER
accounts as visible desktop chats, one account each, then read and steered as a group (the
orchestrator table below has the mechanics).
Mutating tools say `MUTATES:` in their description; there is deliberately no shutdown tool.

`list_sessions`, `get_session`, and `tail_session` accept a `source` of `claude`, `codex`,
`opencode` or `foreign` (the shared reader for Cursor, Windsurf, Zed, Copilot CLI and the rest);
every returned session is source-tagged. Session viewing/search is unified, but queue dispatch,
composing replies, and rate-limit auto-resume remain Claude-only.

### Reading ALL the history, not just today's

`list_sessions` defaults to the **last 24 hours**, because the list it powers answers "what am I
working on". An agent told to go through "all my chat histories" therefore has to say so, and the
tool description says the default out loud so it knows to:

- `period: "24h" | "7d" | "30d" | "all"`, or explicit `since` / `until` bounds (epoch ms or an ISO
  date) for a real date range.
- `offset`, for paging past the 500-row ceiling. Pages are contiguous: `offset: 500, limit: 500` is
  exactly page 2 of the same ordering, because the offset is counted in returned rows rather than
  in index entries, which would skip an unknown number of them.
- `project`, a case-insensitive substring of the working directory or project key.
- `list_projects {}` lists every folder that has conversations in it, with a session count and a
  per-provider breakdown. Read from the transcript index, never a transcript, so it is cheap. This
  is the index of the index: start here to find out what "all" contains, then scope a real query.

### Chats a usage limit cut off

`list_rate_limited_sessions { pendingOnly?, period?, project?, limit? }` lists the conversations a
quota wall ended: "You've hit your weekly limit · resets 3am". Every session row also carries the
same verdict as `limit_stop`, and `rateLimited: "only" | "pending"` narrows `list_sessions` the same
way; the web UI exposes it as **List options -> Usage limits**.

`pending: true` means nothing followed the notice, so that session is *still* stopped there, the
actionable half. `pending: false` means it was resumed afterwards and is history. Pending-ness is a
pure function of the file, recomputed on every scan: the CLI cannot resume a session that died on an
API error without appending its own bookkeeping, so any resume flips it on its own.

Detection trusts only the CLI's own error report (`isApiErrorMessage` / a `<synthetic>` assistant
turn / an errored terminal `result`), never model prose or tool output, so a session that merely
*discussed* rate limits is not listed. It is Claude-only: Codex, OpenCode and Hermes record an error,
but not in a form worth trusting, and a false claim here would be worse than a missing one. The judgment
lives in one place (`createLimitStopTracker` in `server/src/rate-limit-signal.ts`) and is shared with
the auto-resume monitor, so the badge and the resume queue cannot disagree.

### Why a thread is called what it is called

Every session row carries `title_source`: `custom` (a saved title the writing app displays), `ai`
(the model's own summary), `store` (the provider handed us one as a field), `envelope`, `message`
(the first thing said) or `id`. `envelope` is the one worth knowing about: the first turn arrived
wrapped in a pseudo-tag carrying a `name` attribute, `<scheduled-task name="nightly-sweep">`, and
that name became the title, so the string was chosen by whatever wrote the wrapper (a scheduler, a
hook, a harness) and may match nothing you have ever named. `title_tag` names that tag, and the web
UI prints it beside the title. This exists because threads turned up under a name their owner did
not recognise and there was no way to ask the app where the label had come from.

### Usage-check

`check_usage { account?, configDir? }` and `check_my_usage {}` let any MCP-speaking agent read an
account's remaining Claude subscription quota without asking a human. Pass `account` (a saved
dispatch account id or label) or `configDir` (a `CLAUDE_CONFIG_DIR` that's been `/login`'d once);
`check_my_usage` is a self-check that works out which account the calling process actually bills to.
Both report the session (5h) %, the weekly (all-models) %, and any per-model weekly %.

### Built-in guidance

The MCP `initialize` handshake returns an `instructions` block (`SERVER_INSTRUCTIONS` in
`server/src/mcp.ts`), which clients show the model once per session before any tool call, and every
usage or identity answer carries a one-line `nextStep`. Between them an agent gets AgentHydra's
operating rules (check your quota unprompted before heavy work, save state when `shouldOffload` is
true, gate a fan-out on current + projected cost, never quote an unattributed percentage) without a
human typing any of it. The handshake block is length-capped by a test, because it sits in context
for the whole session.

### Self-identification

`whoami {}` answers "which instance am I?" and shows its working: the permanent number, account
email, plan and rate-limit tier, plus a `confidence` (`exact` / `assumed` / `none`), the `method`
that won, the literal `clues`, and everything `ruledOut`. `check_my_usage` and a no-argument
`usage_budget` embed the same answer as an `identity` block, so a quota reading is never
unattributed.

It is not one env var. A Claude **CLI** instance sets `CLAUDE_CONFIG_DIR`; a Claude **Desktop**
instance sets none, because the account is chosen by the Electron host's `--user-data-dir`. So
detection layers `CODEX_HOME` → `CLAUDE_CONFIG_DIR` → `CLAUDE_CODE_EXECPATH` → the instance folder
holding this session's `claude-code-sessions` file → the parent `claude.exe`'s image path → the
Electron host's `--user-data-dir`, stopping at the first hit and only spawning a process scan when
everything cheaper came up empty. It runs in the MCP server process, never on the daemon, which
would faithfully identify the daemon. See [AI_USAGE_SELFCHECK.md](AI_USAGE_SELFCHECK.md) for the
three signals that look authoritative and are wrong.

**The weekly (all-models) % is the binding cap.** A fresh session % is a red herring when weekly is
near 100, and switching the flagship model doesn't dodge the shared weekly bucket. An agent should
check its own quota before a heavy multi-agent fan-out and pace accordingly, routing heavy work to
whichever account has the lowest weekly %.

## Claude Desktop session mapping

> **Moving a chat to another account?** Read
> [MOVING-CHATS-BETWEEN-ACCOUNTS.md](MOVING-CHATS-BETWEEN-ACCOUNTS.md) first. The store is keyed by
> `<accountUuid>/<orgUuid>`, so re-logging an instance orphans its chats where the new account
> cannot see them; migrate leaves a pointer in BOTH profiles; a session with no metadata entry can
> never be archived and shows as live forever; and a session tool's `send_message` silently steals
> a chat onto the caller's own account. Each of those produced a wrong result that looked correct.

Claude Desktop and the `claude` CLI write the same transcript store under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Desktop separately keeps per-chat metadata
under `<user-data-dir>/claude-code-sessions/<org>/<user>/local_*.json`; the metadata's
`cliSessionId` is the only reliable link to the shared transcript. The scanner in
`server/src/instance-sessions.ts` therefore:

- matches only by `cliSessionId`, never metadata filenames or titles;
- scans both `%APPDATA%/Claude/` and every `~/.claude-instances/<name>/` store; and
- treats Desktop activity timestamps as advisory because externally appended turns do not
  reliably update them.

Never use `claude://resume?session=<uuid>` to refresh a live chat. It is a one-way import for a
finished CLI session: it rewrites the shared transcript without thinking blocks and creates a
second Desktop chat. External dispatch can append valid turns to a Desktop-backed transcript, but
whether reopening an existing Desktop chat causes the renderer to request those turns is not a
stable interface and must not be assumed by product logic.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `7787` | preferred API/UI port (hops if busy) |
| `AGENTHYDRA_INSTANCE_PORT` | `PORT + 1` | preferred port for `--instances` quick mode (hops if busy; separate from the full daemon) |
| `HOST` | `127.0.0.1` | loopback bind host; only `127.0.0.1`, `localhost`, and `::1` are accepted because the local API is intentionally passwordless |
| `AGENTHYDRA_PORT_FIXED` | unset | `1` = bind `PORT` exactly, skip the single-instance/port-hop |
| `AGENTHYDRA_HOME` | `~/.agenthydra` | config dir (`runtime.json`, instance-identity cache) |
| `AGENTHYDRA_SHUTDOWN_TOKEN` | unset | if set, `/api/shutdown` requires a matching `x-agenthydra-shutdown-token` header (the tray sets it) |
| `AGENTHYDRA_FAKE` | unset | dispatch uses the harmless fake CLI |
| `AGENTHYDRA_DATA_DIR` | `~/.agenthydra/data` | state directory (sqlite db, run logs, caches) |
| `AGENTHYDRA_DB` | `~/.agenthydra/data/agenthydra.db` | sqlite path |
| `AGENTHYDRA_RUN_LOG_DIR` | `~/.agenthydra/data/run-logs` | detached-run log and sidecar directory |
| `AGENTHYDRA_CODEX_HOME` | `~/.codex` | default Codex rollout store to scan |
| `AGENTHYDRA_CODEX_PATH` | auto-detected / `codex` | Codex executable used by managed Codex instances |
| `AGENTHYDRA_CODEX_DESKTOP_PATH` | auto-detected | Codex Desktop GUI executable; useful for nonstandard installs |
| `AGENTHYDRA_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | OpenCode CLI/Desktop SQLite session store |
| `AGENTHYDRA_BOOT_DEADLINE_MS` | `120000` (full daemon) / `30000` (`--instances`) | startup-liveness watchdog deadline; if boot hasn't reached a bound port by then, the process logs its last-known phase and exits `87` for the supervisor to restart it (see `server/src/boot-watchdog.ts`) |

`/api/health` returns `service: "agenthydra"`, which is load-bearing for the single-instance
pointer. It also returns `dataDir`, `dbPath` and `dataDirNotice`, which answer "which database is
this daemon actually using" by looking rather than by inference.

**One state directory, both modes.** A source checkout used to keep its state in the repo's
`server/data` while a packaged build used `~/.agenthydra/data`, so `bun run start` and the
installed daemon were the same app reading two different sqlite files: settings, the run queue
and the done-mark ledger all diverged, silently, and forensics
run against the wrong one answered confidently and wrongly. Both modes now resolve to
`~/.agenthydra/data`, and a checkout's existing `server/data` is moved across on first run (by
copy when the two live on different volumes, which is the normal Windows layout). If BOTH already
hold state, nothing is moved or merged: the per-user directory is used and the other one is named
in the boot log and in `dataDirNotice`, because the only unrecoverable version of this problem is
the one nobody is told about.

**What the first real migration proved (2026-08-26).** A live fleet's state moved 33 MB from a
checkout on `D:` to a profile on `C:`, verified row-for-row afterwards: 22/22 done-marks, 27/27
monitor rows and 46/46 settings present at the destination, `dataDirNotice`
null. Two things only surfaced by running it rather than designing it. `renameSync` throws `EXDEV`
across volumes, and repo-on-`D:` with profile-on-`C:` is the *normal* Windows layout here, so a
rename-only migration would have silently never run for exactly the people who have the split. The
fallback copies and then deletes, in that order, so an interrupted migration leaves two copies
rather than none. And when both directories already hold real state there is no safe arbiter:
mtime inverts the moment someone runs the other mode once, so the code refuses to choose and says
so instead. Stop the daemon before moving anything: a copy taken while it holds the sqlite WAL is
not a copy of a consistent database.

Manually added dispatch API keys and OAuth tokens are stored as plain values in the per-user SQLite
database so the database remains portable. The state directories and database receive owner-only
POSIX modes where supported, and the daemon cannot bind beyond loopback. This protects the local
service boundary but is not a password vault: anyone who can read files as the same OS user can
read those manually supplied credentials.

## ChatGPT handoff

Enable **Settings → Providers → ChatGPT handoff** to add a ChatGPT action to the single-session
composer. It uses the composer task and effective working directory to create a Markdown
attachment, downloads it in the browser, copies a matching prompt, and opens
<https://chatgpt.com/>. AgentHydra never signs in, submits the prompt, uploads the attachment, or
reads the response.

The pack is capped at roughly 100,000 estimated tokens and 256 KiB per file. Git checkouts respect
standard Git ignore rules; non-Git directories use a bounded walk with common dependency/build and
credential directories excluded. Common secret filenames, private keys, and high-confidence token
patterns are omitted and reported as warnings. This is a guardrail, not a guarantee: review the
download before attaching private source code.

The endpoint is `POST /api/chatgpt/context-pack` with `{ "cwd": "...", "task": "..." }`; it is
available only while the provider toggle is enabled.

## Keeping the daemon alive

Everything that talks to AgentHydra talks to it over HTTP, so a daemon that is not running is not a
degraded fleet, it is a silent one: it stops answering rather than failing loudly, and each
automation just fails its own call until a person happens to notice.

Three scripts under `misc/` cover this, and the difference between them matters:

- **`Ensure-Daemon.ps1`** is a preflight. If a healthy daemon of ours answers, it does nothing and
  exits 0. Only when nothing of ours answers does it restart and then prove recovery. Call this
  before the first API call of any automation.
- **`Restart-Daemon.ps1`** is unconditional. Anything of ours dies, always, so a rebuild can never
  leave you on stale code. Never use it as a preflight.
- **`Wait-Daemon.ps1`** proves the daemon came up and *stayed* up, rather than answering once.

"Ours" is a hard question with a hard answer in all three: `/api/health` must return JSON with
`ok: true` and a `service` equal to this app's package name. Absence of identity is never identity,
which is what stops a Vite dev server on a neighbouring port from being adopted or murdered.

### The supervisor

`Install-DaemonSupervisor.ps1` registers a scheduled task that runs `Ensure-Daemon.ps1` every five
minutes and at logon:

```powershell
.\misc\Install-DaemonSupervisor.ps1            # install
.\misc\Install-DaemonSupervisor.ps1 -Status    # what is registered, and the last tick's result
.\misc\Install-DaemonSupervisor.ps1 -Uninstall # remove it
```

A stock Windows PowerShell prompt may refuse to run it at all ("running scripts is disabled on this
system"). That is the machine's execution policy stopping the INSTALLER, not a problem with the
task: run it from PowerShell 7 (`pwsh`), or as
`powershell -ExecutionPolicy Bypass -File .\misc\Install-DaemonSupervisor.ps1`. The scheduled task
itself is unaffected either way, because the tick already launches with `-ExecutionPolicy Bypass`.

It needs no elevation and stores no credentials: the task runs as the current user in their own
interactive session, which is also the only place a daemon can see and drive the desktop windows it
exists to manage. The action is `Supervisor-Tick.vbs` rather than `powershell.exe` directly, because
a task firing every five minutes forever must not flash a console window each time; the VBS runs it
hidden and forwards the real exit code, so Task Scheduler's Last Run Result answers "is the
supervisor actually keeping it up?" instead of always reading 0.

This exists because it did not. On 2026-08-30 a census of the machine running the fleet found no
scheduled task, no Startup shortcut and no Run key entry for this app; the live daemon's parent was
a bare `cmd /c bun server/src/index.ts` typed five hours earlier, with nothing above it. Every piece
needed to recover already existed and nothing ever called it.

## Auto-update

Opt-in background self-update (off by default; it restarts the daemon):

```
POST /api/update/settings   { "enabled": true, "intervalSecs": 21600 }
```

`intervalSecs` clamps to [900, 604800]; default 21600 (6h). Each tick checks the remote and, only if
the working tree is clean, applies (`git pull --ff-only` + reinstall + rebuild) and relaunches itself
on the same port (`AGENTHYDRA_RELAUNCH=1` makes the successor wait for the predecessor to free it).
A dirty tree is never touched.

Because updates are a `git pull --ff-only` against `origin/main`, **pushing `main` is the release**:
as soon as `main` moves, every instance with auto-update enabled fast-forwards to it on its next
check. Treat a push to `main` as user-facing rather than as a staging step.

## Instance appearance

Renaming an instance changes only its display label; it never renames the profile folder. Windows
can hold a running profile folder open, and the folder name is also the stable session/instance id.
The removed `POST /api/instances/:dir/rename` endpoint must not be restored as a live folder rename.

### The four names on an instance row

They are four independent sources, and a row can legitimately show a different one in each column.
Written down here because "where is this name coming from?" is otherwise unanswerable from the UI:

| Shown as | Source | Changes when |
|---|---|---|
| **Name** column | `label` from `instance-meta.json`, else the account's friendly name, else the folder basename (`web/src/lib/instance-appearance.ts` `displayName`) | you rename the instance |
| **Instance account** column | the local part of the account's email, one rule for every row (`accountHandle`) | the profile signs into a different account |
| the hover on that badge | the full email, plus the Anthropic profile display name (`full_name`) when the account has one | that account's profile is edited at Anthropic |
| profile **folder** | fixed by the name typed at creation (`server/src/core/lifecycle.ts`), sanitized | never |

The account column deliberately does **not** use `accountName`. That resolver returns `full_name`
when set and an email fragment when not, so the column rendered a mix: one row a person's name, the
next an email fragment, with nothing distinguishing them. `accountName` remains the right
choice for *naming* a row (`displayName`), where a friendly string is wanted and its provenance
does not matter.

Appearance metadata `{ label, icon, color }` lives in
`~/.agenthydra/instance-meta.json`, keyed by normalized folder path and cleaned up when the
instance is deleted. `POST /api/instances/:dir/meta` applies a present value, clears a field when it
is `null`, and leaves an absent field unchanged. The curated icon/color keys live in
`server/src/core/shared.ts`; the web mapping and deterministic defaults live in
`web/src/lib/instance-appearance.ts`.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vue 3 + Vite, a shared LunarWerx UI kit (shadcn-vue `reka-mira` on Reka UI), Tailwind v4, `@lucide/vue`, TypeScript |
| Backend | **Bun + Hono**, `bun:sqlite` (queue / dispatch / scheduler / accounts and read-only OpenCode/Hermes access) + JSON under `CONFIG_DIR`, SSE (`hono/streaming`) for live run output |
| Dispatch | `Bun.spawn` of the real `claude` CLI (no Agent SDK) |
| Multi-instance | per-OS Claude and Codex Desktop discovery / launch / focus / quit plus isolated Claude/Codex CLI homes (`server/src/core/*`); Windows DPAPI / macOS Keychain / Linux libsecret read Claude Desktop credentials |
| Launcher | Windows browser + system-tray (`misc/`) |

## Layout

```
server/        Bun + Hono daemon: sqlite, Claude/Codex/OpenCode/Hermes session readers, transcript tail,
               dispatch, scheduler, instance pointer, core/ (Claude + Codex Desktop/CLI instances)
web/           Vue 3 SPA (Sessions / Queue / Instances views)
orchestrator/  THE ORCHESTRATOR - the Python toolbox that decides what should happen to a chat
               (orch.py + scripts/), its own tests (scripts/tests/), and its remote front-end
               (orchestrator/server + orchestrator/web). Driven by the daemon through
               server/src/orchestrator.ts; its own manual is orchestrator/README.md
tests/         launcher.test.ts (the tray guard, Windows-gated) + server/instance unit tests
misc/          the Windows launcher toolkit (tray .ps1 / .vbs / .ico / Create-Shortcut / Make-Icon / Rebuild.bat)
scripts/       repo tooling (screenshots/: regenerate the README images)
```

## The orchestrator

Since 2026-09-03 the orchestrator is part of this repo again - as a **sibling folder, not a
rewrite**. `orchestrator/` is the v3 Python toolbox (stdlib only; one script per act, each with
its own rails and tests) that talks to this daemon over HTTP and decides what *should* happen
to a chat: the dry loop, the sweep's lanes, moving chats between accounts, archiving, naming,
the tray-icon switch. It was split out on 2026-08-31 so the daemon could never again act on a
chat by itself; folding it back in as a folder keeps that boundary (the scripts still only ever
talk to the daemon's API) while giving agents ONE surface, because the owner was tired of
explaining "you have to use both".

The daemon exposes it (`server/src/orchestrator.ts`):

| surface | what |
| --- | --- |
| `GET /api/orchestrator` | the toolbox's own menu, where it lives, whether python answers |
| `POST /api/orchestrator/run` `{script, args, timeoutMs}` | run one script by its menu name - exactly `python orch.py <script> <args>` in `orchestrator/`; stdout, stderr, exit code and what the driver's codes mean come back. Every run is also an OPERATION with an id (audit AH-09), because a 30-minute act used to lose its result to the daemon's 255-second idle timeout: send `X-Idempotency-Key` (or `idempotencyKey` in the body) and a retry after a dropped connection returns THE ORIGINAL operation instead of starting a second act, while `async: true` answers `202` with the id at once so a caller can poll instead of holding the connection open. A refusal that never ran does not pin the key |
| `GET /api/orchestrator/operations` · `GET /api/orchestrator/operations/:id` | what ran and what it returned, for an hour after it finished (bounded, in memory: this reconciles a dropped connection, it is not the audit log - the toolbox's own ledgers are that) |
| `POST /api/orchestrator/operations/:id/cancel` | stop a running operation; the child's whole process tree is killed and the outcome reads `cancelled` rather than failed. Same origin rule as `run` |
| MCP `orchestrator_menu` | the GET above |
| MCP `orchestrator_run` | the POST above |
| MCP `orchestrator_loop` | `loop` (dry by default; `live: true` acts) |
| MCP `orchestrator_switch` | the tray icon: `armed` (read) · `arm` · `arm_now` · `resume` · `pause` · `disarm` |
| MCP `move_chat` | `migrate_chat <chat> --to <n> --from <n> --stop-idle --now --idle-wait 330 --json` in one call: resolves `from`/`to` (number, name, label, email, `here`, `best`) before posting; the script does the fuzzy title match, the background-job scan behind `--now`, the verified landing and the bypass read-back |
| MCP `fan_out` / `fan_out_status` / `fan_out_send` | `fan_out --spec <json> --json` (+ `--per-account`, `--only`, `--exclude`, `--open-closed`, `--force`, `--dry-run`), `fan_out status [<group>] --json`, `fan_out send <group> --text ... --json`: ONE task list -> N visible desktop chats, one account each, tracked as a group (owner ask, 2026-09-04). The MCP tool turns `{cwd, prompt, title?}` tasks into the spec (a temp file when it would exceed the 4000-character arg limit), resolves `only`/`exclude` refs to instance numbers, and excludes the CALLING chat's own account by default (`exclude_self: false` to allow it; only on an exact identity). The script ranks accounts by real room (balance.py's fill ceiling minus peak; unknown is never room), open instances first, spawns each chat through `spawn_chat.py` ONE AT A TIME (two lanes driving two windows at once is how text lands in the wrong pane), refuses a task whose prompt already runs in the fleet while letting one spec share a prompt across its own tasks, reports an unassigned task rather than dropping it, and keeps the group in `orchestrator/state/fanouts.json`. `status` reads each member's gate verdict + last words; `send` stops each member's IDLE engine first (the peer pipe does not steer a chat nobody has clicked - measured on the first drill) and lets the daemon's message route boot it through the app's composer, holds respected; `delete` (MCP `fan_out_delete`) runs `delete_chat.py` on every member - the cleanup a probe fan-out owes (owner rule, 2026-09-04: a ping or account-identification chat is never left in the account). Deleting a chat IN THE APP is not that: the app drops its record and leaves the transcript plus a `<sid>.desktop-released.json` marker, so `orchestrator_run delete_chat --released` lists those leftovers and `--yes` removes them, each with an undo copy. None of them needs the tray icon: a person asked. `add_queue_item` and `launch_terminal_session` are refused on this machine (no-headless law) and now say so in their descriptions |

The script name is validated against the menu grammar and the arguments travel as an argv
array - no shell in the path. Every rule stays in the scripts: **nothing acts without the tray
icon** (`orchestrator_switch {action:"armed"}` first; a disarmed fleet looks exactly like a
quiet one), a live chat is never moved or archived, every attempt is counted, and `--force` is
a person's word for one act. `AGENTHYDRA_ORCHESTRATOR_DIR` points the daemon at a toolbox
somewhere else; `AGENTHYDRA_PYTHON` names the interpreter (default `python` on Windows,
`python3` elsewhere; the spawn forces UTF-8 output and normalises CRLF). Its own tests: `bun run
test:orchestrator` (~650 unit tests, stub daemon, no fleet needed).

In a compiled release the python half (`orch.py`, `scripts/`, `docs/`) is staged beside the
executable as `orchestrator/`, which is exactly where `APP_ROOT/orchestrator` resolves; the
remote front-end (`orchestrator/server` + `web`) needs bun and is source-checkout only. Python
is not bundled - `GET /api/orchestrator` reports whether it answers. A machine that ran the
standalone checkout has a one-time cut-over (scheduled tasks, tray shortcut, `state/`):
orchestrator/README.md, "Moving a machine off the standalone checkout".

## Screenshots

The three README images are generated, not hand-taken:

```
bun run screenshots                 # shoot and install into .github/screenshots/
bun run screenshots -- --keep       # write to tmp/screenshots/ instead, to eyeball first
bun run screenshots -- --url <url>  # reuse a server you already have running
```

It starts its own web server on a private port (5199, so an open dev session on 5173 is neither
disturbed nor photographed), drives headless Chrome over the DevTools protocol, and writes one PNG
per view at a viewport sized to that view's max-width shell.

**Nothing real is ever in frame.** These images are public, so instead of pointing a daemon at a
synthetic home directory, `scripts/screenshots/page-fixtures.js` replaces `window.fetch` before the
SPA boots: every `/api/` response is invented and no daemon runs at all. Any request that finds no
fixture is recorded, and the run **fails** rather than keeping images that could contain live data.
Adding a shot means adding an entry to `SHOTS` in `capture.mjs`; each one carries an `expect`
predicate that must hold before the shutter fires, so a fixture that stops matching the UI fails
the run instead of silently producing a screenshot of empty skeletons.

Requires a Chromium-based browser; set `CHROME_PATH` if it is not in a standard location.

## Checks

`bun run check` runs Biome + the i18n gate + a kit drift-check. The kit check needs an internal
LunarWerx kit checkout, so it's **owner-only and skipped in CI**; external contributors should run
the individual checks instead:

- `bun run lint`: Biome.
- `bun run --cwd web check:i18n`: no hardcoded UI strings; every `t()` key resolves (also gates `build`).
- `bun test`: includes the Windows-gated tray launcher guard and instance/crypto tests.
- `bun run typecheck`: web (`vue-tsc`) + server (`tsc`).

`bun run check:local` is the owner-only half on its own: today it is just `check:kit`, split out under a
name a pre-push runner can look for. It exists because the kit check is the one gate CI *structurally*
cannot run, comparing this app's synced copies against a private sibling repo that a public repo's
workflow can never check out. Before it had a name, a pre-commit hook was its only enforcement, and
that hook is skipped by `--no-verify` and silently does nothing on any machine without the sibling
checkout. External contributors should not run it; nothing in CI depends on it.

CI runs these across `[ubuntu-latest, windows-latest]`, so a green local run on one OS clears one
leg of two.

### A flake that only exists inside a full-suite run

`bun test` runs the whole suite in one process, so state that a single-file run never accumulates
(caches keyed to wall-clock granularity, shared temp dirs, module-level singletons) is reachable
only there. The OpenCode reader's session cache was one: a write landing inside the same filesystem
timestamp tick as a previous read could be cached away, which requires that preceding read in the
same process to happen at all. Two rules came out of chasing it:

- **An isolation run proves nothing about a flake that only fires in the full suite.** Re-run the
  whole suite, enough times that luck is implausible: 15 consecutive green runs against a reported
  ~1-in-3 failure rate is roughly a 0.2% chance of coincidence.
- **Anything keyed on mtime alone needs a tiebreaker** (size, or an explicit generation counter),
  because two writes can share one tick and the second one then looks like no write at all.

### Repo guardrails (`scripts/checks/`)

Custom checks, each a standalone `bun scripts/checks/<name>.mjs` run as its own CI step, and each
written from a bug that actually shipped. Node stdlib only, no install. Their headers carry the
incident; `tests/guardrails.test.ts` proves every one of them still fires on the broken shape and
stays quiet on the fixed one, so none can rot into a silent no-op.

- `reka-popper-root-inside-tooltip.mjs`: a popper root (DropdownMenu, Popover) wrapped AROUND an
  `IconTooltip` steals the anchor, so the real content opens off-screen and, when modal, freezes
  pointer events.
- `wmi-commandline-query-self-match.mjs`: a `CommandLine LIKE` query that forgets to exclude the
  shell running it matches itself and answers "found" forever.
- `kit-lib-type-drift.mjs`: a vendored kit lib whose `.mjs` and hand-written `.d.mts` disagree,
  which is either a compile error on import or `undefined` at runtime.
- `spawn-console-window.mjs`: `windowsHide` missing on a console spawn (a stray console window) or
  present on a GUI one (the window never appears).
- `spawn-test-without-timeout.mjs`: a test **or lifecycle hook** that reaches a subprocess while
  inheriting bun's 5s default. Such a case times the runner, not itself, and a cold windows-latest
  box runs this class ~10x slower than a dev machine. A repo-wide `bun test --timeout N` stands the
  check down, which is the better answer for a suite where nearly everything spawns.
