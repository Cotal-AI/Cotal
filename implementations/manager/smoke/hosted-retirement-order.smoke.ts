/** Broker-free hosted retirement ordering through the built Manager implementation. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { managedRetirementOpId, mintLifecycleUid, newIdentity, remoteManagerActors } from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import { agentLifecycleSecretFilePaths, agentSecretKeyForFile, materializeSecretToFile, workspaceSecretStore } from "@cotal-ai/workspace";

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
  supervisorCreds: "", executorCreds: "", renewExecutor: async () => "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
  serveGrant: {} as never,
  agentBearerExchangeUrl: "https://auth.example.test",
  mintSessionServing: async () => "",
  mintRetirementRequester: async () => "",
  validateRetainedAgent: async () => { throw new Error("not used by retirement ordering smoke"); },
  scanGoalIndex: async () => [],
  authorizeAdmin: async () => false,
};
type Family = { actorToken: string; sentinelCreds: string; health: string };
type Internals = {
  driveDeprovision(agent: { id: string; name: string; lifecycleUid: string; userOwner?: string; secretPaths?: Family }): Promise<void>;
  requestRetirement(agent: { id: string; name: string; lifecycleUid: string }): Promise<void>;
};
const agent = { id: `${owner}.worker`, name: "worker", lifecycleUid: targetUid, userOwner: owner };
// A scratch workspace for every cell: teardown removes this seat's local family, and a Manager given
// no root would resolve one from the working directory.
const workspace = mkdtempSync(join(tmpdir(), "hosted-retirement-family-"));

try {
  await cell("host release completes before the terminal request, preserving target and derived operation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const manager = new Manager({
      space: "demo", runtime: "pty", workspaceRoot: workspace,
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
      space: "demo", runtime: "pty", workspaceRoot: workspace,
      remoteAuthority: {
        ...base,
        prepareAgentRetirement: async () => { throw new Error("host release incomplete"); },
      },
    }) as unknown as Internals;
    manager.requestRetirement = async () => { requested = true; };
    await assert.rejects(manager.driveDeprovision(agent), /host release incomplete/);
    assert.equal(requested, false);
  });

  // #3055: the participant's own credential family, written by the hosted enrollment, is the
  // participant's to remove. The host release and the terminal request leave it on disk otherwise.
  const family = agentLifecycleSecretFilePaths(workspace, "demo", "worker", targetUid);
  const store = workspaceSecretStore(workspace);
  const writeFamily = async (): Promise<void> => {
    for (const [path, value] of [[family.actorToken, "token"], [family.sentinelCreds, "sentinel"]] as const) {
      await store.put(agentSecretKeyForFile(path, "demo"), value);
      await materializeSecretToFile(store, agentSecretKeyForFile(path, "demo"), path);
    }
    mkdirSync(dirname(family.health), { recursive: true });
    writeFileSync(family.health, "{}");
  };
  const left = async (): Promise<string[]> => [
    ...[family.actorToken, family.sentinelCreds, family.health].filter((path) => existsSync(path)),
    ...(await Promise.all([family.actorToken, family.sentinelCreds].map(async (path) =>
      (await store.get(agentSecretKeyForFile(path, "demo"))) === undefined ? undefined : `secret ${path}`))).filter((x) => x !== undefined),
  ];

  await cell("a completed hosted retirement leaves no participant credential family, removed after the host release", async () => {
    await writeFamily();
    let atPrepare: string[] = [];
    let requested = false;
    const manager = new Manager({
      space: "demo", runtime: "pty", workspaceRoot: workspace, secretStore: store,
      remoteAuthority: { ...base, prepareAgentRetirement: async () => { atPrepare = await left(); } },
    }) as unknown as Internals;
    manager.requestRetirement = async () => { requested = true; };
    await manager.driveDeprovision({ ...agent, secretPaths: family });
    assert.equal(atPrepare.length, 5, "the family is still there when the host release runs");
    assert.deepEqual(await left(), []);
    assert.equal(requested, true);
  });

  await cell("a failed local removal is reported, the rest of the family is still removed, and the terminal request waits", async () => {
    await writeFamily();
    let requested = false;
    const stuck = agentSecretKeyForFile(family.actorToken, "demo");
    const manager = new Manager({
      space: "demo", runtime: "pty", workspaceRoot: workspace,
      secretStore: {
        identity: store.identity,
        get: (k) => store.get(k), put: (k, v) => store.put(k, v), create: (k, v) => store.create(k, v),
        delete: async (k) => { if (k === stuck) throw new Error("store refused"); await store.delete(k); },
      },
      remoteAuthority: { ...base, prepareAgentRetirement: async () => {} },
    }) as unknown as Internals;
    manager.requestRetirement = async () => { requested = true; };
    await assert.rejects(manager.driveDeprovision({ ...agent, secretPaths: family }), /could not shred "worker": secret .*actor-token.*store refused/);
    // The workspace store keeps each entry at the file it materializes, so the file removal that
    // follows the refused store delete still takes the token off disk.
    assert.deepEqual(await left(), []);
    assert.equal(requested, false);
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\nhosted-retirement-order: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
