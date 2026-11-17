/** Native request metadata reaches every gateway boundary; model arguments cannot replace it. */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { ApprovalRequired, serveGatewayStdio, type GatewayHost } from "../src/gateway.js";

const input = new PassThrough();
const output = new PassThrough();
const seen: Array<{ operation: string; account: string; id?: string }> = [];
const host: GatewayHost = {
  account(_auth, meta) {
    if (typeof meta?.threadId !== "string") throw new Error("native thread metadata required");
    return meta.threadId;
  },
  async open(account) {
    seen.push({ operation: "open", account });
    throw new ApprovalRequired({ requestId: "fixture-request", proposed: null, approval: { id: "a".repeat(26), url: "https://fixture.example/approve/a", expiresAt: "2099-01-01T00:00:00.000Z" } });
  },
  async find(account, id) { seen.push({ operation: "find", account, id }); return undefined; },
  async close(account, id) { seen.push({ operation: "close", account, id }); return false; },
};
let seq = 0;
const pending = new Map<number, (value: Record<string, unknown>) => void>();
const reader = createInterface({ input: output });
reader.on("line", line => {
  const msg = JSON.parse(line) as Record<string, unknown>;
  const done = pending.get(msg.id as number);
  if (done) { pending.delete(msg.id as number); done(msg); }
});
const gateway = await serveGatewayStdio(host, { input, output, selection: true, space: true, approvalResume: true });
function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 5000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
let count = 0;
const check = (name: string, ok: unknown) => { assert.ok(ok, name); count++; console.log(`  ✓ ${name}`); };
try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-fixture", version: "1" } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await request("tools/call", { name: "cotal_connect", arguments: { name: "fixture" }, _meta: { threadId: "native-a" } });
  check("connect binds to the native metadata account", seen.at(-1)?.operation === "open" && seen.at(-1)?.account === "native-a");
  for (const name of ["cotal_orientation", "cotal_wait", "cotal_roster", "cotal_disconnect"]) {
    await request("tools/call", { name, arguments: { connection_id: "connection-from-a" }, _meta: { threadId: "native-b" } });
    check(`${name} passes this request's native account to the ownership boundary`, seen.at(-1)?.account === "native-b" && seen.at(-1)?.id === "connection-from-a");
  }
  const before = seen.length;
  await request("tools/call", { name: "cotal_connect", arguments: { name: "fixture", threadId: "native-a" } });
  await request("tools/call", { name: "cotal_roster", arguments: { connection_id: "connection-from-a" } });
  check("missing metadata and model-supplied thread arguments reach no identity operation", seen.length === before);
  const results = await Promise.all(["native-c", "native-d"].map(threadId => request("tools/call", { name: "cotal_roster", arguments: { connection_id: "fixture" }, _meta: { threadId } })));
  check("concurrent requests retain separate native accounts", results.length === 2 && seen.slice(-2).some(v => v.account === "native-c") && seen.slice(-2).some(v => v.account === "native-d"));
  console.log(`gateway-native-binding: ${count} checks passed`);
} finally {
  await gateway.close(); reader.close(); input.destroy(); output.destroy();
}
