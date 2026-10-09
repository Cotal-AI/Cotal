import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams, standaloneConnectOpts, resolveService, invokeCommand, withIssuerSession, mintGeneration, mintAcceptedToken, registry, credsClaims, actionContext, recordGoalIndex, readGoalIndex, recordAtomicKey, RECORD_KINDS, recordsKvStreamName, admissionBucket, type Connector, type RemoteManagerAuthorityRequest, type RemoteManagerAuthorityMaterial } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { spaceKey } from "@cotal-ai/workspace";
import { Manager, remoteManagerClient as client, registerRemoteManagerAuthority, managerClusterArtifacts, type ManagerOptions } from "../dist/index.js";
import { startAuthService } from "../../auth/dist/index.js";
import { remoteManagerRegistrationProof } from "../../auth/src/authority-client.js";
import { startHostedAuthFixture } from "../../auth/smoke/_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { nativeAccountConnections } from "./_native-account-connections.js";

let passed = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); }
async function refusesBoot(opts: ManagerOptions, match: RegExp, label: string) {
  const probe = new Manager(opts); let started = false;
  try { await assert.rejects(probe.start().then(() => { started = true; }), match, label); passed++; }
  finally { if (started) await probe.stop(); }
}
const fx = await startHostedAuthFixture("noexec", 1);
const a = fx.accounts[0]!;
const root = join(fx.dir, "control"); mkdirSync(root);
const state = client.loadOrCreateRemoteManagerIdentity(root, a.space);
const assignment = { v: 1 as const, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, assignmentRevision: 1, state: "assigned" as const };
let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let manager: Manager | undefined;
let managerStarted = false;
let callerNc: Awaited<ReturnType<typeof connect>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let witness: Awaited<ReturnType<typeof connect>> | undefined;
let retainedWriter: Awaited<ReturnType<typeof connect>> | undefined;
let latestFamily: { goalWriter: string } | undefined;
let calls = 0, renewals = 0, scans = 0;
let connectorBuilds = 0;
const connector: Connector = { kind: "connector", name: "noexec-witness", requires: ["node"], buildLaunch: () => { connectorBuilds++; return { command: process.execPath, args: ["-e", "process.exit(0)"], env: {} }; } };
registry.register(connector);
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "valid.md"), "---\nname: valid\nagent: noexec-witness\n---\n");
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  witness = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: await mintCreds(a.auth, newIdentity(), "provisioner"), tls: false }) });
  const jsm = await jetstreamManager(witness);
  const resources = async () => {
    const rows: Array<{ name: string; messages: number; consumers: number }> = [];
    for (const name of [recordsKvStreamName(a.space), `KV_${admissionBucket(a.space)}`]) { const row = await jsm.streams.info(name); rows.push({ name: row.config.name, messages: row.state.messages, consumers: row.state.consumer_count }); }
    return JSON.stringify(rows.sort((a, b) => a.name.localeCompare(b.name)));
  };
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, platformControl: { observeAssignment: async () => assignment }, standingRenewableTtlSeconds: 20 });
  const door = async (request: any): Promise<any> => { calls++; if (request.operation === "renewStandingBundle") renewals++; return await service!.platformControlAuthority!({ v: 1, kind: "platform-control-authority", space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1, request }); };
  const start = async () => {
    const prepared = await door(client.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const evict = async (principals: readonly string[]) => {
      const request = client.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
      const result = client.remoteManagerMaintenanceResult(await door(request), request, prepared.owner);
      return result.evictions!.map((e) => e.verifiedGone);
    };
    const registered = await registerRemoteManagerAuthority({ space: a.space, server: fx.servers, owner: prepared.owner, instanceId: state.instanceId, serveActor: prepared.actors.serve, prepareCreds: client.materialCredential(prepared, "executor", state.identities.executor), tlsRequired: false, evict });
    const artifacts = managerClusterArtifacts(), contractArtifacts = [artifacts.document, artifacts.manifest];
    const active = await door(client.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(prepared.owner, state, contractArtifacts), contractArtifacts }));
    const proof = client.currentRegistrationProof(active), supervisorCreds = client.materialCredential(prepared, "supervisor", state.identities.supervisor);
    const standing = client.remoteStandingBundleRenewal({ state, owner: prepared.owner, registrationProof: proof, supervisorCreds, call: (r: RemoteManagerAuthorityRequest) => door(r) as Promise<RemoteManagerAuthorityMaterial> });
    const remote: NonNullable<ManagerOptions["remoteAuthority"]> = {
      ...standing, renewStandingBundle: async (epoch) => { const family = await standing.renewStandingBundle(epoch); latestFamily = family; return family; }, owner: prepared.owner, actors: active.actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities,
      supervisorCreds, executorCreds: client.materialCredential(prepared, "executor", state.identities.executor), serveCreds: client.materialCredential(active, "serve", state.identities.serve), goalWriterCreds: client.materialCredential(active, "goalWriter", state.identities.goalWriter), sessionLedgerCreds: client.materialCredential(active, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant,
      renewExecutor: async () => client.materialCredential(await door(client.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
      mintSessionServing: async (args) => client.materialCredential(await door(client.remoteManagerAuthorityRequest(state, "cli", "session", { registrationProof: remoteManagerRegistrationProof(prepared.owner, state), session: { id: args.identity.id, endpoint: args.endpoint, sessionId: args.sessionId, epoch: args.epoch, exp: args.exp } })), "sessionServing", args.identity),
      mintRetirementRequester: async (args) => client.materialCredential(await door(client.remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof: remoteManagerRegistrationProof(prepared.owner, state), retirement: { id: args.identity.id, target: args.target, opId: args.opId, serveEpoch: args.serveEpoch } })), "retirementRequester", args.identity),
      prepareAgentRetirement: async (args) => { const request = client.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, args.target, args.opId); await door(request); },
      validateRetainedAgent: async (args) => { const request = client.remoteRetainedAgentValidationRequest(state, "cli", proof, registered.processEpoch, args, args.actorToken, args.sentinelCreds); return client.retainedAgentAuthority(await door(request), request); },
      scanGoalIndex: async () => { scans++; const request = { v: 1 as const, kind: "manager-goal-index-scan" as const, space: a.space, actor: "cli", instanceId: state.instanceId, managerLifecycleUid: state.lifecycleUid, requestId: `scan${mintLifecycleUid()}`, registrationProof: proof, serveEpoch: registered.processEpoch, identities: client.publicIdentities(state) }; return client.remoteManagerGoalIndexEntries(await door(request), request, prepared.owner); },
      authorizeAdmin: async (caller) => { const request = client.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller); return client.remoteManagerAdminAuthorized(await door(request), request, prepared.owner); },
      agentBearerExchangeUrl: service!.url,
    };
    const opts: ManagerOptions = { space: a.space, servers: fx.servers, workspaceRoot: root, pooled: true, execution: "none", remoteAuthority: remote };
    for (const runtime of ["auto", "pty", "none"]) { assert.throws(() => new Manager({ ...opts, runtime }), /no runtime option/, `none constructor refuses supplied runtime ${runtime}`); passed++; }
    assert.throws(() => new Manager({ ...opts, execution: "unknown" as never }), /unknown manager execution/, "unknown capability refuses at construction"); passed++;
    assert.throws(() => new Manager({ ...opts, pooled: false }), /requires pooled/, "none requires explicit pooled composition"); passed++;
    assert.throws(() => new Manager({ ...opts, remoteAuthority: undefined }), /requires pooled/, "none requires signerless authority"); passed++;
    assert.throws(() => new Manager({ ...opts, remoteAuthority: { ...remote, scanGoalIndex: undefined } as never }), /complete closed/, "none requires closed goal inventory callback"); passed++;
    for (const execution of [undefined, "runtime"] as const) assert.throws(() => new Manager({ ...opts, execution, runtime: "pty" }), /explicit non-PTY/, "ordinary pooled PTY remains refused"); passed += 2;
    const ordinary = new Manager({ space: a.space, workspaceRoot: root });
    check("omitted capability keeps genuine default PTY runtime", ordinary.execution === "runtime" && ordinary.runtimeKind === "pty");
    const before = calls, files = JSON.stringify(readdirSync(root, { recursive: true }).sort());
    manager = new Manager(opts);
    check("explicit none constructs without runtime resolution", manager.execution === "none" && manager.runtimeKind === "none" && !Object.hasOwn(manager, "runtime"));
    for (const [label, invoke] of [
      ["public startAgent", () => manager!.startAgent({ name: "valid" })],
      ["public startByName", () => manager!.startByName("valid")],
      ["public delegated start", () => manager!.startAgent({ name: "delegated", delegatedIntent: {} as never })],
    ] as const) { let reply: Awaited<ReturnType<Manager["startAgent"]>> | undefined; await assert.doesNotReject(async () => { reply = await invoke(); }, `${label} refuses before authority/files/persona effects`); check(`${label} refuses before authority/files/persona effects`, !reply!.ok && /execution: none/.test(reply!.error!)); }
    check("public launch refusals call no authority and write no files", calls === before && JSON.stringify(readdirSync(root, { recursive: true }).sort()) === files);
    assert.throws(() => manager!.adoptRuntimeHandle({ kind: "pty", id: "missing" }), /execution: none/, "none refuses runtime handle adoption"); passed++;
    const resumed = await manager.resumePreserved({ version: "cotal-manager-resume/v2", space: a.space, createdAt: new Date().toISOString(), agents: [{} as never] });
    check("retained nonempty inventory refuses before host validation or recovery", !resumed.ok && /execution: none/.test(resumed.error!) && calls === before);
    await manager.start();
    managerStarted = true;
    check("boot checks retained inventory and runs native goal recovery", scans >= 2);
    return { owner: prepared.owner, epoch: registered.processEpoch, opts };
  };
  const initial = await start();
  const id = newIdentity(), uid = mintLifecycleUid(), issued = { generation: mintGeneration(), acceptedToken: mintAcceptedToken() };
  const creds = await withIssuerSession({ servers: fx.servers, space: a.space, auth: a.auth, tls: false }, (s) => mintCreds(a.auth, id, "manager-caller", { lifecycleUid: uid, managerInstanceId: state.instanceId, principal: { owner: initial.owner, actor: "probe" }, capabilities: ["admin", "spawn", "run"], expiresInSeconds: 300, issued, issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] } }));
  callerNc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds, tls: false }) });
  const caller = { owner: initial.owner, actor: "probe", uid, generation: issued.generation };
  const selected = await resolveService(callerNc, a.space, "manager", caller, { instanceId: state.instanceId });
  const invoke = async (command: string, args?: any) => (await invokeCommand(callerNc!, a.space, selected, command, args, {})).reply;
  const status = await invoke("status"); assert.ok(status.ok); const data = status.data as any;
  check("real status reports no execution/custody/run/terminal and no class spawn", data.execution === "none" && data.runtime === "none" && data.custody === "none" && data.runHosting === false && data.terminalSessions === false && data.classSpawn === false && data.agentCount === 0 && data.connectors.length === 0);
  const beforeCalls = calls, beforeFiles = JSON.stringify(readdirSync(root, { recursive: true }).sort()), beforeResources = await resources();
  const spec = { apiVersion: "cotal-launch/v1", space: a.space, runId: "r", agents: [{ name: "valid", agent: "noexec-witness", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "h" }] };
  const refusals: Array<{ command: string; reply: any }> = [];
  for (const [command, args] of [["spawn", { name: "valid" }], ["launch", { runId: "r", name: "valid", spec }], ["run-start", { source: "log(1);" }], ["run-resume", { runId: "absent" }]] as const) {
    refusals.push({ command, reply: await invoke(command, args) });
  }
  check("served launch/run refusals produce no host requests or launch files", calls === beforeCalls && JSON.stringify(readdirSync(root, { recursive: true }).sort()) === beforeFiles);
  check("served refusals bind no goals/admissions/keys or broker resources", await resources() === beforeResources && connectorBuilds === 0);
  for (const { command, reply } of refusals) check(`${command} refuses natively before any allocation`, !reply.ok && reply.error?.code === "unimplemented" && /execution: none/.test(reply.error.message));
  check("auth-service real attributed readiness sees actual noexec status", (await service!.platformControlReadiness!(state.instanceId)).reply.ok);
  const renewalBefore = renewals;
  for (let i = 0; i < 170 && renewals === renewalBefore; i++) await new Promise((r) => setTimeout(r, 100));
  check("real noexec timer asks host to renew the all-five family", renewals > renewalBefore);
  // The request counter precedes adoption. Wait for the authentic status rail after renewed dials.
  await new Promise((r) => setTimeout(r, 500));
  check("native readiness remains real after all-duty candidate preflight/adoption", (await service!.platformControlReadiness!(state.instanceId)).reply.ok);
  const originalExpiry = Math.max(...[initial.opts.remoteAuthority!.serveCreds, initial.opts.remoteAuthority!.goalWriterCreds, initial.opts.remoteAuthority!.sessionLedgerCreds].map((cred) => Number(credsClaims(cred).exp))) * 1000;
  assert.ok(originalExpiry - Date.now() < 30_000, "fixture active duties must have bounded short TTL");
  await new Promise((r) => setTimeout(r, Math.max(0, originalExpiry - Date.now() + 250)));
  check("real noexec status survives original serve/goal/session JWT expiry", (await service!.platformControlReadiness!(state.instanceId)).reply.ok);
  const live = await nativeAccountConnections(a.auth, fx.servers);
  check("renewed real standing broker connections retain native identities", Object.values(state.identities).filter((i) => i.id !== state.identities.executor.id).every((i) => live.some((row) => row.user === i.id)));
  await callerNc.close(); callerNc = undefined;
  await manager!.stop(); manager = undefined;
  const closed = await nativeAccountConnections(a.auth, fx.servers);
  check("noexec stop closes all actual standing nkeys", closed.every((row) => !Object.values(state.identities).some((i) => i.id === row.user)));
  const capabilityPath = join(root, ".cotal", `manager-execution.${spaceKey(a.space)}.${state.instanceId}.json`);
  const capability = readFileSync(capabilityPath);
  retainedWriter = await connect({ servers: fx.servers, ...standaloneConnectOpts({ creds: latestFamily!.goalWriter, tls: false }) });
  const ctx = await actionContext(retainedWriter, a.space);
  for (const retained of ["seat", "turn"] as const) {
    const ref = { endpoint: "manager", caller, goalId: mintLifecycleUid() };
    await recordGoalIndex(ctx, ref, state.instanceId, retained === "seat" ? { name: "retained", actor: "retained", uid: mintLifecycleUid() } : undefined, retained === "turn" ? "retained turn" : undefined);
    const before = await readGoalIndex(ctx, ref);
    await refusesBoot(initial.opts, /refuses retained seat or turn inventory/, `${retained} native retained inventory refuses boot`);
    check(`${retained} inventory refusal preserves exact native row`, JSON.stringify(await readGoalIndex(ctx, ref)) === JSON.stringify(before));
    // Native staged inventory, not a launched child. Move the staged row to a sibling after
    // its refusal probe. The scanner deliberately refuses DEL markers rather than skipping them.
    const key = recordAtomicKey(RECORD_KINDS.goalidx, [ref.endpoint, caller.owner, caller.actor, caller.uid, ref.goalId]);
    const entry = await ctx.kv.get(key); assert.ok(entry);
    await ctx.kv.update(key, new TextEncoder().encode(JSON.stringify({ ...before, iid: mintLifecycleUid() })), entry.revision);
  }
  await retainedWriter.close(); retainedWriter = undefined;
  writeFileSync(capabilityPath, "{broken", { mode: 0o600 });
  await refusesBoot(initial.opts, /does not parse/, "malformed execution capability refuses boot");
  writeFileSync(capabilityPath, capability, { mode: 0o600 });
  await refusesBoot({ ...initial.opts, execution: "runtime", pooled: false, runtime: "pty" }, /execution capability differs/, "none instance cannot restart as runtime");
  check("failed capability boots leave no native connection or execution effects", connectorBuilds === 0);
  const afterClose = renewals;
  const successor = await start();
  check("native cold restart retains immutable instance and advances epoch", successor.epoch > initial.epoch);
  for (let i = 0; i < 170 && renewals === afterClose; i++) await new Promise((r) => setTimeout(r, 100));
  check("successor again renews all duties through host issuer", renewals > afterClose);
  await manager!.stop(); manager = undefined;
  rmSync(capabilityPath);
  await refusesBoot(successor.opts, /existing unclassified manager instance/, "unclassified later epoch refuses none boot");
  check("unclassified later epoch writes no capability or execution state", !existsSync(capabilityPath) && connectorBuilds === 0);
  writeFileSync(capabilityPath, capability, { mode: 0o600 });
  await service!.close();
  check("authority close ends every real owned connection", (await service!.closed).connections.every((c) => c.ended));
  console.log(`no-execution native: ${passed} assertions passed`); emitSentinel({ passed, failed: 0 });
} finally { await callerNc?.close(); if (managerStarted) await manager?.stop(); await retainedWriter?.close(); await witness?.close(); try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); } }
