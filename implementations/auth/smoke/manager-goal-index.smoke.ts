/** Closed host-owned remote manager goal-index scan policy. */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { mintLifecycleUid, newIdentity, remoteManagerActors, type RemoteManagerGoalIndexScanRequest } from "@cotal-ai/core";
import { authorizeRemoteManagerGoalIndexScan, completeRemoteManagerGoalIndexScan, parseRemoteManagerGoalIndexScanRequest } from "../src/manager-goal-index.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
const { assert, cells } = countedAssert(nodeAssert);

const owner = `u_${"a".repeat(26)}`;
const otherOwner = `u_${"b".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const identities = {
  supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id },
  goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id },
};
const gate = { state: "open" as const, principal: `${owner}.${actors.serve}`, processEpoch: 7, registrationRevision: 11 };
const secret = "host-secret";
const base = {
  v: 1 as const, kind: "manager-goal-index-scan" as const, space: "demo", actor: "cli", instanceId,
  managerLifecycleUid, requestId: `scan${mintLifecycleUid()}`, registrationProof: "", serveEpoch: 7, identities,
};
const request: RemoteManagerGoalIndexScanRequest = {
  ...base,
  registrationProof: remoteManagerCurrentRegistrationProof(secret, owner, base, gate),
};
const run = (overrides: Partial<Parameters<typeof authorizeRemoteManagerGoalIndexScan>[0]> = {}) =>
  authorizeRemoteManagerGoalIndexScan({ request, space: "demo", owner, scope: ["supervise"], proofSecret: secret, observeManagerGate: async () => gate, ...overrides });

assert.throws(() => parseRemoteManagerGoalIndexScanRequest({ ...request, filter: "goalidx.>" }), /unknown field/);
await assert.rejects(run({ scope: ["spawn"] }), /scope "supervise"/);
await assert.rejects(run({ request: { ...request, space: "other" } }), /not this host space/);
await assert.rejects(run({ request: { ...request, serveEpoch: 6 } }), /serve epoch 6 is stale/);
await assert.rejects(run({ observeManagerGate: async () => ({ ...gate, principal: `${otherOwner}.${actors.serve}` }) }), /not u_/);
await assert.rejects(run({ request: { ...request, registrationProof: `sha256:${"f".repeat(64)}` } }), /current host registration/);
const authorized = await run();
const entry = { v: 1 as const, endpoint: "manager", owner, actor: "cli", uid: mintLifecycleUid(), goalId: `goal${mintLifecycleUid()}`, iid: instanceId };
assert.deepEqual(completeRemoteManagerGoalIndexScan(authorized, owner, [entry]).entries, [entry]);
assert.throws(() => completeRemoteManagerGoalIndexScan(authorized, owner, [{ ...entry, owner: otherOwner }]), /foreign endpoint or owner/);
console.log("manager goal-index scan: 8 passed, 0 failed");
emitSentinel({ passed: cells(), failed: 0 });
