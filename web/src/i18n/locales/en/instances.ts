// Instances view — sortable instance table, toolbar, row actions, create dialog.
export default {
  title: 'Instances',
  refresh: 'Refresh',
  refreshHint: 'Reload the instance list and re-check the Claude Desktop install',
  createInstance: 'Create instance',
  empty: 'No instances found.',
  emptyHint: 'Create your first isolated Claude Desktop instance to get started.',
  sortByStatus: 'Sort by status',
  colName: 'Name',
  colNameHint:
    'The label you gave this instance. If you never named it, this falls back to the account it is signed into, and then to its profile folder — so a row can be named after any of the three. Rename it from the ⋯ menu; that only changes the label, never the folder.',
  colAccount: 'Instance account',
  // NO literal "@" in this string. vue-i18n reads a bare @ as the start of a linked-message
  // reference, so "before the @." threw a tokenizer SyntaxError at render time — and because the
  // throw happened while rendering the header cell, Vue dropped the entire "Instance account"
  // column header while leaving its body cells in place. Typecheck, Biome, the i18n key gate and
  // the test suite were all green; only opening the page showed it.
  colAccountHint:
    'The Anthropic login this instance is signed into, shown as the first part of its email address. Hover a badge for the full address and the profile display name, if that account has one set.',
  colPid: 'PID',
  colUptime: 'Uptime',
  colMemory: 'Memory',
  colUsage: 'Usage',
  colUsageSession: 'Usage 5h',
  // Usage-mode columns — they replace PID/Uptime/Memory, they don't add to them.
  colSession: 'Session (5h)',
  colWeekly: 'Weekly',
  resetsIn: 'in {when}',
  colPlan: 'Plan',
  colActions: 'Actions',
  running: 'Running',
  stopped: 'Stopped',
  external: 'External',
  // Shown while an instance's account is still being worked out. There is no "Resolve" action
  // anymore — every instance resolves itself — so this is the whole of the unresolved state.
  resolving: 'Resolving…',
  open: 'Open',
  quit: 'Quit',
  focusHint: 'Bring this instance to the foreground',
  focusShort: 'Focus',
  delete: 'Delete',
  edit: 'Edit',
  moreActions: 'More actions',
  // The instance number chip. Deliberately explicit about WHAT the number is for: it is the only
  // handle that survives being spoken to an AI or pasted into an MCP call, and it is permanent, so
  // an old note that says "instance 7" still points at the same account.
  numberTooltipTitle: 'Instance #{num}',
  numberTooltipBody:
    'Permanent number for this instance — unique across Claude Desktop, Claude CLI and Codex, and never reused. Say “instance {num}” to an AI, or pass instance: {num} to the MCP tools. Click to copy.',
  numberCopyAria: 'Copy instance number {num}',
  numberMenuLabel: 'Instance #{num}',
  copyNumber: 'Copy instance number',
  toastNumberCopied: 'Copied “{num}” — refer to this instance by that number.',
  // Account-column hover. The handle is on the badge; this is where the full address and the
  // Anthropic profile display name live, so the column itself stays one comparable thing per row.
  accountTitleWithProfile: '{email}\nAnthropic profile name: {profile}',
  // …and the badge copies that full address, because the handle it shows is not one: two accounts
  // on different domains render the same chip, so the short form is for reading and the long form
  // is for pasting.
  accountCopyHint: 'Click to copy the full address.',
  // A name you typed once overrides everything and nothing ever re-checked it, so an instance
  // signed into a different account keeps the old account's name for good. The marker reports it;
  // the ⋯ menu clears it. Deliberately not automatic — the override is still the user's choice.
  labelStale: 'This name does not match the account',
  labelStaleHint:
    'You named this instance “{label}”, but it is signed into {account}. Names you type are kept until you change them, so this one stayed behind when the account did. Use “Name it after the account” in the ⋯ menu to drop it.',
  useAccountName: 'Name it after the account',
  toastUsingAccountName: 'Cleared the typed name. This instance is called “{name}” again.',
  copyAccountEmailAria: 'Copy the account address {email}',
  toastEmailCopied: 'Copied {email} — the account this instance is signed into.',
  // Sign a profile out. Removes the stored login ONLY: history, settings and the folder stay.
  // Disabled while the instance runs, because the server refuses it then (Claude Desktop holds
  // config.json open and would undo or corrupt the write) and a dead click is worse than a
  // greyed one.
  logout: 'Log out of this account',
  logoutDialogTitle: 'Log {name} out?',
  logoutDialogDescription:
    'Removes the stored login from this instance. Its chats, settings and folder are untouched, and it will ask for a sign-in the next time it starts. Signing back in needs the other instances quit first (the “Browser Dance”).',
  logoutDialogSubmit: 'Log out',
  logoutDialogWorking: 'Logging out…',
  toastLoggedOut: 'Signed out. That instance will ask for a login next time it starts.',
  toastLogoutFailed: 'Could not sign that instance out.',
  openFolder: 'Open folder',
  createShortcut: 'Create desktop shortcut',
  checkUsage: 'Check usage',
  launchCli: 'Launch CLI',
  loginCli: 'Sign in CLI',
  // Deliberately NOT "Sign in CLI": on a row with no CLI login yet this creates a whole new managed
  // CLI instance and links it to this account before opening the terminal. Labelling that the same
  // as the plain sign-in made a linked instance appear out of nowhere, which then showed up as the
  // unexplained "CLI instances (0 of 1)" shortfall in the table below.
  addCli: 'Add a CLI login…',
  unlinkCli: 'Unlink CLI instance',
  // The row badge that makes a linked CLI login visible without opening the actions menu.
  linkedCliBadge: 'Has a linked CLI login',
  linkedCliTooltip: 'Claude CLI: {name}',
  linkedCliSignedIn: 'Signed in — launch it from this row’s ⋯ menu.',
  linkedCliSignedOut: 'Needs sign-in — open this row’s ⋯ menu to finish it.',
  toastCliLaunched: 'Opened a terminal for the linked CLI instance.',
  toastCliLaunchFailed: 'Failed to launch the linked CLI instance.',
  toastCliLoginOpened: 'Opened a terminal. Run /login there to sign this CLI instance in.',
  toastCliLoginFailed: 'Failed to open a terminal for the CLI sign-in.',
  toastCliUnlinked: 'Unlinked. It is back in the CLI instances table below.',
  toastCliUnlinkFailed: 'Failed to unlink the CLI instance.',
  toastCliCreateFailed: 'Failed to create a CLI instance for this account.',
  quitExternalDialogTitle: 'Quit your regular Claude Desktop?',
  quitExternalDialogDescription:
    'This is your real, non-isolated Claude Desktop, not an instance created here. Quitting it closes any conversation in progress.',
  quitExternalDialogSubmit: 'Quit it anyway',
  quitExternalDialogQuitting: 'Quitting…',
  usageModeOn: 'Show usage columns',
  usageModeOff: 'Show process columns',
  usageModeHint:
    'Swap PID, uptime and memory for what is left of each quota window and how long until it resets.',
  // Usage filter (toolbar flyout, usage mode only) — see composables/useUsageFilter.ts.
  usageFilterTitle: 'Usage filter',
  usageFilterHint:
    'Set aside the accounts you have already spent, so the ones you can still work on stand out.',
  usageFilterEnable: 'Filter by usage',
  usageFilterThreshold: 'Threshold',
  usageFilterThresholdValue: '{pct}%',
  usageFilterHide: 'Hide instead of dim',
  usageFilterHideHint:
    'Matching instances leave the table entirely. The section heading still says how many are hidden.',
  // Section captions inside the flyout.
  usageFilterWindows: 'Quota windows',
  usageFilterDisplay: 'Display behaviour',
  // One switch + one threshold per quota window; an instance is set aside when it crosses either.
  usageFilterWeek: 'Weekly usage',
  usageFilterWeekHint:
    'The Usage column — the cap that decides whether an account is worth starting on at all. Instances at or above the threshold are set aside. Instances that have never been checked are never filtered: an unknown reading is not a full one.',
  usageFilterWeekThresholdLabel: 'Weekly usage threshold, percent',
  usageFilterSession: 'Also 5-hour usage',
  usageFilterSessionHint:
    'Also set an instance aside when its 5-hour session window is at or above its own threshold, even if there is weekly quota left — a spent session means you cannot use the account right now. Off by default: this window refills the same day, so instances leave the table and come back over an afternoon.',
  usageFilterSessionThresholdLabel: '5-hour usage threshold, percent',
  usageFilterNoWindows: 'Both windows are off, so nothing is being filtered. Turn one back on.',
  // Compact form of the rule, on the toolbar button. A bare percentage is the weekly cap.
  usageFilterChipWeek: '{pct}%',
  usageFilterChipSession: '5h {pct}%',
  usageFilterChipBoth: '{week}% · 5h {session}%',
  usageFilterChipNone: 'Off',
  usageFilterHiddenCount: '{count} hidden',
  usageFilterAllHidden: 'Every instance is at or above the usage filter.',
  usageFilterAllHiddenHint:
    'Raise the thresholds, or turn the usage filter off in the toolbar. It says what it is filtering on.',
  // "x of y" for a heading whose table is showing fewer rows than it has.
  countOfTotal: '{shown} of {total}',
  // Sections flyout (toolbar) — the same provider switches Settings shows, where they apply.
  sectionsTitle: 'Sections',
  sectionsHint: 'Which instance tables this tab shows.',
  // Small-caps heading over the auto-refresh rows inside the usage flyout.
  usageDataTitle: 'Usage data',
  refreshAllUsage: 'Refresh all usage',
  refreshAllUsageHint:
    'Re-check every instance now. Reading your quota does not use any of it, and takes about a third of a second per instance.',
  usageNotChecked: 'Not checked yet.',
  usageReasonLoggedOut:
    'Not signed in. Open this instance and sign in to Claude, then check again.',
  usageReasonNoToken: 'Signed in, but no usage-capable token for this instance.',
  usageReasonNotLoggedIn: 'No login yet. Use the Log in helper, or associate a dispatch account.',
  usageReasonCheckFailed:
    'Claude returned no usage numbers for this instance. Try again in a moment.',
  usageSession: 'Session (5h)',
  usageWeekAll: 'Week (all models)',
  usageWeekModel: 'Week ({model})',
  usageSessionResetsIn: 'Session resets in',
  usageWeekResetsIn: 'Week resets in',
  usageCheckedAgo: 'Checked {when}',
  usageChecking: 'Checking…',
  usageCheckNow: 'Check now',
  toastUsageCheckFailed: 'Failed to check usage.',
  deleteDialogTitle: 'Delete instance',
  deleteDialogDescription:
    'This permanently removes the instance profile and all its local data. This cannot be undone.',
  deleteDialogLabel: 'Type "{name}" to confirm',
  deleteDialogPlaceholder: 'Instance name',
  deleteDialogSubmit: 'Delete instance',
  deleteDialogDeleting: 'Deleting…',
  deleteDialogMismatch: "Name doesn't match.",
  createDialogTitle: 'Create instance',
  createDialogDescription: 'Create a new isolated Claude Desktop instance.',
  createDialogLabel: 'Instance name',
  createDialogPlaceholder: 'e.g. work, personal, client-a',
  createDialogSubmit: 'Create',
  createDialogCreating: 'Creating…',
  editDialogTitle: 'Edit instance',
  editDialogNameLabel: 'Display name',
  editDialogIconLabel: 'Icon',
  editDialogColorLabel: 'Color',
  // "Done", not "Save": every edit persists as it is made, so this button only closes the dialog.
  editDialogDone: 'Done',
  editDialogSaving: 'Saving…',
  desktopMsixTitle: 'Claude Desktop is installed as the MSIX (Windows Apps) build',
  desktopMsixBody:
    'The MSIX package cannot be launched with an isolated profile, so instances cannot be ' +
    'created or opened from this tab. Install the classic Windows installer (~217 MB) instead; ' +
    'the regular download page serves a small ~7 MB ClaudeSetup.exe that reinstalls the MSIX build.',
  desktopNoneTitle: 'No launchable Claude Desktop installation found',
  desktopNoneBody:
    'Instances need the classic Claude Desktop for Windows installer (~217 MB). Install it, then refresh this tab.',
  desktopWarnDownload: 'Download the classic installer',
  desktopWarnAllDownloads: 'All downloads',
  // Names ISOLATED instances explicitly: the old copy said "every other running instance", and a
  // user dutifully following it one-click-quit their REAL (External) Claude Desktop mid-chat.
  browserDanceTitle: 'One-time sign-in required',
  browserDanceBody:
    'Before signing in for the first time, quit the other ISOLATED instances created here (the login can attach to the wrong isolated profile). Your regular Claude Desktop is not affected, so leave it open.',
  toastOpened: 'Instance opened.',
  toastOpenFailed: 'Failed to open instance.',
  toastQuit: 'Instance quit.',
  toastQuitFailed: 'Failed to quit instance.',
  toastFocused: 'Instance focused.',
  toastFocusFailed: 'Failed to focus instance window.',
  toastRevealFailed: 'Failed to open folder.',
  toastCreated: 'Instance created.',
  toastCreateFailed: 'Failed to create instance.',
  toastDeleted: 'Instance deleted.',
  toastDeleteFailed: 'Failed to delete instance.',
  toastSaveFailed: 'Failed to save changes.',
  toastShortcutCreated: 'Desktop shortcut created.',
  toastShortcutFailed: 'Failed to create desktop shortcut.',

  // "Move all chats" on a row's menu (the kebab, or right-click on the row): every active chat on
  // this instance, one hop to another. A closed target is opened first, since the import has to
  // land in a running app.
  moveChats: 'Move all chats to another account',
  moveChatsNoTargets: 'No other instances',
  // Shown under EVERY closed target in the submenu and again in the confirm dialog, so it has to
  // read at a glance seven rows deep: one clause, same wording as the Sessions flyout's group.
  moveChatsClosedLands: 'Not running - lands in its store, ready when it starts',
  moveChatsCounting: 'Counting active chats…',
  moveChatsNone: 'No active chats to move from {from}.',
  moveChatsFailed: "Couldn't list the chats on {from}.",
  moveChatsConfirmTitle: 'Move {n} chats from {from} to {to}?',
  moveChatsConfirmBody:
    'Every active chat on {from} (not archived, not marked done) is stopped if it is running, archived there, and imported into {to}. They move one at a time; this cannot be undone in one step.',
  moveChatsCancel: 'Cancel',
  moveChatsConfirmSubmit: 'Move {n} chats',
  moveChatsProgress: 'Moving chat {done} of {n}…',
  moveChatsDone: 'Moved {ok} of {n} chats to {to}.',
  moveChatsSomeFailed: '{failed} could not be moved; details are in the browser console.',
  // The chat list inside the move dialog: grouped by project, each row opens that chat in Sessions.
  moveChatsGroupCount: '{n} chat(s)',
  moveChatsRowHint: 'Grouped by project. Click a chat to open it in Sessions.',
}
