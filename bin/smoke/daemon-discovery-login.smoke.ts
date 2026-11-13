import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import "../daemon/command.js";
import { registry, type Command } from "@cotal-ai/core";
const daemonCommand = registry.resolve<Command>("command", "daemon");
import { parseRequest } from "../daemon/protocol.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon/endpoint.js";
import { createLoginCoordinator } from "../daemon/login.js";

const pins = { url: "https://issuer.example/api/auth", issuer: "https://issuer.example", audience: "cotal" };
const request = { v: DAEMON_PROTOCOL_VERSION, id: "probe", op: "login-start", idp: pins.url };
const parsed = parseRequest(JSON.stringify({ ...request, discoveryPins: pins }));
assert.equal(parsed.ok, true);
if (parsed.ok && parsed.request.op === "login-start") assert.deepEqual(parsed.request.discoveryPins, pins);
assert.equal(parseRequest(JSON.stringify(request)).ok, true);
for (const discoveryPins of [null, [], {}, { ...pins, extra: true }, { ...pins, audience: " " }, { ...pins, url: "https://other.example/auth" }, { ...pins, issuer: "http://issuer.example" }, { ...pins, issuer: `${pins.issuer}?` }]) {
  assert.equal(parseRequest(JSON.stringify({ ...request, discoveryPins })).ok, false);
}
assert.equal(parseRequest(JSON.stringify({ ...request, op: "logout", discoveryPins: pins })).ok, false);

const dir = mkdtempSync("/var/tmp/cd-");
const originalFetch = globalThis.fetch;
try {
  let established = false;
  const coordinator = createLoginCoordinator({ sessionDir: dir, establish: async opts => {
    established = true;
    assert.deepEqual(opts.discoveryPins, pins);
    assert.equal(opts.idpUrl, pins.url);
    throw new Error("fixture stops before provider effects");
  } });
  const attempt = coordinator.start({ idp: pins.url, discoveryPins: pins, onPrompt: () => assert.fail("unexpected approval"), onResult: async () => {} });
  assert.ok(attempt);
  assert.equal((await attempt.settled).outcome, "failed");
  assert.equal(established, true);
  await coordinator.close();

  // The real registered command must resolve the name before trying IPC or native setup.
  for (const mode of ["login", "setup"]) {
    const urls: string[] = [];
    globalThis.fetch = async input => {
      urls.push(String(input));
      return new Response("{}", { status: 503 });
    };
    await assert.rejects(() => daemonCommand.run({ raw: [], positionals: [mode], values: { idp: "mesh.example", "daemon-home": join(dir, "absent"), json: true } }), /discovery/);
    assert.deepEqual(urls, ["https://mesh.example/.well-known/cotal-mesh"]);
  }
} finally {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
}
console.log("daemon discovery login smoke passed");
