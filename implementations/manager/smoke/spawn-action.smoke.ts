/**
 * SPAWN-AS-ACTION smoke (control-surface P2 item 2) — proves the functional musts of "spawn
 * becomes an action" against a REAL open-mesh Manager + broker + REAL agent processes. The
 * caller-scoped progress-read grant is 2b work, so the FUNCTIONAL musts run on an OPEN mesh where a
 * bare connection observes the epe progress subtree freely; the M7 writer-separation + pin-2/3 ACL
 * musts run on the AUTH leg (broker-enforced), added with the must-5 auth wiring.
 *
 *   M1 ACCEPT SHAPE    spawn replies the acceptance floor {name, owner, actor, uid, goalId,
 *                      fingerprint, executor{lifecycleUid, epoch}} — NOT the ~30s blocking reply —
 *                      goalId === the request id (Q3); executor.lifecycleUid is the manager
 *                      incarnation; the payload carries no secret material (pin 7).
 *   M2 PROGRESS ORDER  the goal's progress rides the caller-scoped epe subtree: handoff -> launched
 *                      -> presence, in order; the terminal rides a final `phase:"terminal"` event.
 *   M3 THREE TERMINALS presence join -> succeeded (carrying the spawned identity); process exit ->
 *                      failed; the readiness window elapsing -> uncertain (bounded, never success).
 *   M6 SAME-ALIAS      a hard-pinned (--name/identity override) collision with a live incarnation
 *                      REFUSES at accept (no bind, no process); a persona-derived base name numbers.
 *
 * Run: pnpm smoke:manager-spawn-action   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  probeConnect, newIdentity, mintLifecycleUid, DEV_OWNER, epCall,
  actionContext, readGoalResult, listGoalIndex, recordsBucket,
  registry, type ActionContext, type Connector, type EpCaller, type GoalRef, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { launchEnv } from "@cotal-ai/connector-core"; // dev-only smoke import: the OS env allow-list a real connector supplies

const dec = new TextDecoder();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const awaitExit = (p: ChildProcess, ms = 5000): Promise<void> =>
  new Promise((r) => { if (p.exitCode !== null || p.signalCode !== null) return r(); p.once("exit", () => r()); setTimeout(r, ms).unref?.(); });

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "spawnact-open";
const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-spawnact-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const n of ["a1", "a2", "j1", "x1", "w1", "m4", "dup", "peer", "recon"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
// A ROLE-LESS persona: its succeeded terminal data carries no `role`, which the strict
// canonicalJson would reject if the manager left `role: undefined` on the payload (surfaced live
// by readiness:live; guarded here in smoke:ci).
writeFileSync(join(workspaceRoot, ".cotal", "agents", "norole.md"), `---\nname: norole\n---\n`);

// Inline connectors driving the three readiness outcomes (open mesh — no creds needed). `join` is
// a real child that joins presence under the manager-assigned id (readiness resolves succeeded);
// `exit` exits at once (failed); `stuck` hangs forever (window -> uncertain).
const coreDist = join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js");
const JOIN_CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1<<30);});",
].join("");
// The OS allow-list a real connector supplies, not a bare PATH: a pty (ConPTY) child inherits
// NOTHING but `spec.env`, and on Windows a node child without `SystemRoot` aborts at startup
// before its first line (see connector-core's OS_ENV_ALLOW). With only PATH set, every child here
// died on launch and the suite read it as a readiness failure.
const envJoin = (o: LaunchOpts): Record<string, string> => ({
  ...launchEnv(), CORE_DIST: coreDist,
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVER),
  COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name,
});
const joinCon: Connector = { kind: "connector", name: "join", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: process.execPath, args: ["-e", JOIN_CHILD], env: envJoin(o) }) };
const PATH_ENV = launchEnv(); // same reason as envJoin above
const exitCon: Connector = { kind: "connector", name: "exit", requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: process.execPath, args: ["-e", "process.exit(3)"], env: PATH_ENV }) };
const stuckCon: Connector = { kind: "connector", name: "stuck", requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1<<30)"], env: PATH_ENV }) };
for (const c of [joinCon, exitCon, stuckCon]) registry.register(c);

/** A bare open-mesh caller: epCall on the `one` rail with a synthetic caller triple (open broker
 *  admits it; the goal scopes under this triple). */
const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
let callNc!: NatsConnection;
const callSpawn = (args: Record<string, unknown>) =>
  epCall(callNc, SPACE, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args }, { deadlineMs: 30_000, currentEpoch: async () => 0 });
const callDespawn = (t: { actor: string; lifecycleUid: string }) =>
  epCall(callNc, SPACE, { mode: "one" }, { endpoint: MANAGER_ENDPOINT, command: "despawn", contract: MANAGER_CONTRACTS.despawn, caller, args: { graceful: false }, target: { mode: "owner", owner: DEV_OWNER, actor: t.actor, lifecycleUid: t.lifecycleUid } }, { deadlineMs: 15_000, currentEpoch: async () => 0 });

interface ProgressEvent { goalId: string; phase: string; state?: string; data?: unknown }
// A PERSISTENT collector subscribed to the caller's whole goal subtree BEFORE any spawn, so the
// handoff/launched edges (emitted around the acceptance reply) are never missed by a late follow.
const events = new Map<string, ProgressEvent[]>();
const termWaiters = new Map<string, () => void>();
function startProgressCollector(nc: NatsConnection): void {
  nc.subscribe(`cotal.${SPACE}.epe.${MANAGER_ENDPOINT}.*.*.goal.${caller.owner}.${caller.actor}.${caller.uid}.>`, {
    callback: (err, m) => {
      if (err) return;
      let ev: ProgressEvent | undefined;
      try { ev = JSON.parse(dec.decode(m.data)) as ProgressEvent; } catch { return; }
      const list = events.get(ev.goalId) ?? [];
      list.push(ev);
      events.set(ev.goalId, list);
      if (ev.phase === "terminal") termWaiters.get(ev.goalId)?.();
    },
  });
}
/** Await a goal's terminal (or timeout) and return the ordered non-terminal phases + the terminal. */
async function followGoal(goalId: string, timeoutMs: number): Promise<{ phases: string[]; terminal?: { state: string; data?: unknown } }> {
  await new Promise<void>((resolve) => {
    if (events.get(goalId)?.some((e) => e.phase === "terminal")) return resolve();
    termWaiters.set(goalId, resolve);
    setTimeout(resolve, timeoutMs);
  });
  const list = events.get(goalId) ?? [];
  const term = list.find((e) => e.phase === "terminal");
  return { phases: list.filter((e) => e.phase !== "terminal").map((e) => e.phase), terminal: term ? { state: String(term.state), data: term.data } : undefined };
}

const acc = (r: Awaited<ReturnType<typeof epCall>>) => (r.reply.data ?? {}) as Record<string, unknown>;
let mgr: InstanceType<typeof Manager> | undefined;

try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-spawnact-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 2_000; // short window for a fast uncertain
  await mgr.start();
  // P2 item 3: the goal's executor coordinate is the PERSISTED logical instanceId (the fence key),
  // not the per-process managerLifecycleUid.
  const managerIid = (mgr as unknown as { managerInstanceId: string }).managerInstanceId;

  callNc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  conns.push(callNc);
  const followNc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  conns.push(followNc);
  startProgressCollector(followNc); // subscribe BEFORE any spawn so handoff/launched are captured
  // A read context that OUTLIVES a manager crash (must-5 M5): reads the durable goal result fact +
  // the reconcile index directly off the broker, so the successor's reconcile is observed at the source.
  const readNc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  conns.push(readNc);
  // Reads of an EXECUTOR-PINNED goal terminal (item 3's (i) fence, now in production) resolve the
  // executor's CURRENT epoch. The predecessor serves at epoch 0; after the M5 restart the SAME logical
  // instance re-registers at epoch 1 and the successor settles the orphan there, so the reader tracks
  // the current serving epoch (0 before the restart, the successor's epoch after).
  let readerExecEpoch = 0;
  const rctx: ActionContext = await actionContext(readNc, SPACE, { resolveExecutorEpoch: () => readerExecEpoch });
  const goalRef = (goalId: string): GoalRef => ({ endpoint: MANAGER_ENDPOINT, caller, goalId });
  const idxKv = await new Kvm(readNc).open(recordsBucket(SPACE));

  // ── M1: ACCEPT SHAPE ──────────────────────────────────────────────────────────────────────
  {
    const r = await callSpawn({ name: "a1", agent: "join" });
    const d = acc(r);
    check("M1 accept reply is ok", r.reply.ok === true, r.reply);
    check("M1 accept carries a string goalId", typeof d.goalId === "string" && (d.goalId as string).length > 0, d);
    check("M1 goalId === the request id (Q3: goalId = env.id)", d.goalId === r.reply.id, { goalId: d.goalId, id: r.reply.id });
    check("M1 accept carries the accepted-spec fingerprint", typeof d.fingerprint === "string" && (d.fingerprint as string).length > 0, d);
    const ex = d.executor as { lifecycleUid?: string; epoch?: number } | undefined;
    check("M1 accept carries executor {lifecycleUid, epoch}", typeof ex?.lifecycleUid === "string" && Number.isSafeInteger(ex?.epoch), ex);
    check("M1 executor.lifecycleUid is the manager incarnation (fence coordinate)", ex?.lifecycleUid === managerIid, { got: ex?.lifecycleUid, mgr: managerIid });
    check("M1 accept payload is the floor {name,owner,actor,uid,goalId,fingerprint,executor}, no secret material (pin 7)",
      Object.keys(d).sort().join(",") === "actor,executor,fingerprint,goalId,name,owner,uid", Object.keys(d));
    check("M1 accept names the ALLOCATED identity (name a1, owner DEV_OWNER, uid present)", d.name === "a1" && d.owner === DEV_OWNER && typeof d.uid === "string" && (d.uid as string).length > 0, d);
  }

  // ── M2: PROGRESS ORDER ────────────────────────────────────────────────────────────────────
  {
    const r = await callSpawn({ name: "a2", agent: "join" });
    const f = await followGoal(acc(r).goalId as string, 12_000);
    check("M2 progress rides handoff -> launched -> presence, in order", JSON.stringify(f.phases) === JSON.stringify(["handoff", "launched", "presence"]), f.phases);
    check("M2 the terminal rides a final progress event (succeeded)", f.terminal?.state === "succeeded", f.terminal);
  }

  // ── M3: THREE TERMINALS ───────────────────────────────────────────────────────────────────
  {
    const rj = await callSpawn({ name: "j1", agent: "join" });
    const fj = await followGoal(acc(rj).goalId as string, 12_000);
    check("M3 presence join -> succeeded", fj.terminal?.state === "succeeded", fj.terminal);
    check("M3 succeeded carries the spawned identity (lifecycleUid)", !!(fj.terminal?.data as { lifecycleUid?: string } | undefined)?.lifecycleUid, fj.terminal?.data);

    const rx = await callSpawn({ name: "x1", agent: "exit" });
    const fx = await followGoal(acc(rx).goalId as string, 12_000);
    check("M3 process exit -> failed", fx.terminal?.state === "failed", fx.terminal);

    const rw = await callSpawn({ name: "w1", agent: "stuck" });
    const fw = await followGoal(acc(rw).goalId as string, 12_000);
    check("M3 readiness window elapsed -> uncertain (bounded, never success)", fw.terminal?.state === "uncertain", fw.terminal);

    // A ROLE-LESS spawn: its succeeded terminal data carries no `role`, so the strict-canonicalJson
    // terminal commit must not choke on an `undefined` (the readiness:live repro, guarded in-gate).
    const rr = await callSpawn({ name: "norole", agent: "join" });
    const fr = await followGoal(acc(rr).goalId as string, 12_000);
    check("M3 a ROLE-LESS spawn still commits its succeeded terminal (no undefined role in the payload)", fr.terminal?.state === "succeeded", fr.terminal);
    check("M3 the role-less succeeded terminal carries the identity and omits role", (() => {
      const d = fr.terminal?.data as { lifecycleUid?: string; role?: unknown } | undefined;
      return !!d?.lifecycleUid && d.role === undefined;
    })(), fr.terminal?.data);
  }

  // ── M4: SETTLE RACE - despawn mid-goal drives the cancel terminal (first terminal wins) ──────
  {
    const r = await callSpawn({ name: "m4", agent: "stuck" }); // stuck hangs -> the 2s readiness window
    const acc4 = acc(r);
    await wait(900); // let the agent provision + become managed, still inside the window
    const rD = await callDespawn({ actor: acc4.actor as string, lifecycleUid: acc4.uid as string });
    check("M4 the mid-goal despawn is accepted", rD.reply.ok === true, rD.reply);
    const f = await followGoal(acc4.goalId as string, 12_000);
    check("M4 despawn mid-goal settles the goal CANCELLED (first terminal fact wins vs the readiness window)", f.terminal?.state === "cancelled", f.terminal);
  }

  // ── M6: HARD-PINNED SAME-ALIAS REFUSE (persona-derived numbers) ───────────────────────────
  {
    // Spawn a persona-derived "dup" (no identity override) — it takes the base name.
    const r1 = await callSpawn({ name: "dup", agent: "stuck" });
    check("M6 a persona-derived spawn takes the base name", acc(r1).name === "dup", acc(r1));
    // A HARD-PINNED identity override ("dup") colliding with the live "dup" refuses at accept (no
    // -2 suffix). The persona ref "peer" exists; the identity override pins the wire name to "dup".
    // A refuse surfaces as a {ok:false} error reply (the serve boundary publishes it), never a throw.
    const rHard = await callSpawn({ name: "peer", identity: "dup", agent: "stuck" });
    check("M6 a hard-pinned --name colliding with a live incarnation refuses at accept",
      rHard.reply.ok === false && /hard-pinned/.test(rHard.reply.error?.message ?? ""), rHard.reply);
    // A second persona-derived "dup" numbers to dup-2 (multi-peer preserved).
    const r3 = await callSpawn({ name: "dup", agent: "stuck" });
    check("M6 a second persona-derived spawn numbers (dup-2)", acc(r3).name === "dup-2", acc(r3));
  }

  // ── M5: MANAGER KILL MID-GOAL → the SUCCESSOR reconciles (must-5 Q-B; never drops an accepted goal) ──
  {
    const pollResult = async (ref: GoalRef, ms: number) => {
      for (let i = 0; i * 100 < ms; i++) { const r = await readGoalResult(rctx, ref); if (r) return r; await wait(100); }
      return readGoalResult(rctx, ref);
    };
    const r = await callSpawn({ name: "recon", agent: "stuck" }); // accepts, never joins → stays within the readiness window
    const goalId = acc(r).goalId as string;
    const ref = goalRef(goalId);
    await wait(400); // let it provision + write the durable index (goal accepted, still in-flight)
    check("M5 the inherited goal has no terminal before the crash (accepted, in-flight)", (await readGoalResult(rctx, ref)) === undefined);
    check("M5 the reconcile index carries the in-flight goal", (await listGoalIndex(idxKv, MANAGER_ENDPOINT)).some((g) => g.ref.goalId === goalId), goalId);
    // CRASH: drop the goal-writer FIRST so the graceful shutdown cannot settle the goal (the
    // child-exit's terminal commit then fails on the closed connection) — the goal is orphaned
    // exactly as after a real crash, an accepted goal with no terminal and a live index entry.
    (mgr as unknown as { goalWriter?: { nc: NatsConnection } }).goalWriter?.nc.close();
    await mgr!.stop();
    mgr = undefined;
    await wait(2200); // past the 2s readiness deadline, so the successor's sweep settles uncertain at once
    // The SUCCESSOR: same space + workspace, a FRESH instanceId — its boot reconcile settles the orphan.
    const mgr2 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
    (mgr2 as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 2_000;
    await mgr2.start();
    mgr = mgr2;
    // The successor re-registered the SAME logical instance at an ADVANCED epoch; the reader now
    // resolves that current epoch so it sees the successor's settle (result.<successorEpoch>).
    readerExecEpoch = (mgr2 as unknown as { serviceServe?: { grant?: { epoch?: number } } }).serviceServe?.grant?.epoch ?? 0;
    const successorIid = (mgr2 as unknown as { managerLifecycleUid: string }).managerLifecycleUid;
    check("M5 the successor is a FRESH incarnation (a new process, advanced epoch)", successorIid !== managerIid, { successorIid, managerIid });
    const after = await pollResult(ref, 4_000);
    check("M5 the successor reconciled the inherited goal to a terminal, never dropped (uncertain)", after?.state === "uncertain", after);
    check("M5 the reconcile cleared the index entry (goal terminal)", (await listGoalIndex(idxKv, MANAGER_ENDPOINT)).every((g) => g.ref.goalId !== goalId), goalId);
  }

  console.log(`\nspawn-action open-mesh functional smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  await mgr?.stop().catch(() => {});
  await Promise.all(kids.map((k) => { k.kill("SIGKILL"); return awaitExit(k); }));
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
