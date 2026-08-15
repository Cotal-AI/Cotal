/**
 * SIBLING-INSTANCE GOAL RACE — a second manager that finds a goal already claimed by a sibling must
 * serve that sibling's acceptance and commit NOTHING.
 *
 * This is the branch #370 guarded by symmetry and could not prove: its duplicate-goal test races one
 * incarnation, so mutating the sibling guard killed no check. The fence is now the single
 * ownership check in `serveSpawnGoal` (an attempt may settle a goal only if it WON the create-only
 * `bindGoal` CAS), and this suite drives the sibling route into it for real: two managers, one
 * space, one request frame delivered to both.
 *
 * Determinism, deliberately. The sibling branch does not need simultaneity, only ORDER: manager B
 * must process the frame while the goal index already carries manager A's instance id. So A is
 * addressed first on the `inst` rail and allowed to finish accepting, then the IDENTICAL body (same
 * `id`, therefore the same goalId, same fingerprint) is published on B's `inst` rail. No queue-group
 * coin flip, and no fault injection into either manager.
 *
 * The spawned agent uses a connector that never joins presence, so A's goal is legitimately still
 * IN FLIGHT with no terminal when B arrives. That is the state a stolen terminal destroys.
 *
 * Run: pnpm smoke:goal-sibling-race   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  probeConnect, newIdentity, mintLifecycleUid, DEV_OWNER, epCall, epRequestSubject, epReplySubject,
  actionContext, readGoalResult, registry,
  type ActionContext, type Connector, type EpCaller, type GoalRef, type LaunchSpec,
} from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { launchEnv } from "@cotal-ai/connector-core";

const dec = new TextDecoder();
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
const SPACE = "goal-sibling";
const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];

// Two managers in one space is two workspace roots (each persists its own logical instanceId), so
// the persona is seeded into both. The goal index they contend over is broker-side and shared.
const mkRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "cotal-sibrace-ws-"));
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(r, ".cotal", "agents", "sib.md"), `---\nname: sib\nrole: worker\n---\n`);
  return r;
};
const rootA = mkRoot();
const rootB = mkRoot();

// Never joins presence: A's goal stays accepted and unterminal for the whole test.
const stuckCon: Connector = {
  kind: "connector", name: "stuck", requires: ["node"],
  buildLaunch: (): LaunchSpec => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1<<30)"], env: launchEnv() }),
};
registry.register(stuckCon);

const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
type MgrPriv = { managerInstanceId: string; readinessTimeoutMs: number; serviceServe?: { grant: { epoch: number } }; agents: Map<string, unknown> };

let mgrA: InstanceType<typeof Manager> | undefined;
let mgrB: InstanceType<typeof Manager> | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-sibrace-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break; await wait(120); }
  for (const r of [rootA, rootB]) recordMesh({ space: SPACE, server: SERVER, root: r, mode: "open", ts: new Date().toISOString() });

  mgrA = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: rootA });
  mgrB = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: rootB });
  // A LONG readiness window on both: the goal must still be in flight when B arrives, so the thing
  // under test is B's behaviour and not a race with the readiness deadline settling it `uncertain`.
  (mgrA as unknown as MgrPriv).readinessTimeoutMs = 60_000;
  (mgrB as unknown as MgrPriv).readinessTimeoutMs = 60_000;
  await mgrA.start();
  await mgrB.start();
  const A = mgrA as unknown as MgrPriv;
  const B = mgrB as unknown as MgrPriv;
  check("two managers coexist with distinct logical instance ids", A.managerInstanceId !== B.managerInstanceId, { a: A.managerInstanceId, b: B.managerInstanceId });

  const callNc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  conns.push(callNc);
  const tapNc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  conns.push(tapNc);
  const readNc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  conns.push(readNc);
  const rctx: ActionContext = await actionContext(readNc, SPACE, { resolveExecutorEpoch: () => A.serviceServe?.grant.epoch ?? 0 });
  const goalRef = (goalId: string): GoalRef => ({ endpoint: MANAGER_ENDPOINT, caller, goalId });

  // Capture the request frame A is about to receive. Replaying real bytes keeps the duplicate a
  // frame the door already admitted rather than one this test invented.
  let captured: { subject: string; body: Uint8Array } | undefined;
  const tap = tapNc.subscribe(`${`cotal.${SPACE}`}.ep.inst.>`, {
    callback: (err, m) => { if (!err && captured === undefined) captured = { subject: m.subject, body: m.data }; },
  });
  await tapNc.flush(); // the tap must be live before the request is published, or nothing is captured

  // ── A accepts on its OWN inst rail; its goal is left in flight ────────────────────────────────
  const rA = await epCall(
    callNc, SPACE, { mode: "inst", instanceId: A.managerInstanceId, epoch: A.serviceServe?.grant.epoch ?? 0 },
    { endpoint: MANAGER_ENDPOINT, command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "sib", agent: "stuck" } },
    { deadlineMs: 30_000 },
  );
  tap.unsubscribe();
  const accA = (rA.reply.data ?? {}) as Record<string, unknown>;
  check("A accepted the goal", rA.reply.ok === true && typeof accA.goalId === "string", rA.reply);
  const goalId = accA.goalId as string;
  const ref = goalRef(goalId);
  check("the goal is IN FLIGHT: accepted, no terminal yet", (await readGoalResult(rctx, ref)) === undefined);
  // POSITIVE CONTROL on the capture: without a frame to replay there is no sibling race below, and
  // every assertion after this would pass by never happening.
  check("A's request frame was captured for replay", captured !== undefined && captured.subject.includes(A.managerInstanceId), captured?.subject);
  if (!captured) throw new Error("no frame captured; the rest of this suite would be vacuous");

  // ── the SAME frame, delivered to B ────────────────────────────────────────────────────────────
  // Same body means the same `id`, so B sees this caller's goalId already in the index under A's
  // instance id: the sibling branch. The nonce is reused so B's reply is addressable.
  const nonce = captured.subject.split(".").pop() as string;
  const bSubject = epRequestSubject(SPACE, {
    route: { mode: "inst", instanceId: B.managerInstanceId },
    endpoint: MANAGER_ENDPOINT, command: "spawn", caller, nonce,
  });
  const bReplySubject = epReplySubject(SPACE, {
    endpoint: MANAGER_ENDPOINT, instanceId: B.managerInstanceId, epoch: B.serviceServe?.grant.epoch ?? 0, caller, nonce,
  });
  let bReply: Record<string, unknown> | undefined;
  const bSub = callNc.subscribe(bReplySubject, {
    callback: (err, m) => { if (!err && bReply === undefined) { try { bReply = JSON.parse(dec.decode(m.data)) as Record<string, unknown>; } catch { /* ignore */ } } },
  });
  await callNc.flush();
  callNc.publish(bSubject, captured.body);
  for (let i = 0; i < 60 && bReply === undefined; i++) await wait(100);
  bSub.unsubscribe();

  // POSITIVE CONTROL on the route: a reply on B's OWN reply subject is proof the frame reached B and
  // B answered it. Without this the terminal assertions below would also pass if B never ran at all.
  check("B received the duplicate frame and answered on its own rail", bReply !== undefined, bReply);
  const bData = (bReply?.data ?? {}) as Record<string, unknown>;
  check("B served A's acceptance (the sibling branch), naming A's allocated agent, not one of its own",
    bReply?.ok === true && bData.goalId === goalId && bData.name === accA.name && bData.uid === accA.uid,
    { b: bData, a: accA });
  check("B provisioned NOTHING for the duplicate (no second agent)", B.agents.size === 0, { bAgents: B.agents.size, aAgents: A.agents.size });

  // ── the property under test ───────────────────────────────────────────────────────────────────
  await wait(600); // a stolen terminal is committed off-handler; give it more time than it needs
  const durable = await readGoalResult(rctx, ref);
  check("B committed NO terminal: the goal is still in flight, owned by A", durable === undefined, durable);
  check("no terminal carries the sibling loser's abort text",
    durable === undefined || !JSON.stringify(durable.data ?? {}).includes("was accepted by instance"), durable);

  console.log(`\ngoal sibling-instance race smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  await mgrB?.stop().catch(() => {});
  await mgrA?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
