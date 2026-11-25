// Scratch stand-in for `codex app-server`, answering as codex-cli 0.170.0 was measured to:
// `skills/list` is `{ data: [{ cwd, skills: [{ name, description, path, scope, enabled }], errors }] }`,
// a `turn/start` that names a skill carries it as `{ type: "skill", name, path }`, and
// `turn/interrupt` answers `{}` for a live turn, which then ends `interrupted`, or the error
// -32600 "no active turn to interrupt" when none runs.
// A turn whose text contains HOLD-OPEN stays open until interrupted. One whose text contains
// RACE-END also stays open, and an interrupt finds it already ending: the interrupt is refused, then
// the turn completes. Every other turn completes at once, after `thread/tokenUsage/updated` reports
// 1000 + the turn's number as the last call's total tokens, in a 258400-token window.
// `model/list` answers MODELS over two pages. `thread/settings/update`
// sets the model and effort later turns run on, answers `{}` and sends `thread/settings/updated`,
// except for fake-refused, which it refuses as Codex refuses an override it cannot apply. Each
// journaled `turn/start` carries `runs`, the model and effort that turn runs on. When
// `<FAKE_CODEX_LOG>.crash` exists, this app-server removes it and exits, as a crash does.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const logPath = process.env.FAKE_CODEX_LOG;
const journal = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
};
const argv = process.argv.slice(2);
const tokenFile = argv.includes("--ws-token-file") ? argv[argv.indexOf("--ws-token-file") + 1] : undefined;
const expectedToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined;
let sock;
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("listening", () => {
  process.stderr.write(`codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:${wss.address().port}\n`);
});
wss.on("connection", (ws, req) => {
  if (expectedToken && (req.headers.authorization ?? "") !== `Bearer ${expectedToken}`) return void ws.close(1008, "unauthorized");
  if (sock) return;
  sock = ws;
  ws.on("message", (data) => { for (const line of String(data).split("\n")) if (line.trim()) onMessage(JSON.parse(line)); });
});
const write = (obj) => sock?.send(JSON.stringify(obj) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

const THREAD = "t_skills";
const cwd = process.cwd();
const skill = (name, description, path, scope, enabled = true) => ({ name, description, path, scope, enabled, pluginId: null });
const SKILLS = [
  skill("smoke-echo", "Reply with the word PINEAPPLE.", `${cwd}/.agents/skills/smoke-echo/SKILL.md`, "repo"),
  skill("smoke-off", "A skill the user turned off.", `${cwd}/.agents/skills/smoke-off/SKILL.md`, "repo", false),
  skill("smoke-echo", "A user skill the repo skill shadows.", "/home/someone/.agents/skills/smoke-echo/SKILL.md", "user"),
  skill("imagegen", "Generate or edit raster images.", "/codex-home/skills/.system/imagegen/SKILL.md", "system"),
];
let turnSeq = 0;
let held;
let racing;
const model = (name, efforts, effort) => ({
  id: name, model: name, displayName: name, description: "", hidden: false, isDefault: name === "fake-model",
  supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: e })), defaultReasoningEffort: effort,
});
const MODELS = [[model("fake-model", ["low", "medium", "high"], "medium")], [model("fake-next", ["low", "high"], "high"), model("fake-refused", ["low"], "low")]];
const thread = { model: "fake-model", effort: null };

/** What the journal keeps of a request besides its method. */
function seen(msg) {
  if (msg.method === "turn/start")
    return { input: msg.params?.input, model: msg.params?.model, effort: msg.params?.effort, runs: { model: msg.params?.model ?? thread.model, effort: msg.params?.effort ?? thread.effort } };
  if (msg.method === "thread/settings/update" || msg.method === "model/list") return { params: msg.params };
  return {};
}

function listModels(msg) {
  const page = msg.params?.cursor === "page-2" ? 1 : 0;
  reply(msg.id, { data: MODELS[page], nextCursor: page === 0 ? "page-2" : null });
}

function updateSettings(msg) {
  const { model: name, effort } = msg.params ?? {};
  if (name === "fake-refused") return void write({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `invalid thread settings override: ${name} is not available here` } });
  if (name !== undefined) thread.model = name;
  if (effort !== undefined) thread.effort = effort;
  reply(msg.id, {});
  notify("thread/settings/updated", { threadId: THREAD, threadSettings: { ...thread } });
}

const CRASH = logPath ? `${logPath}.crash` : undefined;
if (CRASH) setInterval(() => {
  if (!existsSync(CRASH)) return;
  rmSync(CRASH, { force: true });
  journal({ ev: "died" });
  process.exit(3);
}, 50).unref();

function endTurn(turnId, status) {
  notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status } });
}

function reportUsage(turnId) {
  const tokens = (total) => ({ totalTokens: total, inputTokens: total - 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 });
  notify("thread/tokenUsage/updated", { threadId: THREAD, turnId, tokenUsage: { total: tokens(5000), last: tokens(1000 + turnSeq), modelContextWindow: 258400 } });
}

function onMessage(msg) {
  journal({ ev: "recv", method: msg.method, id: msg.id, ...seen(msg) });
  if (msg.method === "initialize") {
    reply(msg.id, { userAgent: "fake-skills", codexHome: process.env.CODEX_HOME ?? null });
    notify("mcpServer/startupStatus/updated", { name: "cotal", status: "ready" });
  } else if (msg.method === "account/read") reply(msg.id, { account: { type: "fake" }, requiresOpenaiAuth: true });
  else if (msg.method === "thread/start") reply(msg.id, { thread: { id: THREAD }, model: "fake-model" });
  else if (msg.method === "skills/list") reply(msg.id, { data: [{ cwd, skills: SKILLS, errors: [] }] });
  else if (msg.method === "model/list") listModels(msg);
  else if (msg.method === "thread/settings/update") updateSettings(msg);
  else if (msg.method === "turn/start") {
    const turnId = `turn_${++turnSeq}`;
    reply(msg.id, { turn: { id: turnId, status: "inProgress" } });
    notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
    const text = (msg.params?.input ?? []).map((i) => i?.text ?? "").join("\n");
    if (text.includes("HOLD-OPEN")) held = turnId;
    else if (text.includes("RACE-END")) racing = turnId;
    else {
      reportUsage(turnId);
      endTurn(turnId, "completed");
    }
  } else if (msg.method === "turn/interrupt") {
    if (racing !== undefined && msg.params?.turnId === racing) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "no active turn to interrupt" } });
      endTurn(racing, "completed");
      racing = undefined;
      return;
    }
    if (held === undefined || msg.params?.turnId !== held) return void write({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "no active turn to interrupt" } });
    const turnId = held;
    held = undefined;
    reply(msg.id, {});
    endTurn(turnId, "interrupted");
  } else if (msg.id !== undefined) reply(msg.id, {});
}

process.stdin.resume();
await new Promise(() => {});
