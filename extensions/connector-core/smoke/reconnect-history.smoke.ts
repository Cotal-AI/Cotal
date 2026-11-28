/** Durable catch-up must not turn an offline channel conversation into new work. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, provisionAgent, seedChannelRegistry, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import { awaitBrokerReady, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent, cotalToolSpecs, fmtItem } from "@cotal-ai/connector-core";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "reconnecthistory";
const channel = "general";
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"),
}));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const endpoints: CotalEndpoint[] = [];
const agents: MeshAgent[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, label: string): Promise<void> {
  for (let n = 0; n < 100; n++) { if (test()) return; await sleep(50); }
  throw new Error(label);
}

// Only the publisher's synchronous envelope construction sees this clock. Restore it before
// any broker callback or receiver runs, so the receiver and broker still use their real clocks.
function withSenderClock<T>(offset: number, send: () => T): T {
  const now = Date.now;
  Date.now = () => now() + offset;
  try { return send(); } finally { Date.now = now; }
}

async function wideReader(manager: CotalEndpoint, name: string, subscribe: string[], allowSubscribe = [">"]) {
  const id = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const creds = await provisionAgent(manager, auth, id, { subscribe, allowSubscribe, lifecycleUid });
  const agent = new MeshAgent({
    space, servers, tls: false, name, id: id.id, creds, lifecycleUid,
    subscribe, allowSubscribe, allowPublish: [], kind: "agent",
  });
  agents.push(agent);
  return agent;
}

async function checkWideReplay(manager: CotalEndpoint, publisher: CotalEndpoint) {
  const count = 12_000;
  const channels = Array.from({ length: 16 }, (_, i) => `replay.wide.c${i}`);
  const text = "x".repeat(16_384);
  for (let i = 0; i < count; i += 4) {
    await Promise.all(Array.from({ length: 4 }, (_, j) =>
      publisher.multicast(text, { channel: channels[(i + j) % channels.length] }),
    ));
  }

  const agent = await wideReader(manager, "wide-reader", [">", "replay.wide.>"]);
  const began = performance.now();
  const rssBefore = Math.max(process.memoryUsage.rss(), process.resourceUsage().maxRSS * 1024);
  let peakBytes = 0, replayed = 0, turnCount = 0, maxTurnCount = 0, maxTurnMs = 0;
  agent.ep.on("message", (message, _delivery, meta) => {
    if (!meta.historical || !message.channel?.startsWith("replay.wide.")) return;
    if (replayed++ === 0) peakBytes = process.memoryUsage().arrayBuffers;
    if (turnCount++ !== 0) return;
    const started = performance.now();
    setImmediate(() => {
      maxTurnMs = Math.max(maxTurnMs, performance.now() - started);
      maxTurnCount = Math.max(maxTurnCount, turnCount);
      peakBytes = Math.max(peakBytes, process.memoryUsage().arrayBuffers);
      turnCount = 0;
    });
  });
  await agent.start();
  const joinMs = performance.now() - began;
  await new Promise<void>(resolve => setImmediate(resolve));
  const rssGrowthMiB = Math.max(0, process.resourceUsage().maxRSS * 1024 - rssBefore) / 2 ** 20;
  const peakBufferMiB = peakBytes / 2 ** 20;
  const measured = { count, channels: channels.length, replayed, joinMs, rssGrowthMiB, peakBufferMiB, maxTurnMs, maxTurnCount };
  console.log(`wide channel replay: ${JSON.stringify(measured)}`);
  assert(peakBufferMiB < 128 && rssGrowthMiB < 192, "joining must not retain the 187.5 MiB replay payload");
  assert.equal(replayed, count, "the root and covered family must deliver each historical post once");
  assert(maxTurnCount > 0 && maxTurnCount <= 256 && maxTurnMs < 250,
    "each replay turn must handle at most 256 posts and take less than 250 ms");
  assert(joinMs < 30_000, "12,000 posts must replay and bind in under 30 seconds");
  assert(agent.peekInbox("pull-only").some(item => item.historical && item.channel?.startsWith("replay.wide.")));
  await agent.stop();
}

async function checkOverlappingWindows(manager: CotalEndpoint, publisher: CotalEndpoint, creds: string) {
  const overlap = "replay.policy.a.b", sideA = "replay.policy.a.c", sideB = "replay.policy.c.b", outside = "replay.policy.c.c";
  const filters = ["replay.policy.*.b", "replay.policy.a.*", overlap];
  const agent = await wideReader(manager, "replay-windows", filters, filters);
  await seedChannelRegistry({ servers, space, creds, file: {
    defaults: { replayWindow: "2s" }, channels: { [overlap]: { replayWindow: "1h" } },
  } });
  const olderOverlap = await publisher.multicast("older overlap", { channel: overlap });
  await publisher.multicast("outside the time window", { channel: sideB });
  await sleep(2_100);
  const expected = [olderOverlap.id];
  for (const ch of [sideA, overlap, sideB]) expected.push((await publisher.multicast("current history", { channel: ch })).id);
  await publisher.multicast("outside both filters", { channel: outside });
  const replayed: string[] = [];
  agent.ep.on("message", (message, _delivery, meta) => { if (meta.historical) replayed.push(message.id); });
  await agent.start();
  assert.deepEqual(replayed.sort(), expected.sort(), "overlap keeps the longer concrete window and excludes unrelated history");
  await agent.stop();
}

async function checkInterruptedReplay(manager: CotalEndpoint, publisher: CotalEndpoint) {
  const count = 3_000;
  const family = "replay.retry.>";
  const expected: string[] = [];
  for (let i = 0; i < count; i += 4) {
    const posts = await Promise.all(Array.from({ length: 4 }, (_, j) =>
      publisher.multicast("retained before runtime join", { channel: `replay.retry.c${(i + j) % 8}` }),
    ));
    expected.push(...posts.map(post => post.id));
  }
  const agent = await wideReader(manager, "replay-reconnect", []);
  await agent.start();
  const tool = cotalToolSpecs(agent.config).find(spec => spec.name === "cotal_join")!;
  const join = () => tool.run(agent, agent.config, { channel: family });
  const replayed: string[] = [];
  const live = new Set<string>();
  let reconnect: Promise<void> | undefined;
  let disconnected = false;
  agent.on("transport", ({ connected }) => { if (!connected) disconnected = true; });
  agent.ep.on("message", (message, _delivery, meta) => {
    if (!meta.historical) { live.add(message.id); return; }
    replayed.push(message.id);
    if (replayed.length === 1) reconnect = agent.ep.reconnect();
  });
  const first = await join();
  assert(reconnect, "replay must start and trigger a real connection rebuild");
  await reconnect;
  assert(disconnected && agent.connected, "the endpoint must replace its connection");
  const partial = replayed.length;
  const joinedAfterFirst = agent.joinedChannels().includes(family);
  const durableAfterFirst = agent.ep.hasDurableMembership(family);
  const between = await publisher.multicast("posted while unjoined", { channel: "replay.retry.c0" });
  const retry = await join();
  console.log(`runtime replay: ${JSON.stringify({ partial, joinedAfterFirst, durableAfterFirst, first, retry, total: replayed.length })}`);
  assert.equal(partial, 256, "receive the full fetched page before failing");
  assert(!joinedAfterFirst, "the interrupted runtime join must leave the channel unjoined");
  assert(!durableAfterFirst, "the failed join must not write a durable membership");
  assert(first.isError && first.text.includes(`Couldn't join #${family}: channel history replay did not complete. Delivered ${partial} messages`), first.text);
  assert(!retry.isError && retry.text.startsWith(`Joined #${family} `), retry.text);
  assert(retry.text.includes(`Backfilled ${count - partial} earlier messages`), retry.text);
  assert(agent.joinedChannels().includes(family), "the successful retry must record the join");
  assert.deepEqual(replayed.sort(), expected.sort(), "retry must finish replay without re-emitting any delivered post");
  const after = await publisher.multicast("posted after retry", { channel: "replay.retry.c0" });
  await until(() => live.has(after.id), "the successful join must receive live posts");
  assert(!live.has(between.id), "the interrupted join must not receive live posts while unjoined");
  await agent.stop();
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds });
  const manager = new CotalEndpoint({
    space, servers, creds, channels: [], consume: false, watchPresence: false, registerPresence: false,
    card: { name: "provisioner", kind: "endpoint" },
  });
  endpoints.push(manager);
  await manager.start();
  const delivery = new CotalEndpoint({
    space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"),
    channels: [], consume: false, watchPresence: true, registerPresence: false, ttlMs: 60_000,
    card: { name: "delivery", kind: "endpoint" },
  });
  endpoints.push(delivery);
  await delivery.start();
  await delivery.startPlane3((owner, uid) => delivery.aclForOwner(owner, uid));
  const lease = await delivery.acquireDeliveryLease(0);
  await delivery.markDeliveryLeaseReady(0, lease);
  const grant = { allowSubscribe: [channel], allowPublish: [channel], subscribe: [channel] };
  async function identity(allowPublish = grant.allowPublish) {
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(manager, auth, id, { ...grant, allowPublish, lifecycleUid: uid });
    return { id, uid, creds };
  }
  async function seat(name: string, issued: Awaited<ReturnType<typeof identity>>) {
    const agent = new MeshAgent({
      space, servers, tls: false, name, id: issued.id.id, creds: issued.creds, lifecycleUid: issued.uid,
      subscribe: [channel], allowSubscribe: [channel], allowPublish: [channel], kind: "agent",
    });
    agents.push(agent);
    await agent.start();
    return agent;
  }
  const alice = await identity([channel, "replay.wide.>", "replay.policy.>", "replay.retry.>"]);
  const publisher = new CotalEndpoint({
    space, servers, creds: alice.creds, lifecycleUid: alice.uid, channels: [channel],
    consume: false, watchPresence: false, registerPresence: false,
    card: { id: alice.id.id, name: "alice", kind: "agent" },
  });
  endpoints.push(publisher);
  await publisher.start();
  const bob = await identity();
  const first = await seat("bob", bob);
  assert(first.ep.hasDurableMembership(channel), "the returning seat must have a durable membership");
  await first.stop();
  const old = [
    await withSenderClock(-8 * 24 * 60 * 60_000, () => publisher.multicast("offline ambient one", { channel })),
    await withSenderClock(-8 * 24 * 60 * 60_000, () => publisher.multicast("offline mention", { channel, mentions: ["bob"] })),
    await withSenderClock(-8 * 24 * 60 * 60_000, () => publisher.multicast("offline ambient two", { channel })),
  ];
  const ids = new Set(old.map((msg) => msg.id));
  const offlineDm = await withSenderClock(-8 * 24 * 60 * 60_000, () => publisher.unicast(first.id, "offline direct request"));
  const returned = await seat("bob", bob);
  await until(() => returned.peekInbox("all").filter((item) => ids.has(item.id)).length === old.length, "returning seat missed durable copies");
  const fresh = await seat("fresh", await identity());
  await until(() => fresh.peekInbox("pull-only").filter((item) => ids.has(item.id)).length === old.length, "fresh join missed replay");
  assert.equal(fresh.peekInbox("automatic").filter((item) => ids.has(item.id)).length, 0);
  assert(fresh.peekInbox("pull-only").filter((item) => ids.has(item.id)).every((item) => item.historical && fmtItem(item).includes("(history)")));
  console.log("PASS positive control: fresh join replay is historical and pull-only");
  console.log(JSON.stringify({
    returningAutomatic: returned.peekInbox("automatic").filter((item) => ids.has(item.id)).length,
    returningPullOnly: returned.peekInbox("pull-only").filter((item) => ids.has(item.id)).length,
    frames: returned.peekInbox("all").filter((item) => ids.has(item.id)).map((item) => fmtItem(item)),
  }));
  assert.equal(returned.peekInbox("automatic").filter((item) => ids.has(item.id)).length, 0, "offline durable channel copies must not start turns");
  const history = returned.peekInbox("pull-only").filter((item) => ids.has(item.id));
  assert.equal(history.length, old.length);
  assert(history.every((item) => item.historical && fmtItem(item).includes("(history)")));
  await until(() => returned.peekInbox("automatic").some((item) => item.id === offlineDm.id), "offline DM must remain automatic");
  assert.equal(returned.peekInbox("automatic").filter((item) => item.kind === "channel").length, 0, "even an old mention must not wake");
  const payload = JSON.stringify(history[0]);
  const python = spawn("python3", ["-c", "import json,sys; sys.path.insert(0, 'extensions/connector-hermes/plugin'); from cotal.framing import format_injection; print(format_injection(json.loads(sys.stdin.read())))"], { stdio: ["pipe", "pipe", "pipe"] });
  let hermesFrame = "";
  let pythonError = "";
  python.stdout.on("data", (data) => { hermesFrame += data; });
  python.stderr.on("data", (data) => { pythonError += data; });
  const framed = new Promise<void>((resolve, reject) => {
    python.once("error", reject);
    python.once("close", (code) => code === 0 ? resolve() : reject(new Error(pythonError)));
  });
  python.stdin.end(payload);
  await framed;
  assert(hermesFrame.includes("(history)"), "the shipped Hermes formatter must see the history classification");
  console.log("PASS returning seat: durable ambient posts and mentions are historical and pull-only");
  const ambient = await publisher.multicast("current ambient", { channel });
  await until(() => returned.peekInbox("automatic").some((item) => item.id === ambient.id), "current ambient channel post did not arrive automatically");
  const current = await publisher.multicast("current request", { channel, mentions: ["bob"] });
  await until(() => returned.peekInbox("automatic").some((item) => item.id === current.id), "current channel mention did not arrive automatically");
  const dm = await publisher.unicast(returned.id, "current DM");
  await until(() => returned.peekInbox("automatic").some((item) => item.id === dm.id), "current DM did not arrive automatically");
  assert(returned.peekInbox("automatic").every((item) => !item.historical));
  console.log("PASS live controls: current ambient, current mentions, current DMs and offline DMs remain automatic");
  assert((await returned.reconnect()).ok);
  assert(returned.peekInbox("automatic").some((item) => item.id === current.id && !item.historical), "a reconnect must not demote already buffered live mail");
  console.log("PASS coalescing control: buffered live mail keeps its classification across reconnect");
  const skewed = await withSenderClock(-5_000, () => publisher.multicast("current mention with five seconds clock skew", { channel, mentions: ["bob"] }));
  await until(() => returned.peekInbox("all").some((item) => item.id === skewed.id), "skewed current mention was lost");
  const skewedAutomatic = returned.peekInbox("automatic").some((item) => item.id === skewed.id && !item.historical);
  let duringGap: ReturnType<CotalEndpoint["multicast"]> | undefined;
  const publishInGap = (state: { connected: boolean }) => {
    if (!state.connected && !duringGap) duringGap = publisher.multicast("current mention during short transport gap", { channel, mentions: ["bob"] });
  };
  returned.on("transport", publishInGap);
  try { assert((await returned.reconnect()).ok); } finally { returned.off("transport", publishInGap); }
  assert(duringGap, "the test must publish during an actual transport-disconnected edge");
  const gapMessage = await duringGap;
  await until(() => returned.peekInbox("all").some((item) => item.id === gapMessage.id), "gap mention was lost");
  const gapAutomatic = returned.peekInbox("automatic").some((item) => item.id === gapMessage.id && !item.historical);
  const afterReconnect = await withSenderClock(-5_000, () => publisher.multicast("current skewed mention after reconnect", { channel, mentions: ["bob"] }));
  await until(() => returned.peekInbox("all").some((item) => item.id === afterReconnect.id), "post-reconnect mention was lost");
  const afterAutomatic = returned.peekInbox("automatic").some((item) => item.id === afterReconnect.id && !item.historical);
  console.log(JSON.stringify({ skewedAutomatic, gapAutomatic, afterAutomatic, gapAgeMs: Date.now() - gapMessage.ts }));
  assert(skewedAutomatic && gapAutomatic && afterAutomatic, "current mentions must stay automatic despite modest sender clock skew or a short transport gap");
  console.log("PASS reconnect controls: five-second sender skew and short-gap mentions stay automatic");
  await fresh.stop();
  await returned.stop();
  await seedChannelRegistry({ servers, space, creds, file: { defaults: { replay: false }, channels: {} } });
  const replayOffPost = await withSenderClock(-8 * 24 * 60 * 60_000, () => publisher.multicast("aged replay-off mention", { channel, mentions: ["bob"] }));
  const replayOffSeat = await seat("bob", bob);
  await until(() => replayOffSeat.peekInbox("all").some((item) => item.id === replayOffPost.id), "replay-off durable backlog was lost");
  assert(replayOffSeat.peekInbox("pull-only").some((item) => item.id === replayOffPost.id && item.historical));
  assert(!replayOffSeat.peekInbox("automatic").some((item) => item.id === replayOffPost.id));
  console.log("PASS replay-off control: aged durable mentions remain available as pull-only history");
  await replayOffSeat.stop();
  await seedChannelRegistry({ servers, space, creds, file: { defaults: { replay: true }, channels: {} } });
  await checkWideReplay(manager, publisher);
  await checkInterruptedReplay(manager, publisher);
  await checkOverlappingWindows(manager, publisher, creds);
} finally {
  for (const agent of agents.reverse()) await agent.stop();
  for (const endpoint of endpoints.reverse()) await endpoint.stop();
  await killAndAwaitExit(broker);
  release();
}
emitSentinel({ passed: 9, failed: 0 });
