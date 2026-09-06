// SettingsView strings — scheduler controls and account credential management.
export default {
  // top-level tabs
  tabGeneral: 'General',
  tabAutomation: 'Automation',
  // appearance section
  appearance: 'Appearance',
  themeLabel: 'Theme',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeSystem: 'System',
  // header controls (theme + shut down now live as icons in the settings panel header; the theme
  // trigger reuses `themeLabel` above)
  shutdownTooltip: 'Shut down AgentHydra (closes the app and its tray icon)',
  shutdownConfirmTooltip: 'Click again to shut down',
  shutdownToast: 'Shutting down…',
  shutdownToastFailed: 'Failed to shut down.',
  showTooltipsLabel: 'Show tooltips',
  showTooltipsHint: 'Hover help on buttons and controls. Info icons stay on.',
  portableModeLabel: 'Portable window',
  portableModeHint:
    'Opens AgentHydra in its own window (no tabs or address bar) instead of a browser tab. The desktop launcher and tray icon follow this setting too.',
  portableModeToastOpened: 'Opened in portable window - you can close this tab.',
  portableModeToastNoBrowser: 'No Edge or Chrome install found to open a portable window.',
  portableModeToastFailed: 'Failed to save portable window setting.',
  instanceModeShortcutLabel: 'Quick Instances shortcut',
  instanceModeShortcutHint:
    'Adds a lightweight launcher to your Desktop that only loads the instance chooser.',
  instanceModeShortcutCreate: 'Add to Desktop',
  instanceModeShortcutCreating: 'Adding…',
  instanceModeShortcutCreated: 'Quick Instances shortcut added to your Desktop.',
  instanceModeShortcutFailed: 'Failed to create the Quick Instances shortcut.',
  hideTrayIconLabel: 'Hide tray icon',
  hideTrayIconHint:
    'Removes the AgentHydra icon from the notification area. AgentHydra keeps running in the background - launch the shortcut again to reopen the UI, or come back here to turn the icon back on. Only applies when AgentHydra was started from its tray shortcut: the icon comes from that launcher, so if you ran the executable directly there is no icon for this to affect.',
  hideTrayIconToastFailed: 'Failed to save hide tray icon setting.',
  // --- what "copy session file location" puts on the clipboard ---
  copyPathLabel: 'Copying a session file location',
  copyPathHint:
    'What lands on the clipboard when you copy a session file location. With both off it is just the path, exactly as before.',
  copyPathIncludeNameLabel: 'Include the session name',
  copyPathIncludePromptLabel: 'Include a prompt',
  copyPathPromptLabel: 'The prompt',
  copyPathPromptPlaceholder: 'Resume where we left off',
  copyPathPreviewLabel: 'What gets copied',
  transcriptEditorLabel: 'Transcript editor',
  transcriptEditorHint:
    'Absolute path to the editor "Open the session file" opens .jsonl transcripts with. Empty auto-detects VS Code, Cursor, Notepad++ or Sublime Text (in that order), falling back to Notepad - never the OS "pick an app" dialog.',
  transcriptEditorPlaceholder: 'Auto-detect',
  transcriptEditorToastFailed: 'Failed to save transcript editor setting.',
  transcriptEditorResolved: 'Opens with {editor}',
  transcriptEditorNotFound: "That path doesn't exist. Using {editor}",
  transcriptEditorCustomBadge: 'Custom',
  // --- search index (the conversation index behind fast content search) ---
  searchIndexLabel: 'Search index',
  searchIndexHint:
    'Makes searching session content instant. It holds the words of your conversations, not the file contents or command output, and rebuilds itself from your transcripts whenever it is missing.',
  searchIndexBuilt: '{size}, covering {n} sessions',
  searchIndexAbsent:
    'Not built yet. It is created in the background the first time you search session content.',
  searchIndexDelete: 'Delete',
  searchIndexDeleted: 'Search index deleted. It will rebuild on your next content search.',
  searchIndexDeleteFailed: "Couldn't delete the search index",
  transcriptEditorReset: 'Back to auto-detect',

  // usage section
  usage: 'Usage',
  usageAutoRefreshLabel: 'Auto-refresh usage',
  usageAutoRefreshHint:
    "Keep every instance's quota numbers up to date in the background, so the Instances table is never stale. Checking your quota does not use any of it, and each check takes about a third of a second, so this costs you nothing. Turn it off to only ever check when you click Refresh.",
  usageIntervalLabel: 'Refresh every',
  usageIntervalHint:
    'How often to re-check. Quota moves over hours, not seconds, so there is little reason to go below 15 minutes.',
  usageIntervalMinutes: '{minutes} min',
  usageToastFailed: 'Failed to save usage setting.',

  // provider surfaces
  providersTitle: 'Providers',
  providersHint:
    'Choose which desktop, CLI, and external AI surfaces AgentHydra shows. Disabling a surface hides its controls; it does not uninstall the provider or delete an account.',
  claudeDesktopProviderLabel: 'Claude Desktop',
  claudeDesktopProviderHint: 'Show and manage isolated Claude Desktop instances.',
  claudeCliProviderLabel: 'Claude CLI',
  claudeCliProviderHint: 'Show and manage isolated Claude CLI logins.',
  codexDesktopProviderLabel: 'Codex Desktop',
  codexDesktopProviderHint: 'Show desktop launch, focus, quit, and running status for Codex.',
  codexCliProviderLabel: 'Codex CLI',
  codexCliProviderHint: 'Show Codex CLI launch and login actions.',
  chatGptHandoffLabel: 'ChatGPT handoff',
  chatGptHandoffHint:
    'Adds a composer action that downloads a bounded, secret-screened repository context file, copies the task prompt, and opens ChatGPT. You still review and submit everything manually.',
  providerToastFailed: 'Failed to save provider setting.',

  // updates section — the version number itself is the status + control now (see the tips below),
  // so the old standalone "Check for updates" / "Update available" / "Update blocked" / "Up to
  // date" strings are gone.
  updates: 'Updates',
  currentVersion: 'Current version',
  noUpdateSourceHint:
    'This install is not linked to a Git remote, so there is nowhere to pull new versions ' +
    'from. Link one (git remote add origin <url>) or set AGENTHYDRA_UPDATE_REPO, and the ' +
    'update check and auto-update come to life.',
  restartGuidance: ' Restart AgentHydra from the tray icon to run the new code.',
  // the version number itself is the status indicator now: green = up to date, amber = update
  // available (click to apply), red = blocked / no source. Tooltip spells out the state + action.
  versionUpToDateTip: 'Up to date. Click to check again.',
  versionCheckingTip: 'Checking for updates…',
  versionUpdateAvailableTip: 'Update available. Click to update and restart.',
  versionUpdateBlockedTip: 'Update available but blocked. Click to re-check.',
  versionNoSourceTip: "Updates can't be checked from this install.",

  // auto-update section
  autoUpdate: 'Auto-update',
  autoUpdateDescription:
    'Off by default. When on, AgentHydra periodically checks for a newer version and, if there are no uncommitted local changes, pulls it, reinstalls, rebuilds, and restarts the daemon on its own - no prompt. A dirty working tree is never touched; updates only apply on a clean checkout.',
  autoUpdateToastEnabled: 'Auto-update enabled.',
  autoUpdateToastDisabled: 'Auto-update disabled.',
  autoUpdateToastFailed: 'Failed to save auto-update settings.',
  toastSchedulerFailed: 'Failed to update scheduler settings.',

  // cloud sync section ("Sync my settings with Connections")
  cloudSyncTitle: 'Cloud sync',
  cloudSyncConnectButton: 'Sync settings with Connections',
  cloudSyncEnableToggle: 'Sync settings',
  cloudSyncHint:
    'Syncs scheduler preferences and appearance (theme) to your Connections account, so they follow you to AgentHydra on another machine. Optional; never syncs accounts, secrets, or queue data.',
  cloudSyncSyncNow: 'Sync now',
  cloudSyncSyncing: 'Syncing…',
  cloudSyncSyncedToast: 'Settings synced.',
  cloudSyncSyncedNow: 'Synced - just now',
  cloudSyncSyncedAgo: 'Synced - {when}',
  cloudSyncSecondsAgo: '{n}s ago',
  cloudSyncMinutesAgo: '{n}m ago',
  cloudSyncHoursAgo: '{n}h ago',
  cloudSyncNeverSynced: 'Not synced yet',
  cloudSyncDisconnect: 'Disconnect',
  cloudSyncConfirmDisconnect: 'Click again to confirm',
  cloudSyncConnectFailed: "Couldn't connect to Connections. Try again.",

  // scheduler section
  scheduler: 'Scheduler',
  schedulerHint:
    "When enabled, the scheduler automatically spawns real claude runs for queued items; this spends the selected account's quota and acts on real repositories. Leave it off to dispatch items manually with the Run button.",
  // AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts's headlessRunsAllowed()
  // is hardcoded false) — the scheduler exists to spawn those runs automatically, so it can never
  // actually dispatch anything in this build. Read alongside web/src/lib/headless.ts's
  // HEADLESS_QUEUEING_ENABLED, which is what the panel below branches on to disable these controls
  // rather than leave them offering a toggle that would only fail moments after flipping.
  schedulerUnavailableHint:
    'Disabled: the scheduler exists to automatically spawn real claude runs for queued items, but AgentHydra never runs a chat nobody can see, so it can never dispatch one in this build. Reply straight into the session’s own desktop chat, use fan_out from an MCP client, or import the session into a desktop app to get work done instead.',
  schedulerEnabledLabel: 'Enabled',
  running: 'running',
  queued: 'queued',
  advanced: 'Advanced',
  tomorrowTimeLabel: 'Tomorrow preset time',
  tomorrowTimeHint:
    'The time of day the composer\'s "Tomorrow …" quick option schedules for. Saved immediately.',
  spacingLabel: 'Spacing (s)',
  pollLabel: 'Poll (s)',
  maxConcurrentLabel: 'Max concurrent',
  saveSettings: 'Save settings',
  toastSaved: 'Settings saved.',

  // auto-resume monitor section
  monitorTitle: 'Auto-resume monitor',
  monitorHint:
    'Watches sessions that stopped on a rate limit and, once the 5-hour window resets, resumes them automatically. Off by default; it prompts sessions while you are away, so review the settings below before turning it on.',
  monitorEnabledLabel: 'Enabled',
  monitorMaxAttemptsLabel: 'Max resume attempts',
  monitorBufferLabel: 'Resume buffer (min)',
  monitorEmpty:
    'Nothing to resume right now. A session appears here once it stops on a rate limit, whether the app ran it or you started it yourself in a terminal, which the monitor finds by checking recent transcripts. The monitor then tracks it until the window resets and resumes it. An empty list means nothing is currently waiting on a limit, not that monitoring is off.',
  monitorAttempts: '{n} attempts',
  monitorDiscovered: 'Found',
  monitorDiscoveredHint:
    'The monitor found this session stopped at a rate limit on disk. You started it outside the app, so there was no queued run to watch.',
  monitorStateScheduled: 'Scheduled',
  monitorStateBlockedWeekly: 'Blocked (weekly limit)',
  monitorStateNeedsHuman: 'Needs you',
  monitorStateDone: 'Done',
  monitorAccountOverridesLabel: 'Per-account overrides',
  monitorToastEnabled: 'Auto-resume monitor enabled.',
  monitorToastDisabled: 'Auto-resume monitor disabled.',
  monitorToastFailed: 'Failed to save auto-resume monitor settings.',

  // The accounts section's strings are gone with the section itself: it only ever listed legacy
  // pasted credentials, so in practice it rendered as an empty box telling you to go to the
  // Instances tab. Accounts are added by signing an instance in there.
}
