// A fake `codex app-server` for the host smoke: speaks just enough of the JSON-RPC v2
// protocol to drive the host's turn loop, and journals everything it sees to
// FAKE_CODEX_LOG (JSONL) so the smoke can assert on it. Turn behavior is scripted by
// the injected text: TOOL:roster → issue an item/tool/call first; SLOW → hold the turn
// open ~1.2s (a steer window); HANG → hold until an interrupt arrives, else self-
// interrupt after ~1s; FAIL → complete with status "failed"; default → complete.
import { appendFileSync } from "node:fs";

const logPath = process.env.FAKE_CODEX_LOG;
const journal = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
journal({ ev: "argv", argv: process.argv.slice(2) });

let nextServerId = 1000;
const pendingServerReqs = new Map();
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
const serverRequest = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pendingServerReqs.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });

const THREAD = "t_fake";
let turnSeq = 0;
let activeTurn;
let interruptWaiter;
let hangUsed = false; // HANG is one-shot: its REDELIVERED batch must complete normally
let failUsed = false; // FAIL is one-shot: its RETRIED batch must complete normally

async function runTurn(text) {
  const turnId = `turn_${++turnSeq}`;
  activeTurn = turnId;
  notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });

  if (text.includes("TOOL:roster")) {
    const res = await serverRequest("item/tool/call", {
      threadId: THREAD,
      turnId,
      callId: `call_${turnSeq}`,
      namespace: null,
      tool: "cotal_roster",
      arguments: {},
    });
    journal({ ev: "toolReply", turnId, result: res });
  }
  if (text.includes("SLOW")) await new Promise((r) => setTimeout(r, 1200));
  if (text.includes("HANG") && !hangUsed) {
    hangUsed = true;
    await new Promise((r) => {
      interruptWaiter = r;
      setTimeout(r, 1000); // self-interrupt fallback: a human hit Esc
    });
    interruptWaiter = undefined;
    activeTurn = undefined;
    notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "interrupted" } });
    return;
  }
  if (text.includes("DIE")) process.exit(3); // the app-server crashed mid-turn
  const status = text.includes("FAIL") && !failUsed ? "failed" : "completed";
  if (status === "failed") failUsed = true;
  if (status === "completed")
    notify("item/completed", {
      threadId: THREAD,
      turnId,
      item: { type: "agentMessage", id: `msg_${turnSeq}`, text: `ok:${turnSeq}`, phase: "final_answer" },
    });
  activeTurn = undefined;
  notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // Replies to our own server→client requests.
    if (msg.id !== undefined && pendingServerReqs.has(msg.id)) {
      pendingServerReqs.get(msg.id)(msg.result ?? msg.error);
      pendingServerReqs.delete(msg.id);
      continue;
    }
    const { id, method, params } = msg;
    journal({ ev: "recv", method, params });
    switch (method) {
      case "initialize":
        if (params?.capabilities?.experimentalApi !== true) {
          write({ jsonrpc: "2.0", id, error: { code: -32600, message: "experimentalApi capability required" } });
          break;
        }
        reply(id, { userAgent: "fake-codex/0.0.0" });
        break;
      case "initialized":
        break; // notification
      case "thread/start":
        reply(id, { thread: { id: THREAD }, model: "fake-model" });
        notify("thread/started", { thread: { id: THREAD } });
        break;
      case "turn/start": {
        const text = (params?.input ?? []).map((i) => i.text ?? "").join("\n");
        reply(id, { turn: { id: `turn_${turnSeq + 1}`, status: "inProgress" } });
        void runTurn(text);
        break;
      }
      case "turn/steer": {
        if (params?.expectedTurnId !== activeTurn) {
          write({ jsonrpc: "2.0", id, error: { code: -32600, message: "turn already completed" } });
          break;
        }
        reply(id, {});
        break;
      }
      case "turn/interrupt":
        reply(id, {});
        if (interruptWaiter) interruptWaiter();
        break;
      default:
        if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled: ${method}` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
