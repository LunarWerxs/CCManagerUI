// LunarWerx shared MCP engine, the canonical JSON-RPC 2.0 / MCP dispatch + newline-delimited
// stdio loop, shared by every sibling app's MCP server (RepoYeti, Reimagine, ...). Synced verbatim
// into each app's server tree by sync.mjs; edit HERE, never the synced copies.
//
// Zero dependencies and runtime-agnostic (runs identically under Bun and Node): it touches only
// `process.stdin` / `process.stdout` and, indirectly, whatever the caller's tools do. Each app
// supplies its own `serverInfo` + a `tools` array, `{ name, description, inputSchema, run(args) }`,
// each tool a thin proxy to that app's own HTTP API, and this engine owns everything protocol:
// the initialize / ping / tools/list / tools/call switch, the JSON-RPC error envelopes, the
// tool-error → MCP `isError` result wrapping, and the stdin→dispatch→stdout loop.
//
// STDOUT is the protocol channel, only JSON-RPC responses (one per line) are ever written there;
// diagnostics go to STDERR so a stray log can't corrupt the stream.
//
// CONCURRENCY (AH-10, 2026-09-05): requests used to be dispatched strictly one-at-a-time — the
// reader `await`ed each `tools/call` before it would even look at the next line — so a long-
// running orchestrator tool blocked a subsequent `ping`/`tools/list`/fast tool on the SAME
// connection until it finished. `runMcpStdio` now dispatches every request concurrently (bounded
// by `maxInFlight`, default 8) as soon as its line is read; each response still carries its own
// JSON-RPC id, so answers may legitimately arrive out of request order. A request registry
// (id -> { method, startedAt, controller }) lets a `notifications/cancelled` for a live id abort
// its `AbortSignal`. `handleRpc`/`processLine` stay pure single-message dispatch (no IO, no
// concurrency policy) so any other caller (an in-process HTTP endpoint, a test) still gets the old
// call-it-per-message contract; they simply accept an optional `signal` now.

const PROTOCOL_VERSION = "2024-11-05";

/** Default cap on requests dispatched concurrently by `runMcpStdio` (see `opts.maxInFlight`). */
const DEFAULT_MAX_IN_FLIGHT = 8;

/** Standard JSON-RPC error codes we use. */
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

const rpcResult = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** A -32700 parse-error response (id null), used by transports on malformed input. */
export function parseErrorResponse() {
  return rpcError(null, ERR.PARSE, "Parse error");
}

/** Trim + JSON.parse one raw stdio line. `{blank:true}` for a blank/whitespace line, `{parseError:
 *  true}` for invalid JSON, otherwise `{msg}` with the parsed value (of any JSON type). Shared by
 *  `processLine` and the `runMcpStdio` loop so the two never disagree on what counts as blank. */
function parseStdioLine(line) {
  const trimmed = String(line).trim();
  if (trimmed === "") return { blank: true };
  try {
    return { msg: JSON.parse(trimmed) };
  } catch {
    return { parseError: true };
  }
}

/** `initialize` — negotiate the protocol version and hand back this app's serverInfo (+ optional
 *  standing instructions). Split out of handleRpc so the dispatch switch reads as a dispatch
 *  table and each method's own logic lives in its own named function. */
function handleInitialize(id, msg, ctx) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const protocolVersion =
    typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: ctx.serverInfo,
    // `instructions` is the MCP handshake's one channel for STANDING guidance: the client
    // shows it to the model once per session, before any tool is called. That is the only
    // place an app can say "here is how to use me" without a human typing it into every
    // prompt, and without paying for it again on every tool result. Omitted entirely when the
    // app supplies none, since an empty string is a field the client still has to render.
    ...(typeof ctx.instructions === "string" && ctx.instructions.trim()
      ? { instructions: ctx.instructions }
      : {}),
  });
}

/** `tools/list` — the tool catalog this app's ctx supplies, trimmed to the MCP-visible fields. */
function handleToolsList(id, ctx) {
  return rpcResult(id, {
    tools: ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
}

/** `tools/call` — look up the named tool and run it, turning a thrown error into an MCP `isError`
 *  result (not a JSON-RPC protocol error) so the agent can read and react to it like any other
 *  tool output. `signal` (an AbortSignal, present when called from `runMcpStdio`) is passed through
 *  to `tool.run` as a second argument; a tool that doesn't declare that parameter simply ignores
 *  it, so this is backward-compatible with every existing tool. */
async function handleToolsCall(id, msg, ctx, signal) {
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  const tool = ctx.tools.find((t) => t.name === name);
  if (!tool) return rpcError(id, ERR.INVALID_PARAMS, `Unknown tool: ${name || "(none)"}`);
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  try {
    const value = await tool.run(args, signal);
    const content = [{ type: "text", text: JSON.stringify(value, null, 2) }];
    if (signal?.aborted) {
      // A `notifications/cancelled` arrived for this id, but the tool doesn't check `signal`
      // (or checked and pressed on anyway), so it ran to completion regardless — say so rather
      // than silently returning the result as if no cancellation had ever been requested.
      content.push({
        type: "text",
        text: "Note: a cancellation was requested for this call, but the tool does not support cancellation and ran to completion.",
      });
    }
    return rpcResult(id, { content });
  } catch (e) {
    const text = signal?.aborted
      ? `Cancelled: ${e?.message ? e.message : String(e)}`
      : e?.message
        ? e.message
        : String(e);
    return rpcResult(id, { content: [{ type: "text", text }], isError: true });
  }
}

/**
 * Dispatch one parsed JSON-RPC message against `ctx` ({ serverInfo, tools }). Returns the response
 * object, or null when the message is a notification (no `id`), the caller must then emit nothing.
 * Pure (no IO): both a stdio server and an in-process HTTP endpoint can share it. `signal` (an
 * optional AbortSignal) is threaded through to a `tools/call`'s tool.run; every other method
 * ignores it.
 */
export async function handleRpc(msg, ctx, signal) {
  if (msg === null || typeof msg !== "object") {
    return rpcError(null, ERR.INVALID_REQUEST, "Invalid Request");
  }
  const method = typeof msg.method === "string" ? msg.method : "";
  // A message with no `id` is a notification → never produces a response.
  const isNotification = !("id" in msg) || msg.id === undefined;
  if (isNotification) return null;
  const id = msg.id == null ? null : msg.id;

  switch (method) {
    case "initialize":
      return handleInitialize(id, msg, ctx);
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return handleToolsList(id, ctx);
    case "tools/call":
      return await handleToolsCall(id, msg, ctx, signal);
    default:
      return rpcError(id, ERR.METHOD_NOT_FOUND, "Method not found");
  }
}

/** Process one already-sliced line; return the JSON string to write (or null for a notification).
 *  `signal` is optional and passed straight through to `handleRpc`; callers that never do
 *  cancellation (e.g. the unit tests) can omit it exactly as before. */
export async function processLine(line, ctx, signal) {
  const parsed = parseStdioLine(line);
  if (parsed.blank) return null; // blank keep-alive line, ignore
  if (parsed.parseError) return JSON.stringify(parseErrorResponse());
  const res = await handleRpc(parsed.msg, ctx, signal);
  return res ? JSON.stringify(res) : null;
}

/**
 * Read stdin as newline-delimited JSON, dispatch each line against `ctx`, and write each non-null
 * response as one line to stdout. Resolves when stdin closes (the client disconnected). All
 * logging goes to stderr.
 *
 * Requests (`initialize`/`ping`/`tools/list`/`tools/call`) are dispatched CONCURRENTLY as soon as
 * their line is read, bounded by `opts.maxInFlight` (default 8): a slow `tools/call` no longer
 * blocks a `ping` or a fast tool queued behind it on the same connection. Once `maxInFlight`
 * requests are in flight, further requests wait in FIFO order for a slot to free. Every dispatched
 * request is tracked in a registry keyed by its JSON-RPC id (`{ method, startedAt, controller }`);
 * a `notifications/cancelled` notification looks its `params.requestId` up there and aborts that
 * request's `AbortSignal` (see `handleToolsCall`). Every other notification is a no-op, same as
 * before this change.
 *
 * Each response is written with a single synchronous `output.write(line + "\n")` call — because
 * JS is single-threaded, that call always runs to completion before any other pending response's
 * write can start, so concurrent completions can never interleave bytes on stdout even though they
 * may finish (and so print) out of request order.
 *
 * `opts.input`/`opts.output` default to `process.stdin`/`process.stdout` and exist so tests can
 * drive the loop against an in-memory stream instead of the real process streams.
 */
export async function runMcpStdio(ctx, opts = {}) {
  const maxInFlight =
    Number.isInteger(opts.maxInFlight) && opts.maxInFlight > 0
      ? opts.maxInFlight
      : DEFAULT_MAX_IN_FLIGHT;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  process.stderr.write(`${ctx.serverInfo.name} mcp: stdio server ready\n`);
  input.setEncoding("utf8");

  const writeLine = (line) => output.write(`${line}\n`);

  // JSON-RPC id -> { method, startedAt, controller }. A request enters when dispatched and leaves
  // once its response is written, so a cancellation for an id that already answered is a no-op.
  const registry = new Map();
  let active = 0;
  const queue = [];
  const outstanding = new Set();

  function pump() {
    while (active < maxInFlight && queue.length > 0) dispatch(queue.shift());
  }

  function dispatch(msg) {
    const id = msg.id == null ? null : msg.id;
    const controller = new AbortController();
    registry.set(id, { method: msg.method, startedAt: Date.now(), controller });
    active++;
    const task = handleRpc(msg, ctx, controller.signal)
      .then((res) => {
        if (res !== null) writeLine(JSON.stringify(res));
      })
      .catch((e) => {
        // A processing failure is logged to stderr only, never poison stdout with non-protocol
        // text.
        process.stderr.write(
          `${ctx.serverInfo.name} mcp: error handling request ${JSON.stringify(id)}: ${
            e?.message ? e.message : e
          }\n`,
        );
      })
      .finally(() => {
        registry.delete(id);
        active--;
        outstanding.delete(task);
        pump();
      });
    outstanding.add(task);
  }

  function handleParsedMessage(msg) {
    const isNotification = !("id" in msg) || msg.id === undefined;
    if (isNotification) {
      if (msg.method === "notifications/cancelled") {
        const params = msg.params && typeof msg.params === "object" ? msg.params : {};
        const target = registry.get(params.requestId);
        if (target) target.controller.abort(params.reason ?? "cancelled");
        // Unknown or already-finished id: nothing to cancel, silently ignored (best-effort, as
        // the spec allows).
      }
      // Every other notification (e.g. `notifications/initialized`) is intentionally a no-op
      // here too — same as the generic branch this replaces.
      return;
    }
    if (active < maxInFlight) dispatch(msg);
    else queue.push(msg); // in-flight cap reached: wait for a slot, FIFO.
  }

  function handleLine(line) {
    const parsed = parseStdioLine(line);
    if (parsed.blank) return;
    if (parsed.parseError) {
      writeLine(JSON.stringify(parseErrorResponse()));
      return;
    }
    if (parsed.msg === null || typeof parsed.msg !== "object") {
      writeLine(JSON.stringify(rpcError(null, ERR.INVALID_REQUEST, "Invalid Request")));
      return;
    }
    handleParsedMessage(parsed.msg);
  }

  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  }
  // Stream closed: flush any final line that lacked a trailing newline.
  if (buffer.trim() !== "") handleLine(buffer);

  // The reader is done, but work it dispatched (or queued behind the in-flight cap) may still be
  // running — drain it so every response still reaches stdout instead of being dropped.
  while (outstanding.size > 0 || queue.length > 0) {
    pump();
    if (outstanding.size > 0) await Promise.race(outstanding);
  }
}
