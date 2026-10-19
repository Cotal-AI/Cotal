import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cotalAuthProvider } from "../src/provider.js";
import { authClientSentinelKey, ensurePinnedIdp, saveAuthServiceInfo } from "../src/store.js";
import type { SecretStore } from "@cotal-ai/core";
import { createAccount } from "@nats-io/nkeys";
import { ServiceAuthorityTransportError, contractDigest, type ServiceAuthorityEnvelope } from "@cotal-ai/core";
import { postRemoteServiceAuthority, readRemoteServiceAuthorityInfo, serviceAuthorityUrl } from "../src/service-authority-client.js";

const accountPublicKey = createAccount().getPublicKey();
const request = {
  v: 1 as const, kind: "service-endpoint-authority" as const, operation: "register" as const,
  requestId: "a".repeat(32), space: "client-smoke", accountPublicKey,
  endpoint: "org.example.orders", instanceId: "i".repeat(32),
  registration: { clusterDigests: [contractDigest({ v: 1, commands: [] })], contractArtifacts: [{ v: 1, commands: [] }] },
  expected: { state: "unregistered" as const },
};
const envelope: ServiceAuthorityEnvelope = { request, proof: { kind: "idp", token: "fixture-not-a-credential" } };
const info = { v: 1, kind: "service-endpoint-authority-info", space: request.space, accountPublicKey };
let mode = "info", requests = 0, redirectRequests = 0;
let expectedEnvelope = envelope;
const dir = mkdtempSync(join(tmpdir(), "service-client-"));
let base: string;
const server = createServer(async (req, res) => {
  requests++;
  if (req.url === "/redirect-target") { redirectRequests++; res.end("unexpected"); return; }
  assert.equal(req.url, "/s/client-smoke/service-endpoint-authority");
  assert.equal(req.headers.authorization, undefined);
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    assert.ok(!body.includes("fixture-host-capability") && !body.includes("fixture-client-sentinel"));
    assert.deepEqual(JSON.parse(body), expectedEnvelope);
  }
  if (mode === "redirect") { res.writeHead(307, { location: `${base}/redirect-target` }); res.end(); return; }
  if (mode === "lost") { req.socket.destroy(); return; }
  if (mode === "malformed") { res.writeHead(502); res.end("upstream unavailable"); return; }
  res.setHeader("content-type", "application/json");
  const { operation, requestId, space, accountPublicKey, endpoint, instanceId, v, kind } = expectedEnvelope.request;
  const echo = { operation, requestId, space, accountPublicKey, endpoint, instanceId, v, kind };
  if (mode === "denied") { res.writeHead(403); res.end(JSON.stringify({ ...echo, state: "denied", reason: "permission-denied" })); return; }
  if (mode === "mismatch") { res.end(JSON.stringify({ ...echo, requestId: "b".repeat(32), state: "denied", reason: "permission-denied" })); return; }
  if (mode === "wrong-space") { res.end(JSON.stringify({ ...info, space: "other" })); return; }
  res.end(JSON.stringify(info));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
base = `http://127.0.0.1:${address.port}`;
const target = `${base}/s/client-smoke`;
const transportError = (outcome: "unknown" | "not-executed") => (error: unknown) =>
  error instanceof ServiceAuthorityTransportError && error.outcome === outcome;
try {
  assert.equal(serviceAuthorityUrl(`${target}/?ignored=1#ignored`), `${target}/service-endpoint-authority`);
  assert.throws(() => serviceAuthorityUrl("http://example.com/"));
  assert.throws(() => serviceAuthorityUrl("https://user:password@example.com/"));
  assert.deepEqual(await readRemoteServiceAuthorityInfo(target, request.space), info);
  mode = "wrong-space";
  await assert.rejects(readRemoteServiceAuthorityInfo(target, request.space), transportError("not-executed"));
  mode = "denied";
  assert.equal((await postRemoteServiceAuthority(target, envelope)).state, "denied");
  for (mode of ["redirect", "malformed", "lost", "mismatch"]) {
    const before = requests;
    await assert.rejects(postRemoteServiceAuthority(target, envelope), transportError("unknown"));
    assert.equal(requests, before + 1, `${mode}: no hidden retries`);
  }
  assert.equal(redirectRequests, 0);
  const before = requests;
  await assert.rejects(postRemoteServiceAuthority(target, { request, proof: { kind: "service-access", token: "fixture" } }));
  assert.equal(requests, before, "invalid proof never dispatches");
  ensurePinnedIdp(dir, "https://idp.example/api/auth");
  saveAuthServiceInfo(dir, { url: target, pid: process.pid, cap: "fixture-host-capability" });
  const reads: string[] = [];
  let sentinel: string | undefined = "fixture-client-sentinel";
  const store: SecretStore = {
    get: async (key) => { reads.push(key); assert.equal(key, authClientSentinelKey(request.space)); return sentinel; },
    put: async () => { throw new Error("client must not write the store"); },
    create: async () => { throw new Error("client must not create store entries"); },
    delete: async () => { throw new Error("client must not delete store entries"); },
  };
  expectedEnvelope = { request: { v: 1, kind: request.kind, operation: "status", requestId: request.requestId,
    space: request.space, accountPublicKey, endpoint: request.endpoint, instanceId: request.instanceId,
    target: { kind: "instance" } }, proof: { kind: "service-access", token: "fixture-access" } };
  mode = "denied";
  const result = await cotalAuthProvider.serviceEndpointAuthority!({ store, dir, request: expectedEnvelope.request,
    proof: { kind: "service-access", token: "fixture-access" } });
  assert.equal(result.result.state, "denied");
  assert.equal(result.sentinelCreds, sentinel);
  assert.deepEqual(reads, [authClientSentinelKey(request.space)]);
  const beforeMissing = requests;
  sentinel = undefined;
  await assert.rejects(cotalAuthProvider.serviceEndpointAuthority!({ store, dir, request: expectedEnvelope.request,
    proof: { kind: "service-access", token: "fixture-access" } }), /no sentinel projection/);
  assert.equal(requests, beforeMissing, "missing projection refuses without a privileged fallback");
  const beforeInvalid = reads.length;
  await assert.rejects(cotalAuthProvider.serviceEndpointAuthority!({ store, dir, request,
    proof: { kind: "service-access", token: "fixture-access" } }), /proof kind/);
  assert.equal(reads.length, beforeInvalid, "proof preflight precedes store access");
  console.log("service-authority-client: live HTTP, provider projection, result binding and no-retry checks passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
