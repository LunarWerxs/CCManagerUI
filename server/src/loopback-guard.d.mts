/**
 * Shared cross-site (CSRF) guard for the LunarWerx loopback daemons. Rejects browser cross-site
 * requests (Sec-Fetch-Site: cross-site, a present non-loopback Origin/Host) while letting
 * same-origin, same-site (dev), and non-browser (curl/tray/MCP) requests through. Wiring is
 * app-local — see loopback-guard.mjs. Synced from the shared kit; do not edit in an app.
 */
import type { MiddlewareHandler } from "hono";

export interface LoopbackGuardResult {
  ok: boolean;
  reason?: string;
}

/** Opt-in exact-origin mode (AH-11) — see evaluateRequest/createLoopbackGuard doc comments. */
export interface LoopbackGuardOptions {
  allowedOrigins?: () => string[];
}

/** The origin string (scheme://host[:port]) has a loopback host. For narrowing a CORS allowlist. */
export function isLoopbackOrigin(origin: string): boolean;

/** Pure decision function (for tests): should this request's headers be allowed? */
export function evaluateRequest(
  headers: {
    secFetchSite?: string;
    origin?: string;
    host?: string;
  },
  options?: LoopbackGuardOptions,
): LoopbackGuardResult;

/** Build a Hono middleware; pass `{ allowedOrigins }` for the opt-in exact-origin mode. */
export function createLoopbackGuard(options?: LoopbackGuardOptions): MiddlewareHandler;

/** The default-mode guard (no exact-origin allowlist): reject browser cross-site requests to the
 *  loopback API with 403, accepting any loopback-port Origin. */
export const loopbackGuard: MiddlewareHandler;
