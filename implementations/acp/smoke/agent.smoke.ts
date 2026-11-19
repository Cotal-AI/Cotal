/**
 * The ACP agent's protocol promises, driven by the ACP SDK's own client over an in-process
 * connection, against a fake space. No broker, no manager.
 *
 *  - `initialize` offers session load, list and delete, and a terminal sign-in only to a client that
 *    can run one;
 *  - opening the space fails as -32000 when signing in fixes it, and as an internal error otherwise;
 *  - `session/new` launches nothing and offers `<agent>/default` first, without applications that
 *    publish no event plane; deleting it hides nothing;
 *  - the first prompt spawns the seat in the session's folder with that prompt, every update of the
 *    turn reaches the client before the prompt answers, frames that beat the spawn reply are kept,
 *    and a tool call left open is closed;
 *  - a failed run fails the prompt with the seat's message;
 *  - `session/list` hides deleted runs and matches a folder through symlinks;
 *  - `session/load` replays before it answers, marked as replay, then follows live;
 *  - the slash commands answer locally, and `/despawn` stops the seat.
 *
 * Run: pnpm --filter @cotal-ai/acp test
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk";
import { cotalAgent, promptText, type HiddenSessions } from "../src/agent.js";
import { SignInRequired, type AgentCatalog, type AguiEventLike, type Mesh, type SeatFrame, type SeatRef, type SeatRow, type SpawnRequest } from "../src/mesh.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "acp-smoke-"));
const link = join(dir, "link");
symlinkSync(dir, link);

const CATALOGS: AgentCatalog[] = [
  { agent: "hermes", available: true, eventPlane: false, models: [] },
  { agent: "claude", available: true, eventPlane: true, models: [{ id: "opus", variants: ["high", "low"] }, { id: "sonnet", variants: ["low"] }, { id: "haiku", variants: [] }] },
  { agent: "pi", available: true, eventPlane: true, models: [] },
];

/** A space held in memory. A test scripts what a seat publishes with `script`. */
class FakeMesh implements Mesh {
  readonly space = "fake";
  readonly userMode = false;
  readonly defaultAgent = "claude";
  spawned: SpawnRequest[] = [];
  despawned: string[] = [];
  rows: SeatRow[] = [];
  history = new Map<string, SeatFrame[]>();
  present = new Set<string>();
  closed = false;
  /** Frames a spawned seat publishes: `before` ahead of the spawn reply, `after` once it answered. */
  script: { before: AguiEventLike[][]; after: AguiEventLike[][] } = { before: [], after: [] };
  private listeners: ((f: SeatFrame) => void)[] = [];
  private seq = 0;

  emit(seat: SeatRef, events: AguiEventLike[], runId = "r1"): void {
    const f: SeatFrame = { owner: seat.owner, actor: seat.actor, threadId: "t", runId, epoch: "e", seq: ++this.seq, events, ts: Date.now() };
    for (const l of this.listeners) l(f);
  }
  async catalogs() { return CATALOGS; }
  async managers() { return [{ instanceId: "m1", host: "here", local: true }]; }
  async personas() { return ["default", "reviewer"]; }
  async spawn(req: SpawnRequest): Promise<SeatRef> {
    this.spawned.push(req);
    const seat: SeatRef = { name: req.name, owner: "local", actor: `actor-${req.name}`, lifecycleUid: `life-${req.name}`, managerInstanceId: "m1" };
    this.present.add(seat.actor);
    for (const e of this.script.before) this.emit(seat, e);
    const after = this.script.after;
    setTimeout(() => { for (const e of after) this.emit(seat, e); }, 10);
    return seat;
  }
  async seats() { return this.rows; }
  async despawn(seat: SeatRef) { this.despawned.push(seat.name); }
  async dm(): Promise<{ storedAt: number }> { throw new Error("not used"); }
  followFrames(on: (f: SeatFrame) => void) { this.listeners.push(on); return () => (this.listeners = this.listeners.filter((l) => l !== on)); }
  async frameHistory(seat: SeatRef) { return this.history.get(seat.name) ?? []; }
  presence(seat: SeatRef) { return this.present.has(seat.actor) ? "working" : undefined; }
  async roster() { return [{ name: "alice", status: "idle", role: "reviewer" }]; }
  async channels() { return ["general", "ops"]; }
  async close() { this.closed = true; }
}

class MemoryHidden implements HiddenSessions {
  readonly ids = new Set<string>();
  read() { return new Set(this.ids); }
  add(id: string) { this.ids.add(id); }
}

function connect(open: () => Promise<Mesh>, terminal = true) {
  const updates: SessionNotification[] = [];
  const hidden = new MemoryHidden();
  let n = 0;
  const app = cotalAgent({ mesh: open, hidden, log: () => {}, version: "0.0.0-smoke", newName: () => `acp-s${++n}` });
  const conn = client({ name: "smoke" })
    .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
    .connect(app);
  const init = conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: terminal ? { auth: { terminal: true } } : {} });
  return { agent: conn.agent, conn, updates, hidden, init };
}
const errorOf = async (p: Promise<unknown>): Promise<{ code?: number; message?: string } | undefined> => {
  try { await p; return undefined; } catch (e) { return e as { code?: number; message?: string }; }
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

// session/new, options, delete of an unspawned session
const mesh = new FakeMesh();
const { agent, conn, updates, hidden, init } = connect(async () => mesh);
await init;
const created = await agent.request(methods.agent.session.new, { cwd: link, mcpServers: [] });
const model = created.configOptions?.find((o) => o.id === "model") as { currentValue: string; options: { group: string; options: { value: string }[] }[] } | undefined;
check("session/new launches nothing", mesh.spawned.length === 0);
check("the model select starts at the default application's own default", model?.currentValue === "claude/default", model);
check("applications without an event plane are not offered", !model?.options.some((g) => g.group === "hermes"), model?.options.map((g) => g.group));
check("each application lists its default first", model?.options.every((g) => g.options[0]!.value === `${g.group}/default`) === true, model);
await tick();
check("the session's slash commands are announced", updates.some((u) => u.sessionId === created.sessionId && u.update.sessionUpdate === "available_commands_update"));
const probe = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
await agent.request(methods.agent.session.delete, { sessionId: probe.sessionId });
check("deleting a session that never spawned hides nothing", hidden.ids.size === 0, [...hidden.ids]);

// options
const sid = created.sessionId;
const set = (configId: string, value: string) => agent.request(methods.agent.session.setConfigOption, { sessionId: sid, configId, value });
let opts = (await set("model", "claude/opus")).configOptions;
check("a model with variants offers the variant option", opts.some((o) => o.id === "variant"), opts.map((o) => o.id));
await set("variant", "high");
opts = (await set("model", "claude/sonnet")).configOptions;
const variant = opts.find((o) => o.id === "variant") as { currentValue?: string } | undefined;
check("a variant does not carry to a model that lacks it", variant?.currentValue === "default", variant);
opts = (await set("model", "claude/haiku")).configOptions;
check("a model without variants offers no variant option", !opts.some((o) => o.id === "variant"), opts);
const bad = await errorOf(set("model", "hermes/default"));
check("an application without an event plane is refused as invalid params", bad?.code === -32602 && bad.message?.includes("event plane") === true, bad);
opts = (await set("model", "claude/my-custom")).configOptions;
const custom = opts.find((o) => o.id === "model") as unknown as { currentValue: string; options: { options: { value: string }[] }[] };
check("a custom model id is accepted and offered as a choice", custom.currentValue === "claude/my-custom" && custom.options.some((g) => g.options.some((o) => o.value === "claude/my-custom")), custom);
await set("model", "claude/opus");
await set("persona", "reviewer");
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
const answer = await agent.request(methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text: "do it" }, { type: "resource_link", name: "spec", uri: "file:///spec.md" }] });
const seen = updates.filter((u) => u.sessionId === sid).map((u) => u.update);
const req = mesh.spawned[0];
check("the first prompt spawns one seat named after the session", mesh.spawned.length === 1 && req?.name === sid, mesh.spawned);
check("it spawns in the session's folder with the prompt and the chosen options", req?.cwd === link && req.prompt === "do it\n\n[spec](file:///spec.md)" && req.agent === "claude" && req.model === "opus" && req.persona === "reviewer" && req.managerInstanceId === "m1" && JSON.stringify(req.subscribe) === '["ops"]', req);
check("the prompt answers end_turn", answer.stopReason === "end_turn", answer);
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
mesh.history.set("outside", [{ owner: "local", actor: "o1", threadId: "t", runId: "r0", epoch: "e", seq: 900, ts: 1, events: [{ type: "TEXT_MESSAGE_START", messageId: "h", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "h", delta: "earlier" }, { type: "TOOL_CALL_START", toolCallId: "old", toolCallName: "Bash" }] }]);
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

// despawn
updates.length = 0;
await agent.request(methods.agent.session.prompt, { sessionId: "outside", prompt: [{ type: "text", text: "/despawn" }] });
check("/despawn stops the session's seat", mesh.despawned.includes("outside"), mesh.despawned);

// a failed run
const second = await agent.request(methods.agent.session.new, { cwd: dir, mcpServers: [] });
mesh.script = { before: [], after: [[{ type: "RUN_STARTED", runId: "r1" }, { type: "TOOL_CALL_START", toolCallId: "z", toolCallName: "Bash" }], [{ type: "RUN_ERROR", message: "rate limited" }]] };
updates.length = 0;
const failed = await errorOf(agent.request(methods.agent.session.prompt, { sessionId: second.sessionId, prompt: [{ type: "text", text: "go" }] }));
check("a failed run fails the prompt with the seat's message", failed?.code === -32603 && failed.message?.includes("rate limited") === true, failed);
check("its open tool call is closed as failed", updates.some((u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { status: string }).status === "failed"), updates);

let threw = false;
try { promptText([{ type: "image", data: "", mimeType: "image/png" }]); } catch { threw = true; }
check("image content is refused", threw);

conn.close();
await tick(20);
check("closing the client closes the space", mesh.closed);
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
