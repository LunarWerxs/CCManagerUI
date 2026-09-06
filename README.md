<div align="center">

<img alt="AgentHydra. Every local AI coding session, in one tab: many heads, one dashboard" src=".github/og-image.png" width="820" />

### Every local AI session, plus your isolated Claude and Codex instances

[**Website**](https://agenthydra.lunarwerx.com) &nbsp;·&nbsp; [Download](https://github.com/LunarWerxs/AgentHydra/releases) &nbsp;·&nbsp; [Reference](docs/REFERENCE.md) &nbsp;·&nbsp; [Changelog](CHANGELOG.md)

[![Website](https://img.shields.io/badge/website-agenthydra.lunarwerx.com-c15f3c?style=flat-square)](https://agenthydra.lunarwerx.com)
[![CI](https://img.shields.io/github/actions/workflow/status/LunarWerxs/AgentHydra/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/LunarWerxs/AgentHydra/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LunarWerxs/AgentHydra?style=flat-square&color=c15f3c)](https://github.com/LunarWerxs/AgentHydra/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-c15f3c?style=flat-square)](LICENSE)

</div>

---

> ### CC Manager UI is now AgentHydra
>
> The name stopped being true. It manages Claude, Codex and OpenCode now, not just Claude Code, so
> it is named for the many-headed thing it actually is. Nothing about your install changes:
>
> - **Update normally.** GitHub redirects the old repo URL, so existing clones, remotes and the
>   built-in updater keep working without you touching anything.
> - **Your data comes with you.** `~/.ccmanagerui` is moved to `~/.agenthydra` on first run, with
>   the queue, settings, instance names and accounts cache intact. If the move cannot happen, the
>   app keeps reading the old folder rather than starting empty.
> - **Old env vars still work.** Every `CCMANAGERUI_*` variable is still read as a fallback for its
>   `AGENTHYDRA_*` replacement.
> - **What you should update at your leisure:** desktop shortcuts pointing at `CCManagerUI.exe`, and
>   any MCP config naming the old binary. Both are one-line changes.

If you run AI tools in more than one place (a couple of isolated Claude Desktop instances on
different accounts, Claude Code and Codex terminals across repos, or OpenCode CLI/Desktop), nothing
shows all of that local history at once. You alt-tab to remember which account is which, whether a
session is still going, and what you asked it to do.

AgentHydra is a local dashboard for AI coding agents that brings your Claude Code, Codex, and
OpenCode session history into one browser tab, lets you queue and schedule Claude Code runs, tracks
cost and usage across models and projects, and manages isolated Claude Desktop and Codex Desktop
accounts, all without a cloud service or account signup. It is not a Claude client and does not
replace one: it is the dashboard the CLI and the desktop app do not come with.

## Every session, in one list

![The sessions view: a searchable list on the left holding Claude, Codex and OpenCode transcripts together, each badged with the tool that wrote it, one open on the right with a message box at the bottom](.github/screenshots/sessions.png)

<sub>Screenshots use demo data.</sub>

Claude Code, Codex, and OpenCode conversations on your machine appear together, newest first.
Filter by provider or recency; Claude sessions can also be filtered by project or Desktop instance.
Click one to read the conversation and live-tail it while it runs. Codex is read from its rollout
JSONL files, while OpenCode CLI and Desktop share the same local SQLite session store.

For Claude sessions, the box at the bottom lets you type straight back into a session without
finding its terminal. Pick several Claude sessions and you can send the same message to all of
them. Codex and OpenCode support is read-only.

An optional **ChatGPT handoff** in that composer turns the task and repository into a bounded
Markdown context file, copies a ready-to-paste prompt, and opens ChatGPT. AgentHydra omits common
secret files and likely credentials; you still review the attachment and submit it yourself.

When you want a raw Claude or Codex file, there is a button for opening the `.jsonl` in your editor,
downloading it under its real title, or copying it out. OpenCode conversations are rendered from its
database rather than exposed as a raw file.

## Reply, fan out, or move a session, never headless

AgentHydra does not run a `claude` chat you cannot see. There is no headless queue or scheduler:
every run happens in a real desktop app window, on purpose, so nothing is ever working away in a
process with no chat for you to open. Three things actually work today:

- **Reply straight into a session's own desktop chat.** The composer at the bottom of a session
  types your message into that chat's own app window (the same delivery `fan_out_send` uses over
  MCP) and confirms it landed by watching the transcript grow. A busy chat refuses honestly instead
  of pretending to queue behind it.
- **Fan a task list out across your other signed-in accounts** with the MCP `fan_out` tool, one
  visible chat per account, then steer the whole group with `fan_out_send`.
- **Import a session into a desktop app** so it becomes a real chat you can continue by hand.

The **run queue** view still exists as a record of past runs: every historical item, its prompt,
model, exit code and live output, stays inspectable and editable, but creating or dispatching a
new one is refused by policy. There is nothing here you can turn back on. If you're looking for the
"queue a run for 3am" feature an earlier version of this README described, it has been removed, not
hidden; the screenshot below is historical.

![The run queue drawer, from before headless dispatch was removed: five runs, one running, three queued and one finished, each showing its project, model, effort and scheduled time](.github/screenshots/queue.png)

## See where the time and the money went

![The analytics view: headline cost, session and agent-hour tiles above a cost-by-day bar chart, cost broken down by model, project and account, and an hour-of-week grid showing when the work happens](.github/screenshots/analytics.png)

Cost by day, by model, by project, and by the account that ran it. When in the week you actually
work. How many sessions were going at once. Which tools get used, which files changed recently, and
which sessions are worth a second look because a tool kept failing or the context was compacted.

All of it comes from totals worked out while the session list is being built, so it costs about half
a megabyte for a store of 1,400 sessions and no message text is kept. Costs are published list
prices: a subscription plan is not billed per token, so read them as what the same work would cost
on the API. `AgentHydra.exe --spend --json` prints the same numbers for a script.

## Manage isolated instances

![The instances view: four isolated Claude Desktop instances, each with its account, plan, remaining weekly quota, live memory and uptime](.github/screenshots/instances.png)

If you keep separate Claude Desktop instances for separate accounts, this is where they live. Each
row shows which account it is signed into, its plan, and, while it is running, its process, memory
and uptime.

You can open, focus, quit, create and delete them from here, give each one a name, an icon and a
colour so they stop looking identical, and see your isolated CLI logins alongside the desktop
instance that shares their account.

The same view manages Codex Desktop and CLI together. Each Codex instance gets its own `CODEX_HOME`
and desktop profile, so work and personal OpenAI logins can run in separate Codex windows. Open,
focus and quit the desktop from its row; CLI Launch and Log in actions use that same isolated login.

### Quick instance mode

When you only need to pick an instance and start it, instance mode skips the session scanner,
database, queue recovery, scheduler, monitor, usage refresh, settings sync and updater. It opens a
compact portable window with Claude Desktop, Claude CLI and Codex start/focus/stop controls.

- Packaged build: run `AgentHydra.exe --instances`.
- Source checkout: run `bun run instances` (after the normal one-time `bun run build`).
- Windows shortcut: run `misc\Create-Shortcut.ps1` once, then open
  **AgentHydra Instances** from the repository root.
- Or add the same one-click launcher from **Settings → Appearance → Quick Instances shortcut**.

The quick daemon uses its own port and runtime pointer, so the full manager can open later without
conflict. If the full manager is already running, the launcher reuses it. Closing the quick window
retires its lightweight daemon automatically after a short reconnect grace period.

## How it compares

Most tools in this space either read what your AI CLIs have already done, or spin up new isolated
sessions for you to run. AgentHydra is the first kind.

**[Claude Squad](https://github.com/smtg-ai/claude-squad)** and **[Conductor](https://www.conductor.build)**
both launch new Claude Code (and Codex) sessions for you, each in its own git worktree so tasks do
not collide: Claude Squad in a terminal TUI, Conductor in a macOS-only app. AgentHydra does not
create worktrees, and by default it starts nothing on its own; it reads the Claude Code, Codex, and
OpenCode session history, queue, and account state your existing setup already writes, then adds a
run queue with a
scheduler, cost and usage analytics, and multi-account instance management on top, from a browser
tab on Windows, macOS, or Linux.

Claude Code's own [worktree support](https://code.claude.com/docs/en/worktrees) covers running
several sessions from one repo without any extra tool. AgentHydra sits a layer above that: it shows
every session across every project and provider at once, however you started it.

If what you want is an editor with AI built in, AgentHydra is not that either. Cursor and Windsurf
are IDEs; AgentHydra is a dashboard over the CLIs and desktop apps you already have.

## Install

**On Windows, one line.** It installs under `%LOCALAPPDATA%` (no Administrator), and it verifies the
download against the release's published SHA-256 before unpacking anything, with no way to skip
that step, because a checksum you can opt out of is decoration:

```powershell
irm https://raw.githubusercontent.com/LunarWerxs/AgentHydra/main/install.ps1 | iex
```

It takes the ZIP, so you get the tray icon, and it makes a Start Menu shortcut. Read the script
first if you like; that is a reasonable thing to do with any `irm … | iex`.

**Or download** your OS build from [Releases](https://github.com/LunarWerxs/AgentHydra/releases).
On Windows, run the versioned `AgentHydra-…-windows-x64.exe` directly; it is an icon-bearing GUI
executable with the web app embedded and no console window. Linux and macOS builds remain
one-executable archives. No Bun is needed.

**Want the system-tray icon?** Take the Windows ZIP instead of the bare `.exe`. The icon comes from a
small separate launcher (`misc\lunarwerx-tray.exe`) that ships in the ZIP's `misc\` folder, and the
daemon starts it for you when it finds it there and nothing else has, so double-clicking
`AgentHydra.exe` out of the ZIP gets you the icon too. `misc\Create-Shortcut.ps1` still makes a
proper shortcut that launches through the tray host directly, and the installer above creates that
same shortcut in the Start Menu. The single-file `.exe` has no `misc\`, so it can never show one, and
says so once when it starts. The ZIP doubles as the automatic-update transport.

**Or from source**, with [Bun](https://bun.sh):

```sh
git clone https://github.com/LunarWerxs/AgentHydra.git
cd AgentHydra && bun install
bun run build && bun run start
```

Either way the UI is at <http://localhost:7787>.

> **Just trying it?** Set `AGENTHYDRA_FAKE=1` and dispatch uses a harmless stand-in for the `claude`
> CLI, so nothing touches your quota or your repos. The scheduler is off by default. Note that
> instance actions (open / quit / create / delete) act on **real** Claude Desktop instances; delete
> asks you to type the name.

There is no cloud service behind this and no account to sign up for. It reads the local stores
your tools already write and talks to `localhost`; optional external handoffs open the provider
and leave the final upload to you.

**Update check.** The one thing that does leave your machine on its own is the periodic check for
a new release, against `studio.connections.icu` (a LunarWerx relay that mirrors GitHub's release
feed). It sends the app version, a coarse OS tag (e.g. `win11-26100`), and a random per-install id,
enough to count installs and see version/OS adoption. From that request, the server also derives and stores a coarse location (country, region, city,
timezone), your network's ASN, locale, and a truncated user agent, but never an IP address. It
never sends a hostname, username, file path, account, or email. Set `AGENTHYDRA_NO_PING=1` to opt
out; the update check then goes straight to GitHub's API instead, carrying no install id or
telemetry.

## Requirements

- **[Bun](https://bun.sh)** if running from source.
- The **`claude` CLI** for dispatch, and/or **Claude Desktop** for Claude instance management.
- Optional: **Codex Desktop/CLI** for isolated Codex windows, CLI launch/login, and local rollout
  history; **OpenCode** for local OpenCode history. Their sessions appear automatically when their
  standard local stores exist.
- **Windows** for the tray launcher. macOS and Linux builds exist and the instance-account code is
  written for them, but they are not verified there yet.
- **Windows instance management needs the classic Claude Desktop build** (the ~217 MB Squirrel
  `.exe` installer). The newer MSIX package cannot be launched with an isolated profile. The
  Instances tab detects this and links the right installer.

## For agents

The whole API is exposed over MCP, so any MCP-speaking client can inspect sessions and drive the
Claude queue, scheduler, and instance managers directly. Setup and the full tool list are in
[docs/REFERENCE.md](docs/REFERENCE.md).

Agents can also work out **which** of your accounts they are running as (`whoami`) and read that
account's remaining quota before fanning out work, which is the difference between pacing a big job
and hitting a wall halfway through it: [docs/AI_USAGE_SELFCHECK.md](docs/AI_USAGE_SELFCHECK.md).

The **orchestrator** - the part that decides what *should* happen to a chat (the dry loop, the
sweep, moving chats between accounts, archiving, naming, the tray-icon switch) - lives in this repo
under [`orchestrator/`](orchestrator/README.md) and is driven through the same MCP server
(`orchestrator_menu`, `orchestrator_run`, `orchestrator_loop`, `orchestrator_switch`), so an agent
never has to be told there is a second program. Nothing there acts unless the tray icon is up.

## More

[Reference](docs/REFERENCE.md) covers configuration, the MCP tools, auto-update, the stack, the repo
layout and how to run the checks.

## FAQ

**Is AgentHydra free?**
Yes. It is open source under the MIT license, free to download and run, with no account or
subscription for AgentHydra itself. You still need your own Claude Code, Codex, or OpenCode setup,
since AgentHydra manages sessions for those tools rather than providing the underlying AI.

**Does it work offline?**
Mostly. AgentHydra runs as a local daemon reading session data already on your machine, with no
cloud service and nothing to sign up for. The one thing that reaches out on its own is a periodic
update check; set `AGENTHYDRA_NO_PING=1` and that check goes straight to GitHub's API instead.

**Is my data sent anywhere?**
No session content leaves your machine. The periodic update check sends the app version, a coarse
OS tag, and a random per-install id, never a hostname, username, file path, account, or email. The
server derives an approximate location and network ASN from that request. `AGENTHYDRA_NO_PING=1`
turns it off.

**What are the system requirements?**
Bun is only needed if you run from source; packaged builds need nothing extra. You need the `claude`
CLI and/or Claude Desktop for Claude features, with Codex Desktop/CLI and OpenCode optional. The
tray launcher and full Windows instance management need the classic Squirrel-installer build of
Claude Desktop, not the newer MSIX package.

**How is it different from Claude Squad or Conductor?**
Claude Squad and Conductor both start new, isolated Claude Code (and Codex) sessions in fresh git
worktrees. AgentHydra creates no worktrees, and out of the box it starts nothing by
itself: it reads the history, queue, and account state your existing Claude Code, Codex, and
OpenCode setup already writes, and adds a scheduler, cost analytics, and instance management on
top. See [How it compares](#how-it-compares).

**Which AI tools does it support?**
Claude Code, Codex, and OpenCode sessions are read directly and shown together in the session list.
Queueing runs, composing replies, the scheduler, and rate-limit auto-resume are Claude-only; Codex
and OpenCode are read-only. Claude Desktop and Codex Desktop instances are managed separately from
the Instances view.

**Can I try it without risking my Claude quota?**
Yes. Set `AGENTHYDRA_FAKE=1` and dispatch uses a harmless stand-in for the `claude` CLI, so nothing
touches your quota or your repos. The scheduler stays off by default either way. Note that instance
actions (open, quit, create, delete) still act on real Claude Desktop instances.

Made by [LunarWerx Studios](https://lunarwerx.com). Also see
[RepoYeti](https://repoyeti.com), [DevWebUI](https://devwebui.lunarwerx.com), and
[SageThumbs](https://sagethumbs.lunarwerx.com).

## License

[MIT](LICENSE).
