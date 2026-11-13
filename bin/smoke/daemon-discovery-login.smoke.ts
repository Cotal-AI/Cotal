import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import "../daemon/command.js";
import { registry, type Command } from "@cotal-ai/core";
import { parseRequest } from "../daemon/protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon/endpoint.js";
import { createLoginCoordinator } from "../daemon/login.js";

const pins = { url: "https://native.example/api/auth", issuer: "https://issuer.example", audience: "resource" };
const request = { v: DAEMON_PROTOCOL_VERSION, id: "probe", op: "login-start", idp: pins.url };
const parsed = parseRequest(JSON.stringify({ ...request, discoveryPins: pins }));
assert.equal(parsed.ok, true);
if (parsed.ok && parsed.request.op === "login-start") assert.deepEqual(parsed.request.discoveryPins, pins);
for (const discoveryPins of [null, [], {}, { ...pins, extra: true }, { ...pins, audience: " " }, { ...pins, url: "https://other.example" }, { ...pins, issuer: "http://issuer.example" }])
  assert.equal(parseRequest(JSON.stringify({ ...request, discoveryPins })).ok, false);
assert.equal(parseRequest(JSON.stringify({ ...request, op: "logout", discoveryPins: pins })).ok, false);
const dir = mkdtempSync("/var/tmp/cd6728-");
chmodSync(dir, 0o700);
process.env.COTAL_HOME = dir;
process.env.HOME = dir;
let established = false;
const coordinator = createLoginCoordinator({ sessionDir: dir, establish: async opts => {
  established = true;
  assert.deepEqual(opts.expectedPins, { idpUrl: pins.url, issuer: pins.issuer, audience: pins.audience });
  throw new Error("fixture stops before provider effects");
} });
const attempt = coordinator.start({ idp: pins.url, discoveryPins: pins, onPrompt: () => assert.fail("unexpected approval"), onResult: async () => {} });
assert.ok(attempt);
assert.equal((await attempt.settled).outcome, "failed");
assert.equal(established, true);
await coordinator.close();
const original = globalThis.fetch;
try {
  for (const mode of ["login", "setup"]) {
    const urls: string[] = [];
    globalThis.fetch = async input => { urls.push(String(input)); return new Response("{}", { status: 503 }); };
    await assert.rejects(registry.resolve<Command>("command", "daemon").run({ raw: [], positionals: [mode], values: { idp: "product.example", "daemon-home": `${dir}/absent`, json: true } }), /discovery/);
    assert.deepEqual(urls, ["https://product.example/.well-known/cotal-mesh"]);
  }
} finally { globalThis.fetch = original; }
console.log("PASS daemon discovery selection and staged login pin propagation");
