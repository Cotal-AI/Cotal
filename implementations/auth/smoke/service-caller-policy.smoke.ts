import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "@nats-io/nkeys";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { contractDigest, createEndpointStreams, epgateKey, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { createPendingServiceGate } from "../src/native-service-gate.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { appendNativeServiceCallerGrant, beginNativeServiceCallerRevocation, parseNativeServiceCallerPolicy, readNativeServiceCallerPolicy } from "../src/service-caller-policy.js";
import type { ServiceCallerGrant } from "../src/service-host-contract.js";

const space = "service-policy", port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const reg = await openLifecycleRegistry(nc, space), otherWriter = await openLifecycleRegistry(nc, space);
  const binding = { accountPublicKey: createAccount().getPublicKey(), space,
    grantee: { owner: `u_${"a".repeat(26)}`, actor: "caller", lifecycleUid: mintLifecycleUid() } };
  const approval = contractDigest({ approved: 1 });
  const grant: ServiceCallerGrant = { grantId: "a".repeat(32), endpoint: "org.example.orders", instanceId: mintLifecycleUid(),
    serviceApprovalDigest: approval, capabilities: [{ endpoint: "org.example.orders", command: "read" }],
    source: { kind: "service-owner", owner: binding.grantee.owner, approvalDigest: approval, nameAuthorityRevision: 1 },
    parentRefs: [], status: { state: "active" } };
  assert.equal(await readNativeServiceCallerPolicy(reg, binding), undefined);
  let policy = await appendNativeServiceCallerGrant(reg, binding, { expectedRevision: 0, grant });
  assert.deepEqual(policy.row.grants[0]!.capabilities[0]!.routes, ["one"]);
  assert.equal((await appendNativeServiceCallerGrant(otherWriter, binding, { expectedRevision: 0, grant })).revision, policy.revision);
  await assert.rejects(appendNativeServiceCallerGrant(reg, binding, { expectedRevision: policy.revision, grant: { ...grant, capabilities: [] } }), /immutable/);
  const second = { ...grant, grantId: "b".repeat(32) }, third = { ...grant, grantId: "c".repeat(32) };
  const contenders = await Promise.allSettled([
    appendNativeServiceCallerGrant(reg, binding, { expectedRevision: policy.revision, grant: second }),
    appendNativeServiceCallerGrant(otherWriter, binding, { expectedRevision: policy.revision, grant: third }),
  ]);
  assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1, "two sealed registry writers cannot win one revision");
  policy = (await readNativeServiceCallerPolicy(reg, binding))!;
  assert.equal(policy.row.grants.length, 2);
  assert.deepEqual(policy.row.grants[0]!.status, { state: "active" });
  const operationId = "d".repeat(32);
  policy = await beginNativeServiceCallerRevocation(reg, binding, { expectedRevision: policy.revision, grantId: grant.grantId, operationId });
  assert.deepEqual(policy.row.grants[0]!.status, { state: "revoking", operationId, phase: "cutoff-required" });
  const unrelated = { ...grant, grantId: "e".repeat(32) };
  policy = await appendNativeServiceCallerGrant(otherWriter, binding, { expectedRevision: policy.revision, grant: unrelated });
  assert.deepEqual(policy.row.grants[0]!.status, { state: "revoking", operationId, phase: "cutoff-required" }, "unrelated append preserves deny-new intent");
  assert.equal((await beginNativeServiceCallerRevocation(reg, binding, { expectedRevision: 0, grantId: grant.grantId, operationId })).revision, policy.revision);
  await assert.rejects(beginNativeServiceCallerRevocation(reg, binding, { expectedRevision: policy.revision, grantId: grant.grantId, operationId: "f".repeat(32) }), /another revocation/);
  await assert.rejects(appendNativeServiceCallerGrant(reg, binding, { expectedRevision: policy.revision, grant }), /reactivated/);
  await assert.rejects(readNativeServiceCallerPolicy(reg, { ...binding, accountPublicKey: createAccount().getPublicKey() }), /immutable grantee/);
  await assert.rejects(readNativeServiceCallerPolicy(reg, { ...binding, grantee: { ...binding.grantee, actor: "other" } }), /immutable grantee/);
  await assert.rejects(readNativeServiceCallerPolicy(reg, { ...binding, space: "other" }), /another registry space/);
  for (const bad of [
    { ...policy.row, extra: true }, { ...policy.row, grants: [grant, grant] },
    { ...policy.row, grants: [{ ...grant, source: { ...grant.source, extra: true } }] },
    { ...policy.row, grants: [{ ...grant, status: { state: "active", operationId } }] },
    { ...policy.row, grants: [{ ...grant, capabilities: [{ endpoint: "org.example.other", command: "read" }] }] },
    { ...policy.row, grants: [{ ...grant, parentRefs: [{ principal: binding.grantee, grants: [{ granteeUid: mintLifecycleUid(), grantId: grant.grantId }] }] }] },
  ]) assert.throws(() => parseNativeServiceCallerPolicy(bad));
  const firstBinding = { ...binding, grantee: { ...binding.grantee, lifecycleUid: mintLifecycleUid() } };
  const firstCreates = await Promise.allSettled([
    appendNativeServiceCallerGrant(reg, firstBinding, { expectedRevision: 0, grant }),
    appendNativeServiceCallerGrant(otherWriter, firstBinding, { expectedRevision: 0, grant: { ...grant, grantId: "8".repeat(32) } }),
  ]);
  assert.equal(firstCreates.filter((r) => r.status === "fulfilled").length, 1, "concurrent first creation has one winner");
  assert.equal((await readNativeServiceCallerPolicy(reg, firstBinding))!.row.grants.length, 1);
  const recreationFailures: string[] = [];
  for (const marker of ["DEL", "PURGE"] as const) {
    const raceBinding = { ...binding, grantee: { ...binding.grantee, lifecycleUid: mintLifecycleUid() } };
    const key = `servicepolicy.${raceBinding.grantee.lifecycleUid}`;
    const kv = registryStores(reg).authKv, competingKv = registryStores(otherWriter).authKv;
    assert.notEqual(kv, competingKv);
    const originalGet = kv.get;
    let reached!: () => void, proceed!: () => void;
    const atRead = new Promise<void>((resolve) => { reached = resolve; });
    const releaseRead = new Promise<void>((resolve) => { proceed = resolve; });
    kv.get = async (...args) => {
      const entry = await originalGet.apply(kv, args);
      if (args[0] === key && !entry) { reached(); await releaseRead; }
      return entry;
    };
    const pending = appendNativeServiceCallerGrant(reg, raceBinding, { expectedRevision: 0, grant })
      .then(() => ({ accepted: true }), () => ({ accepted: false }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([atRead, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native absence read did not pause")), 5000); })]);
      clearTimeout(timer);
      const competing = await appendNativeServiceCallerGrant(otherWriter, raceBinding, { expectedRevision: 0, grant });
      await beginNativeServiceCallerRevocation(otherWriter, raceBinding, { expectedRevision: competing.revision, grantId: grant.grantId, operationId });
      if (marker === "DEL") await competingKv.delete(key); else await competingKv.purge(key);
      const before = (await competingKv.get(key))!;
      assert.equal(before.operation, marker);
      proceed();
      const outcome = await pending, after = (await competingKv.get(key))!;
      if (outcome.accepted || after.operation !== marker || after.revision !== before.revision)
        recreationFailures.push(`${marker}: initial absence writer recreated the policy after deny-new and deletion`);
    } finally { clearTimeout(timer); proceed(); kv.get = originalGet; await pending; }
  }
  const serviceBinding = { accountPublicKey: binding.accountPublicKey, space, owner: binding.grantee.owner,
    endpoint: "org.example.policy-history", instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(),
    assignmentDigest: contractDigest({ assignment: "history-fence" }) };
  await createPendingServiceGate(reg, serviceBinding);
  const serviceKey = epgateKey(serviceBinding.endpoint, serviceBinding.instanceId);
  await registryStores(reg).authKv.delete(serviceKey);
  const deletedGate = (await registryStores(reg).authKv.get(serviceKey))!;
  let recreatedGate = false;
  try { await createPendingServiceGate(reg, serviceBinding); recreatedGate = true; } catch { /* expected refusal */ }
  const afterGate = (await registryStores(reg).authKv.get(serviceKey))!;
  if (recreatedGate || afterGate.operation !== "DEL" || afterGate.revision !== deletedGate.revision)
    recreationFailures.push("service gate: create-only helper recreated a deleted pending assignment");
  assert.deepEqual(recreationFailures, [], "initial authority creation never adopts deletion history after an absent read");
  const mutableBinding = { ...binding, grantee: { ...binding.grantee } };
  const mutableGrant = { ...grant, grantId: "9".repeat(32), capabilities: [{ endpoint: grant.endpoint, command: "read" }] };
  const inFlight = appendNativeServiceCallerGrant(reg, mutableBinding, { expectedRevision: policy.revision, grant: mutableGrant });
  mutableBinding.grantee.actor = "changed"; mutableGrant.capabilities[0]!.command = "changed";
  policy = await inFlight;
  assert.equal(policy.row.grantee.actor, binding.grantee.actor);
  assert.equal(policy.row.grants.at(-1)!.capabilities[0]!.command, "read", "caller-owned input is snapshotted before native awaits");
  await registryStores(reg).authKv.put(`servicepolicy.${binding.grantee.lifecycleUid}`, new TextEncoder().encode('{"v":1}'));
  await assert.rejects(readNativeServiceCallerPolicy(reg, binding), /invalid native/);
  await registryStores(reg).authKv.delete(`servicepolicy.${binding.grantee.lifecycleUid}`);
  await assert.rejects(readNativeServiceCallerPolicy(reg, binding), /deletion marker/);
  await assert.rejects(appendNativeServiceCallerGrant(reg, binding, { expectedRevision: 0, grant }), /deletion marker/);
  await nc.close();
  await assert.rejects(readNativeServiceCallerPolicy(reg, binding), "failed reader is not an empty policy");
  console.log("service caller policy: real shared-store CAS, immutable grants, binding and preserved deny-new intents passed; native authorization and terminal retirement remain separate");
} finally {
  await nc?.close(); await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true }); release();
}
