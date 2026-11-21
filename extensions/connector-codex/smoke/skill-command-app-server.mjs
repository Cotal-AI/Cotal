// Scratch stand-in for `codex app-server`, answering as codex-cli 0.170.0 was measured to:
// `skills/list` is `{ data: [{ cwd, skills: [{ name, description, path, scope, enabled }], errors }] }`,
// a `turn/start` that names a skill carries it as `{ type: "skill", name, path }`, and
// `turn/interrupt` answers `{}` for a live turn, which then ends `interrupted`, or the error
// -32600 "no active turn to interrupt" when none runs.
// A turn whose text contains HOLD-OPEN stays open until interrupted. One whose text contains
// RACE-END also stays open, and an interrupt finds it already ending: the interrupt is refused, then
// the turn completes. Every other turn completes at once.
import { appendFileSync, readFileSync } from "node:fs";
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

function endTurn(turnId, status) {
  notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status } });
}

function onMessage(msg) {
  journal({ ev: "recv", method: msg.method, id: msg.id, ...(msg.method === "turn/start" ? { input: msg.params?.input } : {}) });
  if (msg.method === "initialize") {
    reply(msg.id, { userAgent: "fake-skills", codexHome: process.env.CODEX_HOME ?? null });
    notify("mcpServer/startupStatus/updated", { name: "cotal", status: "ready" });
  } else if (msg.method === "account/read") reply(msg.id, { account: { type: "fake" }, requiresOpenaiAuth: true });
  else if (msg.method === "thread/start") reply(msg.id, { thread: { id: THREAD }, model: "fake-model" });
  else if (msg.method === "skills/list") reply(msg.id, { data: [{ cwd, skills: SKILLS, errors: [] }] });
  else if (msg.method === "turn/start") {
    const turnId = `turn_${++turnSeq}`;
    reply(msg.id, { turn: { id: turnId, status: "inProgress" } });
    notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
    const text = (msg.params?.input ?? []).map((i) => i?.text ?? "").join("\n");
    if (text.includes("HOLD-OPEN")) held = turnId;
    else if (text.includes("RACE-END")) racing = turnId;
    else endTurn(turnId, "completed");
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
