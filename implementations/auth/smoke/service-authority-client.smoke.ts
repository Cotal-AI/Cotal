import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cotalAuthProvider } from "../src/provider.js";
import { authClientSentinelKey, ensurePinnedIdp, saveAuthServiceInfo } from "../src/store.js";
import type { SecretStore } from "@cotal-ai/core";
import { createAccount } from "@nats-io/nkeys";
import { ServiceAuthorityTransportError, contractDigest, epRequestSubject, serviceEndpointActor, type ServiceAuthorityEnvelope } from "@cotal-ai/core";
import { postRemoteServiceAuthority, readRemoteServiceAuthorityInfo, serviceAuthorityUrl } from "../src/service-authority-client.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const accountPublicKey = createAccount().getPublicKey();
const request = {
  v: 1 as const, kind: "service-endpoint-authority" as const, operation: "register" as const,
  requestId: "a".repeat(32), space: "client-smoke", accountPublicKey,
  endpoint: "org.example.orders", instanceId: "i".repeat(32),
  registration: { clusterDigests: [contractDigest({ v: 1, commands: [] })], contractArtifacts: [{ v: 1, commands: [] }] },
  expected: { state: "unregistered" as const },
};
const envelope: ServiceAuthorityEnvelope = { request, proof: { kind: "idp", token: "fixture-not-a-credential" } };
const owner = `u_${"a".repeat(26)}`;
const witness = { accountPublicKey, space: request.space, endpoint: request.endpoint, instanceId: request.instanceId,
  principal: { owner, actor: serviceEndpointActor({ accountPublicKey, space: request.space, endpoint: request.endpoint, instanceId: request.instanceId, owner }), lifecycleUid: "l".repeat(32) },
  rootCredentialId: "r".repeat(32), approvalDigest: contractDigest({ approval: 1 }), processEpoch: 1,
  registrationRevision: 1, nameAuthorityRevision: 1, registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ registration: 1 }) };
const viewRequest = { v: request.v, kind: request.kind, operation: "describe-view" as const, requestId: "d".repeat(32),
  accountPublicKey, space: request.space, endpoint: request.endpoint, instanceId: request.instanceId, witness,
  observation: { subject: epRequestSubject(request.space, { endpoint: request.endpoint, command: "describe", route: { mode: "one" },
    caller: { owner, actor: "caller", uid: "c".repeat(32) }, nonce: "n".repeat(32) }), fingerprint: contractDigest({ observed: 1 }) } };
const viewEnvelope: ServiceAuthorityEnvelope = { request: viewRequest, proof: { kind: "service-access", token: "fixture-access" } };
const info = { v: 1, kind: "service-endpoint-authority-info", space: request.space, accountPublicKey,
  issuer: "https://auth.example/exchange", keys: [{ kty: "OKP", crv: "Ed25519", kid: "kid-1", x: Buffer.from("58" + "66".repeat(31), "hex").toString("base64url") }] };
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
  res.setHeader("cache-control", "no-store");
  const { operation, requestId, space, accountPublicKey, endpoint, instanceId, v, kind } = expectedEnvelope.request;
  const echo = { operation, requestId, space, accountPublicKey, endpoint, instanceId, v, kind };
  if (mode.startsWith("view")) {
    assert.equal(req.headers["cache-control"], "no-store");
    const body = JSON.stringify({ ...echo, state: "view", witness, observation: viewRequest.observation,
      basis: "principal-policy-v1", commands: ["read"], validForMs: mode === "view-expired" ? 1 : 1500 });
    if (mode === "view-cacheable") res.removeHeader("cache-control");
    if (mode === "view-slow-body") {
      res.write(body.slice(0, 10)); setTimeout(() => res.end(body.slice(10)), 100).unref(); return;
    }
    if (mode === "view-expired") { setTimeout(() => res.end(body), 30).unref(); return; }
    res.end(body); return;
  }
  if (mode === "denied" || mode === "denied502" || mode === "denied503") { res.writeHead(mode === "denied" ? 403 : Number(mode.slice(6))); res.end(JSON.stringify({ ...echo, state: "denied", reason: "permission-denied" })); return; }
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
  for (mode of ["denied502", "denied503"]) {
    const before = requests;
    await assert.rejects(postRemoteServiceAuthority(target, envelope), (error: unknown) => transportError("unknown")(error) && error instanceof ServiceAuthorityTransportError && error.httpStatus === Number(mode.slice(6)), `${mode}: HTTP failure is not a confirmed denial`);
    assert.equal(requests, before + 1);
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
  expectedEnvelope = viewEnvelope; mode = "view"; sentinel = "fixture-client-sentinel";
  assert.equal((await postRemoteServiceAuthority(target, viewEnvelope)).state, "view");
  assert.equal((await cotalAuthProvider.serviceEndpointAuthority!({ store, dir, request: viewRequest,
    proof: { kind: "service-access", token: "fixture-access" } })).result.state, "view");
  const beforeNoProof = reads.length;
  await assert.rejects(cotalAuthProvider.serviceEndpointAuthority!({ store, dir, request: viewRequest }), /proof kind/);
  assert.equal(reads.length, beforeNoProof, "Describe never falls back to IdP or reads credentials without its access proof");
  for (mode of ["view-cacheable", "view-expired", "denied502", "redirect"]) {
    const before = requests;
    await assert.rejects(postRemoteServiceAuthority(target, viewEnvelope), transportError("not-executed"));
    assert.equal(requests, before + 1, `${mode}: Describe is a read and does not retry`);
  }
  mode = "view-slow-body";
  await assert.rejects(postRemoteServiceAuthority(target, viewEnvelope, { timeoutMs: 20 }), transportError("not-executed"));
  const cancelled = new AbortController(); cancelled.abort();
  const beforeAbort = requests;
  await assert.rejects(postRemoteServiceAuthority(target, viewEnvelope, { signal: cancelled.signal }), transportError("not-executed"));
  assert.equal(requests, beforeAbort);
  mode = "view";
  const beforeSlow = requests;
  const slowStore: SecretStore = { ...store, get: async (key) => {
    await new Promise((resolve) => setTimeout(resolve, 80)); return store.get(key);
  } };
  await assert.rejects(cotalAuthProvider.serviceEndpointAuthority!({ store: slowStore, dir, request: viewRequest,
    proof: { kind: "service-access", token: "fixture-access" }, timeoutMs: 10 }), transportError("not-executed"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, beforeSlow, "late preparation cannot dispatch after the original provider deadline");
  console.log("service-authority-client: live HTTP, provider projection, result binding, read-only Describe/no-store/full-flow deadlines and no-retry checks passed");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  rmSync(dir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
