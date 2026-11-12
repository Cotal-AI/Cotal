/** Live native requests admitted immediately after credential reconnect starts. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { CotalEndpoint, createSpaceAuth, mintCreds, newIdentity, requestSafeReconnect, mintLifecycleUid, setupSpaceStreams, standaloneConnectOpts, controlServiceSubject, DEV_OWNER } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const binary = process.env.NATS_SERVER_BIN ?? "nats-server";
console.log(spawnSync(binary, ["-v"], { encoding: "utf8" }).stdout.trim());
const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}request-safe-`));
const space = `safe${process.pid}`;
const auth = await createSpaceAuth(space);
const identity = newIdentity();
const source = () => mintCreds(auth, identity, "operator", { expiresInSeconds: 120 });
const creds = await source();
// Open local test broker: this verifies request continuity, not authentication enforcement.
const broker = spawn(binary, ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
const connections: NatsConnection[] = [];
let endpoint: CotalEndpoint | undefined;
async function open(): Promise<NatsConnection> {
  const nc = await connect({ servers: `nats://127.0.0.1:${port}`, ...standaloneConnectOpts({ creds, tls: false }), reconnectTimeWait: 5, reconnectJitter: 0 });
  connections.push(nc);
  return nc;
}
try {
  let responder: NatsConnection | undefined;
  for (let i = 0; i < 100; i++) {
    try { responder = await open(); break; } catch { await wait(20); }
  }
  assert.ok(responder, "live broker did not become ready");
  const counts = new Map<string, number>();
  responder.subscribe("race", { callback: (error, message) => {
    if (error) throw error;
    const id = message.string();
    counts.set(id, (counts.get(id) ?? 0) + 1);
    setTimeout(() => message.respond(id), 20);
  } });
  await responder.flush();
  const client = await open();
  const failures: string[] = [];
  async function arrival(id: string): Promise<void> {
    try {
      const reply = await client.request("race", id, { timeout: 300 });
      assert.equal(reply.string(), id);
      assert.equal(counts.get(id), 1);
    } catch (error) {
      const detail = `${id}: ${String(error)}, responder deliveries=${counts.get(id) ?? 0}`;
      failures.push(detail);
      console.log(detail);
    }
  }
  for (let round = 0; round < 20; round++) await arrival(`control-${round}`);
  assert.equal(failures.length, 0, "native no-reconnect controls failed");
  console.log("native control: 20/20 replies, one responder delivery each");
  for (let round = 0; round < 20; round++) {
    // Intentionally no await: this is a real request in the reconnect admission window.
    const refresh = requestSafeReconnect(client);
    const request = arrival(`immediate-${round}`);
    await Promise.all([refresh, request]);
    await client.flush();
  }
  console.log(`immediate arrivals: ${20 - failures.length}/20 replies, failures=${failures.length}`);
  assert.deepEqual(failures, [], "requests admitted around reconnect must not disappear");

  // A real pending native request must settle before the reconnect is entered.
  const heldClient = await open();
  let reconnects = 0;
  void (async () => { for await (const status of heldClient.status()) if (status.type === "reconnect") reconnects++; })();
  const held = heldClient.request("race", "held-native", { timeout: 2000 });
  await heldClient.flush();
  const pendingRefresh = requestSafeReconnect(heldClient);
  assert.equal(reconnects, 0);
  assert.equal((await held).string(), "held-native");
  await pendingRefresh;
  await client.flush();
  assert.equal(counts.get("held-native"), 1);
  console.log("outstanding native request: original reply once, then reconnect");

  await setupSpaceStreams({ servers: `nats://127.0.0.1:${port}`, space, creds });
  let endpointNc: NatsConnection | undefined;
  endpoint = new CotalEndpoint({ onConnection: (nc) => { endpointNc = nc; }, space, servers: `nats://127.0.0.1:${port}`, tls: false,
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
    lifecycleUid: mintLifecycleUid(), card: { id: identity.id, name: "safe-client", kind: "endpoint" }, creds: source });
  endpoint.on("error", (error) => console.log(`endpoint error: ${String(error)}`));
  endpoint.on("warning", (error) => console.log(`endpoint warning: ${String(error)}`));
  await endpoint.start();
  let endpointReconnects = 0;
  assert.ok(endpointNc);
  const resident = endpointNc;
  void (async () => { for await (const status of resident.status()) if (status.type === "reconnect") endpointReconnects++; })();
  let namedDelay = 80;
  let namedCount = 0;
  responder.subscribe(controlServiceSubject(space, "safe", DEV_OWNER, identity.id), { callback: (error, message) => {
    if (error) throw error;
    namedCount++;
    setTimeout(() => message.respond(JSON.stringify({ ok: true })), namedDelay);
  } });
  await responder.flush();
  const named = endpoint.requestControl("safe", { op: "held" }, 2000);
  await wait(20);
  let refreshed = false;
  const namedRefresh = endpoint.refreshCredsRequestSafe().then(() => { refreshed = true; });
  await wait(20);
  assert.equal(refreshed, false, "refresh must wait for original named reply");
  assert.equal((await named).ok, true);
  await namedRefresh;
  assert.equal(namedCount, 1);
  console.log("public CotalEndpoint named noMux: outstanding original reply once, then refresh");

  await wait(100);
  const beforeBusy = endpointReconnects;
  namedDelay = 5500;
  console.log(`busy request start: reconnects=${endpointReconnects}`);
  const busy = endpoint.requestControl("safe", { op: "busy" }, 12000);
  const busyResult = busy.then((reply) => ({ reply }), (error: unknown) => ({ error }));
  await wait(30);
  const started = Date.now();
  await assert.rejects(endpoint.refreshCredsRequestSafe(), /remained busy.*connection retained/);
  assert.ok(Date.now() - started >= 4900);
  const busyOutcome = await busyResult;
  console.log(`busy outcome: ${JSON.stringify(busyOutcome)}, namedCount=${namedCount}, reconnects=${endpointReconnects}`);
  assert.ok("reply" in busyOutcome);
  assert.equal(busyOutcome.reply.ok, true);
  namedDelay = 20;
  assert.equal((await endpoint.requestControl("safe", { op: "retained" }, 2000)).ok, true);
  assert.equal(namedCount, 3);
  assert.equal(endpointReconnects, beforeBusy, "busy refresh must not reconnect resident transport");
  console.log("public named busy >5s: refresh reports deferred, original and retained connection reply once");
  for (let round = 0; round < 20; round++) {
    const refresh = endpoint.refreshCredsRequestSafe();
    const replies: Array<ReturnType<CotalEndpoint["requestControl"]>> = [endpoint.requestControl("safe", { op: "immediate" }, 2000)];
    await Promise.resolve();
    replies.push(endpoint.requestControl("safe", { op: "microtask" }, 2000));
    await wait(0);
    replies.push(endpoint.requestControl("safe", { op: "timer" }, 2000));
    await refresh;
    replies.push(endpoint.requestControl("safe", { op: "resolved" }, 2000));
    for (const reply of await Promise.all(replies)) assert.equal(reply.ok, true);
  }
  assert.equal(namedCount, 83);
  console.log("public named parallel immediate/microtask/timer/resolved arrivals: 80/80 replies, 80 deliveries");
} finally {
  await endpoint?.stop();
  await Promise.all(connections.map((nc) => nc.close()));
  await killAndAwaitExit(broker);
  release();
  rmSync(store, { recursive: true, force: true });
}
