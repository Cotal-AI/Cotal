/** MCP Events extension through the shipped HTTP transport; no subscription implementation is faked into stock. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GatewayEventError, handleGatewayRequest, type GatewayEvents, type GatewayHost } from "../src/gateway.js";

let calls = 0;
const seen: Array<{ account: string; params: Record<string, unknown> }> = [];
const host: GatewayHost = {
  account(auth) {
    if (typeof auth?.extra?.account !== "string") throw new Error("private authentication detail");
    return auth.extra.account;
  },
  async open() { throw new Error("not used"); },
  async find() { return undefined; },
  async close() { return false; },
};
const events: GatewayEvents = {
  async list(account, params) { calls++; seen.push({ account, params }); return { events: [] }; },
  async subscribe(account, params) {
    calls++; seen.push({ account, params });
    if (params.fail === "callback") throw new GatewayEventError(-32015, "Callback verification failed.", { reason: "verification_failed" });
    if (params.fail === "private") throw new Error("whsec_private-must-not-leak");
    return { id: "fixture-sub", refreshBefore: "2099-01-01T00:00:00.000Z", cursor: null, truncated: false };
  },
  async unsubscribe(account, params) { calls++; seen.push({ account, params }); return {}; },
};
const http = createServer((req, res) => {
  const auth = req.headers.authorization === "Bearer account-a"
    ? { token: "fixture", clientId: "fixture", scopes: [], extra: { account: "a" } }
    : req.headers.authorization === "Bearer account-b"
      ? { token: "fixture", clientId: "fixture", scopes: [], extra: { account: "b" } }
      : req.headers.authorization === "Bearer invalid"
        ? { token: "fixture", clientId: "fixture", scopes: [] }
        : undefined;
  void handleGatewayRequest(host, { req, res, auth, ...(req.url === "/events" ? { events } : {}) }).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const addr = http.address();
assert.ok(addr && typeof addr !== "string");
let count = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); console.log(`  ✓ ${label}`); count++; };
const call = async (method: string, params?: unknown, token = "account-a", path = "/events") => {
  const response = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return await response.json() as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
};
try {
  const init = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "events-smoke", version: "1" } };
  const enabled = await call("initialize", init);
  check("an Events adapter advertises the standard events capability", JSON.stringify(enabled.result?.capabilities).includes('"events":{}'));
  const plain = await call("initialize", init, "account-a", "/plain");
  check("ordinary gateways do not advertise events", !JSON.stringify(plain.result?.capabilities).includes('"events"'));
  const absent = await call("events/list", {}, "account-a", "/plain");
  check("ordinary gateways do not serve event methods", absent.error?.code === -32601);
  const list = await call("events/list");
  check("events/list accepts omitted params and authenticates the account", Array.isArray(list.result?.events) && seen.at(-1)?.account === "a");
  const params = { name: "message.created", arguments: { connection_id: "fixture" }, delivery: { mode: "webhook", url: "https://receiver.example/callback", secret: "whsec_fixture" }, account: "forged" };
  const sub = await call("events/subscribe", params, "account-b");
  check("subscribe keeps transport identity separate from untrusted params", sub.result?.id === "fixture-sub" && seen.at(-1)?.account === "b" && seen.at(-1)?.params.account === "forged");
  const unsub = await call("events/unsubscribe", { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } });
  check("unsubscribe passes the protocol identity without requiring a secret", !!unsub.result && seen.at(-1)?.account === "a");
  const before = calls;
  const missing = await call("events/list", {}, "");
  const invalid = await call("events/list", {}, "invalid");
  check("missing and invalid authentication run no event handler", !!missing.error && !!invalid.error && calls === before);
  const malformed = await call("events/list", "wrong");
  check("non-object method params are rejected before adapter execution", !!malformed.error && calls === before);
  const callback = await call("events/subscribe", { fail: "callback" });
  check("public callback errors preserve protocol code and reason", callback.error?.code === -32015 && JSON.stringify(callback.error.data) === '{"reason":"verification_failed"}');
  const privateError = await call("events/subscribe", { fail: "private" });
  check("unexpected adapter errors do not leak secrets", privateError.error?.code === -32603 && !JSON.stringify(privateError).includes("whsec_"));
  console.log(`gateway-events: ${count} checks passed`);
} finally {
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
}
