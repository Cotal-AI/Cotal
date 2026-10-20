import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount, createServer, createUser } from "@nats-io/nkeys";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  contractDigest, createEndpointStreams, endpointToken, epcredRowKey, epgateKey, nativeIssuanceKey, endpointRegistrationBarrier, isReachable, mintLifecycleUid,
  serviceEndpointActor, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openLifecycleRegistry, reserveLifecycleUid, registryStores } from "../src/lifecycle-registry.js";
import { bindNativeServiceName, nativeServiceNameAuthority, readNativeServiceName } from "../src/native-service-name.js";
import { makeNativeIssuanceRecorder, nativeIssuanceRecord, parseNativeIssuanceRecord, pruneNativeIssuance, readNativeIssuance } from "../src/native-issuance.js";
import { authorizeConnectCredential, openConnectReader } from "../src/connect-reader.js";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { validateUserToken } from "../src/token.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { credRowKey, markLedgerRowRevoked } from "../src/credential-ledger.js";
import { readConnectServiceRoot, readRegistryServiceRoot } from "../src/service-root-reader.js";
import {
  approveNativeServiceGate, createPendingServiceGate, denyNativeServiceGate, fenceUncreatedServiceGate,
  markNativeServiceActivated, readNativeServiceGate, readNativeServiceAccess,
} from "../src/native-service-gate.js";

const space = "native-service-gate", port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const reg = await openLifecycleRegistry(nc, space);
  const tuple = { accountPublicKey: createAccount().getPublicKey(), space, owner: `u_${"a".repeat(26)}`,
    endpoint: "org.example.orders", instanceId: mintLifecycleUid() };
  const nameContext = { accountPublicKey: tuple.accountPublicKey, space };
  const nameRequest = { v: 1 as const, kind: "service-endpoint-host" as const, requestId: "a".repeat(32), operation: "name-bind" as const,
    granter: { kind: "operator" as const, auditId: "fixture-verified-claim" },
    input: { endpoint: tuple.endpoint, owner: tuple.owner, expectedRevision: 0, claimReference: "fixture-namespace-claim" } };
  const names = nativeServiceNameAuthority(reg, nameContext);
  assert.deepEqual(await names.authorize(tuple.endpoint, tuple.owner), { authorized: false, revision: 0 });
  const nameBinding = await bindNativeServiceName(reg, nameContext, nameRequest);
  assert.equal((await bindNativeServiceName(reg, nameContext, nameRequest)).revision, nameBinding.revision);
  assert.deepEqual(await names.authorize(tuple.endpoint, tuple.owner), { authorized: true, revision: nameBinding.revision });
  assert.deepEqual(await names.authorize(tuple.endpoint, `u_${"b".repeat(26)}`), { authorized: false, revision: nameBinding.revision });
  await assert.rejects(bindNativeServiceName(reg, nameContext, { ...nameRequest, requestId: "b".repeat(32),
    input: { ...nameRequest.input, owner: `u_${"b".repeat(26)}` } }), /FOREIGN/);
  await assert.rejects(bindNativeServiceName(reg, nameContext, { ...nameRequest, input: { ...nameRequest.input, expectedRevision: nameBinding.revision } }), /create-only/);
  await assert.rejects(bindNativeServiceName(reg, nameContext, { ...nameRequest, granter: { kind: "owner", owner: tuple.owner } }), /operator decision/);
  for (const endpoint of ["manager", "auth", "delivery"])
    await assert.rejects(bindNativeServiceName(reg, nameContext, { ...nameRequest, input: { ...nameRequest.input, endpoint } }), /native control/);
  const referenceName = await bindNativeServiceName(reg, nameContext, { ...nameRequest, requestId: "f".repeat(32),
    input: { ...nameRequest.input, endpoint: "linear" } });
  assert.equal(referenceName.owner, tuple.owner, "operator-provisioned reference names do not require an application allowlist");
  const contenders = await Promise.allSettled([tuple.owner, `u_${"b".repeat(26)}`].map((owner, index) => bindNativeServiceName(reg, nameContext,
    { ...nameRequest, requestId: String(index + 3).repeat(32), input: { ...nameRequest.input, endpoint: "org.example.concurrent", owner } })));
  assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1, "one owner wins a native name binding");
  const deletedRequest = { ...nameRequest, requestId: "e".repeat(32), input: { ...nameRequest.input, endpoint: "org.example.deleted" } };
  await bindNativeServiceName(reg, nameContext, deletedRequest);
  await registryStores(reg).authKv.delete(`servicename.${endpointToken(deletedRequest.input.endpoint)}`);
  await assert.rejects(readNativeServiceName(reg, nameContext, deletedRequest.input.endpoint), /deletion history/);
  await assert.rejects(bindNativeServiceName(reg, nameContext, deletedRequest), /FOREIGN/);
  await assert.rejects(readNativeServiceName(reg, { ...nameContext, accountPublicKey: createAccount().getPublicKey() }, tuple.endpoint), /another account/);
  await assert.rejects(readNativeServiceName(reg, { ...nameContext, space: "other" }, tuple.endpoint), /native registry/);
  const actor = serviceEndpointActor(tuple);
  // Synthetic test-operator seeding, NOT a service reservation/root writer or admission acceptance.
  const lifecycleUid = mintLifecycleUid(), rootCredentialId = mintLifecycleUid(), stores = registryStores(reg);
  const custody = { v: 1, kind: "native-service-uid", native: { accountPublicKey: tuple.accountPublicKey, space, lifecycleUid },
    assignment: { owner: tuple.owner, actor, endpoint: tuple.endpoint, instanceId: tuple.instanceId, duty: "serve" },
    creation: { operationId: mintLifecycleUid(), requestDigest: contractDigest({ syntheticFixture: true }) } };
  const mirror = { v: 1, uidDigest: contractDigest(custody) }, encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  await stores.recordsKv.create(`uid.${lifecycleUid}`, encode(custody));
  await stores.recordsKv.create(`lifecycle.${tuple.owner}.${actor}`, encode({ owner: tuple.owner, actor, lifecycleUid,
    managerInstance: tuple.instanceId, processEpoch: 1, state: "active", currentCredentialId: rootCredentialId, serviceCustody: mirror }));
  const rootRow = { credentialId: rootCredentialId, holderPrincipal: `${tuple.owner}.${actor}`, lifecycleUid,
    sourceChain: ["root"], state: "active", exp: Date.now() + 60_000, serviceCustody: mirror };
  await stores.authKv.create(`cred.${lifecycleUid}.${rootCredentialId}`, encode(rootRow));
  const binding = { ...tuple, lifecycleUid, assignmentDigest: mirror.uidDigest };
  const headKey = `lifecycle.${tuple.owner}.${actor}`, nativeGateKey = `gate.${lifecycleUid}`;
  const validHead = JSON.parse(new TextDecoder().decode((await stores.recordsKv.get(headKey))!.value));
  const validGate = { lifecycleUid, state: "open", generation: 1, serviceCustody: mirror };
  const proofNow = Date.now();
  await assert.rejects(readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow), /no durable gate/,
    "missing native gate cannot be replaced by any endpoint gate");
  await stores.authKv.create(nativeGateKey, encode(validGate));
  assert.ok((await readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow)).expiresAt > proofNow / 1000);
  await assert.rejects(readRegistryServiceRoot({ space }, binding, rootCredentialId, proofNow), /hand-assembled/);
  await assert.rejects(readConnectServiceRoot({ space }, binding, rootCredentialId, proofNow), /hand-assembled/);
  await assert.rejects(readRegistryServiceRoot(reg, { ...binding, accountPublicKey: createAccount().getPublicKey() }, rootCredentialId, proofNow), /immutable account/);
  await assert.rejects(readRegistryServiceRoot(reg, { ...binding, space: "foreign" }, rootCredentialId, proofNow), /another sealed store/);
  await assert.rejects(readRegistryServiceRoot(reg, { ...binding, assignmentDigest: contractDigest({ other: true }) }, rootCredentialId, proofNow), /assignment digest/);
  for (const corrupt of [
    { ...validHead, managerInstance: "ordinary-manager" }, { ...validHead, processEpoch: 2 },
    { ...validHead, serviceCustody: { ...mirror, uidDigest: contractDigest({ wrong: true }) } },
    { ...Object.fromEntries(Object.entries(validHead).filter(([key]) => key !== "currentCredentialId")), state: "service-creating", op: { kind: "service-create", opId: custody.creation.operationId,
      requestDigest: custody.creation.requestDigest }, rootPlan: { credentialId: rootCredentialId, expMs: rootRow.exp } },
    { ...validHead, state: "service-cancelling", op: { kind: "service-cancel", opId: mintLifecycleUid(),
      requestDigest: contractDigest({ cancel: true }) }, rootPlan: { credentialId: rootCredentialId, expMs: rootRow.exp } },
    Object.fromEntries(Object.entries(validHead).filter(([key]) => key !== "serviceCustody")),
    { ...validHead, currentCredentialId: mintLifecycleUid() }, { ...validHead, extra: true },
  ]) {
    await stores.recordsKv.put(headKey, encode(corrupt));
    await assert.rejects(readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow));
  }
  await stores.recordsKv.put(headKey, encode(validHead));
  for (const corrupt of [
    { ...validGate, generation: 0 }, { ...validGate, generation: 2 },
    { ...validGate, state: "frozen", op: { kind: "activation", opId: custody.creation.operationId } },
    { ...validGate, serviceCustody: { ...mirror, uidDigest: contractDigest({ other: true }) } },
    Object.fromEntries(Object.entries(validGate).filter(([key]) => key !== "serviceCustody")),
    { ...validGate, op: { kind: "activation", opId: custody.creation.operationId } },
  ]) {
    await stores.authKv.put(nativeGateKey, encode(corrupt));
    await assert.rejects(readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow));
  }
  await stores.authKv.delete(nativeGateKey);
  await assert.rejects(readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow), /absent or deleted/);
  await stores.authKv.put(nativeGateKey, encode(validGate));
  for (const corrupt of [
    { ...rootRow, state: "revoked" }, { ...rootRow, exp: proofNow }, { ...rootRow, exp: Number.MAX_SAFE_INTEGER + 1 },
    { ...rootRow, holderPrincipal: `${tuple.owner}.other` }, { ...rootRow, lifecycleUid: mintLifecycleUid() },
    { ...rootRow, sourceChain: ["root", "handle.key.id"] },
    { ...rootRow, serviceCustody: { ...mirror, uidDigest: contractDigest({ root: "wrong" }) } },
    Object.fromEntries(Object.entries(rootRow).filter(([key]) => key !== "serviceCustody")),
    { ...rootRow, endpoint: tuple.endpoint },
  ]) {
    await stores.authKv.put(`cred.${lifecycleUid}.${rootCredentialId}`, encode(corrupt));
    await assert.rejects(readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow));
  }
  await stores.authKv.put(`cred.${lifecycleUid}.${rootCredentialId}`, encode(rootRow));
  const uidKey = `uid.${lifecycleUid}`;
  await stores.recordsKv.put(uidKey, encode({ owner: tuple.owner, actor, mintedBy: "synthetic-ordinary-residue" }));
  await assert.rejects(readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow), /ordinary reservation/);
  await stores.recordsKv.put(uidKey, encode(custody));
  // Instrument real leader API only. The fixture has no copied parser/authority implementation.
  const originalLeaderGet = stores.jsm.streams.getMessage, leaderSubjects: string[] = [];
  stores.jsm.streams.getMessage = async (...args) => {
    leaderSubjects.push("last_by_subj" in args[1] ? String(args[1].last_by_subj) : "non-last-subject-read");
    return originalLeaderGet.apply(stores.jsm.streams, args);
  };
  try { await readRegistryServiceRoot(reg, binding, rootCredentialId, proofNow); }
  finally { stores.jsm.streams.getMessage = originalLeaderGet; }
  assert.equal(leaderSubjects.length, 4);
  assert.ok(leaderSubjects.some(s => s.endsWith(`.${nativeGateKey}`)));
  let gate = await createPendingServiceGate(reg, binding);
  assert.equal(gate.row.serviceAuthority.state, "pending-root");
  assert.equal((await createPendingServiceGate(reg, binding)).revision, gate.revision);
  const ordinaryTuple = { ...tuple, instanceId: mintLifecycleUid() }, ordinaryActor = serviceEndpointActor(ordinaryTuple);
  const ordinaryUid = mintLifecycleUid(), ordinaryRoot = mintLifecycleUid();
  await stores.recordsKv.create(`uid.${ordinaryUid}`, encode({ owner: tuple.owner, actor: ordinaryActor, mintedBy: "synthetic-legacy-residue" }));
  await stores.recordsKv.create(`lifecycle.${tuple.owner}.${ordinaryActor}`, encode({ owner: tuple.owner, actor: ordinaryActor,
    lifecycleUid: ordinaryUid, managerInstance: ordinaryTuple.instanceId, processEpoch: 1, state: "active", currentCredentialId: ordinaryRoot }));
  await stores.authKv.create(`cred.${ordinaryUid}.${ordinaryRoot}`, encode({ ...rootRow, credentialId: ordinaryRoot,
    lifecycleUid: ordinaryUid, holderPrincipal: `${tuple.owner}.${ordinaryActor}` }));
  const ordinaryBinding = { ...ordinaryTuple, lifecycleUid: ordinaryUid, assignmentDigest: contractDigest({ ordinary: true }) };
  const ordinaryPending = await createPendingServiceGate(reg, ordinaryBinding);
  await assert.rejects(approveNativeServiceGate(reg, ordinaryBinding, { expectedRevision: ordinaryPending.revision,
    rootCredentialId: ordinaryRoot, approvalDigest: contractDigest({ approved: true }), nameAuthorityRevision: nameBinding.revision,
    approvalExpiresAt: null, callerCeiling: [] }), /ordinary reservation/, "ordinary custody never supplies service approval authority");
  await assert.rejects(ensureRootCredential(reg, { owner: tuple.owner, actor, lifecycleUid, managerInstance: tuple.instanceId }),
    /service custody|immutable service/, "ordinary root reuse never accepts synthetic service custody");
  gate = await approveNativeServiceGate(reg, binding, { expectedRevision: gate.revision, rootCredentialId,
    approvalDigest: contractDigest({ approved: binding.assignmentDigest }), nameAuthorityRevision: nameBinding.revision, approvalExpiresAt: null, callerCeiling: [] });
  assert.equal(gate.row.serviceAuthority.state, "approved");
  assert.ok(gate.row.serviceAuthority.rootExpiresAt! < Date.now(), "gate root expiry is seconds, not ledger milliseconds");
  const register = async (revision: number) => {
    const barrier = endpointRegistrationBarrier(registryStores(reg).authKv, space, { endpoint: tuple.endpoint,
      instanceId: tuple.instanceId, opId: mintLifecycleUid(), serviceRegistration: {
        requestId: revision.toString(16).padStart(32, "0"), requestDigest: contractDigest({ request: revision }),
      } });
    const observed = (await barrier.observe())!;
    const token = await barrier.freeze(observed.revision);
    assert.notEqual(token, null);
    assert.equal(await barrier.reopen(token!, { generation: observed.generation + 1, processEpoch: observed.processEpoch + 1,
      registrationRevision: revision, nameAuthorityRevision: nameBinding.revision }), true);
    return (await readNativeServiceGate(reg, binding))!;
  };
  gate = await register(1);
  const stamp = gate.row.serviceAuthority.registration!;
  assert.equal(stamp.requestId, "1".padStart(32, "0"));
  const duplicate = endpointRegistrationBarrier(registryStores(reg).authKv, space, { endpoint: tuple.endpoint,
    instanceId: tuple.instanceId, opId: mintLifecycleUid(), serviceRegistration: { requestId: stamp.requestId, requestDigest: stamp.requestDigest } });
  await assert.rejects(async () => duplicate.freeze(gate.revision), /completed registration request/);
  gate = await register(2);
  const stamp2 = gate.row.serviceAuthority.registration!;
  assert.equal(stamp2.requestId, "2".padStart(32, "0"));
  assert.notEqual(stamp2.registrationProof, stamp.registrationProof, "successful replacement has its own atomic completion proof");
  assert.equal(gate.row.serviceAuthority.pendingRegistration, undefined);
  const witness: ServiceRegistrationWitness = { accountPublicKey: tuple.accountPublicKey, space, endpoint: tuple.endpoint,
    instanceId: tuple.instanceId, principal: { owner: tuple.owner, actor, lifecycleUid }, rootCredentialId,
    approvalDigest: gate.row.serviceAuthority.approvalDigest!, processEpoch: gate.row.processEpoch,
    registrationRevision: 2, nameAuthorityRevision: nameBinding.revision, registrationRequestId: stamp2.requestId, registrationProof: stamp2.registrationProof };
  await assert.rejects(markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness: { ...witness, registrationProof: stamp.registrationProof } }));
  const reader = await openConnectReader(nc, space);
  const issuer = createUserTokenIssuer({ issuer: "https://authority.example/native-service", key: await generateSigningKey() });
  const expiresAt = Math.floor(Date.now() / 1000) + 45;
  const access = await validateUserToken(await issuer.issueServiceAccess({ witness, expiresAt }),
    { issuer: issuer.issuer, key: issuer.localKeySet(), audience: space });
  await assert.rejects(authorizeConnectCredential(reader, access, Date.now), /service custody|immutable service/,
    "ordinary connect guard remains closed to service roots");
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt), /current activated registration/);
  gate = await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness });
  assert.equal(gate.row.serviceAuthority.activationIssued, true);
  assert.equal((await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness })).revision, gate.revision);
  assert.equal(await duplicate.freeze(gate.revision), null, "activated service cannot begin another registration");
  assert.deepEqual(await readNativeServiceAccess(reg, reader, binding, access, expiresAt),
    { witness, gateRevision: gate.revision, expiresAt }, "signed service access retains native root authorization without an ActorRow");
  await assert.rejects(readNativeServiceAccess(reg, reader, { ...binding, assignmentDigest: contractDigest({ other: true }) }, access, expiresAt), /assignment digest/);
  await assert.rejects(readNativeServiceAccess(reg, reader, { ...binding, accountPublicKey: createAccount().getPublicKey() }, access, expiresAt), /native assignment/);
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt + 1), /original bounded expiry/);
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, Math.floor(Date.now() / 1000)), /original bounded expiry/);
  const stale = await validateUserToken(await issuer.issueServiceAccess({ witness: { ...witness, registrationProof: stamp.registrationProof }, expiresAt }),
    { issuer: issuer.issuer, key: issuer.localKeySet(), audience: space });
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, stale, expiresAt), /current activated registration/);
  const connection = { userNkey: createUser().getPublicKey(), serverId: createServer().getPublicKey(), clientId: 1 };
  const serviceCredentialId = mintLifecycleUid(), authKv = registryStores(reg).authKv;
  const issuance = { userNkey: connection.userNkey, token: access, connId: "n".repeat(32), iat: Math.floor(Date.now() / 1000), exp: expiresAt,
    service: { credentialId: serviceCredentialId, connection } };
  const receiptWriter = makeNativeIssuanceRecorder(reg, async (token) => { await readNativeServiceAccess(reg, reader, binding, token, expiresAt); });
  await assert.rejects(receiptWriter(issuance), /service issuance evidence is unavailable/);
  const evidenceKey = epcredRowKey(tuple.endpoint, tuple.instanceId, serviceCredentialId);
  await authKv.create(evidenceKey, new TextEncoder().encode(JSON.stringify({ credentialId: serviceCredentialId,
    holderPrincipal: `${tuple.owner}.${actor}`, lifecycleUid: tuple.instanceId, endpoint: tuple.endpoint, sourceChain: ["root"],
    state: "active", exp: expiresAt, serviceConnection: connection })));
  await receiptWriter(issuance);
  const receipt = (await readNativeIssuance(authKv, connection.userNkey))!;
  assert.deepEqual(receipt.service, { witness, credentialId: serviceCredentialId, connection });
  await assert.rejects(receiptWriter(issuance), "one native key cannot acquire a second receipt");
  assert.throws(() => nativeIssuanceRecord(space, { ...issuance, service: undefined }), /bounded native evidence/);
  assert.throws(() => nativeIssuanceRecord(space, { ...issuance, userNkey: createUser().getPublicKey() }), /different user key/);
  assert.throws(() => parseNativeIssuanceRecord({ ...receipt, view: "agent" }), /must occur together/);
  assert.throws(() => parseNativeIssuanceRecord({ ...receipt, credentialId: mintLifecycleUid() }), /native root and lifetime/);
  const foreignReceiptKey = nativeIssuanceKey(createUser().getPublicKey());
  await authKv.create(foreignReceiptKey, new TextEncoder().encode(JSON.stringify(receipt)));
  await assert.rejects(pruneNativeIssuance(reg, expiresAt + 10), /receipt key does not match/);
  await authKv.delete(foreignReceiptKey);
  const pruned = await pruneNativeIssuance(reg, expiresAt + 10);
  assert.equal(pruned.retainedService, 1, "elapsed service JWT time is not topology-qualified absence");
  assert.deepEqual(await readNativeIssuance(authKv, connection.userNkey), receipt);
  await authKv.delete(nativeIssuanceKey(connection.userNkey));
  await assert.rejects(receiptWriter(issuance), "deleted native service receipt cannot be recreated");
  const mutableBinding = { ...binding }, mutableAccess = structuredClone(access);
  const detached = readNativeServiceAccess(reg, reader, mutableBinding, mutableAccess, expiresAt);
  mutableBinding.assignmentDigest = contractDigest({ changed: true });
  mutableAccess.act.service!.witness.registrationProof = stamp.registrationProof;
  assert.equal((await detached).gateRevision, gate.revision, "native access snapshots caller-owned inputs before reads");
  const kv = registryStores(reg).authKv, originalGet = kv.get;
  kv.get = async (...args) => {
    const result = await originalGet.apply(kv, args);
    if (args[0] === `servicename.${endpointToken(tuple.endpoint)}`)
      await new Promise((resolve) => setTimeout(resolve, 1100));
    return result;
  };
  try {
    await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, Math.floor(Date.now() / 1000) + 1), /expired during native authorization/);
  } finally { kv.get = originalGet; }
  kv.get = async (...args) => {
    const result = await originalGet.apply(kv, args);
    if (args[0] === `servicename.${endpointToken(tuple.endpoint)}`) {
      const row = { ...gate.row, generation: gate.row.generation + 1 };
      const revision = await kv.update(epgateKey(tuple.endpoint, tuple.instanceId), new TextEncoder().encode(JSON.stringify(row)), gate.revision);
      gate = { row, revision };
    }
    return result;
  };
  try {
    await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt), /authority changed during/);
  } finally { kv.get = originalGet; }
  assert.equal((await readNativeServiceAccess(reg, reader, binding, access, expiresAt)).gateRevision, gate.revision);
  await assert.rejects(markLedgerRowRevoked(stores.authKv, credRowKey(lifecycleUid, rootCredentialId)), /serviceCustody/,
    "ordinary raw revoke helper still refuses the service marker");
  // Test-operator raw mutation only to inject revoked evidence. There is no service revoke writer here.
  await stores.authKv.put(credRowKey(lifecycleUid, rootCredentialId), encode({ ...rootRow, state: "revoked" }));
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt), /not live/);
  await assert.rejects(markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness }), /not live/);
  gate = await denyNativeServiceGate(reg, binding, { expectedRevision: gate.revision, operationId: mintLifecycleUid() });
  assert.equal(gate.row.serviceAuthority.state, "revoked");
  assert.equal(gate.row.state, "frozen", "deny-new does not claim terminal retirement");
  assert.equal(gate.row.serviceAuthority.activationIssued, true);
  const cancelledTuple = { ...tuple, instanceId: mintLifecycleUid() };
  const cancelledActor = serviceEndpointActor(cancelledTuple);
  const cancelledUid = await reserveLifecycleUid(reg, { owner: tuple.owner, actor: cancelledActor, mintedBy: "service-fixture" });
  const cancelled = { ...cancelledTuple, lifecycleUid: cancelledUid, assignmentDigest: contractDigest({ cancelledTuple, cancelledUid }) };
  const cancelledGate = await fenceUncreatedServiceGate(reg, cancelled, mintLifecycleUid());
  assert.equal(cancelledGate.row.serviceAuthority.state, "revoked");
  await assert.rejects(createPendingServiceGate(reg, cancelled), /FOREIGN content/);
  console.log("native service gate: synthetic canonical marked custody/root prerequisites, ordinary refusal, name binding, registration stamps and activation checks passed; no production service writer/admission/retirement acceptance");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
