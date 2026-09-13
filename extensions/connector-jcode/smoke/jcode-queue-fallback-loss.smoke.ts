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
// Touched by the cross-talk cell to end the seat's busy window at a chosen instant. Absent until
// then, so the busy hold above governs every earlier cell exactly as before.
const busyReleaseFile = join(root, "busy-release");
const softInterruptTimeoutMs = 3_000;
/** Declared here because the fake's swallow knob is scoped to this exact text. */
const marker = "SWALLOWED_QUEUED_TURN_1233";
// Comfortably past the SDK's 10s acceptance wait, so the host has definitively stopped listening
// for this send before its acknowledgement finally arrives.
const lateAcceptAfterMs = 14_000;
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
      // Ends the busy window ON DEMAND rather than by clock. The cross-talk cell needs `drive()` to
      // dispatch the unrelated message as its OWN turn while the swallowed handover is still
      // reserved, and that only happens at an idle boundary the fixture chooses.
      FAKE_JCODE_BUSY_RELEASE_FILE: busyReleaseFile,
      FAKE_JCODE_STEER_BLACKHOLE: "1",
      // THE FIXTURE'S WHOLE POINT: the queued send carrying this marker is taken and never
      // acknowledged. Scoped by content so the host's own readiness traffic still works and the seat
      // reaches the mesh; otherwise this would grade a boot failure instead of the loss.
      FAKE_JCODE_SWALLOW_QUEUED_SEND: marker,
      // A LATE acceptance for that swallowed send, emitted long after the host's window has lapsed.
      // This is the reviewer's sequence: the host gives up waiting, a later batch becomes the one
      // listening, and only then does the Harness answer the ORIGINAL request. The event is
      // session-only, so nothing in it says which send it belongs to.
      FAKE_JCODE_LATE_ACCEPT_AFTER_MS: String(lateAcceptAfterMs),
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

  // THE DECISIVE CELL. An unacknowledged send must leave the message OWED, and it must eventually
  // ARRIVE. If the host treated its own send as delivery, it would record the batch as accepted, the
  // boundary would ack it out of the durable inbox, and the message would never run: silent loss.
  //
  // WHAT COUNTS AS BEING OWED CHANGED WITH THE REPAIR, and this cell changed with it rather than
  // being relaxed. Re-handing the batch to the same connection is no longer correct: a send that
  // lapsed unacknowledged leaves acceptance unattributable there, and a reviewer measured the cost
  // of ignoring that, three executions of one batch on a healthy bridge. So the host replaces the
  // connection first and redelivers on the replacement, where an acknowledgement means something
  // again. The observable guarantee is unchanged and is what is asserted here: a swallowed message
  // is not treated as delivered, and it reaches the session.
  const redelivered = await tryWaitFor(() => {
    const attempts = swallowed().length;
    const ran = entries().filter((e) => e.ev === "turn_run" && String(e.content ?? "").includes(marker)).length;
    return attempts >= 2 || ran >= 1 ? { attempts, ran } : undefined;
  }, 90_000);
  check(
    "an unacknowledged queued turn is re-attempted rather than treated as delivered (#1233)",
    redelivered !== undefined,
    {
      swallowedSends: swallowed().length,
      deliveredTurns: turnsCarrying(marker).length,
      runsAfterBoundary: redelivered?.ran ?? 0,
    },
  );
  // The refusing half, and it is the one that distinguishes redelivery from DUPLICATION. A message
  // may arrive late, but it must never run twice: the whole point of refusing an unattributable
  // acknowledgement is that the batch stays owed, and a host that also executed it would be trading
  // loss for repetition. `turn_run` is the execution witness, separate from the request log, because
  // the swallowed frames ARE requests and cannot answer this.
  const runs = entries().filter((entry) => entry.ev === "turn_run" && String(entry.content ?? "").includes(marker)).length;
  check(
    "and the session ran it at most once, so the attempts are redelivery and not duplication",
    runs <= 1,
    {
      turnsRun: runs,
      swallowedSends: swallowed().length,
      loggedRequests: turnsCarrying(marker).length,
    },
  );

  // --- CROSS-TALK: another message's acknowledgement must not acknowledge THIS one ---------------
  // Found in review, and it defeats the acknowledgement check above using an entirely ORDINARY event
  // rather than a missing one, which is why every cell above passes while a message is lost.
  //
  // `message_accepted` carries a session id and NOTHING ELSE: no request id, no sequence, no echo of
  // the content. `sendMessage` writes through the SDK's `notify()`, which allocates a wire id and
  // discards it, then matches acceptance by session alone (jcode-sdk client.js:317). So while the
  // swallowed A waits, an unrelated B dispatched on the same session emits an acknowledgement that
  // A's listener accepts. A is promoted, acked out of the durable inbox, never run, never retried.
  //
  // THE ORDERING IS FORCED, and it has to be. A and B batch into one injection if both are merely
  // owed, and then B never produces an acceptance of its own: measured that way first, with counts
  // identical on the fixed and severed trees. The release file below ends the busy window while A is
  // reserved and unacknowledged, so `drive()` composes a turn for B ALONE. That is the only shape
  // that reaches the defect.
  {
    const unrelated = "UNRELATED_SAME_SESSION_SEND_1233";
    const attemptsBefore = swallowed().length;
    await operator.unicast(peerId!, unrelated);
    // Wait for the fallback's own send to be outstanding before disturbing anything, so the
    // acceptance window this cell is about is genuinely open.
    await tryWaitFor(() => (swallowed().length > attemptsBefore - 1 ? true : undefined), 30_000);
    // End the busy window: the idle edge lets drive() dispatch B as its own turn.
    writeFileSync(busyReleaseFile, "release");
    // B must genuinely RUN. Without this the cell passes vacuously whenever B was batched or
    // dropped, which is exactly how the first version of this probe cleared a broken tree.
    const bRan = await tryWaitFor(
      () => (entries().some((e) => e.ev === "turn_run" && String(e.content ?? "").includes(unrelated)) ? true : undefined),
      60_000,
    );
    // Past the SDK's 10s acceptance wait, so a correct host has had time to retry A.
    await sleep(20_000);
    const aRuns = entries().filter((e) => e.ev === "turn_run" && String(e.content ?? "").includes(marker)).length;
    const attemptsAfter = swallowed().length;
    check(
      "the unrelated message genuinely ran, so a real acceptance happened on this session",
      bRan === true,
      { unrelatedRan: bRan === true, attemptsBefore, attemptsAfter },
    );
    // THE PREDICATE IS A REVIEWER'S CORRECTION AND IT IS THE WHOLE CELL. Asserting "A stays owed" is
    // WRONG: once acceptance is attributable, A gets a real acknowledgement and RUNS, so that
    // phrasing fails on the repair and passes on the defect, i.e. exactly backwards.
    //
    // The guarantee is that A is never treated as delivered without being delivered. Two healthy
    // outcomes satisfy it, ran or still being retried. LOSS is the conjunction of neither.
    const aLost = aRuns === 0 && attemptsAfter === attemptsBefore;
    check(
      "an unrelated send's acknowledgement does not settle a swallowed handover (#1233)",
      bRan === true && !aLost,
      { lost: aLost, aRuns, attemptsBefore, attemptsAfter, unrelatedRan: bRan === true },
    );
    // And the duplicate half, because serialising acceptance must not deliver A twice.
    check(
      "and the swallowed handover is never executed more than once",
      aRuns <= 1,
      { aRuns },
    );
  }

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
