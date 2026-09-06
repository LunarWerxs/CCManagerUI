// Sessions view — session list, search/filter, and transcript detail pane.
export default {
  searchPlaceholder: 'Search sessions…',
  refresh: 'Refresh',
  noSessionsFound: 'No sessions found.',
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',
  resizeSidebar: 'Drag to resize · double-click to reset',
  selectSessionPrompt: 'Select a session to view its transcript',
  multiSelect: 'Select multiple sessions',
  selectedCount: '{n} selected',
  selectAll: 'All',
  clearSelection: 'Clear',
  composeToSelected: 'Message the {n} selected session(s) below',
  selectSessionsHint: 'Tap sessions in the list to pick message targets',
  copySessionId: 'Copy session id',
  copySessionIdHint:
    'Copies the full id as text — what you paste into claude --resume or a bug report',
  id: 'ID',
  // --- the ⋯ menu on an open transcript ---
  // Items in here carry no explanatory second line. The labels are full sentences already, and a
  // menu that explains every row is a menu you read instead of aim at.
  chatOptions: 'More actions',
  chatOptionsHint:
    'The account, what the transcript shows, and the session file and terminal actions',
  // --- which account this chat is talking to ---
  // Named on the transcript itself because every instance runs a DIFFERENT Anthropic login, and
  // that decides whether the chat is worth resuming at all (is the account out of quota?) and
  // whose weekly limit a long run is spending. The chip shows the handle; the address is one
  // click away, in the ⋯ menu.
  accountLabel: 'Account',
  // Two different absences. The instance is missing from the list entirely (deleted, or the
  // regular install is not running so it has no row) — or it is right there and has no resolved
  // identity yet. Telling you the first when it is the second sends you hunting for nothing.
  accountUnresolved: 'This account is not in the instance list right now',
  accountAddressUnknown: 'No address resolved for this account yet — it may be signed out',
  openAccountInstance: 'Open this account',
  focusAccountInstance: 'Bring this account to the front',
  copyAccountEmail: 'Copy the account address',
  displayControlsActive: 'Part of this transcript is hidden by a display filter',
  fileActions: 'Session file',
  openFile: 'Open session file',
  openFileFailed: "Couldn't open the session file",
  saveCopy: 'Save copy of session file',
  copyFile: 'Copy session file to clipboard',
  copyFileDone: 'Copied {name} to the clipboard; paste it anywhere that takes a file',
  copyFileFailed: "Couldn't copy the session file to the clipboard",
  copyFileUnsupported: 'Copying a file to the clipboard needs Windows or macOS',
  copyFileLocation: 'Copy session file location to clipboard',
  copyFileLocationHint: 'Copies the full path to the original .jsonl session file as text',
  copyFileLocationDone: 'Copied the session file location to the clipboard',
  copyFileLocationDoneRich:
    'Copied the prompt, the session name and its file location to the clipboard',
  copyFileLocationFailed: "Couldn't copy the session file location to the clipboard",
  closeChat: 'Close this chat',
  filterSource: 'Source',
  sourceAll: 'All sources',
  sourceClaude: 'Claude',
  sourceCodex: 'Codex',
  sourceOther: 'Other tools',
  sourceOpenCode: 'OpenCode',
  sourceHermes: 'Hermes',
  readOnlySource: '{source} sessions are read-only here. Carry this one on in {source} itself.',
  filterInstance: 'Instance',
  instanceAll: 'All instances',
  instanceDefault: 'Default',
  // --- one conversation, several transcripts ---
  copyOf: 'part {i} of {n}',
  // The short form, shown on the row itself, so the reason is visible without hovering.
  endedInterrupted: 'you stopped it',
  endedUsageLimit: 'hit a usage limit',
  endedOverload: 'server was overloaded',
  endedRefused: 'a safety filter refused it',
  endedError: 'it hit an error',
  endedComplete: 'picked up again later',
  copyWhy:
    'Part {i} of {n}. This part ended because {why}, and the conversation carried on in a new transcript — that is why it is here more than once. Every part is listed, because each one holds turns the others do not, often the last thing you said before it stopped.',
  copyLatest:
    'Part {i} of {n}, the most recent. The earlier parts are listed too, because each one holds turns this one does not — the conversation moved to a new transcript each time it was stopped or cut off.',
  instanceUnknown: 'Unknown account',
  instanceUnknownHint:
    'Claude Desktop kept no record of which account ran this session, so AgentHydra cannot say. It is not hiding one.',
  instanceOther: 'CLI / other',
  // Shown on a session that fanned out. The subagents are sessions in the provider's own store, but
  // not conversations the user held, so they are folded into this row rather than listed beside it.
  subagents: '{count} subagents',
  subagentsHint:
    'Spawned {count} subagent sessions. They are folded into this row rather than listed separately; their tokens are still counted.',
  // --- list options (the ⋯ menu) ---
  listOptions: 'List options',
  listOptionsHint: 'Filters and view toggles for the session list',
  listOptionsActive: 'Filters are active',
  archived: 'Archived',
  archivedHide: 'Hidden',
  archivedInclude: 'Shown',
  archivedOnly: 'Only archived',
  period: 'Time period',
  period24h: 'Last 24 hours',
  period7d: 'Last 7 days',
  period30d: 'Last 30 days',
  periodAll: 'All time',
  periodEmptyHint: 'Showing {period}. Search all time instead',
  clearDoneMarks: 'Clear all done marks',
  doneMarkCount: '{n} marked done',
  // --- per-session right-click menu ---
  markDone: 'Mark as done',
  markNotDone: 'Clear done mark',
  done: 'Done',
  openTranscript: 'Open transcript',
  copyCwd: 'Copy working folder',
  copyTitle: 'Copy title',
  markDoneFailed: "Couldn't save the done mark",
  turnsShown: 'turns shown',
  // --- tokens + cost for the open session ---
  usageLabel: 'Tokens and cost',
  usageTokens: '{n} tokens',
  usageBreakdown:
    'In {input} · out {output} · cache read {cacheRead} · cache write {cacheWrite}, over {turns} replies.',
  usageListPrice:
    'Priced at published list rates as of {date}. A subscription plan is not billed per token.',
  usageLowerBound: 'No published price for {models}, so the real total is higher.',
  usageNoPrice: 'No published price for {models}, so no cost is shown.',
  // --- queued by us vs driven by hand, and how live a session is ---
  dispatched: 'Queued work',
  dispatchedAll: 'All sessions',
  dispatchedQueued: 'Only what I queued',
  dispatchedManual: 'Only what I drove by hand',
  // --- conversations a usage/quota wall cut off ---
  rateLimited: 'Usage limits',
  rateLimitedAll: 'All sessions',
  rateLimitedOnly: 'Only ones a usage limit stopped',
  rateLimitedPending: 'Only ones still stopped right now',
  rateLimitedNote:
    'Claude sessions only, and only when the CLI itself reported the wall — a chat that merely talked about rate limits is not counted.',
  rateLimitedBadgePending: 'Still at the limit',
  rateLimitedHint: 'This session stopped here: {notice}',
  // --- where a row's title came from ---
  titleFrom: 'Title from',
  titleFromCustom: 'a saved title on the session — a rename, or the app naming it',
  titleFromAi: 'the assistant summarising the conversation',
  titleFromStore: 'the app that wrote this session',
  titleFromEnvelope: 'a <{tag} name="…"> wrapper around the first message, not from you',
  titleFromMessage: 'the first thing said in the conversation',
  titleFromId: 'nothing else was available, so this is the session id',
  // --- keyboard ---
  shortcutGroup: 'Sessions',
  shortcutFind: 'Find in the open session',
  shortcutFilter: 'Filter the session list',
  shortcutEscape: 'Close the find bar, then the session',
  // --- reopen in a terminal ---
  resumeTerminal: 'Reopen in a terminal',
  resumeOpened: 'Opened a terminal for this session.',
  resumeCopied: "Couldn't open a terminal, so the command is on your clipboard.",
  resumeUnsupported: 'Only Claude sessions can be resumed. The command is on your clipboard.',
  resumeFailed: "Couldn't reopen this session.",
  migrateAccount: 'Migrate to another account',
  migrateNoTargets: 'No other instances',
  migrateStarted: 'Migrated to {name} — the chat is in that desktop app now, ready to carry on.',
  migrateFailed: "Couldn't migrate this chat.",
  // --- readable export ---
  exportMarkdown: 'Save as Markdown',
  exportHtml: 'Save as a web page',
  exportRaw: 'Save the raw .jsonl',
  // --- credentials the session printed ---
  secretsLabel: 'Credentials in this transcript',
  secretsCount: '{n} secret(s)',
  secretsTitle: 'Credentials found in this transcript',
  secretsHint: 'This session printed {n} thing(s) that look like credentials. Click for the list.',
  secretsCaveat:
    'Shown redacted, and never revealed here. Only unmistakable formats are matched (private keys, AWS key ids, provider tokens), so this is a prompt to go and rotate something, not a clean bill of health.',
  secretsTurn: 'turn {n}',
  secretsTruncated: 'Showing the first findings of {n}.',
  shape: 'Session shape',
  shapeAll: 'Any shape',
  shapeQuick: 'Quick',
  shapeStandard: 'Standard',
  shapeDeep: 'Deep',
  shapeMarathon: 'Marathon',
  shapeAutomation: 'Automation',
  shapeNote: 'Narrows the sessions already loaded, not the window they came from.',
  shapeHint: 'how big the session was, from its message count and how long it ran. Not a name.',
  activityWorking: 'Working — a turn landed in the last couple of minutes',
  activityIdle: 'Idle — active within the hour',
  activityStale: 'Stale — nothing for over an hour',
  // --- what the transcript shows ---
  // A section heading inside the ⋯ menu now, not a button — the four toggles under it are their own
  // explanation, so it needs no hint. displayControlsActive is what the collapsed trigger says.
  displayControls: 'Display',
  showToolActivity: 'Show tool activity',
  showThinking: 'Show reasoning',
  humanOnly: 'Only what I typed',
  compactLayout: 'Compact layout',
  thinkingLabel: 'Reasoning',
  // --- find within the open session ---
  findInSession: 'Find in session',
  findInSessionHint: 'Search the transcript on screen (Ctrl+F)',
  findPlaceholder: 'Find in this session…',
  findPosition: '{i} of {n}',
  findNone: 'No matches',
  findNext: 'Next match',
  findPrevious: 'Previous match',
  findClose: 'Close find',
  copyMessage: 'Copy message',
  showMore: 'Show more',
  showLess: 'Show less',
  noDisplayableTurns: 'No displayable turns.',
  // --- advanced (body) search ---
  advancedSearch: 'Advanced search',
  advancedSearchHint: 'Search the full session content on the server, not just titles',
  advancedSearchTitle: 'Search session content',
  advancedSearchQueryLabel: 'Search for',
  advancedSearchQueryPlaceholder: 'Text or pattern…',
  searchBudgetExhausted:
    'Stopped after {seconds}s, having read {searched} of {total} sessions. Anything not found may simply not have been reached: narrow it down with the source, instance or time filters.',
  searchLimitReached: 'Showing the first {n} matching sessions. There may be more.',
  searchedConversation:
    'Searched every conversation. Tool output, like file reads and command results, was not included.',
  searchEverything: 'Search everything instead',
  regexMode: 'Regex',
  regexModeHint: 'Treat the search text as a regular expression',
  caseSensitive: 'Case sensitive',
  searchButton: 'Search',
  searching: 'Searching…',
  searchFailed: 'Search failed.',
  bodySearchResultsFor: 'Content matches for “{query}”',
  backToSessionList: 'Back to session list',
  noBodyMatches: 'No sessions matched.',
  matchCount: '{n} match(es)',
  truncatedMatches: 'more not shown',

  // Migrate flyout groups (a closed target is NOT started: the chat lands in its store, settings
  // intact, for the app to find at its next start) and the multi-select bulk actions
  // (Ctrl/Cmd-click or Shift-click rows, then right-click one of them).
  migrateRunningGroup: 'Running',
  migrateClosedGroup: 'Not running - lands in its store, ready when it starts',
  migrateClosedMove: 'Move to {name}',
  copyNIds: 'Copy {n} session ids',
  migrateBulkLabel: 'Migrate {n} chats to another account',
  migrateConfirmTitle: 'Move {n} chats to {name}?',
  migrateConfirmBody:
    'Each chat is stopped if it is running, archived on its current account, and imported into {name}. They move one at a time; this cannot be undone in one step.',
  migrateConfirmCancel: 'Cancel',
  migrateConfirmSubmit: 'Move {n} chats',
  migrateBulkProgress: 'Moving chat {done} of {n}…',
  migrateBulkDone: 'Moved {ok} of {n} chats to {name}.',
  migrateBulkSomeFailed: '{failed} could not be moved; details are in the browser console.',
  // The chat list inside the bulk-move dialog: grouped by project, each row opens that chat.
  groupCount: '{n} chat(s)',
  dialogRowHint: 'Grouped by project. Click a chat to open it.',
  // AH-20: the first fetch failing is not the same fact as a genuinely empty list.
  unavailable: 'Could not load sessions: {reason}.',
  retry: 'Retry',
  staleHint: 'Showing the last known list — updates unavailable: {reason}.',
}
