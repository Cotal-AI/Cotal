/**
 * Jcode mid-turn DM delivery regression (#910).
 *
 * The exact production shape is a healthy, working seat whose automatic inbox count grows while a
 * long Harness turn is open. `cotal_dm` reports success because JetStream accepted the publish, but
 * the Jcode host leaves the DM parked in MeshAgent until that turn ends. Jcode v0.81.1 already has a
 * session-owned `soft_interrupt` queue for this purpose, including busy-agent and persisted fallback
 * paths; the connector simply did not use it.
 *
 * This spins up a real loopback broker and the shipped Jcode host. The fake is only the Harness API
 * peer: it holds one turn open long enough to make the missing handoff observable. The decisive cell
 * reads what the RECIPIENT session accepted (`soft_interrupt`), not whether the sender publish
 * returned ok. Three sizes rule out the live specimen's tempting 4 KiB hypothesis: short, ~4 KiB,
 * and ~64 KiB DMs must all reach the recipient session before the open turn finishes.
 *
 * Run: pnpm smoke:jcode-mid-turn-delivery
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

type Entry = { ev: string; frame?: { req?: string; content?: string; no_reply?: boolean }; [key: string]: unknown };

const root = mkdtempSync(join(tmpdir(), `cotal-jcode-mid-turn-${SMOKE_BROKER_TOKEN}`));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const turnDelayMs = 8_000;
const sessionState = join(root, "fake-session.json");
const lifecycleUid = mintLifecycleUid();
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

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({
    servers,
    space: "jcodemidturn",
    file: { defaults: { replay: false }, channels: { team: { replay: false } } },
  });

  operator = new CotalEndpoint({
    space: "jcodemidturn",
    servers,
    card: { name: "operator", kind: "agent", id: "operator" },
    channels: ["team"],
  });
  operator.on("error", () => {});
  let peerId: string | undefined;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type !== "offline" && event.presence.card.name === "jcodepeer") {
      peerId = event.presence.card.id;
    }
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "jcode-mid-turn-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    detached: true,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_TURN_DELAY_MS: String(turnDelayMs),
      FAKE_JCODE_SESSION_STATE: sessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodemidturn",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_LIFECYCLE_UID: lifecycleUid,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-mid-turn-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("mesh presence", () => peerId);
  check("Jcode recipient is live before the delivery probe", Boolean(peerId));

  await operator.unicast(peerId!, "OPEN_LONG_TURN");
  await waitFor("the recipient's long Harness turn", () =>
    turnRequests().find((entry) => String(entry.frame?.content).includes("OPEN_LONG_TURN")),
  );

  const short = "MID_SHORT_910";
  const fourK = `MID_4K_910:${"x".repeat(4 * 1024)}`;
  const sixtyFourK = `MID_64K_910:${"y".repeat(64 * 1024)}`;
  const sentAt = Date.now();
  await operator.unicast(peerId!, short);
  await operator.unicast(peerId!, fourK);
  await operator.unicast(peerId!, sixtyFourK);

  const observed = await waitFor(
    "short, 4 KiB, and 64 KiB DMs reach the recipient session before the active turn ends (#910)",
    () => {
      const text = steerText();
      return text.includes(short) && text.includes("MID_4K_910:") && text.includes("MID_64K_910:") ? text : undefined;
    },
    3_000,
  );
  check(
    "short, 4 KiB, and 64 KiB DMs reach the recipient session before the active turn ends (#910)",
    Date.now() - sentAt < turnDelayMs && observed.includes(short),
    { elapsedMs: Date.now() - sentAt, steerBytes: Buffer.byteLength(observed) },
  );

  // The soft-interrupt acceptance is not the commit boundary. Once the containing Harness turn
  // completes cleanly, those exact Cotal deliveries are acked. If the accepted ids were omitted from
  // that boundary ledger, the host starts a second recipient turn carrying the same batch immediately.
  await sleep(turnDelayMs + 500);
  const repeated = turnRequests().filter((entry) => String(entry.frame?.content).includes(short));
  check(
    "the clean containing turn commits the steered DMs exactly once",
    repeated.length === 0,
    { repeatedTurns: repeated.length },
  );
  await operator.unicast(peerId!, "POST_BOUNDARY_910");
  const post = await waitFor("the post-boundary recipient turn", () =>
    turnRequests().find((entry) => String(entry.frame?.content).includes("POST_BOUNDARY_910")),
  );
  const postText = String(post.frame?.content ?? "");
  check("the clean boundary leaves later turns free of the prior batch", !postText.includes(short), { postBytes: Buffer.byteLength(postText) });

  // A host restart reuses the same wire principal and lifecycle durable, and resumes the stored
  // Jcode session. The sender still has the old presence record in memory when the replacement comes
  // up. Addressing by that principal must reach the replacement session, not disappear behind the
  // predecessor's dead Harness tree.
  child.kill("SIGKILL");
  await Promise.race([once(child, "exit"), sleep(5_000)]);
  check(
    "the predecessor Jcode host exits before replacement",
    child.exitCode !== null || child.signalCode !== null,
    { exitCode: child.exitCode, signalCode: child.signalCode },
  );
  // The production manager retires a dead child tree before replacement. This fixture's fake bridge
  // is in the host's process group, so clean the controlled group boundary before reusing its socket.
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await sleep(200);

  const beforeRestart = turnRequests().length;
  child = spawn(tsx, [host], {
    cwd: root,
    detached: true,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_TURN_DELAY_MS: "10",
      FAKE_JCODE_SESSION_STATE: sessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodemidturn",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_LIFECYCLE_UID: lifecycleUid,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "r.sock"),
      COTAL_CONTROL_TOKEN: "jcode-mid-turn-replacement-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await waitFor("the replacement to resume the prior session", () =>
    entries().find(
      (entry) => entry.ev === "session_path" && entry.req === "attach_session" && entry.session_id === "fake-session",
    ),
  );
  // Send before the successor publishes presence. The sender still resolves the predecessor's
  // lingering card, but both process incarnations bind the same lifecycle durable, so this DM must
  // wait for the replacement rather than disappear below a fresh activation frontier.
  await operator.unicast(peerId!, "POST_RESTART_910");
  await waitFor("the replacement to complete mesh readiness", () =>
    entries().filter((entry) => entry.ev === "orientation_done").length >= 2 ? true : undefined,
  );
  const replacementTurn = await waitFor("the replacement recipient session to observe the DM", () =>
    turnRequests().slice(beforeRestart).find((entry) => String(entry.frame?.content).includes("POST_RESTART_910")),
  );
  check(
    "a DM addressed from stale pre-restart presence reaches the resumed replacement session (#910)",
    String(replacementTurn.frame?.content).includes("POST_RESTART_910"),
    replacementTurn,
  );

  console.log(`\nJCODE MID-TURN DELIVERY PASSED (${pass} checks)`);
} catch (error) {
  if (child && (child.exitCode !== null || child.signalCode !== null))
    process.stderr.write(
      `\nJCODE HOST STDERR:\nexit=${String(child.exitCode)} signal=${String(child.signalCode)}\n${stderr.slice(-8_000)}\n`,
    );
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(15_000)]);
  }
  await operator?.stop().catch(() => {});
  await killAndAwaitExit(nats);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}
