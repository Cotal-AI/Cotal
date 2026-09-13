/**
 * A queued-turn fallback that is never acknowledged must not ack the message (#1233).
 *
 * FOUND IN REVIEW, and it is the one failure worse than the stall this PR repairs. The fallback hands
 * a queued batch to the Harness with the SDK's plain `sendMessage`. That call waits for
 * `message_accepted` — but the SDK's wait RESOLVES on its own timeout rather than rejecting, on the
 * deliberate ground that "the stream is the source of truth". So a busy Harness that TAKES the frame
 * and never acknowledges it is indistinguishable, from the await alone, from one that ran the turn.
 *
 * A host that treats its own send as proof of delivery therefore records the batch as accepted, and
 * the next clean turn boundary ACKS it out of the durable inbox. The peer's message is then gone: not
 * late, lost. That converts #1233 from "messages arrive hours late" into "messages silently vanish",
 * which is strictly worse, and it would have been introduced by the repair itself.
 *
 * WHAT THIS FIXTURE GRADES. The fake takes the queued `send_message` and emits nothing: no error, no
 * refusal, no `message_accepted`, no turn. The witnesses are the seat's OWN reported inbox depth and
 * the fake's request log, so the question asked is "does the seat still owe this message", which is
 * what an operator would ask, rather than "was a function called".
 *
 * The soft interrupt is black-holed as in the sibling fixture, so the fallback is the path under
 * test. The message must remain owed and be re-attempted; it must never be acked.
 *
 * Run: pnpm smoke:jcode-queue-fallback-loss
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
/** Bounded wait that REPORTS a timeout instead of throwing, so a missed deadline reds its own cell. */
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

const root = mkdtempSync(join(tmpdir(), `cotal-jcode-qfloss-${SMOKE_BROKER_TOKEN}`));
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
const busyHoldMs = 120_000;
const softInterruptTimeoutMs = 3_000;
/** Declared here because the fake's swallow knob is scoped to this exact text. */
const marker = "SWALLOWED_QUEUED_TURN_1233";
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
const swallowed = (): Entry[] => entries().filter((entry) => entry.ev === "queued_send_swallowed");
const turnsCarrying = (marker: string): Entry[] =>
  entries().filter((entry) =>
    entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame.no_reply
    && String(entry.frame?.content ?? "").includes(marker));

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({
    servers,
    space: "jcodeqfloss",
    file: { defaults: { replay: false }, channels: { team: { replay: false } } },
  });

  operator = new CotalEndpoint({
    space: "jcodeqfloss",
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
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "jcode-qfloss-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    detached: true,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_SESSION_STATE: sessionState,
      FAKE_JCODE_TURN_DELAY_MS: "10",
      FAKE_JCODE_BUSY_MODEL: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS: "1",
      FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1",
      FAKE_JCODE_BUSY_HOLD_MS: String(busyHoldMs),
      FAKE_JCODE_STEER_BLACKHOLE: "1",
      // THE FIXTURE'S WHOLE POINT: the queued send carrying this marker is taken and never
      // acknowledged. Scoped by content so the host's own readiness traffic still works and the seat
      // reaches the mesh; otherwise this would grade a boot failure instead of the loss.
      FAKE_JCODE_SWALLOW_QUEUED_SEND: marker,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodeqfloss",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_LIFECYCLE_UID: lifecycleUid,
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-qfloss-control-token",
      COTAL_JCODE_REQUEST_TIMEOUT_MS: String(softInterruptTimeoutMs),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  // Reported as a CELL, not a fatal wait: a seat that never reaches the mesh is a fixture/boot
  // problem, and it should say so by name with the host's own stderr rather than aborting with a
  // stack trace that looks like the defect under test.
  const live = await tryWaitFor(() => peerId, 30_000);
  check("the Jcode recipient is live before the probe", Boolean(live), { stderr: stderr.trim().slice(-600) });
  if (!live) throw new Error("recipient never joined; see the cell above");
  await waitFor("the recipient session to be busy", () =>
    entries().find((entry) => entry.ev === "busy_after_readiness_status" && entry.status === "working") ? true : undefined,
  );

  await operator.unicast(peerId!, marker);

  // The fallback must be attempted, and its send must be the one the fake swallows. Without this the
  // cells below could pass on a tree where the fallback never ran at all.
  const attempted = await tryWaitFor(() => (swallowed().length > 0 ? true : undefined), 30_000);
  check("the queued-turn fallback is attempted and its send is swallowed unacknowledged", attempted === true, {
    swallowedSends: swallowed().length,
    deliveredTurns: turnsCarrying(marker).length,
  });

  // THE DECISIVE CELL. An unacknowledged send must leave the message OWED, which shows up as the
  // level-triggered loop attempting it AGAIN. If the host treated its own send as delivery, it would
  // record the batch as accepted, the boundary would ack it out of the durable inbox, and there would
  // be exactly one attempt for a message that never ran: silent loss.
  const attempts = await tryWaitFor(() => {
    const n = swallowed().length;
    return n >= 2 ? n : undefined;
  }, 30_000);
  check(
    "an unacknowledged queued turn is re-attempted rather than treated as delivered (#1233)",
    (attempts ?? swallowed().length) >= 2,
    { swallowedSends: swallowed().length, deliveredTurns: turnsCarrying(marker).length },
  );
  // The refusing half. "Never delivered" cannot be read off the request log here, because the
  // swallowed frames ARE requests: the fake logs every frame on arrival and then drops this one. The
  // honest witness is whether a TURN ever ran carrying the marker, which the fake records separately
  // when it actually executes one. Zero runs against N attempts is redelivery of an undelivered
  // message; it is what distinguishes this from duplicating something the session already had.
  const runs = entries().filter((entry) => entry.ev === "turn_run" && String(entry.content ?? "").includes(marker)).length;
  check(
    "and the session never ran it, so those attempts are redelivery and not duplication",
    runs === 0 && swallowed().length === turnsCarrying(marker).length,
    {
      turnsRun: runs,
      swallowedSends: swallowed().length,
      loggedRequests: turnsCarrying(marker).length,
    },
  );

  // --- CROSS-TALK: NOT GRADED HERE, and this comment is the honest reason -----------------------
  // Review found a real defect at 0a0bf255a that this suite CANNOT reproduce, and I am recording
  // that rather than shipping a cell which passes either way.
  //
  // THE DEFECT. `message_accepted` carries a session id and nothing else: no request id, no
  // sequence, no echo of the content. `sendMessage` writes through the SDK's `notify()`, which
  // allocates a wire request id and then discards it, so acceptance is matched by session alone
  // (jcode-sdk client.js:317). While a swallowed handover waits, an unrelated send on the same
  // session emits an acknowledgement that the waiting listener accepts, and the batch is promoted,
  // acked out of the durable inbox, never run and never retried. A reviewer measured that end to
  // end and independently against the SDK's own transport, where one acceptance resolved two
  // concurrent sends. The fix for it is in `withExclusiveDispatch`, graded by its own mutation.
  //
  // WHY THIS FIXTURE CANNOT SHOW IT. The host batches everything owed into ONE injection. I tried
  // to build the cell, and measured what actually happens: the second message rides the SAME
  // `send_message` frame as the first (log index 22 carries both markers), so it never produces an
  // independent acceptance and there is no second send to cross-talk with. Counts are identical on
  // the fixed and severed trees: A sends 3, A runs 0, B sends 1, B runs 0, swallowed 3 on both.
  //
  // An earlier version of this cell DID red on the severed tree, and that red was timing luck
  // rather than measurement: at a 5s observation the healthy tree simply had not retried yet,
  // because a swallowed send occupies the SDK's full 10s acceptance wait. Widening the window to
  // 30s made the control PASS, which is what exposed that the cell was grading the fixture's
  // patience. Reproducing this properly needs two independently acknowledged sends on one session,
  // which means either a fixture that can suppress batching or the reviewer's SDK-level harness.
  //
  // So the coverage here is stated as ABSENT. A cell that passes against the defect it names is
  // the exact failure this repo catalogues, and I removed one earlier tonight for the same reason.

  console.log(`\nSUITE COMPLETE: ${pass + fail} cells`);
  if (fail) {
    console.log(`JCODE QUEUE FALLBACK LOSS FAILED (${pass} passed, ${fail} failed)`);
    if (stderr.trim()) console.log(`host stderr:\n${stderr.trim().slice(-2000)}`);
  } else console.log(`JCODE QUEUE FALLBACK LOSS PASSED (${pass} passed, 0 failed)`);
  assert.ok(fail === 0, `jcode queue fallback loss: ${fail} cell(s) failed`);
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
  if (process.env.COTAL_JCODE_KEEP_FIXTURE_ROOT === "1") console.log(`FIXTURE ROOT KEPT: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
