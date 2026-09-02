/**
 * cotal-lang `spawn` against the REAL manager — the fidelity leg mesh-spawn cannot carry.
 *
 * The runtime's own suite (`smoke:runtime-mesh-spawn`) proves the caller contract against a
 * manager-SHAPED endpoint it serves itself, because implementations never import each other. What
 * that cannot prove is fidelity to the shipped manager: that the mesh handler's generic resolve
 * fetches and recompiles the manager's REAL registered contracts, that its args mapping satisfies
 * the REAL spawn input schema, that the acceptance and terminal the real manager commits carry
 * what the handler reads, and that the discharge's owner-mode despawn releases a REAL seat. This
 * suite is the composition root's ride: a real broker, a real in-process `Manager`, a real agent
 * child that joins presence, and the real `MeshHandler` driving it all through a driven program.
 *
 *   1  a driven program spawns a REAL seat: the run completes, the handle pins the incarnation
 *      the manager allocated, and the seat is live on `ps`.
 *   2  a losing race branch's REAL seat is released by the driver's own sweep — the winner's is
 *      not touched.
 *   3  spawn→conclave flow-through: the handle a REAL spawn minted resolves through the seat's
 *      own presence row, a membership row is written for exactly that incarnation, and the close
 *      tombstones it and deletes the minted channel's registry row.
 *   4  monitor + wait(down) flow-through: a run parks on a REAL seat's down-event, the manager
 *      tears the seat down mid-run, its presence lapses, and the died branch wins the race.
 *   5  turn flow-through: a run's turn is relayed through the REAL manager, the suite plays the
 *      seat's own side (`turn-pending` / `turn-yield` under the seat's self reach), and the yield
 *      resumes the run; an unanswered turn is caught in-program as L4003 while the manager's own
 *      hold-expiry deny converges the goal on the plane.
 *
 * Throwaway everything: own open nats-server on a free port, scratch COTAL_HOME + workspace root.
 * Needs nats-server + node on PATH. Run: pnpm smoke:lang-spawn-live
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Seat-env hygiene BEFORE any cotal import: whatever runs this suite may itself be a managed
// session whose COTAL_* names a live mesh; nothing may leak into the rig or its children.
const home = mkdtempSync(join(tmpdir(), "cotal-langspawn-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { connect } = await import("@nats-io/transport-node");
const { jetstream, jetstreamManager } = await import("@nats-io/jetstream");
const {
  probeConnect, registry, DEV_OWNER, openRecordsBucket,
  timerWriterContext, timerWriterConsumerConfig, timerWriterDurable, armCheckpointTimer,
  eptReqStreamName, replayRunJournal, newTakeoverId, resolveService, invokeCommand,
  setupSpaceStreams, openMembersRegistry, openChannelRegistry, listMembers, readChannelConfig,
  actionContext, readGoalResult,
} = await import("@cotal-ai/core");
type LaunchOptsT = import("@cotal-ai/core").LaunchOpts;
type LaunchSpecT = import("@cotal-ai/core").LaunchSpec;
type ConnectorT = import("@cotal-ai/core").Connector;
type EpCallerT = import("@cotal-ai/core").EpCaller;
// The lang entry, structurally (bin does not depend on @cotal-ai/lang): only the fields read here.
interface JournalEntryT { kind: string; state: string; status?: string; result?: unknown; closed?: boolean; external?: Record<string, unknown>; error?: { code?: string; kind?: string }; requestId?: string }
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
const { MeshHandler, EpfSettleWatcher, startRun } = await import("@cotal-ai/runtime");
const { launchEnv } = await import("@cotal-ai/connector-core"); // the OS env allow-list a real connector supplies

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "langspawn";
const CALLER: EpCallerT = { owner: DEV_OWNER, actor: "wf_langspawn", uid: "b".repeat(26) };
const kids: ChildProcess[] = [];

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-langspawn-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
// The persona pins the harness (`agent: join`): the lang `spawn` sends no harness of its own, so
// this is exactly how a workflow-spawned seat picks its connector in production.
for (const n of ["wf1", "wf2", "wf3", "wf4", "wf5", "wf6"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\nagent: join\n---\n`);

// A real agent child: joins presence under the manager-assigned id, then parks. Readiness
// resolves `succeeded` off its presence join — a REAL process, not a scripted verdict.
const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
const JOIN_CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1<<30);});",
].join("");
const envJoin = (o: LaunchOptsT): Record<string, string> => ({
  ...launchEnv(), CORE_DIST: coreDist,
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVER),
  COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name,
});
const joinCon: ConnectorT = { kind: "connector", name: "join", requires: ["node"], buildLaunch: (o): LaunchSpecT => ({ command: process.execPath, args: ["-e", JOIN_CHILD], env: envJoin(o) }) };
registry.register(joinCon);

let mgr: InstanceType<typeof Manager> | undefined;
let rc = 1;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-langspawn-js-"))], { stdio: "ignore" });
  kids.push(broker);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = (await probeConnect(SERVER, { timeoutMs: 400 })).ok; if (!up) await wait(120); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  // The real `cotal up` seed: pre-creates the presence/channel/members registries a conclave
  // opens (the handler never self-provisions a bucket).
  await setupSpaceStreams({ servers: SERVER, space: SPACE });
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  const nc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, SPACE);

  // The timer pump the delivery daemon would host on a live mesh (the race leg sleeps).
  await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
  const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
  const wctx = await timerWriterContext(nc, SPACE);
  const pumpState = { over: false };
  const pump = (async () => {
    while (!pumpState.over) {
      for await (const m of await writerC.fetch({ max_messages: 4, expires: 1_200 })) {
        await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
        m.ack();
      }
    }
  })();

  const mk = (runId: string) => new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: "manager", runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: { id: "cli-run", lifecycleUid: "u_langspawn" }, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(js, jsm, SPACE, 3_000),
    () => Date.now(),
  );
  const lease = (() => { let n = 0; return () => ({ holder: "m1", epoch: 1, fencingToken: (n += 1), takeoverId: newTakeoverId() }); })();
  const entriesOf = async (runId: string, kind: string): Promise<JournalEntryT[]> => {
    const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
    return back.records
      .map((r) => r.record)
      .filter((r) => r.kind === "step")
      .map((r) => (r as { entry: unknown }).entry as JournalEntryT)
      .filter((e) => e.kind === kind);
  };
  // The same generic resolve the handler itself performs — here it doubles as the suite's own
  // read surface, so `ps` is read through the manager's real registered contract too.
  const service = await resolveService(nc, SPACE, "manager", CALLER);
  const psNames = async (): Promise<string[]> => {
    const r = await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000, currentEpoch: async () => 0 });
    return ((r.reply.data ?? []) as Array<{ name?: unknown }>).map((row) => String(row.name));
  };

  // ── 1) a driven program spawns a REAL seat ──────────────────────────────────────────────────
  {
    console.log("• 1 — a driven program spawns a real seat through the real manager");
    const out = await startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-1", lease: lease(),
      source: `const d = await spawn("wf1");\nlog("agent", d.agent);`,
      handler: mk("ls-1"),
    });
    c("the run completes through the real accept and the real readiness terminal",
      out.status === "completed", JSON.stringify(out));
    const settled = (await entriesOf("ls-1", "spawn")).find((e) => e.state === "settled");
    const value = settled?.result as { agent?: string; persona?: string } | undefined;
    c("the settled entry records a handle for the manager-allocated seat",
      settled?.status === "ok" && typeof value?.agent === "string" && value.agent.startsWith("wf1#"), value?.agent);
    c("the handle carries the persona", value?.persona === "wf1", value?.persona);
    const names = await psNames();
    c("the seat is LIVE on the manager's own ps", names.includes("wf1"), names);
  }

  // ── 2) a losing race branch's real seat is released by the driver's sweep ───────────────────
  {
    console.log("• 2 — a losing race branch's real seat is released by the driver's sweep");
    const source = `
const out = await race({
  seat: async () => {
    const d = await spawn("wf2");
    await sleep("10m");
    return d.agent;
  },
  fast: async () => {
    await sleep("3s");
    return "fast";
  },
}, { name: "r" });
log("winner", out.index);
`;
    const out = await startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-2", lease: lease(),
      source, handler: mk("ls-2"),
    });
    c("the racing run completes", out.status === "completed", JSON.stringify(out));
    const scope = (await entriesOf("ls-2", "race")).find((e) => e.state === "settled");
    const winner = ((scope?.result as { value?: { index?: unknown } } | undefined)?.value)?.index;
    c("the fast branch wins while the seat branch parks", winner === "fast", JSON.stringify(scope?.result)?.slice(0, 90));
    const names = await psNames();
    c("the loser's REAL seat is gone: the driver's sweep despawned it through the real manager",
      !names.includes("wf2"), names);
    c("and the winner-unrelated seat from the first run was not touched", names.includes("wf1"), names);
  }

  // ── 3) spawn→conclave flow-through: a REAL seat's presence resolves its membership ──────────
  {
    console.log("• 3 — a conclave joins a real seat off its own presence, and releases it");
    const source = `
const d = await spawn("wf3");
const r = await conclave([d], async (room) => { log("room", room.channel); return room.channel; }, { name: "standup" });
log("done", r);
`;
    const out = await startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-3", lease: lease(),
      source, handler: mk("ls-3"),
    });
    c("the conclave run completes", out.status === "completed", JSON.stringify(out));
    const spawnEntry = (await entriesOf("ls-3", "spawn")).find((e) => e.state === "settled");
    const handle = String((spawnEntry?.result as { agent?: unknown } | undefined)?.agent ?? "");
    const uid = handle.slice(handle.lastIndexOf("#") + 1);
    const entries = await entriesOf("ls-3", "conclave");
    const settled = entries.find((e) => e.state === "settled");
    c("the conclave entry settles ok with the closed fact", settled?.status === "ok" && settled?.closed === true,
      { status: settled?.status, closed: settled?.closed });
    const plan = entries.filter((e) => e.state === "pending").at(-1)?.external as
      { channel?: string; members?: Array<{ uid?: string; principal?: string }> } | undefined;
    c("the plan pinned the REAL seat's incarnation, resolved from its own presence row",
      plan?.members?.length === 1 && plan.members[0]?.uid === uid && uid.length >= 26,
      JSON.stringify(plan));
    const rows = await listMembers(await openMembersRegistry(nc, SPACE), { channel: plan?.channel ?? "" });
    c("one membership row was written for the seat and tombstoned by the close",
      rows.length === 1 && rows[0]?.lifecycleUid === uid && rows[0]?.leaveCursor !== undefined
        && rows[0]?.owner === plan?.members?.[0]?.principal,
      JSON.stringify(rows));
    c("the minted channel's registry row is gone after the close",
      (await readChannelConfig(await openChannelRegistry(nc, SPACE), plan?.channel ?? "")) === undefined);
  }

  // ── 4) monitor + wait(down) flow-through: a REAL seat's death observed off its own presence ─
  {
    console.log("• 4 — a real seat dies mid-run and the down-wait observes the lapse");
    const source = `
const d = await spawn("wf4");
await monitor(d, { name: "watch" });
const r = await race({
  died: () => wait(down(d), { name: "died" }),
  work: () => sleep("10m", { name: "work" }),
}, { name: "scope" });
log("outcome", r.index);
`;
    const drv = startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-4", lease: lease(),
      source, handler: mk("ls-4"),
    }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 140) }));
    // Park first: the death must be observed by a wait that BEGAN while the seat was alive —
    // tearing the seat down before the park would prove only the immediate-down path the runtime
    // suite already owns.
    let parked = false;
    const until = Date.now() + 30_000;
    while (!parked && Date.now() < until) {
      parked = (await entriesOf("ls-4", "wait")).some((e) => e.state === "pending");
      if (!parked) await wait(400);
    }
    c("the run parks on the down-wait while the real seat is alive", parked);
    // The spawn's bound acceptance floor is the despawn address — the same identity the
    // discharge despawns by. A hard (non-graceful) teardown is the crash this pair exists for.
    const floor = (await entriesOf("ls-4", "spawn")).find((e) => e.external !== undefined)?.external as
      { owner?: string; actor?: string; uid?: string } | undefined;
    c("the spawn bound the acceptance floor the teardown addresses",
      typeof floor?.owner === "string" && typeof floor?.actor === "string" && typeof floor?.uid === "string",
      JSON.stringify(floor));
    const reply = await invokeCommand(nc, SPACE, service, "despawn", { graceful: false }, {
      target: { mode: "owner", owner: floor?.owner ?? "", actor: floor?.actor ?? "", lifecycleUid: floor?.uid ?? "" },
      deadlineMs: 20_000,
    });
    c("the real manager tore the seat down", reply.reply.ok === true, JSON.stringify(reply.reply));
    const out = await Promise.race([drv, wait(45_000).then(() => undefined)]);
    c("the died branch ends the run once the presence row lapses",
      (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
    const settledWait = (await entriesOf("ls-4", "wait")).find((e) => e.state === "settled");
    const downV = settledWait?.result as { agent?: string; reason?: string; at?: number } | undefined;
    const spawnV = (await entriesOf("ls-4", "spawn")).find((e) => e.state === "settled")?.result as { agent?: string } | undefined;
    c("the down value names the seat's own incarnation, lapsed",
      downV?.agent !== undefined && downV.agent === spawnV?.agent && downV?.reason === "lapsed",
      JSON.stringify({ down: downV, spawned: spawnV?.agent }));
  }

  // ── 5) turn flow-through: the REAL relay carries a yield, and a deadline denies ─────────────
  {
    console.log("• 5 — a real turn is relayed, pulled and yielded; an unanswered one denies at its deadline");
    // Leg A: the yield. The suite plays the SEAT's side over the real self-reach commands — the
    // same two calls a connector's intake makes.
    const drv = startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-5", lease: lease(),
      source: `const d = await spawn("wf5");
const r = await turn(d, { name: "poke", deadline: "2m" });
log("turned", r.status, r.note);`,
      handler: mk("ls-5"),
    }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 140) }));
    let turnEntry: JournalEntryT | undefined;
    {
      const until = Date.now() + 30_000;
      while (turnEntry === undefined && Date.now() < until) {
        turnEntry = (await entriesOf("ls-5", "turn")).find((e) => e.state === "pending" && e.external !== undefined);
        if (turnEntry === undefined) await wait(400);
      }
    }
    c("the run parks on the relayed turn once the REAL manager accepts it",
      typeof turnEntry?.external?.goalId === "string", JSON.stringify(turnEntry?.external));
    // The seat's own reach: the spawn's acceptance floor IS the caller `turn-pending` rides.
    const floor = (await entriesOf("ls-5", "spawn")).find((e) => e.external !== undefined)?.external as
      { owner?: string; actor?: string; uid?: string } | undefined;
    const seatCaller: EpCallerT = { owner: String(floor?.owner), actor: String(floor?.actor), uid: String(floor?.uid) };
    const seatService = await resolveService(nc, SPACE, "manager", seatCaller);
    let pulled: { goalId?: string; payload?: string } | undefined;
    {
      const until = Date.now() + 20_000;
      while (pulled === undefined && Date.now() < until) {
        const r = await invokeCommand(nc, SPACE, seatService, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 });
        const turns = ((r.reply.data as { turns?: unknown[] } | undefined)?.turns ?? []) as Array<{ goalId?: string; payload?: string }>;
        if (turns.length > 0) pulled = turns[0];
        else await wait(500);
      }
    }
    c("the seat pulls the relayed turn under its own self reach",
      pulled?.goalId !== undefined && pulled.goalId === turnEntry?.external?.goalId, JSON.stringify(pulled)?.slice(0, 120));
    const payload = pulled?.payload !== undefined
      ? JSON.parse(pulled.payload) as { run?: unknown; context?: unknown } : undefined;
    c("the pulled payload names the run and carries its rendered context",
      payload?.run === "ls-5" && typeof payload?.context === "string", JSON.stringify(payload)?.slice(0, 120));
    const y = await invokeCommand(nc, SPACE, seatService, "turn-yield",
      { goalId: pulled?.goalId ?? "", status: "done", note: "built it" }, { target: { mode: "self" }, deadlineMs: 20_000 });
    c("the real manager accepts the yield and completes the goal with the seat's live currency",
      y.reply.ok === true && (y.reply.data as { state?: unknown } | undefined)?.state === "succeeded", JSON.stringify(y.reply));
    const out = await Promise.race([drv, wait(45_000).then(() => undefined)]);
    c("the yield resumes the run", (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
    const turnV = (await entriesOf("ls-5", "turn")).find((e) => e.state === "settled")?.result as
      { status?: string; note?: string } | undefined;
    c("the journal records the yield the seat gave", turnV?.status === "done" && turnV?.note === "built it", JSON.stringify(turnV));

    // Leg B: the deadline. Nobody yields; the client's own pause is the run's L4003, and the
    // manager's hold-expiry deny is the goal's terminal on the plane — poll for BOTH.
    const drv2 = startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-6", lease: lease(),
      source: `const d = await spawn("wf6");
try {
  await turn(d, { name: "poke", deadline: "6s" });
  log("reached", true);
} catch (e) {
  log("caught", e.code);
}`,
      handler: mk("ls-6"),
    }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 140) }));
    const out2 = await Promise.race([drv2, wait(60_000).then(() => undefined)]);
    c("the unanswered turn is caught in-program and the run completes",
      (out2 as { status?: string } | undefined)?.status === "completed", JSON.stringify(out2));
    const expired = (await entriesOf("ls-6", "turn")).find((e) => e.state === "settled");
    c("the entry settles as the deadline-elapsed L4003",
      expired?.status === "failed" && expired?.error?.code === "L4003" && expired?.error?.kind === "turn-deadline",
      JSON.stringify(expired?.error));
    const goalId = String(expired?.external?.goalId ?? "");
    const actx = await actionContext(nc, SPACE);
    let fact: { state?: string; data?: unknown } | undefined;
    {
      const until = Date.now() + 30_000;
      while (fact === undefined && Date.now() < until) {
        fact = await readGoalResult(actx, { endpoint: "manager", caller: CALLER, goalId });
        if (fact === undefined) await wait(1_000);
      }
    }
    c("the REAL manager's hold-expiry deny converges the goal: failed, reason turn-deadline",
      fact?.state === "failed" && (fact?.data as { reason?: unknown } | undefined)?.reason === "turn-deadline", JSON.stringify(fact));
  }

  // ── 5c) two turns on one seat are serialized at the dispatch (cotal-lang 6.5) ──────────────
  // The language serializes its OWN two turns on one handle at the dispatch (a second `turn` on a
  // handle begins when the first settles), so the manager's half is witnessed with a second turn
  // SUBMITTED OUTSIDE the language's dispatch, under the same run caller (the manager's turn reach
  // is the spawner's own: nobody else may turn this seat), while this run's turn is pending.
  {
    console.log("• 5c — two turns on one seat reach it one at a time, in dispatch order");
    const drv3 = startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-5c", lease: lease(),
      source: `const d = await spawn("wf5");
const r = await turn(d, { name: "t1", deadline: "2m" });
log("t1", r.status);`,
      handler: mk("ls-5c"),
    }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 140) }));
    let first3: JournalEntryT | undefined;
    {
      const until = Date.now() + 30_000;
      while (first3 === undefined && Date.now() < until) {
        first3 = (await entriesOf("ls-5c", "turn")).find((e) => e.state === "pending" && typeof e.external?.goalId === "string");
        if (first3 === undefined) await wait(400);
      }
    }
    const firstId = String(first3?.external?.goalId ?? "");
    const floor3 = (await entriesOf("ls-5c", "spawn")).find((e) => e.external !== undefined)?.external as
      { owner?: string; actor?: string; uid?: string } | undefined;
    const otherSvc = await resolveService(nc, SPACE, "manager", CALLER);
    const secondId = "second5c".repeat(6).slice(0, 43);
    const accepted = await invokeCommand(nc, SPACE, otherSvc, "turn",
      { payload: JSON.stringify({ run: "other", step: "/turn:x#0", context: "", noticeIds: [] }), deadlineMs: 120_000 },
      { id: secondId, deadlineMs: 20_000, target: { mode: "owner", owner: String(floor3?.owner), actor: String(floor3?.actor), lifecycleUid: String(floor3?.uid) } });
    c("a second turn on the same seat, submitted outside the language's dispatch, is accepted while the run's turn is pending",
      firstId.length > 0 && accepted.reply.ok === true && (accepted.reply.data as { goalId?: unknown } | undefined)?.goalId === secondId, JSON.stringify(accepted.reply).slice(0, 160));
    const seat3: EpCallerT = { owner: String(floor3?.owner), actor: String(floor3?.actor), uid: String(floor3?.uid) };
    const svc3 = await resolveService(nc, SPACE, "manager", seat3);
    const pull = async (): Promise<Array<{ goalId?: string }>> => {
      const r = await invokeCommand(nc, SPACE, svc3, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 });
      return ((r.reply.data as { turns?: unknown[] } | undefined)?.turns ?? []) as Array<{ goalId?: string }>;
    };
    let shown = await pull();
    c("the seat is shown exactly one of them", shown.length === 1 && shown[0]?.goalId === firstId, JSON.stringify(shown).slice(0, 160));
    await invokeCommand(nc, SPACE, svc3, "turn-yield", { goalId: firstId, status: "done" }, { target: { mode: "self" }, deadlineMs: 20_000 });
    {
      const until = Date.now() + 20_000;
      shown = await pull();
      while (!(shown.length === 1 && shown[0]?.goalId === secondId) && Date.now() < until) { await wait(400); shown = await pull(); }
    }
    c("the other surfaces only once the first has settled", shown.length === 1 && shown[0]?.goalId === secondId, JSON.stringify(shown).slice(0, 160));
    await invokeCommand(nc, SPACE, svc3, "turn-yield", { goalId: secondId, status: "done" }, { target: { mode: "self" }, deadlineMs: 20_000 });
    const out3 = await Promise.race([drv3, wait(45_000).then(() => undefined)]);
    c("the yield resumes the run", (out3 as { status?: string } | undefined)?.status === "completed", JSON.stringify(out3));
  }

  // ── 5d) a handoff to a name the run never spawned is the run's own L4005, through the relay ──
  {
    console.log("• 5d — a seat yielding a handoff to a stranger: the manager relays it, the run refuses it as L4005");
    const drv4 = startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-5d", lease: lease(),
      source: `const d = await spawn("wf5");
try {
  await turn(d, { name: "h", deadline: "2m" });
  log("reached", true);
} catch (e) {
  log("caught", e.code);
}`,
      handler: mk("ls-5d"),
    }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 140) }));
    let pending4: JournalEntryT | undefined;
    {
      const until = Date.now() + 30_000;
      while (pending4 === undefined && Date.now() < until) {
        pending4 = (await entriesOf("ls-5d", "turn")).find((e) => e.state === "pending" && typeof e.external?.goalId === "string");
        if (pending4 === undefined) await wait(400);
      }
    }
    const floor4 = (await entriesOf("ls-5d", "spawn")).find((e) => e.external !== undefined)?.external as
      { owner?: string; actor?: string; uid?: string } | undefined;
    const seat4: EpCallerT = { owner: String(floor4?.owner), actor: String(floor4?.actor), uid: String(floor4?.uid) };
    const svc4 = await resolveService(nc, SPACE, "manager", seat4);
    const y4 = await invokeCommand(nc, SPACE, svc4, "turn-yield",
      { goalId: String(pending4?.external?.goalId ?? ""), status: "handoff", to: "stranger" }, { target: { mode: "self" }, deadlineMs: 20_000 });
    c("the REAL manager relays the handoff yield as the goal's succeeded terminal (the roster is the run's to check)",
      y4.reply.ok === true && (y4.reply.data as { state?: unknown } | undefined)?.state === "succeeded", JSON.stringify(y4.reply));
    const out4 = await Promise.race([drv4, wait(45_000).then(() => undefined)]);
    const refused4 = (await entriesOf("ls-5d", "turn")).find((e) => e.state === "settled");
    c("the run refuses the addressee it never spawned as the catchable L4005 and completes in-program",
      (out4 as { status?: string } | undefined)?.status === "completed" && refused4?.status === "failed" && refused4?.error?.code === "L4005",
      JSON.stringify({ run: (out4 as { status?: string } | undefined)?.status, error: refused4?.error }));
  }

  pumpState.over = true;
  await pump;
  await nc.drain().catch(() => undefined);
  const EXPECTED_CELLS = 33;
  if (pass + fail !== EXPECTED_CELLS) {
    console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    fail += 1;
  }
  rc = fail === 0 ? 0 : 1;
} finally {
  try { await mgr?.stop(); } catch { /* teardown */ }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log(`lang-spawn-live.smoke: ${pass} passed, ${fail} failed`);
process.exit(rc);
