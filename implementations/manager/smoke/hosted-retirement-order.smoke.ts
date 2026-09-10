/** Broker-free hosted retirement ordering through the built Manager implementation. */
import assert from "node:assert/strict";
import { managedRetirementOpId, mintLifecycleUid, newIdentity, remoteManagerActors } from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.log(`  ✗ FAIL: ${name}`, error); }
}

const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const instanceId = mintLifecycleUid();
const managerUid = mintLifecycleUid();
const targetUid = mintLifecycleUid();
const identities = {
  supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(),
  goalWriter: newIdentity(), sessionLedger: newIdentity(),
};
const base = {
  owner,
  actors: remoteManagerActors(instanceId),
  instanceId,
  lifecycleUid: managerUid,
  identities,
  supervisorCreds: "", executorCreds: "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
  serveGrant: {} as never,
  mintSessionServing: async () => "",
  mintRetirementRequester: async () => "",
};
type Internals = {
  driveDeprovision(agent: { id: string; name: string; lifecycleUid: string; userOwner?: string }): Promise<void>;
  requestRetirement(agent: { id: string; name: string; lifecycleUid: string }): Promise<void>;
};
const agent = { id: `${owner}.worker`, name: "worker", lifecycleUid: targetUid, userOwner: owner };

await cell("host release completes before the terminal request, preserving target and derived operation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const manager = new Manager({
    space: "demo", runtime: "pty",
    remoteAuthority: {
      ...base,
      prepareAgentRetirement: async (args) => { calls.push({ step: "prepare", ...args }); },
    },
  }) as unknown as Internals;
  manager.requestRetirement = async (a) => { calls.push({ step: "request", agent: a }); };
  await manager.driveDeprovision(agent);
  assert.deepEqual(calls.map((call) => call.step), ["prepare", "request"]);
  assert.deepEqual(calls[0]?.target, { owner, actor: "worker", lifecycleUid: targetUid });
  assert.equal(calls[0]?.opId, managedRetirementOpId(targetUid));
});

await cell("an incomplete host release prevents the terminal request", async () => {
  let requested = false;
  const manager = new Manager({
    space: "demo", runtime: "pty",
    remoteAuthority: {
      ...base,
      prepareAgentRetirement: async () => { throw new Error("host release incomplete"); },
    },
  }) as unknown as Internals;
  manager.requestRetirement = async () => { requested = true; };
  await assert.rejects(manager.driveDeprovision(agent), /host release incomplete/);
  assert.equal(requested, false);
});

console.log(`\nhosted-retirement-order: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
