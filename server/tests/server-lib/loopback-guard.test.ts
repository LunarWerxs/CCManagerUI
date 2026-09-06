/**
 * Shared cross-site CSRF defense — the pure `evaluateRequest`/`isLoopbackOrigin` decision logic
 * (src/loopback-guard.mjs). Every LunarWerx loopback daemon vendors this test. The app-LOCAL
 * wiring (loopback-only vs tunnel-aware vs per-route) is exercised by each app's own integration
 * test, not here. Synced from the shared kit; do not edit in an app.
 */
import { describe, expect, test } from "bun:test";
import { evaluateRequest, isLoopbackOrigin } from "../../src/loopback-guard.mjs";

const LOOPBACK_HOST = "127.0.0.1:7777";
const OWN_ORIGIN = "http://127.0.0.1:7777";
const allowedOrigins = () => [OWN_ORIGIN, "http://localhost:5173"];

describe("loopback-guard: cross-site CSRF defense (evaluateRequest)", () => {
  test("SPA same-origin request is allowed", () => {
    expect(
      evaluateRequest({
        secFetchSite: "same-origin",
        origin: "http://127.0.0.1:7777",
        host: LOOPBACK_HOST,
      }).ok,
    ).toBe(true);
  });

  test("dev SPA (:5173 -> daemon, same-site) is allowed", () => {
    expect(
      evaluateRequest({
        secFetchSite: "same-site",
        origin: "http://127.0.0.1:5173",
        host: LOOPBACK_HOST,
      }).ok,
    ).toBe(true);
    // localhost hostname variant too
    expect(
      evaluateRequest({
        secFetchSite: "same-site",
        origin: "http://localhost:5173",
        host: "localhost:7777",
      }).ok,
    ).toBe(true);
  });

  test("non-browser client (curl / tray / MCP: no browser headers) is allowed", () => {
    expect(evaluateRequest({ host: LOOPBACK_HOST }).ok).toBe(true);
  });

  test("no headers at all (a raw non-browser client / HTTP tool) is allowed", () => {
    // A real browser always sends Host, so no-Host-at-all is a non-browser client, not a CSRF
    // vector — allowed, exactly like an absent Origin. Only a PRESENT non-loopback Host is rejected.
    expect(evaluateRequest({}).ok).toBe(true);
  });

  test("THE ATTACK: a malicious page cross-site request is REJECTED (Sec-Fetch-Site)", () => {
    const v = evaluateRequest({
      secFetchSite: "cross-site",
      origin: "https://evil.example",
      host: LOOPBACK_HOST,
    });
    expect(v.ok).toBe(false);
  });

  test("simple no-preflight cross-origin POST (no Sec-Fetch-Site) still caught by Origin", () => {
    // An older browser or a "simple" request may omit Sec-Fetch-Site, but a cross-origin POST
    // still carries Origin — the CORS-bypass a naive fix misses.
    const v = evaluateRequest({ origin: "https://evil.example", host: LOOPBACK_HOST });
    expect(v.ok).toBe(false);
  });

  test("DNS rebinding (evil.com A-record -> 127.0.0.1) caught by Host + Origin", () => {
    // The page is served from evil.com which resolves to 127.0.0.1; from the browser it looks
    // same-origin (Sec-Fetch-Site: same-origin) but Host + Origin are evil.com.
    const v = evaluateRequest({
      secFetchSite: "same-origin",
      origin: "http://evil.com",
      host: "evil.com",
    });
    expect(v.ok).toBe(false);
  });

  test("a 'null' opaque origin (sandboxed iframe / file://) is rejected", () => {
    expect(evaluateRequest({ origin: "null", host: LOOPBACK_HOST }).ok).toBe(false);
  });

  test("a PRESENT non-loopback Host (rebinding backstop) is rejected", () => {
    expect(evaluateRequest({ host: "attacker.test" }).ok).toBe(false);
  });

  test("isLoopbackOrigin helper", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:7777")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:9999")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:7777")).toBe(true);
    expect(isLoopbackOrigin("https://evil.example")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

describe("loopback-guard: opt-in exact-origin mode (AH-11)", () => {
  test("no Origin at all still passes (curl / tray / MCP)", () => {
    expect(evaluateRequest({ host: LOOPBACK_HOST }, { allowedOrigins }).ok).toBe(true);
  });

  test("the daemon's own origin passes", () => {
    expect(
      evaluateRequest(
        { secFetchSite: "same-origin", origin: OWN_ORIGIN, host: LOOPBACK_HOST },
        { allowedOrigins },
      ).ok,
    ).toBe(true);
  });

  test("a configured dev origin passes", () => {
    expect(
      evaluateRequest(
        { secFetchSite: "same-site", origin: "http://localhost:5173", host: LOOPBACK_HOST },
        { allowedOrigins },
      ).ok,
    ).toBe(true);
  });

  test("THE HOLE THIS CLOSES: an unconfigured loopback origin on another port is refused", () => {
    // Same-site per the Fetch spec (a site ignores the port), so the default any-loopback-port
    // mode would allow this; exact-origin mode must not.
    const v = evaluateRequest(
      { secFetchSite: "same-site", origin: "http://127.0.0.1:9999", host: LOOPBACK_HOST },
      { allowedOrigins },
    );
    expect(v.ok).toBe(false);
  });

  test("a 'null' opaque origin is refused even in exact-origin mode", () => {
    expect(evaluateRequest({ origin: "null", host: LOOPBACK_HOST }, { allowedOrigins }).ok).toBe(
      false,
    );
  });

  test("the existing non-loopback / cross-site rejections still hold", () => {
    expect(
      evaluateRequest(
        { secFetchSite: "cross-site", origin: "https://evil.example", host: LOOPBACK_HOST },
        { allowedOrigins },
      ).ok,
    ).toBe(false);
    expect(
      evaluateRequest({ origin: "https://evil.example", host: LOOPBACK_HOST }, { allowedOrigins })
        .ok,
    ).toBe(false);
    expect(evaluateRequest({ host: "attacker.test" }, { allowedOrigins }).ok).toBe(false);
  });
});
