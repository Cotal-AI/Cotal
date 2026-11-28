/**
 * The ACP agent's protocol promises, driven by the ACP SDK's own client over an in-process
 * connection, against a fake space. No broker, no manager.
 *
 *  - `initialize` offers session load, list and delete, and a terminal sign-in only to a client that
 *    can run one and has a target for the action;
 *  - opening the space fails as -32000 when signing in fixes it, and as an internal error otherwise;
 *  - `session/new` launches nothing and offers `<agent>/default` first, without applications that
 *    publish no event plane; deleting it hides nothing;
 *  - on the wire, `session/new` carries the model state: every model of the select, each with its
 *    reasoning choices as `_meta.reasoningEfforts` or `supportsReasoningEffort: false`, and the
 *    reasoning select is offered on a fresh session at an application's default;
 *  - the first prompt spawns the seat in the session's folder with that prompt, every update of the
 *    turn reaches the client before the prompt answers, frames that beat the spawn reply are kept,
 *    and a tool call left open is closed;
 *  - an application whose catalog lists a model with id `default` spawns naming that model, with the
 *    chosen variant; without one, `<agent>/default` spawns naming no model;
 *  - a failed run fails the prompt with the seat's message; with each connector's failure condition,
 *    one that arrives after the run's error too, the error carries the harness's own text and kind,
 *    and with none it still says the turn failed; a condition from before the prompt or an approval
 *    condition is not the turn's failure;
 *  - a later prompt is a direct message, and answers once the seat stopped working and the runs it
 *    started ended, or once the seat did not start on it in time;
 *  - a cancel interrupts the seat through its manager and answers `cancelled` however the run ends,
 *    including a cancel that beats the spawn reply; a refused interrupt is said in the thread;
 *  - `session/list` hides deleted runs and matches a folder through symlinks;
 *  - `session/load` replays before it answers, marked as replay, then follows live; a seat whose
 *    launch lists the caller may not read loads with only its own model and cannot start another
 *    after `/despawn`, and one running the model `default` offers it once; a seat no manager listed
 *    while one did not answer is not called missing, and deleting it fails;
 *  - a running seat whose application's models the manager could not read loads and opens on its
 *    model, and after `/despawn` the thread still refuses to start that application;
 *  - with no manager registered, list, load, /open and delete say so, start none, and list nothing
 *    in its place;
 *  - with only another computer's manager live, a new session starts this machine's manager and
 *    defaults to it, and uses the other computer only when Machine names it; a failed start, or one
 *    whose manager is still not listed here, fails the session;
 *  - the selects hold the chosen machine's applications: choosing a machine whose manager reports an
 *    application unavailable offers it in neither select, moves the selection to that machine's
 *    default, refuses the application with the manager's reason, and a prompt starts the default;
 *  - `cotal manager status` output names the native instance of this machine's running manager
 *    service, and names none when it is gone, never started or refused;
 *  - the slash commands answer locally, and `/despawn` stops the seat;
 *  - a persona catalog or channel list longer than a client select offers a short select holding the
 *    caller's own personas, or the described and busiest channels, and `/persona` and `/join` pick
 *    any by exact name while the thread has no agent; a list that fits keeps its full select;
 *  - `/name` before the first prompt names the seat the thread spawns, refuses a name the manager
 *    would refuse, and on a running seat changes the name it shows or says why not;
 *  - `/open` drives a running seat found by its name or shown name from a thread with no agent,
 *    replays what the space retains, sends the seat's options, and stores the thread's link; it
 *    refuses in a thread that already drives one, and names the choices when two seats match;
 *  - a linked thread is listed under its own id with the seat's shown name, and loads and deletes
 *    through its link;
 *  - the thread is titled with the name its seat shows once the seat starts, after `/name`, on `/open`
 *    and on a load, not marked as replay, and whenever its presence shows another name, as a label or
 *    a rename made elsewhere; a refused rename, an unchanged name or a seat the roster stops showing
 *    sends no title;
 *  - where the session lists a thread server (a stand-in for T3 Code's `t3-code` MCP server), the
 *    bridge starts it with only the variables the client gave and sets the client's own title through
 *    it too, and a listed server without the thread tools is listed once and never called; a rename in
 *    the client labels the agent before the next prompt reaches it, keeps its name, and is not written
 *    back; a title the bridge wrote is not read back as a rename; a read the server fails, or a label
 *    the agent refuses, is said in the thread and logged, and the prompt still runs; a refused title
 *    goes back to the agent's name; each title the bridge wrote or read is stored with the thread's
 *    link; a second session of the same bridge starts the server with its own variables and lists
 *    no server again; and a load in a new bridge labels the agent with a title the person gave the
 *    thread while no bridge ran, and otherwise titles the thread with the name the agent shows, as it
 *    does when the link stored no title;
 *  - where seats serve their `agent` endpoint, a prompt the harness opens is asked once as a
 *    permission request, without options ACP cannot answer and only when its digest matches, and the
 *    answer goes back with that digest; a prompt whose read fails once is logged, read again and
 *    asked once; a prompt opened while the thread runs no turn is asked on its next prompt, whose
 *    turn stays open until the client answers; the seat's commands and skills are offered and run through
 *    `command`, and a refused one is said in the thread. Where they do not, nothing calls it;
 *  - on a running thread, choosing a model or a reasoning variant of the seat's application switches
 *    the seat through its `set-model`, and the options show the choice; the seat's refusal fails the
 *    choice with its reason; another application and an option that applies at spawn are refused
 *    naming `/despawn`, and so is a seat whose connector cannot switch, naming its harness and the
 *    cause the seat gives, or nothing is called when the seat predates `set-model`;
 *  - a prompt or seat command the seat queues behind work the thread did not start answers once its
 *    own run ends, however long it waited. Cancelled while still queued, it leaves the queue through
 *    `command-cancel` and the other work is not interrupted; cancelled once taken, its run is; its
 *    seat leaving fails it with that reason.
 *
 * Run: pnpm --filter @cotal-ai/acp test
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type McpServerStdio, type NewSessionResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { agentPromptDigest, assertValidOwnerToken, type AgentPrompt, type PromptContent, type PromptSummary } from "@cotal-ai/core";
import { cotalAgent, defaultName, type HiddenSessions, type ThreadLink, type ThreadLinks } from "../src/agent.js";
import { MAX_CHOICES } from "../src/options.js";
import { promptParts } from "../src/turns.js";
import { recordedInstance, startFailure, startLine } from "../src/manager-start.js";
import { AgentCallFailed, LaunchListsRefused, NoLaunchManager, NoManagerRegistered, SignInRequired, type AgentCatalog, type AgentEndpointServes, type AguiEventLike, type ManagerChoice, type Mesh, type PromptCounter, type SeatFrame, type SeatRef, type SeatRow, type SpawnRequest } from "../src/mesh.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A prompt that never answers is a failed check, not a hung suite. */
const within = <T>(p: Promise<T>, ms = 5000): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);

const dir = mkdtempSync(join(tmpdir(), "acp-smoke-"));
const link = join(dir, "link");
symlinkSync(dir, link);

const CATALOGS: AgentCatalog[] = [
  { agent: "hermes", available: true, eventPlane: false, models: [] },
  { agent: "claude", available: true, eventPlane: true, models: [{ id: "opus", variants: ["high", "low"] }, { id: "sonnet", variants: ["low"] }, { id: "haiku", variants: [] }] },
  { agent: "pi", available: true, eventPlane: true, models: [] },
];

/** A presence condition (SPEC §6) as a connector writes it. */
type Condition = { code: string; source?: string; message?: string; since?: number };

/** A space held in memory. A test scripts what a seat publishes with `script`. */
class FakeMesh implements Mesh {
  readonly space = "fake";
  readonly defaultAgent = "claude";
  spawned: SpawnRequest[] = [];
  despawned: string[] = [];
  rows: SeatRow[] = [];
  history = new Map<string, SeatFrame[]>();
  /** Presence status by actor. */
  present = new Map<string, string>();
  typed: { seat: string; text: string }[] = [];
  /** The manager each typed prompt was sent to, as the seat reference names it. */
  typedTo: (string | undefined)[] = [];
  /** Managers that did not answer the list. */
  silent: string[] = [];
  /** The silent managers that are the person's own registrations and did not answer. */
  removable: string[] = [];
  /** The caller may not read the launch lists. */
  launchRefused = false;
  /** What a seat does when its manager types a prompt into it. A throw is the manager's refusal. */
  onInput: (seat: SeatRef) => void = () => {};
  /** How long the manager takes to answer an input request. */
  inputDelay = 0;
  interrupted: string[] = [];
  /** What a seat does when its manager writes the interrupt key. A throw is the manager's refusal. */
  onInterrupt: (seat: SeatRef) => void = () => {};
  spawnDelay = 0;
  closed = false;
  agentCalls: { seat: string; command: string; args: Record<string, unknown> }[] = [];
  /** What a seat's agent endpoint answers. A throw is its refusal. */
  onAgentCall: (seat: SeatRef, command: string, args: Record<string, unknown>) => unknown = () => { throw new AgentCallFailed("no agent endpoint here", "unavailable"); };
  /** Prompt counters by actor, as presence carries them. */
  counters = new Map<string, PromptCounter>();
  /** What a seat's presence says its agent endpoint serves, shown with its prompt counter as presence
   *  shows both under one gate: by actor, else `serving`. */
  serves = new Map<string, AgentEndpointServes>();
  serving: AgentEndpointServes | undefined;
  /** Frames a spawned seat publishes: `before` ahead of the spawn reply, `after` once it answered. */
  script: { before: AguiEventLike[][]; after: AguiEventLike[][] } = { before: [], after: [] };
  /** The condition each seat's presence carries, by actor, with when this process saw it arrive. */
  conditions = new Map<string, { condition: Condition; at: number }>();
  /** A condition a spawned seat's presence takes `ms` after its spawn reply. */
  failWith: { condition: Condition; ms: number } | undefined;
  private listeners: ((f: SeatFrame) => void)[] = [];
  private seq = 0;

  emit(seat: SeatRef, events: AguiEventLike[], runId = "r1"): void {
    const f: SeatFrame = { plane: "events", owner: seat.owner, actor: seat.actor, threadId: "t", runId, epoch: "e", seq: ++this.seq, events, ts: Date.now() };
    for (const l of this.listeners) l(f);
  }
  catalogsAsked: (string | undefined)[] = [];
  catalogList: AgentCatalog[] = CATALOGS;
  async catalogs(instanceId?: string) {
    this.catalogsAsked.push(instanceId);
    if (this.launchRefused) throw new LaunchListsRefused("the manager did not report its applications: permission-denied");
    return this.catalogList;
  }
  managerList: ManagerChoice[] = [{ instanceId: "m1", host: "here", local: true, live: true }, { instanceId: "m2", host: "there", local: false }];
  /** The managers described one at a time, in order. */
  described: string[] = [];
  /** Managers that refuse to be described, as one that stopped. */
  gone = new Set<string>();
  async manager(instanceId: string): Promise<ManagerChoice> {
    this.described.push(instanceId);
    if (this.gone.has(instanceId)) throw new Error(`manager instance ${instanceId} is not registered`);
    return { instanceId, host: `host-${instanceId}`, local: false };
  }
  /** Why no manager may start a new agent, when none may. */
  noLaunch: string | undefined;
  managersRead = 0;
  async managers() {
    this.managersRead++;
    if (this.noLaunch) throw new NoLaunchManager(this.noLaunch);
    return this.managerList;
  }
  /** How many times this machine's manager was started, and what a start does. A throw is its refusal. */
  starts = 0;
  onStart: () => string = () => { throw new NoLaunchManager("Could not start this machine's manager for fake: no start scripted"); };
  async startManager() {
    this.starts++;
    return this.onStart();
  }
  /** Why this machine's identity could not be read, when it could not. */
  unreadable: string | undefined;
  machineUnreadable() {
    return this.unreadable;
  }
  /** Each manager holds its own persona catalog. */
  personasAsked: (string | undefined)[] = [];
  async personas(instanceId?: string) {
    this.personasAsked.push(instanceId);
    if (this.launchRefused) throw new LaunchListsRefused("the manager did not list its personas: permission-denied");
    return (instanceId === "m2" ? ["default", "builder"] : ["default", "reviewer"]).map((name) => ({ name }));
  }
  async spawn(req: SpawnRequest): Promise<SeatRef> {
    this.spawned.push(req);
    if (this.spawnDelay) await tick(this.spawnDelay);
    const seat: SeatRef = { name: req.name, owner: "local", actor: `actor-${req.name}`, lifecycleUid: `life-${req.name}`, managerInstanceId: req.managerInstanceId ?? "m1" };
    this.present.set(seat.actor, "working");
    for (const e of this.script.before) this.emit(seat, e);
    const after = this.script.after;
    setTimeout(() => { for (const e of after) this.emit(seat, e); }, 10);
    const failWith = this.failWith;
    if (failWith) setTimeout(() => this.conditions.set(seat.actor, { condition: failWith.condition, at: Date.now() }), failWith.ms);
    return seat;
  }
  async seats() { return { rows: this.rows, silent: this.silent, removable: this.removable }; }
  renamed: { seat: string; name: string }[] = [];
  /** Why the agent refuses a rename, when it does. */
  renameRefusal: string | undefined;
  async rename(seat: SeatRef, name: string) {
    if (this.renameRefusal) throw new Error(this.renameRefusal);
    this.renamed.push({ seat: seat.name, name });
    return name;
  }
  relabelled: { seat: string; label: string }[] = [];
  /** Why the agent refuses a label, when it does. */
  labelRefusal: string | undefined;
  async relabel(seat: SeatRef, label: string) {
    if (this.labelRefusal) throw new Error(this.labelRefusal);
    this.relabelled.push({ seat: seat.name, label });
    this.show(seat.actor, label);
    return label;
  }
  spawnNameError(name: string) { return /^[a-z0-9_]+$/.test(name) ? undefined : `unsafe name ${JSON.stringify(name)}`; }
  async despawn(seat: SeatRef) { this.despawned.push(seat.name); }
  async interrupt(seat: SeatRef) { this.onInterrupt(seat); this.interrupted.push(seat.name); }
  async agentCall(seat: SeatRef, command: string, args: Record<string, unknown>) {
    this.agentCalls.push({ seat: seat.name, command, args });
    return this.onAgentCall(seat, command, args);
  }
  promptCounter(seat: SeatRef) { return this.counters.get(seat.actor); }
  served(seat: SeatRef) { return this.counters.has(seat.actor) ? this.serves.get(seat.actor) ?? this.serving : undefined; }
  async input(seat: SeatRef, text: string) {
    this.onInput(seat);
    if (this.inputDelay) await tick(this.inputDelay);
    this.typed.push({ seat: seat.name, text });
    this.typedTo.push(seat.managerInstanceId);
  }
  followFrames(on: (f: SeatFrame) => void) { this.listeners.push(on); return () => (this.listeners = this.listeners.filter((l) => l !== on)); }
  async frameHistory(seat: SeatRef) { return this.history.get(seat.name) ?? []; }
  presence(seat: SeatRef) { return this.present.get(seat.actor); }
  /** The name each seat's presence shows, by actor. */
  shown = new Map<string, string>();
  private rosterListeners: (() => void)[] = [];
  /** Show `name` in a seat's presence, as a label it takes or a rename made elsewhere does. Undefined:
   *  the roster no longer shows the seat. */
  show(actor: string, name: string | undefined): void {
    if (name === undefined) this.shown.delete(actor);
    else this.shown.set(actor, name);
    for (const l of this.rosterListeners) l();
  }
  shownName(seat: SeatRef) { return this.shown.get(seat.actor); }
  followRoster(on: () => void) { this.rosterListeners.push(on); return () => (this.rosterListeners = this.rosterListeners.filter((l) => l !== on)); }
  condition(seat: SeatRef, since: number) {
    const held = this.conditions.get(seat.actor);
    return held && held.at >= since ? held.condition : undefined;
  }
  async roster() { return [{ name: "alice", status: "idle", role: "reviewer" }]; }
  async channels() { return [{ channel: "general", messages: 3 }, { channel: "ops", messages: 1 }]; }
  async close() { this.closed = true; }
}

/** A space with more personas and channels than a client select shows. */
class BigMesh extends FakeMesh {
  override async personas(instanceId?: string) {
    this.personasAsked.push(instanceId);
    return [{ name: "default" }, { name: "mine-a", own: true as const }, { name: "mine-b", own: true as const }, ...Array.from({ length: 70 }, (_, i) => ({ name: `p-${String(i).padStart(2, "0")}` }))];
  }
  override async channels() {
    return [{ channel: "ops", messages: 0, description: "Deploys and incidents." }, ...Array.from({ length: 70 }, (_, i) => ({ channel: `ch-${String(i).padStart(2, "0")}`, messages: i }))];
  }
}

class MemoryLinks implements ThreadLinks {
  readonly rows: (ThreadLink & { space: string })[] = [];
  read(space: string) { return this.rows.filter((row) => row.space === space).map((row) => ({ thread: row.thread, lifecycleUid: row.lifecycleUid, ...(row.title !== undefined ? { title: row.title } : {}) })); }
  add(space: string, link: ThreadLink) { this.rows.push({ space, ...link }); }
}

class MemoryHidden implements HiddenSessions {
  readonly ids = new Set<string>();
  read() { return new Set(this.ids); }
  add(id: string) { this.ids.add(id); }
}

function connect(open: () => Promise<Mesh>, terminal = true, canSignIn = async () => true) {
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  const answers: { pick: (r: RequestPermissionRequest) => RequestPermissionResponse | Promise<RequestPermissionResponse> } = { pick: () => ({ outcome: { outcome: "cancelled" } }) };
  const hidden = new MemoryHidden();
  const links = new MemoryLinks();
  const logs: string[] = [];
  let n = 0;
  const app = cotalAgent({ mesh: open, hidden, links, log: (line) => void logs.push(line), version: "0.0.0-smoke", newName: () => `acp-s${++n}`, waits: { startMs: 300, settleMs: 100 }, canSignIn });
  const conn = client({ name: "smoke" })
    .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
    .onRequest(methods.client.session.requestPermission, async ({ params }) => { asked.push(params); return answers.pick(params); })
    .connect(app);
  const init = conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: terminal ? { auth: { terminal: true } } : {} });
  return { agent: conn.agent, conn, updates, hidden, links, init, asked, answers, logs };
}
const errorOf = async (p: Promise<unknown>): Promise<{ code?: number; message?: string; data?: unknown } | undefined> => {
  try { await p; return undefined; } catch (e) { return e as { code?: number; message?: string; data?: unknown }; }
};

// initialize and sign-in
{
  const { init, conn } = connect(async () => new FakeMesh());
  const r = await init;
  check("initialize offers load, list and delete", r.agentCapabilities?.loadSession === true && r.agentCapabilities.sessionCapabilities?.list !== undefined && r.agentCapabilities.sessionCapabilities?.delete !== undefined, r);
  check("a client that runs terminals is offered the terminal sign-in", r.authMethods?.length === 1 && (r.authMethods[0] as { args?: string[] }).args?.[0] === "--auth", r.authMethods);
  conn.close();
  const other = connect(async () => new FakeMesh(), false);
  check("a client that runs no terminal is offered no sign-in", (await other.init).authMethods?.length === 0);
  other.conn.close();
  const open = connect(async () => new FakeMesh(), true, async () => false);
  check("a target without a terminal action offers no sign-in", (await open.init).authMethods?.length === 0);
  open.conn.close();
}
{
  const signIn = connect(async () => { throw new SignInRequired("sign in first"); });
  await signIn.init;
  const e = await errorOf(signIn.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("a space that needs a sign-in fails session/new with -32000", e?.code === -32000, e);
  signIn.conn.close();
  const down = connect(async () => { throw new Error("broker down"); });
  await down.init;
  const d = await errorOf(down.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("any other failure to open is an internal error naming it", d?.code === -32603 && d.message?.includes("broker down") === true, d);
  down.conn.close();
}

// Remote live, no local: only another computer's manager is live, so a new thread starts this
// machine's manager and defaults to it, and the other computer is used only when Machine names it.
{
  const space = new FakeMesh();
  const line = "Started this machine's manager for fake. It stops itself after 10 minutes with no agents.";
  const far: ManagerChoice = { instanceId: "m2", host: "there", local: false, live: true };
  const near: ManagerChoice = { instanceId: "m1", host: "here", local: true, live: true };
  space.managerList = [far];
  space.onStart = () => { space.managerList = [near, far]; return line; };
  const c = connect(async () => space);
  await c.init;
  const chunks = (sessionId: string) => c.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text);
  const machineIn = (r: { configOptions?: unknown[] | null } | undefined) => {
    const o = r?.configOptions?.find((x) => (x as { id: string }).id === "machine") as { currentValue?: string; options?: { value: string }[] } | undefined;
    return { current: o?.currentValue, choices: (o?.options ?? []).map((x) => x.value) };
  };
  const opened = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }).catch((e: unknown) => e as undefined);
  await tick();
  check("remote live, no local: a new thread starts this machine's manager before it offers anything", space.starts === 1 && space.catalogsAsked[0] === "m1", { starts: space.starts, asked: space.catalogsAsked });
  check("and defaults to it, with the other computer as a Machine choice", JSON.stringify(machineIn(opened)) === JSON.stringify({ current: "m1", choices: ["m1", "m2"] }), machineIn(opened));
  const sid = (opened as { sessionId?: string } | undefined)?.sessionId ?? "none";
  // A client may drop a line sent outside a turn, as T3 Code keeps one only in a loaded thread's history.
  check("and says nothing before its first prompt", opened !== undefined && chunks(sid).length === 0, chunks(sid));
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "hi" }, { type: "TEXT_MESSAGE_END", messageId: "a" }, { type: "RUN_FINISHED", runId: "r1" }]] };
  const before = c.updates.length;
  const here = await within(c.agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "go" }] }).catch((e: unknown) => e as undefined));
  check("its first prompt spawns on this machine's manager", here?.stopReason === "end_turn" && space.spawned.at(-1)?.managerInstanceId === "m1", { here, pins: space.spawned.map((r) => r.managerInstanceId) });
  const turn = c.updates.slice(before).filter((u) => u.sessionId === sid && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text);
  check("and its turn says in one line that it started the manager, before the reply, and only there",
    JSON.stringify(turn) === JSON.stringify([`${line}\n\n`, "hi"]) && JSON.stringify(chunks(sid)) === JSON.stringify(turn), { turn, all: chunks(sid) });
  const other = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  await c.agent.request(methods.agent.session.setConfigOption, { sessionId: other.sessionId, configId: "machine", value: "m2" });
  // This machine's manager stopped itself, and the thread's Machine names the other computer.
  space.managerList = [far];
  const starts = space.starts;
  const there = await within(c.agent.request(methods.agent.session.prompt, { sessionId: other.sessionId, prompt: [{ type: "text", text: "go" }] }).catch((e: unknown) => e as undefined));
  check("a thread whose Machine names another computer spawns there and starts no manager here", there?.stopReason === "end_turn" && space.spawned.at(-1)?.managerInstanceId === "m2" && space.starts === starts, { there, starts: space.starts - starts, pins: space.spawned.map((r) => r.managerInstanceId) });
  // A start after which the space still lists no manager of this machine's fails the thread.
  space.onStart = () => line;
  const unlisted = await errorOf(c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("a start whose manager the space does not list here fails the new thread, saying so", unlisted?.code === -32603 && unlisted.message === "Started this machine's manager for fake, but the space does not list it as running here yet. Open the thread again in a moment.", unlisted);
  space.onStart = () => { throw new NoLaunchManager("Could not start this machine's manager for fake: the manager did not start: boom"); };
  const failed = await errorOf(c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("remote live, no local: a failed start fails the new thread with the start's reason", failed?.code === -32603 && failed.message === "Could not start this machine's manager for fake: the manager did not start: boom", failed);
  c.conn.close();
}
// This machine's identity could not be read, as in a container with no /etc/machine-id: no manager is
// known to run here. A new thread offers the listed managers with none chosen and starts none, a
// prompt with none chosen says why, and a thread whose Machine names one runs there.
{
  const space = new FakeMesh();
  const why = "ENOENT: no such file or directory, open '/etc/machine-id'";
  const linux = process.platform === "linux";
  space.unreadable = why;
  space.managerList = [{ instanceId: "m2", host: "there", local: false, live: true }];
  const c = connect(async () => space);
  await c.init;
  const opened = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }).catch((e: Error) => e);
  const machine = opened instanceof Error ? undefined : opened.configOptions?.find((o) => o.id === "machine") as { currentValue?: string; options?: { value: string }[] } | undefined;
  check("with this machine's identity unread, a new thread opens with no Machine chosen and starts no manager",
    space.starts === 0 && machine?.currentValue === "none" && JSON.stringify(machine.options?.map((o) => o.value)) === JSON.stringify(["none", "m2"]), { starts: space.starts, opened: opened instanceof Error ? opened.message : machine });
  const sid = opened instanceof Error ? "none" : opened.sessionId;
  const unchosen = await errorOf(c.agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "go" }] }));
  check("and its prompt with none chosen fails with the reason and starts none", space.starts === 0 && space.spawned.length === 0 && unchosen?.code === -32602 && unchosen.message === (linux
    ? "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here. Create /etc/machine-id with `systemd-machine-id-setup` and open a new thread, or choose a machine in the Machine option."
    : "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here. Choose a machine in the Machine option."), { starts: space.starts, unchosen });
  await c.agent.request(methods.agent.session.setConfigOption, { sessionId: sid, configId: "machine", value: "m2" }).catch(() => undefined);
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  const there = await within(c.agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "go" }] }).catch((e: unknown) => e as undefined));
  check("a thread whose Machine names a manager runs there without this machine's identity", there?.stopReason === "end_turn" && space.spawned.at(-1)?.managerInstanceId === "m2" && space.starts === 0, { there, starts: space.starts });
  space.managerList = [];
  const none = await errorOf(c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("with no manager listed, a new thread fails with the reason and starts none", space.starts === 0 && none?.code === -32603 && none.message === (linux
    ? "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here and starts none. Create /etc/machine-id with `systemd-machine-id-setup` and open a new thread, or start a manager with `cotal manager start --space fake` and choose it in the Machine option."
    : "This machine's identity could not be read (ENOENT: no such file or directory, open '/etc/machine-id'), so Cotal cannot tell which manager runs here and starts none. Start a manager with `cotal manager start --space fake` and choose it in the Machine option."), { starts: space.starts, none });
  c.conn.close();
}
// Each manager reports its own applications. OpenCode runs on m1, and m2's status row says it is not
// installed there. A thread that chooses m2 offers only what m2 can run and starts there on m2's
// default, and choosing m1 again offers OpenCode again.
{
  const missing = "opencode harness needs opencode on PATH - not found";
  const space = new FakeMesh();
  space.managerList = [{ instanceId: "m1", host: "here", local: true, live: true }, { instanceId: "m2", host: "there", local: false, live: true }];
  const byManager = new Map<string | undefined, AgentCatalog[]>([
    ["m1", [...CATALOGS, { agent: "opencode", available: true, eventPlane: true, models: [{ id: "gpt", variants: ["high"] }] }]],
    ["m2", [...CATALOGS, { agent: "opencode", available: false, eventPlane: true, reason: missing, models: [] }]],
  ]);
  space.catalogs = async (instanceId?: string) => { space.catalogsAsked.push(instanceId); return byManager.get(instanceId) ?? []; };
  const c = connect(async () => space);
  await c.init;
  type Opts = readonly { id: string; currentValue?: unknown; options?: unknown }[] | null | undefined;
  const offered = (o: Opts) => {
    const model = o?.find((x) => x.id === "model") as { currentValue?: string; options?: { group: string; options: { value: string }[] }[] } | undefined;
    const agent = o?.find((x) => x.id === "agent") as { options?: { value: string }[] } | undefined;
    const variant = o?.find((x) => x.id === "reasoning") as { currentValue?: string } | undefined;
    return { model: model?.currentValue, variant: variant?.currentValue, groups: (model?.options ?? []).map((g) => g.group), harnesses: (agent?.options ?? []).map((x) => x.value) };
  };
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const set = (configId: string, value: string) => c.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId, value });
  check("on a machine that runs OpenCode, the selects offer it", offered(s.configOptions).groups.includes("opencode") && offered(s.configOptions).harnesses.includes("opencode"), offered(s.configOptions));
  await set("model", "opencode/gpt");
  await set("reasoning", "high");
  const moved = await set("machine", "m2");
  check("choosing a machine whose manager says OpenCode is unavailable offers it in neither select", !offered(moved.configOptions).groups.includes("opencode") && !offered(moved.configOptions).harnesses.includes("opencode"), offered(moved.configOptions));
  check("and the selection moves to that machine's default", offered(moved.configOptions).model === "claude/default" && offered(moved.configOptions).variant === "default", offered(moved.configOptions));
  const refused = await errorOf(set("model", "opencode/default"));
  check("choosing OpenCode there is refused with the manager's reason", refused?.code === -32602 && refused.message?.includes(missing) === true, refused);
  const back = await set("machine", "m1");
  check("choosing the first machine again offers OpenCode again", offered(back.configOptions).groups.includes("opencode") && offered(back.configOptions).harnesses.includes("opencode"), offered(back.configOptions));
  await set("model", "opencode/gpt");
  await set("machine", "m2");
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  const ran = await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }).catch((e: unknown) => e as undefined));
  check("a prompt there starts that machine's default, not OpenCode", ran?.stopReason === "end_turn" && space.spawned.at(-1)?.managerInstanceId === "m2" && space.spawned.at(-1)?.agent === "claude", { ran, spawned: space.spawned.at(-1) });
  c.conn.close();
}
// a thread no manager may start starts this machine's manager
{
  const space = new FakeMesh();
  const line = "Started this machine's manager for fake. It stops itself after 10 minutes with no agents.";
  space.noLaunch = "the space lists no live manager for you";
  space.onStart = () => { space.noLaunch = undefined; return line; };
  const c = connect(async () => space);
  await c.init;
  const chunks = (sessionId: string) => c.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text);
  const opened = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  await tick();
  check("a new thread no manager may start starts this machine's manager, then reads the managers again", space.starts === 1 && space.managersRead === 2, { starts: space.starts, reads: space.managersRead });
  check("the thread opens on it with its lists", space.catalogsAsked.at(-1) === "m1" && opened.configOptions?.some((o) => o.id === "model") === true, space.catalogsAsked);
  check("and says nothing before its first prompt", chunks(opened.sessionId).length === 0, chunks(opened.sessionId));
  const plain = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  await tick();
  check("a new thread while a manager is live starts none and says nothing", space.starts === 1 && chunks(plain.sessionId).length === 0, space.starts);
  // The manager stopped itself while the thread waited for its first prompt.
  space.noLaunch = "the space lists no live manager for you";
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  const reply = await within(c.agent.request(methods.agent.session.prompt, { sessionId: plain.sessionId, prompt: [{ type: "text", text: "go" }] }));
  check("a first prompt after the manager stopped starts it again before the spawn", space.starts === 2 && space.spawned.length === 1 && reply?.stopReason === "end_turn", { starts: space.starts, spawned: space.spawned.length, reply });
  check("and the turn says so in one line, kept clear of the reply", chunks(plain.sessionId).includes(`${line}\n\n`), chunks(plain.sessionId));
  const reads = space.managersRead;
  space.noLaunch = "none of your managers is live (m9: offline)";
  space.onStart = () => { throw new NoLaunchManager("Could not start this machine's manager for fake: the manager did not start: boom"); };
  const failed = await errorOf(c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("a failed start fails the new thread with the start's reason", failed?.code === -32603 && failed.message === "Could not start this machine's manager for fake: the manager did not start: boom", failed);
  check("and nothing is read or started after it", space.starts === 3 && space.managersRead === reads + 1, { starts: space.starts, reads: space.managersRead - reads });
  c.conn.close();
}
// With no manager registered, as once the last one stopped itself, list and load say so. Neither starts
// a manager, and the list is not answered empty in place of the refusal.
{
  const space = new FakeMesh();
  space.seats = async () => { throw new NoManagerRegistered("fake"); };
  const c = connect(async () => space);
  await c.init;
  const listed = await errorOf(c.agent.request(methods.agent.session.list, { cwd: dir }));
  check("with no manager registered, session/list refuses, saying so and that a new thread starts this machine's manager",
    listed?.code === -32603 && listed.message === "No live manager is registered for fake, so no thread is listed. A new thread starts this machine's manager.", listed);
  const loaded = await errorOf(c.agent.request(methods.agent.session.load, { sessionId: "kept", cwd: dir, mcpServers: [] }));
  check("and session/load refuses the same way, naming the thread",
    loaded?.code === -32603 && loaded.message === "kept is not listed, because no live manager is registered for fake. A new thread starts this machine's manager.", loaded);
  const opened = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const open = await errorOf(c.agent.request(methods.agent.session.prompt, { sessionId: opened.sessionId, prompt: [{ type: "text", text: "/open kept" }] }));
  check("/open refuses the same way, naming the agent it asked for",
    open?.code === -32603 && open.message === "kept is not listed, because no live manager is registered for fake. A new thread starts this machine's manager.", open);
  const deleted = await errorOf(c.agent.request(methods.agent.session.delete, { sessionId: "kept" }));
  check("deleting a thread that is not open refuses the same way, naming it",
    deleted?.code === -32603 && deleted.message === "kept is not listed, because no live manager is registered for fake. A new thread starts this machine's manager.", deleted);
  check("none of them starts a manager", space.starts === 0, space.starts);
  c.conn.close();
}
{
  const refused = JSON.stringify({ outcome: "refused", error: { code: "TARGET_NOT_FOUND", message: "no space named \"x\" is registered here", remedy: "see `cotal space`" } });
  check("a refused start's reason is its own message and remedy", startFailure(2, refused, "") === "no space named \"x\" is registered here; see `cotal space`", startFailure(2, refused, ""));
  check("a start that printed no result is named by its last stderr line", startFailure(1, "", "starting\n✗ the manager did not start: boom\n") === "✗ the manager did not start: boom");
  check("a start that printed nothing is named by its exit code", startFailure(null, "", "") === "it exited with code null");
  check("a start that launched the manager says it started it", startLine("x", JSON.stringify({ outcome: "ok" })) === "Started this machine's manager for x. It stops itself after 10 minutes with no agents.");
  check("a start that found it already running, as a second thread's does, says it is running", startLine("x", JSON.stringify({ outcome: "no-op" })) === "This machine's manager for x is running. It stops itself after 10 minutes with no agents.");
  const status = (result: unknown) => JSON.stringify({ outcome: "ok", result });
  check("a manager status whose recorded process runs names its native instance", recordedInstance(status({ kind: "service-status", observedProcess: "running", nativeEndpoint: { instanceId: "abc" } })) === "abc");
  check("one whose process is gone names none", recordedInstance(status({ kind: "service-status", observedProcess: "gone", nativeEndpoint: { instanceId: "abc" } })) === undefined);
  check("one never started names none", recordedInstance(status({ kind: "service-status", instanceId: null, recordedState: "not started" })) === undefined);
  check("a refused status names none", recordedInstance(refused) === undefined);
  check("output that is not a result names none", recordedInstance("") === undefined);
}

// An application whose models the manager could not read is refused with the read's reason.
{
  const why = "Database is not empty and has no session table";
  const unread: AgentCatalog = { agent: "opencode", available: true, eventPlane: true, models: [], modelsUnread: why };
  const only = new FakeMesh();
  only.catalogList = [unread];
  const alone = connect(async () => only);
  await alone.init;
  const e = await errorOf(alone.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
  check("a new thread whose only application's models could not be read fails with the read's reason",
    e?.code === -32603 && (e as { data?: { details?: string } }).data?.details?.includes(why) === true, e);
  alone.conn.close();
  const beside = new FakeMesh();
  beside.catalogList = [...CATALOGS, unread];
  const both = connect(async () => beside);
  await both.init;
  const s = await both.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const select = s.configOptions?.find((o) => o.id === "model") as { options: { group: string }[] } | undefined;
  check("beside another application, it is not offered", select?.options.some((g) => g.group === "opencode") === false, select?.options.map((g) => g.group));
  const chosen = await errorOf(both.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "model", value: "opencode/default" }));
  check("and choosing it fails with the read's reason", chosen?.message?.includes(why) === true, chosen);
  both.conn.close();
}

// A running seat of such an application still opens, since driving it launches nothing.
{
  const why = "Database is not empty and has no session table";
  const unread: AgentCatalog = { agent: "opencode", available: true, eventPlane: true, models: [], modelsUnread: why };
  const seat: SeatRow = { name: "reader", owner: "local", actor: "r1", lifecycleUid: "life-r", managerInstanceId: "m1", agent: "opencode", model: "anthropic/claude-sonnet-4-5", cwd: dir, status: "running" };
  const modelOf = (r: { configOptions?: unknown[] | null } | undefined) => {
    const o = r?.configOptions?.find((x) => (x as { id: string }).id === "model") as { currentValue?: string; options?: { options?: { value: string }[] }[] } | undefined;
    return { current: o?.currentValue, values: (o?.options ?? []).flatMap((g) => (g.options ?? []).map((c) => c.value)) };
  };
  const only = new FakeMesh();
  only.catalogList = [unread];
  only.rows = [seat];
  const alone = connect(async () => only);
  await alone.init;
  let loadFailed: unknown;
  const loaded = await alone.agent.request(methods.agent.session.load, { sessionId: "reader", cwd: dir, mcpServers: [] }).catch((e: unknown) => { loadFailed = e; return undefined; });
  check("session/load opens a running seat whose application's models could not be read, on the seat's model, which the select lists",
    loadFailed === undefined && modelOf(loaded).current === "opencode/anthropic/claude-sonnet-4-5" && JSON.stringify(modelOf(loaded).values) === JSON.stringify(["opencode/anthropic/claude-sonnet-4-5"]), loadFailed ?? modelOf(loaded));
  if (loaded) await within(alone.agent.request(methods.agent.session.prompt, { sessionId: "reader", prompt: [{ type: "text", text: "/despawn" }] }));
  const relaunch = loaded ? await errorOf(within(alone.agent.request(methods.agent.session.prompt, { sessionId: "reader", prompt: [{ type: "text", text: "again" }] }))) : undefined;
  check("after /despawn, a prompt there still refuses to start that application, with the read's reason",
    relaunch?.code === -32602 && relaunch.message?.includes(why) === true && only.spawned.length === 0, relaunch);
  alone.conn.close();
  const beside = new FakeMesh();
  beside.catalogList = [...CATALOGS, unread];
  beside.rows = [seat];
  const both = connect(async () => beside);
  await both.init;
  const s = await both.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const opened = await errorOf(within(both.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "/open reader" }] })));
  const said = both.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text).join("\n");
  check("/open drives such a seat too", opened === undefined && said.includes("now drives reader"), opened ?? said);
  both.conn.close();
}

// `/open` sends the opened seat's options, so the client's selects show its model.
{
  const unread: AgentCatalog = { agent: "opencode", available: true, eventPlane: true, models: [], modelsUnread: "Database is not empty and has no session table" };
  const space = new FakeMesh();
  space.catalogList = [{ agent: "claude-code", available: true, eventPlane: true, models: [{ id: "sonnet", name: "Claude Sonnet", variants: [] }] }, unread];
  space.rows = [{ name: "coder", owner: "local", actor: "c1", lifecycleUid: "life-c", managerInstanceId: "m1", agent: "opencode", model: "anthropic/claude-opus-4-6", cwd: dir, status: "running" }];
  const c = connect(async () => space);
  await c.init;
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  await tick();
  c.updates.length = 0;
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "/open coder" }] }));
  const kinds = c.updates.filter((u) => u.sessionId === s.sessionId).map((u) => u.update.sessionUpdate);
  const update = c.updates.find((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "config_option_update")?.update as { configOptions?: unknown[] } | undefined;
  const model = update?.configOptions?.find((o) => (o as { id: string }).id === "model") as { currentValue?: string; options?: { group: string; options: { value: string }[] }[] } | undefined;
  check("/open sends the opened seat's options: its model, beside the models a new agent can start on",
    model?.currentValue === "opencode/anthropic/claude-opus-4-6" && JSON.stringify(model.options?.map((g) => [g.group, g.options.map((o) => o.value)])) === JSON.stringify([["claude-code", ["claude-code/default", "claude-code/sonnet"]], ["opencode", ["opencode/anthropic/claude-opus-4-6"]]]),
    { kinds, model });
  c.conn.close();
}

// session/new, options, delete of an unspawned session
const mesh = new FakeMesh();
const { agent, conn, updates, hidden, init } = connect(async () => mesh);
await init;
const created = await agent.request(methods.agent.session.new, { cwd: link, mcpServers: [] });
const model = created.configOptions?.find((o) => o.id === "model") as { currentValue: string; options: { group: string; options: { value: string; name: string }[] }[] } | undefined;
check("session/new launches nothing", mesh.spawned.length === 0);
check("session/new reads the lists of this machine's manager", mesh.catalogsAsked[0] === "m1", mesh.catalogsAsked);
check("the model select starts at the default application's own default", model?.currentValue === "claude/default", model);
check("applications without an event plane are not offered", !model?.options.some((g) => g.group === "hermes"), model?.options.map((g) => g.group));
check("each application lists its default first", model?.options.every((g) => g.options[0]!.value === `${g.group}/default`) === true, model);
check("each model name starts with its application, for a client that drops the group names", model?.options.every((g) => g.options.every((o) => o.name.startsWith(`${g.group}: `))) === true, model);
await tick();
check("the session's slash commands are announced", updates.some((u) => u.sessionId === created.sessionId && u.update.sessionUpdate === "available_commands_update"));
const probe = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
await agent.request(methods.agent.session.delete, { sessionId: probe.sessionId });
check("deleting a session that never spawned hides nothing", hidden.ids.size === 0, [...hidden.ids]);

// The session's model state as it goes on the wire. The SDK's client drops a response field its
// schema lacks, so these cells read the bridge's own JSON-RPC lines.
{
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  cotalAgent({ mesh: async () => new FakeMesh(), hidden: new MemoryHidden(), links: new MemoryLinks(), log: () => {}, version: "0.0.0-smoke", newName: () => "acp-raw", waits: { startMs: 300, settleMs: 100 } })
    .connect(ndJsonStream(toClient.writable, toAgent.readable));
  const writer = toAgent.writable.getWriter();
  const reader = toClient.readable.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  const raw = async (id: number, method: string, params: unknown): Promise<{ result?: Record<string, unknown> }> => {
    await writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl >= 0) {
        const line = JSON.parse(buffered.slice(0, nl)) as { id?: number; result?: Record<string, unknown> };
        buffered = buffered.slice(nl + 1);
        if (line.id === id) return line;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the bridge closed the connection");
      buffered += value;
    }
  };
  await raw(1, "initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const fresh = (await raw(2, "session/new", { cwd: dir, mcpServers: [] })).result ?? {};
  type Wire = { models?: { currentModelId?: string; availableModels?: { modelId: string; _meta?: { reasoningEfforts?: { value: string; label: string }[]; reasoningEffort?: string; supportsReasoningEffort?: boolean } }[] };
    configOptions?: { id: string; category?: string; currentValue?: string; options: ({ value: string } | { options: { value: string }[] })[] }[] };
  const wire = fresh as Wire;
  const listed = wire.models?.availableModels ?? [];
  const select = wire.configOptions?.find((o) => o.id === "model");
  const choices = (select?.options ?? []).flatMap((g) => ("options" in g ? g.options : [g])).map((c) => c.value);
  check("session/new carries the model state, listing every model of the model select",
    wire.models?.currentModelId === select?.currentValue && JSON.stringify(listed.map((m) => m.modelId)) === JSON.stringify(choices), { models: wire.models, choices });
  const meta = (id: string) => listed.find((m) => m.modelId === id)?._meta;
  check("a model with variants lists the reasoning select's choices for it, starting at the model default",
    JSON.stringify(meta("claude/opus")?.reasoningEfforts?.map((e) => e.value)) === '["default","high","low"]' &&
    meta("claude/opus")?.reasoningEffort === "default" && JSON.stringify(meta("claude/sonnet")?.reasoningEfforts?.map((e) => e.value)) === '["default","low"]',
    { opus: meta("claude/opus"), sonnet: meta("claude/sonnet") });
  check("a model without variants, an application's default included, says it takes no reasoning effort",
    ["claude/haiku", "claude/default", "pi/default"].every((id) => meta(id)?.supportsReasoningEffort === false && meta(id)?.reasoningEfforts === undefined),
    ["claude/haiku", "claude/default", "pi/default"].map((id) => meta(id)));
  const reasoning = wire.configOptions?.find((o) => o.id === "reasoning");
  check("a fresh session at an application's default offers the reasoning select, holding the model default",
    reasoning?.category === "thought_level" && reasoning.currentValue === "default" && JSON.stringify(reasoning.options.map((c) => ("value" in c ? c.value : ""))) === '["default"]', reasoning);
  await writer.close();
}

// options
const sid = created.sessionId;
const set = (configId: string, value: string) => agent.request(methods.agent.session.setConfigOption, { sessionId: sid, configId, value });
const harness = (o: readonly { id: string }[]) => o.find((x) => x.id === "agent") as unknown as { currentValue: string; options: { value: string }[] } | undefined;
const modelOf = (o: readonly { id: string }[]) => (o.find((x) => x.id === "model") as unknown as { currentValue: string } | undefined)?.currentValue;
check("the harness select lists the usable applications and starts at the model's", harness(created.configOptions ?? [])?.currentValue === "claude" && JSON.stringify(harness(created.configOptions ?? [])?.options.map((c) => c.value)) === JSON.stringify(["claude", "pi"]), created.configOptions);
let hopts = (await set("agent", "pi")).configOptions;
check("choosing another harness starts it on its own default model", modelOf(hopts) === "pi/default" && harness(hopts)?.currentValue === "pi", hopts);
hopts = (await set("model", "claude/haiku")).configOptions;
check("choosing a model moves the harness to its application", harness(hopts)?.currentValue === "claude", hopts);
hopts = (await set("agent", "claude")).configOptions;
check("choosing the harness the model already runs keeps the model", modelOf(hopts) === "claude/haiku", hopts);
const noPlane = await errorOf(set("agent", "hermes"));
check("a harness without an event plane is refused as invalid params", noPlane?.code === -32602 && noPlane.message?.includes("event plane") === true, noPlane);
let opts = (await set("model", "claude/opus")).configOptions;
check("a model with variants offers the reasoning option", opts.some((o) => o.id === "reasoning"), opts.map((o) => o.id));
await set("reasoning", "high");
opts = (await set("model", "claude/sonnet")).configOptions;
const variant = opts.find((o) => o.id === "reasoning") as { currentValue?: string } | undefined;
check("a variant does not carry to a model that lacks it", variant?.currentValue === "default", variant);
opts = (await set("model", "claude/haiku")).configOptions;
const onlyDefault = opts.find((o) => o.id === "reasoning") as { options?: { value: string }[] } | undefined;
check("a model without variants offers the reasoning select with only the model default",
  JSON.stringify(onlyDefault?.options?.map((c) => c.value)) === '["default"]', onlyDefault);
const bad = await errorOf(set("model", "hermes/default"));
check("an application without an event plane is refused as invalid params", bad?.code === -32602 && bad.message?.includes("event plane") === true, bad);
opts = (await set("model", "claude/my-custom")).configOptions;
const custom = opts.find((o) => o.id === "model") as unknown as { currentValue: string; options: { options: { value: string }[] }[] };
check("a custom model id is accepted and offered as a choice", custom.currentValue === "claude/my-custom" && custom.options.some((g) => g.options.some((o) => o.value === "claude/my-custom")), custom);
const personaChoices = (o: typeof opts) => (o.find((x) => x.id === "persona") as unknown as { options: { value: string }[] } | undefined)?.options.map((c) => c.value) ?? [];
opts = (await set("machine", "m2")).configOptions;
check("choosing another machine offers that manager's personas", personaChoices(opts).includes("builder") && !personaChoices(opts).includes("reviewer"), personaChoices(opts));
await set("machine", "m1");
await set("persona", "reviewer");
opts = (await set("machine", "m2")).configOptions;
const carried = opts.find((o) => o.id === "persona") as { currentValue?: string } | undefined;
check("a persona the chosen machine lacks returns to the default", carried?.currentValue === "default", carried);
await set("machine", "m1");
await set("model", "claude/opus");
await set("persona", "reviewer");
await set("reasoning", "high");
const noChannel = await errorOf(set("channel", "nowhere"));
check("a channel the space does not hold is refused", noChannel?.code === -32602, noChannel);
await set("channel", "ops");

// the first prompt
mesh.script = {
  before: [[{ type: "RUN_STARTED", runId: "r1" }, { type: "TEXT_MESSAGE_START", messageId: "u", role: "user" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "u", delta: "do it" }, { type: "TEXT_MESSAGE_END", messageId: "u" }]],
  after: [
    [{ type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash" }, { type: "TOOL_CALL_START", toolCallId: "c2", toolCallName: "Read" }, { type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "c1" } }],
    [{ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "done" }, { type: "TEXT_MESSAGE_END", messageId: "m" }, { type: "RUN_FINISHED", runId: "r1" }],
  ],
};
updates.length = 0;
const answer = await within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "do it" }, { type: "resource_link", name: "spec", uri: "file:///spec.md" }] }));
const seen = updates.filter((u) => u.sessionId === sid).map((u) => u.update);
const req = mesh.spawned[0];
check("the first prompt spawns one seat named after the session", mesh.spawned.length === 1 && req?.name === sid, mesh.spawned);
check("it spawns in the session's folder with the prompt and the chosen options", req?.cwd === link && req.prompt === "do it\n\n[spec](file:///spec.md)" && req.agent === "claude" && req.model === "opus" && req.variant === "high" && req.persona === "reviewer" && req.managerInstanceId === "m1" && JSON.stringify(req.subscribe) === '["ops"]', req);
check("the prompt answers end_turn", answer?.stopReason === "end_turn", answer);
check("frames published before the spawn reply still reach the client", seen.some((u) => u.sessionUpdate === "user_message_chunk"), seen.map((u) => u.sessionUpdate));
check("the reply reaches the client before the prompt answers", seen.some((u) => u.sessionUpdate === "agent_message_chunk" && (u as { content: { text: string } }).content.text === "done"));
check("a tool call left open is closed before the prompt answers", seen.some((u) => u.sessionUpdate === "tool_call_update" && (u as { toolCallId: string }).toolCallId === "c2"), seen);
const busy = await errorOf(set("model", "pi/default"));
check("options are refused once the seat runs", busy?.code === -32602, busy);

// slash commands
updates.length = 0;
const roster = await agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "/roster" }] });
check("/roster answers locally", roster.stopReason === "end_turn" && updates.some((u) => JSON.stringify(u.update).includes("alice (reviewer): idle")), updates);
updates.length = 0;
await agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "/channels" }] });
check("/channels lists the space's channels", updates.some((u) => JSON.stringify(u.update).includes("#general")), updates);

// later prompts
const actor = `actor-${sid}`;
const after = (ms: number, f: () => void) => void setTimeout(f, ms);
mesh.present.set(actor, "idle");
mesh.onInput = (seat) => {
  after(20, () => { mesh.present.set(actor, "working"); mesh.emit(seat, [{ type: "RUN_STARTED", runId: "r2" }, { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "on it" }], "r2"); });
  // Presence reports idle well before the run's last frame arrives: longer than the settle wait plus
  // a watch tick, so a prompt that ignored the open run would answer before that frame.
  after(250, () => mesh.present.set(actor, "idle"));
  after(1500, () => mesh.emit(seat, [{ type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: " and done" }, { type: "TEXT_MESSAGE_END", messageId: "a" }, { type: "RUN_FINISHED", runId: "r2" }], "r2"));
};
updates.length = 0;
const later = await within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "and again" }] }));
const laterSeen = updates.filter((u) => u.sessionId === sid).map((u) => JSON.stringify(u.update)).join("\n");
check("a later prompt is typed into the seat", mesh.typed.length === 1 && mesh.typed[0]!.seat === sid && mesh.typed[0]!.text === "and again", mesh.typed);
check("a later prompt answers end_turn once the seat stopped working", later?.stopReason === "end_turn", later);
check("a later prompt answers only after the runs it started ended", laterSeen.includes(" and done"), laterSeen);
mesh.onInput = () => {};
updates.length = 0;
const ignored = await within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "anyone?" }] }));
check("a later prompt the seat does not start on answers, and says so", ignored?.stopReason === "end_turn" && updates.some((u) => JSON.stringify(u.update).includes("has not started on it")), { ignored, updates });
mesh.onInput = (seat) => after(20, () => mesh.emit(seat, [{ type: "RUN_STARTED", runId: "r3" }, { type: "RUN_ERROR", message: "out of credit" }], "r3"));
const laterFailed = await errorOf(within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "once more" }] })));
check("a failed run after a later prompt fails it with the seat's message", laterFailed?.code === -32603 && laterFailed.message?.includes("out of credit") === true, laterFailed);
// The seat answers and finishes before the manager's input reply arrives.
mesh.inputDelay = 200;
mesh.onInput = (seat) => mesh.emit(seat, [{ type: "RUN_STARTED", runId: "r4" }, { type: "TEXT_MESSAGE_START", messageId: "q", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "q", delta: "quick" }, { type: "TEXT_MESSAGE_END", messageId: "q" }, { type: "RUN_FINISHED", runId: "r4" }], "r4");
updates.length = 0;
const quick = await within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "quick one" }] }));
check("a run that ends before the input reply still answers the later prompt", quick?.stopReason === "end_turn" && !updates.some((u) => JSON.stringify(u.update).includes("has not started on it")), { quick, updates });
mesh.inputDelay = 0;
mesh.onInput = () => { throw new Error(`${sid} did not get the prompt: input is not supported by runtime tmux`); };
const typedBefore = mesh.typed.length;
const inputRefused = await errorOf(within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "type this" }] })));
check("a prompt the manager refuses to type fails with its reason", inputRefused?.code === -32603 && inputRefused.message?.includes("not supported by runtime tmux") === true && mesh.typed.length === typedBefore, inputRefused);
mesh.onInput = () => {};
const afterRefusal = await within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "/channels" }] }));
check("a refused prompt leaves the session free for the next one", afterRefusal?.stopReason === "end_turn", afterRefusal);
const prose = "/despawn is an example, please explain the syntax";
const proseReply = await within(agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: prose }] }));
check("prose beginning with /despawn goes to the running seat", proseReply?.stopReason === "end_turn" && !mesh.despawned.includes(sid) && mesh.typed.at(-1)?.text === prose, { proseReply, typed: mesh.typed, despawned: mesh.despawned });

// list and delete
mesh.rows = [
  { name: sid, owner: "local", actor: `actor-${sid}`, lifecycleUid: `life-${sid}`, managerInstanceId: "m1", agent: "claude", model: "opus", cwd: dir, status: "running", uptimeMs: 1000 },
  { name: "elsewhere", owner: "local", actor: "x", lifecycleUid: "life-x", agent: "pi", cwd: "/somewhere/else", status: "running" },
];
let listed = await agent.request(methods.agent.session.list, { cwd: link });
check("session/list matches the folder through a symlink", listed.sessions.length === 1 && listed.sessions[0]!.sessionId === sid, listed);
listed = await agent.request(methods.agent.session.list, {});
check("session/list without a folder lists every seat", listed.sessions.length === 2, listed);
await agent.request(methods.agent.session.delete, { sessionId: sid });
check("deleting a spawned session hides its run", hidden.ids.has(`life-${sid}`), [...hidden.ids]);
listed = await agent.request(methods.agent.session.list, {});
check("a hidden run is not listed", !listed.sessions.some((s) => s.sessionId === sid), listed);
await agent.request(methods.agent.session.delete, { sessionId: "elsewhere" });
check("deleting a session from an earlier process hides that seat's run", hidden.ids.has("life-x"));

// load
const outside: SeatRow = { name: "outside", owner: "local", actor: "o1", lifecycleUid: "life-o", managerInstanceId: "m1", agent: "claude", model: "haiku", cwd: dir, status: "running" };
mesh.rows = [outside, { name: "nope", owner: "local", actor: "n1", lifecycleUid: "life-n", agent: "hermes", status: "running" }];
mesh.history.set("outside", [{ plane: "events", owner: "local", actor: "o1", threadId: "t", runId: "r0", epoch: "e", seq: 900, ts: 1, events: [{ type: "TEXT_MESSAGE_START", messageId: "h", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "h", delta: "earlier" }, { type: "TOOL_CALL_START", toolCallId: "old", toolCallName: "Bash" }] }]);
updates.length = 0;
const loaded = await agent.request(methods.agent.session.load, { sessionId: "outside", cwd: dir, mcpServers: [] });
const replay = updates.filter((u) => u.sessionId === "outside");
check("session/load replays before it answers, marked as replay", replay.some((u) => u.update.sessionUpdate === "agent_message_chunk" && u._meta?.isReplay === true), replay);
check("a replayed tool call is closed", replay.some((u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { toolCallId: string }).toolCallId === "old"), replay);
check("the loaded session's model is the seat's", (loaded.configOptions?.find((o) => o.id === "model") as { currentValue?: string } | undefined)?.currentValue === "claude/haiku", loaded.configOptions);
updates.length = 0;
mesh.emit(outside, [{ type: "TEXT_MESSAGE_START", messageId: "l", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "l", delta: "live" }], "r9");
await tick();
check("a loaded session follows the seat live", updates.some((u) => u.sessionId === "outside" && JSON.stringify(u.update).includes("live") && u._meta?.isReplay !== true), updates);
const refused = await errorOf(agent.request(methods.agent.session.load, { sessionId: "nope", cwd: dir, mcpServers: [] }));
check("loading a seat without an event plane is refused", refused?.code === -32602, refused);
const missing = await errorOf(agent.request(methods.agent.session.load, { sessionId: "ghost", cwd: dir, mcpServers: [] }));
check("loading an unknown seat is resource-not-found", missing?.code === -32002, missing);

// A manager that did not answer may hold the seat, so a miss is not called missing.
mesh.silent = ["m9"];
const unsure = await errorOf(agent.request(methods.agent.session.load, { sessionId: "ghost", cwd: dir, mcpServers: [] }));
check("loading a seat no manager listed while one did not answer names that manager, not resource-not-found", unsure?.code === -32603 && String(unsure.message).includes("m9"), unsure);
const hiddenBefore = hidden.ids.size;
const unsureDelete = await errorOf(agent.request(methods.agent.session.delete, { sessionId: "ghost" }));
check("deleting such a seat fails the same way and hides nothing", unsureDelete?.code === -32603 && String(unsureDelete.message).includes("m9") && hidden.ids.size === hiddenBefore, unsureDelete);
check("for a manager that is not the person's own registration, it does not offer to remove it", !String(unsure?.message).includes("deregister"), unsure);
mesh.removable = ["m9"];
const unsureSignedIn = await errorOf(agent.request(methods.agent.session.load, { sessionId: "ghost", cwd: dir, mcpServers: [] }));
check("for the person's own registration that did not answer, it names the command that removes it", String(unsureSignedIn?.message).includes("`cotal endpoint deregister manager m9 --space fake --yes`"), unsureSignedIn);
mesh.removable = [];
mesh.silent = [];

// A person whose grant does not let them spawn opens their agent and types into it. The agent runs
// on m2, which is neither the local machine nor the first listed.
mesh.launchRefused = true;
const rowsBefore = mesh.rows;
mesh.rows = [{ ...outside, managerInstanceId: "m2" }, ...rowsBefore.slice(1)];
let narrowFailed: unknown;
const narrow = await agent.request(methods.agent.session.load, { sessionId: "outside", cwd: dir, mcpServers: [] }).catch((e: unknown) => { narrowFailed = e; return undefined; });
const narrowModel = narrow?.configOptions?.find((o) => o.id === "model") as { currentValue?: string; options?: { options?: { value: string }[] }[] } | undefined;
const narrowChoices = (narrowModel?.options ?? []).flatMap((g) => (g.options ?? []).map((c) => c.value));
const runningModel = await errorOf(agent.request(methods.agent.session.setConfigOption, { sessionId: "outside", configId: "model", value: "claude/opus" }));
check("choosing another model while its agent runs is refused without sending the person to /despawn", runningModel?.code === -32602 && String(runningModel.message).includes("options cannot change") && !String(runningModel.message).includes("/despawn"), runningModel);
check("a seat whose launch lists are refused loads with only its own model and nothing to launch with", narrowModel?.currentValue === "claude/haiku" && JSON.stringify(narrowChoices) === JSON.stringify(["claude/haiku"]) && !narrow?.configOptions?.some((o) => o.id === "persona" || o.id === "channel" || o.id === "agent"), narrowFailed ?? narrow?.configOptions);
mesh.present.set(outside.actor, "idle");
mesh.onInput = (seat) => {
  mesh.present.set(seat.actor, "working");
  mesh.emit(seat, [{ type: "RUN_STARTED", runId: "r7" }], "r7");
  after(30, () => { mesh.emit(seat, [{ type: "RUN_FINISHED", runId: "r7" }], "r7"); mesh.present.set(seat.actor, "idle"); });
};
const narrowTurn = narrow ? await within(agent.request(methods.agent.session.prompt, { sessionId: "outside", prompt: [{ type: "text", text: "go on" }] })) : undefined;
check("its prompt is typed into the seat through the manager that holds it", narrowTurn?.stopReason === "end_turn" && mesh.typed.at(-1)?.text === "go on" && mesh.typedTo.at(-1) === "m2", { narrowTurn, typed: mesh.typed.at(-1), to: mesh.typedTo.at(-1) });
mesh.rows = [{ ...outside, name: "plain", actor: "p1", lifecycleUid: "life-p", model: "default" }];
const plain = await agent.request(methods.agent.session.load, { sessionId: "plain", cwd: dir, mcpServers: [] }).catch(() => undefined);
const plainModel = plain?.configOptions?.find((o) => o.id === "model") as { currentValue?: string; options?: { options?: { value: string; name: string }[] }[] } | undefined;
const plainChoices = (plainModel?.options ?? []).flatMap((g) => g.options ?? []);
check("one whose seat runs the model default offers that model once, as its application's default",
  plainModel?.currentValue === "claude/default" && JSON.stringify(plainChoices) === JSON.stringify([{ value: "claude/default", name: "claude: default" }]), plain?.configOptions);
mesh.onInput = () => {};
mesh.launchRefused = false;
mesh.rows = rowsBefore;

// despawn, in the thread opened without the launch lists
updates.length = 0;
await agent.request(methods.agent.session.prompt, { sessionId: "outside", prompt: [{ type: "text", text: "/despawn" }] });
check("/despawn stops the session's seat", mesh.despawned.includes("outside"), mesh.despawned);
check("and says that starting another agent there needs a grant that may spawn", updates.some((u) => u.sessionId === "outside" && JSON.stringify(u.update).includes("needs a grant that may spawn")), updates);
const spawnsBefore = mesh.spawned.length;
const noLaunch = await errorOf(within(agent.request(methods.agent.session.prompt, { sessionId: "outside", prompt: [{ type: "text", text: "again" }] })));
check("a later prompt there is refused with that reason and spawns nothing", noLaunch?.code === -32602 && String(noLaunch.message).includes("may spawn") && mesh.spawned.length === spawnsBefore, noLaunch);
const otherModel = await errorOf(agent.request(methods.agent.session.setConfigOption, { sessionId: "outside", configId: "model", value: "claude/opus" }));
check("choosing another model there is refused, since no agent can start with it", otherModel?.code === -32602 && String(otherModel.message).includes("options cannot change"), otherModel);

// A loaded agent on a manager the launch list leaves out, such as the space's own while the person
// has managers of their own, keeps that manager as its Machine choice.
const heldRow: SeatRow = { name: "held", owner: "local", actor: "h1", lifecycleUid: "life-h", managerInstanceId: "m3", agent: "claude", model: "haiku", cwd: dir, status: "running" };
const machineOf = (r: { configOptions?: unknown[] | null } | undefined) => {
  const o = r?.configOptions?.find((x) => (x as { id: string }).id === "machine") as { currentValue?: string; options?: { value: string }[] } | undefined;
  return { current: o?.currentValue, choices: (o?.options ?? []).map((c) => c.value) };
};
mesh.rows = [heldRow, ...rowsBefore];
const heldLoad = await agent.request(methods.agent.session.load, { sessionId: "held", cwd: dir, mcpServers: [] });
check("a loaded agent's manager stays its current Machine choice beside the launch list", JSON.stringify(machineOf(heldLoad)) === JSON.stringify({ current: "m3", choices: ["m1", "m2", "m3"] }), machineOf(heldLoad));
const labels = (r: { configOptions?: unknown[] | null } | undefined) => ((r?.configOptions?.find((x) => (x as { id: string }).id === "machine") as { options?: { name: string }[] } | undefined)?.options ?? []).map((c) => c.name);
check("and it is described from its presence like the others", JSON.stringify(labels(heldLoad)) === JSON.stringify(["This machine", "there", "host-m3"]), labels(heldLoad));
// While no manager may start a new agent, the agent still loads, read from the manager that holds it,
// and a new thread still says why it cannot start.
mesh.noLaunch = "none of your managers is live";
const asked = mesh.catalogsAsked.length;
const personasAsked = mesh.personasAsked.length;
let heldFailed: unknown;
await agent.request(methods.agent.session.load, { sessionId: "held", cwd: dir, mcpServers: [] }).catch((e: unknown) => { heldFailed = e; });
check("it loads while no manager may start a new agent, its lists read from the manager that holds it", heldFailed === undefined && mesh.catalogsAsked.slice(asked).every((m) => m === "m3") && mesh.catalogsAsked.length > asked, heldFailed ?? mesh.catalogsAsked.slice(asked));
check("and its personas are read from that manager too", mesh.personasAsked.slice(personasAsked).every((m) => m === "m3") && mesh.personasAsked.length > personasAsked, mesh.personasAsked.slice(personasAsked));
const noNew = await errorOf(agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }));
check("a new thread whose manager start fails is refused with the start's reason in the message", noNew?.code === -32603 && noNew.message === "Could not start this machine's manager for fake: no start scripted", noNew);
check("loading an agent its manager holds starts no manager", mesh.starts === 1, mesh.starts);
mesh.noLaunch = undefined;
// After /despawn the loaded thread may choose another machine and come back to the one that held it.
await agent.request(methods.agent.session.load, { sessionId: "held", cwd: dir, mcpServers: [] });
const describedAtLoad = mesh.described.filter((m) => m === "m3").length;
await agent.request(methods.agent.session.prompt, { sessionId: "held", prompt: [{ type: "text", text: "/despawn" }] });
const toM1 = await agent.request(methods.agent.session.setConfigOption, { sessionId: "held", configId: "machine", value: "m1" });
check("after /despawn, choosing another machine keeps the held manager as a choice", JSON.stringify(machineOf(toM1)) === JSON.stringify({ current: "m1", choices: ["m1", "m2", "m3"] }), machineOf(toM1));
check("the held manager is described once, at the load, not again on a machine change", mesh.described.filter((m) => m === "m3").length === describedAtLoad, mesh.described);
const askedBack = mesh.catalogsAsked.length;
let backFailed: unknown;
const backToM3 = await agent.request(methods.agent.session.setConfigOption, { sessionId: "held", configId: "machine", value: "m3" }).catch((e: unknown) => { backFailed = e; return undefined; });
check("and choosing it again is accepted, its lists read from it", backFailed === undefined && machineOf(backToM3).current === "m3" && mesh.catalogsAsked.slice(askedBack).every((m) => m === "m3") && mesh.catalogsAsked.length > askedBack, backFailed ?? machineOf(backToM3));
const listBefore = mesh.managerList;
// The manager that holds it is already in a launch list of two: it is the current choice.
mesh.managerList = [{ instanceId: "m1", host: "here", local: true, live: true }, { instanceId: "m3", host: "elsewhere", local: false }];
const inList = await agent.request(methods.agent.session.load, { sessionId: "held", cwd: dir, mcpServers: [] });
check("a loaded agent whose manager is in the launch list has it as the current choice", JSON.stringify(machineOf(inList)) === JSON.stringify({ current: "m3", choices: ["m1", "m3"] }), machineOf(inList));
// The manager that holds it is the only one, on another computer: it is the Machine choice, and a new
// agent starts there.
mesh.managerList = [{ instanceId: "m3", host: "elsewhere", local: false }];
const alone = await agent.request(methods.agent.session.load, { sessionId: "held", cwd: dir, mcpServers: [] });
check("with one manager, on another computer, a loaded thread offers it as its current Machine", JSON.stringify(machineOf(alone)) === JSON.stringify({ current: "m3", choices: ["m3"] }), machineOf(alone));
await agent.request(methods.agent.session.prompt, { sessionId: "held", prompt: [{ type: "text", text: "/despawn" }] });
mesh.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
const spawnsAlone = mesh.spawned.length;
const aloneTurn = await within(agent.request(methods.agent.session.prompt, { sessionId: "held", prompt: [{ type: "text", text: "again" }] }));
mesh.script = { before: [], after: [] };
check("and its next agent starts on that manager", aloneTurn?.stopReason === "end_turn" && mesh.spawned.length === spawnsAlone + 1 && mesh.spawned.at(-1)?.name === "held" && mesh.spawned.at(-1)?.managerInstanceId === "m3", { aloneTurn, spawned: mesh.spawned.at(-1) });
// The held manager was in the launch list at the load, then stopped: it leaves the list and refuses to
// be described. After /despawn the thread still switches to the other manager and keeps the held one.
mesh.managerList = [{ instanceId: "m1", host: "here", local: true, live: true }, { instanceId: "m3", host: "elsewhere", local: false }];
await agent.request(methods.agent.session.load, { sessionId: "held", cwd: dir, mcpServers: [] });
await agent.request(methods.agent.session.prompt, { sessionId: "held", prompt: [{ type: "text", text: "/despawn" }] });
mesh.managerList = [{ instanceId: "m1", host: "here", local: true, live: true }];
mesh.gone.add("m3");
const askedGone = mesh.catalogsAsked.length;
let goneFailed: unknown;
const awayFromGone = await agent.request(methods.agent.session.setConfigOption, { sessionId: "held", configId: "machine", value: "m1" }).catch((e: unknown) => { goneFailed = e; return undefined; });
check("after the held manager stops, choosing the other machine reads its lists and keeps the held one as described at the load", goneFailed === undefined && machineOf(awayFromGone).current === "m1" && JSON.stringify(labels(awayFromGone)) === JSON.stringify(["This machine", "elsewhere"]) && mesh.catalogsAsked.slice(askedGone).every((m) => m === "m1"), goneFailed ?? { machine: machineOf(awayFromGone), labels: labels(awayFromGone) });
mesh.gone.clear();
mesh.managerList = [{ instanceId: "m1", host: "there", local: false, live: true }, { instanceId: "m2", host: "here", local: true, live: true }];
const preferLocal = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] }).catch(() => undefined);
check("this machine's manager comes before another live one listed first", machineOf(preferLocal).current === "m2", machineOf(preferLocal));
mesh.managerList = listBefore;
mesh.rows = rowsBefore;

// a failed run
const second = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.script = { before: [], after: [[{ type: "RUN_STARTED", runId: "r1" }, { type: "TOOL_CALL_START", toolCallId: "z", toolCallName: "Bash" }], [{ type: "RUN_ERROR", message: "rate limited" }]] };
updates.length = 0;
const failed = await errorOf(within(agent.request(methods.agent.session.prompt, { sessionId: second.sessionId, prompt: [{ type: "text", text: "go" }] })));
check("a failed run fails the prompt with the seat's message", failed?.code === -32603 && failed.message?.includes("rate limited") === true, failed);
check("its open tool call is closed as failed", updates.some((u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { status: string }).status === "failed"), updates);

// A failed run with the harness's own error. Every connector publishes RUN_ERROR with only the fixed
// text "run failed"; the harness's text and kind are on the seat's presence condition, written as each
// connector's failure-condition code writes it, sometimes after the RUN_ERROR arrives.
const failedTurn = async (failWith: FakeMesh["failWith"], replyFirst?: string) => {
  const s = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const reply = replyFirst ? [[{ type: "TEXT_MESSAGE_START", messageId: "e", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "e", delta: replyFirst }, { type: "TEXT_MESSAGE_END", messageId: "e" }]] : [];
  mesh.script = { before: [], after: [[{ type: "RUN_STARTED", runId: "r1" }], ...reply, [{ type: "RUN_ERROR", message: "run failed" }]] };
  mesh.failWith = failWith;
  updates.length = 0;
  const error = await errorOf(within(agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })));
  mesh.failWith = undefined;
  return { seat: s.sessionId, error, said: updates.filter((u) => u.sessionId === s.sessionId).map((u) => JSON.stringify(u.update)).join("\n") };
};
const conditionOf = (error: { data?: unknown } | undefined) => (error?.data as { condition?: Condition } | undefined)?.condition;
const usage = "You've hit your usage limit. Upgrade to Pro or try again at Nov 28th, 2026 9:00 AM.";
const harnesses: { name: string; condition: Condition; ms: number }[] = [
  // codexCondition: the app-server's turn error, its codexErrorInfo as the source.
  { name: "Codex", condition: { code: "billing", source: "usageLimitExceeded", message: usage }, ms: 300 },
  // Claude Code's StopFailure hook: `error` as the source, `error_details` as the message.
  { name: "Claude Code", condition: { code: "rate_limit", source: "rate_limit", message: "API Error: 429 rate_limit_error: This request would exceed your rate limit." }, ms: 0 },
  // OpenCode 1.x `session.error`: its error name and `data.message`.
  { name: "OpenCode 1.x", condition: { code: "auth", source: "ProviderAuthError", message: "Invalid API key for provider anthropic" }, ms: 150 },
  // OpenCode 2.x `session.execution.failed`: its error type and message.
  { name: "OpenCode 2.x", condition: { code: "auth", source: "provider.auth", message: "Missing API key" }, ms: 150 },
  // Pi: the assistant message's errorMessage, under its stop reason.
  { name: "Pi", condition: { code: "failed", source: "error", message: "No API key found for anthropic" }, ms: 50 },
  // Jcode: the Harness API error's code and message.
  { name: "Jcode", condition: { code: "rate_limit", source: "rate_limit", message: "provider returned 429 Too Many Requests" }, ms: 50 },
];
for (const h of harnesses) {
  const { seat, error } = await failedTurn({ condition: { ...h.condition, since: Date.now() }, ms: h.ms });
  const kept = conditionOf(error);
  check(`${h.name}: a failed turn fails the prompt with the harness's own text and kind, not "run failed"`,
    error?.code === -32603 && error.message === `${seat}'s turn failed: ${h.condition.message} (${h.condition.source})`, error);
  check(`${h.name}: the error's data carries the condition's code, source and message`,
    kept?.code === h.condition.code && kept.source === h.condition.source && kept.message === h.condition.message, error?.data);
}
{
  // Hermes writes no condition. The gateway's own error reply arrives as the agent's text, and the
  // failure still says the turn failed, without the fixed "run failed".
  const { seat, error, said } = await failedTurn(undefined, "API call failed after 3 retries: HTTP 402 insufficient credits");
  check("Hermes: the gateway's own error reply reaches the thread as the agent's text", said.includes("insufficient credits"), said);
  check("a failed turn with no text from the harness still says it failed, without \"run failed\"",
    error?.code === -32603 && error.message === `${seat}'s turn failed` && error.data === undefined, error);
}
{
  // A condition the seat showed before the prompt is not this turn's.
  const s = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  mesh.conditions.set(`actor-${s.sessionId}`, { condition: { code: "auth", source: "old", message: "an earlier failure" }, at: Date.now() - 1000 });
  mesh.script = { before: [], after: [[{ type: "RUN_STARTED", runId: "r1" }], [{ type: "RUN_ERROR", message: "run failed" }]] };
  const error = await errorOf(within(agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })));
  check("a condition from before the prompt is not given as the turn's failure", error?.message === `${s.sessionId}'s turn failed`, error);
}
{
  // A seat waiting on an approval is not failing for that reason.
  const { seat, error } = await failedTurn({ condition: { code: "approval", message: "Allow Bash?" }, ms: 0 });
  check("an approval condition is not given as the turn's failure", error?.message === `${seat}'s turn failed`, error);
}

// cancel
const cancel = (sessionId: string) => conn.agent.notify(methods.agent.session.cancel, { sessionId });
const seatOf = (name: string): SeatRef => ({ name, owner: "local", actor: `actor-${name}`, lifecycleUid: `life-${name}` });
const settled = (p: Promise<{ stopReason: string } | undefined>) => p.catch((e: Error) => ({ stopReason: `error: ${e.message}` }));
const go = (sessionId: string) => settled(within(agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "count" }] })));

const c1 = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }, { type: "TOOL_CALL_START", toolCallId: "k1", toolCallName: "Bash" }]], after: [] };
// Pi ends an interrupted run as an error.
mesh.onInterrupt = (seat) => after(10, () => mesh.emit(seat, [{ type: "RUN_ERROR", message: "run failed" }], "r1"));
updates.length = 0;
const p1 = go(c1.sessionId);
await tick(50);
await cancel(c1.sessionId);
const r1 = await p1;
check("a cancel interrupts the seat through its manager", mesh.interrupted.includes(c1.sessionId), mesh.interrupted);
check("a cancelled prompt answers cancelled when the interrupted run ends as an error", r1?.stopReason === "cancelled", r1);
check("a cancelled turn closes its open tool call as failed", updates.some((u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { toolCallId: string; status: string }).toolCallId === "k1" && (u.update as { status: string }).status === "failed"), updates);

// Claude never ends an interrupted run.
const c2 = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [] };
mesh.onInterrupt = () => {};
const p2 = go(c2.sessionId);
await tick(50);
await cancel(c2.sessionId);
check("a cancel answers cancelled when the interrupted run never ends", (await p2)?.stopReason === "cancelled");

const c3 = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.onInterrupt = () => { throw new Error("interrupt is not supported by connector codex"); };
updates.length = 0;
const p3 = go(c3.sessionId);
await tick(50);
await cancel(c3.sessionId);
await tick(50);
check("a refused interrupt is said in the thread", updates.some((u) => u.sessionId === c3.sessionId && JSON.stringify(u.update).includes("Could not stop") && JSON.stringify(u.update).includes("connector codex")), updates);
const r3 = await p3;
check("a refused interrupt still answers the prompt cancelled", r3?.stopReason === "cancelled", r3);

const c4 = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.spawnDelay = 150;
mesh.onInterrupt = (seat) => after(10, () => mesh.emit(seat, [{ type: "RUN_FINISHED", runId: "r1" }], "r1"));
const p4 = go(c4.sessionId);
await tick(20);
await cancel(c4.sessionId);
const r4 = await p4;
check("a cancel that beats the spawn reply interrupts once the seat exists", mesh.interrupted.includes(c4.sessionId) && r4?.stopReason === "cancelled", { r4, interrupted: mesh.interrupted });
mesh.spawnDelay = 0;
mesh.onInterrupt = () => {};

// A delete while a prompt runs answers it and leaves the seat alone.
const c5 = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [] };
const interruptsBefore = mesh.interrupted.length;
const p5 = go(c5.sessionId);
await tick(50);
await agent.request(methods.agent.session.delete, { sessionId: c5.sessionId });
const r5 = await p5;
check("deleting a session answers its running prompt cancelled and leaves the seat running", r5?.stopReason === "cancelled" && mesh.interrupted.length === interruptsBefore && !mesh.despawned.includes(c5.sessionId), r5);

// A delete while the first spawn is pending hides the seat the spawn returns.
const c6 = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.spawnDelay = 150;
mesh.script = { before: [], after: [] };
const p6 = go(c6.sessionId);
await tick(20);
await agent.request(methods.agent.session.delete, { sessionId: c6.sessionId });
const hiddenAtDelete = hidden.ids.has(`life-${c6.sessionId}`);
const r6 = await p6;
updates.length = 0;
mesh.emit(seatOf(c6.sessionId), [{ type: "TEXT_MESSAGE_START", messageId: "z", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "z", delta: "orphan" }], "r1");
await tick();
check("a delete during the first spawn answers once its seat is hidden, and sends that seat nowhere", r6?.stopReason === "cancelled" && hiddenAtDelete && !updates.some((u) => u.sessionId === c6.sessionId), { r6, hiddenAtDelete, updates });
mesh.spawnDelay = 0;

const parts = promptParts([{ type: "text", text: "look" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
check("an image becomes one of the prompt's images", parts.text === "look" && JSON.stringify(parts.images) === JSON.stringify([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]), parts);
const refusedKind = (blocks: Parameters<typeof promptParts>[0]) => { try { promptParts(blocks); return false; } catch { return true; } };
check("an image of another type, an image without data, and audio are refused",
  refusedKind([{ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }]) && refusedKind([{ type: "image", data: "", mimeType: "image/png" }]) && refusedKind([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }]));
const imaged = await errorOf(agent.request(methods.agent.session.prompt, { sessionId: (await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] })).sessionId, prompt: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }));
check("a first prompt with images to a seat that takes no turn fails, naming why", imaged?.message?.includes("does not take a turn on its agent endpoint, so it cannot take the prompt's images") === true, imaged);
conn.close();
await tick(20);
check("closing the client closes the space", mesh.closed);
check("a thread's agent name is a valid user-mode actor token", (() => { try { return assertValidOwnerToken(defaultName()) !== ""; } catch { return false; } })());

// The opt-in launch fields: asked for where the manager says the connector takes them.
{
  const fields = new FakeMesh();
  fields.catalogList = [
    { agent: "claude", available: true, eventPlane: true, models: [] },
    { agent: "pi", available: true, eventPlane: true, askPermissions: true, reasoningEvents: true, models: [] },
  ];
  fields.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  const c = connect(async () => fields);
  await c.init;
  const start = async (model: string) => {
    const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
    await c.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "model", value: model });
    return c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] });
  };
  await within(start("pi/default"));
  const pi = fields.spawned.at(-1);
  check("a seat whose connector takes askPermissions with prompts here, and reasoningEvents, launches with both", pi?.agent === "pi" && pi.askPermissions === true && pi.reasoningEvents === true, pi);
  await within(start("claude/default"));
  const claude = fields.spawned.at(-1);
  check("a seat whose connector takes neither launches with neither", claude?.agent === "claude" && !("askPermissions" in claude) && !("reasoningEvents" in claude), claude);
  const spawn = fields.spawn.bind(fields);
  fields.spawn = async () => { throw new Error("pi connector does not support asking before tool use (askPermissions)"); };
  const refused = await errorOf(start("pi/default"));
  check("the manager's refusal of a launch field fails the prompt with its reason as is", refused?.message?.includes("does not support asking before tool use (askPermissions)") === true, refused);
  fields.spawn = spawn;
  c.conn.close();
}
// A catalog model whose id is `default`, as a custom endpoint serving one under that id lists it, is
// a model the spawn names. Without one, `<agent>/default` leaves the model to the application.
{
  const space = new FakeMesh();
  space.catalogList = [
    { agent: "hermes", available: true, eventPlane: true, models: [{ id: "default", variants: ["none", "low", "high"] }] },
    { agent: "claude", available: true, eventPlane: true, models: [{ id: "opus", variants: ["high"] }] },
  ];
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  const c = connect(async () => space);
  await c.init;
  const start = async (model: string, variant?: string): Promise<SpawnRequest | undefined> => {
    const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
    await c.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "model", value: model });
    if (variant) await c.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: "reasoning", value: variant });
    const before = space.spawned.length;
    await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
    return space.spawned.length > before ? space.spawned.at(-1) : undefined;
  };
  const listed = await start("hermes/default", "high");
  check("an application whose catalog lists a model with id default spawns naming that model, with the chosen variant",
    listed?.agent === "hermes" && listed.model === "default" && listed.variant === "high", listed);
  const own = await start("claude/default");
  check("an application whose catalog lists no default spawns naming no model", own?.agent === "claude" && !("model" in own) && !("variant" in own), own);
  c.conn.close();
}
// The seat's agent endpoint: the prompts its harness opens and the commands it runs.
{
  const space = new FakeMesh();
  // The bridge reads the seat's presence at each choice, so the test changes it in place.
  const shown = { interrupt: true, turn: true, images: true, usage: true };
  space.serving = shown;
  const c = connect(async () => space);
  await c.init;
  const at = new Date().toISOString();
  const content: PromptContent = {
    kind: "permission",
    title: "Run ls\u202E?",
    subject: { type: "tool", name: "Bash", input: { kind: "shown", value: { command: "ls" } } },
    options: [
      { id: "yes", label: "Yes", effect: "proceed" },
      { id: "always", label: "Yes, always", effect: "proceed", persists: "this session" },
      { id: "no", label: "No", effect: "refuse" },
      { id: "why", label: "No, and tell it why", effect: "refuse", note: "required" },
    ],
    source: { harness: "claude", toolCallId: "tc1" },
  };
  const promptOf = (id: string, digest = agentPromptDigest(content)): AgentPrompt => ({ id, digest, openedAt: at, expiresAt: at, state: { kind: "open" }, content });
  const summaryOf = (p: AgentPrompt): PromptSummary => ({ id: p.id, digest: p.digest, openedAt: at, expiresAt: at, state: p.state, kind: p.content.kind, title: p.content.title, contentBytes: 1 });
  const prompts = new Map<string, AgentPrompt>([["p1", promptOf("p1")]]);
  let seq = 1;
  let commandState: unknown = { kind: "started" };
  let turnRefusal: AgentCallFailed | undefined;
  let usage: unknown = { supported: true, context: { used: 5000, size: 200000 }, cost: { amount: 0.25, currency: "USD" } };
  space.onAgentCall = (_seat, command, args) => {
    switch (command) {
      case "prompts": return { runtime: { id: "rt", startedAt: 1 }, seq, open: [...prompts.values()].map(summaryOf), closed: [] };
      case "prompt": return { prompt: prompts.get(args.id as string) };
      case "prompt-answer": return { state: { kind: "sent" } };
      case "commands": return { supported: true, commands: [{ name: "review", target: "command", description: "Review the diff", inputHint: "what to review" }, { name: "humanizer", target: "skill" }, { name: "name", target: "command" }] };
      case "command": return { id: "cmd1" };
      case "command-state": return { state: commandState };
      case "turn":
        if (turnRefusal) throw turnRefusal;
        return { id: "turn1" };
      // Slower than the rest, as a harness read is, so a usage sent after the answer shows.
      case "usage": return tick(100).then(() => usage);
      case "interrupt": return { state: "interrupted" };
    }
    throw new AgentCallFailed(`unexpected ${command}`, "unimplemented");
  };
  const callsOf = (command: string) => space.agentCalls.filter((x) => x.command === command);
  c.answers.pick = (r) => ({ outcome: { outcome: "selected", optionId: r.options.find((o) => o.kind === "allow_once")!.optionId } });
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [] };
  const first = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
  await tick(50);
  const seat: SeatRef = { name: "acp-s1", owner: "local", actor: "actor-acp-s1", lifecycleUid: "life-acp-s1" };
  space.counters.set(seat.actor, { runtime: "rt", open: 1, seq });
  await tick(700);
  const asked = c.asked[0];
  check("a prompt the seat opens is asked as a permission request", c.asked.length === 1 && asked?.sessionId === s.sessionId, c.asked);
  check("its title names the seat, with invisible characters shown", asked?.toolCall.title === "acp-s1 asks: Run ls<U+202E>?", asked?.toolCall.title);
  check("it is the tool call the prompt is about, with its kind and input", asked?.toolCall.toolCallId === "tc1" && asked.toolCall.kind === "execute" && (asked.toolCall.rawInput as { command?: string }).command === "ls", asked?.toolCall);
  check("options that need a note are not offered, and the rest keep their kinds", JSON.stringify(asked?.options.map((o) => [o.optionId, o.kind])) === JSON.stringify([["yes", "allow_once"], ["always", "allow_always"], ["no", "reject_once"]]), asked?.options);
  const answered = callsOf("prompt-answer");
  check("the answer goes back with the digest the bridge checked", answered.length === 1 && answered[0]!.args.id === "p1" && answered[0]!.args.option === "yes" && answered[0]!.args.digest === agentPromptDigest(content), answered);
  seq = 2;
  space.counters.set(seat.actor, { runtime: "rt", open: 1, seq });
  await tick(600);
  check("a prompt is asked once, however often its list is read", c.asked.length === 1 && callsOf("prompts").length >= 2, { asked: c.asked.length, lists: callsOf("prompts").length });
  prompts.set("p2", promptOf("p2", "sha256:00"));
  seq = 3;
  space.counters.set(seat.actor, { runtime: "rt", open: 2, seq });
  await tick(600);
  check("a prompt whose content does not match its digest is not asked", c.asked.length === 1 && callsOf("prompt").some((x) => x.args.id === "p2"), c.asked.length);
  space.present.set(seat.actor, "idle");
  space.emit(seat, [{ type: "RUN_FINISHED", runId: "r1" }]);
  check("the turn still ends on its run", (await first)?.stopReason === "end_turn");
  await tick(50);

  const offered = c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "available_commands_update").at(-1)?.update as { availableCommands: { name: string; description?: string; input?: { hint?: string } }[] } | undefined;
  const names = offered?.availableCommands.map((x) => x.name) ?? [];
  check("the seat's commands are offered once it runs, its skills with a leading $", names.includes("review") && names.includes("$humanizer"), names);
  check("a seat command keeps its description and input hint", offered?.availableCommands.some((x) => x.name === "review" && x.description === "Review the diff" && x.input?.hint === "what to review") === true, offered);
  check("a seat command named like a session command is not offered", names.filter((n) => n === "name").length === 1, names);
  const run = (text: string) => within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text }] }));
  const usages = () => c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "usage_update").length;
  await tick(200);
  const usageBefore = usages();
  const ran = await run("/review the last commit");
  const usageAtAnswer = usages() - usageBefore;
  check("a seat command runs through command with its target, name and args", ran?.stopReason === "end_turn" && JSON.stringify(callsOf("command").at(-1)?.args) === JSON.stringify({ target: "command", name: "review", args: "the last commit" }), callsOf("command"));
  check("and waits until the seat took it", callsOf("command-state").length >= 1);
  check("the turn's usage reaches the client before its prompt answers", usageAtAnswer === 1, usageAtAnswer);
  await run("$humanizer");
  await tick(50);
  const usageSent = c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "usage_update").map((u) => u.update as unknown as { used: number; size: number; cost?: { amount: number } });
  check("after a turn the seat's context usage reaches the client", usageSent.some((u) => u.used === 5000 && u.size === 200000 && u.cost?.amount === 0.25), usageSent);
  check("a skill runs through command as a skill, with no args", JSON.stringify(callsOf("command").at(-1)?.args) === JSON.stringify({ target: "skill", name: "humanizer" }), callsOf("command"));
  commandState = { kind: "refused", code: "failed-precondition", message: "a turn is running" };
  c.updates.length = 0;
  const refused = await run("/review");
  const said = c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => JSON.stringify(u.update)).join("");
  check("a refused seat command is said in the thread and ends the prompt", refused?.stopReason === "end_turn" && said.includes("did not run /review: a turn is running"), said);

  commandState = { kind: "started" };
  space.onInput = (x) => { space.present.set(x.actor, "working"); setTimeout(() => space.present.set(x.actor, "idle"), 20); };
  const typedBefore = space.typed.length;
  const later = await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "and now this" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }));
  const turned = callsOf("turn").at(-1);
  check("a later prompt is a turn with the owner's words and images, and nothing is typed", later !== undefined && turned?.args.text === "and now this" && JSON.stringify(turned.args.images) === JSON.stringify([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]) && space.typed.length === typedBefore, { later, turned, typed: space.typed.slice(typedBefore) });
  turnRefusal = new AgentCallFailed("this agent's connector takes no turn from its owner", "unimplemented");
  const turnsAt = callsOf("turn").length;
  const failedTurn = await errorOf(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "not typed" }] }));
  check("a turn the seat refuses fails the prompt with its reason, and nothing is typed in its place",
    failedTurn?.message?.includes("takes no turn") === true && callsOf("turn").length === turnsAt + 1 && space.typed.length === typedBefore, { failedTurn, typed: space.typed.slice(typedBefore) });
  turnRefusal = undefined;
  shown.turn = false;
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "typed instead" }] }));
  check("a seat whose presence does not show turn now is typed into through its manager, and no turn is asked", space.typed.at(-1)?.text === "typed instead" && callsOf("turn").length === turnsAt + 1, space.typed.slice(typedBefore));
  const typedAt = space.typed.length;
  const noImages = await errorOf(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "see" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }));
  check("images to such a seat fail the prompt before anything is sent", noImages?.message?.includes("does not take images with a turn now") === true && space.typed.length === typedAt && callsOf("turn").length === turnsAt + 1, noImages);
  shown.turn = true;
  shown.images = false;
  const noPictures = await errorOf(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "see" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }));
  check("images to a seat that takes turns but shows no images fail before anything is sent", noPictures?.message?.includes("does not take images") === true && space.typed.length === typedAt && callsOf("turn").length === turnsAt + 1, noPictures);
  shown.images = true;
  space.onInput = () => {};

  let stopsAt = space.interrupted.length;
  space.present.set("actor-acp-s1", "working");
  const stopped = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "long job" }] }));
  await tick(400);
  await c.agent.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
  await tick(400);
  space.present.set("actor-acp-s1", "idle");
  check("a cancel goes to the seat's own interrupt where its presence says it serves it, and not to its manager",
    (await stopped)?.stopReason === "cancelled" && callsOf("interrupt").length === 1 && space.interrupted.length === stopsAt, { interrupts: callsOf("interrupt"), manager: space.interrupted.slice(stopsAt) });
  for (const [label, set] of [["shows interrupt false", () => { shown.interrupt = false; }], ["shows no agentEndpoint field", () => { space.serving = undefined; }]] as const) {
    set();
    const usagesAt = callsOf("usage").length;
    space.present.set("actor-acp-s1", "working");
    const keyed = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "long job" }] }));
    await tick(400);
    await c.agent.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
    await tick(400);
    space.present.set("actor-acp-s1", "idle");
    check(`a cancel to a seat whose presence ${label} goes to its manager's interrupt key, and not to the endpoint`,
      (await keyed)?.stopReason === "cancelled" && callsOf("interrupt").length === 1 && space.interrupted.length === stopsAt + 1, { interrupts: callsOf("interrupt").length, manager: space.interrupted.slice(stopsAt) });
    stopsAt++;
    if (label === "shows no agentEndpoint field")
      check("...and its usage is not read", callsOf("usage").length === usagesAt, callsOf("usage").length - usagesAt);
  }
  space.serving = shown;
  shown.interrupt = true;

  usage = { supported: false };
  const pictured = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  space.script = { before: [], after: [] };
  const turnsBefore = callsOf("turn").length;
  const pictureSeat: SeatRef = { name: "acp-s2", owner: "local", actor: "actor-acp-s2", lifecycleUid: "life-acp-s2" };
  const firstPicture = within(c.agent.request(methods.agent.session.prompt, { sessionId: pictured.sessionId, prompt: [{ type: "text", text: "what is this" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }));
  await tick(400);
  check("a first prompt with images spawns the seat with no first turn, and waits until it serves its endpoint", space.spawned.at(-1)?.prompt === undefined && callsOf("turn").length === turnsBefore, { spawned: space.spawned.at(-1), turns: callsOf("turn").length - turnsBefore });
  space.serves.set(pictureSeat.actor, { interrupt: false, turn: false, images: false, usage: false });
  space.counters.set(pictureSeat.actor, { runtime: "rt3", open: 0, seq: 0 });
  await tick(400);
  check("while it serves its endpoint but shows no turn yet, it still waits", callsOf("turn").length === turnsBefore, callsOf("turn").length - turnsBefore);
  space.serves.set(pictureSeat.actor, { interrupt: true, turn: true, images: true, usage: false });
  setTimeout(() => space.present.set(pictureSeat.actor, "idle"), 600);
  await firstPicture;
  check("then gives it the prompt as a turn with the images", callsOf("turn").length === turnsBefore + 1 && callsOf("turn").at(-1)?.args.text === "what is this" && callsOf("turn").at(-1)?.seat === "acp-s2", callsOf("turn").slice(turnsBefore));
  c.conn.close();
}
// A prompt whose read fails once, as when the transport drops, is read again and asked once.
{
  const space = new FakeMesh();
  const c = connect(async () => space);
  await c.init;
  const at = new Date().toISOString();
  const content: PromptContent = { kind: "permission", title: "Run ls?", options: [{ id: "yes", label: "Yes", effect: "proceed" }, { id: "no", label: "No", effect: "refuse" }] };
  const p1: AgentPrompt = { id: "p1", digest: agentPromptDigest(content), openedAt: at, expiresAt: at, state: { kind: "open" }, content };
  const summary: PromptSummary = { id: "p1", digest: p1.digest, openedAt: at, expiresAt: at, state: p1.state, kind: "permission", title: content.title, contentBytes: 1 };
  let seq = 1;
  let down = true;
  space.onAgentCall = (_seat, command) => {
    if (command === "prompts") return { runtime: { id: "rt", startedAt: 1 }, seq, open: [summary], closed: [] };
    if (command !== "prompt") throw new AgentCallFailed(`unexpected ${command}`, "unimplemented");
    if (!down) return { prompt: p1 };
    down = false;
    throw new AgentCallFailed("the seat did not answer", "unavailable");
  };
  const fetches = () => space.agentCalls.filter((x) => x.command === "prompt").length;
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [] };
  const turn = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
  await tick(50);
  const seat: SeatRef = { name: "acp-s1", owner: "local", actor: "actor-acp-s1", lifecycleUid: "life-acp-s1" };
  space.counters.set(seat.actor, { runtime: "rt", open: 1, seq });
  await tick(1000);
  check("a failed prompt read is logged", c.logs.some((l) => l.includes("prompt p1 not read: the seat did not answer")), c.logs);
  check("a prompt whose first read failed is read again on the same counter and asked", c.asked.length === 1 && fetches() === 2, { asks: c.asked.length, fetches: fetches() });
  seq = 2;
  space.counters.set(seat.actor, { runtime: "rt", open: 1, seq });
  await tick(600);
  check("once asked, it is not asked again when the counter moves", c.asked.length === 1 && fetches() === 2, { asks: c.asked.length, fetches: fetches() });
  space.present.set(seat.actor, "idle");
  space.emit(seat, [{ type: "RUN_FINISHED", runId: "r1" }]);
  check("the turn ends on its run", (await turn)?.stopReason === "end_turn");
  c.conn.close();
}
// A prompt the seat opens while the thread runs no turn, as when it works on mesh traffic between
// the thread's turns. A client takes a permission request only within a turn, so the thread's next
// prompt asks it, and that turn stays open until the client answers.
{
  const space = new FakeMesh();
  const c = connect(async () => space);
  await c.init;
  const at = new Date().toISOString();
  const content: PromptContent = { kind: "permission", title: "Run ls?", options: [{ id: "yes", label: "Yes", effect: "proceed" }, { id: "no", label: "No", effect: "refuse" }] };
  const p1: AgentPrompt = { id: "p1", digest: agentPromptDigest(content), openedAt: at, expiresAt: at, state: { kind: "open" }, content };
  const summary: PromptSummary = { id: "p1", digest: p1.digest, openedAt: at, expiresAt: at, state: p1.state, kind: "permission", title: content.title, contentBytes: 1 };
  let open: PromptSummary[] = [];
  let seq = 0;
  space.onAgentCall = (_seat, command) => {
    if (command === "prompts") return { runtime: { id: "rt", startedAt: 1 }, seq, open, closed: [] };
    if (command === "prompt") return { prompt: p1 };
    if (command === "prompt-answer") return { state: { kind: "sent" } };
    throw new AgentCallFailed(`unexpected ${command}`, "unimplemented");
  };
  const callsOf = (command: string) => space.agentCalls.filter((x) => x.command === command);
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const seat: SeatRef = { name: "acp-s1", owner: "local", actor: "actor-acp-s1", lifecycleUid: "life-acp-s1" };
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  space.counters.set(seat.actor, { runtime: "rt", open: 0, seq });
  const first = await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
  space.present.set(seat.actor, "idle");
  await tick(300);
  open = [summary];
  seq = 1;
  space.counters.set(seat.actor, { runtime: "rt", open: 1, seq });
  space.present.set(seat.actor, "waiting");
  await tick(1000);
  check("a prompt the seat opens between the thread's turns is read but not asked outside a turn", first?.stopReason === "end_turn" && callsOf("prompt").length === 1 && c.asked.length === 0, { first, fetches: callsOf("prompt").length, asks: c.asked.length });
  check("the bridge logs that it waits for the thread's next turn", c.logs.some((l) => l.includes("prompt p1 waits for the thread's next turn")), c.logs);
  let reply!: (r: RequestPermissionResponse) => void;
  c.answers.pick = () => new Promise((r) => { reply = r; });
  let answered = false;
  const next = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "next" }] })).then((r) => { answered = true; return r; });
  await tick(1200);
  check("the thread's next prompt asks it", c.asked.length === 1 && c.asked[0]?.toolCall.title === "acp-s1 asks: Run ls?", c.asked);
  check("and its turn stays open while the client has not answered", !answered, { answered });
  reply({ outcome: { outcome: "selected", optionId: "yes" } });
  space.present.set(seat.actor, "working");
  await tick(300);
  space.present.set(seat.actor, "idle");
  check("once answered, the answer goes back and the turn ends", (await next)?.stopReason === "end_turn" && callsOf("prompt-answer").length === 1 && callsOf("prompt-answer")[0]!.args.option === "yes", { next: await next, answers: callsOf("prompt-answer") });
  c.conn.close();
}
// On a running thread, the model and reasoning choices switch the seat through its `set-model`.
{
  const space = new FakeMesh();
  const shown = { interrupt: true, turn: true, images: true, usage: true, setModel: true };
  space.serving = shown;
  let refusal: AgentCallFailed | undefined;
  space.onAgentCall = (_seat, command, args) => {
    switch (command) {
      case "prompts": return { runtime: { id: "rt", startedAt: 1 }, seq: 0, open: [], closed: [] };
      case "commands": return { supported: false };
      case "usage": return { supported: false };
      case "set-model":
        if (refusal) throw refusal;
        return { model: args.model, ...(args.variant !== undefined ? { variant: args.variant } : {}) };
    }
    throw new AgentCallFailed(`unexpected ${command}`, "unimplemented");
  };
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  const c = connect(async () => space);
  await c.init;
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const set = (configId: string, value: string) => c.agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId, value });
  const current = (r: { configOptions?: readonly { id: string }[] | null } | undefined, id: string) => (r?.configOptions?.find((o) => o.id === id) as { currentValue?: string } | undefined)?.currentValue;
  const calls = () => space.agentCalls.filter((x) => x.command === "set-model").map((x) => x.args);
  await set("model", "claude/opus");
  space.counters.set(`actor-${s.sessionId}`, { runtime: "rt", open: 0, seq: 0 });
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
  let failed: unknown;
  const switched = await set("model", "claude/sonnet").catch((e: unknown) => { failed = e; return undefined; });
  check("choosing another model of the seat's application on a running thread switches the seat through set-model, and the options show it",
    JSON.stringify(calls()) === '[{"model":"sonnet"}]' && current(switched, "model") === "claude/sonnet", failed ?? { calls: calls(), options: switched?.configOptions });
  failed = undefined;
  const effort = await set("reasoning", "low").catch((e: unknown) => { failed = e; return undefined; });
  check("choosing a reasoning variant there switches it with the model it runs, and the options show it",
    JSON.stringify(calls().at(-1)) === '{"model":"sonnet","variant":"low"}' && current(effort, "reasoning") === "low", failed ?? { calls: calls(), options: effort?.configOptions });
  const before = calls().length;
  const harness = await errorOf(set("model", "pi/default"));
  check("a model of another application is refused there, naming /despawn, and switches nothing", harness?.code === -32602 && String(harness.message).includes("/despawn") && calls().length === before, harness);
  refusal = new AgentCallFailed("the harness has no model gpt-x", "failed-precondition");
  const refusedSwitch = await errorOf(set("model", "claude/haiku"));
  check("the seat's refusal fails the choice with its reason and keeps the model it runs",
    refusedSwitch?.code === -32602 && String(refusedSwitch.message).includes("has no model gpt-x"), refusedSwitch);
  refusal = undefined;
  const kept = await set("reasoning", "default").catch(() => undefined);
  check("...and keeps the model it runs: the model default variant switches that model",
    JSON.stringify(calls().at(-1)) === '{"model":"sonnet"}' && current(kept, "model") === "claude/sonnet" && current(kept, "reasoning") === "default", { calls: calls(), options: kept?.configOptions });
  const persona = await errorOf(set("persona", "reviewer"));
  check("an option that applies only at spawn is still refused on a running thread", persona?.code === -32602 && String(persona.message).includes("/despawn"), persona);
  space.serving = { ...shown, setModel: false };
  refusal = new AgentCallFailed("this agent's connector cannot switch its model now: the command mod is not running in this Claude Code session", "unimplemented");
  const unsupported = await errorOf(set("model", "claude/haiku"));
  check("a seat that shows it cannot switch now is refused with the harness, the seat's own cause and /despawn",
    unsupported?.code === -32602 && String(unsupported.message).includes("claude: this agent's connector cannot switch its model now: the command mod is not running") && String(unsupported.message).includes("/despawn"), unsupported);
  refusal = undefined;
  space.serving = { interrupt: true, turn: true, images: true, usage: true };
  const called = calls().length;
  const older = await errorOf(set("model", "claude/haiku"));
  check("a seat that predates set-model is refused with the harness named and /despawn, and nothing is called",
    older?.code === -32602 && String(older.message).includes("whose connector cannot switch") && String(older.message).includes("/despawn") && calls().length === called, older);
  c.conn.close();
}
// /name, /open and the thread links.
{
  const space = new FakeMesh();
  const c = connect(async () => space);
  await c.init;
  const say = async (sessionId: string, text: string): Promise<string> => {
    c.updates.length = 0;
    await within(c.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }));
    return c.updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text).join("\n");
  };
  const titles = (updates: SessionNotification[], sessionId: string) =>
    updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "session_info_update").map((u) => (u.update as { title?: string | null }).title);
  const named = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  await tick();
  const announced = c.updates.find((u) => u.sessionId === named.sessionId && u.update.sessionUpdate === "available_commands_update")?.update as { availableCommands?: { name: string; input?: { hint?: string } }[] } | undefined;
  check("/name and /open are announced with an input hint", ["name", "open"].every((n) => announced?.availableCommands?.some((cmd) => cmd.name === n && cmd.input?.hint)), announced);
  check("/name with a name the manager would refuse names why and keeps the session's name", (await say(named.sessionId, "/name Has Space")).includes("unsafe name") && space.spawned.length === 0);
  check("/name before the first prompt says what the agent will start as", (await say(named.sessionId, "/name scout")).includes("will start as scout"));
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: named.sessionId, prompt: [{ type: "text", text: "go" }] }));
  check("the first prompt after /name spawns the seat under that name", space.spawned[0]?.name === "scout", space.spawned);
  check("and stores the thread's link to the seat's run", JSON.stringify(c.links.rows.at(-1)) === JSON.stringify({ space: "fake", thread: named.sessionId, lifecycleUid: "life-scout" }), c.links.rows);
  check("once the agent starts, the thread is titled with its name", titles(c.updates, named.sessionId).at(-1) === "scout", titles(c.updates, named.sessionId));
  check("/name on a running seat changes the name it shows", (await say(named.sessionId, "/name Scout Two")).includes("now shows as Scout Two") && space.renamed.at(-1)?.name === "Scout Two", space.renamed);
  check("and retitles the thread with it", titles(c.updates, named.sessionId).at(-1) === "Scout Two", titles(c.updates, named.sessionId));
  space.renameRefusal = "no responder for agent.set-name";
  check("a refused rename says why in the thread", (await say(named.sessionId, "/name other")).includes("Could not rename scout: no responder for agent.set-name"));
  check("and keeps the title", titles(c.updates, named.sessionId).length === 0, titles(c.updates, named.sessionId));
  space.renameRefusal = undefined;
  c.updates.length = 0;
  space.show("actor-scout", "Login fix");
  await tick();
  check("a label the agent takes from its first message retitles the thread", JSON.stringify(titles(c.updates, named.sessionId)) === '["Login fix"]', titles(c.updates, named.sessionId));
  space.show("actor-scout", "Scout Three");
  await tick();
  check("so does a rename made elsewhere that its presence shows", titles(c.updates, named.sessionId).at(-1) === "Scout Three", titles(c.updates, named.sessionId));
  c.updates.length = 0;
  space.show("actor-scout", "Scout Three");
  space.show("actor-scout", undefined);
  await tick();
  check("an unchanged name, or a seat the roster stops showing, sends no title", titles(c.updates, named.sessionId).length === 0, titles(c.updates, named.sessionId));
  space.show("actor-scout", "Scout Three");

  const scout: SeatRow = { name: "scout", display: "Scout Two", owner: "local", actor: "actor-scout", lifecycleUid: "life-scout", managerInstanceId: "m1", agent: "claude", model: "haiku", cwd: dir, status: "running" };
  const helper: SeatRow = { name: "helper", display: "Helper Bee", owner: "local", actor: "actor-helper", lifecycleUid: "life-helper", managerInstanceId: "m1", agent: "pi", cwd: dir, status: "running" };
  space.rows = [scout, helper];
  space.present.set("actor-helper", "idle");
  space.history.set("helper", [{ plane: "events", owner: "local", actor: "actor-helper", threadId: "t", runId: "h1", epoch: "e", seq: 1, ts: Date.now(), events: [{ type: "TEXT_MESSAGE_START", messageId: "hm", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "hm", delta: "earlier work" }, { type: "TEXT_MESSAGE_END", messageId: "hm" }] }]);
  const listed = await c.agent.request(methods.agent.session.list, {});
  const scoutListed = listed.sessions.find((x) => x.title?.startsWith("Scout Two"));
  check("a linked seat is listed under its thread's id, titled with the name it shows", scoutListed?.sessionId === named.sessionId, listed.sessions);
  check("an unlinked seat is listed under its own name", listed.sessions.some((x) => x.sessionId === "helper" && x.title?.startsWith("Helper Bee")), listed.sessions);

  check("/open in a thread that already drives an agent is refused", (await say(named.sessionId, "/open helper")).includes("already drives scout"));
  const opener = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  check("/open of no running agent says so", (await say(opener.sessionId, "/open ghost")).includes("No agent named ghost is running"));
  const opened = await say(opener.sessionId, "/open helper bee");
  check("/open finds a seat by the name it shows and replays what the space retains", opened.includes("earlier work") && opened.includes("now drives Helper Bee"), opened);
  check("/open sets its line apart from the replayed messages", /earlier work[^]*\n\nThis session now drives/.test(opened), opened);
  check("/open titles the thread with the name the agent shows", titles(c.updates, opener.sessionId).at(-1) === "Helper Bee", titles(c.updates, opener.sessionId));
  check("/open stores the thread's link", JSON.stringify(c.links.rows.at(-1)) === JSON.stringify({ space: "fake", thread: opener.sessionId, lifecycleUid: "life-helper" }), c.links.rows);
  space.onInput = (seat) => { space.present.set(seat.actor, "working"); setTimeout(() => space.present.set(seat.actor, "idle"), 20); };
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: opener.sessionId, prompt: [{ type: "text", text: "next step" }] }));
  check("a prompt in the opened thread is typed into that seat", space.typed.at(-1)?.seat === "helper" && space.typed.at(-1)?.text === "next step", space.typed);
  space.onInput = () => {};

  const twin: SeatRow = { ...helper, name: "helper2", actor: "actor-helper2", lifecycleUid: "life-helper2" };
  space.rows = [scout, helper, twin];
  const third = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  check("/open names the choices when two seats show that name", (await say(third.sessionId, "/open Helper Bee")).includes("helper, helper2"));
  space.rows = [scout, helper];

  // Another bridge process, as a client runs one per thread, finds the threads through the links.
  const again = connect(async () => space);
  again.links.rows.push(...c.links.rows);
  await again.init;
  const reloaded = await again.agent.request(methods.agent.session.load, { sessionId: named.sessionId, cwd: dir, mcpServers: [] }).catch((e: unknown) => e);
  check("a thread whose seat has another name loads through its link", (reloaded as { configOptions?: unknown }).configOptions !== undefined, reloaded);
  await tick();
  const loadedTitles = again.updates.filter((u) => u.sessionId === named.sessionId && u.update.sessionUpdate === "session_info_update");
  check("a loaded thread is titled with the name its agent shows now, not as replay", titles(loadedTitles, named.sessionId).at(-1) === "Scout Three" && loadedTitles.every((u) => u._meta?.isReplay !== true), loadedTitles);
  again.updates.length = 0;
  space.emit(scout, [{ type: "TEXT_MESSAGE_START", messageId: "s2", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "s2", delta: "still here" }], "r9");
  await tick();
  check("and follows that seat live", again.updates.some((u) => u.sessionId === named.sessionId && JSON.stringify(u.update).includes("still here")), again.updates);
  await again.agent.request(methods.agent.session.delete, { sessionId: opener.sessionId });
  check("deleting a linked thread hides its seat's run", again.hidden.ids.has("life-helper"), [...again.hidden.ids]);
  again.conn.close();
  c.conn.close();
}

// The client's thread server: a stand-in for T3 Code's `t3-code`, listed in session/new.
{
  const space = new FakeMesh();
  const c = connect(async () => space);
  await c.init;
  const at = (name: string) => join(dir, name);
  const state = at("thread.json");
  const setThread = (t: { title: string; failRead?: string }, file = state, threadId = "t3-thread-1") => writeFileSync(file, JSON.stringify({ threadId, ...t }));
  setThread({ title: "New thread" });
  const fixture = fileURLToPath(new URL("./fake-thread-server.mjs", import.meta.url));
  const server = (name: string, env: Record<string, string>, tools?: string): McpServerStdio =>
    ({ name, command: process.execPath, args: tools ? [fixture, tools] : [fixture], env: Object.entries(env).map(([key, value]) => ({ name: key, value })) });
  // With servers in the list the SDK types session/new's answer as unknown, so it is typed here.
  const newThread = (mcpServers: McpServerStdio[]) => c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers }) as Promise<NewSessionResponse>;
  const servers = (calls: string, file = state) =>
    [server("other", { THREAD_STATE: file, THREAD_CALLS: at("other-calls.jsonl") }, "t3_thread_read"), server("t3-code", { THREAD_STATE: file, THREAD_CALLS: calls })];
  type Event = { start?: string[]; list?: true; tool?: string; args?: { title?: string } };
  const events = (file: string): Event[] => {
    try {
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
    } catch {
      return [];
    }
  };
  const kinds = (file: string) => events(file).map((e) => (e.start ? "start" : e.list ? "list" : e.tool));
  const title = (file = state) => (JSON.parse(readFileSync(file, "utf8")) as { title: string }).title;
  const writes = (file: string) => events(file).filter((e) => e.tool === "t3_thread_update").map((e) => e.args?.title);
  const until = async (done: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await tick(50);
    return done();
  };
  const calls = at("thread-calls.jsonl");
  const s = await newThread(servers(calls));
  const said = (): string => c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text).join("\n");
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
  await until(() => title() === "acp-s1");
  check("once the agent starts, the client's thread server titles the thread with its name", title() === "acp-s1" && JSON.stringify(writes(calls)) === '["acp-s1"]', { title: title(), writes: writes(calls) });
  check("the bridge starts the thread server with only the variables the client gave it", JSON.stringify(events(calls)[0]?.start) === '["THREAD_CALLS","THREAD_STATE"]', events(calls)[0]);
  check("a listed server without the thread tools is started and listed once, and never called", JSON.stringify(kinds(at("other-calls.jsonl"))) === '["start","list"]', kinds(at("other-calls.jsonl")));
  let labelledAtInput = -1;
  space.onInput = (seat) => { labelledAtInput = space.relabelled.length; space.present.set(seat.actor, "working"); setTimeout(() => space.present.set(seat.actor, "idle"), 20); };
  const prompt = (text: string, sessionId = s.sessionId) => within(c.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }));
  setThread({ title: "Login work" });
  await prompt("next");
  check("a rename in the client labels the agent before the next prompt reaches it, and keeps its name",
    JSON.stringify(space.relabelled) === '[{"seat":"acp-s1","label":"Login work"}]' && space.renamed.length === 0 && labelledAtInput === 1 && space.typed.at(-1)?.text === "next",
    { relabelled: space.relabelled, renamed: space.renamed, labelledAtInput, typed: space.typed.at(-1) });
  check("and is not written back to the client", !writes(calls).includes("Login work"), writes(calls));
  space.show("actor-acp-s1", "Fixing login");
  await until(() => title() === "Fixing login");
  await prompt("again");
  check("a name the agent shows is written to the client, and is not read back as a rename",
    title() === "Fixing login" && JSON.stringify(writes(calls)) === '["acp-s1","Fixing login"]' && space.relabelled.length === 1 && space.typed.at(-1)?.text === "again",
    { title: title(), writes: writes(calls), relabelled: space.relabelled });
  setThread({ title: "Fixing login", failRead: "the thread store is down" });
  c.updates.length = 0;
  await prompt("still");
  check("a read the client's server fails is said in the thread and logged, and the prompt still runs",
    said().includes("the thread store is down") && c.logs.some((l) => l.includes("the thread store is down")) && space.typed.at(-1)?.text === "still", { said: said(), typed: space.typed.at(-1) });
  setThread({ title: "Other/name" });
  space.labelRefusal = 'invalid name "Other/name": "/" is reserved (the owner/name separator)';
  c.updates.length = 0;
  await prompt("onward");
  check("a label the agent refuses is said in the thread, the title goes back to the agent's name, and the prompt still runs",
    said().includes('Could not rename acp-s1 to "Other/name": invalid name') && title() === "Fixing login" && space.typed.at(-1)?.text === "onward", { said: said(), title: title(), typed: space.typed.at(-1) });
  space.labelRefusal = undefined;
  const stored = c.links.rows.filter((r) => r.thread === s.sessionId && r.title !== undefined);
  check("each title the bridge wrote or read is stored with the thread's link to the seat's run",
    JSON.stringify(stored.map((r) => r.title)) === '["New thread","acp-s1","Login work","Fixing login","Other/name","Fixing login"]' && stored.every((r) => r.lifecycleUid === "life-acp-s1"),
    stored);

  const state2 = at("thread-2.json");
  setThread({ title: "New thread" }, state2, "t3-thread-2");
  const calls2 = at("thread-calls-2.jsonl");
  const s2 = await newThread(servers(calls2, state2));
  await prompt("go", s2.sessionId);
  await until(() => title(state2) === "acp-s2");
  check("a second session starts the thread server with its own variables, and the bridge lists no server again",
    title(state2) === "acp-s2" && title() === "Fixing login" && kinds(calls2)[0] === "start" && !kinds(calls2).includes("list") && JSON.stringify(kinds(at("other-calls.jsonl"))) === '["start","list"]',
    { title: title(state2), calls: kinds(calls2), other: kinds(at("other-calls.jsonl")) });
  c.conn.close();
  await tick(50);

  // A load in a new bridge, as a client starts one per thread.
  space.rows = [{ name: "acp-s1", owner: "local", actor: "actor-acp-s1", lifecycleUid: "life-acp-s1", managerInstanceId: "m1", agent: "claude", cwd: dir, status: "running" }];
  const loadIn = async (links: ThreadLink[], calls: string) => {
    const b = connect(async () => space);
    b.links.rows.push(...links.map((link) => ({ space: space.space, ...link })));
    await b.init;
    await b.agent.request(methods.agent.session.load, { sessionId: s.sessionId, cwd: dir, mcpServers: [server("t3-code", { THREAD_STATE: state, THREAD_CALLS: calls })] });
    return b;
  };
  const labels = space.relabelled.length;
  space.show("actor-acp-s1", "Login v2");
  const first = await loadIn(c.links.rows, at("load-1.jsonl"));
  await until(() => title() === "Login v2");
  check("a load in a new bridge titles the client's thread with the name the agent shows now, when the thread kept the title its link stored",
    title() === "Login v2" && space.relabelled.length === labels, { title: title(), relabelled: space.relabelled });
  first.conn.close();
  await tick(50);
  setThread({ title: "Signup flow" });
  const second = await loadIn(first.links.rows, at("load-2.jsonl"));
  await until(() => space.relabelled.length > labels);
  await tick(200);
  check("a load in a new bridge labels the agent with a title the person gave the thread while no bridge ran, and keeps that title",
    JSON.stringify(space.relabelled.slice(labels)) === '[{"seat":"acp-s1","label":"Signup flow"}]' && title() === "Signup flow" && writes(at("load-2.jsonl")).length === 0,
    { relabelled: space.relabelled, title: title(), writes: writes(at("load-2.jsonl")) });
  second.conn.close();
  await tick(50);
  setThread({ title: "Picked elsewhere" });
  const third = await loadIn(c.links.rows.filter((r) => r.title === undefined), at("load-3.jsonl"));
  await until(() => title() !== "Picked elsewhere");
  check("with no title stored with the link, a load titles the client's thread with the name the agent shows",
    title() === "Signup flow" && space.relabelled.length === labels + 1, { title: title(), relabelled: space.relabelled });
  third.conn.close();
}

// A space whose persona catalog and channel list are longer than a client select shows.
{
  const space = new BigMesh();
  const c = connect(async () => space);
  await c.init;
  type Select = { currentValue: string; options: { value: string }[] };
  const select = (options: unknown[] | null | undefined, id: string) => (options as { id: string }[] | null | undefined)?.find((o) => o.id === id) as Select | undefined;
  const values = (o: Select | undefined) => o?.options.map((x) => x.value) ?? [];
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const persona = select(s.configOptions, "persona");
  const channel = select(s.configOptions, "channel");
  check("a persona catalog longer than a select still offers a short persona select at the default", persona?.currentValue === "default" && values(persona)[0] === "default" && values(persona).length < MAX_CHOICES, values(persona));
  check("it offers the personas the caller owns", JSON.stringify(values(persona)) === JSON.stringify(["default", "mine-a", "mine-b"]), values(persona));
  check("a channel list longer than a select still offers a short channel select at no channel", channel?.currentValue === "none" && values(channel)[0] === "none" && values(channel).length < MAX_CHOICES, values(channel));
  check("it offers the channels the space describes, then the busiest", values(channel)[1] === "ops" && values(channel)[2] === "ch-69" && values(channel)[3] === "ch-68", values(channel));
  await tick();
  const commands = () => (c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "available_commands_update").at(-1)?.update as { availableCommands: { name: string; input?: { hint?: string } }[] } | undefined)?.availableCommands ?? [];
  check("/persona and /join are announced with an input hint", ["persona", "join"].every((n) => commands().some((x) => x.name === n && x.input?.hint)), commands().map((x) => x.name));
  const say = async (text: string): Promise<string> => {
    c.updates.length = 0;
    await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text }] }).catch((e: unknown) => e));
    return c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text).join("\n");
  };
  const updated = (id: string) => select((c.updates.filter((u) => u.sessionId === s.sessionId && u.update.sessionUpdate === "config_option_update").at(-1)?.update as { configOptions?: unknown[] } | undefined)?.configOptions, id);
  const picked = await say("/persona p-50");
  check("/persona picks a persona the short select does not list", picked.includes("p-50") && space.spawned.length === 0, picked);
  check("and the select then holds it as its current value", updated("persona")?.currentValue === "p-50" && values(updated("persona")).includes("p-50"), updated("persona"));
  const missing = await say("/persona nobody");
  check("/persona with a name the catalog lacks fails with one line and keeps the choice", missing.split("\n").length === 1 && missing.includes(`no persona "nobody"`) && space.spawned.length === 0, missing);
  const joined = await say("/join ch-03");
  check("/join picks a channel the short select does not list", joined.includes("ch-03") && updated("channel")?.currentValue === "ch-03" && values(updated("channel")).includes("ch-03"), { joined, channel: updated("channel") });
  check("/join with a channel the space lacks fails with one line", (await say("/join nowhere")).includes(`no channel "nowhere"`) && space.spawned.length === 0);
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }).catch((e: unknown) => e));
  const req = space.spawned[0];
  check("the first prompt spawns with the persona and channel the commands chose", req?.persona === "p-50" && JSON.stringify(req.subscribe) === '["ch-03"]', req);
  await tick(50);
  check("once the agent runs, /persona and /join are no longer offered", commands().length > 0 && !commands().some((x) => x.name === "persona" || x.name === "join"), commands().map((x) => x.name));
  space.onInput = (seat) => { space.present.set(seat.actor, "working"); setTimeout(() => space.present.set(seat.actor, "idle"), 20); };
  await say("/persona p-51");
  check("and a running agent gets /persona as its own words", space.typed.at(-1)?.text === "/persona p-51", space.typed);
  space.onInput = () => {};
  await say("/despawn");
  await tick(50);
  check("after /despawn, /persona and /join are offered again for the next agent", ["persona", "join"].every((n) => commands().some((x) => x.name === n)), commands().map((x) => x.name));

  const small = connect(async () => new FakeMesh());
  await small.init;
  const fits = await small.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  await tick();
  const offered = (small.updates.filter((u) => u.update.sessionUpdate === "available_commands_update").at(-1)?.update as { availableCommands: { name: string }[] } | undefined)?.availableCommands ?? [];
  check("a list that fits keeps its full select, and offers no command for it", JSON.stringify(values(select(fits.configOptions, "persona"))) === '["default","reviewer"]' && JSON.stringify(values(select(fits.configOptions, "channel"))) === '["none","general","ops"]' && !offered.some((x) => x.name === "persona" || x.name === "join"), { options: fits.configOptions, offered });
  small.conn.close();
  c.conn.close();
}

// A prompt the seat queues behind work the thread did not start (SPEC 13.22: a queued one waits for
// no fixed time). Each case runs on its own space, all at once.
async function queuedSeat(): Promise<{ space: FakeMesh; c: ReturnType<typeof connect>; s: { sessionId: string }; seat: SeatRef; state: { now: unknown; gone?: boolean }; cancels: string[] }> {
  const space = new FakeMesh();
  space.serving = { interrupt: true, turn: true, images: true, usage: false };
  const c = connect(async () => space);
  await c.init;
  const state: { now: unknown; gone?: boolean } = { now: { kind: "started" } };
  const cancels: string[] = [];
  space.onAgentCall = (x, command, args) => {
    // As the space answers for a seat no longer on the roster.
    if (state.gone) throw new AgentCallFailed(`${x.name} is not on the roster with its runtime`, "unavailable");
    switch (command) {
      case "prompts": return { runtime: { id: "rt", startedAt: 1 }, seq: 0, open: [], closed: [] };
      case "commands": return { supported: true, commands: [{ name: "review", target: "command" }] };
      case "command": return { id: "queuedcmd" };
      case "turn": return { id: "queuedturn" };
      case "command-state": return { state: state.now };
      case "command-cancel":
        cancels.push(args.id as string);
        if ((state.now as { kind: string }).kind !== "queued") throw new AgentCallFailed("no longer queued", "conflict");
        state.now = { kind: "cancelled" };
        return { state: state.now };
      case "interrupt": return { state: "interrupted" };
    }
    throw new AgentCallFailed(`unexpected ${command}`, "unimplemented");
  };
  const s = await c.agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
  space.script = { before: [[{ type: "RUN_STARTED", runId: "r1" }]], after: [[{ type: "RUN_FINISHED", runId: "r1" }]] };
  await within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }));
  const seat: SeatRef = { name: "acp-s1", owner: "local", actor: "actor-acp-s1", lifecycleUid: "life-acp-s1" };
  space.counters.set(seat.actor, { runtime: "rt", open: 0, seq: 0 });
  space.present.set(seat.actor, "idle");
  await tick(300);
  // The seat runs mesh work the thread did not start, so what the thread sends next is queued.
  space.present.set(seat.actor, "working");
  state.now = { kind: "queued" };
  return { space, c, s, seat, state, cancels };
}
const said = (c: ReturnType<typeof connect>, sessionId: string, from = 0) =>
  c.updates.slice(from).filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk").map((u) => (u.update as { content: { text: string } }).content.text);
await Promise.all([
  ...(["the prompt", "/review"] as const).map(async (text) => {
    const { space, c, s, seat, state } = await queuedSeat();
    let atAnswer = 0;
    const answer = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text }] }), 30_000).then((r) => { atAnswer = c.updates.length; return r; });
    // The mesh work ends after 12 s, longer than any fixed wait, and the seat takes the queued one half a second later.
    await tick(12_000);
    space.present.set(seat.actor, "idle");
    await tick(500);
    state.now = { kind: "started" };
    space.present.set(seat.actor, "working");
    space.emit(seat, [{ type: "RUN_STARTED", runId: "q" }, { type: "TEXT_MESSAGE_START", messageId: "mq", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "mq", delta: `ran ${text}` }, { type: "TEXT_MESSAGE_END", messageId: "mq" }], "q");
    await tick(300);
    space.emit(seat, [{ type: "RUN_FINISHED", runId: "q" }], "q");
    space.present.set(seat.actor, "idle");
    const reply = await answer;
    const before = said(c, s.sessionId).slice(0, said(c, s.sessionId).length - said(c, s.sessionId, atAnswer).length);
    check(`${text} queued behind other work answers only once its own run reached the thread`, reply?.stopReason === "end_turn" && before.includes(`ran ${text}`), { reply, before, after: said(c, s.sessionId, atAnswer) });
    check(`${text} queued behind other work is not reported as not run`, !said(c, s.sessionId).some((x) => /did not run|not started|failed/.test(x)), said(c, s.sessionId));
    c.conn.close();
  }),
  (async () => {
    const { space, c, s, seat, state, cancels } = await queuedSeat();
    const reply = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "never mind" }] }), 30_000);
    await tick(2000);
    await c.agent.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
    const answer = await reply;
    const interrupts = space.agentCalls.filter((x) => x.command === "interrupt").length;
    check("a prompt cancelled while queued answers cancelled", answer?.stopReason === "cancelled", answer);
    check("...and leaves the queue through command-cancel, so it never runs", JSON.stringify(cancels) === '["queuedturn"]' && JSON.stringify(state.now) === '{"kind":"cancelled"}', { cancels, state: state.now });
    check("...and does not interrupt the work the thread did not start", interrupts === 0, interrupts);
    space.present.set(seat.actor, "idle");
    c.conn.close();
  })(),
  (async () => {
    const { space, c, s, seat, state, cancels } = await queuedSeat();
    const reply = within(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "too late" }] }), 30_000);
    await tick(1000);
    state.now = { kind: "taken" };
    await c.agent.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
    await tick(500);
    state.now = { kind: "started" };
    await tick(1000);
    space.present.set(seat.actor, "idle");
    const answer = await reply;
    const interrupts = space.agentCalls.filter((x) => x.command === "interrupt").length;
    check("a prompt cancelled once the seat took it answers cancelled and interrupts its run", answer?.stopReason === "cancelled" && interrupts === 1 && JSON.stringify(state.now) === '{"kind":"started"}', { answer, interrupts, cancels, state: state.now });
    c.conn.close();
  })(),
  (async () => {
    const { space, c, s, seat, state } = await queuedSeat();
    const failed = errorOf(c.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: "lost" }] }));
    await tick(1000);
    space.present.delete(seat.actor);
    state.gone = true;
    const e = await within(failed, 10_000);
    check("a prompt whose seat leaves while it is queued fails, saying the seat left before it took it", e?.message?.includes("acp-s1 left before it took the prompt") === true, e);
    c.conn.close();
  })(),
]);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
