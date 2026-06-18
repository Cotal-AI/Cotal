/**
 * End-to-end smoke for the REMOTE mcp-bridge paths (no test runner, no network) —
 * run with: pnpm smoke:mcp-bridge:remote. Requires a nats-server (pnpm cotal up).
 *
 * Part 1 — HTTP + static bearer: a Streamable HTTP MCP fixture gated by a bearer token;
 *          the bridge attaches the header and a separate endpoint calls `echo` over the mesh.
 * Part 2 — full OAuth: a fake auth+resource server (DCR + PKCE); drive `runOAuthLogin`
 *          headlessly (the browser-open is replaced by a fetch that follows the redirect),
 *          then run the bridge with `--oauth` off the cached token and call `echo`.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { CotalEndpoint, isReachable } from "@cotal-ai/core";
import { McpBridge } from "./src/bridge.js";
import { runOAuthLogin, mcpAuthDir } from "./src/oauth.js";
import { startBearerServer, startOAuthServer } from "./fixtures/remote-mcp-server.mjs";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 50; i++) {
  if (await isReachable()) break;
  await wait(200);
}
if (!(await isReachable())) {
  console.error("✗ no NATS reachable — start one with: pnpm cotal up");
  process.exit(1);
}

let failed = false;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed = true;
};
const text = (r: { data?: unknown }) => (r.data as { text?: string } | undefined)?.text;

// ---- Part 1: HTTP + static bearer -----------------------------------------
{
  const server = await startBearerServer({ token: "secret-token" });
  const space = `mcp-http-${randomUUID().slice(0, 8)}`;
  const bridge = new McpBridge({
    space,
    mcp: [{ name: "bearer", url: server.url, headers: { Authorization: "Bearer secret-token" } }],
  });
  const caller = new CotalEndpoint({ space, card: { name: "caller", kind: "endpoint" }, consume: false });
  try {
    await bridge.start();
    check(bridge.catalog.some((t) => t.name === "echo"), "HTTP+bearer: connected + discovered `echo`");
    await caller.start();
    await wait(200);
    const call = await caller.requestControl("mcp", { op: "call", args: { tool: "echo", arguments: { message: "over http" } } });
    check(call.ok && text(call) === "over http", `HTTP+bearer: call round-trips ("${text(call)}")`);
  } finally {
    await caller.stop().catch(() => {});
    await bridge.stop().catch(() => {});
    await server.close();
  }
}

// ---- Part 2: full OAuth ----------------------------------------------------
{
  const server = await startOAuthServer();
  const service = `smoke-oauth-${randomUUID().slice(0, 8)}`;
  const dir = mcpAuthDir(service);
  try {
    // Headless login: the "browser" is a fetch that follows the 302 into the loopback callback.
    const { tools } = await runOAuthLogin({
      url: server.url,
      service,
      openUrl: (u) => void fetch(u).catch(() => {}),
    });
    check(tools >= 1, `OAuth: login cached a working token (${tools} tools)`);

    const space = `mcp-oauth-${randomUUID().slice(0, 8)}`;
    const bridge = new McpBridge({ space, mcp: [{ name: service, url: server.url, oauth: true }] });
    const caller = new CotalEndpoint({ space, card: { name: "caller", kind: "endpoint" }, consume: false });
    try {
      await bridge.start();
      check(bridge.catalog.some((t) => t.name === "echo"), "OAuth: daemon used cached token + discovered `echo`");
      await caller.start();
      await wait(200);
      const call = await caller.requestControl("mcp", { op: "call", args: { tool: "echo", arguments: { message: "via oauth" } } });
      check(call.ok && text(call) === "via oauth", `OAuth: call round-trips over the mesh ("${text(call)}")`);
    } finally {
      await caller.stop().catch(() => {});
      await bridge.stop().catch(() => {});
    }
  } catch (e) {
    check(false, `OAuth flow threw: ${(e as Error).message}`);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true }); // clean cached test tokens
  }
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);
