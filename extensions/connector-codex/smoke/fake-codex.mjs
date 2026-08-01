// A fake `codex app-server` for the host smoke: speaks just enough of the JSON-RPC v2
// protocol to drive the host's turn loop, and journals everything it sees to
// FAKE_CODEX_LOG (JSONL) so the smoke can assert on it. Turn behavior is scripted by
// the injected text: TOOL:roster → issue an item/tool/call first; SLOW → hold the turn
// open ~1.2s (a steer window); HANG → hold until an interrupt arrives, else self-
// interrupt after ~1s; FAIL → complete with status "failed"; default → complete.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const logPath = process.env.FAKE_CODEX_LOG;
const DIED_MARK = `${logPath ?? "/tmp/fake-codex"}.died`;
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
let rejectStartUsed = false; // REJECTSTART rejects the first matching turn/start RPC, once
let activeTurnIsRace = false; // RACE: answer a steer and complete the turn in ONE write

async function runTurn(text) {
  const turnId = `turn_${++turnSeq}`;
  activeTurn = turnId;
  activeTurnIsRace = text.includes("RACE");
  notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });

  if (activeTurnIsRace) {
    // Hold the turn open for a steer window; the steer handler completes it (same-write race).
    // Fallback completion if no steer arrives, so the smoke can't hang.
    setTimeout(() => {
      if (activeTurn === turnId) {
        activeTurn = undefined;
        activeTurnIsRace = false;
        notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
      }
    }, 3000);
    return;
  }

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
  if (text.includes("DIE") && !existsSync(DIED_MARK)) {
    // The app-server crashes mid-turn. One-shot ACROSS PROCESSES (a marker file — the restart is
    // a brand-new process): the host respawns us, re-drives the same un-acked batch, and THAT
    // turn must complete, which is what tells recovery apart from a crash loop.
    writeFileSync(DIED_MARK, "1");
    journal({ ev: "died", turnId });
    process.exit(3);
  }
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
        // FAKE_CODEX_DIE_ALWAYS=1 makes EVERY incarnation die shortly after the thread is up —
        // a genuine crash loop, so the host's bounded-restart rail must give up and exit fatal
        // instead of respawning forever.
        if (process.env.FAKE_CODEX_DIE_ALWAYS === "1") setTimeout(() => process.exit(4), 150);
        break;
      case "account/read":
        // FAKE_CODEX_NOAUTH=1 simulates a logged-out codex (auth-honesty smoke case).
        reply(id, {
          account: process.env.FAKE_CODEX_NOAUTH === "1" ? null : { type: "fake", planType: "test" },
          requiresOpenaiAuth: true,
        });
        break;
      case "turn/start": {
        const text = (params?.input ?? []).map((i) => i.text ?? "").join("\n");
        if (text.includes("REJECTSTART") && !rejectStartUsed) {
          rejectStartUsed = true;
          write({ jsonrpc: "2.0", id, error: { code: -32000, message: "transient: try again" } });
          break;
        }
        if (text.includes("SAMECHUNK")) {
          // The adversarial timing: the turn/start RESPONSE, turn/started, and turn/completed all
          // arrive in ONE stdout write, so the client processes both notifications synchronously
          // before the awaited turn/start continuation runs. A response-side id adoption would
          // resurrect the just-completed turn (falsely busy forever); correct handling ignores it.
          const tid = `turn_${++turnSeq}`;
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id, result: { turn: { id: tid, status: "inProgress" } } }) + "\n" +
              JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD, turn: { id: tid, status: "inProgress" } } }) + "\n" +
              JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId: THREAD, turnId: tid, item: { type: "agentMessage", id: `m_${tid}`, text: "ok", phase: "final_answer" } } }) + "\n" +
              JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD, turn: { id: tid, status: "completed" } } }) + "\n",
          );
          break;
        }
        reply(id, { turn: { id: `turn_${turnSeq + 1}`, status: "inProgress" } });
        void runTurn(text);
        break;
      }
      case "turn/steer": {
        if (params?.expectedTurnId !== activeTurn) {
          write({ jsonrpc: "2.0", id, error: { code: -32600, message: "turn already completed" } });
          break;
        }
        if (activeTurnIsRace) {
          // The adversarial interleaving: the steer ACCEPT and the turn's completion land in
          // ONE stdout chunk, so the client processes the terminal event in the same tick as
          // the accept resolution. The steered content is NOT processed by this turn.
          const turnId = activeTurn;
          activeTurn = undefined;
          activeTurnIsRace = false;
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", id, result: {} }) +
              "\n" +
              JSON.stringify({
                jsonrpc: "2.0",
                method: "turn/completed",
                params: { threadId: THREAD, turn: { id: turnId, status: "completed" } },
              }) +
              "\n",
          );
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
