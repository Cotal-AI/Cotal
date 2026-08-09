/**
 * FULL-STACK AUTH RESTART-SUCCEEDS smoke (control-surface P2 item 3, slice 3c fold) — the deferred
 * "AUTH mesh + delivery daemon restart SUCCEEDS" assertion the manager-service smoke could only
 * cover as its LOUD no-daemon refusal.
 *
 * A REAL JWT-auth broker (system account) + a live delivery-admin eviction responder (the delivery
 * daemon's `evictPrincipal` op, served in-process here via the SAME core primitive the daemon uses:
 * `evictDeniedPrincipalWithCreds` over the two scoped $SYS creds). A Manager registers, accepts +
 * terminates a goal under epoch 0, then RESTARTS in the same workspace root. On an AUTH mesh the
 * registration barrier's PHASE 2 must VERIFY-EVICT the superseded serve family before the epoch
 * advances — so the restart drives the manager → `ctl.delivery-admin` → real eviction chain end to
 * end and SUCCEEDS: same logical instanceId, an ADVANCED process epoch, and the predecessor's
 * old-epoch goal terminal FENCED (invisible to the current-epoch reader; the (i) fence), with the
 * successor's settle under the current epoch what callers see.
 *
 * Run: pnpm smoke:manager-restart-live   (needs nats-server + node on PATH; boots its own JWT broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, DEV_OWNER,
  mintMembershipObserverCreds, mintConnectionEvictorCreds, evictDeniedPrincipalWithCreds,
  CotalEndpoint, CONTROL_DELIVERY_ADMIN,
  bindGoal, createGoal, commitGoalResult, readGoalResult, goalRefOf,
  type ActionContext, type EpCaller, type ParsedEpRequest, type ControlReply,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `mgrrestart-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), "cotal-mgrrestart-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));

// The two scoped $SYS creds (mintable ONLY from the fresh auth's in-memory system seed) that the
// delivery daemon's eviction executor rides — minted NOW, exactly as `cotal up` provisions them.
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());

const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
const reqFor = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: MANAGER_ENDPOINT, command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);

type MgrPriv = { managerInstanceId: string; serviceServe?: { grant: { epoch: number; instanceId: string } }; goalWriter?: { ctx: ActionContext } };
const kids: ReturnType<typeof spawn>[] = [];
let mgr: InstanceType<typeof Manager> | undefined;
let daemon: CotalEndpoint | undefined;
try {
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(srv);
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space: SPACE, server: SERVERS, root: workspaceRoot, mode: "auth", ts: new Date().toISOString() });

  // ── the delivery-admin eviction responder (the daemon's evictPrincipal op, in-process) ──
  const dlvId = newIdentity();
  daemon = new CotalEndpoint({
    space: SPACE, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  daemon.on("error", () => {});
  await daemon.start();
  let evictCalls = 0;
  daemon.serveControl(CONTROL_DELIVERY_ADMIN, async (req): Promise<ControlReply> => {
    if (req.op !== "evictPrincipal") return { ok: false, error: `unsupported delivery-admin op "${req.op}"` };
    evictCalls++;
    const principal = String((req.args as { principal?: unknown })?.principal ?? "");
    const result = await evictDeniedPrincipalWithCreds({ servers: SERVERS, observerCreds, evictorCreds, accountId: auth.account.pub, principal });
    return { ok: true, data: result };
  }, { boundReply: true });

  // ── incarnation 1 (epoch 0) ──
  mgr = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot });
  await mgr.start();
  const M1 = mgr as unknown as MgrPriv;
  const iid1 = M1.managerInstanceId;
  const epoch1 = M1.serviceServe!.grant.epoch;
  check("incarnation 1 registered its persisted instanceId at epoch 0 (a FIRST registration on AUTH)",
    M1.serviceServe!.grant.instanceId === iid1 && epoch1 === 0, { iid1, epoch1 });

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
  check("incarnation 1 (current at epoch 0) sees its own terminal", (await readGoalResult(gw1, ref1))?.state === "failed");

  // ── the AUTH restart: PHASE-2 verify-evicts the superseded serve family via the delivery daemon ──
  await mgr.stop();
  mgr = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot });
  await mgr.start(); // this SUCCEEDS only because the delivery-admin eviction responder answered
  const M2 = mgr as unknown as MgrPriv;
  const iid2 = M2.managerInstanceId;
  const epoch2 = M2.serviceServe!.grant.epoch;

  check("the AUTH restart SUCCEEDED — it drove the delivery-admin eviction responder", evictCalls >= 1, { evictCalls });
  check("the restart PRESERVED the logical instanceId (persisted, not a fresh mint)", iid2 === iid1, { iid1, iid2 });
  check("the restart ADVANCED the process epoch through the §13.1 gate (superseding the predecessor)",
    epoch2 > epoch1 && M2.serviceServe!.grant.instanceId === iid1, { epoch1, epoch2 });

  // THE FENCE on a real AUTH+daemon restart: incarnation 2 resolves its CURRENT epoch, so incarnation
  // 1's OLD-epoch terminal is invisible; the successor's settle under the current epoch is what wins.
  const gw2 = M2.goalWriter!.ctx;
  check("the predecessor's OLD-epoch terminal is INVISIBLE to the restarted current-epoch reader (the (i) fence)",
    (await readGoalResult(gw2, ref1)) === undefined);
  await commitGoalResult(gw2, { ref: ref1, now: 1_000_002, cause: "complete", state: "succeeded", data: { by: "successor" }, executorEpoch: epoch2 });
  const seen = await readGoalResult(gw2, ref1);
  check("the successor's settle under the CURRENT epoch is what callers see",
    seen?.state === "succeeded" && (seen?.data as { by?: string })?.by === "successor", seen);
} finally {
  await mgr?.stop().catch(() => {});
  await daemon?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

console.log(`\n${fail === 0 ? "AUTH RESTART-SUCCEEDS (full-stack) SMOKE OK ✅" : "AUTH RESTART-SUCCEEDS SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
