import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";

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

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-permanent-refusal-"));
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
let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};
const entries = (): Array<{ ev: string; [key: string]: unknown }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcoderefuse", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({
    space: "jcoderefuse",
    servers,
    card: { name: "operator", kind: "agent", id: "operator" },
    channels: ["team"],
  });
  operator.on("error", () => {});
  let peerId: string | undefined;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type !== "offline" && event.presence.card.name === "jcoderefuse") peerId = event.presence.card.id;
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "provider-refusal-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_CLOSE_ON_CONTENT: "SIMULATE_PROVIDER_STALL",
      FAKE_JCODE_CLOSE_ONCE_FILE: closeOnce,
      FAKE_JCODE_REFUSE_ATTACH_CODE: "invalid_request",
      FAKE_JCODE_REFUSE_ATTACH_AFTER_FILE: closeOnce,
      FAKE_JCODE_REFUSE_ATTACH_MESSAGE: "synthetic permanent attach refusal",
      FAKE_JCODE_SESSION_STATE: sessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcoderefuse",
      COTAL_NAME: "jcoderefuse",
      COTAL_ID: "jcoderefuse",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-provider-refusal-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("initial bridge", () => entries().find((entry) => entry.ev === "listening"));
  await waitFor("mesh presence", () => peerId);
  check("the shipped Jcode host joins before the provider stall (instrument control)", Boolean(peerId));
  await operator.unicast(peerId!, "SIMULATE_PROVIDER_STALL");
  await waitFor("persistent permanent replacement refusal", () =>
    entries().find((entry) => entry.ev === "attach_refused" && entry.code === "invalid_request"),
  );
  await waitFor("terminal host exit or unsafe retry", () =>
    child!.exitCode !== null || entries().filter((entry) => entry.ev === "listening").length >= 3 ? true : undefined,
  );
  const launches = entries().filter((entry) => entry.ev === "listening");
  const refusals = entries().filter((entry) => entry.ev === "attach_refused");
  check(
    "a persistent invalid_request replacement refusal is terminal before another launch",
    child.exitCode === 1 &&
      launches.length === 2 &&
      refusals.length === 1 &&
      stderr.includes("recovery failed: invalid_request: synthetic permanent attach refusal") &&
      !stderr.includes("replacement not ready yet; retrying"),
    { code: child.exitCode, launches: launches.length, refusals: refusals.length, stderr },
  );
  console.log(`\nJCODE PROVIDER PERMANENT-REFUSAL SMOKE PASSED (${passed} checks)`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  for (const entry of entries()) {
    if (entry.ev !== "listening" || typeof entry.pid !== "number") continue;
    try { process.kill(entry.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await operator?.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
