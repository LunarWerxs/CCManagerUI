/**
 * Shared self-update engine for the LunarWerx daemons. Checks the app's configured
 * update remote for a newer commit and (on request) fast-forward-pulls + reinstalls +
 * rebuilds, returning a step-by-step transcript. The git/spawn/parse plumbing was
 * duplicated near-verbatim across the apps, this is the one copy, parameterised by:
 *
 *   appRoot           the checkout root (each app resolves its own import.meta path)
 *   serviceName       the `service` field on UpdateStatus (e.g. "repoyeti")
 *   appLabel          display name used in the apply messages (e.g. "RepoYeti")
 *   updateRepoEnvVar  env var that overrides the update remote (e.g. REPOYETI_UPDATE_REPO)
 *   installCmd        install step, e.g. ["bun", "install"]
 *   buildCmd          build step, e.g. ["bun", "run", "--cwd", "web", "build"]
 *
 * runtime-agnostic (Bun + Node): node:child_process spawn runs in both. Part of the
 * shared kit, keep it app-agnostic.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const CHECK_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 240_000;

export function createUpdater({ appRoot, serviceName, appLabel, updateRepoEnvVar, installCmd, buildCmd }) {
  function packageVersion() {
    try {
      const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
      return pkg.version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  // On Windows, package-manager launchers (npm/yarn/pnpm) are `.cmd` shims that CreateProcess
  // can't execute directly, so a bare spawn throws ENOENT, while git/node/bun are real `.exe`
  // and resolve fine. So spawn raw first (git/bun keep their exact behavior and no shell-escaping
  // deprecation fires) and retry once through a shell only when the raw spawn ENOENTs on Windows,
  // which is exactly the `.cmd`-shim case. Every arg here is a fixed literal or a git URL (no
  // spaces or shell metacharacters), so the shell's arg concatenation is safe.
  function runCommand(args, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const attempt = (useShell) => {
        const child = spawn(args[0], args.slice(1), {
          cwd: appRoot,
          windowsHide: true,
          shell: useShell,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let superseded = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          // `error` fires before this attempt's `close`; flag it so that trailing `close`
          // is ignored while we retry the `.cmd` shim through a shell.
          if (err.code === "ENOENT" && !useShell && process.platform === "win32") {
            superseded = true;
            attempt(true);
            return;
          }
          finish({ ok: false, code: null, stdout, stderr: stderr || err.message, timedOut });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (superseded) return;
          finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
        });
      };
      attempt(false);
    });
  }

  const git = (args, timeoutMs = CHECK_TIMEOUT_MS) => runCommand(["git", ...args], timeoutMs);
  async function gitText(args, timeoutMs = CHECK_TIMEOUT_MS) {
    const r = await git(args, timeoutMs);
    return r.ok ? r.stdout.trim() : null;
  }

  function parseRemoteHead(stdout) {
    return {
      branch: stdout.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1] ?? null,
      commit: stdout.match(/^([0-9a-f]{40})\s+HEAD$/m)?.[1] ?? null,
    };
  }
  function parseLsRemoteCommit(stdout) {
    return stdout.match(/^([0-9a-f]{40})\s+/m)?.[1] ?? null;
  }

  async function currentUpstream() {
    const upstream = await gitText(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (!upstream) return { upstream: null, remoteName: null, remoteBranch: null };
    const slash = upstream.indexOf("/");
    if (slash <= 0) return { upstream, remoteName: null, remoteBranch: null };
    return { upstream, remoteName: upstream.slice(0, slash), remoteBranch: upstream.slice(slash + 1) };
  }

  async function remoteForCheck(remoteName) {
    const configured = process.env[updateRepoEnvVar]?.trim();
    if (configured) return { remote: configured, remoteArg: configured };
    const name = remoteName || "origin";
    const url = await gitText(["remote", "get-url", name]);
    return url ? { remote: url, remoteArg: name } : { remote: null, remoteArg: null };
  }

  async function checkForUpdate() {
    const base = {
      ok: true,
      service: serviceName,
      currentVersion: packageVersion(),
      currentCommit: null,
      remoteCommit: null,
      branch: null,
      upstream: null,
      remote: null,
      dirty: false,
      updateAvailable: false,
      canApply: false,
      checkedAt: Date.now(),
      reason: null,
    };

    if (!existsSync(join(appRoot, ".git"))) return { ...base, ok: false, reason: "not a git checkout" };
    if ((await gitText(["rev-parse", "--is-inside-work-tree"])) !== "true")
      return { ...base, ok: false, reason: "not a git checkout" };

    const currentCommit = await gitText(["rev-parse", "HEAD"]);
    const branch = await gitText(["branch", "--show-current"]);
    const upstream = await currentUpstream();
    const remote = await remoteForCheck(upstream.remoteName);
    const dirty = !!(await gitText(["status", "--porcelain"]));
    const status = { ...base, currentCommit, branch, upstream: upstream.upstream, remote: remote.remote, dirty };

    if (!currentCommit) return { ...status, ok: false, reason: "could not read current commit" };
    if (!remote.remoteArg) return { ...status, ok: false, reason: "no update remote configured" };

    const compareBranch = upstream.remoteBranch || branch;
    let remoteCommit = null;
    if (compareBranch) {
      const ref = await git(["ls-remote", remote.remoteArg, `refs/heads/${compareBranch}`]);
      if (ref.ok) remoteCommit = parseLsRemoteCommit(ref.stdout);
    }
    if (!remoteCommit) {
      const head = await git(["ls-remote", "--symref", remote.remoteArg, "HEAD"]);
      if (head.ok) {
        const parsed = parseRemoteHead(head.stdout);
        remoteCommit = parsed.commit;
        status.branch = status.branch || parsed.branch;
      }
    }

    status.remoteCommit = remoteCommit;
    // A differing remote SHA is NOT enough: on a dev checkout the local branch is routinely
    // AHEAD of the update remote (committed-but-unpushed work). ls-remote gives us the SHA
    // without fetching, and when we're ahead that commit already exists locally, so
    // merge-base --is-ancestor can prove it's behind us (exit 0). A genuinely new remote
    // commit is an unknown object locally (exit 128) or a non-ancestor (exit 1), both of
    // which correctly read as "update available". Without this, an enabled auto-update
    // loop on an ahead checkout would ff-pull a no-op and reinstall + rebuild every cycle.
    let remoteIsAncestor = false;
    if (remoteCommit && remoteCommit !== currentCommit) {
      remoteIsAncestor = (await git(["merge-base", "--is-ancestor", remoteCommit, "HEAD"])).ok;
    }
    status.updateAvailable = !!(remoteCommit && remoteCommit !== currentCommit && !remoteIsAncestor);
    status.canApply = status.updateAvailable && !dirty && !!(compareBranch || status.branch);
    status.reason = status.updateAvailable
      ? dirty
        ? "local changes must be committed or stashed before updating"
        : null
      : remoteCommit
        ? remoteIsAncestor
          ? "local checkout is ahead of the update remote"
          : "up to date"
        : "could not read remote commit";
    return status;
  }

  function commandSummary(args, result) {
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
    const suffix = result.timedOut ? "timed out" : result.ok ? "ok" : `exit ${result.code ?? "unknown"}`;
    return `$ ${args.join(" ")}\n${text || suffix}`;
  }
  async function runStep(args, timeoutMs, output) {
    const result = await runCommand(args, timeoutMs);
    output.push(commandSummary(args, result));
    if (!result.ok) {
      const msg = result.stderr.trim() || result.stdout.trim() || `${args[0]} failed`;
      throw new Error(msg.split("\n")[0] ?? "update step failed");
    }
  }

  async function applyUpdate() {
    const before = await checkForUpdate();
    const output = [];
    if (!before.updateAvailable) {
      return {
        ok: true,
        message: before.reason === "up to date" ? `${appLabel} is already up to date.` : "No update is available.",
        restartRequired: false,
        status: before,
        output,
      };
    }
    if (before.dirty) throw new Error("Commit or stash local changes before applying an update.");

    const upstream = await currentUpstream();
    const remote = await remoteForCheck(upstream.remoteName);
    const branch = upstream.remoteBranch || before.branch;
    if (!remote.remoteArg || !branch) throw new Error("No update remote/branch is configured.");

    await runStep(
      upstream.upstream ? ["git", "pull", "--ff-only"] : ["git", "pull", "--ff-only", remote.remoteArg, branch],
      APPLY_TIMEOUT_MS,
      output,
    );
    try {
      await runStep(installCmd, BUILD_TIMEOUT_MS, output);
      await runStep(buildCmd, BUILD_TIMEOUT_MS, output);
    } catch (err) {
      // Unattended self-update: a failed install/build must never leave the checkout
      // half-upgraded (new code, stale deps/build). Reset back to the pre-update commit
      // (the pull was ff-only), then best-effort reinstall + rebuild the previous version so
      // the running daemon stays consistent.
      //
      // BUT THE TREE WAS ONLY PROVEN CLEAN BEFORE THE PULL. Install + build run for minutes,
      // and a developer editing the checkout meanwhile (this is a source install - the same
      // tree they work in) has changes the clean check never saw. `git reset --hard` erases
      // them without a trace. So the tree is re-read here: anything that changed since is
      // moved into a named git stash BEFORE the reset, and the message says so. If the tree
      // cannot be inspected, or the stash fails, the reset does NOT run - a half-updated
      // checkout is recoverable by hand; a deleted edit is not.
      const msg = err instanceof Error ? err.message : String(err);
      const statusArgs = ["git", "status", "--porcelain"];
      const statusNow = await runCommand(statusArgs, CHECK_TIMEOUT_MS);
      output.push(commandSummary(statusArgs, statusNow));
      if (!statusNow.ok) {
        throw new Error(
          `${msg}; the checkout could not be inspected afterwards (git status failed), so it was NOT rolled back: it is at the new commit with a failed install/build; inspect it by hand`,
        );
      }
      const changedDuring = statusNow.stdout.split(/\r?\n/).filter(Boolean);
      let stashName = null;
      if (changedDuring.length) {
        stashName = `${serviceName}-update-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const stashArgs = ["git", "stash", "push", "--include-untracked", "-m", stashName];
        const stash = await runCommand(stashArgs, APPLY_TIMEOUT_MS);
        output.push(commandSummary(stashArgs, stash));
        if (!stash.ok) {
          throw new Error(
            `${msg}; ${changedDuring.length} file(s) changed in the checkout during the update and could not be stashed, so it was NOT rolled back (a reset would have deleted them): it is at the new commit with a failed install/build; recover by hand - changed: ${changedDuring.join(", ")}`,
          );
        }
      }
      const resetArgs = ["git", "reset", "--hard", before.currentCommit];
      const reset = await runCommand(resetArgs, APPLY_TIMEOUT_MS);
      output.push(commandSummary(resetArgs, reset));
      let restored = false;
      if (reset.ok) {
        restored = true;
        for (const cmd of [installCmd, buildCmd]) {
          const r = await runCommand(cmd, BUILD_TIMEOUT_MS);
          output.push(commandSummary(cmd, r));
          if (!r.ok) {
            restored = false;
            break;
          }
        }
      }
      // The stash was taken against the NEW commit, so popping it onto the rolled-back tree can
      // conflict where the update also touched the same file; the edit is intact either way and
      // `git stash show -p` / `git checkout stash@{0} -- <file>` recover it file by file.
      const preserved = stashName
        ? `; ${changedDuring.length} file(s) changed during the update were saved to git stash "${stashName}" (git stash pop brings them back; resolve any conflict against the rolled-back files)`
        : "";
      throw new Error(
        (reset.ok
          ? restored
            ? `${msg}; rolled back to the previous version`
            : `${msg}; code was rolled back, but reinstalling/rebuilding it failed; the previous version may not run until this is fixed`
          : `${msg}; rollback failed; the checkout may be partially updated`) + preserved,
      );
    }

    return {
      ok: true,
      message: `${appLabel} was updated. Restart the daemon to run the new code.`,
      restartRequired: true,
      status: await checkForUpdate(),
      output,
    };
  }

  return { checkForUpdate, applyUpdate };
}
