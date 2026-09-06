// AH-12: mirrors server/src/headless-policy.ts's headlessRunsAllowed(), which is a hardcoded
// `false` (owner law 2026-08-27, restated 2026-08-31: "I have zero interest of you ever using
// headless" — there is no setting for it). POST /api/queue refuses every creation with a 409
// before it looks at anything else in the body, and POST /api/queue/:id/run (and the scheduler,
// and run-due) fail the same way a moment after reporting "started". No client-side check can make
// those calls succeed — this constant exists so the UI can say so up front instead of discovering
// it by clicking, and so every place that says so is deciding it from ONE flag rather than
// duplicating the reasoning. Not imported from the server (the web bundle doesn't pull in server
// code): if headless-policy.ts is ever un-hardcoded, flip this alongside it.
export const HEADLESS_QUEUEING_ENABLED = false as const
