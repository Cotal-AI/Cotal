import assert from "node:assert/strict";
import { createAccount } from "@nats-io/nkeys";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  buildContractClosureManifest, contractArtifactCanonicalBytes, contractStoreContext, fetchContractClosure,
  parseServiceAuthorityRequest, publishContractArtifact, publishContractClosureManifest,
  contractDigest, createEndpointStreams, epAuthBucket, epgateKey, endpointRegistrationBarrier,
  isReachable, mintLifecycleUid, parseEndpointGate, parseServiceGateAuthority, serviceGateApprovalLive,
  serveIssuanceGateKv, type EndpointGateRow, type ServiceGateAuthority,
} from "../src/index.js";

const space = "service-gate-smoke", endpoint = "org.example.orders", instanceId = mintLifecycleUid();
const key = epgateKey(endpoint, instanceId), enc = new TextEncoder();
const now = Math.floor(Date.now() / 1000);
const pending: ServiceGateAuthority = {
  v: 1, assignmentDigest: contractDigest({ assignment: 1 }), lifecycleUid: mintLifecycleUid(),
  state: "pending-root", rootCredentialId: null, rootExpiresAt: null, approvalDigest: null,
  approvalExpiresAt: null, callerCeiling: [], activationIssued: false,
};
assert.deepEqual(parseServiceGateAuthority(pending), pending);
assert.throws(() => parseServiceGateAuthority({ ...pending, activationIssued: true }));
assert.throws(() => parseServiceGateAuthority({ ...pending, state: "approved" }));
const approved: ServiceGateAuthority = {
  ...pending, state: "approved", rootCredentialId: mintLifecycleUid(), rootExpiresAt: now + 600,
  approvalDigest: contractDigest({ approval: 1 }), approvalExpiresAt: now + 300,
};
assert.equal(serviceGateApprovalLive(approved, now), true);
assert.equal(serviceGateApprovalLive(approved, now + 300), false);
assert.equal(serviceGateApprovalLive({ ...approved, state: "revoked" }, now), false);
const row: EndpointGateRow = {
  state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
  principal: `u_${"a".repeat(26)}.service_fixture`, authorityFamily: "service", serviceAuthority: pending,
};
const bytes = (value: unknown) => enc.encode(JSON.stringify(value));
assert.deepEqual(parseEndpointGate(bytes(row), key), row);
assert.throws(() => parseEndpointGate(bytes({ ...row, serviceAuthority: undefined }), key));
assert.throws(() => parseEndpointGate(bytes({ ...row, authorityFamily: undefined }), key));
const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const kv = await new Kvm(nc).open(epAuthBucket(space));
  await kv.create(key, bytes(row));
  const gate = serveIssuanceGateKv(kv, space, { endpoint, instanceId });
  const barrier = endpointRegistrationBarrier(kv, space, { endpoint, instanceId, opId: mintLifecycleUid() });
  let observed = (await gate.observe())!;
  assert.equal(await gate.commit(observed.revision), false, "pending root cannot release");
  assert.equal(await barrier.freeze(observed.revision), null, "pending root cannot register");
  await kv.update(key, bytes({ ...row, serviceAuthority: approved }), observed.revision);
  observed = (await gate.observe())!;
  const token = await barrier.freeze(observed.revision);
  assert.notEqual(token, null);
  const next = { generation: 1, processEpoch: 1, registrationRevision: 1, nameAuthorityRevision: 1 };
  assert.equal(await barrier.reopen(token!, next), true);
  observed = (await gate.observe())!;
  assert.deepEqual(observed.serviceAuthority, approved, "registration preserves approval");
  assert.equal(await gate.commit(observed.revision), false, "approval alone is not activation");
  const activated = { ...approved, activationIssued: true, registration: {
    requestId: "a".repeat(32), requestDigest: contractDigest({ request: 1 }), registrationProof: contractDigest({ registration: 1 }),
  } };
  await kv.update(key, bytes({ ...row, ...next, serviceAuthority: activated }), observed.revision);
  observed = (await gate.observe())!;
  assert.equal(await barrier.freeze(observed.revision), null, "activated registration cannot be superseded");
  assert.equal(await gate.commit(observed.revision), true);
  observed = (await gate.observe())!;
  await kv.update(key, bytes({ ...row, ...next, serviceAuthority: { ...activated, state: "revoked" } }), observed.revision);
  observed = (await gate.observe())!;
  assert.equal(await gate.commit(observed.revision), false, "revoked approval cannot release on an open gate");
  assert.equal(await barrier.freeze(observed.revision), null, "revoked approval cannot register");
  const context = await contractStoreContext(nc, space);
  const leaves = Array.from({ length: 64 }, (_, index) => ({ refs: [], leaf: index }));
  const refs: string[] = [];
  for (const leaf of leaves) refs.push(`sha256:${(await publishContractArtifact(context, contractArtifactCanonicalBytes(leaf))).digestHex}`);
  const makeClosure = async (count: number) => {
    const root = { refs: refs.slice(0, count), label: `closure-${count}` };
    const rootRef = `sha256:${(await publishContractArtifact(context, contractArtifactCanonicalBytes(root))).digestHex}`;
    const manifest = buildContractClosureManifest(rootRef, root.refs);
    const published = await publishContractClosureManifest(context, manifest);
    return { root, manifest, closureDigest: `sha256:${published.closureDigestHex}` };
  };
  const refsOf = (value: Uint8Array) => (JSON.parse(new TextDecoder().decode(value)) as { refs: string[] }).refs;
  const valid = await makeClosure(63);
  const complete = await fetchContractClosure(context, valid.closureDigest, refsOf);
  assert.equal(complete.artifacts.size, 64, "native walk counts documents, not its manifest");
  const excessive = await makeClosure(64);
  await assert.rejects(fetchContractClosure(context, excessive.closureDigest, refsOf), /64-artifact bound/);
  const registration = {
    v: 1, kind: "service-endpoint-authority", operation: "register", requestId: "b".repeat(32),
    accountPublicKey: createAccount().getPublicKey(), space, endpoint, instanceId,
    registration: { clusterDigests: [valid.closureDigest], contractArtifacts: [valid.manifest, valid.root, ...leaves.slice(0, 63)] },
    expected: { state: "unregistered" },
  };
  assert.doesNotThrow(() => parseServiceAuthorityRequest(registration), "transport accepts a verified 64-document closure plus its manifest");
  const second = await makeClosure(62);
  assert.equal((await fetchContractClosure(context, second.closureDigest, refsOf)).artifacts.size, 63);
  assert.doesNotThrow(() => parseServiceAuthorityRequest({ ...registration, registration: {
    clusterDigests: [valid.closureDigest, second.closureDigest],
    contractArtifacts: [valid.manifest, valid.root, second.manifest, second.root, ...leaves.slice(0, 63)],
  } }), "transport accounts for a deduplicated union of multiple closures");
  console.log("service gate: native KV registration and release guards passed; host activation/retirement not exercised");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
