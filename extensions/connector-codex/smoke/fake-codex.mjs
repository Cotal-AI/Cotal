// A fake `codex app-server` for the host smoke: speaks just enough of the JSON-RPC v2
// protocol to drive the host's turn loop, and journals everything it sees to
// FAKE_CODEX_LOG (JSONL) so the smoke can assert on it. Turn behavior is scripted by
// the injected text: TOOL:roster → call the cotal_* MCP endpoint the host is serving;
// SLOW → hold the turn open ~1.2s (a steer window); HANG → hold until an interrupt
// arrives, else self-interrupt after ~1s; FAIL → complete with status "failed";
// default → complete.
//
// Like the real thing, this fake is an MCP *client*: the cotal_* tools are not on the
// websocket at all, they are fetched over the loopback HTTP endpoint named in its own
// `-c mcp_servers.cotal.url` with the bearer token from its env. That is what makes the
// smoke exercise the same path a TUI-initiated turn takes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";

const logPath = process.env.FAKE_CODEX_LOG;
const DIED_MARK = `${logPath ?? "/tmp/fake-codex"}.died`;
/** One-shot marker for FAKE_CODEX_DIE_BEFORE_MCP: only the FIRST incarnation dies, so the host's
 *  restart really does have a healthy successor to bring up. */
const MCP_DIED_MARK = `${logPath ?? "/tmp/fake-codex"}.mcpdied`;
const journal = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const argv = process.argv.slice(2);
journal({ ev: "argv", argv, pid: process.pid });

// `codex resume --remote …` is the TUI, not the app-server. Journal how the host invoked it (the
// smoke asserts the url / token-env / thread-id wiring, and that the token really is passed by
// env name rather than on argv), then sit here like a running UI until killed. The top-level
// await also stops the app-server body below from running in this process.
// FAKE_CODEX_TUI_EXIT=1 quits instead, driving the "operator closed the UI" path.
if (argv[0] === "resume") {
  const tokenEnv = argv[argv.indexOf("--remote-auth-token-env") + 1];
  journal({ ev: "tui", argv, tokenFromEnv: tokenEnv ? (process.env[tokenEnv] ?? null) : null });
  if (process.env.FAKE_CODEX_TUI_EXIT === "1") setTimeout(() => process.exit(0), 300);
  // FAKE_CODEX_TUI_CRASH=1: the UI dies of its own accord. Indistinguishable from a quit at the
  // process level except for the CODE, which is the whole point — read as a quit, an operator is
  // returned to a shell prompt with a clean exit and nothing to go on.
  if (process.env.FAKE_CODEX_TUI_CRASH === "1") setTimeout(() => process.exit(3), 300);
  // FAKE_CODEX_TUI_ATTACH=1 behaves like the real TUI: it holds a websocket to the listener and
  // DIES when that listener goes away. That is what makes an app-server crash with a UI attached
  // testable — the host must read that exit as "the transport died", not "the operator quit".
  if (process.env.FAKE_CODEX_TUI_ATTACH === "1") {
    const remote = argv[argv.indexOf("--remote") + 1];
    const { WebSocket } = await import("ws");
    const sock = new WebSocket(remote, { headers: { Authorization: `Bearer ${process.env[tokenEnv] ?? ""}` } });
    sock.on("open", () => journal({ ev: "tuiAttached" }));
    sock.on("close", () => {
      journal({ ev: "tuiTransportGone" });
      process.exit(0);
    });
    sock.on("error", () => {
      journal({ ev: "tuiTransportGone" });
      process.exit(0);
    });
  }
  await new Promise(() => {});
}

// ---- the cotal_* MCP endpoint (what the host serves, and what real codex dials) ----------
// The URL rides argv as a `-c` override; the token rides env BY NAME, never argv.
const cfgValue = (key) => {
  for (let i = 0; i < argv.length - 1; i++)
    if (argv[i] === "-c" && argv[i + 1].startsWith(`${key}=`)) return argv[i + 1].slice(key.length + 1).replace(/^"|"$/g, "");
  return undefined;
};
const MCP_URL = cfgValue("mcp_servers.cotal.url");
const MCP_TOKEN = process.env.COTAL_MCP_TOKEN;
// Proves the env boundary in BOTH directions at once: the child gets the one capability it
// needs and none of the agent's mesh identity.
journal({
  ev: "env",
  mcpTokenPresent: Boolean(MCP_TOKEN),
  cotalLeak: Object.keys(process.env).filter((k) => k.startsWith("COTAL_") && k !== "COTAL_MCP_TOKEN"),
});

/** The endpoint answers SSE (`data: {…}`) for a POSTed request; plain JSON otherwise. */
const parseRpc = (text) => {
  const data = text.split("\n").filter((l) => l.startsWith("data:"));
  const payload = data.length ? data[data.length - 1].slice(5).trim() : text;
  try {
    return JSON.parse(payload);
  } catch {
    return { raw: text };
  }
};

/** Minimal streamable-HTTP MCP client: initialize → initialized → tools/call. */
async function mcpCall(tool, args, { token = MCP_TOKEN } = {}) {
  if (!MCP_URL) throw new Error("no mcp_servers.cotal.url on argv");
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const init = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "0.0.0" } },
    }),
  });
  if (!init.ok) return { httpStatus: init.status };
  const sid = init.headers.get("mcp-session-id");
  await init.text();
  const withSession = { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) };
  await fetch(MCP_URL, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  return { httpStatus: res.status, body: parseRpc(await res.text()) };
}

let nextServerId = 1000;
const pendingServerReqs = new Map();
// The transport is a websocket LISTENER, not stdio — that is what lets a second client (the real
// TUI) attach to the same thread the host drives. Auth is enforced the way the real app-server
// does it under `--ws-auth capability-token`, so the smoke also proves the host presents its
// token rather than relying on the listener being open.
const tokenFile = argv.includes("--ws-token-file") ? argv[argv.indexOf("--ws-token-file") + 1] : undefined;
const expectedToken = tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined;
let sock;
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
wss.on("listening", () => {
  // The banner the host parses for the OS-assigned port. On STDERR and byte-shaped like the real
  // one: codex-cli 0.145 prints it there, and a fake that used stdout would let a stdout-only
  // parser pass here and hang against the real binary (which is exactly what happened once).
  process.stderr.write(
    `codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:${wss.address().port}\n` +
      `  note: binds localhost only (use SSH port-forwarding for remote access)\n`,
  );
});
wss.on("connection", (ws, req) => {
  const auth = req.headers.authorization ?? "";
  if (expectedToken && auth !== `Bearer ${expectedToken}`) {
    journal({ ev: "unauthorized", auth: auth ? "wrong" : "absent" });
    ws.close(1008, "unauthorized");
    return;
  }
  // The FIRST client is the host — that connection is the protocol channel. Later clients are
  // observers (the attached TUI), exactly as the real listener treats them: they see the stream
  // but must never displace the host's channel.
  if (sock) {
    journal({ ev: "observer" });
    return;
  }
  journal({ ev: "connected" });
  sock = ws;
  ws.on("message", (data) => onChunk(String(data)));
});
/** Send raw text. ONE frame may carry several newline-delimited messages, which is how the race
 *  cases below still reproduce "everything arrived in a single chunk" against a client that
 *  splits on newlines. */
const raw = (s) => sock?.send(s);
const write = (obj) => raw(JSON.stringify(obj) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
const serverRequest = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pendingServerReqs.set(id, resolve);
    journal({ ev: "serverRequest", method, id });
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
let soloUsed = false; // SOLOTUI is one-shot
let foreignUsed = false; // FOREIGN is one-shot: the REDELIVERED batch must complete normally

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
    // The model calls a cotal tool. Exactly as real codex does it: over MCP, from THIS process,
    // with no involvement from whichever client happens to own the turn.
    try {
      const res = await mcpCall("cotal_roster", {});
      journal({ ev: "toolReply", turnId, result: res });
    } catch (e) {
      journal({ ev: "toolReply", turnId, error: String(e) });
    }
    // The same call without the bearer token must be refused — loopback alone is not the
    // boundary on a shared machine.
    try {
      const bad = await mcpCall("cotal_roster", {}, { token: "" });
      journal({ ev: "toolReplyNoAuth", turnId, httpStatus: bad.httpStatus });
    } catch (e) {
      journal({ ev: "toolReplyNoAuth", turnId, error: String(e) });
    }
  }
  if (text.includes("SOLOTUI") && !soloUsed) {
    // A turn the human started with NOTHING of ours open. The host must still pump its buffered
    // traffic when this ends — otherwise a DM that arrived while someone was typing sits in the
    // inbox until unrelated traffic happens to wake the loop.
    soloUsed = true;
    const solo = `turn_solo_${turnSeq}`;
    activeTurn = undefined;
    notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
    await new Promise((r) => setTimeout(r, 200));
    notify("turn/started", { threadId: THREAD, turn: { id: solo, status: "inProgress" } });
    journal({ ev: "soloTuiTurn", id: solo });
    await new Promise((r) => setTimeout(r, 2500));
    notify("turn/completed", { threadId: THREAD, turn: { id: solo, status: "completed" } });
    return;
  }
  if (text.includes("FOREIGN") && !foreignUsed) {
    // A turn this host did NOT start — what the attached TUI produces when a human types. The
    // app-server broadcasts turn lifecycle to every client, so the host SEES it.
    //
    // The discriminator: the FOREIGN turn completes successfully while OUR turn is still open,
    // and our turn then ends INTERRUPTED. A host that treats any terminal as its own boundary
    // acks the batch on the foreign `completed` and the message is lost forever; a host that
    // only finalizes turns it started leaves it un-acked, so it redelivers. One-shot, so the
    // redelivery completes normally.
    foreignUsed = true;
    const foreign = `turn_tui_${turnSeq}`;
    notify("turn/started", { threadId: THREAD, turn: { id: foreign, status: "inProgress" } });
    await new Promise((r) => setTimeout(r, 150));
    notify("turn/completed", { threadId: THREAD, turn: { id: foreign, status: "completed" } });
    await new Promise((r) => setTimeout(r, 250));
    activeTurn = undefined;
    notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "interrupted" } });
    return;
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

// One websocket frame is a complete unit (no partial message carries across frames), but it may
// pack several newline-delimited messages — the same rule the client applies.
function onChunk(d) {
  for (const rawLine of d.split("\n")) {
    const line = rawLine.trim();
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
    // A reply with no matching outstanding request of OURS. Under a correct client this cannot
    // happen; a reply pinned to a DEAD incarnation leaking into this one shows up here, which is
    // exactly what the cross-incarnation smoke asserts never appears.
    if (method === undefined) {
      journal({ ev: "stray", id, msg });
      continue;
    }
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
        // Real codex reports each configured MCP server's startup here. The host gates presence
        // on the cotal server reaching `ready`, so a peer never advertises online without its
        // tools. FAKE_CODEX_MCP_FAIL=1 reports the failure instead, which must be fatal.
        notify("mcpServer/startupStatus/updated", { threadId: THREAD, name: "cotal", status: "starting", error: null });
        setTimeout(
          () =>
            notify("mcpServer/startupStatus/updated", {
              threadId: THREAD,
              name: "cotal",
              status: process.env.FAKE_CODEX_MCP_FAIL === "1" ? "failed" : "ready",
              error: process.env.FAKE_CODEX_MCP_FAIL === "1" ? "connection refused" : null,
            }),
          50,
        );
        // FAKE_CODEX_DIE_ALWAYS=1 makes EVERY incarnation die shortly after the thread is up —
        // a genuine crash loop, so the host's bounded-restart rail must give up and exit fatal
        // instead of respawning forever.
        if (process.env.FAKE_CODEX_DIE_ALWAYS === "1") setTimeout(() => process.exit(4), 150);
        // FAKE_CODEX_DIE_BEFORE_MCP=1: the FIRST incarnation dies with the thread up but the cotal
        // server never reported ready (the `ready` above is still 50ms out). That strands the
        // host's LAUNCH tail mid-`awaitMcpReady` on a child that no longer exists, while the crash
        // rail is already bringing up a replacement — the interleaving where a stale tail can
        // adopt the successor's readiness, drive on it, and (on its failure branch) tear it down.
        if (process.env.FAKE_CODEX_DIE_BEFORE_MCP === "1" && !existsSync(MCP_DIED_MARK)) {
          writeFileSync(MCP_DIED_MARK, "1");
          setTimeout(() => process.exit(7), 20);
        }
        break;
      case "thread/inject_items":
        // The host primes the thread at start so a rollout exists for the TUI to resume.
        reply(id, {});
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
        if (text.includes("NOSTART")) {
          // Accept the turn (so the host CLAIMS it from this response) but never emit
          // `turn/started`; then terminate it. A host that needs both events to close its ledger
          // waits forever for a boundary that can no longer come.
          const tid = `turn_nostart_${++turnSeq}`;
          reply(id, { turn: { id: tid, status: "inProgress" } });
          setTimeout(
            () => notify("turn/completed", { threadId: THREAD, turn: { id: tid, status: "completed" } }),
            300,
          );
          break;
        }
        if (text.includes("LATERESP")) {
          // The opposite permitted ordering to NOSTART: `turn/started` AND `turn/completed` both
          // arrive BEFORE the response that names the turn. JSON-RPC does not order a notification
          // after the response to a request still in flight, so a client that can only claim a turn
          // from that response sees a live-but-unclaimed id, calls the terminal somebody else's,
          // and then claims an already-dead turn — its own accounting never closes.
          const tid = `turn_lateresp_${++turnSeq}`;
          notify("turn/started", { threadId: THREAD, turn: { id: tid, status: "inProgress" } });
          notify("item/completed", {
            threadId: THREAD,
            turnId: tid,
            item: { type: "agentMessage", id: `m_${tid}`, text: "late response", phase: "final_answer" },
          });
          notify("turn/completed", { threadId: THREAD, turn: { id: tid, status: "completed" } });
          setTimeout(() => reply(id, { turn: { id: tid, status: "inProgress" } }), 120);
          break;
        }
        if (text.includes("SAMECHUNK")) {
          // The adversarial timing: the turn/start RESPONSE, turn/started, and turn/completed all
          // arrive in ONE stdout write, so the client processes both notifications synchronously
          // before the awaited turn/start continuation runs. A response-side id adoption would
          // resurrect the just-completed turn (falsely busy forever); correct handling ignores it.
          const tid = `turn_${++turnSeq}`;
          raw(
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
          raw(
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
        // FAKE_CODEX_DIE_ON_INTERRUPT=1 makes the child die on interrupt WITHOUT replying. That
        // pins the shutdown ordering: the host is suspended inside `await driver.interrupt()`
        // when the child dies, so the driver's finalizer rejects that request and emits `closed`
        // strictly BEFORE shutdown() can publish offline. A closed-handler process.exit() would
        // therefore always win the race and cut the mesh leave.
        if (process.env.FAKE_CODEX_DIE_ON_INTERRUPT === "1") {
          journal({ ev: "died", turnId: activeTurn });
          process.exit(7);
        }
        reply(id, {});
        if (interruptWaiter) interruptWaiter();
        break;
      default:
        if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled: ${method}` } });
    }
  }
}
