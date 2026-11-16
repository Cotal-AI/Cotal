// Scratch stand-in for `codex app-server`. Speaks the JSON-RPC the real host expects.
// A turn whose text contains FAILFOREVER records a final answer, then ends failed.
// Every later turn of that same text does the same. There is no one-shot latch.
// A turn whose text contains COMPLETEONCE ends completed.
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const logPath = process.env.FAKE_CODEX_LOG;
const journal = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
};
const argv = process.argv.slice(2);
journal({ ev: "argv", pid: process.pid });

const tokenFile = argv.includes("--ws-token-file") ? argv[argv.indexOf("--ws-token-file") + 1] : undefined;
const expectedToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined;
let sock;
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("listening", () => {
  process.stderr.write(
    `codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:${wss.address().port}\n` +
      `  note: binds localhost only (use SSH port-forwarding for remote access)\n`,
  );
});
wss.on("connection", (ws, req) => {
  const auth = req.headers.authorization ?? "";
  if (expectedToken && auth !== `Bearer ${expectedToken}`) {
    journal({ ev: "unauthorized" });
    ws.close(1008, "unauthorized");
    return;
  }
  if (sock) {
    journal({ ev: "observer" });
    return;
  }
  journal({ ev: "connected" });
  sock = ws;
  ws.on("message", (data) => onChunk(String(data)));
});
const raw = (s) => sock?.send(s);
const write = (obj) => raw(JSON.stringify(obj) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

const THREAD = "t_repro";
let turnSeq = 0;
let buf = "";

function textOf(params) {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  return input.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n");
}

function finish(turnId, text, status) {
  const answer = status === "failed" ? "model answered before the failure" : "model completed the turn";
  const started = JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId: THREAD, turn: { id: turnId, status: "inProgress" } },
  });
  const item = JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: THREAD,
      turnId,
      item: { id: `item_${turnId}`, type: "agentMessage", text: answer },
    },
  });
  const done = JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: THREAD,
      turn: {
        id: turnId,
        status,
        ...(status === "failed"
          ? { error: { message: "stream completion withheld", codexErrorInfo: "streamClosed", willRetry: false } }
          : {}),
      },
    },
  });
  journal({ ev: "turn", turnId, status, text });
  if (status === "failed") appendFileSync(`${logPath}.answers`, `${turnId}\n`);
  raw(`${started}\n${item}\n${done}\n`);
}

function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    journal({ ev: "bad", line });
    return;
  }
  journal({ ev: "recv", method: msg.method, id: msg.id });
  if (msg.method === "initialize") {
    reply(msg.id, {
      userAgent: "fake-repro",
      codexHome: process.env.CODEX_HOME ?? null,
    });
    notify("mcpServer/startupStatus/updated", { name: "cotal", status: "ready" });
    return;
  }
  if (msg.method === "account/read") {
    reply(msg.id, { account: { type: "fake", planType: "test" }, requiresOpenaiAuth: true });
    return;
  }
  if (msg.id !== undefined && msg.method !== "turn/start" && msg.method !== "thread/start") {
    reply(msg.id, {});
    return;
  }
  if (msg.method === "thread/start") {
    reply(msg.id, { thread: { id: THREAD }, model: "fake-model" });
    return;
  }
  if (msg.method === "turn/start") {
    const text = textOf(msg.params);
    const turnId = `turn_${++turnSeq}`;
    reply(msg.id, { turn: { id: turnId } });
    const status = text.includes("FAILFOREVER") ? "failed" : "completed";
    finish(turnId, text, status);
  }
}

function onChunk(chunk) {
  onLine(chunk);
}

process.stdin.resume();
await new Promise(() => {});
