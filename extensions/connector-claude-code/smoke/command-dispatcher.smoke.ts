/*
 * The Claude Code seat's agent commands (SPEC 13.22) from the agent endpoint's lane down to the
 * command socket, with this suite as the command mod. The feed is the real one, opened with this
 * process's pid as the Claude pid, and the built `dist/command-reader.cjs` runs as this process's
 * child, so its hello and the one-shot `answer` helper travel the real socket. The lane is the
 * shipped one, so every reply below is what a caller of the agent endpoint gets.
 *
 * Covered: with no feed, no reader, an old Claude or another mod version, `commands` answers
 * `supported: false` and `command` and `interrupt` are `unimplemented` naming the cause. With a
 * reader, the list maps each entry to a `command` with its hint, a failed list is `unavailable`, and
 * each run and interrupt answer the mod can give maps to its state; a run held by a panel ends
 * `unknown` at the start bound, and so does one whose reader leaves. The queue starts commands only
 * while the seat runs no turn, one at a time, and a remote interrupt ends the hooks' turn only when
 * no other turn opened since.
 *
 * Run: pnpm smoke:claude-command-dispatcher
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/command-dispatcher.json
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { MeshAgent, type AgentConfig, type CommandDispatch, type CommandDispatcher, type HookEvent } from "@cotal-ai/connector-core";
import { CONNECTOR_VERSION } from "@cotal-ai/connector-core/version";
import { EpEnvelopeError, type CommandState, type PresenceStatus } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
// The built lane, so its `CommandRefused` is the class the dispatcher throws.
import { createCommandLane } from "../../connector-core/dist/agent-commands.js";
import { commandSocketPath, openCommandFeed, type CommandFeed } from "../src/command-feed.js";
import { claudeCommands, commandTurns } from "../src/commands.js";
import { createClaudeHandle } from "../src/hooks.js";

const EXPECTED_CELLS = 47;
const READER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "command-reader.cjs");
const scratch = mkdtempSync(join(tmpdir(), "cmd-disp-"));
process.env.TMPDIR = scratch;
const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8" };
const { check, finish, passed, failed } = createSuite();
const children = new Set<ChildProcess>();
const warnings: string[] = [];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const BOUNDS = { runMs: 400, interruptMs: 400 };

async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (cond()) return true;
  return cond();
}

type Request = Record<string, unknown> & { id: string; op: string; route: string };

/** The real reader as this process's child; `next` is the next request it printed. */
function startReader(claude: string) {
  const child = spawn(process.execPath, [READER, "read", "--claude", claude], { env, stdio: ["ignore", "pipe", "ignore"] });
  children.add(child);
  const lines: Request[] = [];
  createInterface({ input: child.stdout! }).on("line", (l) => lines.push(JSON.parse(l) as Request));
  const next = async (): Promise<Request | undefined> => ((await until(() => lines.length > 0)) ? lines.shift() : undefined);
  return { child, next };
}

/** The mod's answer to `req`, through the one-shot helper. */
function answer(req: Request, frame: Record<string, unknown>): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [READER, "answer", req.route], { env, stdio: ["pipe", "ignore", "ignore"] });
    children.add(child);
    child.on("close", (code) => resolve(code));
    child.stdin!.on("error", () => {});
    child.stdin!.end(JSON.stringify({ id: req.id, ...frame }));
  });
}

type Reply = { ok: true; value: unknown } | { ok: false; error: unknown };
const settled = (p: Promise<unknown>): Promise<Reply> => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const refusal = (r: Reply): string =>
  !r.ok && r.error instanceof EpEnvelopeError ? `${r.error.code}/${r.error.outcome}: ${r.error.message}` : JSON.stringify(r.ok ? r.value : String(r.error));

/** The shipped lane over `dispatcher`, called as alice's interactive session calls her seat. */
function laneOver(dispatcher: CommandDispatcher) {
  const lane = createCommandLane(dispatcher, () => {});
  const call = (command: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const def = lane.handlers.find((h) => h.command === command)!;
    const ctx = { request: { args }, principal: { owner: "alice", actor: "seat" }, caller: { owner: "alice", actor: "web" } };
    return settled(Promise.resolve().then(() => def.handler(ctx as never)));
  };
  /** Queue one command and take it, with `mod` answering what the reader printed for it. */
  const run = async (name: string, args: string, mod: (req: Request) => Promise<unknown>): Promise<{ state?: CommandState; seen?: Request }> => {
    const queued = await call("command", { target: "command", name, args });
    if (!queued.ok) return {};
    const taking = lane.dispatchNext();
    const seen = await reader?.next();
    if (seen) await mod(seen);
    // Bounded, so a start that never settles fails its cell as `taken` instead of stalling the suite.
    await Promise.race([taking, wait(3_000)]);
    const read = await call("command-state", { id: (queued.value as { id: string }).id });
    return { state: read.ok ? (read.value as { state: CommandState }).state : undefined, seen };
  };
  return { lane, call, run };
}

let feed: CommandFeed;
let reader: ReturnType<typeof startReader> | undefined;
let interrupted = 0;
const imageDir = mkdtempSync(join(scratch, "images-"));
const dispatcher = claudeCommands({
  feed: () => feed,
  interrupting: () => async () => { interrupted++; },
  warn: (msg) => warnings.push(msg),
  imageDir,
  bounds: BOUNDS,
});

async function unsupported(): Promise<void> {
  const none = laneOver(claudeCommands({ feed: () => undefined, interrupting: () => undefined, warn: () => {} }));
  const noList = await none.call("commands");
  check("with no command socket, commands answers supported: false", noList.ok && JSON.stringify(noList.value) === '{"supported":false}', noList);
  const noPid = await none.call("command", { target: "command", name: "context" });
  check("...and command is unimplemented, naming the host that named no Claude Code process", /^unimplemented\/not-executed: .*named no Claude Code process/.test(refusal(noPid)), refusal(noPid));

  const { call } = laneOver(dispatcher);
  const list = await call("commands");
  check("with no reader, commands answers supported: false", list.ok && JSON.stringify(list.value) === '{"supported":false}', list);
  const run = await call("command", { target: "command", name: "context" });
  check("...command is unimplemented, naming the missing mod, the 2.1.330 floor and what turns mods off",
    /^unimplemented\/not-executed: .*the command mod is not running in this Claude Code session; it needs Claude Code 2\.1\.330 .*--bare, --safe-mode, disableAllHooks/.test(refusal(run)), refusal(run));
  const stop = await call("interrupt");
  check("...and interrupt is unimplemented with the same cause", /^unimplemented\/not-executed: .*the command mod is not running/.test(refusal(stop)), refusal(stop));

  const old = startReader("2.1.329");
  await until(() => feed.unsupported() !== undefined && !/not running/.test(feed.unsupported()!));
  const oldRun = await call("command", { target: "command", name: "context" });
  check("an old Claude: command is unimplemented, naming its version and the floor", /^unimplemented\/not-executed: .*Claude Code 2\.1\.329 is older than 2\.1\.330/.test(refusal(oldRun)), refusal(oldRun));
  old.child.kill("SIGTERM");

  const skew = createConnection(commandSocketPath(process.pid));
  skew.on("error", () => {});
  skew.on("connect", () => skew.write(`${JSON.stringify({ op: "hello", mod: "0.0.1", claude: "2.1.400" })}\n`));
  await until(() => /the mod is 0\.0\.1/.test(feed.unsupported() ?? ""));
  const skewRun = await call("command", { target: "command", name: "context" });
  check("another mod version: command is unimplemented, naming both versions", refusal(skewRun).endsWith(`the mod is 0.0.1 and the server is ${CONNECTOR_VERSION}; reload the plugin or restart the session`), refusal(skewRun));
  skew.destroy();
}

async function listing(): Promise<void> {
  reader = startReader("2.1.330");
  check("a reader of this version is accepted", await until(() => feed.unsupported() === undefined), feed.unsupported());
  const { call } = laneOver(dispatcher);
  const listed = call("commands");
  const req = await reader.next();
  await answer(req!, { op: "list", commands: [{ name: "deploy", description: "Ship it", argumentHint: "<env>" }, { name: "context", description: "Show context usage" }] });
  const reply = await listed;
  check("the mod is asked for its list", req?.op === "list", req);
  check("the list carries each entry as a command, with its description and its hint as inputHint",
    reply.ok && JSON.stringify(reply.value) === JSON.stringify({ supported: true, commands: [
      { name: "deploy", target: "command", description: "Ship it", inputHint: "<env>" },
      { name: "context", target: "command", description: "Show context usage" },
    ] }), reply);
  const empty = call("commands");
  await answer((await reader.next())!, { op: "list", commands: [] });
  const none = await empty;
  check("a mod that lists nothing answers an empty supported list", none.ok && JSON.stringify(none.value) === '{"supported":true,"commands":[]}', none);
  const broken = call("commands");
  await answer((await reader.next())!, { op: "error", reason: "$.command.list threw" });
  const failedList = await broken;
  check("a failed list is unavailable, never an empty list", /^unavailable\/not-executed: .*\$\.command\.list threw/.test(refusal(failedList)), refusal(failedList));
}

async function running(): Promise<void> {
  const { run } = laneOver(dispatcher);
  const started = await run("deploy", "prod --dry", (r) => answer(r, { op: "run", outcome: "started" }));
  check("the mod is asked to run the command with its args", started.seen?.op === "run" && started.seen.command === "deploy" && started.seen.args === "prod --dry", started.seen);
  check("a started run reads started", JSON.stringify(started.state) === '{"kind":"started"}', started.state);
  const settings = await run("model", "", (r) => answer(r, { op: "run", outcome: "refused", reason: "/model changes Claude Code settings at the seat" }));
  check("a run the mod's policy refuses reads refused, failed-precondition, with its reason",
    JSON.stringify(settings.state) === JSON.stringify({ kind: "refused", code: "failed-precondition", message: "/model changes Claude Code settings at the seat" }), settings.state);
  const local = await run("context", "", (r) => answer(r, { op: "run", outcome: "refused", reason: "waiting for local input" }));
  check("a run refused after a local Stop reads refused, failed-precondition, waiting for local input",
    local.state?.kind === "refused" && local.state.code === "failed-precondition" && local.state.message === "waiting for local input", local.state);
  const missing = await run("cost", "", (r) => answer(r, { op: "run", outcome: "not-found", reason: "no command named /cost in this session" }));
  check("an unknown command reads refused, not-found", missing.state?.kind === "refused" && missing.state.code === "not-found" && missing.state.message === "no command named /cost in this session", missing.state);
  const broken = await run("init", "", (r) => answer(r, { op: "error", reason: "the run failed oddly" }));
  check("a run the mod could not serve reads unknown, internal: it may have started",
    broken.state?.kind === "unknown" && /may have started: the command mod failed: the run failed oddly/.test(broken.state.message), broken.state);
  let held: Request | undefined;
  const panel = await run("panel", "", async (r) => { held = r; });
  check("a run a panel holds past the start bound reads unknown, naming the bound and the panel",
    panel.state?.kind === "unknown" && /did not start \/panel within 0\.4 s\. A panel or dialog open at the seat holds it/.test(panel.state.message), panel.state);
  const warned = warnings.length;
  check("...and its late answer is still accepted", held !== undefined && (await answer(held, { op: "run", outcome: "started" })) === 0 && warnings.length === warned, warnings);
}

/** Queue one turn and take it, with `mod` answering the prompt request the reader printed. */
async function turnRun(args: Record<string, unknown>, mod: (req: Request) => Promise<unknown>): Promise<{ state?: CommandState; seen?: Request }> {
  const { call, lane } = laneOver(dispatcher);
  const queued = await call("turn", args);
  if (!queued.ok) return {};
  const taking = lane.dispatchNext();
  const seen = await reader?.next();
  if (seen) await mod(seen);
  await Promise.race([taking, wait(3_000)]);
  const read = await call("command-state", { id: (queued.value as { id: string }).id });
  return { state: read.ok ? (read.value as { state: CommandState }).state : undefined, seen };
}

async function turning(): Promise<void> {
  const said = await turnRun({ text: "hello there" }, (r) => answer(r, { op: "prompt", outcome: "submitted" }));
  check("a turn asks the mod to submit the owner's words as they are", said.seen?.op === "prompt" && said.seen.text === "hello there", said.seen);
  check("a submitted prompt reads started", JSON.stringify(said.state) === '{"kind":"started"}', said.state);
  const dropped = await turnRun({ text: "hello" }, (r) => answer(r, { op: "prompt", outcome: "refused", reason: "a Stop stands" }));
  check("a prompt Claude drops reads refused, failed-precondition, with Claude's reason",
    JSON.stringify(dropped.state) === JSON.stringify({ kind: "refused", code: "failed-precondition", message: "a Stop stands" }), dropped.state);
  const red = Buffer.from("not really a png").toString("base64");
  const pictured = await turnRun({ text: "what is this?", images: [{ mimeType: "image/png", data: red }, { mimeType: "image/webp", data: red }] },
    (r) => answer(r, { op: "prompt", outcome: "submitted" }));
  const text = String(pictured.seen?.text ?? "");
  const paths = [...text.matchAll(/\[Image (\d): (.+)\]/g)].map((m) => m[2]!);
  check("a turn's images are named after its words, one line each",
    paths.length === 2 && text === `what is this?\n\n[Image 1: ${paths[0]}]\n\n[Image 2: ${paths[1]}]`, text);
  check("each image is a new owner-only file in the seat's folder, with its bytes and its type's extension",
    paths.every((p) => dirname(p) === imageDir && (statSync(p).mode & 0o777) === 0o600 && readFileSync(p).toString() === "not really a png") &&
      paths[0]!.endsWith("-1.png") && paths[1]!.endsWith("-2.webp"), paths);
  const only = await turnRun({ text: "", images: [{ mimeType: "image/gif", data: red }] }, (r) => answer(r, { op: "prompt", outcome: "submitted" }));
  check("a turn of an image alone names just the image", /^\[Image 1: .+-1\.gif\]$/.test(String(only.seen?.text)), only.seen?.text);
  const blind = laneOver(claudeCommands({ feed: () => feed, interrupting: () => undefined, warn: () => {} }));
  const noImages = await blind.call("turn", { text: "look", images: [{ mimeType: "image/png", data: red }] });
  check("with no image folder, a turn with images is unimplemented", /^unimplemented\/not-executed: .*takes no images/.test(refusal(noImages)), refusal(noImages));
}

async function usageReading(): Promise<void> {
  const { call } = laneOver(dispatcher);
  const ask = async (frame: Record<string, unknown>): Promise<Reply> => {
    const p = call("usage");
    const req = await reader!.next();
    await answer(req!, frame);
    return p;
  };
  const full = await ask({ op: "usage", window: 200000, tokens: 1234, usd: 0.5 });
  check("usage carries Claude's context tokens over its window, and its cost in USD",
    full.ok && JSON.stringify(full.value) === JSON.stringify({ supported: true, context: { used: 1234, size: 200000 }, cost: { amount: 0.5, currency: "USD" } }), full);
  const fresh = await ask({ op: "usage", window: 200000 });
  check("before Claude's first response, usage reports nothing it has not given", fresh.ok && JSON.stringify(fresh.value) === '{"supported":true}', fresh);
  const none = laneOver(claudeCommands({ feed: () => undefined, interrupting: () => undefined, warn: () => {} }));
  const off = await none.call("usage");
  check("with no command mod, usage is unavailable naming the cause", /^unavailable\/not-executed: .*named no Claude Code process/.test(refusal(off)), refusal(off));
  const offTurn = await none.call("turn", { text: "hi" });
  check("with no command mod, turn is unimplemented naming the cause", /^unimplemented\/not-executed: .*named no Claude Code process/.test(refusal(offTurn)), refusal(offTurn));
}

async function interrupting(): Promise<void> {
  const { call } = laneOver(dispatcher);
  const ask = async (frame: Record<string, unknown> | undefined): Promise<Reply> => {
    const p = call("interrupt");
    const req = await reader!.next();
    if (frame) await answer(req!, frame);
    return Promise.race([p, wait(3_000).then((): Reply => ({ ok: false, error: new Error("no reply within 3 s") }))]);
  };
  const stopped = await ask({ op: "interrupt", outcome: "interrupted" });
  check("an interrupt the mod made answers interrupted and ends the seat's turn",
    stopped.ok && JSON.stringify(stopped.value) === '{"state":"interrupted"}' && interrupted === 1, [stopped, interrupted]);
  const idle = await ask({ op: "interrupt", outcome: "idle" });
  check("with no turn running it answers idle and ends nothing", idle.ok && JSON.stringify(idle.value) === '{"state":"idle"}' && interrupted === 1, [idle, interrupted]);
  const leftover = await ask({ op: "interrupt", outcome: "interrupted", reason: "a tool is still running" });
  check("a tool left running still answers interrupted, and the seat's log names it",
    leftover.ok && JSON.stringify(leftover.value) === '{"state":"interrupted"}' && warnings.some((w) => w.includes("a tool is still running")), [leftover, warnings]);
  const broken = await ask({ op: "error", reason: "$.turn.abort threw" });
  check("an interrupt the mod could not serve is internal, outcome unknown", /^internal\/unknown: .*\$\.turn\.abort threw/.test(refusal(broken)), refusal(broken));
  const silent = await ask(undefined);
  check("an interrupt with no answer within its bound is internal, outcome unknown", /^internal\/unknown: .*did not answer within 0\.4 s/.test(refusal(silent)), refusal(silent));
}

async function readerLeaves(): Promise<void> {
  const { call, lane, run } = laneOver(dispatcher);
  const gone = await run("deploy", "", async () => { reader!.child.kill("SIGTERM"); });
  check("a run whose reader leaves before it answers reads unknown", gone.state?.kind === "unknown" && /reader disconnected/.test(gone.state.message), gone.state);
  reader = startReader("2.1.330");
  await until(() => feed.unsupported() === undefined);
  const queued = await call("command", { target: "command", name: "deploy" });
  const queuedTurn = await call("turn", { text: "hi" });
  reader.child.kill("SIGTERM");
  await until(() => feed.unsupported() !== undefined);
  reader = undefined;
  await lane.dispatchNext();
  await lane.dispatchNext();
  const stateOf = async (r: Reply) => {
    const state = r.ok ? await call("command-state", { id: (r.value as { id: string }).id }) : r;
    return state.ok ? (state.value as { state: CommandState }).state : undefined;
  };
  const s = await stateOf(queued);
  check("a command queued while the mod served and taken after it left reads refused, failed-precondition, naming the cause",
    s?.kind === "refused" && s.code === "failed-precondition" && /the command mod is not running/.test(s.message), s);
  const t = await stateOf(queuedTurn);
  check("...and so does a turn",
    t?.kind === "refused" && t.code === "failed-precondition" && /the command mod is not running/.test(t.message), t);
}

/** A seat the queue drives: its presence status, its queue, and each dispatch the suite settles. */
class FakeSeat extends EventEmitter {
  status: PresenceStatus = "idle";
  readonly queue: string[] = [];
  readonly taken: string[] = [];
  readonly settle: ((d: CommandDispatch) => void)[] = [];
  get queuedCommands(): number { return this.queue.length; }
  dispatchNextCommand(): Promise<CommandDispatch> {
    this.taken.push(this.queue.shift()!);
    return new Promise((resolve) => this.settle.push(resolve));
  }
}

async function queueing(): Promise<void> {
  const seat = new FakeSeat();
  const turns = commandTurns(seat as never);
  seat.queue.push("a");
  seat.emit("command");
  check("an idle seat takes a queued command at once", seat.taken.join() === "a");
  seat.queue.push("b");
  seat.emit("command");
  seat.settle.shift()!("dispatched");
  await wait(200);
  check("the next command waits while the one before it starts its turn", seat.taken.join() === "a");
  seat.status = "working";
  await wait(1_100);
  check("a seat running a turn takes no command", seat.taken.join() === "a");
  seat.status = "idle";
  turns.idle();
  check("the turn's end takes the next command", seat.taken.join() === "a,b");
  seat.settle.shift()!("failed");
  seat.queue.push("c");
  seat.status = "waiting";
  seat.emit("command");
  await wait(50);
  check("a seat waiting on a dialog takes no command", seat.taken.join() === "a,b");
}

const cfg: AgentConfig = {
  space: "smoke", name: "seat", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};

async function hookTurns(): Promise<void> {
  const agent = new MeshAgent(cfg);
  (agent as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "seat" },
    setStatus: async () => {}, setCondition: async () => {}, noteActivity() {}, setActivity: async () => {}, setAttention: async () => {},
    joinedChannels: () => [], getChannelConfig: () => undefined,
    invokeService: async () => ({ reply: { ok: true, data: { turns: [] } } }),
  };
  (agent as unknown as { _connected: boolean })._connected = true;
  let idles = 0;
  const claude = createClaudeHandle({ idle: () => { idles++; } });
  const frame = (name: string): HookEvent => ({ hook_event_name: name, transcript_path: join(scratch, "none.jsonl") });
  await claude.handle(agent, frame("UserPromptSubmit"));
  const end = claude.interrupting(agent);
  await end();
  check("a remote interrupt ends the hooks' open turn: the seat reads idle and the queue is told", agent.status === "idle" && idles === 1, [agent.status, idles]);
  await claude.handle(agent, frame("UserPromptSubmit"));
  const stale = claude.interrupting(agent);
  await claude.handle(agent, frame("Stop"));
  check("a turn's Stop tells the queue", agent.status === "idle" && idles === 2, [agent.status, idles]);
  await claude.handle(agent, frame("UserPromptSubmit"));
  await stale();
  check("an interrupt's end leaves a turn that opened after it working", agent.status === "working" && idles === 2, [agent.status, idles]);
}

try {
  feed = await openCommandFeed(process.pid, { warn: (msg) => warnings.push(msg) });
  await unsupported();
  await listing();
  await running();
  await turning();
  await usageReading();
  await interrupting();
  await readerLeaves();
  await queueing();
  await hookTurns();
  feed.close();
  console.log("command-dispatcher.smoke: done");
} catch (e) {
  check("the suite ran to its end", false, (e as Error).stack);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
  check(`the suite ran its ${EXPECTED_CELLS} cells`, passed() + failed() === EXPECTED_CELLS, passed() + failed());
  finish();
  process.exit();
}
