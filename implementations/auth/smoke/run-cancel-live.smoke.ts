/** Cooperative cancellation through a signerless manager, its real issuer HTTP door and broker.
 * The fixture creates only parked workflows, no agent processes or provider calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  issuedUserCaller, mintCreds, mintLifecycleUid, mintGeneration, mintAcceptedToken, newIdentity, setupSpaceStreams,
  withIssuerSession, standaloneConnectOpts,
  resolveService, invokeCommand, registry, type RuntimeProvider, type IssuedCaller,
  RUN_HOST_KIND, COTAL_LANG_RUN_HOST, recordsBucket, recordStatusKey, RECORD_KINDS, admissionBucket, revocationKey, type RunHost,
  type RemoteManagerAuthorityMaterial, type RemoteRunAdmissionResult, type RemoteRunAttemptResult,
  type RemoteRunCancelResult, type RunCancelResult, type RunStatusView, type EndpointReply,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, startAuthService,
  type AuthServiceHandle,
} from "../src/index.js";
import { remoteManagerRegistrationProof } from "../src/authority-client.js";
import { Manager, managerClusterArtifacts, registerRemoteManagerAuthority } from "../../manager/src/index.js";
import * as remote from "../../manager/src/remote-authority.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import "../../runtime/src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, name: string, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} did not arrive`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
let launchHold: { entered: ReturnType<typeof deferred<string>>; release: ReturnType<typeof deferred<void>>;
  marker: ReturnType<typeof deferred<void>>; startSettled: ReturnType<typeof deferred<void>>;
  beforeReply: boolean; runId?: string } | undefined;
let completionHold: { entered: ReturnType<typeof deferred<string>>; release: ReturnType<typeof deferred<void>> } | undefined;
let postMarkerHold: { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
let nextOperatorHold: typeof postMarkerHold;
let failStatusMarkerRead = false;
const realHost = registry.resolve<RunHost>(RUN_HOST_KIND, COTAL_LANG_RUN_HOST);
registry.unregister(RUN_HOST_KIND, COTAL_LANG_RUN_HOST);
const observedHost: RunHost = { ...realHost, drive: (planes, request, mediator) => {
  const hold = completionHold;
  if (hold) {
    const send = planes.nc.request.bind(planes.nc);
    const subject = `$KV.${recordsBucket(planes.space)}.${recordStatusKey(RECORD_KINDS.run, [request.endpoint, request.runId])}`;
    planes.nc.request = async (target, data, options) => {
      if (target === subject) {
        const row = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as { state?: string };
        if (row.state === "completed") {
          hold.entered.resolve(request.runId);
          await bounded(hold.release.promise, "release of the actual completed-status write");
        }
      }
      return send(target, data, options);
    };
  }
  return realHost.drive(planes, request, mediator);
}, status: async (planes, request) => {
  if (!failStatusMarkerRead) return realHost.status(planes, request);
  const read = planes.jsm.streams.getMessage.bind(planes.jsm.streams);
  const bucket = admissionBucket(planes.space);
  const subject = `$KV.${bucket}.${revocationKey(request.endpoint, request.runId)}`;
  planes.jsm.streams.getMessage = async (stream, query) => {
    if (stream === `KV_${bucket}` && "last_by_subj" in query && query.last_by_subj === subject) {
      failStatusMarkerRead = false;
      throw new Error("fixture marker read unavailable");
    }
    return read(stream, query);
  };
  try { return await realHost.status(planes, request); }
  finally { planes.jsm.streams.getMessage = read; }
} };
registry.register(observedHost);
let passed = 0;
async function cell(name: string, check: () => Promise<void>) {
  await check();
  passed++;
  console.log(`  ✓ ${name}`);
}
const fx = await startHostedAuthFixture("cancel", 1);
const account = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "cancel-idp", alg: "EdDSA" };
const idp = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
rmSync(join(account.stateDir, "idp.json"));
ensurePinnedIdp(account.stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(account.store, account.space))!, origin, "cancel-human");
const cli = grantActor(account.stateDir, { owner, actor: "cli", scope: ["admin", "spawn", "run", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });
const operator = grantActor(account.stateDir, { owner, actor: "operator", scope: ["run"], allowSubscribe: [">"], allowPublish: [">"] });
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "cancel-idp" }).setSubject("cancel-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);
const runtime: RuntimeProvider = { kind: "runtime", name: "cancel-fixture", available: () => true, create: () => ({
  kind: "cancel-fixture", spawn: () => { throw new Error("this fixture starts no agent processes"); },
}) };
registry.register(runtime);
const state = remote.loadOrCreateRemoteManagerIdentity(join(fx.dir, "manager-identity"), account.space);
let service: AuthServiceHandle | undefined;
let manager: Manager | undefined;
const connections: NatsConnection[] = [];
const stages: Array<{ stage: "inspect" | "commit"; runId: string }> = [];
let loseCommitReply = false;
let failReadbackAfterLoss = false;
let failNextOperatorReads = 0;
const callerLimit = 64;
const cancellationCalls = new Map<string, number>();
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${service!.cap}`,
  }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}
const authority = (request: import("@cotal-ai/core").RemoteManagerAuthorityRequest) =>
  post<RemoteManagerAuthorityMaterial>("/manager-service-authority", { idpToken, request });
async function dial(actor: string, uid: string) {
  const exchange = await post<{ token: string }>("/exchange", { idpToken, actor, view: "manager-caller", managerInstanceId: state.instanceId });
  const nonce = mintLifecycleUid();
  const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(new TextEncoder().encode(account.sentinelCreds)), tokenAuthenticator(exchange.token)],
    name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 5000 });
  connections.push(nc);
  const caller = await issuedUserCaller(nc, account.space, nonce, { owner, actor, uid });
  return { nc, caller };
}
type Client = { nc: NatsConnection; caller: IssuedCaller };
/** The human manager-caller view has no channel rows. This separate fixture-owned issuer uses
 * the supported agent profile with one declared channel. It tests channel cancellation, not the
 * human callout's channel issuance or interactive-owner authority. */
async function channelClient(): Promise<Client> {
  const identity = newIdentity(), uid = mintLifecycleUid();
  const issued = { generation: mintGeneration(), acceptedToken: mintAcceptedToken() };
  const caller: IssuedCaller = { owner, actor: "channel", uid, generation: issued.generation };
  const creds = await withIssuerSession({ servers: fx.servers, space: account.space, auth: account.auth, tls: false }, session =>
    mintCreds(account.auth, identity, "agent", { principal: { owner, actor: "channel" }, lifecycleUid: uid,
      capabilities: ["run"], allowSubscribe: ["cancel-window"], issued, expiresInSeconds: 300,
      endpointCapabilities: ["describe", "run-start", "run-status", "run-cancel"].map(command => ({ endpoint: "manager", command, instanceId: state.instanceId, instanceOnly: true })),
      issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] } }));
  const nc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  connections.push(nc);
  return { nc, caller };
}
async function call(client: Client, command: string, args: Record<string, unknown>): Promise<EndpointReply> {
  const target = await resolveService(client.nc, account.space, "manager", client.caller, { instanceId: state.instanceId, deadlineMs: 10000 });
  if (command === "run-cancel") cancellationCalls.set(client.caller.uid, (cancellationCalls.get(client.caller.uid) ?? 0) + 1);
  return (await invokeCommand(client.nc, account.space, target, command, args, { deadlineMs: 15000 })).reply;
}
async function status(client: Client, runId: string, wanted: "pending" | "released" | "completed"): Promise<RunStatusView> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await call(client, "run-status", { runId });
    assert.ok(reply.ok, reply.error?.message);
    const view = reply.data as RunStatusView;
    if (wanted !== "pending" ? view.status?.state === wanted : view.journal.some(r => r.kind === "step" && r.state === wanted)) return view;
    assert.notEqual(view.status?.state, "failed", "workflow failed before expected observation");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`run did not reach ${wanted}`);
}
async function start(client: Client, source: string) {
  const reply = await call(client, "run-start", { source });
  assert.ok(reply.ok, reply.error?.message);
  const runId = (reply.data as { runId: string }).runId;
  const pending = await status(client, runId, "pending");
  assert.equal(pending.revoked, undefined);
  assert.equal(pending.revocationUnreadable, undefined);
  return runId;
}
try {
  await setupSpaceStreams({ servers: fx.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  service = await startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: account.space,
    servers: fx.servers, stateDir: account.stateDir, store: account.store, storeIdentity: account.store.identity, publicFace: { port: 0, trustedProxy: false } });
  const prepared = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const registered = await registerRemoteManagerAuthority({ space: account.space, server: fx.servers, owner, instanceId: state.instanceId,
    serveActor: prepared.actors.serve, prepareCreds: remote.materialCredential(prepared, "executor", state.identities.executor), tlsRequired: false, evict: async () => [] });
  const cluster = managerClusterArtifacts(), contractArtifacts = [cluster.document, cluster.manifest];
  const activated = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
  const proof = remote.currentRegistrationProof(activated);
  const supervisorCreds = remote.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: authority });
  const root = join(fx.dir, "manager-root");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  const unused = async (): Promise<never> => { throw new Error("this fixture opens no agent or terminal session"); };
  manager = new Manager({ space: account.space, servers: fx.servers, workspaceRoot: root, runtime: runtime.name, remoteAuthority: {
    ...standing, owner, actors: prepared.actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities, supervisorCreds,
    executorCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
    renewExecutor: async () => remote.materialCredential(await authority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
    serveCreds: remote.materialCredential(activated, "serve", state.identities.serve),
    goalWriterCreds: remote.materialCredential(activated, "goalWriter", state.identities.goalWriter),
    sessionLedgerCreds: remote.materialCredential(activated, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant,
    mintSessionServing: unused, mintRetirementRequester: unused, prepareAgentRetirement: unused, validateRetainedAgent: unused, enrollManagedAgent: unused,
    agentBearerExchangeUrl: service.publicUrl!,
    scanGoalIndex: async () => {
      const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
      return remote.remoteManagerGoalIndexEntries(await post("/manager-service-authority", { idpToken, request }), request, owner);
    },
    authorizeAdmin: async (caller) => {
      const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
      return remote.remoteManagerAdminAuthorized(await post("/manager-service-authority", { idpToken, request }), request, owner);
    },
    runHosting: remote.remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: account.accountPublicKey, processEpoch: registered.processEpoch,
      requestRunAdmission: request => post<RemoteRunAdmissionResult>("/manager-service-authority", { idpToken, request }),
      requestRunAttempt: async request => {
        if (request.operator && nextOperatorHold) {
          const hold = nextOperatorHold;
          nextOperatorHold = undefined;
          hold.entered.resolve();
          await bounded(hold.release.promise, "post-marker holder reader release", 20000);
        }
        if (request.operator && failNextOperatorReads > 0) {
          failNextOperatorReads--;
          throw new Error("fixture read-only issuance transport unavailable");
        }
        const result = await post<RemoteRunAttemptResult>("/manager-service-authority", { idpToken, request });
        const hold = launchHold;
        if (request.attempt && hold) {
          hold.runId = request.attempt.runId;
          hold.entered.resolve(request.attempt.runId);
          await hold.release.promise;
        }
        return result;
      },
      requestRunCancel: async request => {
        stages.push({ stage: request.stage, runId: request.cancel.runId });
        const result = await post<RemoteRunCancelResult>("/manager-service-authority", { idpToken, request });
        if (result.stage === "commit" && result.result.kind === "committed" && postMarkerHold) {
          nextOperatorHold = postMarkerHold;
          postMarkerHold = undefined;
        }
        const hold = launchHold;
        if (result.stage === "commit" && result.result.kind === "committed" && hold?.runId === request.cancel.runId) {
          if (hold.beforeReply) {
            hold.release.resolve();
            await bounded(hold.startSettled.promise, "start response after pending cancellation");
          }
          hold.marker.resolve();
        }
        if (request.stage === "commit" && loseCommitReply) {
          loseCommitReply = false;
          if (failReadbackAfterLoss) {
            failReadbackAfterLoss = false;
            failNextOperatorReads = 1;
          }
          throw new Error("fixture loses the issuer reply after the real HTTP commit");
        }
        return result;
      }, call: authority }),
  } });
  await manager.start();
  const original = await dial("cli", cli.lifecycleUid!);
  let firstRun = "";
  let firstResult: RunCancelResult | undefined;
  await cell("original caller cancels a parked checkpoint through issuer inspect and commit", async () => {
    firstRun = await start(original, 'await checkpoint("parked", "Await input"); log("must not execute");');
    const reply = await call(original, "run-cancel", { runId: firstRun, reason: "checkpoint fixture finished" });
    assert.ok(reply.ok, reply.error?.message);
    firstResult = reply.data as RunCancelResult;
    assert.equal(firstResult.authority, "original");
    assert.equal(firstResult.observed.phase, "stopped");
    assert.equal(firstResult.observed.driveOutcome?.status, "released");
    assert.equal(firstResult.duplicate, false);
    assert.deepEqual(stages.filter(s => s.runId === firstRun).map(s => s.stage), ["inspect", "commit"]);
    const final = await status(original, firstRun, "released");
    console.log(`status marker observation: ${JSON.stringify({ recordedState: final.status?.state,
      hasRevoked: Object.hasOwn(final, "revoked"), hasUnreadable: Object.hasOwn(final, "revocationUnreadable"),
      cancellationObservedMarker: firstResult.revocation !== undefined })}`);
    assert.deepEqual(final.revoked, { by: firstResult.revocation!.by, reason: firstResult.revocation!.reason });
    assert.equal(final.revocationUnreadable, undefined);
    assert.ok(!final.journal.some(r => r.kind === "step" && r.step.includes("log")));
  });
  await cell("status reports an unreadable marker without claiming it absent", async () => {
    failStatusMarkerRead = true;
    try {
      const reply = await call(original, "run-status", { runId: firstRun });
      assert.ok(reply.ok, reply.error?.message);
      const view = reply.data as RunStatusView;
      assert.equal(failStatusMarkerRead, false, "the actual status marker reader reached the injected failure");
      assert.equal(view.status?.state, "released");
      assert.equal(view.revoked, undefined);
      assert.equal(view.revocationUnreadable, "fixture marker read unavailable");
    } finally { failStatusMarkerRead = false; }
    const recovered = await status(original, firstRun, "released");
    assert.deepEqual(recovered.revoked, { by: firstResult!.revocation!.by, reason: firstResult!.revocation!.reason });
    assert.equal(recovered.revocationUnreadable, undefined);
  });
  await cell("fresh duplicate keeps the first marker", async () => {
    const reply = await call(original, "run-cancel", { runId: firstRun, reason: "later reason" });
    assert.ok(reply.ok, reply.error?.message);
    const result = reply.data as RunCancelResult;
    assert.equal(result.duplicate, true);
    assert.deepEqual(result.revocation, firstResult!.revocation);
  });
  await cell("new issued generation of the original lifecycle cancels a parked sleep", async () => {
    const runId = await start(original, 'await sleep("1h", { name: "parked" }); log("must not execute");');
    const fresh = await dial("cli", cli.lifecycleUid!);
    assert.notEqual(fresh.caller.generation, original.caller.generation);
    const reply = await call(fresh, "run-cancel", { runId, reason: "sleep fixture finished" });
    assert.ok(reply.ok, reply.error?.message);
    assert.equal((reply.data as RunCancelResult).duplicate, false);
    await status(original, runId, "released");
  });
  await cell("issuer-attested interactive same-owner operator cancels an owned run", async () => {
    const runId = await start(original, 'await checkpoint("operator", "Await input");');
    const interactive = await dial("operator", operator.lifecycleUid!);
    const reply = await call(interactive, "run-cancel", { runId, reason: "operator fixture finished" });
    assert.ok(reply.ok, reply.error?.message);
    const result = reply.data as RunCancelResult;
    assert.equal(result.authority, "owner-interactive");
    assert.equal(result.revocation?.by, `${owner}.operator`);
    await status(original, runId, "released");
  });
  await cell("lost commit reply converges through marker readback without claiming creation", async () => {
    const runId = await start(original, 'await checkpoint("lost", "Await input");');
    loseCommitReply = true;
    const reply = await call(original, "run-cancel", { runId, reason: "lost reply fixture" });
    assert.ok(reply.ok, reply.error?.message);
    const result = reply.data as RunCancelResult;
    assert.equal(loseCommitReply, false, "the real commit completed before its reply was lost");
    assert.equal(result.duplicate, null);
    assert.equal(result.revocation?.reason, "lost reply fixture");
    assert.equal(result.observed.phase, "stopped");
    assert.deepEqual(stages.filter(s => s.runId === runId).map(s => s.stage), ["inspect", "commit"]);
    await status(original, runId, "released");
  });
  await cell("concurrent requests retain one marker and both report truthful local observations", async () => {
    const runId = await start(original, 'await sleep("1h", { name: "concurrent" });');
    const replies = await Promise.all([
      call(original, "run-cancel", { runId, reason: "first concurrent request" }),
      call(original, "run-cancel", { runId, reason: "second concurrent request" }),
    ]);
    for (const reply of replies) assert.ok(reply.ok, reply.error?.message);
    const results = replies.map(reply => reply.data as RunCancelResult);
    assert.deepEqual(results.map(r => r.duplicate).sort(), [false, true]);
    assert.deepEqual(results[0]!.revocation, results[1]!.revocation);
    assert.ok(results.every(r => r.observed.phase === "stopped" || r.observed.phase === "not-driven-here"));
    await status(original, runId, "released");
  });
  await cell("completed run is observed without creating a revocation marker", async () => {
    const started = await call(original, "run-start", { source: 'log("complete normally");' });
    assert.ok(started.ok, started.error?.message);
    const runId = (started.data as { runId: string }).runId;
    await status(original, runId, "completed");
    const reply = await call(original, "run-cancel", { runId, reason: "already complete" });
    assert.ok(reply.ok, reply.error?.message);
    const result = reply.data as RunCancelResult;
    assert.equal(result.observed.phase, "terminal");
    assert.equal(result.observed.recordedState, "completed");
    assert.equal(result.revocation, undefined);
    assert.equal(result.duplicate, false);
    assert.deepEqual(stages.filter(s => s.runId === runId).map(s => s.stage), ["inspect"]);
  });
  for (const beforeReply of [false, true]) await cell(`admitted launch abandons ${beforeReply ? "before" : "after"} marker reply without creating a drive`, async () => {
    const hold = { entered: deferred<string>(), release: deferred<void>(), marker: deferred<void>(), startSettled: deferred<void>(), beforeReply };
    launchHold = hold;
    const starting = call(original, "run-start", { source: 'await checkpoint("never-started", "Await input");' })
      .then(value => { hold.startSettled.resolve(); return { status: "fulfilled" as const, value }; },
        reason => { hold.startSettled.resolve(); return { status: "rejected" as const, reason }; });
    try {
      const runId = await bounded(hold.entered.promise, "actual attempt issuance");
      const before = await call(original, "run-status", { runId });
      assert.equal(before.ok, false);
      assert.equal(before.error?.code, "not-found", "no drive has created a run record yet");
      const cancelling = call(original, "run-cancel", { runId, reason: "cancel admitted launch" });
      await bounded(hold.marker.promise, "actual issuer marker commit");
      hold.release.resolve();
      const reply = await cancelling;
      assert.ok(reply.ok, reply.error?.message);
      const result = reply.data as RunCancelResult;
      assert.equal(result.observed.phase, "launch-abandoned");
      assert.equal(result.observed.driveOutcome, undefined);
      assert.equal(result.duplicate, false);
      const startResult = await starting;
      assert.equal(startResult.status, "fulfilled");
      if (startResult.status === "fulfilled") {
        assert.equal(startResult.value.ok, false);
        assert.equal(startResult.value.error?.code, "failed-precondition");
      }
      const after = await call(original, "run-status", { runId });
      assert.equal(after.ok, false);
      assert.equal(after.error?.code, "not-found", "cancelled launch never creates a run record");
    } finally {
      hold.release.resolve();
      launchHold = undefined;
      await starting;
    }
  });
  await cell("terminal marker resend clears an earlier unknown pending cancellation", async () => {
    const hold = { entered: deferred<string>(), release: deferred<void>() };
    completionHold = hold;
    try {
      const started = await call(original, "run-start", { source: 'log("complete after the held native status write");' });
      assert.ok(started.ok, started.error?.message);
      const runId = (started.data as { runId: string }).runId;
      assert.equal(await bounded(hold.entered.promise, "actual completed-status write"), runId);
      loseCommitReply = true;
      failReadbackAfterLoss = true;
      const unknown = await call(original, "run-cancel", { runId, reason: "retain unknown until observed" });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error?.code, "deadline-exceeded");
      assert.equal(failNextOperatorReads, 0, "readback encountered the injected transport failure");
      hold.release.resolve();
      await status(original, runId, "completed");
      const resend = await call(original, "run-cancel", { runId, reason: "observe terminal marker" });
      assert.ok(resend.ok, resend.error?.message);
      const result = resend.data as RunCancelResult;
      assert.equal(result.observed.phase, "terminal");
      assert.equal(result.duplicate, true);
      assert.equal(result.revocation?.reason, "retain unknown until observed");
      const resumed = await call(original, "run-resume", { runId });
      assert.equal(resumed.ok, false);
      assert.equal(resumed.error?.code, "permission-denied", "resume must reach durable revocation, not a lingering local pending intent");
    } finally {
      hold.release.resolve();
      completionHold = undefined;
    }
  });
  await cell("a channel wait observes cancellation while the holder recheck is delayed", async () => {
    const channel = await channelClient();
    const runId = await start(channel, 'await wait(message(channel("cancel-window")), { name: "channel-window" });');
    const hold = { entered: deferred<void>(), release: deferred<void>() };
    postMarkerHold = hold;
    const cancelling = call(channel, "run-cancel", { runId, reason: "channel cancellation window" })
      .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
    try {
      await bounded(hold.entered.promise, "post-marker holder read");
      let observed: RunStatusView | undefined;
      const until = performance.now() + 7000;
      while (performance.now() < until) {
        const reply = await call(channel, "run-status", { runId });
        assert.ok(reply.ok, reply.error?.message);
        observed = reply.data as RunStatusView;
        if (observed.status?.state !== "running") break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      console.log(`channel marker window: ${JSON.stringify({ state: observed?.status?.state,
        marker: observed?.revoked !== undefined, outcome: observed?.journal.filter(r => r.kind === "step").at(-1)?.outcome })}`);
      hold.release.resolve();
      const result = await cancelling;
      assert.ok(result.status === "fulfilled");
      assert.ok(result.value.ok, result.value.error?.message);
      const receipt = result.value.data as RunCancelResult;
      console.log(`ended drive receipt: ${JSON.stringify(receipt.observed)}`);
      assert.equal(observed?.status?.state, "released", "an observed cancellation marker must classify the channel exit as cancellation");
      assert.equal(observed?.journal.filter(r => r.kind === "step").at(-1)?.outcome, "cancelled");
      assert.equal(receipt.observed.phase, "stopped", "a captured drive that ended during holder read must report its observed outcome");
      assert.equal(receipt.observed.driveOutcome?.status, "released");
    } finally {
      hold.release.resolve();
      postMarkerHold = undefined;
      nextOperatorHold = undefined;
      await cancelling;
    }
  });
  for (const failure of ["read", "budget"] as const) {
    await cell(`post-marker holder ${failure} failure preserves uncertainty until a fresh cancellation`, async () => {
      const runId = await start(original, 'await checkpoint("reader", "Await input");');
      const hold = { entered: deferred<void>(), release: deferred<void>() };
      postMarkerHold = hold;
      const cancelling = call(original, "run-cancel", { runId, reason: `holder ${failure} fixture` })
        .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
      try {
        await bounded(hold.entered.promise, "post-marker failing holder read");
        if (failure === "read") {
          failNextOperatorReads = 1;
          hold.release.resolve();
        }
        const result = await cancelling;
        hold.release.resolve();
        assert.ok(result.status === "rejected" || !result.value.ok, "no stopped receipt is invented without the required holder read");
        const error = result.status === "rejected" ? result.reason : result.value.error;
        // SPEC 13.3 reads an omitted wire outcome as unknown too.
        assert.equal(error?.outcome ?? "unknown", "unknown");
        console.log(`holder failure observation: ${JSON.stringify({ failure, code: error?.code,
          wireOutcome: error?.outcome ?? null, interpretedOutcome: error?.outcome ?? "unknown" })}`);
        const pending = await status(original, runId, "pending");
        assert.equal(pending.status?.state, "running", "the parked checkpoint was not signalled before the holder fence");
        assert.equal(pending.revoked?.reason, `holder ${failure} fixture`);
        const retry = await call(original, "run-cancel", { runId, reason: "fresh observed-holder cancellation" });
        assert.ok(retry.ok, retry.error?.message);
        const receipt = retry.data as RunCancelResult;
        assert.equal(receipt.duplicate, true);
        assert.equal(receipt.revocation?.reason, `holder ${failure} fixture`);
        assert.equal(receipt.observed.phase, "stopped");
        assert.equal(receipt.observed.driveOutcome?.status, "released");
      } finally {
        hold.release.resolve();
        postMarkerHold = undefined;
        nextOperatorHold = undefined;
        await cancelling;
      }
    });
  }
  await cell("issuer quota refusal names its local budget without caller data", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.startsWith("run-cancel custody:")) warnings.push(text);
      warn(...args);
    };
    try {
      let refused = false;
      for (let attempt = 0; attempt <= callerLimit; attempt++) {
        const reply = await call(original, "run-cancel", { runId: firstRun, reason: "bounded quota fixture" });
        if (!reply.ok) { refused = true; break; }
      }
      assert.ok(refused, "the fixture reaches the issuer's finite caller quota");
      assert.equal(cancellationCalls.get(original.caller.uid), callerLimit + 1, "the refusal occurs only after this lifecycle's exact allowance");
      const repeated = await call(original, "run-cancel", { runId: firstRun, reason: "bounded quota repeat" });
      assert.equal(repeated.ok, false);
      assert.deepEqual(warnings, ["run-cancel custody: caller lifetime budget exhausted; new observations refused"]);
    } finally { console.warn = warn; }
  });
} finally {
  await manager?.stop();
  for (const nc of connections) await nc.close();
  await service?.close();
  await new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve()));
  await fx.stopBroker();
  registry.unregister(RUN_HOST_KIND, COTAL_LANG_RUN_HOST);
  registry.register(realHost);
  // Keep the private fixture root as evidence until the lane's cleanup barrier is established.
  console.log(`retained fixture root: ${fx.dir}`);
}
emitSentinel({ passed, failed: 0 });
