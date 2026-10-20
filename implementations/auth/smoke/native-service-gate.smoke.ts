import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "@nats-io/nkeys";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  contractDigest, createEndpointStreams, endpointToken, epgateKey, endpointRegistrationBarrier, isReachable, mintLifecycleUid,
  serviceEndpointActor, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openLifecycleRegistry, reserveLifecycleUid, registryStores } from "../src/lifecycle-registry.js";
import { bindNativeServiceName, nativeServiceNameAuthority, readNativeServiceName } from "../src/native-service-name.js";
import { openConnectReader } from "../src/connect-reader.js";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { validateUserToken } from "../src/token.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { credRowKey, markLedgerRowRevoked } from "../src/credential-ledger.js";
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
  const lifecycleUid = await reserveLifecycleUid(reg, { owner: tuple.owner, actor, mintedBy: "service-fixture" });
  const binding = { ...tuple, lifecycleUid, assignmentDigest: contractDigest({ tuple, lifecycleUid }) };
  let gate = await createPendingServiceGate(reg, binding);
  assert.equal(gate.row.serviceAuthority.state, "pending-root");
  assert.equal((await createPendingServiceGate(reg, binding)).revision, gate.revision);
  const rootCredentialId = await ensureRootCredential(reg, { owner: tuple.owner, actor, lifecycleUid, managerInstance: "service-fixture" });
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
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt), /current activated registration/);
  gate = await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness });
  assert.equal(gate.row.serviceAuthority.activationIssued, true);
  assert.equal((await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness })).revision, gate.revision);
  assert.equal(await duplicate.freeze(gate.revision), null, "activated service cannot begin another registration");
  assert.deepEqual(await readNativeServiceAccess(reg, reader, binding, access, expiresAt),
    { witness, gateRevision: gate.revision, expiresAt }, "signed service access retains native root authorization without an ActorRow");
  await assert.rejects(readNativeServiceAccess(reg, reader, { ...binding, assignmentDigest: contractDigest({ other: true }) }, access, expiresAt), /another immutable assignment/);
  await assert.rejects(readNativeServiceAccess(reg, reader, { ...binding, accountPublicKey: createAccount().getPublicKey() }, access, expiresAt), /native assignment/);
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt + 1), /original bounded expiry/);
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, Math.floor(Date.now() / 1000)), /original bounded expiry/);
  const stale = await validateUserToken(await issuer.issueServiceAccess({ witness: { ...witness, registrationProof: stamp.registrationProof }, expiresAt }),
    { issuer: issuer.issuer, key: issuer.localKeySet(), audience: space });
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, stale, expiresAt), /current activated registration/);
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
  await markLedgerRowRevoked(registryStores(reg).authKv, credRowKey(lifecycleUid, rootCredentialId));
  await assert.rejects(readNativeServiceAccess(reg, reader, binding, access, expiresAt), /not active/);
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
  console.log("native service gate: create-only name binding and native reservations, root binding, registration stamps, monotonic activation, native access prerequisites and cancellation fence passed; full host retirement not exercised");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
