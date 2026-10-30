/**
 * A `once` task through both OpenCode plugins, against a fake OpenCode server and a scripted manager.
 *
 * A once task is handed to OpenCode at most once. The drive claims it right before the submission,
 * confirms it when the submission lands, and releases it when the submission fails, which seals it
 * and reports `turn-unconfirmed`. A claimed task is not offered to a native prompt meanwhile, and a
 * native prompt that carries a pending task confirms it. Each plugin registers its own teardown as
 * the exit a once seat takes when its report cannot land.
 *
 * A turn can end before the submission's answer arrives, because the events come over another
 * transport. That end may be the task's own turn or one the host ran meanwhile, and neither
 * generation can tell which, so the task is sealed and reported instead of confirmed. Only an end
 * newer than the last one seen when the submission started counts: a replay, the idle that trails
 * an end already seen, and another session's end leave the task to confirm as usual.
 *
 * The manager is the agent's `managerInvoke`, replaced for the run: `turn-pending` serves the rows
 * below and `turn-unconfirmed` records each report. The mesh is a real nats-server.
 *
 * Run: pnpm smoke:opencode-once
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "@cotal-ai/connector-core";
import { bootPlugin, bootPlugin2, fakeOpenCode2Context, disposeInProcess } from "./_boot-plugin.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5_000) => {
  for (let i = 0; i < ms / 50 && !cond(); i++) await sleep(50);
};

// ── The scripted manager.
type Row = { goalId: string; payload: string; acceptedAt: number; once: true };
const onceRow = (goalId: string, prompt: string): Row => ({
  goalId, payload: JSON.stringify({ context: prompt, once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true,
});
const pending = new Map<string, Row[]>();
const reports: Array<{ name: string; goalId: unknown }> = [];
const yields: Array<{ name: string; goalId: unknown }> = [];
const agents = new Map<string, MeshAgent>();
const nameOf = (a: MeshAgent) => (a as unknown as { config: { name: string } }).config.name;
(MeshAgent.prototype as unknown as { managerInvoke: (this: MeshAgent, command: string, args?: Record<string, unknown>) => Promise<unknown> }).managerInvoke =
  async function (command, args) {
    const name = nameOf(this);
    agents.set(name, this);
    if (command === "turn-pending") return { ok: true, data: { turns: [...(pending.get(name) ?? [])], notices: true } };
    if (command === "turn-unconfirmed") {
      reports.push({ name, goalId: args?.goalId });
      pending.set(name, (pending.get(name) ?? []).filter((r) => r.goalId !== args?.goalId));
      return { ok: true, data: { goalId: args?.goalId, state: "failed" } };
    }
    if (command === "turn-yield") {
      yields.push({ name, goalId: args?.goalId });
      pending.set(name, (pending.get(name) ?? []).filter((r) => r.goalId !== args?.goalId));
      return { ok: true, data: { goalId: args?.goalId, state: "succeeded" } };
    }
    return { ok: false, error: `unscripted manager command ${command}`, code: "refused" };
  };
const pull = (name: string) => (agents.get(name) as unknown as { requestTurnPull(): void }).requestTurnPull();
const offer = (name: string, row: Row) => { pending.set(name, [...(pending.get(name) ?? []), row]); pull(name); };
/** The manager settles a task without the seat, as its deadline does: the row leaves the pull. */
const settle = (name: string, goalId: string) => { pending.set(name, (pending.get(name) ?? []).filter((r) => r.goalId !== goalId)); pull(name); };
const yieldsOf = (goalId: string) => yields.filter((y) => y.goalId === goalId).length;
const reportsOf = (goalId: string) => reports.filter((r) => r.goalId === goalId).length;

const registry = () => (globalThis as Record<symbol, { handoffs: Map<string, { state: string }>; exit?: () => void }>)[Symbol.for("cotal.once-handoff")];
const stateOf = (uid: string, goalId: string) => registry()?.handoffs.get(`${uid}:${goalId}`)?.state ?? "pending";

// ── The fake OpenCode server: 1.x and 2.x routes, each submission recorded. `next` scripts the
// answer to the next submission: a status, and an optional hold before it.
const SID = "ses_once";
const SID2 = "ses_once2";
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
const prompts: string[] = [];
let next: { status: number; hold?: Promise<void> } | undefined;
/** Holds the next submission's answer until the returned function is called. */
const holdAnswer = (): (() => void) => {
  let open!: () => void;
  next = { status: 204, hold: new Promise<void>((r) => (open = r)) };
  return () => open();
};
// The 1.x session's messages, read for a turn end's position. `holdReads` holds every read until
// the returned function is called.
let readGate: Promise<void> | undefined;
let readsHeld = 0;
const holdReads = (): (() => void) => {
  let release!: () => void;
  readGate = new Promise<void>((r) => (release = r));
  return () => { readGate = undefined; release(); };
};
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/session") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SID }));
      return;
    }
    if (req.method === "GET" && req.url === `/session/${SID}/message`) {
      const gate = readGate;
      if (gate) { readsHeld++; await gate; }
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    if (req.method === "POST" && req.url === "/api/session") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: SID2 } }));
      return;
    }
    if (req.method === "POST" && (req.url === `/session/${SID}/prompt_async` || req.url === `/api/session/${SID2}/prompt`)) {
      const body = JSON.parse(raw) as { parts?: { text?: string }[]; text?: string };
      prompts.push(body.text ?? body.parts?.map((p) => p.text ?? "").join("\n") ?? "");
      const answer = next ?? { status: 204 };
      next = undefined;
      await answer.hold;
      res.writeHead(answer.status).end();
      return;
    }
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocUrl = `http://127.0.0.1:${(oc.address() as { port: number }).port}`;

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "oconce";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const managerInstance = mintLifecycleUid();
const seatEnv = (name: string, uid: string) => {
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_NAME: name, COTAL_ID: name.toLowerCase(), COTAL_SPACE: space, COTAL_SERVERS: servers,
    COTAL_ROLE: "generalist", COTAL_LIFECYCLE_UID: uid, COTAL_MANAGER_INSTANCE: managerInstance,
    COTAL_OPENCODE_SERVER_URL: ocUrl, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "test-secret",
  });
};
const TASK = "started this seat for one task";
const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: [] });
pub.on("error", () => {});

type Hooks = Awaited<ReturnType<typeof bootPlugin>>;
let hooks: Hooks | undefined;
let dispose2: (() => Promise<void>) | void = undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await pub.start();

  // ── 1.x
  const uid = mintLifecycleUid();
  seatEnv("Una", uid);
  // The event plane is on, so a turn end reads the session's messages for its position.
  mkdirSync(join(dir, "ws"), { recursive: true });
  Object.assign(process.env, { COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: join(dir, "ws") });
  pending.set("Una", [onceRow("g1", "write the release note")]);
  hooks = await bootPlugin();
  const fire = (event: unknown) => hooks!.event!({ event } as never);
  const chatMessage = (text: string) => {
    const output = { parts: [{ type: "text", text }] };
    return (hooks as unknown as { "chat.message": (i: unknown, o: typeof output) => Promise<void> })["chat.message"]({ sessionID: SID }, output).then(() => output.parts[0]!.text);
  };

  await until(() => prompts.length >= 1);
  check("1.x: a once task pending at boot drives one submission that carries it", prompts.length === 1 && prompts[0]!.includes(TASK) && prompts[0]!.includes("write the release note"), prompts);
  await until(() => stateOf(uid, "g1") === "confirmed");
  check("1.x: the landed submission confirms the handoff", stateOf(uid, "g1") === "confirmed", stateOf(uid, "g1"));

  await fire({ type: "session.idle", properties: { sessionID: SID } });
  const unaId = pub.getRoster().find((p) => p.card.name === "Una")?.card.id;
  if (!unaId) throw new Error("once-handoff: Una not in the roster");
  await pub.unicast(unaId, "a later dm");
  await until(() => prompts.length >= 2);
  check("1.x: a later drive does not carry the confirmed task again", prompts.length === 2 && prompts[1]!.includes("a later dm") && !prompts[1]!.includes(TASK), prompts);
  await fire({ type: "session.idle", properties: { sessionID: SID } });
  check("1.x: a native prompt does not carry the confirmed task again", !(await chatMessage("human prompt")).includes(TASK));
  await fire({ type: "session.idle", properties: { sessionID: SID } });

  next = { status: 500 };
  const beforeFail = prompts.length;
  offer("Una", onceRow("g2", "fails to submit"));
  await until(() => reports.some((r) => r.goalId === "g2"));
  check("1.x: a failed submission seals the task it carried", stateOf(uid, "g2") === "sealed", stateOf(uid, "g2"));
  check("1.x: ...and reports it to the manager once", reports.filter((r) => r.goalId === "g2").length === 1, reports);
  await sleep(2_500);
  check("1.x: the retry after the failure does not submit the sealed task again", prompts.slice(beforeFail).filter((p) => p.includes("fails to submit")).length === 1, prompts.slice(beforeFail));

  await fire({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  const beforeBusy = prompts.length;
  offer("Una", onceRow("g3", "taken by a native prompt"));
  await sleep(500);
  check("1.x: a once task offered while a turn runs is not driven", prompts.length === beforeBusy, prompts.slice(beforeBusy));
  // A prompt the human queues while that turn runs reaches the hook before the turn ends.
  const carried = await chatMessage("human prompt");
  check("1.x: a native prompt queued meanwhile carries it", carried.includes(TASK) && carried.includes("taken by a native prompt"), carried);
  check("1.x: ...and confirms the handoff", stateOf(uid, "g3") === "confirmed", stateOf(uid, "g3"));
  await fire({ type: "session.idle", properties: { sessionID: SID } });
  await sleep(500);
  check("1.x: the turn end after it does not drive the task again", prompts.slice(beforeBusy).every((p) => !p.includes("taken by a native prompt")), prompts.slice(beforeBusy));

  // ── 1.x: a turn that ends before the submission's answer arrives.
  const busy1 = () => fire({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  const idle1 = () => fire({ type: "session.idle", properties: { sessionID: SID } });
  const claimed = (u: string, g: string) => until(() => stateOf(u, g) === "claimed");
  const landed = (u: string, g: string) => until(() => stateOf(u, g) !== "claimed");
  // A turn the host runs after the task's: it yields every task its turn was handed.
  const laterTurn1 = async () => { await busy1(); await idle1(); await sleep(300); };
  // Binds the event plane to the session, so a turn end reads its position.
  await fire({ type: "session.created", properties: { info: { id: SID } } });
  await sleep(500);

  let open1 = holdAnswer();
  offer("Una", onceRow("g4", "ends before its answer"));
  await claimed(uid, "g4");
  await busy1();
  await idle1();
  open1();
  await landed(uid, "g4");
  await laterTurn1();
  check("1.x: a turn that ends before the submission's answer arrives seals the task", stateOf(uid, "g4") === "sealed", stateOf(uid, "g4"));
  check("1.x: ...reports it to the manager once, and no turn yields it", reportsOf("g4") === 1 && yieldsOf("g4") === 0, { reports, yields });

  open1 = holdAnswer();
  offer("Una", onceRow("g5", "ends on its status"));
  await claimed(uid, "g5");
  await busy1();
  await fire({ type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } });
  open1();
  await landed(uid, "g5");
  await idle1();
  await laterTurn1();
  check("1.x: an idle status alone, before the answer, seals the task and no turn yields it", stateOf(uid, "g5") === "sealed" && reportsOf("g5") === 1 && yieldsOf("g5") === 0, { state: stateOf(uid, "g5"), reports, yields });

  open1 = holdAnswer();
  offer("Una", onceRow("g6", "errors before its answer"));
  await claimed(uid, "g6");
  await busy1();
  await fire({ type: "session.error", properties: { sessionID: SID, error: { name: "UnknownError", data: { message: "upstream failed" } } } });
  open1();
  await landed(uid, "g6");
  await idle1();
  await laterTurn1();
  check("1.x: a turn error before the answer seals the task and no turn yields it", stateOf(uid, "g6") === "sealed" && reportsOf("g6") === 1 && yieldsOf("g6") === 0, { state: stateOf(uid, "g6"), reports, yields });

  open1 = holdAnswer();
  offer("Una", onceRow("g7", "lands while its end is read"));
  await claimed(uid, "g7");
  await busy1();
  const heldBefore = readsHeld;
  const releaseRead = holdReads();
  const ending = idle1();
  await until(() => readsHeld > heldBefore);
  open1();
  await landed(uid, "g7");
  releaseRead();
  await ending;
  await laterTurn1();
  check("control: the turn end's position read was held while the answer arrived", readsHeld > heldBefore, { readsHeld });
  check("1.x: an answer that arrives while the turn end's position is read still seals the task, and no turn yields it", stateOf(uid, "g7") === "sealed" && reportsOf("g7") === 1 && yieldsOf("g7") === 0, { state: stateOf(uid, "g7"), reports, yields });

  open1 = holdAnswer();
  offer("Una", onceRow("g8", "after a stale end"));
  await claimed(uid, "g8");
  // The idle that trails the last turn's end, with no turn started since, and another session's end.
  await idle1();
  await fire({ type: "session.idle", properties: { sessionID: "ses_other" } });
  open1();
  await landed(uid, "g8");
  check("1.x: an idle with no turn started since the last end, or another session's, does not seal the task", stateOf(uid, "g8") === "confirmed" && reportsOf("g8") === 0, { state: stateOf(uid, "g8"), reports });
  await laterTurn1();
  check("1.x: ...and its own turn's end yields it", yieldsOf("g8") === 1, yields);

  open1 = holdAnswer();
  offer("Una", onceRow("g9", "answered with no end"));
  await claimed(uid, "g9");
  await sleep(300);
  open1();
  await landed(uid, "g9");
  check("1.x: an answer with no turn end before it confirms the task", stateOf(uid, "g9") === "confirmed" && reportsOf("g9") === 0, { state: stateOf(uid, "g9"), reports });
  await laterTurn1();

  open1 = holdAnswer();
  offer("Una", onceRow("g10", "settled before its answer"));
  await claimed(uid, "g10");
  settle("Una", "g10");
  await until(() => stateOf(uid, "g10") !== "claimed");
  await busy1();
  await idle1();
  open1();
  await sleep(500);
  await laterTurn1();
  check("1.x: a task the manager settles while its answer is held is neither reported nor yielded when the answer arrives", reportsOf("g10") === 0 && yieldsOf("g10") === 0, { state: stateOf(uid, "g10"), reports, yields });

  // The registered once exit is the plugin's own teardown, which ends the process with code 1.
  const exitCodes: Array<number | undefined> = [];
  const realExit = process.exit;
  process.exit = ((code?: number) => { exitCodes.push(code); }) as typeof process.exit;
  try {
    registry()?.exit?.();
    await until(() => exitCodes.length > 0, 15_000);
  } finally {
    process.exit = realExit;
  }
  await until(() => !pub.getRoster().some((p) => p.card.name === "Una" && p.status !== "offline"));
  check("1.x: the registered once exit runs the plugin's teardown and exits 1", exitCodes[0] === 1 && !pub.getRoster().some((p) => p.card.name === "Una" && p.status !== "offline"), { exitCodes });
  hooks = undefined;

  // ── 2.x
  const uid2 = mintLifecycleUid();
  seatEnv("Duo", uid2);
  delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
  next = { status: 500 };
  pending.set("Duo", [onceRow("h1", "fails on 2.x")]);
  const ctx = fakeOpenCode2Context();
  dispose2 = await bootPlugin2(ctx);
  await until(() => reports.some((r) => r.goalId === "h1"));
  check("2.x: a failed submission seals the task it carried", stateOf(uid2, "h1") === "sealed", stateOf(uid2, "h1"));
  check("2.x: ...and reports it to the manager once", reports.filter((r) => r.goalId === "h1").length === 1, reports);

  let open!: () => void;
  next = { status: 204, hold: new Promise<void>((r) => (open = r)) };
  const beforeHold = prompts.length;
  offer("Duo", onceRow("h2", "held on 2.x"));
  await until(() => prompts.length > beforeHold);
  check("2.x: a once task drives one submission that carries it", prompts.length === beforeHold + 1 && prompts.at(-1)!.includes("held on 2.x"), prompts.slice(beforeHold));
  check("2.x: the task is claimed while its submission is in flight", stateOf(uid2, "h2") === "claimed", stateOf(uid2, "h2"));
  const promptHook = ctx.sessionHooks.get("prompt") as unknown as (e: { sessionID: string; prompt: { text: string } }) => void;
  const native = { sessionID: SID2, prompt: { text: "native prompt" } };
  promptHook(native);
  check("2.x: a native prompt meanwhile does not carry the claimed task", !native.prompt.text.includes(TASK), native.prompt.text);
  open();
  await until(() => stateOf(uid2, "h2") === "confirmed");
  check("2.x: the landed submission confirms the handoff", stateOf(uid2, "h2") === "confirmed", stateOf(uid2, "h2"));

  offer("Duo", onceRow("h3", "taken by a 2.x native prompt"));
  await sleep(500);
  const native2 = { sessionID: SID2, prompt: { text: "native prompt" } };
  promptHook(native2);
  check("2.x: a native prompt while a turn runs carries a pending task", native2.prompt.text.includes("taken by a 2.x native prompt"), native2.prompt.text);
  check("2.x: ...and confirms the handoff", stateOf(uid2, "h3") === "confirmed", stateOf(uid2, "h3"));

  // ── 2.x: a turn that ends before the submission's answer arrives. Each event carries the
  // session's durable log position, as the server's event stream does.
  let seq = 0;
  const exec2 = (type: string, at = ++seq, session = SID2) =>
    ctx.feed({ type, data: { sessionID: session }, durable: { aggregateID: session, seq: at } } as never);
  const laterTurn2 = async () => { exec2("session.execution.started"); exec2("session.execution.succeeded"); await sleep(300); };
  // The turn that carried h2 and h3 ends, so the session is free for a submission again.
  await laterTurn2();

  for (const [g, end] of [["h4", "succeeded"], ["h5", "failed"], ["h6", "interrupted"]] as const) {
    const open2 = holdAnswer();
    offer("Duo", onceRow(g, `ends ${end} before its answer`));
    await claimed(uid2, g);
    exec2("session.execution.started");
    exec2(`session.execution.${end}`);
    await sleep(200);
    open2();
    await landed(uid2, g);
    await laterTurn2();
    check(`2.x: a turn that ends ${end} before the submission's answer arrives seals the task, and no turn yields it`, stateOf(uid2, g) === "sealed" && reportsOf(g) === 1 && yieldsOf(g) === 0, { state: stateOf(uid2, g), reports, yields });
  }

  let open2 = holdAnswer();
  offer("Duo", onceRow("h7", "ends with no start seen"));
  await claimed(uid2, "h7");
  // A turn the host started before the submission, whose start this plugin never saw.
  exec2("session.execution.succeeded");
  await sleep(200);
  open2();
  await landed(uid2, "h7");
  await laterTurn2();
  check("2.x: an end with no start seen, before the answer, seals the task, and no turn yields it", stateOf(uid2, "h7") === "sealed" && reportsOf("h7") === 1 && yieldsOf("h7") === 0, { state: stateOf(uid2, "h7"), reports, yields });

  open2 = holdAnswer();
  offer("Duo", onceRow("h8", "after a replayed end"));
  await claimed(uid2, "h8");
  // The last turn's end again, at its own position, and another session's end.
  exec2("session.execution.succeeded", seq);
  exec2("session.execution.succeeded", ++seq, "ses_other");
  await sleep(200);
  open2();
  await landed(uid2, "h8");
  check("2.x: a replayed end, or another session's, does not seal the task", stateOf(uid2, "h8") === "confirmed" && reportsOf("h8") === 0, { state: stateOf(uid2, "h8"), reports });
  await laterTurn2();
  check("2.x: ...and its own turn's end yields it", yieldsOf("h8") === 1, yields);

  open2 = holdAnswer();
  offer("Duo", onceRow("h9", "settled before its answer"));
  await claimed(uid2, "h9");
  settle("Duo", "h9");
  await until(() => stateOf(uid2, "h9") !== "claimed");
  exec2("session.execution.started");
  exec2("session.execution.succeeded");
  open2();
  await sleep(500);
  await laterTurn2();
  check("2.x: a task the manager settles while its answer is held is neither reported nor yielded when the answer arrives", reportsOf("h9") === 0 && yieldsOf("h9") === 0, { state: stateOf(uid2, "h9"), reports, yields });

  // The registered once exit is the 2.x teardown, which ends the process with code 1.
  const exitCodes2: Array<number | undefined> = [];
  const realExit2 = process.exit;
  process.exit = ((code?: number) => { exitCodes2.push(code); }) as typeof process.exit;
  try {
    registry()?.exit?.();
    await until(() => exitCodes2.length > 0, 15_000);
  } finally {
    process.exit = realExit2;
  }
  await until(() => !pub.getRoster().some((p) => p.card.name === "Duo" && p.status !== "offline"));
  check("2.x: the registered once exit runs the plugin's teardown and exits 1", exitCodes2[0] === 1 && !pub.getRoster().some((p) => p.card.name === "Duo" && p.status !== "offline"), { exitCodes2 });
  dispose2 = undefined;
} finally {
  await disposeInProcess(hooks).catch(() => undefined);
  await dispose2?.().catch(() => undefined);
  await pub.stop().catch(() => undefined);
  srv.kill("SIGKILL");
  oc.close();
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(fail === 0 ? `\nOPENCODE ONCE SMOKE PASSED ✅ (${pass} checks)` : `\nOPENCODE ONCE SMOKE FAILED ❌ (${pass} passed, ${fail} failed)`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
