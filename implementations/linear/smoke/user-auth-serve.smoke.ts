/** Real owned authority and broker; the upstream tool reply is an inert fixture, not Linear data. */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, EpEnvelopeError, contractDigest, invokeCommand, mintCreds, newIdentity, parseServiceAuthorityRequest, resolveService,
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
import { serviceEndpointHostCall } from "../../auth/src/service-host-client.js";
import { isCommandFailure } from "@cotal-ai/workspace";
import { SERVICE_CALLER_PAYLOAD_FLOOR } from "../../auth/src/service-caller-payload.js";
import { LINEAR_CAPABILITY, LINEAR_COMMANDS } from "../src/contract.js";
import { linearUserAuthRequest, serveLinearUserAuth } from "../src/user-auth-serve.js";
import type { LinearUpstream } from "../src/upstream.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

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
const endpoints: CotalEndpoint[] = [];
let running: Promise<void> | undefined;
let ctl = new AbortController();
let closedUpstreams = 0, toolCalls = 0;
const heldTools = new Map<string, { started(): void; released: Promise<void> }>();
const upstream = () => ({
  inventory: async () => ({ endpoint: "ai.cotal.linear", digest: "fixture-inventory", fetchedAt: new Date().toISOString(),
    mode: "readonly", server: {}, capabilities: {}, unsupported: [], pages: 1, bytes: 0, tools: [] }),
  callTool: async (input: { name: string }) => {
    toolCalls++;
    const held = heldTools.get(input.name);
    if (held) { held.started(); await held.released; }
    if (input.name === "executed-denial" || input.name === "unknown-denial" || input.name === "not-executed-denial")
      throw new EpEnvelopeError("permission-denied", "fixture responder refusal", undefined,
        input.name === "executed-denial" ? "executed" : input.name === "unknown-denial" ? "unknown" : "not-executed");
    return { kind: "result", inventoryDigest: "fixture-inventory", result: { content: [{ type: "text", text: "fixture-result" }] } };
  },
  close: async () => { closedUpstreams++; },
}) as unknown as LinearUpstream;
const seen: ServiceAuthorityRequest[] = [];
const renewalEvents = new EventEmitter();
const expiries: number[] = [];
let proposalId = "";
const provider: AuthProvider = { ...cotalAuthProvider,
  serviceEndpointRenewal(opts) {
    const source = cotalAuthProvider.serviceEndpointRenewal!(opts);
    return { ...source,
      get sentinelCreds() { return source.sentinelCreds; },
      async credential() {
        const credential = await source.credential();
        expiries.push(credential.accessExpiresAt);
        renewalEvents.emit("credential");
        return credential;
      },
    };
  },
  async serviceEndpointAuthority(opts) {
    // Runtime-parse every request, including ready, to catch extra registration fields.
    parseServiceAuthorityRequest(opts.request);
    seen.push(opts.request);
    const result = await cotalAuthProvider.serviceEndpointAuthority!(opts);
    if (result.result.state === "approval-required") proposalId = result.result.proposalId;
    if (opts.request.operation === "ready" && result.result.state === "ready") renewalEvents.emit("ready");
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
  const refused = await start().then(() => undefined, (error: unknown) => error);
  assert.ok(isCommandFailure(refused) && /space owner must approve/.test(refused.message), String(refused));
  assert.equal(closedUpstreams, 1, "approval refusal closes its upstream");
  assert.ok(proposalId);
  const request = seen.find((r): r is Extract<ServiceAuthorityRequest, { operation: "register" }> => r.operation === "register")!;
  assert.deepEqual(refused.target, { space: a.space, endpoint, instanceId: request.instanceId, proposalId }, "the refusal's target carries the live proposal id");
  // The owner approves by running the remedy's command as printed; its ceiling must cover the Linear commands.
  const remedy = /`cotal service-endpoint approve ([^\s`]+) --caller-ceiling ([^\s`]+) --space ([^\s`]+)`, then repeat the same serve command/.exec(refused.remedy ?? "");
  assert.ok(remedy, `the remedy names the approve command: ${refused.remedy}`);
  assert.deepEqual(remedy.slice(1), [proposalId, LINEAR_CAPABILITY, a.space], "the approve command names this proposal, the Linear capability and this space");
  const approved = (await serviceEndpointHostCall(dir, remedy[3]!, ["approve", remedy[1]!], { "caller-ceiling": remedy[2]! })).answer;
  assert.equal(approved.state, "approved");
  if (approved.state !== "approved") throw new Error("approval");
  assert.deepEqual(approved.approval.callerCeiling.map(c => c.command).sort(), [...LINEAR_COMMANDS].sort(), "the remedy's ceiling covers every Linear command");
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
  const bearer = async (actor: string) => {
    const response = await fetch(`${service!.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify({ idpToken: jwt(), actor }) });
    assert.equal(response.status, 200);
    const { token } = await response.json() as { token: string };
    return token;
  };
  const dial = async (actor: string) => {
    const token = await bearer(actor);
    const nonce = rid();
    const nc = await connect({ servers: fx.servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0,
      authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(token)] });
    conns.push(nc); return nc;
  };
  // A caller connected before its grant keeps the permissions it authenticated with (#5668).
  const early = await dial("caller");
  const openCaller = async (actor = "caller", lifecycleUid = caller.lifecycleUid!, onConnection?: (nc: NatsConnection) => void) => {
    const ep = new CotalEndpoint({ space: a.space, servers: fx.servers, bearer: () => bearer(actor), onConnection,
      sentinelCreds: a.sentinelCreds, lifecycleUid, channels: [], consume: false,
      watchPresence: false, registerPresence: false, watchChannels: false,
      card: { owner, actor, name: actor, kind: "agent" } });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    endpoints.push(ep);
    await ep.start();
    return ep;
  };
  const connected = await openCaller();
  const pinnedCaller = await openCaller();
  let reconnects = 0;
  connected.on("connection", ({ connected }: { connected: boolean }) => { if (connected) reconnects++; });
  const grantCall = await serviceEndpointHostCall(dir, a.space, ["grant", proposalId], { to: `${owner}.caller`, lifecycle: caller.lifecycleUid!, commands: LINEAR_COMMANDS.join(",") });
  assert.equal(grantCall.answer.state, "granted");
  assert.match(grantCall.note ?? "", new RegExp(`connection ${owner}\\.caller opened before this grant .*must reconnect`), "the grant result says a connected grantee must reconnect");
  const stale = await resolveService(early, a.space, endpoint, { owner, actor: "caller", uid: caller.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 3000 }).then(() => undefined, (e: unknown) => e);
  assert.ok(stale instanceof EpEnvelopeError && stale.code === "permission-denied" && stale.outcome === "not-executed", String(stale));
  assert.match(stale.message, /granted after this connection authenticated.*reconnect and retry/, "the connected caller is told to reconnect, not that it holds no grant");
  const toolArgs = (name: string) => ({ name, arguments: {}, inventoryDigest: "fixture-inventory" });
  const recovered = await Promise.all([
    connected.invokeService(endpoint, "call-tool", toolArgs("echo"), { deadlineMs: 3000 }),
    connected.invokeService(endpoint, "call-tool", toolArgs("echo"), { deadlineMs: 3000 }),
  ]);
  assert.ok(recovered.every(r => r.reply.ok), "concurrent late-granted mutations recover without a manual reconnect");
  assert.equal(toolCalls, 2, "each recovered mutation executes once");
  assert.equal(reconnects, 1, "concurrent refusals share one connection rebuild");
  assert.equal((await pinnedCaller.invokeService(endpoint, "inventory", {}, { instanceId: request.instanceId, deadlineMs: 3000 })).reply.ok,
    true, "a pinned pre-grant describe recovers on a fresh connection too");
  for (const [name, outcome] of [["executed-denial", "executed"], ["unknown-denial", "unknown"], ["not-executed-denial", "not-executed"]] as const) {
    const before: number = toolCalls;
    const reply = await connected.invokeService(endpoint, "call-tool", toolArgs(name), { deadlineMs: 3000 });
    assert.equal(reply.reply.ok, false);
    assert.equal(reply.reply.error?.outcome, outcome, "the responder's outcome survives");
    assert.equal(toolCalls, before + 1, "a responder refusal is never replayed");
    assert.equal(reconnects, 1, "a responder refusal never reconnects");
  }
  const hold = (name: string) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    heldTools.set(name, { started: entered, released });
    return { started, release };
  };
  const timeoutGate = hold("timeout");
  const beforeTimeout = toolCalls;
  const timedOut = connected.invokeService(endpoint, "call-tool", toolArgs("timeout"), { deadlineMs: 100 });
  const timeoutResult = timedOut.then(() => false, (e: unknown) => e instanceof EpEnvelopeError && e.code === "deadline-exceeded" && e.outcome === "unknown");
  try {
    await Promise.race([timeoutGate.started, timeoutResult.then(() => { throw new Error("mutation never reached the upstream"); })]);
    assert.equal(await timeoutResult, true, "a published request without a reply has unknown outcome");
    assert.equal(toolCalls, beforeTimeout + 1, "an unknown mutation is never replayed");
    assert.equal(reconnects, 1, "an unknown timeout never starts permission recovery");
  } finally { timeoutGate.release(); await timeoutResult; }
  const drainingGate = hold("draining");
  const draining = connected.invokeService(endpoint, "call-tool", toolArgs("draining"), { deadlineMs: 3000 });
  const drainingResult = draining.then(reply => reply.reply.ok, () => false);
  try {
    await Promise.race([drainingGate.started, drainingResult.then(() => { throw new Error("drain mutation never reached the upstream"); })]);
    const beforeDeadline = Date.now();
    await assert.rejects(connected.invokeService(endpoint, "inventory", {}, { instanceId: rid(), deadlineMs: 60 }),
      (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied" && e.outcome === "not-executed");
    assert.ok(Date.now() - beforeDeadline < 1000, "drain waiting respects the recovery's own deadline");
    const cancellation = new AbortController();
    const reason = new Error("cancelled pending recovery");
    const cancelled = connected.invokeService(endpoint, "inventory", {}, { instanceId: rid(), deadlineMs: 3000, signal: cancellation.signal });
    const cancelledResult = cancelled.then(() => false, (e: unknown) => e === reason);
    await new Promise(resolve => setTimeout(resolve, 50));
    cancellation.abort(reason);
    assert.equal(await cancelledResult, true, "cancellation interrupts recovery while another request holds the drain");
    drainingGate.release();
    assert.equal(await drainingResult, true, "expired and cancelled recoveries preserve the active mutation's reply");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reconnects, 1, "expired and cancelled drains never reconnect later");
  } finally { drainingGate.release(); await drainingResult; }
  // A recovery must wait for requests admitted after its first drain snapshot too.
  let raceNc!: NatsConnection;
  const raceCaller = await openCaller("caller", caller.lifecycleUid!, nc => { raceNc = nc; });
  const firstGate = hold("first"), lateGate = hold("late");
  let raceReconnects = 0;
  let duringRebuild: Promise<boolean> | undefined;
  let cancelledAdmission: Promise<boolean> | undefined, expiredAdmission: Promise<boolean> | undefined;
  raceCaller.on("connection", ({ connected }: { connected: boolean }) => {
    if (connected) raceReconnects++;
    else {
      duringRebuild = raceCaller.invokeService(endpoint, "inventory", {}, { deadlineMs: 3000 }).then(reply => reply.reply.ok, () => false);
      const cancellation = new AbortController();
      const reason = new Error("cancelled rebuild admission");
      cancelledAdmission = raceCaller.invokeService(endpoint, "call-tool", toolArgs("must-not-run"), { signal: cancellation.signal })
        .then(() => false, (e: unknown) => e === reason);
      cancellation.abort(reason);
      expiredAdmission = raceCaller.invokeService(endpoint, "call-tool", toolArgs("must-not-run"), { deadlineMs: 0 })
        .then(() => false, (e: unknown) => e instanceof EpEnvelopeError && e.code === "deadline-exceeded" && e.outcome === "not-executed");
    }
  });
  const status = raceNc.status() as ReturnType<NatsConnection["status"]> & { stop(): void };
  const refusedPublish = (async () => {
    try {
      for await (const event of status) {
        if (event.type === "error" && event.error instanceof PermissionViolationError
          && event.error.operation === "publish" && event.error.subject.includes(".describe.")) return;
      }
      throw new Error("permission observation ended before the refusal");
    } finally { status.stop(); }
  })();
  const beforeRace = toolCalls;
  const firstResult = raceCaller.invokeService(endpoint, "call-tool", toolArgs("first"), { deadlineMs: 3000 }).then(reply => reply.reply.ok, () => false);
  let lateResult: Promise<boolean> | undefined, refusalResult: Promise<boolean> | undefined;
  try {
    await Promise.race([firstGate.started, firstResult.then(() => { throw new Error("first mutation never reached the upstream"); })]);
    refusalResult = raceCaller.invokeService(endpoint, "inventory", {}, { instanceId: rid(), deadlineMs: 3000 })
      .then(() => false, (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied" && e.outcome === "not-executed");
    await Promise.race([refusedPublish, refusalResult.then(() => { throw new Error("broker refusal was not observed"); })]);
    await new Promise(resolve => setTimeout(resolve, 0));
    lateResult = raceCaller.invokeService(endpoint, "call-tool", toolArgs("late"), { deadlineMs: 3000 }).then(reply => reply.reply.ok, () => false);
    await Promise.race([lateGate.started, lateResult.then(() => { throw new Error("late mutation never reached the upstream"); })]);
    firstGate.release();
    assert.equal(await firstResult, true, "the original request keeps its reply");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(raceReconnects, 0, "a later pending mutation also holds the recovery barrier");
    lateGate.release();
    assert.equal(await lateResult, true, "the later mutation keeps its reply");
    assert.equal(await refusalResult, true, "the unrelated permanent refusal stands");
    assert.equal(await duringRebuild, true, "a call arriving during rebuild waits for the fresh connection");
    assert.equal(await cancelledAdmission, true, "a cancelled rebuild admission never publishes");
    assert.equal(await expiredAdmission, true, "an expired rebuild admission never publishes");
    assert.equal(raceReconnects, 1, "one bounded recovery completes after the live drain");
    assert.equal(toolCalls, beforeRace + 2, "the two held mutations each execute once");
  } finally {
    firstGate.release(); lateGate.release(); status.stop();
    await Promise.allSettled([firstResult, lateResult, refusalResult, refusedPublish, duringRebuild, cancelledAdmission, expiredAdmission]);
    heldTools.clear();
  }
  const ungranted = await openCaller("stranger", stranger.lifecycleUid!);
  let deniedReconnects = 0;
  ungranted.on("connection", ({ connected }: { connected: boolean }) => { if (connected) deniedReconnects++; });
  await assert.rejects(ungranted.invokeService(endpoint, "inventory", {}, { instanceId: request.instanceId, deadlineMs: 3000 }),
    (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied" && e.outcome === "not-executed" && /reconnect and retry/.test(e.message));
  assert.equal(deniedReconnects, 1, "a permanent refusal reconnects only once");
  const beforeAbort = toolCalls;
  const aborted = new AbortController();
  aborted.abort(new Error("fixture cancellation"));
  await assert.rejects(connected.invokeService(endpoint, "call-tool", toolArgs("echo"), { signal: aborted.signal }), /fixture cancellation/);
  assert.equal(toolCalls, beforeAbort, "a cancelled call never publishes");
  const recoveryCalls = toolCalls;
  const nc = await dial("caller");
  const target = await resolveService(nc, a.space, endpoint, { owner, actor: "caller", uid: caller.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 3000 });
  const result = await invokeCommand(nc, a.space, target, "call-tool", { name: "echo", arguments: {}, inventoryDigest: "fixture-inventory" }, { deadlineMs: 3000 });
  assert.equal(result.reply.ok, true, "authorized native discovery and invocation reach Linear's handler");
  assert.equal(toolCalls, recoveryCalls + 1);
  const denied = await dial("stranger");
  await assert.rejects(resolveService(denied, a.space, endpoint, { owner, actor: "stranger", uid: stranger.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 500 }));
  assert.equal(toolCalls, recoveryCalls + 1, "ungranted caller does not reach the upstream");
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
  assert.equal(toolCalls, recoveryCalls + 2);
  if (process.argv.includes("--renewal")) {
    const firstExpiry = expiries.at(-1)!;
    const reconnected = once(renewalEvents, "ready", { signal: AbortSignal.timeout(90_000) });
    await Promise.race([
      once(renewalEvents, "credential", { signal: AbortSignal.timeout(55_000) }),
      running.then(() => { throw new Error("service stopped before its automatic renewal"); }),
    ]);
    assert.ok(expiries.at(-1)! > firstExpiry, "the endpoint timer obtains a fresh native bearer without a manual pull");
    await Promise.race([reconnected, running.then(() => { throw new Error("service stopped before expiry reconnect"); })]);
    assert.ok(Date.now() < firstExpiry * 1000, "native ready follows the live swap before the original broker credential expires");
    const refreshed = await resolveService(nc, a.space, endpoint, { owner, actor: "caller", uid: caller.lifecycleUid! }, { instanceId: request.instanceId, deadlineMs: 3000 });
    const refreshedReply = await invokeCommand(nc, a.space, refreshed, "call-tool", { name: "echo", arguments: {}, inventoryDigest: "fixture-inventory" }, { deadlineMs: 3000 });
    assert.equal(refreshedReply.reply.ok, true, "the same native instance serves after expiry reconnect");
    assert.equal(toolCalls, recoveryCalls + 3);
    if (approved.state !== "approved") throw new Error("approval missing");
    const revoked = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner }, input: {
      endpoint, instanceId: request.instanceId, expectedAssignmentDigest: approved.approval.assignment.assignmentDigest, cause: "owner-request" } });
    assert.equal(revoked.state, "pending", "the host confirms deny-new, not completed eviction");
    const shutdownDeadline = setTimeout(() => ctl.abort(), 55_000);
    try { await assert.rejects(running, /stopped after its remote authority/); }
    finally { clearTimeout(shutdownDeadline); }
    running = undefined;
    assert.equal(closedUpstreams, 3, "a terminal renewal denial closes the serving upstream");
    await assert.rejects(start(), /did not authorize|renewal ended/);
    assert.equal(closedUpstreams, 4, "a revoked restart closes its upstream without a replacement registration");
    assert.equal(contractDigest(seen.filter(r => r.operation === "register").at(-1)!), contractDigest(request));
    assert.equal(toolCalls, recoveryCalls + 3);
    console.log("LINEAR HOSTED RENEWAL: native timer, real bearer-expiry reconnect, same-instance invocation, deny-new shutdown and revoked restart refusal passed; remote eviction is not claimed");
  } else {
    ctl.abort(); await running; running = undefined;
    assert.equal(closedUpstreams, 3, "restart stop closes its upstream");
  }
  console.log("LINEAR HOSTED SERVE: approval, native ready, late-grant recovery, concurrent request draining, bounded cancellation, no mutation replay, ungranted refusal, account pin and same-instance restart passed");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  await Promise.all(endpoints.map(ep => ep.stop().catch(() => {})));
  ctl.abort(); await running?.catch(() => {});
  for (const nc of conns) await nc.close();
  await service?.close();
  await new Promise<void>(resolve => idp.close(() => resolve()));
  if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
  await fx.close();
}
