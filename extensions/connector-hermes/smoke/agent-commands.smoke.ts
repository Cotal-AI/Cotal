/**
 * The Hermes seat's agent endpoint over the bridge (src/commands.ts, src/bridge.ts): the owner's
 * turns with their images, the gateway's commands and skills, interrupt and usage, each answered by
 * the adapter, and the busy gate that starts a queued turn only while the gateway has no Cotal
 * message or turn in progress, and the end of a turn the gateway gave up on once it is idle. The
 * adapter here is a socket speaking the bridge frames; the dispatcher, the bridge, the drain and the
 * presence end are the shipped ones.
 */
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRefused, type AgentConfig, type AgentTurn, type MeshAgent } from "@cotal-ai/connector-core";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { startBridgeServer, type BridgeServer } from "../src/bridge.js";
import { drainWhileIdle, hermesCommands } from "../src/commands.js";
import { gatewayIdle } from "../src/hermes-hooks.js";
import { bridgeKey, openBridge } from "./bridge-open.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`  x FAIL: ${name}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  }
};

/** An agent with an empty inbox and a turn queue: `dispatchNextCommand` takes the oldest queued turn
 *  before it awaits the dispatcher, as connector-core's command lane does. */
class QueueAgent extends EventEmitter {
  readonly queue: AgentTurn[] = [];
  readonly started: string[] = [];
  turn?: (t: AgentTurn) => Promise<void>;
  /** Presence as the hooks write it: each status written, and the held-message wakes asked for. */
  status = "idle";
  readonly statuses: string[] = [];
  held = 0;
  wakes = 0;
  async setStatus(status: string): Promise<void> {
    this.statuses.push(status);
    this.status = status;
  }
  pendingWake(): number {
    return this.held;
  }
  requestWake(): void {
    this.wakes += 1;
  }
  inboxPreview() {
    return [];
  }
  async dispatchNextCommand(): Promise<"empty" | "dispatched" | "failed"> {
    const t = this.queue.shift();
    if (!t) return "empty";
    this.started.push(t.text);
    try {
      await this.turn!(t);
      return "dispatched";
    } catch {
      return "failed";
    }
  }
  enqueue(text: string): void {
    this.queue.push({ text, images: [] });
    this.emit("command");
  }
}

const dir = mkdtempSync(join(tmpdir(), "cotal-hermes-commands-"));
const socketPath = join(dir, "bridge.sock");
const key = "commands-smoke-control-key";
const config = {
  space: "hermes-commands", name: "Hermes", servers: "nats://127.0.0.1:1", subscribe: ["general"],
  allowSubscribe: ["general"], allowPublish: ["general"], kind: "agent" as const, tls: false,
};
const agent = new QueueAgent();
let bridge: BridgeServer | undefined;
const commands = hermesCommands(() => bridge);
agent.turn = commands.turn;
const drain = drainWhileIdle(agent as unknown as MeshAgent, () => bridge);
agent.on("command", drain);
let subscribed = 0;
let idled = 0;
bridge = startBridgeServer(agent as unknown as MeshAgent, config as AgentConfig, socketPath, bridgeKey(socketPath, key), {
  onSubscribe: () => (subscribed += 1),
  // As the sidecar wires it.
  onIdle: () => {
    idled += 1;
    void gatewayIdle(agent as unknown as MeshAgent, bridge);
    drain();
  },
});

interface Adapter {
  sock: Socket;
  next: () => Promise<Record<string, unknown>>;
  pending: () => number;
}

/** How long the adapter waits for the sidecar's next frame, so a frame that never comes fails a cell
 *  rather than hanging the suite. */
const FRAME_MS = 5_000;

/** Connect and subscribe as the adapter; read the frames the sidecar sends, one at a time. */
async function adapter(): Promise<Adapter> {
  const sock = connect(socketPath);
  await once(sock, "connect");
  const frames: Record<string, unknown>[] = [];
  let read = 0;
  let waiter: (() => void) | undefined;
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      frames.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      buf = buf.slice(nl + 1);
    }
    waiter?.();
  });
  await openBridge(sock, key);
  const next = async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + FRAME_MS;
    while (read >= frames.length) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`the sidecar sent no frame within ${FRAME_MS} ms`);
      await new Promise<void>((resolve) => {
        waiter = resolve;
        setTimeout(resolve, left).unref();
      });
    }
    return frames[read++]!;
  };
  return { sock, next, pending: () => frames.length - read };
}
const send = (sock: Socket, frame: Record<string, unknown>) => sock.write(`${JSON.stringify(frame)}\n`);
type Settled<T> = { ok: true; v: T } | { ok: false; e: Error };
const settled = <T>(p: Promise<T>): Promise<Settled<T>> => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }));
/** Let the bridge read what the adapter wrote, and the drain run what that woke. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Ask through the dispatcher, answer as the adapter, and return what the dispatcher made of it. */
async function answered<T>(a: Adapter, call: () => Promise<T>, answer: Record<string, unknown>): Promise<{ frame: Record<string, unknown>; out: Settled<T> }> {
  const out = settled(call());
  const frame = await a.next();
  send(a.sock, { t: "answer", id: frame.id, ...answer });
  return { frame, out: await out };
}

async function frames(a: Adapter): Promise<void> {
  const png = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };
  const turn = settled(commands.turn!({ text: "what is this?", images: [png] }));
  const frame = await a.next();
  check("a turn goes to the adapter with its text and images", frame.t === "turn" && frame.text === "what is this?" && JSON.stringify(frame.images) === JSON.stringify([png]), frame);
  check("the bridge is not idle while a turn waits for its answer", bridge!.idle() === false);
  const before = idled;
  send(a.sock, { t: "turn_taken", id: frame.id });
  check("the turn resolves when the gateway took it", (await turn).ok);
  check("a settled turn wakes the drain", idled > before && bridge!.idle());

  const text = settled(commands.turn!({ text: "plain", images: [] }));
  const plain = await a.next();
  check("a turn without images carries no images field", plain.t === "turn" && !("images" in plain), plain);
  send(a.sock, { t: "turn_refused", id: plain.id, error: "no session" });
  const refused = await text;
  check("a turn the gateway refused is refused as failed-precondition", !refused.ok && refused.e instanceof CommandRefused && refused.e.code === "failed-precondition" && refused.e.message.includes("no session"), !refused.ok && refused.e.message);
}

async function usage(a: Adapter): Promise<void> {
  const full = await answered(a, () => commands.usage!(), { ok: true, data: { context: { used: 1200, size: 200000 }, cost: { amount: 0.25, currency: "USD" } } });
  check("usage asks the adapter with a usage frame", full.frame.t === "usage" && typeof full.frame.id === "string", full.frame);
  check("usage reports the context and cost the gateway gave", full.out.ok && JSON.stringify(full.out.v) === JSON.stringify({ context: { used: 1200, size: 200000 }, cost: { amount: 0.25, currency: "USD" } }), full.out);
  const none = await answered(a, () => commands.usage!(), { ok: true, data: {} });
  check("usage leaves out what the gateway did not report", none.out.ok && JSON.stringify(none.out.v) === "{}", none.out);
  const bad = await answered(a, () => commands.usage!(), { ok: true, data: { context: { used: -1, size: 10 } } });
  check("an invalid context is an error, never a number passed on", !bad.out.ok && bad.out.e.message.includes("invalid context"), bad.out);
  const failed = await answered(a, () => commands.usage!(), { ok: false, error: "no runner" });
  check("a failed answer rejects with the gateway's reason", !failed.out.ok && failed.out.e.message === "no runner", failed.out);
}

async function interrupt(a: Adapter): Promise<void> {
  const stopped = await answered(a, () => commands.interrupt!(), { ok: true, data: { state: "interrupted" } });
  check("interrupt asks the adapter with an interrupt frame", stopped.frame.t === "interrupt", stopped.frame);
  check("interrupt reports interrupted when the gateway stopped a session", stopped.out.ok && stopped.out.v === "interrupted", stopped.out);
  const idle = await answered(a, () => commands.interrupt!(), { ok: true, data: { state: "idle" } });
  check("interrupt reports idle when nothing was in progress", idle.out.ok && idle.out.v === "idle", idle.out);
  const odd = await answered(a, () => commands.interrupt!(), { ok: true, data: { state: "paused" } });
  check("an unknown interrupt state is an error", !odd.out.ok && odd.out.e.message.includes("unknown interrupt state"), odd.out);
}

const LISTED = [
  { name: "status", target: "command", description: "Show session info", inputHint: "" },
  { name: "model", target: "command", description: "Switch model", inputHint: "[model]" },
  { name: "release-notes", target: "skill", description: "" },
];

async function commandList(a: Adapter): Promise<void> {
  check("the dispatcher runs commands and skills", commands.targets.has("command") && commands.targets.has("skill"));
  const listed = await answered(a, () => commands.list(), { ok: true, data: { commands: LISTED } });
  check("the list asks the adapter with a commands frame", listed.frame.t === "commands" && typeof listed.frame.id === "string", listed.frame);
  const want = [
    { name: "status", target: "command", description: "Show session info" },
    { name: "model", target: "command", description: "Switch model", inputHint: "[model]" },
    { name: "release-notes", target: "skill" },
  ];
  check("the list is the gateway's, with empty fields left out", listed.out.ok && JSON.stringify(listed.out.v) === JSON.stringify(want), listed.out);
  const bad = await answered(a, () => commands.list(), { ok: true, data: { commands: [{ name: "x", target: "plugin" }] } });
  check("an entry with an unknown target is an error", !bad.out.ok && bad.out.e.message.includes("invalid command"), bad.out);
  const none = await answered(a, () => commands.list(), { ok: true, data: {} });
  check("an answer with no list is an error, never an empty list", !none.out.ok && none.out.e.message.includes("no command list"), none.out);
}

/** Dispatch through the dispatcher: answer its list request, then return the frame that follows it. */
async function dispatched(a: Adapter, command: { target: "command" | "skill"; name: string; args: string }) {
  const out = settled(commands.dispatch(command));
  const ask = await a.next();
  send(a.sock, { t: "answer", id: ask.id, ok: true, data: { commands: LISTED } });
  return { ask, out };
}

async function commandDispatch(a: Adapter): Promise<void> {
  const model = await dispatched(a, { target: "command", name: "model", args: "claude-opus" });
  const turn = await a.next();
  check("a command reads the current list before it runs", model.ask.t === "commands", model.ask);
  check("a listed command runs in the operator chat as /<name> <args>", turn.t === "turn" && turn.text === "/model claude-opus", turn);
  send(a.sock, { t: "turn_taken", id: turn.id });
  check("it resolves when the gateway took it", (await model.out).ok);

  const skill = await dispatched(a, { target: "skill", name: "release-notes", args: "" });
  const skillTurn = await a.next();
  check("a skill runs by its slash name, with no args appended", skillTurn.t === "turn" && skillTurn.text === "/release-notes", skillTurn);
  send(a.sock, { t: "turn_taken", id: skillTurn.id });
  await skill.out;

  for (const [command, why] of [
    [{ target: "command", name: "restart", args: "" }, "a name the gateway does not list"],
    [{ target: "skill", name: "status", args: "" }, "a listed name under the other target"],
  ] as const) {
    const refused = await dispatched(a, command);
    const r = await refused.out;
    await tick();
    check(`${why} is refused as not-found and nothing runs`, !r.ok && r.e instanceof CommandRefused && r.e.code === "not-found" && a.pending() === 0, !r.ok && r.e.message);
  }
}

async function busyGate(a: Adapter): Promise<void> {
  send(a.sock, { t: "busy", count: 1 });
  await tick();
  check("a busy count makes the bridge not idle", bridge!.idle() === false);
  agent.enqueue("first");
  agent.enqueue("second");
  await tick();
  check("no queued turn starts while the gateway is busy", agent.started.length === 0 && a.pending() === 0, agent.started);
  send(a.sock, { t: "busy", count: 0 });
  const first = await a.next();
  check("the oldest queued turn starts once the gateway is idle", first.t === "turn" && first.text === "first", first);
  await tick();
  check("the next turn waits while the first waits for its answer", agent.started.length === 1 && a.pending() === 0, agent.started);
  send(a.sock, { t: "busy", count: 1 });
  send(a.sock, { t: "turn_taken", id: first.id });
  await tick();
  check("the next turn waits while the first one runs", agent.started.length === 1 && a.pending() === 0, agent.started);
  send(a.sock, { t: "busy", count: 0 });
  const second = await a.next();
  check("the next turn starts when the gateway is idle again", second.t === "turn" && second.text === "second", second);
  send(a.sock, { t: "turn_taken", id: second.id });
  await tick();
  agent.enqueue("third");
  const third = await a.next();
  check("a turn queued while idle starts at once", third.t === "turn" && third.text === "third", third);
  send(a.sock, { t: "turn_taken", id: third.id });
  await tick();
}

/** A turn still working once the gateway has nothing in progress has ended: a run Hermes gave up on
 *  fires neither post_llm_call nor on_session_end. */
async function gaveUp(a: Adapter): Promise<void> {
  agent.status = "working";
  agent.held = 1;
  send(a.sock, { t: "busy", count: 1 });
  await tick();
  check("a turn stays working while the gateway has a message in progress", agent.statuses.length === 0, agent.statuses);
  send(a.sock, { t: "busy", count: 0 });
  await tick();
  check("the gateway going idle ends a turn still working", agent.statuses.join() === "idle", agent.statuses);
  check("and asks for the messages held while it worked", agent.wakes === 1, agent.wakes);
  send(a.sock, { t: "busy", count: 1 });
  send(a.sock, { t: "busy", count: 0 });
  await tick();
  check("a turn that already ended is not ended again", agent.statuses.join() === "idle", agent.statuses);
  agent.status = "working";
  const turn = settled(commands.turn!({ text: "handed over", images: [] }));
  const frame = await a.next();
  send(a.sock, { t: "busy", count: 0 });
  await tick();
  check("a turn handed to the gateway and not yet taken is not ended", agent.statuses.join() === "idle", agent.statuses);
  send(a.sock, { t: "busy", count: 1 });
  send(a.sock, { t: "turn_taken", id: frame.id });
  await turn;
  send(a.sock, { t: "busy", count: 0 });
  await tick();
  check("it ends once the gateway is done with it", agent.statuses.join() === "idle,idle", agent.statuses);
  agent.held = 0;
}

async function disconnect(a: Adapter): Promise<void> {
  const turn = settled(commands.turn!({ text: "unanswered", images: [] }));
  await a.next();
  const asked = settled(commands.usage!());
  await a.next();
  a.sock.destroy();
  const [t, u] = await Promise.all([turn, asked]);
  check("a turn whose adapter disconnects rejects as unknown, never handed again", !t.ok && t.e.message.includes("whether it started is unknown"), !t.ok && t.e.message);
  check("a request whose adapter disconnects rejects", !u.ok && u.e.message.includes("disconnected before it answered"), !u.ok && u.e.message);
  const none = await settled(commands.usage!());
  check("with no adapter subscribed, a request rejects at once", !none.ok && none.e.message.includes("not connected"), !none.ok && none.e.message);
  check("with no adapter subscribed, the bridge is not idle", bridge!.idle() === false);
}

/** Run one section; one that throws, such as on a frame that never came, fails by name. */
async function section(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    check(`${name} ran to its end`, false, (e as Error).message);
  }
}

try {
  check("the bridge is not idle before an adapter subscribes", bridge.idle() === false);
  const a = await adapter();
  await tick();
  check("an authenticated subscribe is reported", subscribed === 1);
  check("a subscribed adapter with nothing in progress is idle", bridge.idle() === true);
  await section("turns", () => frames(a));
  await section("usage", () => usage(a));
  await section("interrupt", () => interrupt(a));
  await section("the command list", () => commandList(a));
  await section("command dispatch", () => commandDispatch(a));
  await section("the busy gate", () => busyGate(a));
  await section("a turn the gateway gave up on", () => gaveUp(a));
  await section("disconnect", () => disconnect(a));
} finally {
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`hermes agent commands: ${pass} passed, ${fail} failed`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
