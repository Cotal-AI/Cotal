/**
 * The one hand-shaped check of this package's protocol promises, against a loopback stand-in for the
 * Linear MCP server (no network, no account). It drives the real client the way `cotal linear` does
 * and asserts what the docs promise:
 *
 *  - a tool result comes back verbatim (positive control), and extension fields the MCP SDK does not
 *    model survive on capabilities, tools and content blocks;
 *  - a redirect answered after dispatch is refused and reported with outcome `unknown`;
 *  - an expired OAuth token is refreshed before the request, without an interactive login;
 *  - a request whose deadline expires ends its own HTTP request, so timed-out calls never hold more
 *    sockets than the concurrency limit.
 *
 * Run: pnpm --filter @cotal-ai/linear test   (needs `pnpm build` of core and workspace first)
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Every account file this run touches lives under a throwaway home.
const home = mkdtempSync(join(tmpdir(), "linear-smoke-"));
process.env.COTAL_HOME = join(home, "cotal");
process.env.HOME = home;
const { LinearUpstream, DEFAULT_LIMITS } = await import("../src/upstream.js");
const { credentialFor } = await import("../src/oauth.js");
const { oauthStatePath } = await import("../src/account.js");
const { LINEAR_MCP_ORIGIN } = await import("../src/origin.js");

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };

const seen = { redirect: false, refreshes: 0, outstanding: 0, maxOutstanding: 0, streamsOpen: 0, holdInit: false, initAborted: false, initializedAfterClose: false, closedAt: 0, bigEntry: false };
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://local").pathname;
  const json = (data: unknown): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  // A result delivered as an SSE event on a stream the server then keeps open, as a streaming MCP
  // server may do after answering.
  const sse = (data: unknown): void => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
    seen.streamsOpen++;
    res.once("close", () => { seen.streamsOpen--; });
  };
  if (path.includes("oauth-protected-resource")) return json({ resource: `${LINEAR_MCP_ORIGIN}/mcp`, authorization_servers: [LINEAR_MCP_ORIGIN] });
  if (path.includes("oauth-authorization-server") || path.includes("openid-configuration"))
    return json({ issuer: LINEAR_MCP_ORIGIN, authorization_endpoint: `${LINEAR_MCP_ORIGIN}/authorize`, token_endpoint: `${LINEAR_MCP_ORIGIN}/token`, registration_endpoint: `${LINEAR_MCP_ORIGIN}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"] });
  if (path === "/token") { seen.refreshes++; return json({ access_token: "new-local-token", refresh_token: "rotated-local-token", token_type: "Bearer", expires_in: 3600 }); }
  if (req.method !== "POST") { res.writeHead(req.method === "DELETE" ? 200 : 405).end(); return; }
  let body = "";
  for await (const part of req) body += part;
  const m = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; protocolVersion?: string } };
  if (m.id === undefined) {
    if (m.method === "notifications/initialized" && seen.closedAt && Date.now() >= seen.closedAt) seen.initializedAfterClose = true;
    res.writeHead(202).end();
    return;
  }
  const rpc = (result: unknown): void => json({ jsonrpc: "2.0", id: m.id, result });
  const initResult = { protocolVersion: m.params?.protocolVersion, serverInfo: { name: "local-stand-in", version: "1" }, capabilities: { tools: {}, "vendor/feature": {} } };
  if (m.method === "initialize" && seen.holdInit) {
    // Held long enough for the client to be closed underneath it.
    let answered = false;
    res.once("close", () => { if (!answered) seen.initAborted = true; });
    await new Promise((r) => setTimeout(r, 300));
    answered = true;
    return rpc(initResult);
  }
  if (m.method === "initialize") return rpc(initResult);
  if (m.method === "tools/list" && seen.bigEntry) return rpc({ tools: [{ name: "wide", description: "x".repeat(60 * 1024), inputSchema: { type: "object" } }] });
  if (m.method === "tools/list") return rpc({ tools: ["echo", "redirect", "hold", "stream"].map((name) => ({ name, inputSchema: { type: "object" }, "vendor/field": "keep" })) });
  if (m.method === "tools/call" && m.params?.name === "stream") return sse({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "streamed" }] } });
  if (m.method === "tools/call" && m.params?.name === "redirect") { seen.redirect = true; res.writeHead(307, { location: "https://example.invalid/" }).end(); return; }
  if (m.method === "tools/call" && m.params?.name === "hold") {
    seen.outstanding++; seen.maxOutstanding = Math.max(seen.maxOutstanding, seen.outstanding);
    res.once("close", () => { seen.outstanding--; });
    return; // never answered: the client's deadline must end this request
  }
  if (m.method === "tools/call") return rpc({ content: [{ type: "text", text: "positive-control", "vendor/field": "keep" }], "vendor/result": "keep" });
  res.writeHead(400).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no listening address");
const local = `http://127.0.0.1:${address.port}`;

// The client only ever dials the pinned origin; this run maps that origin onto the stand-in.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const logical = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
  if (logical.origin !== LINEAR_MCP_ORIGIN) throw new Error(`unexpected origin ${logical.origin}`);
  return nativeFetch(local + logical.pathname + logical.search, init);
};

const tokenFile = join(home, "control.token");
writeFileSync(tokenFile, "local-control-token\n", { mode: 0o600 });
const upstream = new LinearUpstream({ name: "local-control", mode: "write", auth: "token", tokenFile }, { ...DEFAULT_LIMITS, maxConcurrent: 2, maxQueued: 2, maxTimeoutMs: 2000, defaultTimeoutMs: 2000 });
try {
  const inv = await upstream.inventory();
  const echo = await upstream.callTool({ name: "echo", inventoryDigest: inv.digest });
  const content = echo.kind === "result" ? (echo.result.content as Array<Record<string, unknown>>) : [];
  check("positive control: a tool result comes back", echo.kind === "result" && content[0]?.text === "positive-control", echo);
  check("inventory keeps an extension capability the SDK does not model", Object.hasOwn(inv.capabilities, "vendor/feature"), inv.capabilities);
  check("inventory keeps an extension field on a tool", Object.hasOwn(inv.tools[0] ?? {}, "vendor/field"), inv.tools[0]);
  check("a tool result keeps an extension field on a content block", Object.hasOwn(content[0] ?? {}, "vendor/field"), content[0]);
  check("a tool result keeps an extension field on the result itself", echo.kind === "result" && Object.hasOwn(echo.result, "vendor/result"), echo);

  const redirect = await upstream.callTool({ name: "redirect", inventoryDigest: inv.digest });
  check("the server received the redirected call", seen.redirect);
  check("a redirect after dispatch is refused with outcome unknown", redirect.kind === "failed" && redirect.reason === "transport" && redirect.outcome === "unknown", redirect);

  const statePath = oauthStatePath("oauth-control");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ client: { client_id: "local-client" }, tokens: { access_token: "old-token", refresh_token: "local-refresh", token_type: "Bearer", expires_in: 1 }, obtainedAt: Date.now() - 120_000 }), { mode: 0o600 });
  const credential = credentialFor({ name: "oauth-control", auth: "oauth", mode: "write" });
  let refreshed: string | undefined;
  try { await credential.prepare(); refreshed = credential.bearer(); } catch (e) { check("an expired token refreshes without a login", false, e); }
  if (refreshed !== undefined) check("an expired token refreshes without a login", refreshed === "new-local-token" && seen.refreshes === 1, { refreshed, refreshes: seen.refreshes });

  const replies = [];
  for (let i = 0; i < 5; i++) replies.push(await upstream.callTool({ name: "hold", inventoryDigest: inv.digest, timeoutMs: 80 }));
  check("every held call reports a timeout with outcome unknown", replies.every((r) => r.kind === "failed" && r.reason === "timeout" && r.outcome === "unknown"), replies);
  check("timed-out calls never hold more sockets than the concurrency limit", seen.maxOutstanding <= 2, seen);
  await new Promise((r) => setTimeout(r, 200));
  check("no held socket outlives its deadline by more than a moment", seen.outstanding <= 1, seen);

  const streamed = [];
  for (let i = 0; i < 5; i++) streamed.push(await upstream.callTool({ name: "stream", inventoryDigest: inv.digest }));
  check("a result sent as an SSE event comes back", streamed.every((r) => r.kind === "result"), streamed);
  await new Promise((r) => setTimeout(r, 200));
  check("a request's response stream is closed once its result is in", seen.streamsOpen === 0, seen);
} finally {
  await upstream.close(1000);
}

// Closing the upstream while its first connect is still in flight ends that connect: the initialize
// request is aborted, and no session is announced to the server afterwards.
seen.holdInit = true;
const closing = new LinearUpstream({ name: "local-control", mode: "write", auth: "token", tokenFile }, { ...DEFAULT_LIMITS, maxTimeoutMs: 2000, defaultTimeoutMs: 2000 });
const pending = closing.inventory().then(() => "resolved", (e: Error) => e.message);
await new Promise((r) => setTimeout(r, 50));
seen.closedAt = Date.now();
await closing.close(50);
const closedOutcome = await pending;
await new Promise((r) => setTimeout(r, 500));
check("an inventory read interrupted by close rejects", closedOutcome !== "resolved", closedOutcome);
check("closing during connect ends the initialize request", seen.initAborted, seen);
check("no initialized notification follows a close", !seen.initializedAfterClose, seen);
seen.holdInit = false;

// One inventory entry larger than an agent tool can carry refuses the whole inventory, named.
seen.bigEntry = true;
const wide = new LinearUpstream({ name: "local-control", mode: "write", auth: "token", tokenFile }, { ...DEFAULT_LIMITS, maxTimeoutMs: 2000, defaultTimeoutMs: 2000 });
try {
  const outcome = await wide.inventory().then(() => "resolved", (e: Error) => e.message);
  check("an inventory entry over the entry bound refuses discovery, naming the entry", /tools\[0\].*wide.*bytes/.test(outcome), outcome);
} finally {
  await wide.close(1000);
}
seen.bigEntry = false;

server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
globalThis.fetch = nativeFetch;
rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
