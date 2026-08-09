/**
 * MANAGER RESTART + GOAL-TERMINAL SURVIVAL smoke (control-surface P2 item 3, slice 3a) — the P2
 * acceptance line: "manager endpoint restart preserves the logical instance + durable goal handle."
 *
 * RETARGETED. This suite used to assert the opposite of what it asserts now, so the inversion is
 * spelled out rather than left for a reader to infer. It encoded the epoch-scoped terminal subject
 * `…result.<execEpoch>`: the predecessor's terminal was expected to be INVISIBLE to the restarted
 * current-epoch reader, and the successor was expected to write a second terminal that callers
 * would see instead. That mechanism is gone (SPEC:1394 reserves a flat `…result` leaf with no epoch
 * token), and it was not merely non-conformant — it was wrong. The window is "commit the terminal,
 * then die before projecting it", in which the pre-restart fact is the LEGITIMATE outcome of work
 * that really happened, not a corpse's guess. Hiding it lost a real `succeeded` and let a successor
 * contradict it.
 *
 * WHAT IT ASSERTS NOW: a restart neither hides nor overwrites the terminal that was already
 * committed. The pre-restart fact SURVIVES and is exactly what the restarted incarnation reads, and
 * the successor's contradictory second terminal LOSES the create-only CAS and reads back the
 * winner. Attribution is what distinguishes the two commits (SPEC 13.6), not subject scoping.
 *
 * OPEN mesh (evictor-free — pin 2: a bare registration mints no serve family, so a restart needs no
 * delivery daemon). The manager persists its logical instanceId + serve identity under .cotal, so a
 * restart in the SAME workspace root re-registers the SAME instanceId with an ADVANCED processEpoch
 * through the §13.1 gate — which this suite still asserts, because id persistence and epoch advance
 * are 3a's own subject matter.
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

  // A goal ACCEPTED under epoch 0 and terminated by incarnation 1 before it dies. This is the
  // legitimate pre-restart winner: the work really ran and its outcome is already durable.
  const gw1 = M1.goalWriter!.ctx;
  const ref1 = goalRefOf(reqFor("g-pre-restart"), "g-pre-restart");
  await bindGoal(gw1, ref1, "fp-pre-restart");
  await createGoal(gw1, ref1, {
    fingerprint: "fp-pre-restart", command: "spawn", caller: { id: `${caller.owner}.${caller.actor}`, lifecycleUid: caller.uid },
    requestId: "g-pre-restart", sourceSeq: 0, acceptedAt: 1_000_000, readinessDeadlineMs: 30_000,
    acceptedEpoch: epoch1,
  });
  await commitGoalResult(gw1, {
    ref: ref1, now: 1_000_001, cause: "complete", state: "failed",
    data: { by: "pre-restart" }, committer: { instanceId: iid1, epoch: epoch1 },
  });
  check("incarnation 1 sees the terminal it committed under its own accepted epoch",
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

  // THE INVERSION, driven by a real restart. The advanced epoch does not hide the pre-restart fact
  // and does not license overwriting it: one goal has ONE terminal subject, and the first fact won.
  const gw2 = M2.goalWriter!.ctx;
  const survived = await readGoalResult(gw2, ref1);
  check("the pre-restart terminal SURVIVES the restart and is exactly what the restarted incarnation reads",
    survived?.state === "failed" && (survived?.data as { by?: string })?.by === "pre-restart", survived);

  // The successor is a legitimate committer by attribution (committed epoch > accepted epoch = a
  // successor settling inherited work), so nothing REFUSES it on attribution grounds. What stops it
  // is the create-only CAS: the terminal already exists, so it loses and reads back the winner.
  const second = await commitGoalResult(gw2, {
    ref: ref1, now: 1_000_002, cause: "complete", state: "succeeded",
    data: { by: "successor" }, committer: { instanceId: iid1, epoch: epoch2 },
  });
  check("the successor's CONTRADICTORY second terminal loses the create-only CAS and reads back the winner",
    second.won === false && second.fact.state === "failed" && (second.fact.data as { by?: string })?.by === "pre-restart",
    { won: second.won, fact: second.fact });
  const after = await readGoalResult(gw2, ref1);
  check("...and the durable terminal is still the pre-restart one, not the successor's",
    after?.state === "failed" && (after?.data as { by?: string })?.by === "pre-restart", after);
} finally {
  await mgr?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "MANAGER RESTART + TERMINAL SURVIVAL SMOKE OK ✅" : "MANAGER RESTART + TERMINAL SURVIVAL SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
