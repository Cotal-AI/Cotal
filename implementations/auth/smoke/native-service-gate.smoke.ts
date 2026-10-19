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
  contractDigest, createEndpointStreams, endpointRegistrationBarrier, isReachable, mintLifecycleUid,
  serviceEndpointActor, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openLifecycleRegistry, reserveLifecycleUid, registryStores } from "../src/lifecycle-registry.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { credRowKey, markLedgerRowRevoked } from "../src/credential-ledger.js";
import {
  approveNativeServiceGate, createPendingServiceGate, denyNativeServiceGate, fenceUncreatedServiceGate,
  markNativeServiceActivated, readNativeServiceGate,
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
  const actor = serviceEndpointActor(tuple);
  const lifecycleUid = await reserveLifecycleUid(reg, { owner: tuple.owner, actor, mintedBy: "service-fixture" });
  const binding = { ...tuple, lifecycleUid, assignmentDigest: contractDigest({ tuple, lifecycleUid }) };
  let gate = await createPendingServiceGate(reg, binding);
  assert.equal(gate.row.serviceAuthority.state, "pending-root");
  assert.equal((await createPendingServiceGate(reg, binding)).revision, gate.revision);
  const rootCredentialId = await ensureRootCredential(reg, { owner: tuple.owner, actor, lifecycleUid, managerInstance: "service-fixture" });
  gate = await approveNativeServiceGate(reg, binding, { expectedRevision: gate.revision, rootCredentialId,
    approvalDigest: contractDigest({ approved: binding.assignmentDigest }), nameAuthorityRevision: 1, approvalExpiresAt: null, callerCeiling: [] });
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
      registrationRevision: revision, nameAuthorityRevision: 1 }), true);
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
    registrationRevision: 2, nameAuthorityRevision: 1, registrationRequestId: stamp2.requestId, registrationProof: stamp2.registrationProof };
  await assert.rejects(markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness: { ...witness, registrationProof: stamp.registrationProof } }));
  gate = await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness });
  assert.equal(gate.row.serviceAuthority.activationIssued, true);
  assert.equal((await markNativeServiceActivated(reg, binding, { expectedRevision: gate.revision, witness })).revision, gate.revision);
  assert.equal(await duplicate.freeze(gate.revision), null, "activated service cannot begin another registration");
  await markLedgerRowRevoked(registryStores(reg).authKv, credRowKey(lifecycleUid, rootCredentialId));
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
  console.log("native service gate: root binding, registration stamps, monotonic activation and cancellation fence passed; full host retirement not exercised");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
