import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  authorizeServeGrant, contractDigest, createEndpointStreams, epAuthBucket, epcredRowKey, epgateKey,
  endpointRegistrationBarrier, finalizeServeIssuance, isReachable, mintLifecycleUid, openRecordsBucket,
  parseEndpointGate, parseLedgerRow, reconcileEndpointGate, registerServiceInstance, recordSpecKey, RECORD_KINDS,
  serveIssuanceGateKv, type EndpointGateRow, type EpIssuanceGate, type ServiceGateAuthority,
} from "../src/index.js";

const space = "service-release", endpoint = "org.example.release", owner = `u_${"a".repeat(26)}`, actor = "fixture";
const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir), enc = new TextEncoder();
const bytes = (value: unknown) => enc.encode(JSON.stringify(value));
const failures: string[] = [];
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const kv = await new Kvm(nc).open(epAuthBucket(space)), records = await openRecordsBucket(nc, space);
  const authority = (): ServiceGateAuthority => ({ v: 1, assignmentDigest: contractDigest({ assignment: 1 }),
    lifecycleUid: mintLifecycleUid(), state: "approved", rootCredentialId: mintLifecycleUid(),
    rootExpiresAt: Math.floor(Date.now() / 1000) + 600, approvalDigest: contractDigest({ approval: 1 }),
    approvalExpiresAt: null, callerCeiling: [], activationIssued: false });
  const row = (auth: ServiceGateAuthority): EndpointGateRow => ({ state: "open", generation: 0,
    processEpoch: 1, registrationRevision: 0, nameAuthorityRevision: 1, principal: `${owner}.${actor}`,
    authorityFamily: "service", serviceAuthority: auth });
  const doc = { urn: "org.example.release", revision: 1, attributes: [], events: [], commands: [{
    name: "read", class: "ephemeral", targeted: false, capability: "orders.read",
    inputDigest: contractDigest({ type: "object" }), outputDigest: contractDigest({ type: "object" }),
  }] };
  const manifest = { v: 1, root: contractDigest(doc), members: [] };
  const documents = new Map<string, unknown>([[contractDigest(doc), doc], [contractDigest(manifest), manifest]]);
  for (const evidence of ["active", "revoked", "corrupt", "deleted"] as const) {
    const instanceId = mintLifecycleUid(), key = epgateKey(endpoint, instanceId), credentialId = mintLifecycleUid();
    await kv.create(key, bytes(row(authority())));
    const credentialKey = epcredRowKey(endpoint, instanceId, credentialId);
    await kv.create(credentialKey, evidence === "corrupt" ? enc.encode("not-json") : bytes({ credentialId,
      holderPrincipal: `${owner}.${actor}`, lifecycleUid: instanceId, endpoint, sourceChain: ["root"],
      state: evidence === "revoked" ? "revoked" : "active", exp: Math.floor(Date.now() / 1000) + 60 }));
    if (evidence === "deleted") await kv.delete(credentialKey);
    const barrier = endpointRegistrationBarrier(kv, space, { endpoint, instanceId, opId: mintLifecycleUid(),
      serviceRegistration: { requestId: "a".repeat(32), requestDigest: contractDigest({ evidence }) } });
    try { await barrier.freeze((await barrier.observe())!.revision); failures.push(`${evidence}: freeze accepted issuance evidence`); }
    catch (error) { assert.match(String(error), /issuance evidence/); }
    assert.equal(parseEndpointGate((await kv.get(key))!.value, key).state, "frozen");
    await assert.rejects(registerServiceInstance(records, { space, instanceId,
      spec: { endpoint, owner, clusterDigests: [contractDigest(manifest)], protocol: { v: 1 } }, registrant: { owner },
      authority: { authorize: () => { throw new Error("unexpected name authority read"); } }, barrier,
      readClusterArtifact: (digest) => documents.get(digest),
    }), /issuance evidence/, "resumed registration refuses before publication or name policy effects");
    assert.equal(await records.get(recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId])), null);
    let probed = false;
    try {
      await reconcileEndpointGate({ kv, recordsKv: records, space, endpoint, instanceId,
        probeHolder: async () => { probed = true; throw new Error("unexpected probe"); },
        evictHolders: async () => { throw new Error("unexpected eviction"); }, log: () => {} });
      failures.push(`${evidence}: recovery accepted issuance evidence`);
    } catch (error) {
      if (probed) failures.push(`${evidence}: recovery reached ordinary holder reconciliation`);
      else assert.match(String(error), /issuance evidence/);
    }
  }
  const readConnection = await connect({ servers });
  const readKv = await new Kvm(readConnection).open(epAuthBucket(space));
  const failedInstance = mintLifecycleUid(), failedKey = epgateKey(endpoint, failedInstance);
  await kv.create(failedKey, bytes(row(authority())));
  const failedBarrier = endpointRegistrationBarrier(readKv, space, { endpoint, instanceId: failedInstance, opId: mintLifecycleUid(),
    serviceRegistration: { requestId: "a".repeat(32), requestDigest: contractDigest({ failedInstance }) } });
  assert.notEqual(await failedBarrier.freeze((await failedBarrier.observe())!.revision), null);
  await readConnection.close();
  await assert.rejects(async () => failedBarrier.enumerate(), "failed evidence read is not an empty family");
  assert.equal(parseEndpointGate((await kv.get(failedKey))!.value, failedKey).state, "frozen");
  const instanceId = mintLifecycleUid(), key = epgateKey(endpoint, instanceId);
  const revision = await records.create(recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]), bytes({ endpoint, owner,
    clusterDigests: [contractDigest(manifest)], protocol: { v: 1 } }));
  const active = authority(); active.activationIssued = true;
  active.registration = { operationId: mintLifecycleUid(), processEpoch: 1, registrationRevision: revision, nameAuthorityRevision: 1, requestId: "a".repeat(32), requestDigest: contractDigest({ request: 1 }), registrationProof: contractDigest({ registration: 1 }) };
  await kv.create(key, bytes({ ...row(active), registrationRevision: revision }));
  const grant = await authorizeServeGrant(records, { space, endpoint, instanceId, epoch: 1, holder: { owner },
    authority: { authorize: () => ({ authorized: true, revision: 1 }) }, readProcessEpoch: () => 1,
    readClusterArtifact: (digest) => documents.get(digest) });
  const native = serveIssuanceGateKv(kv, space, { endpoint, instanceId });
  for (const delay of ["stage", "ack"] as const) {
    const exp = Math.floor(Date.now() / 1000) + 2, credentialId = mintLifecycleUid();
    const expire = () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, exp * 1000 + 30 - Date.now())));
    const delayed: EpIssuanceGate = { ...native,
      stage: async (entry) => { await native.stage(entry); if (delay === "stage") await expire(); },
      commit: async (pin) => { const won = await native.commit(pin); if (delay === "ack") await expire(); return won; },
    };
    try {
      await finalizeServeIssuance(delayed, grant, { credentialId, credentialKey: "fixture-key", holderActor: actor, sourceChain: ["root"], exp });
      failures.push(`${delay}: expired fixed credential released`);
    } catch (error) {
      assert.match(String(error), /expired/);
      assert.equal(parseLedgerRow((await kv.get(epcredRowKey(endpoint, instanceId, credentialId)))!.value,
        epcredRowKey(endpoint, instanceId, credentialId)).state, "revoked");
    }
  }
  await finalizeServeIssuance(native, grant, { credentialId: mintLifecycleUid(), credentialKey: "fixture-key",
    holderActor: actor, sourceChain: ["root"], exp: Math.floor(Date.now() / 1000) + 30 });
  const ordinaryId = mintLifecycleUid();
  const ordinaryRevision = await records.create(recordSpecKey(RECORD_KINDS.svc, [endpoint, ordinaryId]), bytes({ endpoint, owner,
    clusterDigests: [contractDigest(manifest)], protocol: { v: 1 } }));
  await kv.create(epgateKey(endpoint, ordinaryId), bytes({ state: "open", generation: 0, processEpoch: 1,
    registrationRevision: ordinaryRevision, nameAuthorityRevision: 1, principal: `${owner}.${actor}` }));
  const ordinaryGrant = await authorizeServeGrant(records, { space, endpoint, instanceId: ordinaryId, epoch: 1, holder: { owner },
    authority: { authorize: () => ({ authorized: true, revision: 1 }) }, readProcessEpoch: () => 1,
    readClusterArtifact: (digest) => documents.get(digest) });
  await finalizeServeIssuance(serveIssuanceGateKv(kv, space, { endpoint, instanceId: ordinaryId }), ordinaryGrant,
    { credentialId: mintLifecycleUid(), credentialKey: "fixture-key", holderActor: actor, sourceChain: ["root"], exp: Math.floor(Date.now() / 1000) + 30 });
  assert.deepEqual(failures, [], "native service evidence and final release checks");
  console.log("service release: contradictory evidence, recovery and fixed-expiry delays refused on native KV");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
