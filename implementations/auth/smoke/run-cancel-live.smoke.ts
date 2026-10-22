/** Cooperative cancellation through a signerless manager, its real issuer HTTP door and broker.
 * The fixture creates only parked workflows, no agent processes or provider calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  issuedUserCaller, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams,
  resolveService, invokeCommand, registry, type RuntimeProvider, type IssuedCaller,
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
async function call(client: Client, command: string, args: Record<string, unknown>): Promise<EndpointReply> {
  const target = await resolveService(client.nc, account.space, "manager", client.caller, { instanceId: state.instanceId, deadlineMs: 10000 });
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
  await status(client, runId, "pending");
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
      requestRunAttempt: request => post<RemoteRunAttemptResult>("/manager-service-authority", { idpToken, request }),
      requestRunCancel: async request => {
        stages.push({ stage: request.stage, runId: request.cancel.runId });
        const result = await post<RemoteRunCancelResult>("/manager-service-authority", { idpToken, request });
        if (request.stage === "commit" && loseCommitReply) {
          loseCommitReply = false;
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
    assert.ok(!final.journal.some(r => r.kind === "step" && r.step.includes("log")));
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
} finally {
  await manager?.stop();
  for (const nc of connections) await nc.close();
  await service?.close();
  await new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve()));
  await fx.stopBroker();
  // Keep the private fixture root as evidence until the lane's cleanup barrier is established.
  console.log(`retained fixture root: ${fx.dir}`);
}
emitSentinel({ passed, failed: 0 });
