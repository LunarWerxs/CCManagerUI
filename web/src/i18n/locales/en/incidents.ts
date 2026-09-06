export default {
  title: 'Incidents',
  whatIsIncidents:
    'A run that fails is grouped with earlier failures of the same project that hit the same ' +
    'error, instead of each one paging separately. The count is how many times it has happened; ' +
    'acknowledge to say you have seen it, resolve to close it out. If the same error comes back ' +
    'after that, the incident reopens.',
  openCount: '{n} open',
  ack: 'Ack',
  resolve: 'Resolve',
  occurrences: '{n}×',
  stateOpen: 'Open',
  stateAcked: 'Acked',
  stateResolved: 'Resolved',
  lastSeen: 'last seen {time}',
  toastAckFailed: 'Failed to acknowledge the incident.',
  toastResolveFailed: 'Failed to resolve the incident.',
  // AH-20: an outage must not read as "no incidents".
  unavailable: 'Could not load incidents: {reason}.',
  retry: 'Retry',
  staleHint: 'Showing the last known incidents — updates unavailable: {reason}.',
}
