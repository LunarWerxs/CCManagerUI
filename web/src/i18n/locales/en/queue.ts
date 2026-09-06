export default {
  title: 'Run queue',
  // AH-12: dispatching (Run, Run Due, the scheduler) is disabled by policy — AgentHydra never
  // runs a chat nobody can see — so this now describes the queue as a history/editing view rather
  // than a thing that can still dispatch.
  whatIsQueue:
    'Each item records a claude CLI run — its prompt, working directory, model, effort, ' +
    'permission mode, and account. New runs and dispatch (Run, the scheduler) are disabled by ' +
    'policy: AgentHydra never runs a chat nobody can see. Existing items can still be edited or ' +
    'deleted; to get work done, reply in the session’s own desktop chat, use fan_out, or import ' +
    'it into a desktop app.',
  schedulerOnLabel: 'Scheduler on',
  schedulerOffLabel: 'Scheduler off',
  schedulerOnHint: 'Queued items dispatch automatically. Toggle it in Settings → Scheduler.',
  schedulerOffHint:
    'Nothing runs by itself. Press Run on an item, or enable the scheduler in Settings.',
  schedulerClickHint: 'Click to open the scheduler settings',
  newRun: 'New run',
  itemsCount: '{n} item(s)',
  edit: 'Edit',
  scheduledFor: 'runs {time}',
  // Shown on a FINISHED run that has not landed in its target desktop app yet. Importing needs
  // that instance to be open, so a run that ended overnight waits for it rather than vanishing.
  deliveryPending: 'waiting to appear in the app',
  deliveryFailed: 'never appeared in the app',
  // AH-12: AgentHydra never runs a chat nobody can see (headless-policy.ts) — queuing or
  // dispatching a run is disabled by policy. Replaces newRun/queueARun/run's working state and the
  // Run Due control, which used to dispatch every due item and now would only fail each one.
  createUnavailableHint:
    'Disabled: AgentHydra never runs a chat nobody can see. Reply straight into the session’s own desktop chat, use fan_out from an MCP client, or import the session into a desktop app.',
  runUnavailableHint:
    'Disabled: headless runs are off by policy, so this can never dispatch. Reply in the session’s desktop chat, use fan_out, or import it into a desktop app.',
  empty: 'Queue is empty.',
  queueARun: 'Queue a run',
  toggleLiveOutput: 'Toggle live output',
  newChat: 'new chat',
  fork: 'fork',
  exit: 'exit',
  runNow: 'Run now',
  run: 'Run',
  cancel: 'Cancel',
  stop: 'Stop',
  delete: 'Delete',
  toastCancelFailed: 'Failed to cancel the run.',
  toastDeleteFailed: 'Failed to delete the queue item.',
  showFinished: 'Show {n} finished',
  hideFinished: 'Hide finished',
  showDiedOnly: "Only the {n} that didn't finish",
  showAllFinished: 'Show all finished',
  clearFinished: 'Clear',
  clearFinishedConfirm: 'Clear them?',
  clearFinishedTitle: 'Delete every finished run from the queue',
  toastCleared: 'Cleared {n} finished run(s)',
  toastClearFailed: "Couldn't clear {n} run(s)",
  allDone: 'Nothing left to run.',
  exitCode: 'Exit {code}',
  exitLost: 'interrupted',
  exitLostHint:
    'The run was cut off before it finished. The process was killed, or AgentHydra restarted under it. Whatever it had already done is on disk; open the session to see how far it got.',
  deletedInstance: '(deleted instance)',
  // AH-20: an outage must not read as an empty queue.
  unavailable: 'Could not load the queue: {reason}.',
  retry: 'Retry',
  staleHint: 'Showing the last known queue — updates unavailable: {reason}.',
}
