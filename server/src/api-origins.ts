// server/src/api-origins.ts - the one allowlist of browser origins allowed to call a local API.
//
// WHY THIS IS SHARED AND NOT INLINE. This process is not the only local HTTP server AgentHydra
// runs: index.ts serves the daemon and instance-mode.ts serves the instances window, each on its
// own loopback port. AH-11 (audit, 2026-09-05) asked for an exact-origin allowlist instead of
// "any loopback port", and the first fix landed in index.ts ONLY. Adversarial verification of that
// closure found instance-mode.ts still accepting any loopback origin, so a page served by any
// other localhost port could drive instance create / open / quit from a browser. That is the
// classic shape of a half-fix: the finding named a class of entry points and the patch touched
// one. Both now call this, and scripts/checks/local-api-origin-allowlist.mjs fails the build if a
// third local server ever appears without it.
//
// WHAT IS AND IS NOT DEFENDED. This stops a BROWSER on another origin from driving the API
// (drive-by CSRF, which on these routes reaches process launch). It is not authentication: a
// request with no Origin header at all - curl, the MCP client, the tray host - still passes,
// because those are local tools acting for the user and no browser can forge that absence
// cross-site. See loopback-guard.mjs for the request-side half of the rule.

/**
 * Every origin allowed to call this server's API, from the origin it is itself bound to.
 *
 * Both host spellings are included because a browser treats `http://127.0.0.1:P` and
 * `http://localhost:P` as different origins while a person treats them as the same address, and
 * the app's own window may be opened at either. `AGENTHYDRA_DEV_ORIGINS` (comma-separated) adds
 * the Vite dev server during development; it is read fresh on every call, never cached, so a test
 * can set it per case.
 */
export function apiOriginAllowlist(
  ownOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const origins = new Set<string>()
  if (ownOrigin) origins.add(ownOrigin)
  try {
    const u = new URL(ownOrigin)
    const port = u.port ? `:${u.port}` : ''
    if (u.hostname === '127.0.0.1') origins.add(`${u.protocol}//localhost${port}`)
    else if (u.hostname === 'localhost') origins.add(`${u.protocol}//127.0.0.1${port}`)
  } catch {
    // An unparseable own origin (should not happen) simply gets no alternate spelling. It is
    // never a reason to widen the list.
  }
  for (const dev of (env.AGENTHYDRA_DEV_ORIGINS ?? '').split(',')) {
    const trimmed = dev.trim()
    if (trimmed) origins.add(trimmed)
  }
  return [...origins]
}
