import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";

if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_JCODE ?? "")) {
  console.log("SKIP Jcode live E2E — set COTAL_E2E_JCODE=1 (needs an authenticated `jcode` CLI)");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(250);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-live-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "jcodelive";
const peer = "jcodepeer";
const hostEntry = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
let host: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({
    space,
    servers,
    card: { name: "operator", kind: "agent", id: "operator" },
    channels: ["team"],
  });
  operator.on("error", () => {});
  let peerId: string | undefined;
  let reply = "";
  let sawWorking = false;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string }; status?: string } }) => {
    if (event.type !== "offline" && event.presence.card.name === peer) peerId = event.presence.card.id;
    if (event.presence.card.name === peer && event.presence.status === "working") sawWorking = true;
  });
  operator.on("message", (message: { parts?: { kind: string; text?: string }[] }, _delivery, meta: { historical: boolean; kind: string }) => {
    if (!meta.historical && meta.kind === "dm") reply += (message.parts ?? []).filter((part) => part.kind === "text").map((part) => part.text ?? "").join("");
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  host = spawn(tsx, [hostEntry], {
    cwd: root,
    env: {
      ...env,
      COTAL_SPACE: space,
      COTAL_NAME: peer,
      COTAL_ID: "jcodepeer",
      COTAL_ROLE: "worker",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-live-smoke-control-token",
      COTAL_MODEL: "gpt-5.6-sol",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  host.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  host.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  try {
    await waitFor("Jcode peer presence", () => peerId);
    check("real Jcode Harness API seat joins the mesh", Boolean(peerId));

    await operator.unicast(
      peerId!,
      "Use cotal_dm to send exactly the single word JCODE_LIVE_PONG to the peer named operator. Do not run commands and do not reply in text; make that one tool call.",
    );
    await waitFor("Jcode mesh-tool reply", () => (reply.includes("JCODE_LIVE_PONG") ? reply : undefined));
    check("real Jcode model replies over the mesh via cotal_dm", reply.includes("JCODE_LIVE_PONG"), reply);
    check("presence reports working during the Harness API turn", sawWorking);
    console.log(`\nJCODE LIVE E2E PASSED (${pass} checks)`);
  } catch (error) {
    // The harness reports startup causes only on its host streams. Print them before rethrowing a
    // waitFor failure so a missing peer is diagnosable without hand-editing the smoke.
    process.stderr.write(`\nJCODE LIVE HOST OUTPUT:\n${output || "(no host output captured)"}\n`);
    throw error;
  }
} finally {
  if (host && host.exitCode === null) {
    host.kill("SIGTERM");
    await Promise.race([once(host, "exit"), sleep(15_000)]);
  }
  await operator?.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
