/** Managed-seat run issuance through the shipped auth service and native broker. */
// A remote Manager preflights the stock bearer command using this process's entrypoint.
// Serve that re-exec through the registered production command before creating any fixture.
if (process.argv[2] === "agent-bearer") {
  await import("../src/index.js");
  const { registry } = await import("@cotal-ai/core");
  const raw = process.argv.slice(3);
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i]!;
    if (!flag.startsWith("--")) throw new Error("agent-bearer fixture takes flags only");
    const next = raw[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values[flag.slice(2)] = next; i++; }
    else values[flag.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", "agent-bearer").run({ values, positionals: [], raw });
  process.exit(0);
}
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  issuedUserCaller, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams, standaloneConnectOpts,
  resolveService, invokeCommand, readRunAdmission, withIssuerSession, actorLedgerSource, importNativeSubjectPermissions,
  permissionsFor, connectionAcceptedToken, EP_UNBOUND_CALLER_AUTHORITY,
  type EpCaller, type RemoteManagerAuthorityMaterial, type RemoteRunAdmissionResult, type RemoteRunAttemptResult,
  type RunStatusView, type EndpointReply,
  registry, RUN_HOST_KIND, COTAL_LANG_RUN_HOST, type RunHost,
  identityFromCreds, credsFromJwt,
  CotalEndpoint, type Connector, type LaunchOpts, type RuntimeProvider, type AgentHandle,
  runDriverCaller,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  cotalAuthProvider, deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, startAuthService,
  findManagedActor, grantManagedActor, newActorToken, revokeManagedActor, ledgerActorSourceIsLive,
  loadCalloutAuth,
  type AuthServiceHandle,
} from "../src/index.js";
import { remoteManagerRegistrationProof } from "../src/authority-client.js";
import { Manager, managerClusterArtifacts, registerRemoteManagerAuthority } from "../../manager/src/index.js";
import * as remote from "../../manager/src/remote-authority.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import "../../runtime/src/index.js";
import { jetstreamManager } from "@nats-io/jetstream";
import { decode, encodeUser, type AuthorizationRequest, type AuthorizationResponse } from "@nats-io/jwt";
import { fromCurveSeed, fromPublic, fromSeed } from "@nats-io/nkeys";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";

const names = [
  "U1 eligible managed seat receives issued authority and accepted-row read",
  "U1 interactive user still starts answers and resumes",
  "U1 issued seat starts answers and resumes under its own admission",
  "U1 evidence ceiling equals the stock signed mint",
  "U1 persona without run receives no issuance",
  "U1 admin parent without run receives no issuance and stock refusal",
  "U1 same nonce renews only the identical ceiling",
  "U1 source is the managed actor lifecycle and respawn invalidates it",
  "U1 managed persona run grant can answer and baseline seat cannot answer outside relay",
  "U1 direct parent grant is read afresh at callout mint",
  "U1 absent malformed foreign and self parent cannot issue",
  "U1 seat-started run spawns only its owner and cross-owner launch is broker refused",
];
let pass = 0, fail = 0;
async function cell(index: number, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${names[index]}`); }
  catch (error) { fail++; console.error(`  ✗ FAIL: ${names[index]}`); console.error(error instanceof Error ? error.message : "unknown failure"); }
}
const fx = await startHostedAuthFixture("u1", 1);
const a = fx.accounts[0]!;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "u1-idp", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
rmSync(join(a.stateDir, "idp.json"));
ensurePinnedIdp(a.stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "u1-human");
const cli = grantActor(a.stateDir, { owner, actor: "cli", scope: ["admin", "spawn", "run", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });
const idpToken = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "u1-idp" }).setSubject("u1-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);
let service: AuthServiceHandle | undefined;
let manager: Manager | undefined;
let signedObserver: NatsConnection | undefined;
const signed = new Map<string, Record<string, unknown>>();
const conns: NatsConnection[] = [];
const endpoints: CotalEndpoint[] = [];
const launches = new Map<string, LaunchOpts>();
const connector: Connector = { kind: "connector", name: "u1-fixture", requires: [], buildLaunch: (opts) => {
  launches.set(opts.name, opts); return { command: "fixture", args: [] };
} };
const runtime: RuntimeProvider = { kind: "runtime", name: "u1-fixture", available: () => true, create: () => ({
  kind: "u1-fixture", spawn: (name): AgentHandle => {
    const opts = launches.get(name)!;
    const closed = { value: false };
    void (async () => {
      assert.ok(opts.userAuth && opts.lifecycleUid);
      const files = agentLifecycleSecretFilePaths(opts.workspaceRoot!, a.space, name, opts.lifecycleUid);
      const actorToken = readFileSync(files.actorToken, "utf8");
      const exchange = await post<{ token: string }>("/exchange", { owner, actor: name, actorToken });
      const ep = new CotalEndpoint({ space: a.space, servers: fx.servers, bearer: exchange.token, sentinelCreds: a.sentinelCreds,
        lifecycleUid: opts.lifecycleUid, card: { owner, actor: name, name, kind: "agent" }, channels: [], consume: false, watchChannels: false });
      endpoints.push(ep); ep.on("error", () => {}); await ep.start();
    })().catch((error) => { console.error("managed endpoint fixture refused:", error instanceof Error ? error.message : "unknown"); closed.value = true; });
    return { name, kind: "u1-fixture", status: () => closed.value ? "exited" : "running", stop: () => { closed.value = true; }, release: () => {}, interrupt: () => {}, attach: () => { throw new Error("no terminal in endpoint fixture"); } };
  },
}) };
registry.register(connector, runtime);
const state = remote.loadOrCreateRemoteManagerIdentity(join(fx.dir, "mgr"), a.space);
// Observe and release actual runtime drives through their published host contract. This is fault
// injection at a real pause, not an authored run status or a copied interpreter.
const drives = new Map<string, import("@cotal-ai/core").RunHostDrive>();
const mediators = new Map<string, import("@cotal-ai/core").RunHostPlanes>();
const realHost = registry.resolve<RunHost>(RUN_HOST_KIND, COTAL_LANG_RUN_HOST);
registry.unregister(RUN_HOST_KIND, COTAL_LANG_RUN_HOST);
const observingHost: RunHost = { ...realHost, drive: (planes, request, mediator) => {
  const drive = realHost.drive(planes, request, mediator);
  drives.set(request.runId, drive);
  mediators.set(request.runId, mediator);
  return drive;
} };
registry.register(observingHost);
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}
const authority = (request: import("@cotal-ai/core").RemoteManagerAuthorityRequest) => post<RemoteManagerAuthorityMaterial>("/manager-service-authority", { idpToken, request });
async function dial(actor: string, actorToken?: string, nonce = mintLifecycleUid()) {
  const exchange = await post<{ token: string }>("/exchange", { ...(actorToken ? { owner, actorToken } : { idpToken }), actor, view: "manager-caller", managerInstanceId: state.instanceId });
  const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(exchange.token)], name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 5000 });
  conns.push(nc);
  return { nc, nonce, token: exchange.token };
}
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  // Passive auth-account witness. The native signed, sealed response is decoded without modifying
  // the production callout or authoring a permission rule. Nothing here responds to a request.
  const quarantine = (await loadCalloutAuth(a.store, a.space))!;
  const identity = identityFromCreds(quarantine.calloutCreds);
  const observerJwt = await encodeUser("u1-passive-audit", fromPublic(identity.id), fromPublic(quarantine.account.pub),
    { sub: { allow: [">"] }, pub: { allow: ["_INBOX.>"] } }, { signer: fromSeed(new TextEncoder().encode(quarantine.account.signingSeed)) });
  signedObserver = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: credsFromJwt(observerJwt, identity), tls: false }) });
  const curve = fromCurveSeed(new TextEncoder().encode(quarantine.xkey.seed));
  signedObserver.subscribe("$SYS.REQ.USER.AUTH", { callback: (error, msg) => {
    if (error || !msg.reply) return;
    const serverKey = msg.headers?.get("Nats-Server-Xkey");
    if (!serverKey) return;
    const requestBytes = curve.open(msg.data, serverKey);
    if (!requestBytes) return;
    const request = decode(new TextDecoder().decode(requestBytes)) as { nats: AuthorizationRequest };
    const nonce = request.nats.connect_opts?.name;
    if (!nonce) return;
    signedObserver!.subscribe(msg.reply, { max: 1, callback: (replyError, reply) => {
      if (replyError) return;
      const responseBytes = curve.open(reply.data, serverKey);
      if (!responseBytes) return;
      const response = decode(new TextDecoder().decode(responseBytes)) as { nats: AuthorizationResponse };
      if (response.nats.jwt) signed.set(nonce, (decode(response.nats.jwt) as { nats: Record<string, unknown> }).nats);
    } });
  } });
  await signedObserver.flush();
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false } });
  const prepared = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const registered = await registerRemoteManagerAuthority({ space: a.space, server: fx.servers, owner, instanceId: state.instanceId, serveActor: prepared.actors.serve, prepareCreds: remote.materialCredential(prepared, "executor", state.identities.executor), tlsRequired: false, evict: async () => [] });
  const cluster = managerClusterArtifacts();
  const contractArtifacts = [cluster.document, cluster.manifest];
  const activated = await authority(remote.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
  assert.ok(Number.isSafeInteger(registered.processEpoch) && registered.processEpoch >= 0);
  assert.equal(activated.owner, owner);
  const proof = remote.currentRegistrationProof(activated);
  const supervisorCreds = remote.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: authority });
  const managerRoot = join(fx.dir, "manager-root");
  mkdirSync(join(managerRoot, ".cotal", "agents"), { recursive: true });
  manager = new Manager({ space: a.space, servers: fx.servers, workspaceRoot: managerRoot, runtime: "u1-fixture", remoteAuthority: {
    ...standing, owner, actors: prepared.actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid,
    identities: state.identities, supervisorCreds,
    executorCreds: remote.materialCredential(prepared, "executor", state.identities.executor),
    renewExecutor: async () => remote.materialCredential(await authority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
    serveCreds: remote.materialCredential(activated, "serve", state.identities.serve),
    goalWriterCreds: remote.materialCredential(activated, "goalWriter", state.identities.goalWriter),
    sessionLedgerCreds: remote.materialCredential(activated, "sessionLedger", state.identities.sessionLedger),
    serveGrant: registered.serveGrant,
    mintSessionServing: async () => { throw new Error("this suite opens no terminal session"); },
    mintRetirementRequester: async () => { throw new Error("this suite retires no managed process"); },
    prepareAgentRetirement: async () => { throw new Error("this suite retires no managed process"); },
    validateRetainedAgent: async () => { throw new Error("this fresh manager retains no seat"); },
    scanGoalIndex: async () => {
      const request = { v: 1 as const, kind: "manager-goal-index-scan" as const, space: a.space, actor: "cli", instanceId: state.instanceId,
        managerLifecycleUid: state.lifecycleUid, requestId: `scan${mintLifecycleUid()}`, registrationProof: proof, serveEpoch: registered.processEpoch, identities: remote.publicIdentities(state) };
      return remote.remoteManagerGoalIndexEntries(await post("/manager-service-authority", { idpToken, request }), request, owner);
    },
    authorizeAdmin: async (caller) => {
      const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
      return remote.remoteManagerAdminAuthorized(await post("/manager-service-authority", { idpToken, request }), request, owner);
    },
    agentBearerExchangeUrl: service.publicUrl!,
    enrollManagedAgent: async ({ target }) => {
      const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
      return remote.remoteManagedAgentEnrollmentMaterial(await post("/manager-service-authority", { idpToken, request }), request);
    },
    runHosting: remote.remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: a.accountPublicKey, processEpoch: registered.processEpoch,
      requestRunAdmission: (request) => post<RemoteRunAdmissionResult>("/manager-service-authority", { idpToken, request }),
      requestRunAttempt: (request) => post<RemoteRunAttemptResult>("/manager-service-authority", { idpToken, request }), call: authority }),
  } });
  await manager.start();
  const call = async (d: Awaited<ReturnType<typeof dial>>, caller: EpCaller, command: string, args?: Record<string, unknown>): Promise<EndpointReply> => {
    const target = await resolveService(d.nc, a.space, "manager", caller, { instanceId: state.instanceId, deadlineMs: 10000 });
    return (await invokeCommand(d.nc, a.space, target, command, args, { deadlineMs: 30000, currentEpoch: async () => 0,
      ...(command === "run-answer" ? { target: { mode: "self" as const } } : {}) })).reply;
  };
  const readyStatus = async (d: Awaited<ReturnType<typeof dial>>, caller: EpCaller, runId: string, wanted: string, stepKey?: string): Promise<RunStatusView> => {
    for (let n = 0; n < 100; n++) {
      const reply = await call(d, caller, "run-status", { runId });
      assert.ok(reply.ok, reply.error?.message);
      const view = reply.data as RunStatusView;
      if ((stepKey === undefined && view.status?.state === wanted) || view.journal.some((r) => r.kind === "step" && r.state === wanted && (stepKey === undefined || r.step === stepKey))) return view;
      if (view.status?.state === "failed") throw new Error("the real run failed before reaching its requested step");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`run never reached ${wanted}`);
  };
  const workflow = async (d: Awaited<ReturnType<typeof dial>>, caller: EpCaller) => {
    const started = await call(d, caller, "run-start", { source: 'await checkpoint("approve", "Continue?"); await checkpoint("finish", "Finish?"); log("done");' });
    assert.ok(started.ok, started.error?.message);
    const runId = (started.data as { runId: string }).runId;
    const waiting = await readyStatus(d, caller, runId, "pending");
    const step = waiting.journal.find((r) => r.kind === "step" && r.state === "pending");
    assert.ok(step && step.kind === "step");
    const drive = drives.get(runId);
    assert.ok(drive);
    drive.release("native resume fixture releases the first attempt");
    const answer = await call(d, caller, "run-answer", { runId, stepKey: step.step, value: true });
    assert.ok(answer.ok, answer.error?.message);
    assert.equal((await drive.done).status, "released");
    await readyStatus(d, caller, runId, "released");
    const resumed = await call(d, caller, "run-resume", { runId });
    assert.ok(resumed.ok, resumed.error?.message);
    await readyStatus(d, caller, runId, "pending", "/checkpoint:finish#0");
    const finished = await call(d, caller, "run-answer", { runId, stepKey: "/checkpoint:finish#0", value: true });
    assert.ok(finished.ok, finished.error?.message);
    await readyStatus(d, caller, runId, "completed");
    return runId;
  };
  writeFileSync(join(managerRoot, ".cotal", "agents", "runner.md"), "---\nname: runner\nagent: u1-fixture\ncapabilities: [spawn, run]\n---\n");
  writeFileSync(join(managerRoot, ".cotal", "agents", "baseline.md"), "---\nname: baseline\nagent: u1-fixture\ncapabilities: []\n---\n");
  const startedRunner = await manager.startAgent({ name: "runner", events: false }, `${owner}.cli`);
  assert.ok(startedRunner.ok, startedRunner.error);
  const runnerRow = findManagedActor(a.stateDir, owner, "runner")!;
  assert.deepEqual(runnerRow.scope, ["spawn", "run"]);
  assert.equal(runnerRow.parent, `${owner}.cli`);
  const uid = runnerRow.lifecycleUid!;
  const grant = { actorToken: readFileSync(agentLifecycleSecretFilePaths(managerRoot, a.space, "runner", uid).actorToken, "utf8") };
  let d: Awaited<ReturnType<typeof dial>> | undefined;
  let caller: import("@cotal-ai/core").IssuedCaller | undefined;
  await cell(0, async () => {
    d = await dial("runner", grant.actorToken);
    const expected: EpCaller = { owner, actor: "runner", uid };
    caller = await issuedUserCaller(d.nc, a.space, d.nonce, expected);
    assert.match(caller.generation, /^[0-9a-f]{32}$/);
    assert.deepEqual({ owner: caller.owner, actor: caller.actor, uid: caller.uid }, expected);
  });
  await cell(1, async () => {
    const human = await dial("cli");
    const humanCaller = await issuedUserCaller(human.nc, a.space, human.nonce, { owner, actor: "cli", uid: cli.lifecycleUid! });
    await workflow(human, humanCaller);
  });
  await cell(2, async () => {
    assert.ok(d && caller);
    const runId = await workflow(d, caller);
    const reader = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: await mintCreds(a.auth, newIdentity(), "run-mediator",
      { runMediator: { endpoint: "manager", runId, takeoverId: "a".repeat(16), instanceId: state.instanceId, epoch: 2 } }), tls: false }) });
    try {
      const admission = (await readRunAdmission(await jetstreamManager(reader), a.space, "manager", runId)).admission;
      assert.deepEqual(admission.caller, caller);
      assert.equal(admission.provenance.kind, "issued");
    } finally { await reader.close(); }
  });
  await cell(3, async () => {
    assert.ok(d && caller);
    await withIssuerSession({ servers: fx.servers, space: a.space, auth: a.auth, tls: false }, async (session) => {
      const ref = { space: a.space, ...caller! };
      const evidence = (await session.store.resolve(ref, async (source) => ledgerActorSourceIsLive(a.stateDir)(source))).evidence;
      const expected = permissionsFor("manager-caller", a.space, { owner, actor: "runner", connId: d!.nonce, lifecycleUid: uid },
        { capabilities: ["spawn", "run"], lifecycleUid: uid, managerInstanceId: state.instanceId, issued: { generation: caller!.generation, acceptedToken: connectionAcceptedToken(d!.nonce) } });
      assert.deepEqual(evidence.permissions, importNativeSubjectPermissions(expected));
      assert.ok(signed.has(d!.nonce), "passive witness must observe this connection's signed reply");
      const actual = signed.get(d!.nonce)!;
      assert.deepEqual(evidence.permissions, importNativeSubjectPermissions({ pub: actual.pub, sub: actual.sub }));
    });
  });
  await cell(4, async () => {
    const started = await manager!.startAgent({ name: "baseline", events: false }, `${owner}.cli`);
    assert.ok(started.ok, started.error);
    const baselineUid = findManagedActor(a.stateDir, owner, "baseline")!.lifecycleUid!;
    const actorToken = readFileSync(agentLifecycleSecretFilePaths(managerRoot, a.space, "baseline", baselineUid).actorToken, "utf8");
    const conn = await dial("baseline", actorToken);
    await assert.rejects(issuedUserCaller(conn.nc, a.space, conn.nonce, { owner, actor: "baseline", uid: baselineUid }), /Permissions Violation/);
    const target = await resolveService(conn.nc, a.space, "manager", { owner, actor: "baseline", uid: baselineUid }, { instanceId: state.instanceId });
    assert.equal(target.responder.instanceId, state.instanceId);
    await assert.rejects(call(conn, { owner, actor: "baseline", uid: baselineUid }, "run-start", { source: 'log("denied");' }),
      (error: Error & { code?: string }) => error.code === "permission-denied" && /REFUSED BY THE BROKER/.test(error.message));
  });
  await cell(8, async () => {
    assert.ok(d && caller);
    const started = await call(d, caller, "run-start", { source: 'await checkpoint("outside", "Outside relay?");' });
    assert.ok(started.ok, started.error?.message);
    const runId = (started.data as { runId: string }).runId;
    await readyStatus(d, caller, runId, "pending", "/checkpoint:outside#0");
    const row = findManagedActor(a.stateDir, owner, "baseline")!;
    const baseline = await dial("baseline", readFileSync(agentLifecycleSecretFilePaths(managerRoot, a.space, "baseline", row.lifecycleUid!).actorToken, "utf8"));
    const refused = await call(baseline, { owner, actor: "baseline", uid: row.lifecycleUid! }, "run-answer", { runId, stepKey: "/checkpoint:outside#0", value: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "permission-denied");
    assert.match(refused.error?.message ?? "", /baseline seat only for a pending ask or escalation/);
    const answer = await call(d, caller, "run-answer", { runId, stepKey: "/checkpoint:outside#0", value: true });
    assert.ok(answer.ok, answer.error?.message);
    await readyStatus(d, caller, runId, "completed");
  });
  await cell(11, async () => {
    assert.ok(d && caller);
    writeFileSync(join(managerRoot, ".cotal", "agents", "owned.md"), "---\nname: owned\nagent: u1-fixture\ncapabilities: []\n---\n");
    const started = await call(d, caller, "run-start", { source: 'await spawn("owned", { events: false }); await checkpoint("owned", "Owner boundary?");' });
    assert.ok(started.ok, started.error?.message);
    const runId = (started.data as { runId: string }).runId;
    await readyStatus(d, caller, runId, "pending", "/checkpoint:owned#0");
    const child = findManagedActor(a.stateDir, owner, "owned");
    assert.ok(child);
    assert.equal(child.owner, owner);
    const mediator = mediators.get(runId)!;
    const runCaller = runDriverCaller(runId, owner);
    const target = await resolveService(mediator.nc, a.space, "manager", runCaller);
    const spec = { apiVersion: "cotal-launch/v1", space: a.space, runId: "foreignlaunch", owner: `u_${"z".repeat(26)}`,
      agents: [{ name: "foreign", agent: "u1-fixture", hash: "fixture", capabilities: [], subscribe: [], allowSubscribe: [], allowPublish: [] }] };
    await assert.rejects(invokeCommand(mediator.nc, a.space, target, "launch", { runId: spec.runId, name: "foreign", spec }, { deadlineMs: 5000, currentEpoch: async () => 0 }),
      (error: Error) => /REFUSED BY THE BROKER/.test(error.message));
    assert.equal(findManagedActor(a.stateDir, spec.owner, "foreign"), undefined);
    drives.get(runId)!.release("owned spawn boundary fixture complete");
    assert.ok((await call(d, caller, "run-answer", { runId, stepKey: "/checkpoint:owned#0", value: true })).ok);
  });
  await cell(5, async () => {
    grantActor(a.stateDir, { owner, actor: "norun", scope: ["admin", "spawn"], allowSubscribe: [], allowPublish: [] });
    const secret = newActorToken(), lifecycleUid = mintLifecycleUid();
    grantManagedActor(a.stateDir, { owner, actor: "denied", scope: ["run"], allowSubscribe: [], allowPublish: [], parent: `${owner}.norun`, lifecycleUid, tokenHash: secret.tokenHash });
    const conn = await dial("denied", secret.actorToken);
    const expected = { owner, actor: "denied", uid: lifecycleUid };
    await assert.rejects(issuedUserCaller(conn.nc, a.space, conn.nonce, expected), /Permissions Violation/);
    const result = await call(conn, expected, "run-start", { source: 'log("not admitted");' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "permission-denied");
    assert.ok(result.error?.details?.some((detail) => detail.kind === EP_UNBOUND_CALLER_AUTHORITY));
    const exchange = await post<{ token: string }>("/exchange", { owner, actor: "denied", actorToken: secret.actorToken, view: "manager-caller", managerInstanceId: state.instanceId });
    grantActor(a.stateDir, { owner, actor: "norun", scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
    const nonce = mintLifecycleUid();
    const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(exchange.token)], name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0 });
    conns.push(nc);
    await assert.rejects(issuedUserCaller(nc, a.space, nonce, expected), /Permissions Violation/);
    const nonAdmin = await call({ nc, nonce, token: exchange.token }, expected, "run-start", { source: 'log("denied");' });
    assert.equal(nonAdmin.error?.code, "permission-denied");
    assert.ok(nonAdmin.error?.details?.some((detail) => detail.kind === EP_UNBOUND_CALLER_AUTHORITY));
  });
  await cell(9, async () => {
    const parent = grantActor(a.stateDir, { owner, actor: "changing", scope: ["admin", "run"], allowSubscribe: [], allowPublish: [] });
    const secret = newActorToken(), lifecycleUid = mintLifecycleUid();
    grantManagedActor(a.stateDir, { owner, actor: "freshparent", scope: ["run"], allowSubscribe: [], allowPublish: [], parent: `${owner}.changing`, lifecycleUid, tokenHash: secret.tokenHash });
    const exchange = await post<{ token: string }>("/exchange", { owner, actor: "freshparent", actorToken: secret.actorToken, view: "manager-caller", managerInstanceId: state.instanceId });
    grantActor(a.stateDir, { ...parent, scope: ["admin"] });
    const nonce = mintLifecycleUid();
    const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(exchange.token)],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0 });
    conns.push(nc);
    await assert.rejects(issuedUserCaller(nc, a.space, nonce, { owner, actor: "freshparent", uid: lifecycleUid }), /Permissions Violation/);
    const result = await call({ nc, nonce, token: exchange.token }, { owner, actor: "freshparent", uid: lifecycleUid }, "run-start", { source: 'log("refused");' });
    assert.equal(result.error?.code, "permission-denied");
    assert.ok(result.error?.details?.some((detail) => detail.kind === EP_UNBOUND_CALLER_AUTHORITY));
  });
  await cell(10, async () => {
    const foreignOwner = `u_${"z".repeat(26)}`;
    grantActor(a.stateDir, { owner: foreignOwner, actor: "foreignparent", scope: ["admin", "run"], allowSubscribe: [], allowPublish: [] });
    for (const [actor, parent] of [["no_parent", undefined], ["bad_parent", "malformed"], ["foreign_parent", `${foreignOwner}.foreignparent`], ["self_parent", `${owner}.self_parent`], ["missing_parent", `${owner}.absent`]] as const) {
      const secret = newActorToken(), lifecycleUid = mintLifecycleUid();
      grantManagedActor(a.stateDir, { owner, actor, scope: ["run"], allowSubscribe: [], allowPublish: [], lifecycleUid, tokenHash: secret.tokenHash });
      const exchanged = await post<{ token: string }>("/exchange", { owner, actor, actorToken: secret.actorToken, view: "manager-caller", managerInstanceId: state.instanceId });
      // Simulate a changed trusted row between exchange and mint, without copying any eligibility rule.
      const file = join(a.stateDir, "managed-actors", `${owner}.${actor}.json`);
      const row = JSON.parse(readFileSync(file, "utf8"));
      if (parent !== undefined) row.parent = parent;
      writeFileSync(file, JSON.stringify(row));
      const nonce = mintLifecycleUid();
      const nc = await connect({ servers: fx.servers, authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(exchanged.token)], name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0 });
      conns.push(nc);
      await assert.rejects(issuedUserCaller(nc, a.space, nonce, { owner, actor, uid: lifecycleUid }), /Permissions Violation/);
    }
  });
  await cell(6, async () => {
    assert.ok(d && caller);
    const same = await dial("runner", grant.actorToken, d.nonce);
    assert.deepEqual(await issuedUserCaller(same.nc, a.space, same.nonce, { owner, actor: "runner", uid }), caller);
    const row = findManagedActor(a.stateDir, owner, "runner")!;
    grantManagedActor(a.stateDir, { ...row, scope: ["run"], tokenHash: row.tokenHash! });
    await assert.rejects(dial("runner", grant.actorToken, d.nonce), /Authorization Violation/);
    grantManagedActor(a.stateDir, { ...row, tokenHash: row.tokenHash! });
  });
  await cell(7, async () => {
    assert.ok(caller);
    await withIssuerSession({ servers: fx.servers, space: a.space, auth: a.auth, tls: false }, async (session) => {
      const ref = { space: a.space, ...caller! };
      const sourceIsLive = async (source: import("@cotal-ai/core").IssuedSourceRef) => ledgerActorSourceIsLive(a.stateDir)(source);
      const before = await session.store.resolve(ref, sourceIsLive);
      assert.deepEqual(before.evidence.sources, [actorLedgerSource(a.space, owner, "runner", uid)]);
      const row = findManagedActor(a.stateDir, owner, "runner")!;
      revokeManagedActor(a.stateDir, owner, "runner");
      await assert.rejects(session.store.resolve(ref, sourceIsLive), /no longer live/);
      grantManagedActor(a.stateDir, { ...row, lifecycleUid: mintLifecycleUid(), tokenHash: row.tokenHash! });
      await assert.rejects(session.store.resolve(ref, sourceIsLive), /no longer live/);
    });
  });
} finally {
  await manager?.stop();
  for (const ep of endpoints) await ep.stop();
  for (const nc of conns) await nc.close();
  await service?.close();
  await signedObserver?.close();
  await new Promise<void>((resolve) => idp.close(() => resolve()));
  await fx.close();
}
console.log(`managed run issuance: ${pass} passed, ${fail} failed, cells=${pass + fail}`);
emitSentinel({ passed: pass, failed: fail });
process.exitCode = fail || pass !== names.length ? 1 : 0;
