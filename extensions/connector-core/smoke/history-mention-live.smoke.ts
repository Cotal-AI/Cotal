/** A real replay-enabled join must not turn old mentions into native gateway wakes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CotalEndpoint, isReachable, mintLifecycleUid, seedChannelRegistry } from "@cotal-ai/core";
import { awaitBrokerReady, createSuite, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { formatInjection } from "../src/control.js";
import { registerCotalGatewayTools, type GatewayConnection } from "../src/gateway.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "historymention";
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const modes = ["open", "dnd", "focus", "quiet"] as const;
const channels = modes.map((m) => `history_${m}`);
const pub = new CotalEndpoint({ space, servers, card: { id: "publisher", name: "Publisher", kind: "agent" }, channels, lifecycleUid: mintLifecycleUid() });
pub.on("error", () => {});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 100; n++) { if (test()) return; await sleep(50); }
  throw new Error(what);
}
const agents: MeshAgent[] = [];
const clients: Client[] = [];
const mcpServers: McpServer[] = [];

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await seedChannelRegistry({ space, servers, file: { defaults: { replay: true }, channels: {} } });
  await pub.start();
  for (const mode of modes) {
    const channel = `history_${mode}`;
    const name = `receiver_${mode}`;
    const oldPlain = await pub.multicast(`old context ${mode}`, { channel });
    const oldMention = await pub.multicast(`old request ${mode}`, { channel, mentions: [name] });
    const config: AgentConfig = { space, name, id: name, servers, subscribe: [], allowSubscribe: [channel], allowPublish: [channel], kind: "agent", tls: false, lifecycleUid: mintLifecycleUid() };
    const agent = new MeshAgent(config);
    agents.push(agent);
    agent.on("error", () => {});
    let mentionWakes = 0;
    agent.on("mention-wake", () => mentionWakes++);
    const frames: string[] = [];
    const connection: GatewayConnection = { id: `connection_${mode}`, agent, config };
    const server = new McpServer({ name: "history-wake-fixture", version: "1" });
    mcpServers.push(server);
    registerCotalGatewayTools(server, {
      account: () => "fixture",
      async open() { void agent.start(); await until(() => agent.connected, "recipient did not connect"); return connection; },
      find: async (_account, id) => id === connection.id ? connection : undefined,
      close: async () => { await agent.stop(); return true; },
    }, "history-wake-fixture", {
      wake: { signal: (_connection, preview) => { frames.push(JSON.stringify(preview)); return true; }, listening: () => "fixture reader attached" },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "history-wake-fixture", version: "1" });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (tool: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: tool, arguments: args });
      assert(!result.isError, JSON.stringify(result));
      return result;
    };
    await call("cotal_connect", { name });
    if (mode === "quiet") await call("cotal_channel_mode", { connection_id: connection.id, channel, mode: "quiet" });
    else if (mode !== "open") await call("cotal_status", { connection_id: connection.id, attention: mode });
    await call("cotal_join", { connection_id: connection.id, channel });
    await sleep(200);
    check(`${mode}: replay creates no gateway wake or focus mention wake`, frames.length === 0 && mentionWakes === 0, { frames: frames.length, mentionWakes });
    check(`${mode}: old mentions do not count as pending or directed wakes`, agent.pendingWake() === 0 && agent.directedPendingCount() === 0, { pending: agent.pendingWake(), directed: agent.directedPendingCount() });
    const history = agent.peekInbox("pull-only");
    check(`${mode}: both replayed messages remain available on explicit pull`, history.length === 2 && history.every((i) => i.historical) && history.some((i) => i.id === oldPlain.id) && history.some((i) => i.id === oldMention.id), history.map((i) => ({ id: i.id, historical: i.historical })));
    if (history.length) {
      const rendered = formatInjection(history) ?? "";
      check(`${mode}: catch-up is not described as new work`, !rendered.includes("new messages") && !rendered.includes("If this asks for work") && rendered.includes("history"), rendered);
    }
    await call("cotal_inbox", { connection_id: connection.id });
    frames.length = 0;
    mentionWakes = 0;
    await pub.multicast(`current mention ${mode}`, { channel, mentions: [name] });
    await until(() => frames.length > 0, `${mode}: current mention did not wake`);
    check(`${mode}: a new mention still wakes the gateway`, frames.length === 1, frames);
    await call("cotal_inbox", { connection_id: connection.id });
    frames.length = 0;
    await pub.unicast(agent.id, `current DM ${mode}`);
    await until(() => frames.length > 0, `${mode}: current DM did not wake`);
    check(`${mode}: a new DM still wakes the gateway`, frames.length === 1, frames);
    await call("cotal_inbox", { connection_id: connection.id });
    await agent.stop();
    await client.close();
    await server.close();
  }
} finally {
  for (const agent of agents) await agent.stop();
  for (const client of clients) await client.close();
  for (const server of mcpServers) await server.close();
  await pub.stop();
  if (broker.exitCode === null && broker.signalCode === null) {
    const exited = new Promise<void>((resolve) => broker.once("exit", () => resolve()));
    broker.kill("SIGTERM");
    await exited;
  }
  release();
  rmSync(dir, { recursive: true, force: true });
}
finish();
