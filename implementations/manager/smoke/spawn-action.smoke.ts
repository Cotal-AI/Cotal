/**
 * SPAWN-AS-ACTION smoke (control-surface P2 item 2, slice 2a) — the RED-FIRST gate for
 * "spawn becomes an action". A REAL Manager + JWT broker + REAL agent processes, proving the
 * seven binding 2a musts (the panel's six + the Q2 serve-cred-denied-goal-write negative):
 *
 *   M1 ACCEPT SHAPE      spawn replies with the acceptance {goalId, fingerprint,
 *                        executor{lifecycleUid, epoch}} — NOT the old ~30s blocking reply — and
 *                        goalId === the request id (Q3); the payload carries no secret material (pin 7).
 *   M2 PROGRESS ORDER    the goal's progress events ride the caller-scoped epe subtree in the
 *                        honest order handoff -> launched -> presence.
 *   M3 THREE TERMINALS   presence join -> succeeded (carrying today's reply data); process exit ->
 *                        failed; the readiness window elapsing -> uncertain (durable, reconcilable).
 *   M4 SETTLE RACE       despawn mid-goal vs the readiness window: exactly ONE terminal, first fact wins.
 *   M5 KILL / RECONCILE  a manager killed mid-goal: the successor reconciles the accepted goal under
 *                        the epoch fence (a superseded old executor cannot settle); never dropped.
 *   M6 SAME-ALIAS        two concurrent same-alias submissions: exactly one accepts, the other REFUSES
 *                        loud at the NAME layer (reserve/uniqueName), leaving zero bind + zero process.
 *   M7 WRITER SEPARATION the manager's SERVE credential is broker-DENIED a goal-fact write (the
 *                        dedicated goal-writer profile {@link goalWriterGrants} is a distinct
 *                        connection); pin 2 (foreign caller can't read another's progress) + pin 3
 *                        (a caller can't publish a terminal) ride the same fact/event ACLs.
 *
 * RED-FIRST: against the current BLOCKING spawn (no goal machinery) M1-M5 fail by design — that red
 * IS the slice's first artifact. It goes green as 2a's handler surgery lands. The harness (broker,
 * manager, connectors, callers, follows) must stay green so every red is a MISSING-behavior red.
 *
 * Run: pnpm smoke:manager-spawn-action   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, mintLifecycleUid,
  standaloneConnectOpts, principalKey, probeConnect, DEV_OWNER,
  epCall, EpEnvelopeError, epGoalProgressGrantRow,
  registry,
  type Connector, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");
const dec = new TextDecoder();

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

// ── harness ──────────────────────────────────────────────────────────────────────────────────
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `spawnact-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-spawnact-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["m1", "m2", "m3j", "m3x", "m3w", "m4", "m5", "dup"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

// Connectors driving the three readiness outcomes. `join` is the real presence-joining stub (auth
// mode: it reads its minted creds); `exit`/`stuck` never connect (no creds needed) — they only need
// to exit / hang so the manager's readiness race resolves failed / (window ->) uncertain.
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const joinCon: Connector = { kind: "connector", name: "join", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
const exitCon: Connector = { kind: "connector", name: "exit", requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: "node", args: ["-e", "process.exit(3)"] }) };
const stuckCon: Connector = { kind: "connector", name: "stuck", requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: "node", args: ["-e", "setInterval(()=>{},1<<30)"] }) };
for (const c of [joinCon, exitCon, stuckCon]) registry.register(c);

/** A minted caller instrument: the spawn capability + (item-2 forward-wired) the caller-scoped
 *  goal-progress read row, so it can follow its OWN goals. epCall on the `one` rail with a static
 *  epoch-0 currency (the manager's serve gate is born open@gen0). */
async function instrument(): Promise<{
  caller: EpCaller; nc: NatsConnection; principal: string; violations: () => string[];
  call: (command: string, args?: Record<string, unknown>, target?: { actor: string; lifecycleUid: string; mode?: "owner" | "any" }) => ReturnType<typeof epCall>;
}> {
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", {
    lifecycleUid: uid,
    capabilities: ["spawn"],
    // 2b wires this into the rollup; the smoke mints it explicitly so the caller can follow its goals.
    allowSubscribe: [epGoalProgressGrantRow(space, MANAGER_ENDPOINT, caller)],
    endpointCapabilities: [
      { endpoint: MANAGER_ENDPOINT, command: "spawn" },
      { endpoint: MANAGER_ENDPOINT, command: "despawn", target: { mode: "owner" as const, tOwner: DEV_OWNER } },
    ],
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  const violations = watchViolations(nc);
  const principal = principalKey(DEV_OWNER, id.id).key;
  const call = (command: string, args?: Record<string, unknown>, target?: { actor: string; lifecycleUid: string; mode?: "owner" | "any" }) =>
    epCall(nc, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller,
      ...(args !== undefined ? { args } : {}),
      ...(target ? { target: { mode: target.mode ?? "owner", owner: DEV_OWNER, actor: target.actor, lifecycleUid: target.lifecycleUid } } : {}),
    }, { deadlineMs: 30_000, currentEpoch: async () => 0 });
  return { caller, nc, principal, call, violations };
}

/** The 2a progress-event contract this smoke pins: each event on the goal's epe subtree is
 *  `{ v:1, goalId, phase, ...(phase==="terminal" ? { state, data } : {}) }`. Follow collects the
 *  ordered non-terminal phases and resolves on the terminal event (or a bounded timeout). */
interface ProgressEvent { goalId: string; phase: string; state?: string; data?: unknown }
async function followGoal(nc: NatsConnection, caller: EpCaller, goalId: string, timeoutMs: number): Promise<{ phases: string[]; terminal?: { state: string; data?: unknown } }> {
  const triple = `${caller.owner}.${caller.actor}.${caller.uid}`;
  const subject = `cotal.${space}.epe.${MANAGER_ENDPOINT}.*.*.goal.${triple}.${goalId}.>`;
  const phases: string[] = [];
  let terminal: { state: string; data?: unknown } | undefined;
  // Callback-form subscribe: a permission-denied subscription delivers the error to `err` here
  // rather than throwing out of an async iterator (which would abort the run). Red-first, the
  // manager emits nothing AND the caller-scoped progress read is a 2b-wired grant, so this simply
  // collects no events and the terminal stays undefined.
  return await new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const sub = nc.subscribe(subject, {
      callback: (err, m) => {
        if (err) return;
        let ev: ProgressEvent | undefined;
        try { ev = JSON.parse(dec.decode(m.data)) as ProgressEvent; } catch { return; }
        if (ev.phase === "terminal") { terminal = { state: String(ev.state), data: ev.data }; finish(); return; }
        phases.push(ev.phase);
      },
    });
    const finish = (): void => { clearTimeout(timer); sub.unsubscribe(); resolve({ phases, ...(terminal ? { terminal } : {}) }); };
    timer = setTimeout(finish, timeoutMs);
  });
}

/** Drain a connection's status stream so an async permission-violation is observed rather than
 *  thrown as an unhandled error, AND capture any violation the broker reports (used reader-free by
 *  M7/pin-3: publish a forbidden goal write, then assert the PUBLISHER's own connection was denied). */
function watchViolations(nc: NatsConnection): () => string[] {
  const hits: string[] = [];
  void (async () => {
    try {
      for await (const s of nc.status()) {
        const blob = `${JSON.stringify(s)} ${String((s as { data?: unknown }).data ?? "")} ${String((s as { error?: { message?: string } }).error?.message ?? "")}`;
        if (/permission/i.test(blob)) hits.push(blob);
      }
    } catch { /* connection closed */ }
  })();
  return () => hits;
}

const acceptOf = (r: Awaited<ReturnType<typeof epCall>>): { goalId?: string; fingerprint?: string; executor?: { lifecycleUid?: string; epoch?: number } } =>
  (r.reply.data ?? {}) as { goalId?: string; fingerprint?: string; executor?: { lifecycleUid?: string; epoch?: number } };

const MI = Manager as unknown; void MI;
let mgr: InstanceType<typeof Manager> | undefined;
let A: Awaited<ReturnType<typeof instrument>> | undefined;
let B: Awaited<ReturnType<typeof instrument>> | undefined;
const openConns: NatsConnection[] = [];

try {
  for (let i = 0; i < 60; i++) { if ((await probeConnect(SERVERS, { timeoutMs: 400 })).ok) break; await wait(120); }
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
  const M = mgr as unknown as { readinessTimeoutMs: number; managerLifecycleUid: string; serviceServe?: { creds?: string; grant?: { epoch: number } }; agents: Map<string, { id: string; lifecycleUid: string }> };
  M.readinessTimeoutMs = 1_500; // short window so the red-first (blocking) run and the uncertain terminal are fast
  await mgr.start();

  A = await instrument();
  B = await instrument();

  // ── M1: ACCEPT SHAPE ─────────────────────────────────────────────────────────────────────
  {
    const r = await A.call("spawn", { name: "m1", agent: "join" });
    const d = acceptOf(r);
    check("M1 accept reply is ok", r.reply.ok === true, r.reply);
    check("M1 accept carries a string goalId", typeof d.goalId === "string" && d.goalId.length > 0, d);
    check("M1 goalId === the request id (Q3: goalId = env.id)", d.goalId === r.reply.id, { goalId: d.goalId, id: r.reply.id });
    check("M1 accept carries the accepted-spec fingerprint", typeof d.fingerprint === "string" && (d.fingerprint?.length ?? 0) > 0, d);
    check("M1 accept carries executor {lifecycleUid, epoch}", typeof d.executor?.lifecycleUid === "string" && Number.isSafeInteger(d.executor?.epoch), d.executor);
    check("M1 executor.lifecycleUid is the manager incarnation (epoch fence coordinate)", d.executor?.lifecycleUid === M.managerLifecycleUid, { got: d.executor?.lifecycleUid, mgr: M.managerLifecycleUid });
    check("M1 accept payload is lean — exactly {goalId, fingerprint, executor}, no secret material (pin 7)",
      Object.keys(r.reply.data ?? {}).sort().join(",") === "executor,fingerprint,goalId", Object.keys(r.reply.data ?? {}));
  }

  // ── M2: PROGRESS ORDER ───────────────────────────────────────────────────────────────────
  {
    const r = await A.call("spawn", { name: "m2", agent: "join" });
    const goalId = acceptOf(r).goalId ?? r.reply.id ?? "";
    const f = await followGoal(A.nc, A.caller, goalId, 6_000);
    check("M2 progress rides handoff -> launched -> presence, in order",
      JSON.stringify(f.phases) === JSON.stringify(["handoff", "launched", "presence"]), f.phases);
  }

  // ── M3: THREE TERMINALS ──────────────────────────────────────────────────────────────────
  {
    const rj = await A.call("spawn", { name: "m3j", agent: "join" });
    const fj = await followGoal(A.nc, A.caller, acceptOf(rj).goalId ?? rj.reply.id ?? "", 6_000);
    check("M3 join -> succeeded", fj.terminal?.state === "succeeded", fj.terminal);
    check("M3 succeeded carries today's reply data (name/id/lifecycleUid/mode)",
      !!(fj.terminal?.data as { name?: string; id?: string; lifecycleUid?: string; mode?: string } | undefined)?.lifecycleUid, fj.terminal?.data);

    const rx = await A.call("spawn", { name: "m3x", agent: "exit" });
    const fx = await followGoal(A.nc, A.caller, acceptOf(rx).goalId ?? rx.reply.id ?? "", 6_000);
    check("M3 process exit -> failed", fx.terminal?.state === "failed", fx.terminal);

    const rw = await A.call("spawn", { name: "m3w", agent: "stuck" });
    const fw = await followGoal(A.nc, A.caller, acceptOf(rw).goalId ?? rw.reply.id ?? "", 6_000);
    check("M3 readiness window elapsed -> uncertain (bounded, never success; pin 4)", fw.terminal?.state === "uncertain", fw.terminal);
  }

  // ── M4: SETTLE RACE (despawn mid-goal vs window; first terminal wins) ─────────────────────
  {
    const r = await A.call("spawn", { name: "m4", agent: "stuck" });
    const goalId = acceptOf(r).goalId ?? r.reply.id ?? "";
    // Resolve the spawned agent's target from the managed set (the reconcile coordinate), then cancel it.
    await wait(300);
    const row = M.agents.get("m4");
    if (row) await A.call("despawn", { graceful: false }, { actor: row.id, lifecycleUid: row.lifecycleUid });
    const f = await followGoal(A.nc, A.caller, goalId, 6_000);
    check("M4 despawn mid-goal settles exactly one terminal, cancelled (first fact wins)", f.terminal?.state === "cancelled", { terminal: f.terminal, had: !!row });
  }

  // ── M5: KILL / RECONCILE under the epoch fence ───────────────────────────────────────────
  {
    const r = await A.call("spawn", { name: "m5", agent: "stuck" });
    const goalId = acceptOf(r).goalId ?? r.reply.id ?? "";
    const deadInstance = M.managerLifecycleUid;
    await mgr.stop(); // incarnation dies mid-goal WITHOUT terminalizing
    const mgr2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
    (mgr2 as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 1_500;
    await mgr2.start(); // successor boot reconcile sweeps the orphaned accepted goal
    mgr = mgr2;
    const f = await followGoal(A.nc, A.caller, goalId, 8_000);
    check("M5 successor reconciles the orphaned goal to a terminal (never dropped)", f.terminal !== undefined, f.terminal);
    check("M5 the successor incarnation differs from the dead one (epoch fence has a fresh executor)",
      (mgr as unknown as { managerLifecycleUid: string }).managerLifecycleUid !== deadInstance, { dead: deadInstance });
  }

  // ── M6: CONCURRENT SAME-ALIAS (refuse at the name layer, not the bind) ────────────────────
  {
    const [r1, r2] = await Promise.all([
      A.call("spawn", { name: "dup", agent: "stuck" }),
      A.call("spawn", { name: "dup", agent: "stuck" }),
    ]);
    const accepted = [r1, r2].filter((r) => typeof acceptOf(r).goalId === "string");
    const refused = [r1, r2].filter((r) => r.reply.ok === false);
    check("M6 exactly one same-alias submission accepts (carries a goalId)", accepted.length === 1, [r1.reply, r2.reply]);
    check("M6 the other refuses loud at the NAME layer (reserve/uniqueName, not a bind conflict)",
      refused.length === 1 && !/bind/i.test(String(refused[0]?.reply.error?.message ?? "")), refused.map((r) => r.reply.error));
  }

  // ── M7: WRITER SEPARATION — the serve credential is broker-DENIED a goal-fact write ───────
  {
    const serveCreds = (mgr as unknown as { serviceServe?: { creds?: string } }).serviceServe?.creds;
    check("M7 the manager holds a serve credential to test the boundary with", typeof serveCreds === "string", { has: !!serveCreds });
    const enc2 = new TextEncoder();
    if (typeof serveCreds === "string") {
      // Reader-free enforcement: the SERVE credential PUBLISHES a goal terminal fact on the manager's
      // own endpoint. The serve profile carries no goal write (those ride the dedicated
      // goalWriterGrants connection), so the broker REJECTS the publish and the PUBLISHER's own
      // connection reports the violation. (A no-delivery reader can't distinguish write-denied from
      // read-denied — an ordinary reader also lacks epf goal read — so we assert on the publisher.)
      const goalResultSubj = `cotal.${space}.epf.${MANAGER_ENDPOINT}.goal.${DEV_OWNER}.someactor.someuid.g-forge.result`;
      const sc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: serveCreds }), maxReconnectAttempts: 0 });
      const scViol = watchViolations(sc);
      openConns.push(sc);
      sc.publish(goalResultSubj, enc2.encode(JSON.stringify({ v: 1, goalId: "g-forge" })));
      await sc.flush().catch(() => {});
      await wait(600);
      check("M7 the SERVE credential is broker-denied a goal-fact write (writer separation, Q2)", scViol().some((v) => v.includes("g-forge")), scViol());
    }
    // pin 3: an ordinary CALLER likewise cannot publish a goal terminal (only the manager commits) —
    // same reader-free publisher-violation assertion.
    const callerResultSubj = `cotal.${space}.epf.${MANAGER_ENDPOINT}.goal.${A.caller.owner}.${A.caller.actor}.${A.caller.uid}.g-self.result`;
    A.nc.publish(callerResultSubj, enc2.encode(JSON.stringify({ v: 1, goalId: "g-self" })));
    await A.nc.flush().catch(() => {});
    await wait(500);
    check("M7/pin3 a caller cannot publish a goal terminal (terminal authority is manager-only)", A.violations().some((v) => v.includes("g-self")), A.violations());

    // pin 2 (structural, panel-accepted): the caller-scoped progress row admits ONLY the caller's own
    // goal subtree — a foreign principal's grant cannot match another caller's progress subject.
    const aRow = epGoalProgressGrantRow(space, MANAGER_ENDPOINT, A.caller);
    const bRow = epGoalProgressGrantRow(space, MANAGER_ENDPOINT, B.caller);
    const aGoalSubject = `cotal.${space}.epe.${MANAGER_ENDPOINT}.i.1.goal.${A.caller.owner}.${A.caller.actor}.${A.caller.uid}.g1.progress`;
    const subjMatches = (pattern: string, subj: string): boolean => {
      const ps = pattern.split("."), ss = subj.split(".");
      for (let i = 0; i < ps.length; i++) {
        if (ps[i] === ">") return true;
        if (ps[i] === "*") { if (ss[i] === undefined) return false; continue; }
        if (ps[i] !== ss[i]) return false;
      }
      return ps.length === ss.length;
    };
    check("M7/pin2 the caller's own progress grant matches its own goal subtree", subjMatches(aRow, aGoalSubject), aRow);
    check("M7/pin2 a FOREIGN caller's progress grant does NOT match another caller's goal subtree (structural containment)", subjMatches(bRow, aGoalSubject) === false, { bRow, aGoalSubject });
  }

  console.log(`\nspawn-action 2a smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) console.log("(RED-FIRST: reds above are the un-built 2a behavior — the slice's first artifact.)");
} finally {
  for (const c of openConns) await c.drain().catch(() => c.close());
  await A?.nc.drain().catch(() => A?.nc.close());
  await B?.nc.drain().catch(() => B?.nc.close());
  await mgr?.stop().catch(() => {});
  srv.kill("SIGKILL");
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
