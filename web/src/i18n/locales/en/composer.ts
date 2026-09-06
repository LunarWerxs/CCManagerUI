// Session composer — the chat-style input at the bottom of the transcript pane.
export default {
  placeholder: 'Message this session. Enter to send, Shift+Enter for a new line',
  placeholderMulti: 'Message {n} sessions. Enter to send to each',
  sendingToN: 'Sending to {n} sessions',
  busyHintAuto:
    'This session is busy, so your message will queue and start on its own once the current run finishes (two runs cannot share one session).',
  busyHintManual:
    'This session is busy, so your message will queue behind the current run. The scheduler is off, so it waits until you press Run.',
  send: 'Send',
  sendHint: 'Start this message now. Enter sends, Shift+Enter adds a line.',
  queue: 'Queue',
  queueForLater: 'Queue for later — pick a time',
  queueNow: 'Queue now',
  queueMoreHint: 'Other queue options',
  clearOption: 'Default',
  // Each chip is an OVERRIDE for this one message; left alone, the session keeps whatever it was
  // already running with. The hints say so, because an icon on its own cannot.
  chipModel: 'Model',
  chipModelHint:
    'Which model answers this message. Left alone, it stays on whatever this chat is already using.',
  chipEffort: 'Effort',
  chipEffortHint:
    "How much reasoning to spend on this message. Left alone, it stays on the session's own setting.",
  chipPermission: 'Permissions',
  chipPermissionHint:
    "How much this run may do without stopping to ask. Left alone, it stays on the session's own mode.",
  chipAccount: 'Account',
  chipAccountHint:
    'Which login this message runs under. By default it uses the desktop instance this chat belongs to, so it stays on the same account the conversation was already using.',
  accountAuto: "Auto (this chat's own instance)",
  accountAutoNamed: 'Auto · {instance}',
  cwdPopoverLabel: 'Working directory override',
  cwdPopoverHint: "Leave empty to use the session's own directory.",
  toastStarted: 'Started {n} run(s)',
  toastQueued: 'Queued {n} message(s)',
  toastMixed: 'Started {ran} run(s), queued {queued}',
  toastFailed: 'Failed for {n} session(s)',
  schedulerOffHint: 'Scheduler is off; queued messages only run when you press Run.',
  viewQueue: 'View queue',
  chatGptHandoff: 'ChatGPT',
  chatGptHandoffHint:
    'Download a scoped repository context file, copy this task, and open ChatGPT. You review and submit it manually.',
  chatGptReady: 'ChatGPT opened. Prompt copied and context downloaded.',
  chatGptReadyWithoutClipboard:
    'ChatGPT opened and context downloaded. The task is included in the file.',
  chatGptAttachHint: 'Attach the downloaded context file. It contains {files} source files.',
  chatGptHandoffFailed: 'Failed to prepare the ChatGPT handoff.',
  // AH-26: fallback only — the server's own error string is preferred when present.
  sendFailedFallback: 'Failed to send.',
}
