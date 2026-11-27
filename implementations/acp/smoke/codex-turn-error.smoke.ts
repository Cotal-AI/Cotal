/**
 * A Codex turn that hits Codex's usage limit, carried to the ACP client end to end: a real broker, the
 * real Codex connector host (`host-main.ts`, as the manager starts it) over a stand-in app-server
 * that ends the turn with Codex's own usage-limit error, the seat's event plane and presence, and the
 * bridge's `cotalAgent` over `openLiveMesh`, driven by the ACP SDK's own client.
 *
 *  - the prompt fails with Codex's own text and its kind, not with "run failed";
 *  - the error's data carries the condition the seat's presence holds: its code, Codex's
 *    `codexErrorInfo` as the source, and the text.
 *
 * What stands in: the app-server is a fixture, no manager runs, so the seat row is listed by the suite
 * and the prompt reaches the seat as a direct message, which is what a manager's `input` gives it.
 *
 * Run: pnpm smoke:acp-turn-error (needs nats-server on PATH).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { CotalEndpoint, isReachable, parsePrincipalKey, seedChannelRegistry, setupSpaceStreams } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, skipSuite, teardownOnSignal } from "../../../packages/smoke-kit/src/index.js";
import { cotalAgent, type HiddenSessions, type ThreadLinks } from "../src/agent.js";
import { openLiveMesh } from "../src/live-mesh.js";
import { AgentCallFailed, LaunchListsRefused, type Mesh, type SeatRow } from "../src/mesh.js";

if (process.platform === "win32") skipSuite("managed Codex agents are POSIX-only");

const { check, finish } = createSuite();
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}acp-turn-error-`));
process.env.COTAL_HOME = join(dir, "home");
const space = "acpturnerror";
const name = "codexseat";
const usage = "You've hit your usage limit. Upgrade to Pro or try again at Nov 28th, 2026 9:00 AM.";

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const operator = new CotalEndpoint({ space, servers: server, card: { name: "operator", kind: "agent", id: "operator" }, channels: ["team"] });
operator.on("error", () => {});
let host: ChildProcess | undefined;
let mesh: Mesh | undefined;
const hostLog: string[] = [];
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 100, delayMs: 50 });
  await setupSpaceStreams({ servers: server, space });
  await seedChannelRegistry({ servers: server, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  recordMesh({ space, server, root: join(dir, space), mode: "open", ts: new Date().toISOString() });
  await operator.start();

  const fake = join(repo, "extensions/connector-codex/smoke/fake-codex.mjs");
  const bin = join(dir, "fake-codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(bin, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const codexHome = join(dir, "codex");
  host = spawn(join(repo, "node_modules/.bin/tsx"), [join(repo, "extensions/connector-codex/src/host-main.ts")], {
    cwd: repo,
    detached: true,
    env: {
      ...env,
      COTAL_SPACE: space,
      COTAL_NAME: name,
      COTAL_ID: name,
      COTAL_SERVERS: server,
      COTAL_SUBSCRIBE: "team",
      COTAL_CODEX_BIN: bin,
      COTAL_CODEX_HOME: codexHome,
      COTAL_CODEX_TUI: "0",
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: codexHome,
      COTAL_MODEL: "fake-model",
      FAKE_CODEX_LOG: join(dir, "fake.log.jsonl"),
      FAKE_CODEX_ROLLOUT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout?.on("data", (d: Buffer) => hostLog.push(String(d)));
  host.stderr?.on("data", (d: Buffer) => hostLog.push(String(d)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !operator.getRoster().some((p) => p.card.name === name && p.status !== "offline")) await tick(100);
  const presence = operator.getRoster().find((p) => p.card.name === name);
  const principal = presence ? parsePrincipalKey(presence.card.id) : undefined;
  if (!presence?.lifecycleUid || !principal) throw new Error(`the Codex seat did not join\n${hostLog.join("").slice(-4000)}`);
  // The event plane binds once the thread's rollout exists; give it the boundary the host waits for.
  await tick(1500);
  const row: SeatRow = { name, owner: principal.owner, actor: principal.actor, lifecycleUid: presence.lifecycleUid, agent: "codex", status: "idle" };

  const live = await openLiveMesh({ space, log: () => {}, stop: () => {} });
  const noManager = async (): Promise<never> => { throw new LaunchListsRefused("this suite runs no manager"); };
  mesh = {
    ...live,
    managers: noManager,
    catalogs: noManager,
    personas: noManager,
    startManager: noManager,
    seats: async () => ({ rows: [row], silent: [] }),
    served: () => undefined,
    promptCounter: () => undefined,
    agentCall: async () => { throw new AgentCallFailed("this suite calls no agent endpoint", "unavailable"); },
    input: async (_seat, text) => { await operator.unicast(presence.card.id, text); },
  };
  const opened = mesh;
  const hidden: HiddenSessions = { read: () => new Set(), add: () => {} };
  const links: ThreadLinks = { read: () => [], add: () => {} };
  const app = cotalAgent({ mesh: async () => opened, hidden, links, log: () => {}, version: "0.0.0-smoke" });
  const conn = client({ name: "smoke" }).onNotification(methods.client.session.update, () => {}).connect(app);
  await conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  await conn.agent.request(methods.agent.session.load, { sessionId: name, cwd: dir, mcpServers: [] });
  const error = await Promise.race([
    conn.agent.request(methods.agent.session.prompt, { sessionId: name, prompt: [{ type: "text", text: "USAGELIMIT please" }] }).then(
      (r) => ({ answered: r }),
      (e: { code?: number; message?: string; data?: unknown }) => e,
    ),
    tick(30_000).then(() => ({ timedOut: true })),
  ]) as { code?: number; message?: string; data?: unknown; answered?: unknown; timedOut?: true };
  console.log(`  the ACP prompt's answer: ${JSON.stringify({ code: error.code, message: error.message, data: error.data, answered: error.answered, timedOut: error.timedOut })}`);
  const condition = (error.data as { condition?: { code?: string; source?: string; message?: string } } | undefined)?.condition;
  check("the prompt fails with Codex's own usage-limit text and its kind, not \"run failed\"",
    error.code === -32603 && error.message === `${name}'s turn failed: ${usage} (usageLimitExceeded)`, { error, host: hostLog.join("").slice(-3000) });
  check("the error's data carries the seat's condition: billing, Codex's codexErrorInfo, and its text",
    condition?.code === "billing" && condition.source === "usageLimitExceeded" && condition.message === usage, error.data);
  conn.close();
} finally {
  await mesh?.close().catch(() => {});
  await operator.stop().catch(() => {});
  if (host?.pid !== undefined) {
    try { process.kill(-host.pid, "SIGKILL"); } catch { /* the group is gone */ }
    host.stdout?.destroy();
    host.stderr?.destroy();
  }
  await killAndAwaitExit(broker, "SIGTERM");
  release();
  rmSync(dir, { recursive: true, force: true });
}
finish();
