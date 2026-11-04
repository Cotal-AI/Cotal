/** An unsettled team attempt gets a stopped receipt only when its own journal records every effect.
 *  The journal is the one a failed launch leaves: #lab created, pa joined, cx allocated but never
 *  joined, pb never submitted. Each way of leaving an effect unknown keeps the attempt without one,
 *  and a stopped receipt alone never releases the deployment's blocker. */
import { strict as nodeAssert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_OWNER } from "@cotal-ai/core";
import { canonicalRoot } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import {
  listAdditiveTeamAttempts, removalOriginal, retainedAdditiveTeamAttempts, stoppedAttemptEffects, writeAdditiveAgentStep,
  writeAdditiveChannelStep, writeAdditiveTeamAttempt, type AdditiveAgentStep, type AdditiveChannelStep, type AdditiveTeamAttempt,
} from "../src/lib/team-additive-attempt.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const root = canonicalRoot(mkdtempSync(join(tmpdir(), "cotal-team-stopped-")));
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
const manager = "a".repeat(26);
const now = () => new Date().toISOString();
const attempt: AdditiveTeamAttempt = {
  schemaVersion: 1, kind: "additive-team-attempt", deploymentId: "0123456789abcdef", root, space: "stopped-attempt",
  server: "nats://127.0.0.1:4999", manifestPath: join(root, "team.yaml"), manifestHash: "fedcba9876543210", authMode: "auth", tlsRequired: false,
  declaredChannels: ["lab"], requestedAgents: ["pa", "cx", "pb"],
  agentHashes: [{ name: "pa", hash: "1111111111111111" }, { name: "cx", hash: "2222222222222222" }, { name: "pb", hash: "3333333333333333" }],
  managerInstanceId: manager, createdAt: now(),
};
const request = (name: string, uid: string) => {
  const requestId = randomUUID();
  return { requestId, managerInstanceId: manager, managerEpoch: 1, goalId: requestId, fingerprint: `sha256:${name}`, allocation: { name, owner: DEV_OWNER, actor: `ACTOR${name.toUpperCase()}`, lifecycleUid: uid } };
};
const pa = request("pa", "b".repeat(26)), cx = request("cx", "c".repeat(26));

// Write the journal through the same synced write path a deploy uses.
writeAdditiveTeamAttempt(root, attempt);
writeAdditiveChannelStep(root, attempt, 0, "submitted");
writeAdditiveChannelStep(root, attempt, 0, "accepted", 3);
writeAdditiveAgentStep(root, attempt, 0, { phase: "submitted", managerInstanceId: manager, requestId: pa.requestId });
writeAdditiveAgentStep(root, attempt, 0, { phase: "accepted", managerInstanceId: manager, requestId: pa.requestId, request: pa });
writeAdditiveAgentStep(root, attempt, 0, { phase: "joined", managerInstanceId: manager, requestId: pa.requestId, request: pa, joined: { requested: "pa", hash: "1111111111111111", name: "pa", id: pa.allocation.actor, lifecycleUid: pa.allocation.lifecycleUid, agent: "pi", runtime: "pty", request: pa } });
writeAdditiveAgentStep(root, attempt, 1, { phase: "submitted", managerInstanceId: manager, requestId: cx.requestId });
writeAdditiveAgentStep(root, attempt, 1, { phase: "accepted", managerInstanceId: manager, requestId: cx.requestId, request: cx });

const inventory = listAdditiveTeamAttempts(root);
assert.equal(inventory.refused.length, 0);
assert.equal(inventory.returned.length, 0);
const stopped = removalOriginal(inventory, attempt.deploymentId);
assert.equal(stopped?.kind, "additive-stopped-receipt");
assert.deepEqual(stopped?.createdChannels, [{ name: "lab", revision: 3 }]);
assert.deepEqual(stopped?.createdAgents.map((row) => [row.requested, row.name, row.id, row.lifecycleUid, row.request.requestId]),
  [["pa", "pa", pa.allocation.actor, pa.allocation.lifecycleUid, pa.requestId], ["cx", "cx", cx.allocation.actor, cx.allocation.lifecycleUid, cx.requestId]]);
assert.deepEqual(retainedAdditiveTeamAttempts(inventory).map((row) => row.deploymentId), [attempt.deploymentId]);
console.log("PASS: a failed launch's journal yields its created card and both allocations, joined or not, and still blocks");

// The same journal, read in memory, with each way of leaving an effect unknown.
const { steps, agentSteps } = inventory;
const without = (rows: readonly AdditiveAgentStep[], ordinal: number, phase: AdditiveAgentStep["phase"]) => rows.filter((row) => !(row.ordinal === ordinal && row.phase === phase));
const unknown = (found: ReturnType<typeof stoppedAttemptEffects>) => "unknown" in found ? found.unknown : "receipt";
assert.equal(unknown(stoppedAttemptEffects(attempt, steps, agentSteps)), "receipt");
assert.equal(unknown(stoppedAttemptEffects(attempt, steps.filter((row: AdditiveChannelStep) => row.phase !== "accepted"), agentSteps)), "channel #lab was submitted with no recorded create revision");
assert.equal(unknown(stoppedAttemptEffects(attempt, steps, without(agentSteps, 1, "accepted"))), "agent cx was submitted with no recorded native allocation");
assert.equal(unknown(stoppedAttemptEffects(attempt, [], agentSteps)), "agent pa has a step although channel #lab before it was never submitted");
assert.equal(unknown(stoppedAttemptEffects(attempt, steps, [...agentSteps, { ...agentSteps.find((row) => row.ordinal === 1 && row.phase === "submitted")!, ordinal: 2, name: "pb" }].filter((row) => row.ordinal !== 1))), "agent pb has a step although agent cx before it was never submitted");
assert.equal(unknown(stoppedAttemptEffects(attempt, [], [])), "no channel or agent step is recorded, so nothing shows that the attempt ended");
console.log("PASS: an unconfirmed create, an unconfirmed launch, an out-of-order step and an empty journal stay unknown");

// An unreadable record of the attempt leaves it with no stopped receipt, and the route refuses it.
const junk = join(root, ".cotal", `team-deploy-agent-step-${attempt.deploymentId}-2-submitted.json`);
writeFileSync(junk, "{", { mode: 0o600 });
chmodSync(junk, 0o600);
const unreadable = listAdditiveTeamAttempts(root);
assert.equal(unreadable.refused.some((row) => row.path === junk), true);
assert.equal(removalOriginal(unreadable, attempt.deploymentId), undefined);
console.log("PASS: an unreadable step of the attempt leaves no stopped receipt");
console.log(`Retained fixtures: ${root}`);
emitSentinel({ passed: counted.cells(), failed: 0 });
