/**
 * Jcode inbound-wedge regression (#1075).
 *
 * #910 / PR #1079 already delivers directed traffic into a Cotal-owned Harness `run()`
 * through `soft_interrupt`. Two remaining seats still look alive and cannot be steered:
 *
 * 1. A TUI-owned turn: `session_status` is working while the host is not inside `drive()`.
 *    `drive()` refuses because `turnActive`, and `steerPending()` refuses because `!driving`.
 * 2. An advisory idle pulse during a still-open Cotal-owned `run()`: `session_status` idle
 *    clears `turnActive`, so `steerPending()` returns even though `driving` is true.
 *
 * Both are recipient-side. The sender publish succeeds. This fixture grades only what the
 * recipient Harness session accepted (`soft_interrupt`) before that busy window ends, plus
 * that a growing automatic queue is published on presence activity so the wedged state is
 * visible from outside the seat.
 *
 * Run: pnpm smoke:jcode-inbound-wedge
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
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(50);
  }
}

type Entry = { ev: string; frame?: { req?: string; content?: string; no_reply?: boolean }; status?: string; [key: string]: unknown };

const root = mkdtempSync(join(tmpdir(), `cotal-jcode-inbound-wedge-${SMOKE_BROKER_TOKEN}`));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const sessionState = join(root, "fake-session.json");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, root);
let child: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let stderr = "";
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line) as T);
}
const entries = (): Entry[] => readJsonLines<Entry>(log);
const turnRequests = (): Entry[] => entries().filter((entry) => entry.ev === "request" && entry.frame?.req === "send_message" && !entry.frame.no_reply);
const steerText = (): string =>
  entries()
    .filter((entry) => entry.ev === "request" && entry.frame?.req === "soft_interrupt")
    .map((entry) => String(entry.frame?.content ?? ""))
    .join("\n");

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
}

async function spawnHost(extra: NodeJS.ProcessEnv, controlSock: string): Promise<ChildProcess> {
  const env = baseEnv();
  rmSync(sessionState, { force: true });
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "jcode-inbound-wedge-smoke-token", { mode: 0o600 });
  const spawned = spawn(tsx, [host], {
    cwd: root,
    detached: true,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_SESSION_STATE: sessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodewedge",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_LIFECYCLE_UID: mintLifecycleUid(),
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: controlSock,
      COTAL_CONTROL_TOKEN: "jcode-inbound-wedge-control-token",
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  spawned.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return spawned;
}

async function stopChild(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([once(proc, "exit"), sleep(15_000)]);
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({
    servers,
    space: "jcodewedge",
    file: { defaults: { replay: false }, channels: { team: { replay: false } } },
  });

  operator = new CotalEndpoint({
    space: "jcodewedge",
    servers,
    card: { name: "operator", kind: "agent", id: "operator" },
    channels: ["team"],
  });
  operator.on("error", () => {});
  let peerId: string | undefined;
  let peerStatus = "";
  let peerActivity = "";
  let peerPresenceAt = 0;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string }; status?: string; activity?: string } }) => {
    if (event.type !== "offline" && event.presence.card.name === "jcodepeer") {
      peerId = event.presence.card.id;
      peerStatus = event.presence.status ?? "";
      peerActivity = event.presence.activity ?? "";
      peerPresenceAt = Date.now();
    }
  });
  await operator.start();

  const busyMs = 8_000;

  // --- Cell A: the initial automatic batch stays visible while its Cotal-owned run() is open ---
  child = await spawnHost({ FAKE_JCODE_TURN_DELAY_MS: String(busyMs) }, join(root, "ci.sock"));
  await waitFor("readiness is definitively idle with no stale activity before the initial-drive cell", () =>
    peerId && peerStatus === "idle" && peerActivity === "" ? peerId : undefined,
  );

  const initialSentAt = Date.now();
  await operator.unicast(peerId!, "OPEN_LONG_TURN_INITIAL_1075");
  await waitFor("the recipient's initial long Harness turn", () =>
    turnRequests().find((entry) => String(entry.frame?.content).includes("OPEN_LONG_TURN_INITIAL_1075")),
  );
  const initialActivity = await waitFor(
    "presence activity names the initial automatic inbound batch while its run is open (#1075)",
    () => (peerPresenceAt >= initialSentAt && /^inbound: 1 automatic queued, oldest \d+s$/.test(peerActivity) ? peerActivity : undefined),
    3_000,
  );
  check(
    "presence activity names the initial automatic inbound batch while its run is open (#1075)",
    Date.now() - initialSentAt < busyMs && /^inbound: 1 automatic queued, oldest \d+s$/.test(initialActivity),
    { elapsedMs: Date.now() - initialSentAt, peerActivity: initialActivity },
  );

  await stopChild(child);
  child = undefined;
  writeFileSync(log, "");
  peerId = undefined;
  peerStatus = "";
  peerActivity = "";
  peerPresenceAt = 0;

  // --- Cell B: advisory idle during a still-open Cotal-owned run() ---
  child = await spawnHost({ FAKE_JCODE_TURN_DELAY_MS: String(busyMs), FAKE_JCODE_IDLE_DURING_TURN: "1" }, join(root, "control-a.sock"));
  await waitFor("mesh presence for the idle-during-drive cell", () => peerId);
  check("Jcode recipient is live before the idle-during-drive probe", Boolean(peerId));

  await operator.unicast(peerId!, "OPEN_LONG_TURN_1075");
  await waitFor("the recipient's long Harness turn", () =>
    turnRequests().find((entry) => String(entry.frame?.content).includes("OPEN_LONG_TURN_1075")),
  );
  await waitFor("the fake Harness to pulse idle while that run is still open", () =>
    entries().find((entry) => entry.ev === "idle_during_turn") ? true : undefined,
  );

  const idleMarker = "MID_IDLE_PULSE_1075";
  const idleSentAt = Date.now();
  await operator.unicast(peerId!, idleMarker);
  const idleObserved = await waitFor(
    "a DM during advisory idle inside a live Cotal-owned run reaches the recipient session (#1075)",
    () => (steerText().includes(idleMarker) ? steerText() : undefined),
    3_000,
  );
  check(
    "a DM during advisory idle inside a live Cotal-owned run reaches the recipient session (#1075)",
    Date.now() - idleSentAt < busyMs && idleObserved.includes(idleMarker),
    { elapsedMs: Date.now() - idleSentAt },
  );

  await stopChild(child);
  child = undefined;
  writeFileSync(log, "");
  peerId = undefined;
  peerStatus = "";
  peerActivity = "";
  peerPresenceAt = 0;

  // --- Cell C: TUI-owned working session, host not inside drive() ---
  child = await spawnHost({ FAKE_JCODE_TURN_DELAY_MS: "10", FAKE_JCODE_EXTERNAL_TURN_MS: String(busyMs) }, join(root, "control-b.sock"));
  await waitFor("mesh presence for the TUI-owned cell", () => peerId);
  await waitFor("the fake Harness to mark a TUI-owned working session", () =>
    entries().find((entry) => entry.ev === "external_turn" && entry.status === "working") ? true : undefined,
  );
  check("the recipient session is working without a Cotal-owned drive()", true);

  const tuiMarker = "MID_TUI_OWNED_1075";
  const tuiSentAt = Date.now();
  await operator.unicast(peerId!, tuiMarker);
  const tuiObserved = await waitFor(
    "a DM during a TUI-owned working session reaches the recipient session (#1075)",
    () => (steerText().includes(tuiMarker) ? steerText() : undefined),
    3_000,
  );
  check(
    "a DM during a TUI-owned working session reaches the recipient session (#1075)",
    Date.now() - tuiSentAt < busyMs && tuiObserved.includes(tuiMarker),
    { elapsedMs: Date.now() - tuiSentAt },
  );

  // Ambient is not steered. It must still be visible from outside the seat while the TUI owns the turn.
  await operator.multicast("AMBIENT_QUEUED_1075", { channel: "team" });
  await waitFor(
    "presence activity names the growing automatic inbound queue (#1075)",
    () => (/\binbound: .*queued\b/.test(peerActivity) ? peerActivity : undefined),
    3_000,
  );
  check(
    "presence activity names the growing automatic inbound queue (#1075)",
    /\binbound: .*queued\b/.test(peerActivity),
    { peerActivity },
  );

  await waitFor("the TUI-owned turn to finish", () =>
    entries().find((entry) => entry.ev === "external_turn" && entry.status === "idle") ? true : undefined,
    busyMs + 2_000,
  );
  await sleep(500);
  const repeated = turnRequests().filter((entry) => String(entry.frame?.content).includes(tuiMarker));
  check("the TUI-owned turn commits the steered DM instead of starting a second recipient turn", repeated.length === 0, {
    repeatedTurns: repeated.length,
  });

  console.log(`\nJCODE INBOUND WEDGE PASSED (${pass} checks passed)`);
} catch (error) {
  if (child && (child.exitCode !== null || child.signalCode !== null))
    process.stderr.write(
      `\nJCODE HOST STDERR:\nexit=${String(child.exitCode)} signal=${String(child.signalCode)}\n${stderr.slice(-8_000)}\n`,
    );
  else if (stderr) process.stderr.write(`\nJCODE HOST STDERR:\n${stderr.slice(-8_000)}\n`);
  throw error;
} finally {
  await stopChild(child);
  await operator?.stop().catch(() => {});
  await killAndAwaitExit(nats);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}
