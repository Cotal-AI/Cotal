import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "@nats-io/nkeys";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { contractDigest, createEndpointStreams, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
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
