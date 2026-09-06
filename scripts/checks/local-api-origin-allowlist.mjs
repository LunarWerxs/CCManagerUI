// Guardrail for a half-fix that adversarial verification caught (2026-09-06): a finding named a
// CLASS of entry points and the patch touched one of them.
//
// AgentHydra runs more than one local HTTP server. `server/src/index.ts` is the daemon;
// `server/src/instance-mode.ts` is the instances window, on its own loopback port. Audit item
// AH-11 asked both to stop trusting "any loopback origin" and to use an exact allowlist instead,
// because a browser treats every localhost PORT as a separate origin while the old rule treated
// them all as one: any page served by any other local port could drive these APIs cross-site, and
// on these routes that reaches instance create / open / quit and process launch.
//
// The AH-11 fix landed in index.ts, was marked closed, and instance-mode.ts kept the permissive
// guard for another day. Nothing failed; the closure just was not true of the whole class. So the
// rule is enforced here rather than remembered:
//
//   THE RULE: any file under server/src/ that stands up a local HTTP server (it calls Bun.serve)
//   must install the loopback guard in its EXACT-ORIGIN mode, i.e.
//   createLoopbackGuard({ allowedOrigins: ... }). The bare `loopbackGuard` export, which accepts
//   any loopback origin, is not enough for a server that can act on the machine.
//
// Deliberately narrow, so it cannot cry wolf:
//   · Only server/src/. The orchestrator's remote gateway (orchestrator/server) is a different
//     boundary with its own real authentication and ownership checks, not a loopback-trust model,
//     and holding it to this rule would be a false red.
//   · Binding the port is the signal. A module that merely builds routes on a shared Hono app
//     (every file under server/src/routes/, and http-app.ts itself) is not an entry point and is
//     not asked to guard anything; the file that serves it is.
//   · Only the guard is required. CORS matters too, but the guard is the boundary that REFUSES a
//     request; a permissive CORS header behind a refusing guard leaks nothing.
//
// Self-contained by design: imports nothing from the arkitect core, and returns plain finding
// objects, which the runner accepts as-is.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "local-api-origin-allowlist";

/**
 * BINDING THE PORT is the signal, and only that.
 *
 * The first cut of this check also required `new Hono()` in the same file, reasoning that an
 * entry point both builds an app and serves it. It does not: the daemon builds its app in
 * server/src/http-app.ts and index.ts only imports and serves it, so index.ts, the MAIN server,
 * was silently not checked and the report cheerfully said "all 1 entry point(s) ✓". That is the
 * same false green this file was written to prevent, one level up, which is why the anchor below
 * exists. Whoever calls Bun.serve is the process answering the socket, and is the one that must
 * install the guard.
 */
const BINDS_PORT = /Bun\s*\.\s*serve\s*\(/;
/** An entry point that must always be found. If it stops matching, the detection has drifted and
 *  a pass means nothing; see the comment above for the day that actually happened. */
const ANCHOR = "server/src/index.ts";
/** The exact-origin mode. `createLoopbackGuard()` with no options is the permissive default, so
 *  the `allowedOrigins` option is the thing being required, not merely the function name. */
const EXACT_ORIGIN_GUARD = /createLoopbackGuard\s*\(\s*\{[^}]*allowedOrigins/s;

const SCAN_DIR = join("server", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "tmp", "coverage", "build", "data"]);
const EXTS = [".ts", ".mts", ".mjs"];

const SELF = fileURLToPath(import.meta.url);

/** Are these two paths the same FILE? Windows does not treat case as part of a file's identity,
 *  and Bun and Node disagree about which casing they hand back for the same path, so a
 *  case-sensitive compare can silently fail to match and turn the CLI block below into a no-op.
 *  A gating check that quietly checks nothing is worse than one that fails loudly. */
function samePath(a, b) {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * The rule as a pure function of ONE file's text, which is the shape the guardrail fixtures in
 * tests/guardrails.test.ts exercise: a file that does not bind a port is not an entry point and is
 * never a violation; one that binds a port without the exact-origin guard always is.
 */
export function findViolations(text) {
  if (!BINDS_PORT.test(text)) return [];
  if (EXACT_ORIGIN_GUARD.test(text)) return [];
  const line = text.split(/\r?\n/).findIndex((l) => BINDS_PORT.test(l)) + 1;
  return [
    {
      id: ID,
      line: line || 1,
      message:
        "stands up a local HTTP server but does not install the loopback guard in exact-origin " +
        "mode. Pass createLoopbackGuard({ allowedOrigins: () => <list> }), built with " +
        "apiOriginAllowlist() from server/src/api-origins.ts. Without it, a page on any other " +
        "localhost port can drive this API cross-site (audit AH-11).",
    },
  ];
}

export const audit = {
  id: ID,
  title: "Local API servers must use an exact-origin allowlist, not any loopback origin",
  gating: true,
  async run({ root = process.cwd() } = {}) {
    const files = walk(join(root, SCAN_DIR), []);
    const entryPoints = [];
    const findings = [];
    for (const file of files) {
      if (samePath(resolve(file), resolve(SELF))) continue;
      let src;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!BINDS_PORT.test(src)) continue;
      const rel = relative(root, file).replace(/\\/g, "/");
      entryPoints.push(rel);
      // ONE implementation of the rule, shared with the fixtures in tests/guardrails.test.ts:
      // see findViolations above.
      for (const v of findViolations(src)) {
        findings.push({ ...v, file: rel, message: `${rel} ${v.message}` });
      }
    }
    // Not finding the anchor means the detection stopped matching the code, not that the fleet is
    // clean. Reporting that as a pass is exactly the false green this check exists to prevent, and
    // it is not hypothetical: the first cut of this check missed the anchor and passed. So a miss
    // is a failure with its own message.
    if (!entryPoints.includes(ANCHOR)) {
      findings.push({
        id: ID,
        file: SCAN_DIR.replace(/\\/g, "/"),
        line: 1,
        message:
          `did not find the expected entry point ${ANCHOR} among {${entryPoints.join(", ") || "none"}}. ` +
          "The detection has drifted from the code; fix this check rather than trusting its pass.",
      });
    }
    const failed = findings.length > 0;
    const report = failed
      ? `Local API origin allowlist: ${findings.length} problem(s):\n` +
        findings.map((f) => `- ${f.file}:${f.line} ${f.message}`).join("\n")
      : `All ${entryPoints.length} local HTTP entry point(s) use the exact-origin allowlist ` +
        `(${entryPoints.join(", ")}). ✓`;
    return { failed, findings, report };
  },
};

// Standalone CLI (used by CI): prints the report and exits 1 on any violation. Under an arkitect
// run the module is only imported, so this block stays inert there.
if (process.argv[1] && samePath(resolve(fileURLToPath(import.meta.url)), resolve(process.argv[1]))) {
  const res = await audit.run({ root: process.cwd() });
  console.log(res.report);
  if (res.failed) process.exit(1);
}
