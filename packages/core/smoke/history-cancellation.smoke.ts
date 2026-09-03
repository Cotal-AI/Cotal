/**
 * Public history cancellation over a real broker and a constrained link.
 *
 * The reader calls CotalEndpoint.channelHistory with an AbortSignal. The broker contains enough
 * payload to keep the pull active behind a throttled TCP proxy. Once the consumer exists, aborting
 * must reject the public call and reclaim the consumer promptly. Without the shipped cancellation
 * seam the signal is ignored, the promise stays pending, and the consumer keeps moving bytes.
 *
 * No stack lifecycle command. This suite owns and tears down its one nats-server and proxy.
 */
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { DeliverPolicy, jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, chatStream, isReachable, setupSpaceStreams } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

/** Forward server-to-client bytes at a fixed rate. Client-to-server control traffic stays direct. */
async function bandwidthProxy(listenPort: number, targetPort: number, bytesPerSecond: number): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = new (client.constructor as typeof Socket)();
    sockets.add(client); sockets.add(upstream);
    upstream.connect(targetPort, "127.0.0.1");
    client.on("data", (chunk) => upstream.write(chunk));
    const queue: Buffer[] = [];
    let pumping = false;
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      while (queue.length && !client.destroyed) {
        const chunk = queue.shift()!;
        const slice = Math.max(1, Math.floor(bytesPerSecond / 20));
        for (let off = 0; off < chunk.length && !client.destroyed; off += slice) {
          client.write(chunk.subarray(off, off + slice));
          await wait(50);
        }
      }
      pumping = false;
      if (!client.destroyed) upstream.resume();
    };
    upstream.on("data", (chunk: Buffer) => {
      upstream.pause();
      queue.push(Buffer.from(chunk));
      void pump();
    });
    const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listenPort, "127.0.0.1", resolve); });
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const brokerPort = await pickFreePort();
const proxyPort = await pickFreePort();
const brokerUrl = `nats://127.0.0.1:${brokerPort}`;
const proxyUrl = `nats://127.0.0.1:${proxyPort}`;
const space = "historycancel";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const store = join(dir, "js");
mkdirSync(store, { recursive: true });
const broker = spawn("nats-server", ["-js", "-p", String(brokerPort), "-sd", store], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let proxy: Awaited<ReturnType<typeof bandwidthProxy>> | undefined;
let poster: CotalEndpoint | undefined;
let reader: CotalEndpoint | undefined;
let control: Awaited<ReturnType<typeof connect>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(brokerUrl)) { up = true; break; } await wait(100); }
  if (!up) throw new Error("fixture broker did not start");
  await setupSpaceStreams({ servers: brokerUrl, space });

  poster = new CotalEndpoint({ space, servers: brokerUrl, card: { name: "poster", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  poster.on("error", () => {});
  await poster.start();
  const payload = "x".repeat(8 * 1024);
  for (let i = 0; i < 96; i++) await poster.multicast(`${i}:${payload}`, { channel: "general" });

  proxy = await bandwidthProxy(proxyPort, brokerPort, 8 * 1024);
  reader = new CotalEndpoint({ space, servers: proxyUrl, card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  reader.on("error", () => {});
  await reader.start();
  control = await connect({ servers: brokerUrl });
  const jsm = await jetstreamManager(control);
  const consumers = async () => (await jsm.streams.info(chatStream(space))).state.consumer_count;
  const drainActive = async () =>
    (await jsm.consumers.list(chatStream(space)).next())
      .some((info) => info.config.deliver_policy !== DeliverPolicy.Last);
  const consumerNames = async (): Promise<string[]> => {
    const names: string[] = [];
    for await (const info of jsm.consumers.list(chatStream(space))) names.push(info.name);
    return names;
  };

  const controller = new AbortController();
  let outcome = "pending";
  const read = reader.channelHistory("general", { limit: 96, signal: controller.signal }).then(
    (rows) => { outcome = `resolved:${rows.length}`; },
    (error) => { outcome = `rejected:${(error as Error).name}:${(error as Error).message}`; },
  );

  const startedBy = Date.now() + 5000;
  while (Date.now() < startedBy && !(await drainActive())) await wait(25);
  check("positive control: the public read reached its live window-drain consumer", await drainActive(), await consumers());
  const activeNames = await consumerNames();
  check("positive control: the active read consumer identity is observable", activeNames.length === 1, activeNames);

  controller.abort(new DOMException("history read cancelled by caller", "AbortError"));
  const settled = await Promise.race([read.then(() => true), wait(1500).then(() => false)]);
  check("PUBLIC REPRO: abort settles channelHistory as AbortError instead of leaving it pending",
    settled && /^rejected:AbortError:/.test(outcome), outcome);

  const deletedBy = Date.now() + 1500;
  let remaining = activeNames;
  while (Date.now() < deletedBy) {
    remaining = await consumerNames();
    if (!remaining.some((name) => activeNames.includes(name))) break;
    await wait(25);
  }
  check("aborting the public read promptly deletes the exact ephemeral consumer",
    !remaining.some((name) => activeNames.includes(name)), remaining);

  // The same endpoint must serve the next request once the constrained link is no longer occupied.
  await reader.stop();
  await proxy.close();
  proxy = undefined;
  reader = new CotalEndpoint({ space, servers: brokerUrl, card: { name: "reader2", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
  reader.on("error", () => {});
  await reader.start();
  const next = await reader.channelHistory("general", { limit: 1 });
  check("a subsequent public history read still succeeds", next.length === 1, next.length);
} finally {
  await control?.drain().catch(() => {});
  await reader?.stop().catch(() => {});
  await poster?.stop().catch(() => {});
  await proxy?.close().catch(() => {});
  if (broker.exitCode === null) broker.kill("SIGTERM");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(`\nHISTORY CANCELLATION: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
