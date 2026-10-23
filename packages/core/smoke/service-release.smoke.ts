import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@nats-io/jwt";
import { createAccount, createServer, createUser } from "@nats-io/nkeys";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, countedAssert, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  authorizeServeGrant, contractDigest, createEndpointStreams, epAuthBucket, epcredRowKey, epgateKey,
  endpointRegistrationBarrier, finalizeServeIssuance, isReachable, mintLifecycleUid, mintServiceCalloutJwt, openRecordsBucket, principalKey,
  parseEndpointGate, parseLedgerRow, reconcileEndpointGate, registerServiceInstance, recordSpecKey, RECORD_KINDS,
  serveIssuanceGateKv, type EndpointGateRow, type EpIssuanceGate, type ServiceGateAuthority,
} from "../src/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

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
  const serviceConnection = { userNkey: createUser().getPublicKey(), serverId: createServer().getPublicKey(), clientId: 1 };
  const credentialKey = serviceConnection.userNkey;
  await assert.rejects(finalizeServeIssuance(native, grant, { credentialId: mintLifecycleUid(), credentialKey,
    holderActor: actor, sourceChain: ["root"], exp: Math.floor(Date.now() / 1000) + 30 }), /authenticated connection binding/);
  await assert.rejects(finalizeServeIssuance({ ...native, verifyServiceIssuance: undefined }, grant,
    { credentialId: mintLifecycleUid(), credentialKey, serviceConnection, holderActor: actor, sourceChain: ["root"],
      exp: Math.floor(Date.now() / 1000) + 30 }), /native verification/);
  for (const delay of ["stage", "ack"] as const) {
    const exp = Math.floor(Date.now() / 1000) + 2, credentialId = mintLifecycleUid();
    const expire = () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, exp * 1000 + 30 - Date.now())));
    const delayed: EpIssuanceGate = { ...native,
      stage: async (entry) => { await native.stage(entry); if (delay === "stage") await expire(); },
      commit: async (pin) => { const won = await native.commit(pin); if (delay === "ack") await expire(); return won; },
    };
    try {
      await finalizeServeIssuance(delayed, grant, { credentialId, credentialKey, serviceConnection, holderActor: actor, sourceChain: ["root"], exp });
      failures.push(`${delay}: expired fixed credential released`);
    } catch (error) {
      assert.match(String(error), /expired/);
      assert.equal(parseLedgerRow((await kv.get(epcredRowKey(endpoint, instanceId, credentialId)))!.value,
        epcredRowKey(endpoint, instanceId, credentialId)).state, "revoked");
    }
  }
  const issued = { credentialId: mintLifecycleUid(), credentialKey, serviceConnection,
    holderActor: actor, sourceChain: ["root"], exp: Math.floor(Date.now() / 1000) + 30 };
  await finalizeServeIssuance(native, grant, issued);
  const issuedKey = epcredRowKey(endpoint, instanceId, issued.credentialId);
  const stored = parseLedgerRow((await kv.get(issuedKey))!.value, issuedKey);
  assert.deepEqual(stored.serviceConnection, serviceConnection, "native service evidence retains its broker coordinates");
  for (const changed of [{ ...serviceConnection, clientId: 2 }, { ...serviceConnection, serverId: createServer().getPublicKey() }])
    await assert.rejects(finalizeServeIssuance(native, grant, { ...issued, serviceConnection: changed }), /FOREIGN/);
  assert.throws(() => parseLedgerRow(bytes({ ...stored, endpoint: undefined }), `cred.${instanceId}.${issued.credentialId}`), /agent-family/);
  for (const bad of [{ ...serviceConnection, clientId: 0 }, { ...serviceConnection, clientId: 1.5 },
    { ...serviceConnection, userNkey: serviceConnection.serverId }, { ...serviceConnection, extra: true }])
    assert.throws(() => parseLedgerRow(bytes({ ...stored, serviceConnection: bad }), issuedKey));
  const changedId = mintLifecycleUid();
  const changedPair: EpIssuanceGate = { ...native, commit: async (pin) => {
    const won = await native.commit(pin), rowKey = epcredRowKey(endpoint, instanceId, changedId);
    const entry = (await kv.get(rowKey))!, row = parseLedgerRow(entry.value, rowKey);
    await kv.update(rowKey, bytes({ ...row, serviceConnection: { ...serviceConnection, clientId: 2 } }), entry.revision);
    return won;
  } };
  await assert.rejects(finalizeServeIssuance(changedPair, grant, { ...issued, credentialId: changedId }), /could not be verified/);
  assert.equal(parseLedgerRow((await kv.get(epcredRowKey(endpoint, instanceId, changedId)))!.value,
    epcredRowKey(endpoint, instanceId, changedId)).state, "revoked");
  const account = createAccount(), signer = createAccount();
  const mintAuth = { space, account: { pub: account.getPublicKey(), signingSeed: new TextDecoder().decode(signer.getSeed()) } };
  const admittedAt = Math.floor(Date.now() / 1000), accessExpiresAt = admittedAt + 30, inboxNonce = "n".repeat(32);
  const mintArgs = { serve: grant, gate: native, principal: { owner, actor }, connection: serviceConnection,
    inboxNonce, admittedAt, accessExpiresAt, expiresAt: accessExpiresAt };
  const minted = await mintServiceCalloutJwt(mintAuth, mintArgs), claims = decode(minted.jwt);
  assert.equal(claims.name, principalKey(owner, actor).name, "callout authorized_user identifies the actual serving principal");
  assert.equal(claims.sub, serviceConnection.userNkey);
  assert.equal(claims.exp, accessExpiresAt);
  const nativePermissions = claims.nats as { sub: { allow: string[] }; pub: { allow: string[] } };
  assert.ok(nativePermissions.sub.allow.includes(`_INBOX_${inboxNonce}.>`));
  assert.ok(!nativePermissions.sub.allow.includes(`_INBOX_${serviceConnection.userNkey}.>`), "reply nonce is not inferred from the broker user key");
  assert.ok(nativePermissions.pub.allow.every((subject) => !subject.startsWith("$JS.") && !subject.startsWith("$KV.")));
  const mintedRowKey = epcredRowKey(endpoint, instanceId, minted.credentialId);
  assert.deepEqual(parseLedgerRow((await kv.get(mintedRowKey))!.value, mintedRowKey).serviceConnection, serviceConnection);
  await assert.rejects(mintServiceCalloutJwt(mintAuth, { ...mintArgs, expiresAt: accessExpiresAt + 1 }), /original admission-bounded expiry/);
  await assert.rejects(mintServiceCalloutJwt(mintAuth, { ...mintArgs, admittedAt: admittedAt - 61 }), /original admission-bounded expiry/);
  await assert.rejects(mintServiceCalloutJwt(mintAuth, { ...mintArgs, inboxNonce: ">" }));
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
  await assert.rejects(finalizeServeIssuance(serveIssuanceGateKv(kv, space, { endpoint, instanceId: ordinaryId }), ordinaryGrant,
    { ...issued, credentialId: mintLifecycleUid() }), /ordinary serving issuance/);
  assert.deepEqual(failures, [], "native service evidence and final release checks");
  console.log("service release: contradictory evidence, recovery, connection binding and fixed-expiry delays refused on native KV");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  release();
}
