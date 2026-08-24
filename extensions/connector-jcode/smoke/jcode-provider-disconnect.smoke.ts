import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";

// #781: a provider stream can make Jcode close the Harness API connection while a seat is in an
// inbox-driven turn. That failed turn must not take the mesh seat down with it. This uses the real
// host, SDK, Unix socket, NATS endpoint, and a process-per-bridge Harness fake: the first bridge
// deliberately closes on a delivered message, then the recovered bridge proves it reattached the
// same session and can accept later mesh work.

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
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-provider-disconnect-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const closeOnce = join(root, "first-bridge-closed");
const sessionState = join(root, "fake-session.json");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
let child: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const entries = (): Array<{ ev: string; [key: string]: unknown }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcodeclose", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({
    space: "jcodeclose",
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
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "provider-disconnect-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_CLOSE_ON_CONTENT: "SIMULATE_PROVIDER_STALL",
      FAKE_JCODE_CLOSE_ONCE_FILE: closeOnce,
      FAKE_JCODE_SESSION_STATE: sessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodeclose",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-provider-disconnect-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("initial bridge", () => entries().find((entry) => entry.ev === "listening"));
  await waitFor("mesh presence", () => peerId);
  check("Jcode host joins before the provider stall", Boolean(peerId));

  await operator.unicast(peerId!, "SIMULATE_PROVIDER_STALL");
  await waitFor("simulated provider disconnect", () => existsSync(closeOnce) ? closeOnce : undefined);
  // The unfixed host reacts immediately through `client.on("close") → shutdown(1)`. Let that
  // path settle before the assertion; a reconnecting host remains live and proceeds to its one
  // reattach attempt below.
  await sleep(500);
  check("provider disconnect does not exit the mesh seat (#781)", child.exitCode === null, { code: child.exitCode, stderr });
  await waitFor("recovery Harness connection", () => {
    const hellos = entries().filter(
      (entry) => entry.ev === "request" && (entry.frame as { req?: string }).req === "hello",
    );
    return hellos.length >= 2 ? hellos : undefined;
  });
  const reattachments = entries().filter(
    (entry) => entry.ev === "session_path" && entry.req === "attach_session" && entry.session_id === "fake-session",
  );
  check("recovered Harness client reattaches the existing private session (#781)", reattachments.length >= 1, reattachments);

  await operator.unicast(peerId!, "RECOVERED_MESH_WORK");
  const retriedTurn = await waitFor("unacknowledged stalled turn redelivery", () => {
    const attempts = entries().filter(
      (entry) =>
        entry.ev === "request" &&
        (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" &&
        !(entry.frame as { no_reply?: boolean }).no_reply &&
        String((entry.frame as { content?: string }).content).includes("SIMULATE_PROVIDER_STALL"),
    );
    return attempts.length >= 2 ? attempts : undefined;
  });
  check("recovered seat redrives the unacknowledged stalled turn (#781)", retriedTurn.length >= 2, retriedTurn);

  await operator.unicast(peerId!, "RECOVERED_MESH_WORK");
  const recoveredTurn = await waitFor("post-recovery turn", () =>
    entries().find(
      (entry) =>
        entry.ev === "request" &&
        (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" &&
        !(entry.frame as { no_reply?: boolean }).no_reply &&
        String((entry.frame as { content?: string }).content).includes("RECOVERED_MESH_WORK"),
    ),
  );
  check("recovered seat accepts a later mesh turn (#781)", JSON.stringify(recoveredTurn).includes("RECOVERED_MESH_WORK"), recoveredTurn);

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(10_000)]);
  check("recovered host still exits cleanly on operator stop", child.exitCode === 0, { code: child.exitCode, stderr });
  console.log(`\nJCODE PROVIDER-DISCONNECT SMOKE PASSED (${pass} checks)`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await operator?.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
