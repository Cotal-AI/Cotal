/**
 * MANAGER RESTART + (i) EPOCH FENCE smoke (control-surface P2 item 3, slice 3a) — the P2 acceptance
 * line: "manager endpoint restart preserves the logical instance + durable goal handle while fencing
 * the OLD process epoch."
 *
 * OPEN mesh (evictor-free — pin 2: a bare registration mints no serve family, so a restart needs no
 * delivery daemon). The manager persists its logical instanceId + serve identity under .cotal, so a
 * restart in the SAME workspace root re-registers the SAME instanceId with an ADVANCED processEpoch
 * through the §13.1 gate. A goal terminal committed under the OLD epoch is then INVISIBLE to a
 * current-epoch reader (the 3.0 (i) fence, now driven by a REAL restart), and the successor's settle
 * under the current epoch is what callers see.
 *
 * Run: pnpm smoke:manager-restart-fence   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { createServer, type AddressInfo } from "node:net";
import {
  probeConnect, newIdentity, mintLifecycleUid, DEV_OWNER,
  bindGoal, createGoal, commitGoalResult, readGoalResult, goalRefOf,
  type ActionContext, type EpCaller, type ParsedEpRequest,
} from "@cotal-ai/core";
import { recordMesh, loadManagerInstanceIdentity } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "mgr-restart-fence";
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-mrf-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });

const kids: ChildProcess[] = [];
type MgrPriv = { managerInstanceId: string; serviceServe?: { grant: { epoch: number; instanceId: string } }; goalWriter?: { ctx: ActionContext } };
const bootManager = async (): Promise<InstanceType<typeof Manager>> => {
  const m = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await m.start();
  return m;
};

// A goal owned by a synthetic caller, executor-pinned to the manager instance (the (i) fence key).
const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
const reqFor = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: MANAGER_ENDPOINT, command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);

let mgr: InstanceType<typeof Manager> | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-mrf-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  // ── incarnation 1 (epoch 0) ──
  mgr = await bootManager();
  const M1 = mgr as unknown as MgrPriv;
  const iid1 = M1.managerInstanceId;
  const epoch1 = M1.serviceServe!.grant.epoch;
  check("incarnation 1 registered its persisted instanceId at epoch 0 (a FIRST registration)",
    M1.serviceServe!.grant.instanceId === iid1 && epoch1 === 0, { iid1, epoch1 });
  check("the logical instanceId is persisted on disk (.cotal manager-instance file)",
    loadManagerInstanceIdentity(workspaceRoot, SPACE)?.instanceId === iid1);

  // A goal accepted + terminated by incarnation 1 UNDER epoch 0 (executor-pinned to the instance).
  const gw1 = M1.goalWriter!.ctx;
  const ref1 = goalRefOf(reqFor("g-corpse"), "g-corpse");
  await bindGoal(gw1, ref1, "fp-corpse");
  await createGoal(gw1, ref1, {
    fingerprint: "fp-corpse", command: "spawn", caller: { id: `${caller.owner}.${caller.actor}`, lifecycleUid: caller.uid },
    requestId: "g-corpse", sourceSeq: 0, acceptedAt: 1_000_000, readinessDeadlineMs: 30_000,
    executor: { instanceId: iid1 },
  });
  await commitGoalResult(gw1, { ref: ref1, now: 1_000_001, cause: "complete", state: "failed", data: { by: "corpse-e0" }, executorEpoch: epoch1 });
  check("incarnation 1 (current at epoch 0) sees its own terminal",
    (await readGoalResult(gw1, ref1))?.state === "failed");

  // ── restart: incarnation 2 (same root) ──
  await mgr.stop();
  mgr = await bootManager();
  const M2 = mgr as unknown as MgrPriv;
  const iid2 = M2.managerInstanceId;
  const epoch2 = M2.serviceServe!.grant.epoch;

  check("the restart PRESERVED the logical instanceId (persisted, not a fresh mint)", iid2 === iid1, { iid1, iid2 });
  check("the restart ADVANCED the process epoch through the §13.1 gate (superseding the predecessor)",
    epoch2 > epoch1 && M2.serviceServe!.grant.instanceId === iid1, { epoch1, epoch2 });

  // THE FENCE, driven by a real restart: incarnation 2 resolves its CURRENT epoch, so incarnation 1's
  // OLD-epoch terminal is invisible; the successor's settle under the current epoch is what callers see.
  const gw2 = M2.goalWriter!.ctx;
  check("the predecessor's OLD-epoch terminal is INVISIBLE to the restarted current-epoch reader (the (i) fence)",
    (await readGoalResult(gw2, ref1)) === undefined);
  await commitGoalResult(gw2, { ref: ref1, now: 1_000_002, cause: "complete", state: "succeeded", data: { by: "successor-e1" }, executorEpoch: epoch2 });
  const seen = await readGoalResult(gw2, ref1);
  check("the successor's settle under the CURRENT epoch is what callers see",
    seen?.state === "succeeded" && (seen?.data as { by?: string })?.by === "successor-e1", seen);
} finally {
  await mgr?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "MANAGER RESTART + FENCE SMOKE OK ✅" : "MANAGER RESTART + FENCE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
