/**
 * `once` on spawn, on an AUTH mesh: a real JWT broker, the real Manager on the pty runtime, the
 * delivery-hosted timer writer, and stub seats that join presence under the credential the manager
 * minted. The seat's side of the relay (pull, yield, the unconfirmed report) runs under that seat's
 * OWN credential, so the broker grades every grant the feature needs.
 *
 * A once spawn's prompt is its one task, relayed as a turn the spawner can read with `goal-result`.
 * The suite checks that the task is the only thing the seat is handed, that every way the task ends
 * stops the seat, and that every way the seat ends first settles the task.
 *
 * Run: pnpm smoke:spawn-once   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, digestIdToken, epCall, invokeCommand, resolveService, readAcceptedRow, readGoalResult, readGoalIndex, registry,
  type AgentHandle, type Connector, type EpCaller, type IssuedCaller, type LaunchOpts, type LaunchSpec, type OnceSeat, type Runtime,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, agentLifecycleSecretFilePaths, workspaceSecretStore } from "@cotal-ai/workspace";
import "@cotal-ai/connector-claude-code";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { hostTimerWriter, type HostedTimerWriter } from "./_timer-writer.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};
type Reply = { ok?: boolean; code?: string; data?: Record<string, unknown>; error?: { message?: string } };
const asValue = (e: unknown): Reply => ({ ok: false, code: (e as { code?: string }).code, error: { message: String((e as Error).message).slice(0, 400) } });
const errorText = (r: unknown): string => String((r as { error?: { message?: string } | string }).error && typeof (r as { error?: unknown }).error === "object"
  ? (r as { error: { message?: string } }).error.message : (r as { error?: string }).error);

const space = `once-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-spawn-once-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "helper.md"), "---\nname: helper\nrole: worker\n---\n");

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? broker.servers), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
// What each launch was handed as its kickoff prompt, by seat name.
const kickoffs = new Map<string, string | undefined>();
const relayStub: Connector = {
  kind: "connector", name: "once-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true,
  buildLaunch: (o): LaunchSpec => { kickoffs.set(o.name, o.prompt); return { command: "node", args: [STUB], env: envFor(o) }; },
};
// Joins presence only after a delay, so a deadline can elapse before the readiness verdict.
const lateStub: Connector = {
  kind: "connector", name: "once-late-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true,
  buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["--input-type=module", "-e", `setTimeout(() => import(${JSON.stringify(STUB)}), 12000)`], env: envFor(o) }),
};
// Never joins presence: its readiness window elapses.
const silentStub: Connector = {
  kind: "connector", name: "once-silent-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true, readinessTimeoutMs: 3_000,
  buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["-e", "setInterval(() => {}, 1 << 30)"], env: envFor(o) }),
};
// A harness that cannot be woken while idle, so it declares no relay.
const noRelayStub: Connector = {
  kind: "connector", name: "once-norelay-stub", requires: ["node"], supportsPrompt: true, turnRelayRefusal: "it cannot be woken while idle",
  buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }),
};
// Launches nothing outside its seat, but answers retireAfterExit as a connector that does would:
// it cannot prove its first seat's processes gone the first time it is asked.
const retireCalls: Array<{ seat: OnceSeat; indexed: boolean; ended: boolean }> = [];
const discarded: string[] = [];
const launchedOnce = new Map<string, boolean | undefined>();
let retireRefusals = 1;
/** What the task's records showed when the connector was asked: its index entry, and its terminal. */
let probe: (() => Promise<{ indexed: boolean; ended: boolean }>) | undefined;
const retireStub: Connector = {
  kind: "connector", name: "once-retire-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true,
  buildLaunch: (o): LaunchSpec => { launchedOnce.set(o.name, o.once); return { command: "node", args: [STUB], env: envFor(o) }; },
  async retireAfterExit(seat) {
    retireCalls.push({ seat, ...((await probe?.()) ?? { indexed: false, ended: false }) });
    if (retireRefusals-- > 0) throw new Error("its launched tree is still running");
    return { discard: async () => { discarded.push(seat.lifecycleUid); } };
  },
};
// Never joins, takes four seconds to exit after a SIGTERM, and answers retireAfterExit as a connector
// that launches outside its seat: it refuses its first proof.
const slowRetireCalls: Array<{ seat: OnceSeat; seatRunning: boolean; indexed: boolean }> = [];
let slowRetireRefusals = 1;
/** Whether the slow seat's own process was still running when its connector was asked. */
let slowSeatRunning: (() => boolean) | undefined;
const slowRetireStub: Connector = {
  kind: "connector", name: "once-slow-retire-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true, readinessTimeoutMs: 3_000,
  buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 4000)); setInterval(() => {}, 1 << 30)"], env: envFor(o) }),
  async retireAfterExit(seat) {
    slowRetireCalls.push({ seat, seatRunning: slowSeatRunning?.() ?? true, indexed: (await probe?.())?.indexed ?? false });
    if (slowRetireRefusals-- > 0) throw new Error("its launched tree is still running");
    return { discard: async () => { discarded.push(seat.lifecycleUid); } };
  },
};
// Needs a confirmed startup, as Claude does. Its child paints a prompt and, on the prompt's Enter,
// its input screen with the notice (`confirmed`) or without it (`silent`); `ready` paints the input
// screen with no prompt. Each then joins as the stub, two seconds in.
let startupMode: "confirmed" | "silent" | "ready" = "confirmed";
const startupChild = (mode: string): string => `
const show = (text) => process.stdout.write("\\x1b[2J\\x1b[H" + text + "\\r\\n");
const join = () => { process.stdin.pause(); setTimeout(() => import(${JSON.stringify(pathToFileURL(STUB).href)}), 2000); };
if (${JSON.stringify(mode)} === "ready") { show("input ready"); join(); }
else {
  show("LOAD THE CHANNEL\\r\\nEnter to confirm");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once("data", () => { show(${JSON.stringify(mode)} === "confirmed" ? "THE CHANNEL IS LIVE\\r\\ninput ready" : "input ready"); join(); });
}`;
const confirmStub: Connector = {
  kind: "connector", name: "once-confirm-stub", requires: ["node"], supportsPrompt: true, supportsTurnRelay: true,
  onceNeedsConfirmed: "its startup did not show the channel",
  buildLaunch: (o): LaunchSpec => ({
    command: "node", args: ["--input-type=module", "-e", startupChild(startupMode)], env: envFor(o),
    confirm: "LOAD THE CHANNEL", confirmNotice: "THE CHANNEL IS LIVE", confirmReady: ["input ready"],
  }),
};
for (const c of [relayStub, lateStub, silentStub, noRelayStub, retireStub, slowRetireStub, confirmStub]) registry.register(c);

let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let writer: HostedTimerWriter | undefined;
let writerNc: Awaited<ReturnType<typeof connect>> | undefined;
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
const seatConns: Awaited<ReturnType<typeof connect>>[] = [];

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  writerNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
  writer = await hostTimerWriter(writerNc, space, { pollMs: 1_000 });

  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  type Seat = { id: string; lifecycleUid: string; handle: AgentHandle; issued?: { generation: string; acceptedToken: string } };
  const M = manager as unknown as { agents: Map<string, Seat>; reserved: Map<string, string> };

  // The spawner: a caller that may spawn and turn seats, exactly as a run's instrument connects.
  const runnerId = newIdentity();
  const runner: EpCaller = { owner: DEV_OWNER, actor: runnerId.id, uid: mintLifecycleUid() };
  runnerNc = await connect({
    servers: broker.servers,
    ...standaloneConnectOpts({ creds: await mintCreds(auth, runnerId, "control-caller-admin", { lifecycleUid: runner.uid }), tls: false }),
    maxReconnectAttempts: 0,
  });
  const call = (command: string, args: Record<string, unknown> | undefined, opts: { id?: string; target?: { actor: string; lifecycleUid: string; mode?: "owner" | "any" } } = {}) =>
    epCall(runnerNc!, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(opts.target ? { target: { mode: opts.target.mode ?? "owner", owner: DEV_OWNER, actor: opts.target.actor, lifecycleUid: opts.target.lifecycleUid } } : {}),
    }, { deadlineMs: 15_000, currentEpoch: async () => 0 }).then((r) => r.reply as Reply, asValue);
  const actx = (manager as unknown as { goalWriter: { ctx: Parameters<typeof readGoalResult>[0] } }).goalWriter.ctx;
  const refOf = (goalId: string) => ({ endpoint: MANAGER_ENDPOINT, caller: runner, goalId });
  const resultOf = async (goalId: string, ms: number) => {
    const until = Date.now() + ms;
    for (;;) {
      const fact = await readGoalResult(actx, refOf(goalId));
      if (fact !== undefined || Date.now() >= until) return fact;
      await wait(250);
    }
  };
  const until = async (cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    for (;;) {
      if (await cond()) return true;
      if (Date.now() >= end) return false;
      await wait(250);
    }
  };
  let goalSeq = 0;
  const goalId = (tag: string) => `${tag}-${goalSeq++}`.padEnd(43, "x");
  /** A once spawn's task goal id: derived from the spawn's own goal id. */
  const taskOf = (spawnId: string) => digestIdToken(`${spawnId}:once`);
  /** A once spawn followed to its readiness terminal, with its seat captured while it runs. */
  const spawnOnce = async (args: Record<string, unknown>, id = goalId("spawn")) => {
    const accepted = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, ...args }, { id });
    const name = accepted.data?.name as string | undefined;
    const seat = name !== undefined && await until(() => M.agents.has(name), 15_000) ? M.agents.get(name) : undefined;
    const terminal = await resultOf(id, 60_000);
    const data = terminal?.data as { once?: { goalId: string; deadlineAt?: number } } | undefined;
    return { id, accepted, terminal, name, once: data?.once, seat };
  };
  /** The seat's own credential and its manager service, as the seat's connector holds them. */
  const seatSide = async (name: string, seat: Seat) => {
    const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: readFileSync(agentLifecycleSecretFilePaths(workspaceRoot, space, name, seat.lifecycleUid).creds, "utf8"), tls: false }), maxReconnectAttempts: 0 });
    seatConns.push(nc);
    const ref = await readAcceptedRow(nc, space, seat.issued!.acceptedToken);
    const triple: EpCaller = { owner: DEV_OWNER, actor: seat.id, uid: seat.lifecycleUid, generation: ref.generation } as IssuedCaller;
    const service = await resolveService(nc, space, MANAGER_ENDPOINT, triple);
    const invoke = (command: string, args?: Record<string, unknown>) =>
      invokeCommand(nc, space, service, command, args, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply as Reply, asValue);
    const pull = async () => ((await invoke("turn-pending")).data?.turns ?? []) as Array<{ goalId: string; payload: string; acceptedAt: number; deadlineAt?: number; once?: true }>;
    return { invoke, pull };
  };
  /** The seat is gone: its process exited and its slot was freed. */
  const gone = (name: string, handle: AgentHandle) => until(() => handle.status() === "exited" && M.agents.get(name)?.handle !== handle, 20_000);
  /** The task's index entry, the seat's debt, is dropped once the seat's exit is proved. */
  const debtCleared = (id: string) => until(async () => (await readGoalIndex(actx, refOf(id))) === undefined, 20_000);

  console.log("1. refusals before anything is allocated");
  const seatsBefore = M.agents.size;
  const noPrompt = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, once: {} }, { id: goalId("np") });
  check("a once spawn with no prompt is refused: the prompt is the task", noPrompt.ok === false && /needs a prompt/.test(errorText(noPrompt)), noPrompt);
  const badDeadlines = await Promise.all([0, -2, 1.5, "1h", Number.MAX_SAFE_INTEGER].map((deadlineMs) =>
    call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, prompt: "x", once: { deadlineMs } }, { id: goalId("bd") })));
  check("a deadline that is neither -1 nor a positive whole number of ms ending inside the scheduler's range is refused",
    badDeadlines.every((r) => r.ok === false), badDeadlines.map(errorText));
  const noRelay = await call("spawn", { name: "helper", agent: "once-norelay-stub", cwd: repoRoot, events: false, prompt: "x", once: {} }, { id: goalId("nr") });
  check("a connector without the turn relay is refused, with its own reason",
    noRelay.ok === false && /once-norelay-stub connector cannot take a once task: it cannot be woken while idle/.test(errorText(noRelay)), noRelay);
  // The admission check the spawn door runs, on the real Claude registration and on stubs.
  const refusal = (c: Connector, runtime: Partial<Runtime> & { kind: string }, once: { deadlineMs?: number }, prompt = "x") =>
    (manager as unknown as { onceRefusal(c: Connector, r: object, l: Record<string, unknown>, s: undefined, h: object): string | undefined })
      .onceRefusal(c, runtime, { prompt, once }, undefined, { onOnce: () => undefined });
  const claude = registry.resolve<Connector>("connector", "claude");
  const claudeOnCustody = refusal(claude, { kind: "custody" }, {});
  check("a Claude seat on a runtime that does not report how its startup ended is refused, naming the runtime",
    claudeOnCustody === `once: runtime "custody" does not report how a seat's startup ended, which a once seat on the claude connector needs`, claudeOnCustody);
  const claudeOnPty = refusal(claude, { kind: "pty", reportsStartupOutcome: true }, {});
  check("...and admitted on one that does", claudeOnPty === undefined, claudeOnPty);
  // The connector's turn frame: the refusal names what the task renders to, so the limit can be set
  // to that size and one under it, with and without a deadline.
  const framed = (limit: number): Connector => ({ ...relayStub, name: "once-frame-stub", turnFrameLimit: limit });
  const fits = [{}, { deadlineMs: 60_000 }].map((once) => {
    const size = Number(/renders to (\d+) characters, over 1\)$/.exec(refusal(framed(1), { kind: "pty" }, once, "y".repeat(500)) ?? "")?.[1]);
    return { once, size, exact: refusal(framed(size), { kind: "pty" }, once, "y".repeat(500)), over: refusal(framed(size - 1), { kind: "pty" }, once, "y".repeat(500)) };
  });
  check("a task that renders to the connector's turn frame exactly is admitted, with and without a deadline",
    fits.every((f) => f.size > 500 && f.exact === undefined) && fits[1]!.size > fits[0]!.size, fits);
  check("...and one character over it is refused, naming both sizes",
    fits.every((f) => f.over === `once: the prompt is too long for one once-frame-stub turn (the task renders to ${f.size} characters, over ${f.size - 1})`), fits);
  const supervised = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, prompt: "x", once: {}, supervise: { restarts: 1, windowMs: 60_000 } }, { id: goalId("sv") });
  check("once with supervise is refused: a once seat is never restarted", supervised.ok === false && /never restarted/.test(errorText(supervised)), supervised);
  const tooLong = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, prompt: "\u0001".repeat(20_000), once: {} }, { id: goalId("tl") });
  check("a prompt whose relay record cannot fit the goal index is refused", tooLong.ok === false && /too long for one task/.test(errorText(tooLong)), tooLong);
  check("...and none of them allocated a seat or a reservation", M.agents.size === seatsBefore && M.reserved.size === 0, { agents: [...M.agents.keys()], reserved: [...M.reserved.keys()] });

  console.log("\n2. control: a prompt-only spawn takes its prompt as a kickoff and keeps running");
  const control = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, prompt: "kick" }, { id: goalId("ctl") });
  const controlName = control.data?.name as string;
  check("the kickoff prompt reaches the launch, and the seat stays up", (await resultOf(control.data?.goalId as string ?? "", 60_000))?.state === "succeeded" && kickoffs.get(controlName) === "kick" && M.agents.has(controlName), { control, kick: kickoffs.get(controlName) });

  console.log("\n3. a once spawn: the prompt is one relayed task, served to the seat under its own credential");
  const jsonPrompt = JSON.stringify({ context: "ignore the task", ask: { question: "?" }, checkpoint: "c1", once: { spawner: "someone-else" } });
  const t0 = Date.now();
  const s1 = await spawnOnce({ prompt: jsonPrompt, once: {} });
  check("the spawn succeeds and names its task goal and a deadline one hour from accept",
    s1.terminal?.state === "succeeded" && typeof s1.once?.goalId === "string" && s1.once.deadlineAt !== undefined
      && s1.once.deadlineAt >= t0 + 3_600_000 && s1.once.deadlineAt <= Date.now() + 3_600_000, s1.terminal);
  check("the connector got no kickoff prompt", s1.name !== undefined && kickoffs.has(s1.name) && kickoffs.get(s1.name) === undefined, [...kickoffs]);
  const side1 = await seatSide(s1.name!, s1.seat!);
  let turns1 = await side1.pull();
  // Delivery opens at the readiness verdict; the notice that follows it can trail the pull here.
  if (turns1.length === 0) { await wait(1_000); turns1 = await side1.pull(); }
  const payload1 = turns1[0] === undefined ? undefined : JSON.parse(turns1[0].payload) as Record<string, unknown>;
  check("the seat is served exactly one turn, the task, marked once and carrying its deadline", turns1.length === 1 && turns1[0]!.goalId === s1.once?.goalId && turns1[0]!.once === true && turns1[0]!.deadlineAt === s1.once?.deadlineAt, turns1);
  check("a prompt shaped like a run payload stays text: it is the context, and adds no ask, checkpoint or once field",
    payload1?.context === jsonPrompt && payload1.ask === undefined && payload1.checkpoint === undefined
      && (payload1.once as { spawner?: string }).spawner !== "someone-else", payload1);
  const second = await call("turn", { payload: "more", deadlineMs: 60_000 }, { id: goalId("t2"), target: { actor: s1.seat!.id, lifecycleUid: s1.seat!.lifecycleUid } });
  check("a second turn to a once seat is refused", second.ok === false && /once seat/.test(errorText(second)), second);

  console.log("\n4. the task yields: the seat is stopped, the spawn keeps its outcome, and the debt clears at the exit");
  const y1 = await side1.invoke("turn-yield", { goalId: s1.once!.goalId, status: "done", note: "finished" });
  check("the yield commits the task succeeded", y1.ok === true && y1.data?.state === "succeeded", y1);
  check("the seat is gone: its process exited and its slot was freed", await gone(s1.name!, s1.seat!.handle));
  check("the task's index entry is dropped once the exit is proved", await debtCleared(s1.once!.goalId));
  check("the spawn goal keeps its succeeded outcome: the once stop never cancels it", (await readGoalResult(actx, refOf(s1.id)))?.state === "succeeded");
  const read1 = await call("goal-result", { goalId: s1.once!.goalId });
  check("the spawner reads the task's outcome with goal-result", read1.ok === true && (read1.data as { result?: { state?: string } } | undefined)?.result?.state === "succeeded", read1);

  console.log("\n5. the deadline: a task nobody yields fails `turn-deadline` and its seat is stopped");
  const s2 = await spawnOnce({ prompt: "never answered", once: { deadlineMs: 4_000 } });
  check("the short-deadline once spawn succeeds", s2.terminal?.state === "succeeded" && s2.once?.deadlineAt !== undefined, s2.terminal);
  const denied = await resultOf(s2.once!.goalId, 30_000);
  check("the task's terminal is the deadline deny", denied?.state === "failed" && (denied.data as { reason?: string }).reason === "turn-deadline", denied);
  check("...and the seat is gone at its deadline", await gone(s2.name!, s2.seat!.handle));
  check("...and its debt clears at the exit", await debtCleared(s2.once!.goalId));

  console.log("\n6. no deadline (-1): no expiry, until the spawner's despawn ends it");
  const s3 = await spawnOnce({ prompt: "open-ended", once: { deadlineMs: -1 } });
  check("the spawn result names the task and no deadline", s3.terminal?.state === "succeeded" && s3.once !== undefined && s3.once.deadlineAt === undefined, s3.terminal);
  const side3 = await seatSide(s3.name!, s3.seat!);
  await wait(6_500); // past a turn sweep
  const turns3 = await side3.pull();
  check("the task is still served after a sweep, with no deadline on its row", turns3.length === 1 && turns3[0]!.deadlineAt === undefined, turns3);
  const d3 = await call("despawn", {}, { target: { actor: s3.seat!.id, lifecycleUid: s3.seat!.lifecycleUid, mode: "any" } });
  const cancelled3 = await resultOf(s3.once!.goalId, 20_000);
  check("a despawn ends it: the task is cancelled `despawned` at the proved exit",
    d3.ok === true && cancelled3?.state === "cancelled" && (cancelled3.data as { reason?: string }).reason === "despawned", { d3, cancelled3 });
  check("...and the seat is gone and its debt cleared", await gone(s3.name!, s3.seat!.handle) && await debtCleared(s3.once!.goalId));

  console.log("\n7. the seat dies before it yields: the task is cancelled at the exit, with and without a deadline");
  for (const deadlineMs of [600_000, -1]) {
    const s = await spawnOnce({ prompt: "doomed", once: { deadlineMs } });
    process.kill(s.seat!.handle.pid!, "SIGKILL");
    const r = await resultOf(s.once!.goalId, 20_000);
    check(`deadline ${deadlineMs}: the task is cancelled \`seat-exited\` and nothing restarts the seat`,
      r?.state === "cancelled" && (r.data as { reason?: string }).reason === "seat-exited" && await gone(s.name!, s.seat!.handle) && !M.agents.has(s.name!), r);
  }

  console.log("\n8. the seat reports an unconfirmed handoff: the task fails and the seat is stopped");
  const s4 = await spawnOnce({ prompt: "maybe delivered", once: {} });
  const side4 = await seatSide(s4.name!, s4.seat!);
  const u4 = await side4.invoke("turn-unconfirmed", { goalId: s4.once!.goalId });
  const r4 = await readGoalResult(actx, refOf(s4.once!.goalId));
  check("the report commits the task failed `delivery-unconfirmed`", u4.ok === true && u4.data?.state === "failed" && (r4?.data as { reason?: string } | undefined)?.reason === "delivery-unconfirmed", { u4, r4 });
  check("...and the reporting seat is gone", await gone(s4.name!, s4.seat!.handle));
  const u4b = await side4.invoke("turn-unconfirmed", { goalId: s4.once!.goalId });
  check("a report from the stopped seat's credential changes nothing: that credential is retiring", u4b.ok === false && /retiring/.test(errorText(u4b)) && (await readGoalResult(actx, refOf(s4.once!.goalId)))?.state === "failed", u4b);
  const controlSeat = M.agents.get(controlName)!;
  const runTurn = goalId("run");
  await call("turn", { payload: "a run turn", deadlineMs: 60_000 }, { id: runTurn, target: { actor: controlSeat.id, lifecycleUid: controlSeat.lifecycleUid } });
  const controlSide = await seatSide(controlName, controlSeat);
  const uRun = await controlSide.invoke("turn-unconfirmed", { goalId: runTurn });
  check("a report for a run's turn is refused: a run turn is offered again", uRun.ok === false && /run's turn/.test(errorText(uRun)), uRun);
  const uForeign = await controlSide.invoke("turn-unconfirmed", { goalId: s1.once!.goalId });
  check("a report from another seat's credential finds no task", uForeign.ok === false, uForeign);

  console.log("\n9. a once seat that never joins: spawn uncertain, task cancelled, seat stopped");
  const s5 = await spawnOnce({ agent: "once-silent-stub", prompt: "never seen", once: {} });
  check("the spawn ends uncertain", s5.terminal?.state === "uncertain", s5.terminal);
  const r5 = await resultOf(taskOf(s5.id), 10_000);
  check("...its task, never served, is cancelled `readiness-timeout`", r5?.state === "cancelled" && (r5.data as { reason?: string }).reason === "readiness-timeout", r5);
  check("...and the seat is stopped, never left running with nothing to do", s5.seat !== undefined && await gone(s5.name!, s5.seat.handle), s5.name);

  console.log("\n10. a deadline shorter than readiness: the task fails at its deadline and the stop is deliberate");
  const s6 = await spawnOnce({ agent: "once-late-stub", prompt: "too slow", once: { deadlineMs: 1_500 } });
  const r6 = await resultOf(taskOf(s6.id), 10_000);
  check("the task fails at its deadline", r6?.state === "failed" && (r6.data as { reason?: string }).reason === "turn-deadline", r6);
  check("...the spawn is cancelled, as a deliberate stop mid-launch is", s6.terminal?.state === "cancelled", s6.terminal);
  check("...and the slow seat is gone", s6.seat !== undefined && await gone(s6.name!, s6.seat.handle));

  console.log("\n11. the original spawn retried after a lost reply: one allocation, one task");
  const rid = goalId("retry");
  const first = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, prompt: "once only", once: {} }, { id: rid });
  const retried = await call("spawn", { name: "helper", agent: "once-stub", cwd: repoRoot, events: false, prompt: "once only", once: {} }, { id: rid });
  check("the retry is served the same acceptance", first.ok === true && retried.ok === true && first.data?.name === retried.data?.name, { first, retried });
  const rTerm = await resultOf(rid, 60_000);
  const rOnce = (rTerm?.data as { once?: { goalId: string } } | undefined)?.once;
  const rSeat = M.agents.get(first.data?.name as string);
  const rSide = rSeat === undefined ? undefined : await seatSide(first.data?.name as string, rSeat);
  const rTurns = rSide === undefined ? [] : await rSide.pull();
  check("...one seat holds one task", rOnce !== undefined && rTurns.length === 1 && rTurns[0]!.goalId === rOnce.goalId && [...M.agents.keys()].filter((n) => n === first.data?.name).length === 1, { rTurns, rOnce });
  if (rSeat) await call("despawn", {}, { target: { actor: rSeat.id, lifecycleUid: rSeat.lifecycleUid, mode: "any" } });

  console.log("\n12. a connector that launches outside its seat: the debt clears only on its proof that the launch is gone");
  const s7 = await spawnOnce({ agent: "once-retire-stub", prompt: "leaves a tree", once: {} });
  const side7 = await seatSide(s7.name!, s7.seat!);
  const probeOf = (goal: string) => async () => ({ indexed: (await readGoalIndex(actx, refOf(goal))) !== undefined, ended: (await readGoalResult(actx, refOf(goal))) !== undefined });
  probe = probeOf(s7.once!.goalId);
  check("the launch is told it is a once seat, so it can record what it launches", launchedOnce.get(s7.name!) === true, [...launchedOnce]);
  await side7.invoke("turn-yield", { goalId: s7.once!.goalId, status: "done" });
  check("the yield stops the seat", await gone(s7.name!, s7.seat!.handle));
  await until(() => retireCalls.length >= 1, 10_000);
  check("its exit asks the connector, naming the seat it launched",
    retireCalls[0]?.seat.name === s7.name && retireCalls[0]?.seat.lifecycleUid === s7.seat!.lifecycleUid && retireCalls[0]?.seat.space === space && retireCalls[0]?.seat.workspaceRoot === workspaceRoot, retireCalls);
  await wait(1_000);
  check("a refused proof keeps the debt", retireCalls.length === 1 && (await readGoalIndex(actx, refOf(s7.once!.goalId))) !== undefined);
  check("...and the turn sweep asks again, and the debt clears on the proof", await debtCleared(s7.once!.goalId) && retireCalls.length === 2 && retireCalls[1]!.indexed, retireCalls.length);
  check("...after which the proof's receipt is discarded", await until(() => discarded.includes(s7.seat!.lifecycleUid), 5_000));
  const s8 = await spawnOnce({ agent: "once-retire-stub", prompt: "dies first", once: {} });
  probe = probeOf(s8.once!.goalId);
  process.kill(s8.seat!.handle.pid!, "SIGKILL");
  const r8 = await resultOf(s8.once!.goalId, 20_000);
  check("a seat that dies first: its task is cancelled only once the connector proved the launch gone",
    r8?.state === "cancelled" && retireCalls.at(-1)?.seat.lifecycleUid === s8.seat!.lifecycleUid && retireCalls.at(-1)?.ended === false
      && await debtCleared(s8.once!.goalId), { r8, calls: retireCalls });

  console.log("\n13. a stop never waits on a goal write, and a seat's debt never clears before its exit and its proof");
  // With `stall`, the next goal write the manager makes waits until released, as a stalled
  // publication would. With `refuse`, every goal write is refused until the gate is lifted.
  const G = manager as unknown as { assertGoalWriterEpochCurrent(epoch: number): Promise<void> };
  const realAssert = G.assertGoalWriterEpochCurrent.bind(manager);
  let gate: { mode: "stall" | "refuse"; hit: boolean; release?: () => void } | undefined;
  G.assertGoalWriterEpochCurrent = async (epoch: number) => {
    const g = gate;
    if (g !== undefined && (!g.hit || g.mode === "refuse")) {
      g.hit = true;
      if (g.mode === "refuse") throw new Error("injected: this goal write was refused");
      await new Promise<void>((resolve) => { g.release = resolve; });
    }
    return realAssert(epoch);
  };
  const stallId = goalId("stall");
  const s9name = (await call("spawn", { name: "helper", agent: "once-silent-stub", cwd: repoRoot, events: false, prompt: "never seen", once: { deadlineMs: -1 } }, { id: stallId })).data?.name as string | undefined;
  const stall: { mode: "stall"; hit: boolean; release?: () => void } = { mode: "stall", hit: false };
  gate = stall;
  const s9 = s9name !== undefined && await until(() => M.agents.has(s9name), 15_000) ? M.agents.get(s9name) : undefined;
  check("a seat that never joins is stopped while its spawn's terminal cannot be published",
    s9 !== undefined && await gone(s9name!, s9.handle) && stall.hit && (await readGoalResult(actx, refOf(stallId))) === undefined, { hit: stall.hit, s9name });
  stall.release?.();
  gate = undefined;
  const stallTerm = await resultOf(stallId, 20_000);
  check("...and the spawn's own terminal lands once the write goes through", stallTerm?.state === "uncertain", stallTerm);

  const s10 = await spawnOnce({ prompt: "never answered", once: { deadlineMs: 3_000 } });
  // No goal write lands until the seat is seen gone, so a retried write's success cannot be what stops it.
  gate = { mode: "refuse", hit: false };
  check("a refused deadline write still stops the seat at its deadline", s10.seat !== undefined && await gone(s10.name!, s10.seat.handle) && gate.hit);
  gate = undefined;
  const r10 = await resultOf(s10.once!.goalId, 20_000);
  check("...and the deadline terminal is written again while the manager runs",
    r10?.state === "failed" && (r10.data as { reason?: string }).reason === "turn-deadline" && await debtCleared(s10.once!.goalId), r10);

  const slowId = goalId("slow");
  const slowName = (await call("spawn", { name: "helper", agent: "once-slow-retire-stub", cwd: repoRoot, events: false, prompt: "never seen", once: { deadlineMs: -1 } }, { id: slowId })).data?.name as string | undefined;
  const slowSeat = slowName !== undefined && await until(() => M.agents.has(slowName), 15_000) ? M.agents.get(slowName) : undefined;
  slowSeatRunning = () => slowSeat?.handle.status() !== "exited";
  const slowTask = taskOf(slowId);
  probe = probeOf(slowTask);
  const rSlow = await resultOf(slowTask, 15_000);
  const heldAtCancel = (await readGoalIndex(actx, refOf(slowTask))) !== undefined;
  check("a seat that never joins: its task is cancelled at once, and its debt is kept while its process still runs",
    rSlow?.state === "cancelled" && (rSlow.data as { reason?: string }).reason === "readiness-timeout" && heldAtCancel && slowSeatRunning() && slowRetireCalls.length === 0,
    { rSlow, heldAtCancel, calls: slowRetireCalls.length });
  await until(() => slowRetireCalls.length >= 1, 20_000);
  check("...its connector is asked only after the exit, and a refused proof keeps the debt",
    slowRetireCalls[0]?.seatRunning === false && slowRetireCalls[0]?.seat.lifecycleUid === slowSeat?.lifecycleUid && slowRetireCalls[0]?.indexed === true, slowRetireCalls);
  check("...and the debt clears on its proof, which is then discarded",
    await debtCleared(slowTask) && slowRetireCalls.length === 2 && await until(() => discarded.includes(slowSeat!.lifecycleUid), 5_000), slowRetireCalls.length);

  console.log("\n14. a connector that needs a confirmed startup: its task is served only after the prompt and its notice");
  const errorOf = (t: { data?: unknown } | undefined) => String((t?.data as { error?: string } | undefined)?.error);
  const reasonOf = (t: { data?: unknown } | undefined) => (t?.data as { reason?: string } | undefined)?.reason;
  const opened: string[] = [];
  const O = manager as unknown as { openOnceDelivery(ref: { goalId: string }): void };
  const realOpen = O.openOnceDelivery.bind(manager);
  O.openOnceDelivery = (ref) => { opened.push(ref.goalId); realOpen(ref as Parameters<typeof realOpen>[0]); };

  startupMode = "confirmed";
  const c1 = await spawnOnce({ agent: "once-confirm-stub", prompt: "confirmed", once: {} });
  const cSide1 = c1.seat === undefined ? undefined : await seatSide(c1.name!, c1.seat);
  let cTurns1 = cSide1 === undefined ? [] : await cSide1.pull();
  if (cTurns1.length === 0 && cSide1 !== undefined) { await wait(1_000); cTurns1 = await cSide1.pull(); }
  check("a startup that answered the prompt and then showed the notice succeeds, and its seat is served the task",
    c1.terminal?.state === "succeeded" && cTurns1.length === 1 && cTurns1[0]!.goalId === c1.once?.goalId && opened.includes(c1.once!.goalId), { terminal: c1.terminal, cTurns1 });
  if (c1.once !== undefined) await cSide1?.invoke("turn-yield", { goalId: c1.once.goalId, status: "done" });
  check("...and its yield stops the seat", c1.seat !== undefined && await gone(c1.name!, c1.seat.handle));

  startupMode = "ready";
  const c2 = await spawnOnce({ agent: "once-confirm-stub", prompt: "no prompt", once: {} });
  const r2 = await resultOf(taskOf(c2.id), 20_000);
  check("a startup that opened its input screen without the prompt fails, saying why",
    c2.terminal?.state === "failed" && errorOf(c2.terminal) === `${c2.name} joined, but its startup did not show the channel: its startup watch opened its input screen without the prompt, so it cannot take a once task`, c2.terminal);
  check("...its task, never served, is cancelled `launch-failed`, and its seat is gone with its debt cleared",
    r2?.state === "cancelled" && reasonOf(r2) === "launch-failed" && !opened.includes(taskOf(c2.id))
      && c2.seat !== undefined && await gone(c2.name!, c2.seat.handle) && await debtCleared(taskOf(c2.id)), r2);

  // The runtime's gate stops the seat when its watch fails. The launch here reads that outcome only
  // after the seat's exit, the order a loaded manager can see between its polls.
  startupMode = "silent";
  const W = manager as unknown as { awaitStartupOutcome(a: { handle: AgentHandle }, ...rest: unknown[]): Promise<string> };
  const readOutcome = W.awaitStartupOutcome.bind(manager);
  W.awaitStartupOutcome = async (a, ...rest) => {
    const outcome = await readOutcome(a, ...rest);
    if (outcome === "failed") { await until(() => a.handle.status() === "exited", 10_000); await wait(500); }
    return outcome;
  };
  const silentId = goalId("silent");
  const silentName = (await call("spawn", { name: "helper", agent: "once-confirm-stub", cwd: repoRoot, events: false, prompt: "no notice", once: {} }, { id: silentId })).data?.name as string | undefined;
  const silentSeat = silentName !== undefined && await until(() => M.agents.has(silentName), 15_000) ? M.agents.get(silentName) : undefined;
  const silentSide = silentSeat === undefined ? undefined : await seatSide(silentName!, silentSeat);
  await wait(5_000); // the prompt answered and the seat joined; its notice never comes
  const silentEarly = silentSide === undefined ? undefined : await silentSide.pull();
  check("while the notice is awaited the seat has joined, but its pull finds no task", silentEarly !== undefined && silentEarly.length === 0, silentEarly);
  const silentTerm = await resultOf(silentId, 45_000);
  const rSilent = await resultOf(taskOf(silentId), 10_000);
  check("a prompt answered with no notice after it fails the spawn at the notice's bound, saying why",
    silentTerm?.state === "failed" && errorOf(silentTerm) === `${silentName} joined, but its startup did not show the channel: its startup watch failed, so it cannot take a once task`, silentTerm);
  check("...its task, never served, is cancelled `launch-failed` though its seat's exit landed first, and its seat is gone",
    rSilent?.state === "cancelled" && reasonOf(rSilent) === "launch-failed" && !opened.includes(taskOf(silentId))
      && silentSeat !== undefined && await gone(silentName!, silentSeat.handle), rSilent);
  W.awaitStartupOutcome = readOutcome;

  startupMode = "confirmed";
  const lostId = goalId("lost");
  const lostName = (await call("spawn", { name: "helper", agent: "once-confirm-stub", cwd: repoRoot, events: false, prompt: "terminal refused", once: {} }, { id: lostId })).data?.name as string | undefined;
  const lostSeat = lostName !== undefined && await until(() => M.agents.has(lostName), 15_000) ? M.agents.get(lostName) : undefined;
  // From launch on, no goal write lands until the seat is seen gone: the succeeded terminal is refused.
  gate = { mode: "refuse", hit: false };
  check("a confirmed spawn whose succeeded terminal cannot be written never serves its task: its seat is stopped",
    lostSeat !== undefined && await gone(lostName!, lostSeat.handle) && gate.hit && !opened.includes(taskOf(lostId)), { hit: gate.hit, opened });
  gate = undefined;
  const rLost = await resultOf(taskOf(lostId), 20_000);
  check("...and its task is cancelled `launch-failed` once goal writes land again",
    rLost?.state === "cancelled" && reasonOf(rLost) === "launch-failed" && (await readGoalResult(actx, refOf(lostId)))?.state !== "succeeded", rLost);
} finally {
  for (const nc of seatConns) await nc.drain().catch(() => nc.close());
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await manager?.stop({ withAgents: true }).catch(() => {});
  await writer?.stop().catch(() => {});
  await writerNc?.drain().catch(() => writerNc?.close());
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
}

const EXPECTED_CELLS = 67;
console.log(`\n${fail === 0 && pass === EXPECTED_CELLS ? "SPAWN ONCE SMOKE OK ✅" : "SPAWN ONCE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
