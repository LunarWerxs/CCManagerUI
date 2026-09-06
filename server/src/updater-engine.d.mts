export interface UpdateStatus {
  ok: boolean;
  service: string;
  currentVersion: string;
  currentCommit: string | null;
  remoteCommit: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  updateAvailable: boolean;
  canApply: boolean;
  checkedAt: number;
  reason: string | null;
  /** Installed version of each release-owned component, or null where an install predates version
   *  stamping. OPTIONAL because only an app whose release ships sidecar components beside the
   *  executable can populate it: the git-checkout engine has no such components, and a fabricated
   *  entry there would be worse than an absent one. */
  components?: Array<{ name: string; version: string | null }>;
}

export interface UpdateApplyResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
  status: UpdateStatus;
  output: string[];
}

export interface UpdaterOptions {
  /** Checkout root (each app resolves its own import.meta path and passes it in). */
  appRoot: string;
  /** Value of the `service` field on UpdateStatus. */
  serviceName: string;
  /** Display name used in the apply-result messages. */
  appLabel: string;
  /** Env var whose value overrides the update remote (URL or remote name). */
  updateRepoEnvVar: string;
  /** Install step, e.g. ["bun", "install"]. */
  installCmd: string[];
  /** Build step, e.g. ["bun", "run", "--cwd", "web", "build"]. */
  buildCmd: string[];
}

export interface Updater {
  checkForUpdate(): Promise<UpdateStatus>;
  applyUpdate(): Promise<UpdateApplyResult>;
}

export function createUpdater(opts: UpdaterOptions): Updater;
