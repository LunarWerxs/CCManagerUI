// Session composer — the chat-style input at the bottom of the transcript pane.
export default {
  placeholder: 'Message this session. Enter to send, Shift+Enter for a new line',
  placeholderMulti: 'Message {n} sessions. Enter to send to each',
  sendingToN: 'Sending to {n} sessions',
  send: 'Send',
  sendHint:
    'Deliver this into the chat now. Enter sends, Shift+Enter adds a line. A busy chat refuses honestly instead of queuing behind it — headless runs are off.',
  toastSent: 'Sent to {n} session(s)',
  toastFailed: 'Failed for {n} session(s)',
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
