# Releasing

## Pushing `main` is the release

Auto-update (see the README's Auto-update section) applies each update as a `git pull --ff-only`
against `origin/main`. There is no separate publish step for that path: as soon as `main` moves,
every instance with auto-update enabled will fast-forward to it on its next check. Treat a push to
`main` as user-facing, not as a staging step.

## Recipe

1. **Bump the version.** Update `version` in `package.json`.
2. **Update the changelog.** Move the relevant `[Unreleased]` entries in `CHANGELOG.md` into a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, following the existing Keep a Changelog format already used
   in that file.
3. **Run local CI before pushing.** `.github/workflows/ci.yml` is the authoritative list; the
   commands below are a convenience copy and the workflow wins if the two ever disagree. Check
   the workflow rather than trusting this line when a step has been added recently.
   `bun install --frozen-lockfile`, `bun run typecheck`, `bun run check`, `bun run build`,
   `bun test`, `bun run dist`, and `bun run scripts/smoke-release.ts dist/AgentHydra.exe`.
   Don't rely on pushing to find out one of these fails.

   Maintainers: also `bun run check:local`, which CI cannot run at all (see REFERENCE.md).

   A local pass is one leg of a two-leg matrix. CI runs `[ubuntu-latest, windows-latest]`, so a
   green run on Windows says nothing about Linux. Anything OS-shaped (path handling, filesystem
   watching, process spawning, line endings) needs a real runner before you call it verified.
4. **Commit** the version bump and changelog update.
5. **Push `main`, then wait for CI to go green.** Not the same step as tagging, deliberately: this
   push is the release (see above), so it is the last point at which a red run is still cheap.
   ```sh
   git push origin main
   gh run watch          # or: gh run list --limit 2
   ```
6. **Tag only once `main` is green:**
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
   `git push --follow-tags` bundles both into one command, which is how v0.7.0 shipped to
   auto-update instances before anyone had looked at CI; it then failed the ubuntu leg on a
   win32-only path assertion. Prefer the two steps.

   **Name the tag in the push. Never `git push --tags`.** It pushes every local tag the remote is
   missing, not the one just created, and a `v*` tag is a release trigger. Releasing 0.19.3 that way
   also pushed a stale local `v0.8.0` and started a real Release build for a months-old commit; it
   was cancelled while still queued (`gh run cancel <id>`, then `git push --delete origin v0.8.0`),
   so nothing published. A minute later it would have been a public 0.8.0 sitting above 0.19.2 in
   the list that auto-update clients read. These trees accumulate stale local tags precisely because
   releases are normally pushed one at a time, so `--tags` looks harmless right up until it isn't.

   **If a tag does end up on a red commit,** do not move a published tag. Fix the failure, bump to
   the next patch version, and release that immutable version instead.

## The install script depends on SHA256SUMS.txt

`install.ps1` (repo root) is the documented one-liner install for Windows. It downloads the
`AgentHydra-<version>-windows-x64.zip` asset, downloads `SHA256SUMS.txt` from the SAME release, and
refuses to install on a mismatch or a missing entry. There is no skip switch, on purpose.

That makes the checksum file a **release contract, not a nicety**: the `Build checksums` step in
`release.yml` (`sha256sum out/* > out/SHA256SUMS.txt`) and its inclusion in the upload list must
both survive any edit to the release job. Drop either one and the installer stops working for
everyone on the next release, with a refusal rather than a silent downgrade in safety, which is the
right failure, but still a broken install path.

Two shapes to keep intact if the workflow is ever restructured:

* The ZIP is what gets installed, not the bare `.exe`. Only the ZIP carries `misc/` (the tray
  toolkit); a bundle without it can only run console-style, which is exactly the regression 0.11.2
  shipped.
* `sha256sum` writes `<hash>  out/<name>`, so the path field carries the `out/` prefix. The
  installer matches on the file's LEAF name for that reason; moving the build output to another
  directory is fine, renaming the assets is not.

## When a push doesn't trigger anything

GitHub's standard mitigation for an Actions incident is to **throttle webhook triggers**, which
fails in the most confusing possible way: `git push` succeeds, the commit and the tag are really on
`origin`, and no workflow run is ever created. Nothing is red; there is simply nothing. Both steps 5
and 6 above silently stall, because both wait on a run that will never exist.

Check <https://www.githubstatus.com/api/v2/components.json> for the `Actions` component before
assuming it's your fault:

```sh
curl -s https://www.githubstatus.com/api/v2/components.json | grep -A2 '"name": "Actions"'
```

`workflow_dispatch` is NOT throttled with the webhooks, so it is the way through. Both workflows
accept it:

```sh
gh workflow run ci.yml --ref main          # step 5's green gate
gh workflow run release.yml --ref vX.Y.Z   # step 6's publish
```

Dispatching `release.yml` **against the tag ref** is the important part. The publish job gates on
`github.ref_type == 'tag'`, not on the event that started the run, so a dispatch on a tag publishes
a real release exactly as a tag push would; a dispatch on a branch runs build + smoke and publishes
nothing. This is how v0.16.0 and v0.16.1 actually shipped on 2026-08-06.

Do NOT try to force the webhook by deleting and re-pushing the tag. Re-pushing an identical tag is
still a published tag moving, the failure mode this file warns about at the end of step 6, and it
buys nothing a dispatch doesn't already give you.

## What the tag push triggers

Pushing a tag matching `v*.*.*` triggers `.github/workflows/release.yml`. It builds one
self-contained executable for every supported OS (Windows x64, Linux x64/arm64, macOS x64/arm64),
boots every platform bundle **except darwin-x64**, verifies the health endpoint and an embedded
frontend asset, then publishes the GitHub Release automatically from the matching changelog
section. Windows exposes a direct icon-bearing GUI executable for people plus a one-executable ZIP
for the updater; Unix targets expose one-executable archives. `SHA256SUMS.txt` covers every asset.
`workflow_dispatch` runs the same build and smoke matrix without publishing a release.

**darwin-x64 (Intel mac) is build-only.** GitHub retired its Intel macOS runners, so the smoke job
has no honest way to boot that target: it is compiled and archived like every other target, but
never booted, and every other smoke assertion (tray inventory, orchestrator inventory,
`/api/health`) skips it too. This is a documented, deliberate gap until a native or self-hosted
Intel-mac runner exists, not a silent one.

## The orchestrator rides in the bundle (since 2026-09-03)

`orchestrator/` is the Python toolbox that decides what should happen to a chat (see
REFERENCE.md, "The orchestrator"). The release job stages its python half - `orch.py`,
`scripts/`, `docs/` - beside the executable as `orchestrator/`, which is where a compiled daemon
looks for it (`APP_ROOT/orchestrator`). Not staged: `state/` (runtime), `scripts/tests/`, and the
remote front-end (`orchestrator/server` + `orchestrator/web`), which need bun and are a source
checkout's business. Python 3 is the user's own; the daemon does not bundle it, and
`GET /api/orchestrator` reports whether it answers. `misc/Rebuild.bat` is unaffected: it rebuilds
the daemon's own SPA, and the orchestrator's web dashboard is built separately with
`bun run --cwd orchestrator remote:build`.

**The smoke job asserts this inventory (AH-27), on every booted target.** Before boot, an "Assert
orchestrator payload" step unpacks the archive and checks: `orchestrator/orch.py` and
`orchestrator/scripts/lib/hydralib.py` are present, at least one `orchestrator/scripts/*.py` tool
exists, and none of `orchestrator/scripts/tests/`, any `__pycache__/` under `orchestrator/`, or a
non-empty `orchestrator/state/` made it into the archive. Without this, an archive that silently
lost `orchestrator/` would still pass every other smoke check (boot, `/api/health`, the SPA);
the daemon reports the tools unavailable rather than failing to start, so nothing else here would
ever notice.
