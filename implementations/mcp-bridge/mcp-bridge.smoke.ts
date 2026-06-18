/**
 * End-to-end smoke for the MCP bridge (no test runner) — run with: pnpm smoke:mcp-bridge
 * Requires a nats-server running locally (pnpm cotal up).
 *
 * Bridges a tiny stdio MCP server (fixtures/echo-mcp-server.mjs) onto the mesh, then — from a
 * SEPARATE endpoint — lists and calls its tools over the control plane. Proves the whole path:
 * external MCP tool → bridge peer → mesh → any caller.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable } from "@cotal-ai/core";
import { McpBridge } from "./src/bridge.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 50; i++) {
  if (await isReachable()) break;
  await wait(200);
}
if (!(await isReachable())) {
  console.error("✗ no NATS reachable — start one with: pnpm cotal up");
  process.exit(1);
}

const space = `mcp-smoke-${randomUUID().slice(0, 8)}`;
const fixture = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));

const bridge = new McpBridge({
  space,
  mcp: [{ name: "echo-fixture", command: "node", args: [fixture] }],
});
const caller = new CotalEndpoint({ space, card: { name: "caller", kind: "endpoint" }, consume: false });

let failed = false;
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed = true;
};

try {
  await bridge.start();
  check(bridge.catalog.some((t) => t.name === "echo"), "bridge connected to MCP server and discovered `echo`");
  await caller.start();
  await wait(200); // let the control subscription settle

  const list = await caller.requestControl("mcp", { op: "list" });
  const tools = (list.data as { tools?: { name: string }[] })?.tools ?? [];
  check(list.ok && tools.some((t) => t.name === "echo"), "list op returns the `echo` tool over the mesh");

  const call = await caller.requestControl("mcp", {
    op: "call",
    args: { tool: "echo", arguments: { message: "hello mesh" } },
  });
  const text = (call.data as { text?: string })?.text;
  check(call.ok && text === "hello mesh", `call op round-trips the tool result ("${text}")`);

  const missing = await caller.requestControl("mcp", { op: "call", args: { tool: "nope" } });
  check(!missing.ok && /no such tool/.test(missing.error ?? ""), "unknown tool is rejected cleanly");
} finally {
  await caller.stop().catch(() => {});
  await bridge.stop().catch(() => {});
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
process.exit(failed ? 1 : 0);
