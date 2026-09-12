/**
 * A soft-interrupt timeout must not strand the automatic queue on a healthy seat (#1233).
 *
 * THE PRODUCTION SHAPE. A Jcode seat is up, working, and answering DMs. Its automatic queue holds
 * peer messages whose count is STATIC while their age grows, and its connector log carries
 * `soft interrupt failed: timeout: no reply to soft_interrupt within 30000ms`. Measured live: 27
 * deliveries, oldest 13.8 hours, on a seat that replied to a direct question in under a minute.
 * `cotal_connection_status` said `ready` the whole time.
 *
 * WHAT THIS FIXTURE GRADES, and the distinction is the point. The decisive cell reads what the
 * RECIPIENT Harness session actually received — the fake bridge's own request log — not whether a
 * drain function was called. An instrument that counts its own invocation is the failure class this
 * repo has catalogued a dozen times, so the witness here is a `send_message` frame carrying the
 * message text, logged by the fake at the moment the shipped host wrote it to the socket.
 *
 * The fake's `soft_interrupt` is told to NEVER reply (`FAKE_JCODE_STEER_BLACKHOLE=1`), which is the
 * measured failure exactly: not a refusal, not a close, silence. The SDK's 30s request timeout then
 * rejects the handoff. The host's readiness timeout and the SDK's request timeout are both pulled
 * in so the cell runs in seconds rather than minutes; the timeout VALUE is not what is under test,
 * the absence of a second path after it is.
 *
 * THREE CELLS.
 *   A. the drain: a DM sent to a busy seat whose soft interrupt black-holes still reaches the
 *      recipient session, by the fallback path, while that turn is still open.
 *   B. exactly once: the queued-turn delivery is committed at the containing boundary like any
 *      other, so the message is not re-sent afterwards.
 *   C. not-ready: while a non-empty automatic queue has made no progress over the window, the
 *      reported state is NOT `ready`.
 *
 * Run: pnpm smoke:jcode-queue-fallback
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, mintLifecycleUid, seedChannelRegistry } from "@cotal-ai/core";
import { AUTOMATIC_QUEUE_STALL_MS, MeshAgent, type InboxItem } from "@cotal-ai/connector-core";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(50);
  }
}
/** Bounded wait that REPORTS a timeout instead of throwing, so a missed deadline reds its own cell
 *  and the remaining cells still run. A throw here would abort the suite at the first red, which is
 *  how a pre-fix control ends up grading one cell instead of the four it was written for. */
async function tryWaitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(50);
  }
}

type Entry = { ev: string; frame?: { req?: string; content?: string; no_reply?: boolean }; [key: string]: unknown };

const root = mkdtempSync(join(tmpdir(), `cotal-jcode-queue-fallback-${SMOKE_BROKER_TOKEN}`));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const sessionState = join(root, "fake-session.json");
const lifecycleUid = mintLifecycleUid();
// The busy window the probe runs inside. The seat must be BUSY for the whole cell, because that is
// the state the defect lives in. It is produced by the fake's measured post-readiness busy shape
// rather than by a slow turn: a long turn delay also paces the READINESS turn, so the seat would
// take that long to reach the roster and the fixture would spend its runtime booting.
const busyHoldMs = 30_000;
// The SDK default is 30s. Shortened so the timeout the fixture depends on happens in seconds. The
// VALUE is not under test — lengthening it is explicitly not the repair — only what follows it.
const softInterruptTimeoutMs = 3_000;
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, root);
let child: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let stderr = "";
let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
};
function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line) as T);
}
const entries = (): Entry[] => readJsonLines<Entry>(log);
/** Every message the recipient session was actually handed as a turn. THE witness for the drain. */
const turnRequests = (): Entry[] =>
  entries().filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame.no_reply);
const turnsCarrying = (marker: string): Entry[] =>
  turnRequests().filter((entry) => String(entry.frame?.content ?? "").includes(marker));
const softInterrupts = (): Entry[] =>
  entries().filter((entry) => entry.ev === "request" && entry.frame?.req === "soft_interrupt");

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({
    servers,
    space: "jcodequeuefallback",
    file: { defaults: { replay: false }, channels: { team: { replay: false } } },
  });

  operator = new CotalEndpoint({
    space: "jcodequeuefallback",
    servers,
    card: { name: "operator", kind: "agent", id: "operator" },
    channels: ["team"],
  });
  operator.on("error", () => {});
  let peerId: string | undefined;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type !== "offline" && event.presence.card.name === "jcodepeer") peerId = event.presence.card.id;
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "jcode-queue-fallback-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    detached: true,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_SESSION_STATE: sessionState,
      FAKE_JCODE_TURN_DELAY_MS: "10",
      // The measured busy-agent behaviour of jcode 0.81.5: a plain send against a busy agent is
      // ACCEPTED and queued (message_accepted, then run as its own turn), while the no-reply form is
      // refused. The fallback depends on exactly that asymmetry, so the fixture must model it rather
      // than answer every frame ok — which would make the fallback look viable even if it were not.
      FAKE_JCODE_BUSY_MODEL: "1",
      // The measured v8 boot: the session is busy immediately after readiness, and the host learns
      // it from session_status rather than from a turn it started. This is the live shape — a seat
      // that is busy without a Cotal-owned run — and it makes the busy window independent of turn
      // pacing, so readiness stays fast.
      FAKE_JCODE_BUSY_AFTER_READINESS: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1",
      FAKE_JCODE_BUSY_HOLD_MS: String(busyHoldMs),
      // The measured failure: the bridge accepts the soft_interrupt frame and never answers it.
      FAKE_JCODE_STEER_BLACKHOLE: "1",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodequeuefallback",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_LIFECYCLE_UID: lifecycleUid,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_JCODE_REQUEST_TIMEOUT_MS: String(softInterruptTimeoutMs),
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-queue-fallback-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("mesh presence", () => peerId);
  check("the Jcode recipient is live before the probe", Boolean(peerId));

  // The seat is now BUSY without a Cotal-owned turn, which is the live shape: the host learns it
  // from session_status. Everything below happens inside this window.
  await waitFor("the recipient session to be busy", () =>
    entries().find((entry) => entry.ev === "busy_after_readiness_status" && entry.status === "working") ? true : undefined,
  );
  const busySince = Date.now();

  // --- Cell A: the drain ---------------------------------------------------------------------
  const marker = "QUEUED_BEHIND_DEAD_STEER_1233";
  const sentAt = Date.now();
  await operator.unicast(peerId!, marker);

  // The handoff must be attempted first, and must fail. Without this the cell could pass on a tree
  // where soft_interrupt simply worked, which would grade nothing about the fallback.
  //
  // Reported as a CELL rather than a fatal wait. A throw here aborts the run before the decisive
  // cell below ever prints, so a mutation that suppresses the handoff reds the suite with a stack
  // trace instead of a named assertion, and mutation-proof correctly grades that WRONG-RED: "it
  // exited 1" and "it failed for my reason" are the same exit code until the suite says which.
  const attempted = await tryWaitFor(() => (softInterrupts().length > 0 ? true : undefined), 15_000);
  check("the mid-turn soft interrupt is attempted and black-holed", attempted === true, {
    softInterrupts: softInterrupts().length,
  });

  // THE DECISIVE CELL, and its deadline is load-bearing. The witness is a send_message frame
  // carrying the marker, logged by the fake bridge when the shipped host wrote it — the message
  // ARRIVING at the seat, not a drain counter.
  //
  // The deadline is well INSIDE the busy window on purpose. Measured against the pre-fix tree, the
  // message does eventually arrive: the pre-existing idle-boundary path delivers it once the seat
  // finally goes idle, at 20013ms of a 20000ms window. An unbounded wait therefore goes GREEN on
  // the defect — "it arrived eventually" is exactly what a 13.8-hour stall also satisfies.
  // Requiring arrival while the seat is still busy is what makes this cell a statement about
  // DRAINING rather than about the queue outliving the turn.
  const drainDeadlineMs = 12_000;
  const delivered = await tryWaitFor(() => turnsCarrying(marker)[0], drainDeadlineMs);
  const elapsed = Date.now() - sentAt;
  const stillBusy = Date.now() - busySince < busyHoldMs;
  check(
    "a message queued behind a timed-out soft interrupt reaches the recipient session while the seat is still busy (#1233)",
    delivered !== undefined && String(delivered.frame?.content ?? "").includes(marker) && stillBusy,
    {
      arrived: delivered !== undefined,
      elapsedMs: elapsed,
      sinceBusyMs: Date.now() - busySince,
      busyHoldMs,
      softInterrupts: softInterrupts().length,
    },
  );
  // The drain must not merely have beaten the clock: the seat has to still be busy, or this is the
  // old idle-boundary behaviour arriving early rather than a queue that was actually served.
  check(
    "and the seat had not yet gone idle, so this was a drain and not the idle boundary",
    stillBusy,
    { sinceBusyMs: Date.now() - busySince, busyHoldMs },
  );

  // --- Cell B: exactly once ------------------------------------------------------------------
  // The fallback records acceptance in the same ledger the steer path uses, so the containing
  // boundary is still the sole ack site. A delivery counted twice would re-send. Measured while the
  // seat is STILL BUSY, so a second copy would have to come from the retry loop rather than from
  // the boundary that legitimately follows it.
  await sleep(2_000);
  check(
    "the fallback delivers the queued batch exactly once, not once per retry tick",
    turnsCarrying(marker).length === 1 && Date.now() - busySince < busyHoldMs,
    { deliveries: turnsCarrying(marker).length, sinceBusyMs: Date.now() - busySince },
  );

  // --- Cell C: the reported state --------------------------------------------------------------
  // Graded against the shipped MeshAgent rather than the live seat, because the live window is ten
  // minutes by design. A non-empty automatic queue that has made no progress over the window must
  // not report `ready`; the same agent, having committed that delivery, must.
  {
    const agent = new MeshAgent({
      space: "jcodequeuefallback",
      name: "status-probe",
      servers,
      kind: "agent",
      tls: false,
      subscribe: [],
      allowSubscribe: [],
      allowPublish: [],
    });
    const stage = agent as unknown as { _connected: boolean; _transportConnected: boolean };
    stage._connected = true;
    stage._transportConnected = true;
    const item = (id: string): InboxItem => ({
      id,
      recvKey: id,
      ts: Date.now(),
      fromId: "peer",
      fromName: "peer",
      kind: "dm",
      mentionsMe: false,
      historical: false,
      text: `message ${id}`,
    });
    type Slot = { item: InboxItem; ack: () => void; pullOnly: boolean; receivedAt: number };
    const slots = agent as unknown as { inbox: Slot[] };
    const heldSince = Date.now() - AUTOMATIC_QUEUE_STALL_MS - 60_000;
    slots.inbox = [{ item: item("stuck"), ack: () => {}, pullOnly: false, receivedAt: heldSince }];
    check(
      "a non-empty automatic queue with no progress over the window does NOT report ready",
      agent.connectionState === "stalled",
      { state: agent.connectionState, stalledForMs: agent.automaticQueueStalledForMs() },
    );
    // The refusing half: the SAME queue, freshly arrived, is not a stall. Without this the cell
    // would also pass on an agent that called every queue stalled, which is a different lie.
    slots.inbox = [{ item: item("fresh"), ack: () => {}, pullOnly: false, receivedAt: Date.now() }];
    check(
      "a queue that is merely deep, not stalled, still reports ready",
      agent.connectionState === "ready",
      { state: agent.connectionState, stalledForMs: agent.automaticQueueStalledForMs() },
    );
    // And progress clears it: committing the automatic delivery restores ready even though the
    // queue formed long ago. This is what makes the signal about PROGRESS rather than depth.
    slots.inbox = [{ item: item("stuck2"), ack: () => {}, pullOnly: false, receivedAt: heldSince }];
    check("the stall is re-entered on the same aged queue", agent.connectionState === "stalled", {
      state: agent.connectionState,
    });
    agent.drainInboxDeliveries(["stuck2"]);
    slots.inbox = [{ item: item("after"), ack: () => {}, pullOnly: false, receivedAt: heldSince }];
    check(
      "a committed automatic delivery clears the stall even on an aged queue",
      agent.connectionState === "ready",
      { state: agent.connectionState, lastAutomaticDrainedAt: agent.lastAutomaticDrainedAt },
    );
    // A pull-only drain is NOT automatic progress. The measured seat drained cotal_inbox every few
    // minutes while its automatic queue sat for 13.8 hours; counting that as progress would have
    // reported it healthy throughout, which is the precise lie this field exists to refuse.
    const quietAgent = new MeshAgent({
      space: "jcodequeuefallback",
      name: "status-probe-2",
      servers,
      kind: "agent",
      tls: false,
      subscribe: [],
      allowSubscribe: [],
      allowPublish: [],
    });
    const quietStage = quietAgent as unknown as { _connected: boolean; _transportConnected: boolean };
    quietStage._connected = true;
    quietStage._transportConnected = true;
    const quietSlots = quietAgent as unknown as { inbox: Slot[] };
    quietSlots.inbox = [
      { item: item("ambient"), ack: () => {}, pullOnly: true, receivedAt: heldSince },
      { item: item("held"), ack: () => {}, pullOnly: false, receivedAt: heldSince },
    ];
    quietAgent.drainInboxDeliveries(["ambient"]);
    check(
      "draining pull-only traffic is not automatic progress, so the stall stands",
      quietAgent.connectionState === "stalled",
      { state: quietAgent.connectionState, lastDrainedAt: quietAgent.lastInboxDrainedAt, lastAutomaticDrainedAt: quietAgent.lastAutomaticDrainedAt },
    );
    await quietAgent.stop().catch(() => {});
    await agent.stop().catch(() => {});
  }

  console.log(`\nSUITE COMPLETE: ${pass + fail} cells`);
  console.log(`${fail === 0 ? "JCODE QUEUE FALLBACK PASSED" : "JCODE QUEUE FALLBACK FAILED"} (${pass} passed, ${fail} failed)`);
  if (fail > 0) assert.fail(`jcode queue fallback: ${fail} cell(s) failed`);
} catch (error) {
  if (stderr) process.stderr.write(`\nJCODE HOST STDERR:\n${stderr.slice(-8_000)}\n`);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(15_000)]);
  }
  if (child?.pid !== undefined) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await operator?.stop().catch(() => {});
  await killAndAwaitExit(nats);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}
