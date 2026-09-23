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
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// Control sockets are AF_UNIX: a long case-name under the tokened root can exceed sun_path and
// replace the outcome under test with a listen error, so all control sockets live here.
const sockRoot = mkdtempSync(join("/tmp", "jiw-"));
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, root);
// The #1868 cell needs its OWN broker so it can kill and restart it without disturbing the
// cells above; it is created inside the cell and torn down there.
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

async function portReachable(portNumber: number): Promise<boolean> {
  return isReachable(`nats://127.0.0.1:${portNumber}`);
}

/** The managed seat-home key the host derives: first 12 hex of sha256(`<space>\0<name>`). */
function seatKey(space: string, name: string): string {
  return createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);
}

/** First `wal.json` under an events root, or undefined. The layout is
 *  `<root>/.cotal/events/<h(space)>/<h(principal)>/<h(thread)>/wal.json` — three hashed
 *  directory levels, so the walk is exactly that deep and no further. */
function findWal(eventsRoot: string): string | undefined {
  if (!existsSync(eventsRoot)) return undefined;
  for (const space of readdirSync(eventsRoot)) {
    const spaceDir = join(eventsRoot, space);
    if (!statSync(spaceDir).isDirectory()) continue;
    for (const principal of readdirSync(spaceDir)) {
      const principalDir = join(spaceDir, principal);
      if (!statSync(principalDir).isDirectory()) continue;
      for (const thread of readdirSync(principalDir)) {
        const threadDir = join(principalDir, thread);
        if (!statSync(threadDir).isDirectory()) continue;
        const wal = join(threadDir, "wal.json");
        if (existsSync(wal)) return wal;
      }
    }
  }
  return undefined;
}

/** The seat's private connector log text for one space, or "". */
function readSeatLog(root: string, space: string): string {
  const base = join(root, ".cotal", "jcode");
  if (!existsSync(base)) return "";
  for (const seat of readdirSync(base)) {
    if (!seat.startsWith(`${space}-`)) continue;
    const logs = join(base, seat, "logs");
    if (!existsSync(logs)) continue;
    for (const file of readdirSync(logs)) {
      if (/^connector-.*\.log$/.test(file)) return readFileSync(join(logs, file), "utf8");
    }
  }
  return "";
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

  await stopChild(child);
  child = undefined;
  writeFileSync(log, "");

  // --- Cell D (#1868): a transient mesh rebuild window during an event flush is not terminal ---
  //
  // The reproduction: an events-armed seat whose kickoff turn is HELD open (its records are
  // durable, nothing has flushed), a broker SIGKILL, and the turn completed while the endpoint
  // is inside its rebuild window. At base the holder's flush read `max_payload` off a connection
  // that was not there and the seat exited 1. The fix holds the queued step on the holder's
  // waitLive seam until the endpoint's own reconnect lands it, so the seat stays up and the
  // frame reaches the restarted broker.
  {
    const em1Port = await freePort();
    const em1Servers = `nats://127.0.0.1:${em1Port}`;
    let em1Nats = spawn("nats-server", ["-js", "-p", String(em1Port), "-sd", join(root, "js-em1")], { stdio: "ignore" });
    const em1Release = teardownOnSignal(em1Nats, root);
    const holdMarker = "HOLD_TURN_EM1_1868";
    const holdRelease = join(root, "em1-release");
    try {
      for (let i = 0; i < 100 && !(await portReachable(em1Port)); i++) await sleep(50);
      await seedChannelRegistry({
        servers: em1Servers,
        space: "jcodeem1",
        file: { defaults: { replay: false }, channels: { team: { replay: false } } },
      });
      const em1Root = join(root, "em1-workspace");
      mkdirSync(em1Root, { recursive: true });
      // The fake appends one `append_messages` record per executed turn to FAKE_JCODE_JOURNAL;
      // the host reads the seat's own `sessions/fake-session.journal.jsonl`. The seat home slug
      // is derivable up front (the same sha256(managedHome) the host uses), so point the fake
      // there from the start and every record lands exactly where the emitter reads it.
      const seatSlugHome = join(root, ".cotal", "jcode", `jcodeem1-jcodepeer-${seatKey("jcodeem1", "jcodepeer")}`);
      mkdirSync(join(seatSlugHome, "sessions"), { recursive: true });
      const seatJournal = join(seatSlugHome, "sessions", "fake-session.journal.jsonl");
      writeFileSync(seatJournal, "");
      child = await spawnHost(
        {
          COTAL_EVENTS: "1",
          COTAL_WORKSPACE_ROOT: em1Root,
          COTAL_JCODE_PROMPT: `${holdMarker} do the work`,
          FAKE_JCODE_HOLD_TURN_ON_CONTENT: holdMarker,
          FAKE_JCODE_HOLD_TURN_RELEASE_FILE: holdRelease,
          FAKE_JCODE_JOURNAL: seatJournal,
          FAKE_JCODE_APPEND_RECORDS: "1",
          COTAL_SPACE: "jcodeem1",
          COTAL_SERVERS: em1Servers,
        },
        join(sockRoot, "control-em1.sock"),
      );
      await waitFor("the #1868 seat's held kickoff turn is open with durable records", () =>
        entries().find((entry) => entry.ev === "turn_held_open" && String(entry.content).includes(holdMarker)) ? true : undefined,
      );
      // The WAL must settle with no pending frame before the outage: the defect is a pump that
      // STARTS clean and then loses the connection, not a publish interrupted mid-flight.
      const settled = await waitFor("the #1868 WAL holds no pending frame", () => {
        const wal = findWal(join(em1Root, ".cotal/events"));
        if (!wal) return undefined;
        const doc = JSON.parse(readFileSync(wal, "utf8")) as { pending: unknown };
        return doc.pending === null || doc.pending === undefined ? wal : undefined;
      }).catch((error: Error) => {
        throw new Error(`${(error as Error).message}; events dir=${existsSync(join(em1Root, ".cotal/events"))}; seatLog=${readSeatLog(root, "jcodeem1").slice(-400)}`);
      });
      check("CONTROL: the #1868 seat armed its event plane and settled it before the outage", Boolean(settled), settled);

      // Kill the broker, let the endpoint enter its rebuild window, then complete the held turn
      // DURING the outage: the turn_done drives closeEventRun -> flush -> (held) -> pump.
      await killAndAwaitExit(em1Nats, "SIGKILL", 5_000);
      await sleep(6_000); // nats.js exhausts its own reconnects; the endpoint is mid-rebuild
      em1Nats = spawn("nats-server", ["-js", "-p", String(em1Port), "-sd", join(root, "js-em1")], { stdio: "ignore" });
      teardownOnSignal(em1Nats, join(root, "js-em1"));
      writeFileSync(holdRelease, "go");
      for (let i = 0; i < 100 && !(await portReachable(em1Port)); i++) await sleep(50);

      // The seat must SURVIVE the window and land the queued flush once the endpoint is live.
      const frameLanded = await waitFor(
        "the seat survives the rebuild window and publishes its held-run frame after reconnect (#1868)",
        () => {
          const wal = findWal(join(em1Root, ".cotal/events"));
          if (!wal) return undefined;
          const doc = JSON.parse(readFileSync(wal, "utf8")) as { pending: unknown; frontier: { seq: number } };
          return (doc.pending === null || doc.pending === undefined) && doc.frontier.seq >= 2 ? doc.frontier.seq : undefined;
        },
        30_000,
      ).catch(() => undefined);
      const seatLog = readSeatLog(root, "jcodeem1");
      const journalRecords = readFileSync(seatJournal, "utf8").split("\n").filter((line) => line.includes("append_messages")).length;
      const walDoc = findWal(join(em1Root, ".cotal/events"));
      const walState = walDoc ? readFileSync(walDoc, "utf8").slice(0, 300) : "(no wal)";
      const fakeTail = entries().slice(-6);
      check(
        "the seat survives a transient rebuild window during an event flush (#1868)",
        child.exitCode === null && frameLanded !== undefined && !seatLog.includes("AG-UI emitter stopped"),
        { exitCode: child.exitCode, frameLanded, seatLog, walState, fakeTail },
      );
      check(
        "the queued flush lands after reconnect with no dropped or duplicated run (#1868)",
        frameLanded === 2 && journalRecords >= 2,
        { frameLanded, journalRecords, walState },
      );

      // A stop during a standing outage must not be held by the wait: shutdown flushes and closes
      // the open run, both steps hold for a live endpoint, and the seat must still exit.
      await killAndAwaitExit(em1Nats, "SIGKILL", 5_000);
      await sleep(6_000);
      const stopAt = Date.now();
      child.kill("SIGTERM");
      const exited = await Promise.race([once(child, "exit").then(() => true), sleep(20_000).then(() => false)]);
      check(
        "a seat stopped while its mesh connection is down exits instead of waiting for the broker (#1868)",
        exited && readSeatLog(root, "jcodeem1").includes("AG-UI emitter stopped: seat stopping while the mesh connection is down"),
        { exited, ms: Date.now() - stopAt, seatLog: readSeatLog(root, "jcodeem1").slice(-400) },
      );
    } finally {
      await stopChild(child);
      child = undefined;
      await killAndAwaitExit(em1Nats);
      em1Release();
    }
  }

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
