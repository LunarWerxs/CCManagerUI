/**
 * Shared cross-site (CSRF) guard for the LunarWerx loopback daemons — the single audited copy
 * that agenthydra / RepoYeti / ReDesign / DevWebUI all vendor. Synced from the shared kit, do
 * not edit in an app (change it here + re-sync).
 *
 * THE THREAT (classic local-daemon CSRF — the Jupyter/Selenium/dev-server CVE class): each app is
 * a Bun+Hono daemon binding `127.0.0.1:<port>` with a REST API that, on the local path, is
 * UNAUTHENTICATED by design (a single-user tool on the owner's machine). But "loopback + no auth"
 * is NOT private: a browser lets ANY web page the owner visits POST to `http://127.0.0.1:<port>`.
 * Without a guard, a malicious page could drive a mutating route — run a queued `claude`, set a git
 * remote + push, open a file — with the owner's own credentials, no approval: a drive-by RCE. A
 * cross-site GET could also exfiltrate local data.
 *
 * THE DEFENSE (no tokens, no client changes, robust to the "simple request" CORS bypass): the
 * browser itself stamps the request's provenance in headers page JS CANNOT forge —
 *   · `Sec-Fetch-Site` — set by the browser on every fetch/navigation. Another site gets
 *     `cross-site`; the app's own SPA gets `same-origin`; the dev SPA (Vite :5173 → daemon) gets
 *     `same-site`. It is a Forbidden header — page script cannot override it. Reject `cross-site`.
 *   · `Origin` — present on all cross-origin requests, INCLUDING a "simple" text/plain POST that
 *     skips CORS preflight (the exact bypass a CORS-only fix misses). Present + non-loopback host →
 *     reject. This also stops DNS-rebinding (evil.com's A-record → 127.0.0.1: the page's Origin is
 *     still evil.com).
 *   · `Host` — a PRESENT non-loopback Host is rejected (a second rebinding backstop, and the one
 *     signal left when a same-origin GET omits Origin). An ABSENT Host is allowed: a real browser
 *     ALWAYS sends Host, so no-Host-at-all is a non-browser client (curl/tray/MCP/an HTTP tool) —
 *     not a browser-CSRF vector — consistent with an absent Origin being allowed.
 * A request with none of these browser markers (curl, the tray probe, an MCP client) is allowed —
 * those are same-machine tools the owner ran deliberately; a local shell attacker already owns the
 * session. The threat is specifically the *browser* drive-by.
 *
 * WIRING IS APP-LOCAL (this module is guard LOGIC only): a loopback-only daemon wires it as
 * `app.use('/api/*', loopbackGuard)`; a daemon that is ALSO exposed over a tunnel (RepoYeti) runs
 * it ONLY on the local path — `app.use('/api/*', (c, next) => isRemoteRequest(c) ? next() :
 * loopbackGuard(c, next))` — because a genuine tunnel request legitimately carries a non-loopback
 * Host/Origin and is CSRF-gated by its own SameSite session cookie + auth instead. Never apply it
 * to `/oauth/*` (those are legit cross-site OAuth returns). Narrowing `cors()` to loopback origins
 * (via `isLoopbackOrigin`) is a worthwhile defense-in-depth for reads, but the guard — not CORS —
 * is what stops the write: CORS governs response READABILITY, and the CSRF damage is done the
 * moment the request is PROCESSED.
 */

/** Hostname is loopback (the only interface these daemons bind). Accepts IPv4/IPv6 loopback + the
 *  `localhost` name; strips a `:port` and IPv6 brackets first. */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  // host may be "127.0.0.1:7171", "localhost:7171", "[::1]:7171"
  let host = hostHeader.trim().toLowerCase();
  // strip IPv6 brackets + port
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    host = close >= 0 ? host.slice(1, close) : host.slice(1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** The origin string (scheme://host[:port]) has a loopback host. For narrowing a CORS allowlist. */
export function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

/** The Origin header's host is loopback (or the header is absent — many legitimate same-origin
 *  requests omit it). A present, non-loopback Origin is a cross-site/rebinding request → block. */
function originIsLoopbackOrAbsent(originHeader) {
  if (!originHeader || originHeader === "null") return originHeader !== "null"; // 'null' origin (sandboxed/file) is NOT trusted
  try {
    return isLoopbackHost(new URL(originHeader).host);
  } catch {
    return false; // unparseable Origin → treat as untrusted
  }
}

/**
 * Pure decision function (exported for tests): should this request's headers be allowed?
 *
 * OPT-IN EXACT-ORIGIN MODE (AH-11): by default (no `options.allowedOrigins`) an Origin is
 * accepted whenever it is LOOPBACK, any port — the long-standing behaviour every app below still
 * gets. That is too loose for an app whose loopback API holds session-scoped data or mutating
 * routes: per the Fetch spec, a page served from ANY local port is "same-site" (a site ignores the
 * port), so a dev server, a preview, or another local daemon's page can carry browser-forged
 * `Sec-Fetch-Site: same-site`/absent-Origin-style requests here too. Pass `options.allowedOrigins`
 * (a THUNK — the caller's own origin is typically only known after it binds, so it must be read
 * lazily, per request, not captured at wiring time) to require a PRESENT Origin to match one of
 * those origins byte-for-byte; a request with NO Origin (curl, MCP clients, the tray) still passes
 * as it always has, since it carries no browser provenance to check.
 * @param {{ secFetchSite?: string, origin?: string, host?: string }} headers
 * @param {{ allowedOrigins?: () => string[] }} [options]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateRequest(headers, options = {}) {
  const { allowedOrigins } = options;
  // 1. Sec-Fetch-Site: a modern browser's unforgeable provenance signal. Only `cross-site` is a
  //    drive-by from another origin; `same-origin`/`same-site`/`none` are our SPA (or the dev SPA,
  //    or a top-level navigation the user typed). Absent → non-browser client, allowed.
  if (headers.secFetchSite && headers.secFetchSite.toLowerCase() === "cross-site") {
    return { ok: false, reason: "cross-site request rejected" };
  }
  if (allowedOrigins) {
    // Exact-origin mode: a present Origin (including 'null') must match the allowlist exactly;
    // any other loopback origin — a foreign local port included — is refused. No Origin at all
    // (non-browser client) is unaffected and falls through to the Host check below.
    if (headers.origin) {
      if (headers.origin === "null" || !allowedOrigins().includes(headers.origin)) {
        return { ok: false, reason: "origin not in allowlist" };
      }
    }
  } else if (!originIsLoopbackOrAbsent(headers.origin)) {
    // 2. Default mode: Origin present but non-loopback → cross-origin write / DNS-rebinding, even
    //    without a Sec-Fetch-Site header (older browsers) or on a "simple" no-preflight POST.
    return { ok: false, reason: "non-loopback Origin rejected" };
  }
  // 3. A PRESENT Host must be loopback (a browser rebinding evil.com → 127.0.0.1 sends
  //    Host: evil.com, and may omit Origin on a same-origin GET, so Host is the one signal left).
  //    An ABSENT Host is a non-browser client (a real browser always sends Host) → allowed.
  if (headers.host && !isLoopbackHost(headers.host)) {
    return { ok: false, reason: "non-loopback Host rejected" };
  }
  return { ok: true };
}

/**
 * Build a Hono middleware for the loopback API surface (see WIRING note in the file header).
 * Blocks browser cross-site requests with 403; lets same-origin (SPA), same-site (dev), and
 * non-browser (curl/tray/MCP) requests through. Pass `{ allowedOrigins }` for the opt-in
 * exact-origin mode documented on `evaluateRequest` above; omit it for the long-standing
 * any-loopback-port behaviour.
 * @param {{ allowedOrigins?: () => string[] }} [options]
 * @returns {import("hono").MiddlewareHandler}
 */
export function createLoopbackGuard(options = {}) {
  return async (c, next) => {
    const verdict = evaluateRequest(
      {
        secFetchSite: c.req.header("sec-fetch-site"),
        origin: c.req.header("origin"),
        host: c.req.header("host"),
      },
      options,
    );
    if (!verdict.ok) {
      return c.json({ error: `forbidden: ${verdict.reason}` }, 403);
    }
    await next();
  };
}

/** The default-mode guard (no exact-origin allowlist) — what every app used before AH-11. */
export const loopbackGuard = createLoopbackGuard();
