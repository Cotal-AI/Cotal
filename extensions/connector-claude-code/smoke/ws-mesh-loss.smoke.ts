/**
 * A CONVERSATION THAT LOSES A WEBSOCKET MESH GETS IT BACK, SAYS WHAT FAILED, AND CAN DISCONNECT.
 *
 * A Claude Code conversation reaches a hosted mesh over `wss://`. When the laptop sleeps, the
 * connection dies without a reset: the far end and the NAT forget it, and its packets go nowhere.
 * Measured on the unchanged code with the rig below, three things went wrong.
 *
 *   1. Every failed dial was reported as a bare `ConnectionError`, with no address and no reason.
 *      Node's WebSocket gives its error event no message, and nats-core builds its error from it.
 *   2. A silently dead websocket never came back. nats-core's ping check found it stale and closed
 *      the socket, then waited for a close event that nobody answering the closing handshake ever
 *      sends. The library neither reconnected nor closed, so the endpoint never rebuilt either, and
 *      the session stayed down after the network returned.
 *   3. `cotal_disconnect` hung on the same wait: the agent stop closes the connection, and that
 *      close never finished.
 *
 * The broker is a real nats-server with a websocket listener. Between it and each client sits a
 * TCP proxy this file controls: `refuse` stops listening and resets what is open; `blackhole` holds
 * new connections silently and freezes the open ones without a reset; `pass-keep` lets new
 * connections through while the frozen ones stay frozen, which is the network coming back after a
 * sleep. The disconnect runs through the real app host, with the real event plane over a real
 * transcript; only the identity CLI is a stub.
 *
 * Run: pnpm smoke:claude-ws-mesh-loss   (needs nats-server on PATH; starts its own broker)
 */
import { spawn } from "node:child_process";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable, seedChannelRegistry } from "@cotal-ai/core";
import { MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal, withDeadline } from "@cotal-ai/smoke-kit";
import { createAppHost } from "../src/app-host.js";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (reached: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!reached() && Date.now() < end) await sleep(50);
  return reached();
};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}${extra === undefined ? "" : ` - ${JSON.stringify(extra)}`}`);
};

const tcpPort = await freePort();
const wsPort = await freePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"),
  `port: ${tcpPort}\nwebsocket { listen: "127.0.0.1:${wsPort}", no_tls: true }\njetstream { store_dir: "${join(dir, "js")}" }\n`);
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

type Mode = "pass" | "pass-keep" | "blackhole" | "refuse";
/** One client's network: a TCP proxy to the broker's websocket listener. */
async function network(): Promise<{ url: string; set(mode: Mode): Promise<void>; close(): void }> {
  const port = await freePort();
  let mode: Mode = "pass";
  let server: Server | undefined;
  const pairs = new Set<{ client: Socket; upstream: Socket }>();
  const held = new Set<Socket>();
  const listen = () => new Promise<void>((resolve) => {
    server = createServer((client) => {
      client.on("error", () => {});
      if (mode === "blackhole") { held.add(client); return; }
      const upstream = netConnect(wsPort, "127.0.0.1", () => { client.pipe(upstream); upstream.pipe(client); });
      const pair = { client, upstream };
      pairs.add(pair);
      upstream.on("error", () => client.destroy());
      client.on("close", () => { upstream.destroy(); pairs.delete(pair); });
      upstream.on("close", () => client.destroy());
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
  await listen();
  return {
    url: `ws://127.0.0.1:${port}`,
    async set(next) {
      if (next === "blackhole")
        for (const p of pairs) { p.client.unpipe(); p.upstream.unpipe(); p.client.pause(); p.upstream.pause(); }
      if (next === "refuse") {
        const closing = server;
        server = undefined;
        const closed = new Promise<void>((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
        for (const p of pairs) { p.client.resetAndDestroy(); p.upstream.destroy(); }
        for (const h of held) h.resetAndDestroy();
        held.clear();
        await closed;
      }
      if ((next === "pass" || next === "pass-keep") && !server) await listen();
      mode = next === "pass-keep" ? "pass" : next;
    },
    close() {
      for (const p of pairs) { p.client.destroy(); p.upstream.destroy(); }
      for (const h of held) h.destroy();
      server?.close();
    },
  };
}

const agentConfig = (name: string, servers: string): AgentConfig => ({
  space: `wsloss-${tcpPort}`, name, servers, kind: "agent", tls: false, subscribe: [], allowSubscribe: [], allowPublish: [],
});
/** A presence read from the broker, bounded so a dead connection answers false. `readRoster` does
 *  not reject: a failed read comes back with the cached roster and its `failure`. */
const reads = async (agent: MeshAgent): Promise<boolean> =>
  (await withDeadline(agent.readRoster().then((read) => read.failure === undefined, () => false), 8_000, "roster read")) === true;

/** Defect 1: a refused websocket dial names its address. */
async function namedFailure(): Promise<void> {
  const net = await network();
  const agent = new MeshAgent(agentConfig("named", net.url));
  const errors: string[] = [];
  const warnings: Array<{ name: string; message: string }> = [];
  agent.ep.on("error", (e: Error) => errors.push(e.message));
  agent.ep.on("warning", (e: Error) => warnings.push({ name: e.name, message: e.message }));
  try {
    await agent.start(100);
    await until(() => agent.connected, 20_000);
    await net.set("refuse");
    // nats.js retries on its own first; the endpoint's terminal close follows when it gives up, and
    // the endpoint's own rebuild after it fails too while the proxy refuses.
    await until(() => errors.some((m) => m.startsWith("mesh connection closed")) && warnings.some((w) => w.name === "ConnectionError"), 60_000);
    const closed = errors.find((m) => m.startsWith("mesh connection closed")) ?? "";
    const dial = warnings.filter((w) => w.name === "ConnectionError");
    check("refused: the terminal close names the websocket it lost", closed.includes(net.url), closed);
    check("refused: a failed rebuild names its dial target", dial.length > 0 && dial.every((w) => w.message.includes(net.url)), dial);
    const reconnect = await agent.reconnect();
    check("refused: a manual reconnect that fails names the target", !reconnect.ok && reconnect.message.includes(net.url), reconnect);
    check("refused: the connection status names the target", (agent.connectionIssue ?? "").includes(net.url), agent.connectionIssue);
    // Positive control for the rig: a refused network that comes back is rebuilt, as before.
    await net.set("pass");
    check("refused: the connection comes back once the network does", await until(() => agent.connected, 60_000) && await reads(agent));
  } finally {
    await withDeadline(agent.stop().catch(() => {}), 15_000, "named agent stop");
    net.close();
  }
}

/** Defect 2: a silently dead websocket is closed, and redialed once the network returns. */
async function silentLoss(): Promise<void> {
  const net = await network();
  const agent = new MeshAgent(agentConfig("silent", net.url));
  const transport: boolean[] = [];
  agent.on("transport", (e: { connected: boolean }) => transport.push(e.connected));
  try {
    await agent.start(100);
    await until(() => agent.connected, 20_000);
    check("silent: the connection reads before the loss", await reads(agent));
    const before = transport.length;
    await net.set("blackhole");
    // The ping check finds the connection stale 20 to 30 s in (two unanswered pings, ten seconds
    // apart), and the close it starts is bounded after that.
    check("silent: the dead websocket is reported as a lost transport",
      await until(() => transport.slice(before).includes(false), 60_000), transport.slice(before));
    await net.set("pass-keep");
    let back = false;
    const end = Date.now() + 45_000;
    while (!back && Date.now() < end) back = await reads(agent);
    check("silent: the connection works again after the network returns, with no manual reconnect", back,
      { transport: transport.slice(before), connected: agent.connected, live: agent.transportConnected, issue: agent.connectionIssue });
  } finally {
    await withDeadline(agent.stop().catch(() => {}), 15_000, "silent agent stop");
    net.close();
  }
}

/** Defect 3: cotal_disconnect finishes while the websocket is silently dead and a flush is queued. */
async function disconnect(): Promise<void> {
  const net = await network();
  const space = `wsloss-${tcpPort}`;
  const id = "leaver";
  const session = "ws-mesh-loss-session";
  const root = join(dir, "disconnect");
  mkdirSync(join(root, "ws"), { recursive: true });
  const transcript = join(root, `${session}.jsonl`);
  const prompt = (n: number) => JSON.stringify({ type: "user", uuid: `u-${n}`, promptId: `prompt-${n}`, sessionId: session,
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(), origin: { kind: "human" }, message: { content: `prompt ${n}` } }) + "\n";
  const answer = (n: number) => JSON.stringify({ type: "assistant", uuid: `a-${n}`, sessionId: session,
    timestamp: new Date(1_700_000_000_000 + n * 1000 + 1).toISOString(), message: { id: `msg-${n}`, content: [{ type: "text", text: `answer-${n}` }] } }) + "\n";
  writeFileSync(transcript, prompt(1));
  const env = { COTAL_NAME: id, COTAL_ID: id, COTAL_SPACE: space, COTAL_SERVERS: net.url, COTAL_ROLE: "generalist", COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: join(root, "ws") };
  const cli = join(root, "identity-stub.cjs");
  writeFileSync(cli, `const args = process.argv.slice(2);
console.log(JSON.stringify(args[1] === "provision" ? { ok: true, env: ${JSON.stringify(env)}, retire: { dir: ${JSON.stringify(join(root, "cred"))} } } : { ok: true }));\n`);
  await seedChannelRegistry({ servers: `nats://127.0.0.1:${tcpPort}`, space, file: { defaults: { replay: false }, channels: { [`events.local.${id}`]: { replay: true } } } });
  const host = createAppHost({ cotal: () => [process.execPath, cli], cwd: root, env: { HOME: root, PATH: process.env.PATH } });
  try {
    await host.nativeEvent({ session_id: session, hook_event_name: "SessionStart", source: "startup", transcript_path: transcript });
    const conn = await host.open("local", id, session);
    appendFileSync(transcript, answer(1));
    await host.nativeEvent({ session_id: session, hook_event_name: "Stop", last_assistant_message: "answer-1", prompt_id: "prompt-1" });
    await sleep(1_000);
    check("disconnect: the conversation is connected before the loss", conn.agent.connected);
    await net.set("blackhole");
    // A turn written while the link is silently dead: its tool boundary queues a flush, and its
    // Stop queues another and a run close behind it.
    appendFileSync(transcript, prompt(2) + answer(2));
    void host.nativeEvent({ session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash" }).catch(() => {});
    void host.nativeEvent({ session_id: session, hook_event_name: "Stop", last_assistant_message: "answer-2", prompt_id: "prompt-2" }).catch(() => {});
    await sleep(1_000);
    const started = Date.now();
    const closed = await withDeadline(host.close("local", conn.id), 40_000, "disconnect");
    check("disconnect: cotal_disconnect completes while the websocket is silently dead", closed === true,
      { closed, ms: Date.now() - started });
    check("disconnect: the conversation is gone once it returns", closed === true && (await host.find("local", conn.id)) === undefined);
  } finally {
    await withDeadline(host.closeAll().catch(() => {}), 15_000, "host closeAll");
    net.close();
  }
}

try {
  await awaitBrokerReady(() => isReachable(`nats://127.0.0.1:${tcpPort}`), { servers: `nats://127.0.0.1:${tcpPort}`, attempts: 50, delayMs: 200 });
  // Independent clients on independent proxies, so the three waits overlap.
  await Promise.all([namedFailure(), silentLoss(), disconnect()]);
} catch (error) {
  check("the suite ran to the end", false, (error as Error).stack ?? String(error));
} finally {
  broker.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
console.log(`\nws mesh loss: ${pass} passed, ${fail} failed`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
