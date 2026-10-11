/** Existing supervisor issuance cannot cross an environment-manager gate. */
import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import {
  EpEnvelopeError, epAuthBucket, epgateKey, mintCreds, mintLifecycleUid, newIdentity, parseEndpointGate,
  provisionEndpointGateOpen, remoteManagerActors, REMOTE_MANAGER_IDENTITY_NAMES, setupSpaceStreams,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { openAuthAuthorityPlane, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { remoteManagerIssuerGrants, openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("environment-family", 2);
const account = fx.accounts[0]!;
const owner = `u_${"a".repeat(26)}`;
let instanceId = mintLifecycleUid(), lifecycleUid = mintLifecycleUid();
let state: "assigned" | "ended" = "assigned";
const identities = Object.fromEntries(REMOTE_MANAGER_IDENTITY_NAMES.map(name => [name, { id: newIdentity().id }])) as RemoteManagerAuthorityRequest["identities"];
const request = (): RemoteManagerAuthorityRequest => ({
  v: 1, kind: "manager-service-authority", operation: "prepare", space: account.space,
  actor: "cli", instanceId, managerLifecycleUid: lifecycleUid, requestId: mintLifecycleUid(), identities,
});
let service: AuthServiceHandle | undefined;
let writer: AuthorityClient | undefined;
let passed = 0, failed = 0;
async function cell(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function exerciseAuthorityPaths() {
  const account = fx.accounts[1]!;
  const space = account.space;
  const managerLifecycleUid = mintLifecycleUid();
  const envInstance = mintLifecycleUid(), plainInstance = mintLifecycleUid();
  const otherOwner = `u_${"b".repeat(26)}`;
  await setupSpaceStreams({ servers: fx.servers, space,
    creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const plane = await openAuthAuthorityPlane({ server: fx.servers, space, dir: account.stateDir,
    identityRoot: account.stateDir, identityStore: account.store,
    dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, log: () => {} });
  let fixture: AuthorityClient | undefined;
  try {
    fixture = await openAuthorityClient({ server: fx.servers, space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      label: "environment-family-path-fixture", grants: id => remoteManagerIssuerGrants(space, id), log: () => {} });
    const kv = await new Kvm(fixture.nc).open(epAuthBucket(space));
    const envKey = epgateKey("manager", envInstance);
    await provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId: envInstance,
      principal: `${owner}.${remoteManagerActors(envInstance).serve}`, authorityFamily: "environment-manager" });
    await cell("unregistered environment gates do not disable ordinary caller selection", async () => {
      await assert.rejects(() => plane.selectManagerInstance(owner), /found no manager candidate/);
    });
    // Registration fixture, not environment admission: generated authority registers both families
    // through the stock ceremony. No bootstrap or hosted execution is certified by this setup.
    const register = async (instanceId: string) => registerRemoteManagerAuthority({ space, server: fx.servers,
      owner, instanceId, serveActor: remoteManagerActors(instanceId).serve, tlsRequired: false,
      prepareCreds: await mintCreds(account.auth, newIdentity(), "remote-manager", {
        principal: { owner, actor: remoteManagerActors(instanceId).executor },
        remoteManager: { instanceId, owner, actor: remoteManagerActors(instanceId).executor } }),
      evict: async principals => principals.map(() => true) });
    const registered = await register(envInstance);
    const before = (await kv.get(envKey))!;
    const envelope = (instanceId = envInstance) => ({ v: 1 as const, space, actor: "cli", instanceId,
      managerLifecycleUid, requestId: mintLifecycleUid(), identities });
    const base = envelope();
    const proof = remoteManagerCurrentRegistrationProof(account.auth.account.signingSeed!, owner, base, registered);
    const current = { ...base, registrationProof: proof, serveEpoch: registered.processEpoch };
    const runBase = { ...base, registrationProof: proof, accountPublicKey: account.accountPublicKey,
      processEpoch: registered.processEpoch };
    const deny = async (name: string, run: () => Promise<unknown>) => cell(name, async () => {
      await assert.rejects(run, error => error instanceof EpEnvelopeError && error.code === "permission-denied" && /environment-manager/.test(error.message), name);
      const after = (await kv.get(envKey))!;
      assert.equal(after.revision, before.revision, `${name} leaves the native gate revision unchanged`);
      assert.deepEqual(after.value, before.value, `${name} leaves the native gate bytes unchanged`);
    });
    await deny("ordinary manager-caller refuses a registered environment instance", () => plane.authorizeManagerCaller(owner, envInstance));
    await deny("explicit manager selection refuses an environment instance", () => plane.selectManagerInstance(owner, envInstance));
    await cell("an environment manager alone is not an automatic ordinary candidate", async () => {
      await assert.rejects(() => plane.selectManagerInstance(owner), /found no manager candidate/);
    });
    for (const operation of ["prepare", "renew", "renewStandingBundle"] as const) {
      await deny(`human ${operation} refuses an environment registration`, () => plane.issueManagerServiceAuthority({ owner, scope: ["supervise"],
        request: { ...base, kind: "manager-service-authority", operation,
          ...(operation === "prepare" ? {} : { registrationProof: proof }),
          ...(operation === "renewStandingBundle" ? { accountPublicKey: account.accountPublicKey, processEpoch: registered.processEpoch } : {}) } }));
    }
    await deny("foreign human preparation refuses an environment registration", () => plane.issueManagerServiceAuthority({ owner: otherOwner, scope: ["supervise"],
      request: { ...base, kind: "manager-service-authority", operation: "prepare" } }));
    await deny("own maintenance refuses before scanning an environment credential family", () => plane.maintainRemoteManager({ owner, scope: ["supervise"],
      request: { ...base, kind: "manager-service-maintenance", operation: "evict-family-principal", targetInstanceId: envInstance,
        principals: [`${owner}.${remoteManagerActors(envInstance).serve}`] } }));
    const ordinary = await register(plainInstance);
    await deny("ordinary maintenance refuses a foreign environment target", () => plane.maintainRemoteManager({ owner, scope: ["supervise"],
      request: { ...envelope(plainInstance), kind: "manager-service-maintenance", operation: "reconcile-registration", targetInstanceId: envInstance } }));
    await deny("run admission refuses an environment registration", () => plane.admitManagerRun({ owner, scope: ["supervise"],
      request: { ...runBase, kind: "manager-run-admission", run: { runId: `run-${"a".repeat(32)}`, subject: "fixture-run-start" } } }));
    await deny("run attempt refuses an environment registration", () => plane.issueManagerRunAttempt({ owner, scope: ["supervise"],
      request: { ...runBase, kind: "manager-run-attempt", attempt: { runId: `run-${"a".repeat(32)}`, takeoverId: "fixture", epoch: 1,
        fencingToken: 1, driverId: newIdentity().id, mediatorId: newIdentity().id } } }));
    await deny("run revoke refuses an environment registration", () => plane.revokeManagerRun({ owner, scope: ["supervise"],
      request: { ...runBase, kind: "manager-run-revoke", revoke: { runId: `run-${"a".repeat(32)}`, reason: "fixture" } } }));
    await deny("goal index refuses an environment registration", () => plane.scanManagerGoalIndex({ owner, scope: ["supervise"],
      request: { ...current, kind: "manager-goal-index-scan" } }));
    await deny("admin authorization refuses an environment registration", () => plane.authorizeManagerAdmin({ owner, scope: ["supervise"],
      request: { ...current, kind: "manager-admin-authorization", caller: { owner, actor: "operator", lifecycleUid: mintLifecycleUid() } } }));
    await cell("mixed families leave ordinary explicit and automatic selection usable", async () => {
      await plane.authorizeManagerCaller(owner, plainInstance);
      assert.equal(await plane.selectManagerInstance(owner, plainInstance), plainInstance);
      assert.equal(await plane.selectManagerInstance(owner), plainInstance);
    });
    await cell("ordinary standing renewal and goal-index policy still work", async () => {
      const plainBase = envelope(plainInstance);
      const registrationProof = remoteManagerCurrentRegistrationProof(account.auth.account.signingSeed!, owner, plainBase, ordinary);
      const material = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: {
        ...plainBase, kind: "manager-service-authority", operation: "renewStandingBundle", registrationProof,
        accountPublicKey: account.accountPublicKey, processEpoch: ordinary.processEpoch } });
      assert.deepEqual(Object.keys(material.credentials).sort(), [...REMOTE_MANAGER_IDENTITY_NAMES].sort());
      const index = await plane.scanManagerGoalIndex({ owner, scope: ["supervise"], request: {
        ...plainBase, kind: "manager-goal-index-scan", registrationProof, serveEpoch: ordinary.processEpoch } });
      assert.deepEqual(index.entries, []);
    });
  } finally {
    await fixture?.close();
    await plane.close();
  }
}
try {
  await setupSpaceStreams({ servers: fx.servers, space: account.space,
    creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  service = await startAuthService({
    context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: account.space, servers: fx.servers, stateDir: account.stateDir,
    store: account.store, storeIdentity: account.store.identity,
    platformSupervisor: { authorizePlatformAdmin: async () => true,
      observeAssignment: async () => ({ v: 1, kind: "platform-supervisor", owner, state,
        space: account.space, accountPublicKey: account.accountPublicKey, instanceId, lifecycleUid,
        revision: 1, expiresAt: Math.floor(Date.now() / 1000) + 300, scope: ["supervise"] }) },
  });
  writer = await openAuthorityClient({ server: fx.servers, space: account.space,
    dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
    label: "environment-family-fixture", grants: id => remoteManagerIssuerGrants(account.space, id), log: () => {} });
  const kv = await new Kvm(writer.nc).open(epAuthBucket(account.space));
  await provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId,
    principal: `${owner}.${remoteManagerActors(instanceId).serve}`, authorityFamily: "environment-manager" });
  const door = await service.platformSupervisorAuthority!(owner);
  const prepare = () => door({ v: 1, kind: "platform-supervisor-authority", owner,
    assignmentRevision: 1, request: request() });
  const key = epgateKey("manager", instanceId);
  const initial = (await kv.get(key))!;
  const row = parseEndpointGate(initial.value, key);
  for (const gateState of ["open", "frozen", "retired"] as const) {
    const current = (await kv.get(key))!;
    const bytes = new TextEncoder().encode(JSON.stringify({ ...row, state: gateState,
      ...(gateState === "open" ? {} : { op: { opId: mintLifecycleUid(), kind: gateState === "frozen" ? "registration" : "retirement" } }) }));
    parseEndpointGate(bytes, key);
    await kv.update(key, bytes, current.revision);
    await assert.rejects(prepare, /environment-manager/,
      `human-family prepare refuses an environment gate in ${gateState} before releasing direct-store credentials`);
    passed++;
    assert.deepEqual((await kv.get(key))!.value, bytes, `refused ${gateState} preparation leaves the gate bytes unchanged`);
    passed++;
  }
  state = "ended";
  const beforeEnd = (await kv.get(key))!;
  await assert.rejects(() => service!.endPlatformSupervisorAssignment!(owner), /environment-manager/,
    "ending a human supervisor cannot retire an environment gate");
  passed++;
  assert.equal((await kv.get(key))!.revision, beforeEnd.revision, "refused cross-family end leaves the gate revision unchanged");
  passed++;

  state = "assigned";
  instanceId = mintLifecycleUid(); lifecycleUid = mintLifecycleUid();
  const plain = await prepare();
  assert.deepEqual(Object.keys(plain.credentials).sort(), ["executor", "supervisor"], "plain supervisor preparation still returns its fixed credentials");
  passed++;
  const reservedEntry = await kv.get(epgateKey("manager", instanceId));
  assert.ok(reservedEntry, "plain preparation reserves its native family before credential release");
  passed++;
  const reserved = parseEndpointGate(reservedEntry.value, epgateKey("manager", instanceId));
  assert.equal(reserved.authorityFamily, undefined, "plain preparation reserves the existing unmarked family");
  passed++;
  await assert.rejects(() => provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId,
    principal: reserved.principal, authorityFamily: "environment-manager" }), /FOREIGN|conflict/,
    "environment admission cannot adopt an instance whose direct-store preparation already won");
  passed++;

  for (let attempt = 0; attempt < 6; attempt++) {
    instanceId = mintLifecycleUid(); lifecycleUid = mintLifecycleUid();
    const raced = await Promise.allSettled([
      provisionEndpointGateOpen(kv, { endpoint: "manager", instanceId,
        principal: `${owner}.${remoteManagerActors(instanceId).serve}`, authorityFamily: "environment-manager" }),
      prepare(),
    ]);
    assert.equal(raced.filter(result => result.status === "fulfilled").length, 1, "native create-only reservation admits only one racing family");
    passed++;
    const gate = parseEndpointGate((await kv.get(epgateKey("manager", instanceId)))!.value, epgateKey("manager", instanceId));
    assert.equal(gate.authorityFamily === "environment-manager", raced[0].status === "fulfilled", "the winning family matches the native gate");
    passed++;
  }
  await exerciseAuthorityPaths();
} finally {
  await service?.close();
  await writer?.close();
  await fx.close();
}
emitSentinel({ passed, failed });
process.exitCode = failed === 0 ? 0 : 1;
