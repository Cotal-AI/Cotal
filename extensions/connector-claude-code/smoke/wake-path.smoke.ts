/**
 * Claude Code wake-path regression test (no test runner) — spins up its OWN nats-server on an
 * ephemeral port and drives the SHIPPED handler (`createClaudeHandle`) behind the SHIPPED control
 * server, with a real mesh peer sending real DMs. No `claude` binary, no model.
 *
 * It guards the three ways an unattended peer used to go permanently silent — a DM arrives, and
 * nothing ever delivers it, so the peer simply never replies and only a human at the keyboard
 * notices:
 *
 *   1. ACK-BEFORE-DELIVERY. The hook reply travels connector → unix socket → hook relay → stdout →
 *      Claude Code, and the relay abandons it after 2s (`runHookRelay`'s TIMEOUT_MS). The handler
 *      used to `drainInbox()` — which ACKS the JetStream message and marks it handled — while
 *      merely *formatting* that reply. When the reply then failed to land, the message was gone:
 *      `handledIds` turns the durable redelivery into a silent ack, so the DM could never come back.
 *   2. PRESENCE BLOCKING THE WAKE. Every hook branch did `await agent.setStatus(...)` (a broker
 *      round-trip that throws mid-reconnect) inside the same try/catch as the delivery work, so one
 *      failed presence write skipped the `Stop` → `requestWake()` flush of held messages entirely.
 *   3. A DROPPED NUDGE WITH NO RETRY. The `claude/channel` push is an idle session's ONLY wake
 *      source; a rejected notification was logged and forgotten, and no later hook fires to recover.
 *
 * Ack semantics under test: a peer message is COMMITTED only once the reply carrying it is
 * confirmed flushed to the hook client. Anything less must leave it un-acked so JetStream
 * redelivers it.
 *
 * It also pins the same property one layer down, in code this fix depends on and does not own: when
 * the ack itself throws (a JetStream ack publishes, so a closed connection fails), the message must
 * come back. That holds only because `commitPending` acks BEFORE marking handled; reverse those two
 * lines and a failed ack is marked handled without being acked, which is this branch's original bug
 * with a new cause. Nothing else in the repo covers that ordering.
 *
 * Run: pnpm smoke:claude-wake
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { connect, createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { MeshAgent, startControlServer, type InboxItem } from "@cotal-ai/connector-core";
import { createClaudeHandle, createWakePolicy } from "../src/hooks.js";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The real per-event hook entry Claude Code runs, and the loader that can execute its TS. */
const hookEntry = join(here, "..", "src", "hook.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ccwake";
/**
 * Short so redelivery (the recovery path this test asserts) is observable in seconds, not a minute —
 * but LONG relative to the nudge retry's 1s first attempt. Both mechanisms produce an identical
 * nudge, so the retry check below can only be about the retry if redelivery cannot have happened
 * yet: keep `RETRY_DEADLINE_MS` comfortably under this. At 2.5s they were indistinguishable and the
 * retry check passed with the retry deleted.
 */
const ACK_WAIT_MS = 10_000;
/** The retry's first attempt is at 1s; anything inside this window predates any possible redelivery. */
const RETRY_DEADLINE_MS = 5_000;
/** `NUDGE_RETRY_INITIAL_MS` in `../src/hooks.ts` — the earliest the retry timer can possibly fire. */
const NUDGE_RETRY_FIRST_MS = 1_000;
const TOKEN = "wake-path-test-token";

const dir = mkdtempSync(join(tmpdir(), "cotal-ccwake-"));
const socketPath = join(dir, "control.sock");
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// ---- the peer side of the mesh -------------------------------------------------------------
const agent = new MeshAgent({
  space,
  name: "Otto",
  id: "otto",
  kind: "agent",
  role: "generalist",
  servers,
  subscribe: ["team"],
  allowSubscribe: ["team"],
  allowPublish: ["team"],
  tls: false,
  ackWaitMs: ACK_WAIT_MS,
});
agent.on("error", () => {});

const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["team"] });
pub.on("error", () => {});

// ---- the push side: record every claude/channel nudge, and fail it on demand ------------------
const nudges: string[] = [];
let failNudges = 0;
const wake = createWakePolicy(
  agent,
  async (params) => {
    if (failNudges > 0) {
      failNudges--;
      throw new Error("stdio pipe closed");
    }
    nudges.push(params.content);
  },
  () => {},
);

// ---- the hook side: the SHIPPED handler behind the SHIPPED control server ---------------------
const claude = createClaudeHandle();
const controlServer = startControlServer(agent, { path: socketPath, token: TOKEN }, claude.handle, {
  onReply: claude.onReply,
});

/**
 * Speak the real control-frame protocol the hook relay speaks.
 * `dropReply` reproduces a relay that gave up (its 2s timeout, or a killed hook process): the frame
 * IS delivered — we destroy only after the write flushes — but nothing ever reads the answer.
 */
function fireHook(event: Record<string, unknown>, opts: { dropReply?: boolean } = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    let buf = "";
    const finish = (out?: string) => {
      sock.destroy();
      resolve(out);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ token: TOKEN, event }) + "\n", () => {
        if (opts.dropReply) finish(undefined); // frame delivered; answer abandoned
      });
    });
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    });
    sock.on("error", () => resolve(undefined));
    setTimeout(() => finish(undefined), 5_000).unref?.();
  });
}

/**
 * Run the REAL hook entry point — `src/hook.ts`, the same one-liner over `runHookRelay` that
 * Claude Code executes per lifecycle event — as its own process, event JSON on stdin, and return
 * what it prints on stdout.
 *
 * `fireHook` above hand-builds the control frame, which is fine for driving exact interleavings but
 * proves nothing about the production path. This is the positive control for the whole chain:
 * relay process → control socket → handler → reply → relay stdout → runtime, including the relay's
 * own 2s abandon timer and its stdout-flush backstop. Without it, `delivered === true` might be
 * unreachable in production and every message would redeliver forever behind a green suite.
 */
function fireHookViaRealRelay(event: Record<string, unknown>): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, hookEntry], {
      env: {
        ...process.env,
        COTAL_NAME: "Otto", // hasIdentity() gate — the relay no-ops for an unmanaged session
        COTAL_CONTROL_SOCKET: socketPath,
        COTAL_CONTROL_TOKEN: TOKEN,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ stdout: out.trim(), code }));
    child.stdin.end(JSON.stringify(event));
  });
}

const injected = (reply: string | undefined): string => {
  if (!reply) return "";
  const parsed = JSON.parse(reply) as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? "";
};

const waitFor = async (what: string, cond: () => boolean, ms = 8_000): Promise<void> => {
  for (let i = 0; i < ms / 100 && !cond(); i++) await sleep(100);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

let ottoId = "";
const dmOtto = async (text: string): Promise<void> => {
  await pub.unicast(ottoId, text);
};
/** Pending count for a specific message body — the honest "is it still recoverable" question. */
const stillPending = (text: string): boolean => agent.peekInbox("all").some((i: InboxItem) => i.text.includes(text));

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await pub.start();
  agent.start();
  await waitFor("Otto to join the roster", () => pub.getRoster().some((p) => p.card.name === "Otto"));
  ottoId = pub.getRoster().find((p) => p.card.name === "Otto")!.card.id;

  // A session that has not completed the MCP handshake must not push: the message still buffers.
  await dmOtto("pre-handshake dm");
  await waitFor("the pre-handshake DM to buffer", () => stillPending("pre-handshake dm"));
  check("no claude/channel push before the handshake confirms the capability", nudges.length === 0, nudges);
  wake.setChannelActive(true);

  // Boot: SessionStart surfaces whatever was waiting.
  const boot = await fireHook({ hook_event_name: "SessionStart", model: "claude-opus-5" });
  check("SessionStart injects the messages that arrived before the session was up", injected(boot).includes("pre-handshake dm"), injected(boot));
  check("a delivered SessionStart batch is committed", !stillPending("pre-handshake dm"));

  // ---- 1. a DM wakes an idle session -----------------------------------------------------------
  await dmOtto("dm-one: wake me");
  await waitFor("a nudge for the first DM", () => nudges.length > 0);
  check("a DM pushes a claude/channel nudge at an idle session", nudges.some((n) => n.includes("New dm")), nudges);

  const turnOne = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check("the woken turn is injected with the DM body", injected(turnOne).includes("dm-one: wake me"), injected(turnOne));
  await fireHook({ hook_event_name: "Stop" });
  check("a delivered batch is committed at the end of its turn", !stillPending("dm-one: wake me"));

  const beforeRepeat = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check("a committed batch is not surfaced twice", !injected(beforeRepeat).includes("dm-one: wake me"), injected(beforeRepeat));
  await fireHook({ hook_event_name: "Stop" });

  // ---- 2. THE BUG: a reply the runtime never receives must not consume the message --------------
  // This is the relay's 2s timeout (or a killed hook): the connector answers into a socket nobody
  // is reading. Pre-fix the handler had already acked at format time, so the DM was gone for good.
  await dmOtto("dm-two: reply is lost");
  await waitFor("the second DM to buffer", () => stillPending("dm-two: reply is lost"));
  await fireHook({ hook_event_name: "UserPromptSubmit" }, { dropReply: true });
  await waitFor("the handler to finish the abandoned frame", () => agent.status === "working");
  await sleep(500); // let any commit land before we judge it
  check(
    "a DM whose hook reply never reached the runtime is NOT consumed",
    stillPending("dm-two: reply is lost"),
    { inbox: agent.peekInbox("all").map((i) => i.text) },
  );
  // Un-acked means JetStream is still on the hook for it: the message comes back on its own.
  const nudgesBeforeRedelivery = nudges.length;
  await waitFor("JetStream to redeliver the abandoned DM", () => nudges.length > nudgesBeforeRedelivery, ACK_WAIT_MS * 3);
  check("the abandoned DM is redelivered and re-nudged, so the peer still hears about it", nudges.length > nudgesBeforeRedelivery);
  const recovery = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check("the recovered DM reaches the model on the next turn", injected(recovery).includes("dm-two: reply is lost"), injected(recovery));
  await fireHook({ hook_event_name: "Stop" });
  check("the recovered DM is committed once it is actually delivered", !stillPending("dm-two: reply is lost"));

  // ---- 3. a failed presence write must never swallow the Stop wake -----------------------------
  // A DM lands mid-turn (held), then presence fails exactly as it does when the endpoint is
  // mid-reconnect (setStatus calls assertConnected). The turn-end flush must still fire.
  await fireHook({ hook_event_name: "UserPromptSubmit" }); // open a turn
  await dmOtto("dm-three: held behind a turn");
  await waitFor("the third DM to buffer", () => stillPending("dm-three: held behind a turn"));
  const realSetStatus = agent.setStatus.bind(agent);
  agent.setStatus = async () => {
    throw new Error("not connected to the mesh");
  };
  const nudgesBeforeStop = nudges.length;
  await fireHook({ hook_event_name: "Stop" });
  await sleep(300);
  agent.setStatus = realSetStatus;
  check(
    "Stop still flushes held messages when the presence write fails",
    nudges.length > nudgesBeforeStop,
    { before: nudgesBeforeStop, after: nudges.length },
  );
  const afterPresenceFailure = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check("the held DM survives the presence failure and is injected", injected(afterPresenceFailure).includes("dm-three: held behind a turn"), injected(afterPresenceFailure));
  await fireHook({ hook_event_name: "Stop" });

  // ---- 3b. one frame's delivery verdict must never commit another frame's batch ------------------
  // Hook frames are separate socket connections and can overlap (a PreToolUse from a parallel tool
  // batch while a UserPromptSubmit reply is still being written). Driven directly, not over the
  // socket, so the interleaving is exact rather than timing-dependent.
  await dmOtto("dm-cross: belongs to frame A");
  await waitFor("the cross-frame DM to buffer", () => stillPending("dm-cross: belongs to frame A"));
  const frameA = { hook_event_name: "UserPromptSubmit" };
  const frameB = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
  const replyA = await claude.handle(agent, frameA);
  check(
    "frame A carries the batch",
    JSON.stringify(replyA).includes("dm-cross: belongs to frame A"),
    replyA,
  );
  await claude.handle(agent, frameB);
  claude.onReply(frameB, true); // B delivered — it carried nothing, so it must commit nothing
  check(
    "another frame's delivered reply does not commit frame A's batch",
    stillPending("dm-cross: belongs to frame A"),
    { inbox: agent.peekInbox("all").map((i) => i.text) },
  );
  claude.onReply(frameA, true); // A delivered — now, and only now, it commits
  check("frame A's own verdict commits frame A's batch", !stillPending("dm-cross: belongs to frame A"));

  // ---- 3c. POSITIVE CONTROL: the same thing through the REAL hook process -----------------------
  // Every check above drives a frame this file wrote. This one runs the actual entry point Claude
  // Code invokes, so the whole production chain — relay process, its 2s abandon timer, its stdout
  // flush, the control socket, the handler, the delivery verdict — is what delivers and commits.
  await dmOtto("dm-relay: through the real hook");
  await waitFor("the relay DM to buffer", () => stillPending("dm-relay: through the real hook"));
  const viaRelay = await fireHookViaRealRelay({ hook_event_name: "UserPromptSubmit" });
  check("the real hook process exits cleanly", viaRelay.code === 0, viaRelay);
  check(
    "the real hook process prints the injected DM for the runtime to apply",
    injected(viaRelay.stdout).includes("dm-relay: through the real hook"),
    viaRelay.stdout,
  );
  await sleep(300); // the verdict lands just after the child's stdout closes
  check(
    "a batch delivered through the real relay IS committed",
    !stillPending("dm-relay: through the real hook"),
    { inbox: agent.peekInbox("all").map((i) => i.text) },
  );
  await fireHook({ hook_event_name: "Stop" });

  // ---- 4. a rejected nudge is retried — an idle session has no other wake source ----------------
  // The retry and a JetStream redelivery emit the SAME nudge, so this must be timed to exclude the
  // latter: the deadline is well under ack_wait, so a nudge inside it can only have come from the
  // retry timer. (Measured, not assumed — with the two windows overlapping, this check passed with
  // the retry deleted, proving the redelivery and not the fix.)
  failNudges = 1;
  const nudgesBeforeRetry = nudges.length;
  const retryClock = Date.now();
  await dmOtto("dm-four: first push fails");
  await waitFor(
    "the retried nudge after the first push was rejected",
    () => nudges.length > nudgesBeforeRetry,
    RETRY_DEADLINE_MS,
  );
  const retryElapsed = Date.now() - retryClock;
  console.log(`    (retry nudge observed after ${retryElapsed}ms; timer fires at ${NUDGE_RETRY_FIRST_MS}ms, redelivery at ${ACK_WAIT_MS}ms)`);
  check(
    "a rejected claude/channel push is retried, before any redelivery could explain it",
    nudges.length > nudgesBeforeRetry && retryElapsed < ACK_WAIT_MS,
    { retryElapsed, ackWaitMs: ACK_WAIT_MS },
  );
  // Upper bound alone only rules out the redelivery. A nudge arriving IMMEDIATELY would mean some
  // other producer satisfied the check — a live/durable duplicate re-announcing the same item, say —
  // and the assertion would be green for the wrong reason. The retry timer cannot fire before its
  // first delay, so a lower bound pins the observation to the mechanism being claimed.
  check(
    "and it was the retry timer that produced it, not a same-instant duplicate",
    retryElapsed >= NUDGE_RETRY_FIRST_MS,
    { retryElapsed, timerFiresAtMs: NUDGE_RETRY_FIRST_MS },
  );
  const retried = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check("the DM behind the rejected push is delivered", injected(retried).includes("dm-four: first push fails"), injected(retried));
  await fireHook({ hook_event_name: "Stop" });

  // ---- 5. the ack ITSELF fails — the branch that runs when the commit does not ------------------
  // A JetStream ack publishes, so a closed connection throws. `drainInboxIds` removes the batch from
  // the in-memory buffer BEFORE acking, so a throw part-way through leaves the remainder neither
  // acked nor marked handled. That is the safe direction — JetStream still owns it — but it is the
  // branch nobody exercises, and it is safe ONLY because `commitPending` acks before it marks
  // handled. Swap those two lines in connector-core and a failed ack becomes permanent loss: marked
  // handled, so `ingest` silently acks the redelivery. That is this branch's original bug, one layer
  // down, in code this fix depends on and does not own. This is the check that would catch it.
  await dmOtto("dm-five-a: acks cleanly");
  await dmOtto("dm-five-b: ack throws");
  await waitFor("both DMs buffered", () => stillPending("dm-five-a") && stillPending("dm-five-b"));
  const pendings = (agent as unknown as { inbox: { item: InboxItem; ack: () => void }[] }).inbox;
  const doomed = pendings.find((p) => p.item.text.includes("dm-five-b"));
  check("the fault target is buffered and reachable, so the fault is really wired", !!doomed, {
    buffered: pendings.map((p) => p.item.text),
  });
  let ackAttempted = false;
  doomed!.ack = () => {
    ackAttempted = true;
    throw new Error("simulated: connection closed before the ack could publish");
  };
  const bothSurfaced = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check(
    "both DMs reach the model in one batch",
    injected(bothSurfaced).includes("dm-five-a") && injected(bothSurfaced).includes("dm-five-b"),
    injected(bothSurfaced),
  );
  await sleep(300); // the verdict lands just after the reply is written
  check("the failing ack was attempted, so the batch really did try to commit", ackAttempted);
  check("a throwing ack does not take the session down: the clean sibling still commits", !stillPending("dm-five-a"));
  check("the un-acked message left the local buffer, because the drain removes before it acks", !stillPending("dm-five-b"));
  // ...and comes BACK. Un-acked AND un-handled is the only state from which JetStream can recover it.
  await waitFor("the un-acked DM to be redelivered", () => stillPending("dm-five-b"), ACK_WAIT_MS + 8_000);
  check("a message whose ack threw is redelivered, not lost", stillPending("dm-five-b"));
  check("and its cleanly-acked sibling is NOT redelivered with it", !stillPending("dm-five-a"));
  const afterAckFailure = await fireHook({ hook_event_name: "UserPromptSubmit" });
  check(
    "the recovered message reaches the model",
    injected(afterAckFailure).includes("dm-five-b: ack throws"),
    injected(afterAckFailure),
  );
  check(
    "and it is labelled a possible repeat, because this one HAD already been shown",
    injected(afterAckFailure).includes("may be a repeat"),
    injected(afterAckFailure),
  );
  await fireHook({ hook_event_name: "Stop" });

  console.log(`\nCLAUDE WAKE-PATH TEST PASSED ✅  (${pass} checks)`);
} finally {
  wake.stop();
  controlServer.close();
  await agent.stop().catch(() => {});
  await pub.stop().catch(() => {});
  srv.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
