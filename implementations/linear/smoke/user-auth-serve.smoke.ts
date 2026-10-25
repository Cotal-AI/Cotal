/** Real owned authority and broker; the upstream tool reply is an inert fixture, not Linear data. */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  contractDigest, invokeCommand, mintCreds, newIdentity, parseServiceAuthorityRequest, resolveService,
  setupSpaceStreams, type AuthProvider, type ServiceAuthorityRequest,
} from "@cotal-ai/core";
import { startHostedAuthFixture, MemoryStore } from "../../auth/smoke/_hosted-auth-fixture.js";
import { deriveOwnerForIdpSubject } from "../../auth/src/derive.js";
import { grantActor } from "../../auth/src/ledger.js";
import { saveIdpSession } from "../../auth/src/login.js";
import { cotalAuthProvider } from "../../auth/src/provider.js";
import { startAuthService, type AuthServiceHandle } from "../../auth/src/service.js";
import { authClientSentinelKey, ensurePinnedIdp, loadOwnerSecret, saveAuthServiceInfo } from "../../auth/src/store.js";
import { mintServiceCallerPayloadObserverCreds } from "../../auth/src/service-caller-payload-bootstrap.js";
import { SERVICE_CALLER_PAYLOAD_FLOOR } from "../../auth/src/service-caller-payload.js";
import { LINEAR_COMMANDS } from "../src/contract.js";
import { linearUserAuthRequest, serveLinearUserAuth } from "../src/user-auth-serve.js";
import type { LinearUpstream } from "../src/upstream.js";

const rid = () => randomBytes(16).toString("hex");
const fx = await startHostedAuthFixture("linearhost", 1, { maxPayload: SERVICE_CALLER_PAYLOAD_FLOOR });
const a = fx.accounts[0]!;
const key = generateKeyPairSync("ed25519");
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "linear-fixture" };
let origin = "";
const jwt = () => {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${b64({ alg: "EdDSA", kid: jwk.kid })}.${b64({ iss: origin, aud: origin, sub: "fixture-human", iat: now, nbf: now, exp: now + 600 })}`;
  return `${body}.${sign(null, Buffer.from(body), key.privateKey).toString("base64url")}`;
};
const idp = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url?.endsWith("/jwks") ? { keys: [jwk] } : { token: jwt() }));
});
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
const idpUrl = `${origin}/api/auth`;
const home = join(fx.dir, "home"), stateDir = join(fx.dir, "server"), dir = join(fx.dir, "client");
for (const path of [home, stateDir, dir]) mkdirSync(path, { mode: 0o700 });
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;
ensurePinnedIdp(stateDir, idpUrl); ensurePinnedIdp(dir, idpUrl);
saveIdpSession(home, idpUrl, { token: "fixture-session", expiresAt: Date.now() / 1000 + 600 });
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "fixture-human");
grantActor(stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
const caller = grantActor(stateDir, { owner, actor: "caller", scope: [], allowSubscribe: [], allowPublish: [] });
const stranger = grantActor(stateDir, { owner, actor: "stranger", scope: [], allowSubscribe: [], allowPublish: [] });
const clientStore = new MemoryStore({ kind: "injected", coordinate: "linear-client" });
await clientStore.put(authClientSentinelKey(a.space), a.sentinelCreds);
let service: AuthServiceHandle | undefined;
const conns: NatsConnection[] = [];
let running: Promise<void> | undefined;
let ctl = new AbortController();
let closedUpstreams = 0, toolCalls = 0;
const upstream = () => ({
  inventory: async () => ({ digest: "fixture-inventory", mode: "readonly", tools: [] }),
  callTool: async () => { toolCalls++; return { kind: "result", inventoryDigest: "fixture-inventory", result: { content: [{ type: "text", text: "fixture-result" }] } }; },
  close: async () => { closedUpstreams++; },
}) as unknown as LinearUpstream;
const seen: ServiceAuthorityRequest[] = [];
let proposalId = "";
const provider: AuthProvider = { ...cotalAuthProvider,
  async serviceEndpointAuthority(opts) {
    // Runtime-parse every request, including ready, to catch extra registration fields.
    parseServiceAuthorityRequest(opts.request);
    seen.push(opts.request);
    const result = await cotalAuthProvider.serviceEndpointAuthority!(opts);
    if (result.result.state === "approval-required") proposalId = result.result.proposalId;
    return result;
  },
};
const endpoint = "ai.cotal.linear";
const start = (onInitialized?: () => void) => serveLinearUserAuth({ account: "fixture", endpoint, space: a.space,
  servers: fx.servers, tls: false, provider, store: clientStore, dir, upstream: upstream(), signal: ctl.signal, onInitialized });
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "linear-fixture" }, space: a.space,
    servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir, serviceEndpoints: { startup: { kind: "normal" },
      callerPayload: { observerCreds: () => mintServiceCallerPayloadObserverCreds({ pub: a.auth.sys.pub, signingSeed: a.auth.sys.signingSeed! }) } } });
  saveAuthServiceInfo(dir, { url: service.url, pid: process.pid, cap: service.cap });
  const host = service.serviceEndpointHost!;
  const bind = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "name-bind", granter: { kind: "operator", auditId: "owned-fixture" },
    input: { endpoint, owner, expectedRevision: 0, claimReference: "owned-fixture-namespace" } });
  assert.equal(bind.state, "bound"); if (bind.state !== "bound") throw new Error("name binding");
  await assert.rejects(start(), /space owner must approve/);
  assert.equal(closedUpstreams, 1, "approval refusal closes its upstream");
  assert.ok(proposalId);
  const request = seen.find((r): r is Extract<ServiceAuthorityRequest, { operation: "register" }> => r.operation === "register")!;
  const proposal = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", granter: { kind: "owner", owner }, input: { proposalId } });
  assert.equal(proposal.state, "present"); if (proposal.state !== "present") throw new Error("proposal read");
  const capabilities = LINEAR_COMMANDS.map(command => ({ endpoint, command, instanceId: request.instanceId, instanceOnly: true }));
  const approved = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner }, input: {
    proposalId, expectedProposalRevision: proposal.record.revision, expectedNameRevision: bind.binding.revision, decision: "approve", callerCeiling: capabilities } });
  assert.equal(approved.state, "approved");
  let initialized!: () => void;
  const ready = new Promise<void>(resolve => { initialized = resolve; });
  running = start(initialized);
  await Promise.race([ready, running.then(() => { throw new Error("service ended before ready"); })]);
  const registers = seen.filter(r => r.operation === "register");
  assert.equal(registers.length, 2);
  assert.equal(contractDigest(registers[0]), contractDigest(registers[1]), "approval replay retains the exact request");
  assert.ok(seen.some(r => r.operation === "ready"), "ready is acknowledged through the native door");
  const registered = (await provider.serviceEndpointAuthority!({ store: clientStore, dir, request })).result;
  assert.equal(registered.state, "registered"); if (registered.state !== "registered") throw new Error("register replay");
  const granted = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-grant", granter: { kind: "owner", owner }, input: {
    grantee: { owner, actor: "caller", lifecycleUid: caller.lifecycleUid! }, service: { endpoint, instanceId: request.instanceId, approvalDigest: registered.witness.approvalDigest },
    capabilities, expectedPolicyRevision: 0 } });
  assert.equal(granted.state, "granted");
  const dial = async (actor: string) => {
    const response = await fetch(`${service!.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify({ idpToken: jwt(), actor }) });
    assert.equal(response.status, 200);
    const { token } = await response.json() as { token: string };
    const nonce = rid();
    const nc = await connect({ servers: fx.servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0,
      authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(token)] });
    conns.push(nc); return nc;
  };
  const nc = await dial("caller");
  const target = await resolveService(nc, a.space, endpoint, { owner, actor: "caller", uid: caller.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 3000 });
  const result = await invokeCommand(nc, a.space, target, "call-tool", { name: "echo", arguments: {}, inventoryDigest: "fixture-inventory" }, { deadlineMs: 3000 });
  assert.equal(result.reply.ok, true, "authorized native discovery and invocation reach Linear's handler");
  assert.equal(toolCalls, 1);
  const denied = await dial("stranger");
  await assert.rejects(resolveService(denied, a.space, endpoint, { owner, actor: "stranger", uid: stranger.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 500 }));
  assert.equal(toolCalls, 1, "ungranted caller does not reach the upstream");
  const keys = [...clientStore.values.keys()].filter(k => k.endsWith("register.json"));
  assert.equal(keys.length, 1);
  await assert.rejects(linearUserAuthRequest(clientStore, keys[0]!, { space: a.space, endpoint, accountPublicKey: "wrong-account" }), /another account/);
  ctl.abort(); await running; running = undefined;
  assert.equal(closedUpstreams, 2, "normal stop closes the serving upstream");
  ctl = new AbortController();
  const restarted = new Promise<void>(resolve => { initialized = resolve; });
  running = start(initialized);
  await Promise.race([restarted, running.then(() => { throw new Error("service ended before restart ready"); })]);
  const lastRegister = seen.filter(r => r.operation === "register").at(-1)!;
  assert.equal(contractDigest(lastRegister), contractDigest(request), "restart retains the approved instance and request");
  const resumed = await resolveService(nc, a.space, endpoint, { owner, actor: "caller", uid: caller.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 3000 });
  const resumedReply = await invokeCommand(nc, a.space, resumed, "call-tool", { name: "echo", arguments: {}, inventoryDigest: "fixture-inventory" }, { deadlineMs: 3000 });
  assert.equal(resumedReply.reply.ok, true, "the same instance-scoped caller grant serves after restart");
  assert.equal(toolCalls, 2);
  ctl.abort(); await running; running = undefined;
  assert.equal(closedUpstreams, 3, "restart stop closes its upstream");
  console.log("LINEAR HOSTED SERVE: approval replay, native ready, exact caller discovery/invocation, ungranted refusal, account pin, stop and same-instance restart passed");
} finally {
  ctl.abort(); await running?.catch(() => {});
  for (const nc of conns) await nc.close();
  await service?.close();
  await new Promise<void>(resolve => idp.close(() => resolve()));
  if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
  await fx.close();
}
