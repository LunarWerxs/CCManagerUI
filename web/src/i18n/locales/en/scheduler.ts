export default {
  off: 'Scheduler off',
  idle: 'Scheduler idle',
  running: '{n} running',
  dispatching: 'Dispatching {n}',
  nextIn: 'Next in {time}',
  onTooltip:
    'The scheduler is on: queued items dispatch automatically, respecting your spacing and concurrency limits. A spinner means a run is executing now; a countdown is the next scheduled item.',
  offTooltip:
    'The scheduler is off; nothing runs on its own. Turn it on here, or press Run on a queued item.',
  clickToToggle: 'Click to turn it on or off.',
  // The chip's popover: the on/off switch used to be a Settings row three clicks away, even though
  // the chip beside it already reported the state it controls.
  enabledLabel: 'Auto-dispatch queued items',
  countsLine: '{running} running · {queued} queued',
  advancedLink: 'Spacing, poll and concurrency…',

  // --- the shared "run at…" panel (SchedulePanel.vue) ---
  // These used to live under composer.*, back when the chat composer was the only thing that could
  // schedule. The queue builder now shows the same panel, so they belong to the scheduler.
  scheduleTitle: 'Run at…',
  presetIn5h: 'In 5 hours',
  presetTomorrow: 'Tomorrow {time}',
  presetInHM: 'In {h}h {m}m',
  presetInHours: 'In {h}h',
  presetInMinutes: 'In {m}m',
  hoursValue: '{n}h',
  minutesValue: '{n}m',
  hoursDecrease: 'One hour less',
  hoursIncrease: 'One hour more',
  minutesDecrease: 'Ten minutes less',
  minutesIncrease: 'Ten minutes more',
  // No longer "(Settings → Scheduler)": the gear edits the value in place now.
  editTomorrowTime: 'Change this time',
  schedulePickLabel: 'Or pick a date & time',
  scheduleConfirm: 'Queue for then',
  scheduleUseTime: 'Use this time',
  scheduleClear: 'Clear',
  scheduleNotSet: 'Run as soon as it can',
  // AH-20: distinct from `off` — the daemon could not even be asked.
  unavailable: 'Scheduler unavailable',
  unavailableHint: 'Could not read scheduler status: {reason}.',
}
