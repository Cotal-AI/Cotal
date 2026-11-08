/**
 * #4005: a user-mode seat released without teardown stays recorded, and the next start of the
 * same instance drives the retirement the release skipped.
 *
 * The first manager is the pre-change shape: it releases the seat and suppresses cleanup, and
 * nothing records the lifecycle. The second is this manager: it records the lifecycle when the
 * seat goes live, leaves that record when it releases the seat, and a later start retires it
 * through the same deprovision a live exit uses.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid, newIdentity, principalKey, remoteManagerActors } from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { readUserCustody } from "../src/resume.js";

const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const instanceId = mintLifecycleUid();
const scratch = process.env.COTAL_PROOF_TMP ?? tmpdir();
const workspace = mkdtempSync(join(scratch, "user-custody-release-"));
const calls: string[] = [];

function remote() {
  const identities = {
    supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(),
    goalWriter: newIdentity(), sessionLedger: newIdentity(),
  };
  return {
    owner,
    actors: remoteManagerActors(instanceId),
    instanceId,
    lifecycleUid: mintLifecycleUid(),
    identities,
    supervisorCreds: "", executorCreds: "", renewExecutor: async () => "", serveCreds: "",
    goalWriterCreds: "", sessionLedgerCreds: "", serveGrant: {} as never,
    agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => "",
    mintRetirementRequester: async () => "",
    prepareAgentRetirement: async () => { calls.push("prepare"); },
    validateRetainedAgent: async () => { throw new Error("unused"); },
    scanGoalIndex: async () => [],
    authorizeAdmin: async () => false,
  };
}

type Internals = {
  userMode: boolean;
  managerInstanceId: string;
  agents: Map<string, { name: string; id: string; lifecycleUid: string; userOwner: string; delegated?: boolean; launch: { allowSubscribe: string[] }; handle: { kind: string; reference?: { kind: string; id: string }; release?: () => void; status: () => string }; secretPaths?: { actorToken?: string } }>;
  releaseManagedAgents(): string[];
  stop(): Promise<void>;
  recordUserCustody(agent: Internals["agents"] extends Map<string, infer A> ? A : never): void;
  reconcileUserCustody(): Promise<void>;
  confirmRetirement(agent: { id: string; name: string; lifecycleUid: string }): void;
  deprovision(target: { name: string; lifecycleUid: string }): Promise<void>;
};

const uid = mintLifecycleUid();
const seat = {
  name: "worker",
  id: principalKey(owner, "worker").key,
  lifecycleUid: uid,
  userOwner: owner,
  launch: { allowSubscribe: [] as string[] },
  handle: { kind: "tmux", reference: { kind: "tmux", id: "seat-1" }, release: () => {}, status: () => "running" },
  secretPaths: agentLifecycleSecretFilePaths(workspace, "demo", "worker", uid),
};

let failed = 0;
try {
  const released = new Manager({ space: "demo", runtime: "pty", workspaceRoot: workspace, remoteAuthority: remote() }) as unknown as Internals;
  released.userMode = true;
  released.managerInstanceId = instanceId;
  released.agents.set(seat.name, seat);
  await released.stop().catch(() => {});
  assert.equal(released.agents.has(seat.name), false, "a default stop releases a detachable seat");
  assert.deepEqual(readUserCustody(workspace, "demo", instanceId), [], "before the record, a release leaves nothing a later start can retire");
  assert.deepEqual(calls, [], "the release itself calls no retirement");

  const holding = new Manager({ space: "demo", runtime: "pty", workspaceRoot: workspace, remoteAuthority: remote() }) as unknown as Internals;
  holding.userMode = true;
  holding.managerInstanceId = instanceId;
  holding.agents.set(seat.name, seat);
  holding.recordUserCustody(seat);
  const recorded = readUserCustody(workspace, "demo", instanceId);
  assert.equal(recorded.length, 1, "the live seat is recorded");
  assert.equal(recorded[0]?.lifecycleUid, uid);
  await holding.stop().catch(() => {});
  assert.equal(readUserCustody(workspace, "demo", instanceId).length, 1, "releasing the seat keeps the record");

  const next = new Manager({ space: "demo", runtime: "pty", workspaceRoot: workspace, remoteAuthority: remote() }) as unknown as Internals;
  next.userMode = true;
  next.managerInstanceId = instanceId;
  const original = next.deprovision.bind(next);
  next.deprovision = async (target: { name: string; lifecycleUid: string }) => {
    calls.push(`deprovision:${target.lifecycleUid}`);
    await original(target);
  };
  await next.reconcileUserCustody();
  assert.deepEqual(calls, [`deprovision:${uid}`, "prepare"], "the next start drives prepareAgentRetirement for the released lifecycle");
  assert.equal(readUserCustody(workspace, "demo", instanceId).length, 1, "the record stays until the rail confirms, so a later start re-drives it");
  next.confirmRetirement({ id: seat.id, name: seat.name, lifecycleUid: uid });
  assert.deepEqual(readUserCustody(workspace, "demo", instanceId), [], "a confirmed retirement removes the record");
  console.log("user-custody-release: passed");
} catch (error) {
  failed = 1;
  console.error(error);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
process.exit(failed);
