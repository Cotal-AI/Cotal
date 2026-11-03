/**
 * #2896: every manager door runs ONE current-registration check, so a gate refuses the same way at
 * each of them. Broker-free: each door is driven with valid requests, and only the manager gate the
 * host observes varies. The delegated user intent execution door is the one whose copy had drifted:
 * it checked the principal before the open state, so a frozen gate held by another owner was
 * `permission-denied` there and `failed-precondition` at every other door. The manager-service
 * `renew` arm needs a live authority plane and is not driven here; its request carries no epoch, so
 * a stale one is refused by the proof, which binds the gate's epoch.
 *
 * #3495: the manager-service retirement policy checks the gate the same way and carries no current-
 * registration proof (its request binds the lifecycle proof), so it is a gate-only door here. Every
 * refusal is also held to one wording, so a copy that drifts in its sentence is caught as well.
 */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import {
  createSpaceAuth, EpEnvelopeError, mintLifecycleUid, newIdentity, remoteManagerServePrincipal,
  type RemoteDelegatedUserIntentExecutionRequest, type RemoteManagedAgentEnrollmentRequest,
  type RemoteManagerAuthorityRequest, type RemoteManagerGoalIndexScanRequest, type RemoteRetainedAgentValidationRequest,
} from "@cotal-ai/core";
import {
  authorizeDelegatedUserIntentExecution, authorizeRemoteManagedAgentEnrollment, deriveOwnerToken,
  newActorToken, platformControlOwner, remoteManagerCurrentRegistrationProof,
  type DelegatedUserIntentRecord,
} from "../src/index.js";
import { requireCurrentServeTimeManager } from "../src/manager-admin-authorization.js";
import { authorizeRemoteManagerRenewal } from "../src/manager-authority.js";
import { authorizeRemoteManagerGoalIndexScan } from "../src/manager-goal-index.js";
import { authorizeRemoteRetainedAgentValidation } from "../src/retained-manager-validation.js";
import { authorizeRemoteManagerRetirement } from "../src/service.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const space = "doors";
const { account } = await createSpaceAuth(space);
const accountPublicKey = account.pub;
const secret = "host-proof-secret";
const owner = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const otherOwner = deriveOwnerToken("s".repeat(32), "better-auth|human-2");
const platformOwner = platformControlOwner("p".repeat(32), space, accountPublicKey);
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const EPOCH = 4;
const REVISION = 9;
const identities = {
  supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id },
  goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id },
};
const envelope = { space, actor: "cli" as const, instanceId, managerLifecycleUid, identities };
const proof = (proofOwner: string) =>
  remoteManagerCurrentRegistrationProof(secret, proofOwner, envelope, { registrationRevision: REVISION, processEpoch: EPOCH });

type Gate = { state: "open" | "frozen"; principal: string; processEpoch: number; registrationRevision: number } | null;
/** One gate case, phrased for the door's own owner: `own` is that owner's serve principal. A
 *  `proofOnly` case is refused only by a door that checks the current-registration proof. */
type Case = { name: string; gate: (own: string, foreign: string) => Gate; code: string | null; says?: RegExp; proofOnly?: true };
const NO_GATE = /found no current open manager gate for instance /;
const CASES: Case[] = [
  { name: "an open gate at the owner's serve principal and the current epoch", gate: (own) => ({ state: "open", principal: own, processEpoch: EPOCH, registrationRevision: REVISION }), code: null },
  { name: "an absent gate", gate: () => null, code: "failed-precondition", says: NO_GATE },
  { name: "a frozen gate of the owner", gate: (own) => ({ state: "frozen", principal: own, processEpoch: EPOCH, registrationRevision: REVISION }), code: "failed-precondition", says: NO_GATE },
  { name: "an open gate held by another owner", gate: (_own, foreign) => ({ state: "open", principal: foreign, processEpoch: EPOCH, registrationRevision: REVISION }), code: "permission-denied", says: / gate belongs to \S+, not serve principal \S+$/ },
  { name: "an open gate of the owner at a newer epoch", gate: (own) => ({ state: "open", principal: own, processEpoch: EPOCH + 1, registrationRevision: REVISION }), code: "conflict", says: new RegExp(` serve epoch ${EPOCH} is stale; current is ${EPOCH + 1}$`) },
  { name: "a frozen gate held by another owner", gate: (_own, foreign) => ({ state: "frozen", principal: foreign, processEpoch: EPOCH, registrationRevision: REVISION }), code: "failed-precondition", says: NO_GATE },
  { name: "an open gate at a registration revision the proof does not name", gate: (own) => ({ state: "open", principal: own, processEpoch: EPOCH, registrationRevision: REVISION + 1 }), code: "permission-denied", says: / proof does not match current host registration$/, proofOnly: true },
];

const outcomeOf = async (call: () => unknown): Promise<{ code: string | null; message?: string }> => {
  try {
    await call();
    return { code: null };
  } catch (e) {
    if (e instanceof EpEnvelopeError) return { code: e.code, message: e.message };
    throw e;
  }
};

const enrollment: RemoteManagedAgentEnrollmentRequest = {
  v: 1, kind: "manager-managed-agent-enrollment", ...envelope,
  requestId: `enroll${mintLifecycleUid()}`, registrationProof: proof(owner), serveEpoch: EPOCH,
  target: { actor: "worker", tokenHash: newActorToken().tokenHash, allowSubscribe: ["general"] },
};
const enroll = (gate: Gate) => authorizeRemoteManagedAgentEnrollment({
  request: enrollment, space, owner, scope: ["supervise"], proofSecret: secret, observeManagerGate: async () => gate,
});

const assignmentRevision = 3;
const target = { owner, actor: "worker", lifecycleUid: mintLifecycleUid() };
const intent: DelegatedUserIntentRecord = {
  v: 1, space, owner, actor: "cli", parent: `${owner}.cli`, intentId: mintLifecycleUid(), accountPublicKey,
  instanceId, managerLifecycleUid, assignmentRevision, serveEpoch: EPOCH,
  intent: { operation: "retire", target }, expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "admitted",
};
const execution: RemoteDelegatedUserIntentExecutionRequest = {
  v: 1, kind: "manager-delegated-user-intent-execution", ...envelope, accountPublicKey, assignmentRevision,
  requestId: `execute${mintLifecycleUid()}`, registrationProof: proof(platformOwner), serveEpoch: EPOCH,
  intentId: intent.intentId, execute: { operation: "retire", target },
};
const execute = (gate: Gate) => authorizeDelegatedUserIntentExecution({
  request: execution, space, accountPublicKey, platformOwner, intent, proofSecret: secret, now: Date.now(),
  observeAssignment: async () => ({ v: 1, space, accountPublicKey, instanceId, lifecycleUid: managerLifecycleUid, assignmentRevision, state: "assigned" }),
  observeManagerGate: async () => gate,
});

const retained: RemoteRetainedAgentValidationRequest = {
  v: 1, kind: "manager-retained-agent-validation", ...envelope,
  requestId: `retain${mintLifecycleUid()}`, registrationProof: proof(owner), serveEpoch: EPOCH,
  target, actorToken: "actor-secret", sentinelCreds: "sentinel-secret",
};
const retain = (gate: Gate) => authorizeRemoteRetainedAgentValidation({
  request: retained, space, owner, scope: ["supervise"], proofSecret: secret, observeManagerGate: async () => gate,
});

const scan: RemoteManagerGoalIndexScanRequest = {
  v: 1, kind: "manager-goal-index-scan", ...envelope,
  requestId: `scan${mintLifecycleUid()}`, registrationProof: proof(owner), serveEpoch: EPOCH,
};
const scanGoals = (gate: Gate) => authorizeRemoteManagerGoalIndexScan({
  request: scan, space, owner, scope: ["supervise"], proofSecret: secret, observeManagerGate: async () => gate,
});

const serveTime = (gate: Gate) => requireCurrentServeTimeManager(
  { space, managerOwner: owner, managerScope: ["supervise"], proofSecret: secret, observeManagerGate: async () => gate },
  { ...envelope, registrationProof: proof(owner), serveEpoch: EPOCH },
  "manager admin authorization",
);

const renewal = {
  v: 1, kind: "manager-service-authority", operation: "renewStandingBundle", ...envelope,
  requestId: `renew${mintLifecycleUid()}`, registrationProof: proof(owner), accountPublicKey, processEpoch: EPOCH,
} as RemoteManagerAuthorityRequest;
const renew = (gate: Gate) => authorizeRemoteManagerRenewal({
  request: renewal, owner, space, accountPublicKey, proofSecret: secret, observeManagerGate: async () => gate, observeRun: async () => null,
});

const retire = (gate: Gate) => authorizeRemoteManagerRetirement({
  owner, instanceId, targetOwner: owner, serveEpoch: EPOCH, gate,
});

const ownGate = remoteManagerServePrincipal(owner, instanceId);
const foreignGate = remoteManagerServePrincipal(otherOwner, instanceId);
const doors = [
  { name: "managed-agent enrollment", call: enroll, own: ownGate, foreign: foreignGate },
  { name: "retained-agent validation", call: retain, own: ownGate, foreign: foreignGate },
  { name: "goal-index scan", call: scanGoals, own: ownGate, foreign: foreignGate },
  { name: "serve-time manager admin check", call: serveTime, own: ownGate, foreign: foreignGate },
  { name: "manager-service renewal", call: renew, own: ownGate, foreign: foreignGate },
  { name: "delegated user intent execution", call: execute, own: remoteManagerServePrincipal(platformOwner, instanceId), foreign: foreignGate },
  { name: "manager-service retirement", call: retire, own: ownGate, foreign: foreignGate, gateOnly: true },
];

for (const c of CASES) {
  const asked = doors.filter((d) => !(c.proofOnly && d.gateOnly));
  const outcomes = Object.fromEntries(await Promise.all(asked.map(async (d) => [d.name, await outcomeOf(() => d.call(c.gate(d.own, d.foreign)))] as const)));
  assert.deepEqual(Object.fromEntries(Object.entries(outcomes).map(([n, o]) => [n, o.code])), Object.fromEntries(asked.map((d) => [d.name, c.code])), `${c.name}: every door answers ${c.code ?? "accept"}`);
  if (c.says) {
    const says = c.says;
    const odd = Object.entries(outcomes).filter(([, o]) => !says.test(o.message ?? "")).map(([n, o]) => `${n}: ${o.message}`);
    assert.deepEqual(odd, [], `${c.name}: every door says it in the same words`);
  }
  console.log(`  ✓ ${c.name}: every door${c.proofOnly ? " that checks the proof" : ""} answers ${c.code ?? "accept"}${c.says ? ", in the same words" : ""}`);
}
// A gate-only door is still handed the proof-only case, and it accepts: it binds no current proof.
assert.equal((await outcomeOf(() => retire(CASES.at(-1)!.gate(ownGate, foreignGate)))).code, null, "a gate-only door accepts a gate at another registration revision");
console.log("  ✓ the gate-only door accepts a gate at another registration revision, binding no current proof");

console.log(`manager registration check: ${cells()} passed, 0 failed`);
emitSentinel({ passed: cells(), failed: 0 });
