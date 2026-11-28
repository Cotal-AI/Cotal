/**
 * delivery reconnect-responder smoke (blocker 2). `serveControl(CONTROL_DELIVERY)` is bound via
 * `armPlane3`/`armDeliveryControl`, which runs on EVERY (re)connect — a reconnect drains the old
 * connection (the old sub dies, and `clearConnectionScoped` leaves caller-owned subs alone), so the
 * responder + the Plane-3 KV handles (`membersKv`/`aclKv`/`deliveryKv`) and the observer's derived
 * membership-feed handle must be re-bound/re-opened on the fresh connection. Old and stopped watches
 * must release their local subscription. Read-only consumers remain for native inactivity reclamation
 * without ungranted DELETE requests. Asserts these lifetimes beside durable join/leave/list checks.
 *
 * Run: pnpm smoke:delivery-reconnect:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid, serverConfig, newIdentity, setupSpaceStreams, principalKey, DEV_OWNER, membershipBucket, MEMBERSHIP_FEED_KEY, standaloneConnectOpts, dlvDurable, type MembershipChange } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openChannelRegistry, readChannelRegistry } from "../src/channels.js";
import type { ConnectionState } from "../src/endpoint-connection-state.js";
import { recordsBucket } from "../src/endpoint-records.js";
import { PLUGIN_CHANNEL_PROJECTION_KEY } from "../src/plugin-channel-projection.js";
import { PLUGIN_CHANNEL_ROOT } from "../src/plugin-channel-route.js";
import { chatStream, dlvStream, inboxStream, type CotalMessage, type Delivery, type MessageMeta, type PluginMentionPointer } from "../src/index.js";
import { pluginChannelStream, pluginChannelSubject } from "../src/plugin-channel-route.js";
import { PLUGIN_MENTION_POINTER_KEY } from "../src/types.js";
import { isStreamNotFound } from "../src/jetstream-missing.js";
import { startEnabledPluginSpace } from "./fixtures/enabled-plugin-space.js";

const PORT = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
const reconnected = (ep: CotalEndpoint): Promise<void> => new Promise((resolve) => {
  const onConnection = (state: { connected: boolean }) => { if (state.connected) { ep.off("connection", onConnection); resolve(); } };
  ep.on("connection", onConnection);
});
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

async function checkEnabledPluginDelivery() {
  const fixture = await startEnabledPluginSpace();
  const { channel, hiddenChannel, chatChannel, space, endpoint, mintAgent, jsm } = fixture;
  try {
    const daemon = await fixture.startDelivery();
    const reader = await mintAgent({ read: [channel] });
    const writer = await mintAgent({ post: [channel] });
    const read = endpoint({ creds: reader.creds, lifecycleUid: reader.lifecycleUid, channels: [channel],
      allowSubscribe: [channel, hiddenChannel], card: { kind: "agent", name: "scoped-reader" } });
    const write = endpoint({ creds: writer.creds, lifecycleUid: writer.lifecycleUid, channels: [],
      consume: false, registerPresence: false, watchPresence: false, card: { kind: "agent", name: "scoped-writer" } });
    const observer = endpoint({ creds: await fixture.mintObserver(), channels: [], consume: false,
      readChannelRoutingProjection: true, registerPresence: false, watchPresence: false,
      allowSubscribe: [channel, hiddenChannel], card: { kind: "endpoint", name: "chat-observer" } });
    const live: CotalMessage[] = [], tapped: CotalMessage[] = [], notices: CotalMessage[] = [];
    read.on("message", (msg: CotalMessage, delivery: Delivery, meta: MessageMeta) => {
      if (meta.kind === "channel" && !meta.historical && !delivery.durable) live.push(msg);
      if (msg.parts.some((p) => p.kind === "data" && typeof p.data === "object" && p.data !== null &&
        Object.hasOwn(p.data, PLUGIN_MENTION_POINTER_KEY))) notices.push(msg);
      delivery.ack();
    });
    read.tap((_subject, msg) => { if (msg) tapped.push(msg); }, { subject: pluginChannelSubject(space, "*", "*", channel) });
    await Promise.all([read.start(), write.start(), observer.start()]);
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 120 && !condition(); i++) await wait(50);
      return condition();
    };
    check("the signed writer, reader and CHAT observer admit the isolated routing projection",
      [read, write, observer].every((ep) => ep.channelRoutingMode() === "isolated"));
    const names = (rows: Awaited<ReturnType<typeof read.listChannels>>) => rows.map((row) => row.channel);
    const readable = names(await read.listChannels());
    const chatOnly = names(await observer.listChannels());
    const replay = await observer.channelReplayPolicy(chatChannel);
    check("the fixture's ordinary CHAT channel has explicit replay enabled", replay.registered && replay.replay && replay.window === "1h", replay);
    check("isolated discovery lists admitted grants and suppresses stale configured names",
      readable.includes(channel) && !readable.includes(hiddenChannel) && !chatOnly.includes(channel) && !chatOnly.includes(hiddenChannel),
      { readable, chatOnly });
    const post = await write.multicast("retained plugin body", { channel });
    check("the real broker delivers the post to an exact scoped live subscriber and native tap",
      await waitFor(() => live.some(({ id }) => id === post.id) && tapped.some(({ id }) => id === post.id)));
    check("the scoped reader reads the retained post from its named filtered consumer",
      (await read.channelHistory(channel, { limit: 10 })).some(({ id }) => id === post.id));
    const frontier = await read.channelFrontier(channel);
    const state = async (name: string) => (await jsm.streams.info(name)).state;
    check("the plugin post advances only its own stream and yields no ordinary channel copies",
      frontier > 0 && (await state(pluginChannelStream(space))).last_seq === frontier &&
      (await state(chatStream(space))).messages === 0 && (await state(inboxStream(space))).messages === 0 &&
      (await state(dlvStream(space))).messages === 0);

    check("daemon sees the uniquely resolved recipient before the mention", await waitFor(() =>
      daemon.getRoster().some(({ card }) => card.name === "scoped-reader")));
    const mention = await write.multicast("not inside the directed pointer", { channel, mentions: ["scoped-reader"] });
    const pointerArrived = await waitFor(() => notices.length > 0);
    const notice = notices[0];
    const part = notice?.parts[0];
    const pointer = (part?.kind === "data" ? (part.data as Record<string, unknown>)[PLUGIN_MENTION_POINTER_KEY] : undefined) as PluginMentionPointer | undefined;
    check("the directed notice has only the daemon pointer and no body", pointerArrived && notice.parts.length === 1 &&
      pointer?.channel === channel && pointer.message === mention.id && pointer.seq > frontier &&
      !JSON.stringify(notice).includes("not inside the directed pointer"), notice);
    if (pointer) {
      check("daemon mediation fetches only the exact channel, message and sequence",
        (await read.readPluginMentionHistory(pointer))?.id === mention.id &&
        await read.readPluginMentionHistory({ ...pointer, message: post.id }) === undefined);
      await fixture.provisioner.commitAcl(reader.principal, reader.lifecycleUid, []);
      check("narrowing the live ACL refuses a later fetch of that same pointer",
        await read.readPluginMentionHistory(pointer).then(() => false, () => true));
    }
    check("mention processing still leaves ordinary INBOX and DLV without plugin copies",
      (await state(inboxStream(space))).messages === 0 && (await state(dlvStream(space))).messages === 0);
    await daemon.stop();
    await fixture.removePluginHistory();
    check("a removed plugin stream is broker-confirmed absence, not an empty page or a CHAT fallback",
      read.channelRoutingMode() === "isolated" &&
      await read.channelHistory(channel, { limit: 10 }).then(() => false, isStreamNotFound) &&
      (await state(chatStream(space))).messages === 0);
  } finally {
    await fixture.close();
  }
}

async function checkPluginProjection(space: string, provisioner: string, creds: string, lifecycleUid: string, viewerCreds: string, probeCreds: string): Promise<void> {
  const writer = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provisioner, tls: false }) });
  const key = PLUGIN_CHANNEL_PROJECTION_KEY;
  const kv = await openChannelRegistry(writer, space);
  const legacyChannel = `${PLUGIN_CHANNEL_ROOT}.sample.replay`;
  await kv.put(legacyChannel, JSON.stringify({ replay: false, replayWindow: "1h" }));
  const probe = new CotalEndpoint({ space, servers: SERVERS, creds: probeCreds, card: { name: "projection-ungranted", kind: "endpoint" },
    readChannelRoutingProjection: true, consume: false, watchPresence: false, registerPresence: false });
  try {
    await probe.start();
    check("endpoint without a projection grant binds without claiming legacy or isolated mode", probe.channelRoutingMode() === undefined);
  } finally { await probe.stop(); }
  const opened: NatsConnection[] = [];
  const ready: { wire: NatsConnection | undefined; epoch: number | undefined; enabled: boolean }[] = [];
  const warnings: string[] = [];
  const ep = new CotalEndpoint({
    space, servers: SERVERS, creds, lifecycleUid, card: { name: "projection-agent", kind: "agent" },
    channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
    onConnection: (nc) => { opened.push(nc); },
  });
  const state = (ep as unknown as { conn: ConnectionState }).conn;
  let viewerWire: NatsConnection | undefined;
  const viewer = new CotalEndpoint({ space, servers: SERVERS, creds: viewerCreds, card: { name: "projection-viewer", kind: "endpoint" },
    readChannelRoutingProjection: true, consume: false, watchPresence: true, registerPresence: false,
    onConnection: (nc) => { viewerWire = nc; } });
  viewer.on("error", (error) => { if (error instanceof Error) warnings.push(error.message); });
  ep.on("transport", (event) => {
    if (event.connected) ready.push({ wire: state.nc, epoch: state.pluginChannelEpoch, enabled: state.pluginChannelsEnabled });
  });
  ep.on("warning", (error) => { if (error instanceof Error) warnings.push(error.message); });
  ep.on("error", (error) => { if (error instanceof Error) warnings.push(error.message); });
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await wait(50);
    return condition();
  };
  const put = (enabled: boolean, epoch: number) => kv.put(key, JSON.stringify({ enabled, epoch }));
  try {
    check("public routing mode is undefined before the initial bind", ep.channelRoutingMode() === undefined);
    await ep.start();
    await viewer.start();
    check("scoped endpoint-kind observer reads legacy mode without plugin access", viewer.channelRoutingMode() === "legacy");
    check("off mode preserves the cached replay override on the legacy channel", await until(() => !viewer.channelReplay(legacyChannel)) &&
      viewer.channelReplayWindow(legacyChannel) === "1h");
    check("credentialed non-consuming agent binds absent projection as CHAT before ready", ready.length === 1 &&
      ready[0].epoch === 0 && !ready[0].enabled && ep.channelRoutingMode() === "legacy");
    const first = opened[0];
    await first.reconnect();
    check("same projection preserves the native connection and re-announces readiness", await until(() => ready.length === 2) &&
      ready[1].wire === first && ready[1].epoch === 0);

    await put(true, 1);
    const viewerBefore = viewerWire!;
    await viewerBefore.reconnect();
    check("endpoint-kind observer admits isolated mode only on its replacement wire", await until(() => viewer.channelRoutingMode() === "isolated") &&
      viewerWire !== viewerBefore && viewerBefore.isClosed());
    const isolatedReplay = await viewer.channelReplayPolicy(legacyChannel);
    check("isolated cached replay matches fresh policy without the shared override", !isolatedReplay.registered &&
      viewer.getChannelConfig(legacyChannel) === undefined && viewer.channelReplay(legacyChannel) === isolatedReplay.replay &&
      viewer.channelReplayWindow(legacyChannel) === (isolatedReplay.window ?? undefined));
    await first.reconnect();
    check("native reconnect with new epoch never announces ready on reused subscriptions", await until(() => ready.length >= 3) &&
      ready.length === 3 && ready[2].wire !== first && first.isClosed() && ready[2].epoch === 1 && ready[2].enabled && ep.channelRoutingMode() === "isolated");
    const old = ready[2]?.wire;
    if (!old) throw new Error("fixture did not establish a rebuilt transport");
    await kv.put(key, "{");
    await old.reconnect();
    check("corrupt reconnect refuses readiness and reports the validation error", await until(() => old.isClosed()) &&
      ready.length === 3 && warnings.some((message) => message.includes("malformed plugin channel route projection")));
    await put(true, 2);
    check("full bind can recover after a corrupt reconnect without reviving the old wire", await until(() => ready.length >= 4) &&
      ready.length === 4 && ready[3].epoch === 2 && ready[3].wire !== old);

    const view = await readChannelRegistry({ servers: SERVERS, space, creds, directGet: true });
    check("the public registry view does not expose routing metadata as a channel or warning",
      !Object.hasOwn(view.channels ?? {}, key) && !view.undecodable?.some((entry) => entry.key === key));
    const watchedView = await readChannelRegistry({ servers: SERVERS, space, creds: viewerCreds });
    check("the scanned registry also excludes routing metadata and warnings",
      !Object.hasOwn(watchedView.channels ?? {}, key) && !watchedView.undecodable?.some((entry) => entry.key === key));
    const stale = state.nc!;
    const request = stale.request.bind(stale);
    let readHeld = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    stale.request = async (...args: Parameters<NatsConnection["request"]>) => {
      const reply = await request(...args);
      if (args[0].startsWith("$JS.API.STREAM.MSG.GET.") && !readHeld) {
        readHeld = true;
        await held;
      }
      return reply;
    };
    try {
      await stale.reconnect();
      if (!(await until(() => readHeld))) throw new Error("fixture did not hold the native projection reply");
      check("public routing mode is undefined while native projection admission is pending", ep.channelRoutingMode() === undefined);
      await put(false, 3);
      await ep.reconnect();
    } finally { release(); }
    await wait(50);
    check("a delayed projection reply cannot overwrite or announce readiness for a replacement transport", ready.length === 5 &&
      ready[4].wire !== stale && ready[4].epoch === 3 && !ready[4].enabled && state.pluginChannelEpoch === 3 && ep.channelRoutingMode() === "legacy");
    await kv.delete(key);
    let bootReady = false;
    const refused = new CotalEndpoint({ space, servers: SERVERS, creds, lifecycleUid, card: { name: "projection-refused", kind: "agent" },
      consume: false, watchPresence: false, registerPresence: false, watchChannels: false });
    refused.on("transport", (event) => { if (event.connected) bootReady = true; });
    let failure: unknown;
    try { await refused.start(); } catch (error) { failure = error; } finally { await refused.stop(); }
    check("boot rejects deleted projection without publishing readiness", !bootReady &&
      failure instanceof Error && failure.message.includes("invalid plugin channel route projection record"));
  } finally {
    await viewer.stop();
    await ep.stop();
    await writer.close();
  }
}

async function checkStopWhileRedialing(dir: string, space: string): Promise<void> {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "redial")], { stdio: "ignore" });
  const release = teardownOnSignal(broker);
  let nc: NatsConnection | undefined;
  const ep = new CotalEndpoint({
    space, servers, consume: false, watchPresence: false, registerPresence: false,
    card: { name: "redial-observer", kind: "endpoint" }, onConnection: (connection) => { nc = connection; },
  });
  ep.on("error", () => {});
  try {
    // An open broker lets the watch attempt its consumer delete without a credential fence.
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
    await setupSpaceStreams({ servers, space });
    await ep.start();
    await ep.watchMembership(() => {});
    let disconnected = false;
    ep.on("transport", (s) => { if (!s.connected) disconnected = true; });
    await killAndAwaitExit(broker);
    for (let i = 0; i < 40 && !disconnected; i++) await wait(50);
    if (!disconnected || !nc || nc.isClosed()) throw new Error("fixture did not observe a disconnected, open transport");
    const result = await Promise.race([
      ep.stop().then(() => "stopped", (err: Error) => err.message),
      wait(2000).then(() => "pending after 2 seconds"),
    ]);
    check("endpoint stops within two seconds with a membership watch while its transport redials", result === "stopped" && nc.isClosed(), result);
  } finally {
    await killAndAwaitExit(broker);
    await nc?.close();
    await ep.stop().catch(() => {});
    release();
  }
}

const space = `delivery-reconnect-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }) + `
http: "127.0.0.1:${MON}"
`);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, agent: CotalEndpoint | undefined, observer: CotalEndpoint | undefined, sup: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start();

  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {}); await daemon.start();
  await daemon.startPlane3((owner, lifecycleUid) => daemon!.aclForOwner(owner, lifecycleUid), { readPluginChannelAuthority: true });
  const daemonState = (daemon as unknown as { conn: ConnectionState }).conn;
  const initialDaemonWire = daemonState.nc!;
  check("scoped delivery credential reads absent authority before Plane-3 starts",
    daemonState.pluginChannelEpoch === 0 && !daemonState.pluginChannelsEnabled);
  let nativeReady = 0;
  daemon.on("transport", (event) => { if (event.connected && daemonState.nc === initialDaemonWire) nativeReady++; });
  const request = initialDaemonWire.request;
  const authorityApi = `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`;
  let leaderReplyHeld = false;
  let releaseLeaderReply!: () => void;
  const leaderReply = new Promise<void>((resolve) => { releaseLeaderReply = resolve; });
  initialDaemonWire.request = async (...args: Parameters<NatsConnection["request"]>) => {
    if (args[0] !== authorityApi) return request.apply(initialDaemonWire, args);
    try { return await request.apply(initialDaemonWire, args); }
    finally { leaderReplyHeld = true; await leaderReply; }
  };
  try {
    await initialDaemonWire.reconnect();
    for (let i = 0; i < 100 && !leaderReplyHeld && !initialDaemonWire.isClosed(); i++) await wait(50);
    check("native delivery readiness waits for the current wire's records leader reply", leaderReplyHeld && nativeReady === 0);
  } finally {
    initialDaemonWire.request = request;
    releaseLeaderReply();
  }
  for (let i = 0; i < 100 && nativeReady === 0 && !initialDaemonWire.isClosed(); i++) await wait(50);
  check("same authority admits the same native delivery connection after reconnect",
    nativeReady === 1 && daemonState.nc === initialDaemonWire && daemonState.pluginChannelEpoch === 0);

  // The dashboard/observer is the membership-feed reader in production. Use its real admin grant:
  // the delivery cred writes the feed but deliberately cannot create the ordered consumer a KV watch needs.
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer", role: "observer", kind: "endpoint" } });
  observer.on("error", () => {}); await observer.start();

  const aId = newIdentity();
  const uidA = mintLifecycleUid(); // alice's one lifecycle uid (SPEC §13.1)
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["review", "ops"], subscribe: ["review"], lifecycleUid: uidA });
  agent = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], consume: false, lifecycleUid: uidA, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();

  // Pre-reconnect: the responder works + the daemon holds a (ready) lease (so the deliveryKv reopen is
  // exercised post-reconnect).
  const leaseRev = await daemon.acquireDeliveryLease(0);
  const readyLeaseRev = await daemon.markDeliveryLeaseReady(0, leaseRev);
  const pre = await agent.durableJoinChannel("review");
  check("durableJoin works before reconnect", pre.durable === true);
  const reviewGen = pre.generation ?? 0;
  await observer.readMembership(); // open the membership-feed KV on the old connection before rebuilding
  const membershipStream = `KV_${membershipBucket(space)}`;
  // PUSH-BOUND consumers only. The admin cred holds no consumer delete on this bucket (#691), so a
  // stopped or superseded watch leaves its unbound consumer to the broker's inactive threshold.
  const membershipConsumers = async (): Promise<string[]> => {
    const j = await (await fetch(`http://127.0.0.1:${MON}/jsz?consumers=true&streams=true&accounts=true`)).json() as
      { account_details?: { stream_detail?: { name: string; consumer_detail?: { name: string; push_bound?: boolean }[] }[] }[] };
    const out: string[] = [];
    for (const acc of j.account_details ?? []) for (const st of acc.stream_detail ?? [])
      if (st.name === membershipStream) for (const c of st.consumer_detail ?? []) if (c.push_bound) out.push(c.name);
    return out.sort();
  };
  let membershipChanges = 0;
  const membershipDelivered: MembershipChange[] = [];
  const membershipWatch = await observer.watchMembership((change) => { membershipChanges++; membershipDelivered.push(change); });
  await wait(200); // drain the watch's initial replay before measuring the post-reconnect write
  // #4904: the watch delivers the entries, not a bare tick, and the replay ends with one marker.
  check("the watch's initial replay ends with exactly one replayed marker", membershipDelivered.filter((c) => c.type === "replayed").length === 1, membershipDelivered);
  check("every replayed entry is marked update: false", membershipDelivered.every((c) => c.type === "replayed" || c.update === false), membershipDelivered);
  membershipChanges = 0;
  membershipDelivered.length = 0;
  const beforeMembershipConsumers = await membershipConsumers();
  check("the pre-reconnect membership watch owns exactly one live broker consumer", beforeMembershipConsumers.length === 1, beforeMembershipConsumers);
  const predecessorMembershipConsumerName = beforeMembershipConsumers[0];

  // A supervisor holding its manager liveness lease, so the lease KV handle is cached before the rebuild.
  // Its renew after the reconnect is the cell: the handle is bound to the connection, and a rebuild that
  // keeps it leaves every later renew and re-read timing out on a dead connection for good.
  sup = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "supervisor"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "sup", role: "manager", kind: "endpoint" } });
  sup.on("error", () => {}); await sup.start();
  const leaseInfo = { holder: sup.ref().id, instanceId: `iid-${randomUUID().slice(0, 8)}`, runtime: "pty", root: dir, pid: process.pid };
  const supRev = await sup.acquireManagerLease(leaseInfo);

  // Force the roles to drain + rebuild. The daemon exercises its responder/Plane-3 handles; the
  // observer exercises the cached read-only membership-feed handle that triggered #800; the
  // supervisor exercises the cached manager-lease handle.
  await Promise.all([daemon.reconnect(), observer.reconnect(), sup.reconnect()]);
  await wait(400);
  // The rearmed watch replays the bucket again before any new write: the feed is empty here, so the
  // replay is its marker alone, and it must not count as the write below arriving.
  const rearmReplay = membershipDelivered.splice(0);
  membershipChanges = 0;
  check("the rearmed watch replays the feed again: one replayed marker and nothing marked update: true", rearmReplay.filter((c) => c.type === "replayed").length === 1 && rearmReplay.every((c) => c.type === "replayed" || !c.update), rearmReplay);

  let renewedRev: number | undefined, renewErr: string | undefined;
  try { renewedRev = await sup.renewManagerLease(leaseInfo, supRev); } catch (e) { renewErr = (e as Error).message; }
  const reread = await sup.readOwnManagerLease(leaseInfo.instanceId).catch((e: Error) => e.message);
  check("the manager lease renews after reconnect (managerLeaseKv reopened on the fresh connection)", renewedRev !== undefined && renewedRev > supRev, { renewErr, supRev, renewedRev });
  check("and the manager lease reads back as its own after reconnect", typeof reread === "object" && reread?.revision === renewedRev, reread);

  // Post-reconnect, ALL ctl.delivery ops + every Plane-3 KV handle must work on the fresh connection:
  // join (aclKv read + membersKv write), list (membersKv read), leave (membersKv tombstone), and the
  // lease read (deliveryKv) — the exact set the blocker covered (responder rebind + stale KV reopen).
  let postJoin: { durable: boolean } | undefined;
  try { postJoin = await agent.durableJoinChannel("ops"); } catch (e) { console.log(`    (post-reconnect join threw: ${(e as Error).message})`); }
  check("durableJoin works after reconnect (responder + aclKv + membersKv re-bound)", postJoin?.durable === true);

  const members = await daemon.ownerMemberships(principalKey(DEV_OWNER, aId.id).key, uidA);
  check("listMemberships works after reconnect (membersKv reopened)", members.some((m) => m.channel === "review") && members.some((m) => m.channel === "ops"));

  let leftOk = false;
  try { await agent.durableLeaveChannel("review", reviewGen); leftOk = true; } catch (e) { console.log(`    (post-reconnect leave threw: ${(e as Error).message})`); }
  check("durableLeave works after reconnect (membersKv tombstone)", leftOk);

  const lease = await daemon.readDeliveryLease(0);
  check("the delivery lease is still readable after reconnect (deliveryKv reopened)", lease?.ready === true);
  let membershipReadOk = false;
  try { await observer.readMembership(); membershipReadOk = true; }
  catch (e) { console.log(`    (post-reconnect membership read threw: ${(e as Error).message})`); }
  check("the membership feed read re-opens on the fresh connection", membershipReadOk);

  const membershipRwCreds = await mintCreds(auth, newIdentity(), "membership-rw");
  const membershipNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: membershipRwCreds, tls: false }) });
  try {
    const feed = await new Kvm(membershipNc).open(membershipBucket(space));
    const probeObservedAt = Date.now();
    await feed.put("reconnect-probe", JSON.stringify({ live: ["ops"], durable: [], observedAt: probeObservedAt }));
    for (let i = 0; i < 20 && membershipChanges === 0; i++) await wait(50);
    check("the membership feed watch stays live across reconnect", membershipChanges > 0, { membershipChanges });
    // The write is delivered as a decoded member record; a heartbeat write arrives as its `asOf`, and
    // a delete as a member change with no record — the shapes a caller needs to keep its snapshot
    // current without re-reading the bucket (#4904).
    const probeChange = membershipDelivered.find((c) => c.type === "member" && c.id === "reconnect-probe");
    check("the post-reconnect write is delivered as a decoded member change", probeChange?.type === "member" && probeChange.operation === "PUT" && probeChange.update && probeChange.member?.observedAt === probeObservedAt && probeChange.member.live[0] === "ops" && probeChange.revision > 0, membershipDelivered);
    const seen = membershipDelivered.length;
    const heartbeatAt = Date.now();
    await feed.put(MEMBERSHIP_FEED_KEY, JSON.stringify({ observedAt: heartbeatAt }));
    await feed.delete("reconnect-probe");
    const later = () => membershipDelivered.slice(seen);
    const deletion = () => later().find((c) => c.type === "member" && c.id === "reconnect-probe");
    for (let i = 0; i < 40 && !deletion(); i++) await wait(50);
    const heartbeat = later().find((c) => c.type === "heartbeat");
    check("a heartbeat write is delivered as the feed's asOf, not as a member", heartbeat?.type === "heartbeat" && heartbeat.asOf === heartbeatAt && heartbeat.update, later());
    const deleted = deletion();
    check("a deleted member is delivered as a member change with no record", deleted?.type === "member" && deleted.operation === "DEL" && deleted.member === undefined && deleted.update === true, later());
  } finally {
    await membershipNc.drain();
  }
  const afterMembershipConsumers = await membershipConsumers();
  const successorMembershipConsumerName = afterMembershipConsumers.find((n) => n !== predecessorMembershipConsumerName);
  check("reconnect creates exactly one successor membership consumer", afterMembershipConsumers.length === 1 && successorMembershipConsumerName !== undefined, { predecessorMembershipConsumerName, afterMembershipConsumers });
  check("reconnect leaves no bound predecessor membership consumer", !afterMembershipConsumers.includes(predecessorMembershipConsumerName), { predecessorMembershipConsumerName, afterMembershipConsumers });
  await membershipWatch.stop();
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 0; i++) await wait(50);
  check("stopping the membership watch unbinds its broker consumer", (await membershipConsumers()).length === 0, await membershipConsumers());

  // Invoke the public stop while its broker consumer is live, then terminal-close that epoch.
  // Read-only cleanup must settle and unbind without attempting an ungranted delete on either epoch.
  const raceNc = (observer as unknown as { conn: { nc: import("@nats-io/transport-node").NatsConnection } }).conn.nc;
  const raceFeed = await new Kvm(raceNc).open(membershipBucket(space));
  const raceBucket = raceFeed as unknown as { js: { consumers: { getPushConsumer: (...a: unknown[]) => Promise<import("@nats-io/jetstream").PushConsumer> } } };
  const raceGet = raceBucket.js.consumers.getPushConsumer.bind(raceBucket.js.consumers);
  let raceConsumer: import("@nats-io/jetstream").PushConsumer | undefined;
  raceBucket.js.consumers.getPushConsumer = async (...args: unknown[]) => {
    raceConsumer = await raceGet(...args);
    return raceConsumer;
  };
  (observer as unknown as { conn: { membershipFeedKv: unknown } }).conn.membershipFeedKv = raceFeed;
  const raceHandle = await observer.watchMembership(() => {});
  // The broker marks the consumer push-bound only once it sees the subscribe, which can trail the watch.
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 1; i++) await wait(50);
  const raceConsumers = await membershipConsumers();
  check("the public stop/close race starts with one membership consumer", raceConsumers.length === 1 && raceConsumer !== undefined, raceConsumers);
  if (!raceConsumer) throw new Error("public stop/close race did not capture broker consumer creation");
  const raceDelete = raceConsumer.delete;
  let raceDeleteCalls = 0;
  raceConsumer.delete = function () { raceDeleteCalls++; return raceDelete.call(this); };
  const raceDeletePrefix = `$JS.API.CONSUMER.DELETE.${membershipStream}.`;
  const ncPrototype = Object.getPrototypeOf(raceNc) as typeof raceNc;
  const ncRequest = ncPrototype.request;
  const raceRequest = raceNc.request;
  let raceDeleteRequests = 0;
  // Existing connections already bind request; the prototype observes the fresh connection too.
  raceNc.request = function (this: typeof raceNc, ...args: Parameters<typeof raceRequest>) {
    if (args[0].startsWith(raceDeletePrefix)) raceDeleteRequests++;
    return raceRequest.apply(this, args);
  };
  ncPrototype.request = function (this: typeof raceNc, ...args: Parameters<typeof ncRequest>) {
    if (args[0].startsWith(raceDeletePrefix)) raceDeleteRequests++;
    return ncRequest.apply(this, args);
  };
  try {
    const raceStop = raceHandle.stop();
    void raceStop.catch(() => {});
    const raceHealed = reconnected(observer).then(() => true);
    void raceNc.close();
    await raceNc.closed();
    const raceStopSettled = await Promise.race([raceStop.then(() => true, () => false), wait(5000).then(() => false)]);
    // Observe fresh-epoch requests before restoring the spies or starting another watch.
    const raceReconnected = await Promise.race([raceHealed, wait(5000).then(() => false)]);
    for (let i = 0; i < 40 && (await membershipConsumers()).length !== 0; i++) await wait(50);
    check("public stop concurrent with terminal close resolves without ungranted deletes", raceStopSettled && raceReconnected && raceDeleteCalls === 0 && raceDeleteRequests === 0 && (await membershipConsumers()).length === 0, { raceStopSettled, raceReconnected, raceDeleteCalls, raceDeleteRequests, consumers: await membershipConsumers() });
  } finally {
    raceConsumer.delete = raceDelete;
    raceNc.request = raceRequest;
    ncPrototype.request = ncRequest;
  }

  const shutdownWatch = await observer.watchMembership(() => {});
  await wait(200);
  const shutdownConsumer = await membershipConsumers();
  check("the shutdown-order control starts with one membership consumer", shutdownConsumer.length === 1, shutdownConsumer);
  await shutdownWatch.stop();
  await observer.stop();
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 0; i++) await wait(50);
  check("awaited watch stop before endpoint stop unbinds the broker consumer", (await membershipConsumers()).length === 0, await membershipConsumers());

  // Permanent endpoint shutdown has no future cleanup epoch. If the broker connection is already
  // terminal, an outstanding public stop must not hang the process waiting for an impossible rebuild.
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer-broker-down", role: "observer", kind: "endpoint" } });
  observer.on("error", () => {}); await observer.start();
  const brokerDownWatch = await observer.watchMembership(() => {});
  await (observer as unknown as { conn: { nc: import("@nats-io/transport-node").NatsConnection } }).conn.nc.close();
  const brokerDownStop = brokerDownWatch.stop();
  void brokerDownStop.catch(() => {});
  const endpointStopped = await Promise.race([observer.stop().then(() => true), wait(2000).then(() => false)]);
  const brokerDownWatchStopped = await Promise.race([brokerDownStop.then(() => true, () => false), wait(1000).then(() => false)]);
  check("endpoint shutdown while broker is down settles the public membership stop", endpointStopped && brokerDownWatchStopped, { endpointStopped, brokerDownWatchStopped });
  // This terminal boundary leaves broker expiry to retire the unreachable consumer, which the bound-only
  // census no longer counts, so later cells grade their own ownership rather than this exception.
  for (let i = 0; i < 20 && (await membershipConsumers()).length !== 0; i++) await wait(50);
  check("the broker-down shutdown exception is isolated before later lifecycle cells", (await membershipConsumers()).length === 0, await membershipConsumers());

  // Restart a fresh observer for the terminal-close arm: endpoint stop is permanent by contract.
  observer = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "observer-2", role: "observer", kind: "endpoint" } });
  observer.on("error", () => {}); await observer.start();

  // Terminal self-heal starts after the old connection closes. The read-only predecessor becomes
  // unbound for native inactivity reclamation; the fresh connection must own one successor watch.
  let terminalChanges = 0;
  const terminalWatch = await observer.watchMembership(() => { terminalChanges++; });
  await wait(200);
  terminalChanges = 0;
  const terminalBefore = await membershipConsumers();
  check("the terminal-close control starts with one membership consumer", terminalBefore.length === 1, terminalBefore);
  const healed = reconnected(observer);
  await (observer as unknown as { conn: { nc: import("@nats-io/transport-node").NatsConnection } }).conn.nc.close();
  await Promise.race([healed, wait(5000)]);
  await wait(200);
  const terminalAfter = await membershipConsumers();
  check("terminal self-heal creates one successor and leaves no bound closed-epoch predecessor", terminalAfter.length === 1 && !terminalAfter.some((n) => terminalBefore.includes(n)), { terminalBefore, terminalAfter });
  const terminalNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: membershipRwCreds, tls: false }) });
  try {
    const feed = await new Kvm(terminalNc).open(membershipBucket(space));
    await feed.put("terminal-reconnect-probe", JSON.stringify({ live: [], durable: [], observedAt: Date.now() }));
    for (let i = 0; i < 20 && terminalChanges === 0; i++) await wait(50);
  } finally { await terminalNc.drain(); }
  check("the membership watch stays live after terminal self-heal", terminalChanges > 0, { terminalChanges });

  // A transient failed arm leaves a rejected promise in the per-watch queue. A later rebuild must
  // reset that rejection before appending cleanup/rearm work, or this watch is poisoned forever.
  const terminalIntent = [...(observer as unknown as { conn: { membershipFeedWatches: Set<{ arm: Promise<void> }> } }).conn.membershipFeedWatches][0];
  terminalIntent.arm = Promise.reject(new Error("transient membership arm failure"));
  void terminalIntent.arm.catch(() => {}); // handled, but intentionally still the rejected queue value
  let recoveredFromRejectedArm = false;
  try { await observer.reconnect(); recoveredFromRejectedArm = true; } catch { /* cell below names it */ }
  check("a later rebuild recovers a membership watch after a transient arm rejection", recoveredFromRejectedArm);

  // A watch iterator closed under a live connection must reach the caller through onClosed,
  // not just the generic endpoint error event.
  const closedReasons: string[] = [];
  const watchesBeforeClosedCell = new Set([...(observer as unknown as { conn: { membershipFeedWatches: Set<{ iter?: { stop(): void } }> } }).conn.membershipFeedWatches]);
  const closedWatch = await observer.watchMembership(() => {}, (err) => { closedReasons.push(err.message); });
  await wait(200);
  const closedWatchIntent = [...(observer as unknown as { conn: { membershipFeedWatches: Set<{ iter?: { stop(): void } }> } }).conn.membershipFeedWatches]
    .find((w) => !watchesBeforeClosedCell.has(w));
  closedWatchIntent?.iter?.stop();
  for (let i = 0; i < 40 && closedReasons.length === 0; i++) await wait(50);
  check("a watch iterator closed under a live connection reaches the caller's closed callback", JSON.stringify(closedReasons) === JSON.stringify(["membership watch closed"]), closedReasons);
  await closedWatch.stop();

  await terminalWatch.stop();

  const durable = dlvDurable(DEV_OWNER, aId.id, uidA);
  const probeDlvBind = async () => {
    const errors: Error[] = [];
    const warnings: Error[] = [];
    let messages = 0;
    const probe = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], lifecycleUid: uidA, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice-bind-probe", kind: "agent" } });
    probe.on("error", (e) => errors.push(e));
    probe.on("warning", (e) => warnings.push(e));
    probe.on("message", () => { messages++; });
    let startError: Error | undefined;
    try { await probe.start(); await wait(100); }
    catch (e) { startError = e as Error; }
    finally { try { await probe.stop(); } catch { /* isolate probe cleanup from the named bind cells */ } }
    return { errors, warnings, messages, startError };
  };

  const quiet = await probeDlvBind();
  check("a quiet delivery durable binds while the plane holds a ready lease without raising a warning", quiet.startError === undefined && quiet.errors.length === 0 && quiet.warnings.length === 0, quiet);
  check("the ready-lease control delivers no message on a genuinely quiet plane", quiet.messages === 0, quiet);

  await daemon.releaseDeliveryLease(0, readyLeaseRev);
  const missingLease = await probeDlvBind();
  const missingLeaseWarning = missingLease.warnings[0];
  check("a delivery durable binds and warns when the plane has no ready delivery lease", missingLease.startError === undefined && missingLease.errors.length === 0 && missingLease.warnings.length === 1, missingLease);
  check("the missing-lease warning names the durable, space, condition, and reconnect repair", missingLeaseWarning?.message.includes(durable) === true && missingLeaseWarning.message.includes(space) && missingLeaseWarning.message.includes("no ready delivery lease") && missingLeaseWarning.message.includes("reconnect against it"), missingLeaseWarning?.message);
  check("the warned missing-lease bind delivers no message", missingLease.messages === 0, missingLease);

  const notReadyRev = await daemon.acquireDeliveryLease(0);
  const notReadyLease = await probeDlvBind();
  const notReadyWarning = notReadyLease.warnings[0];
  check("a delivery durable binds and warns when the delivery lease is not ready", notReadyLease.startError === undefined && notReadyLease.errors.length === 0 && notReadyLease.warnings.length === 1, notReadyLease);
  check("the not-ready warning names the durable, space, condition, and reconnect repair", notReadyWarning?.message.includes(durable) === true && notReadyWarning.message.includes(space) && notReadyWarning.message.includes("no ready delivery lease") && notReadyWarning.message.includes("reconnect against it"), notReadyWarning?.message);
  check("the warned not-ready bind delivers no message", notReadyLease.messages === 0, notReadyLease);
  await daemon.releaseDeliveryLease(0, notReadyRev);

  await checkStopWhileRedialing(dir, space);
  await checkPluginProjection(space, mgrCreds, aCreds, uidA,
    await mintCreds(auth, newIdentity(), "observer"), await mintCreds(auth, newIdentity(), "probe"));
  await checkEnabledPluginDelivery();

  console.log(`\nDELIVERY-RECONNECT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agent?.stop(); } catch { /* ignore */ }
  try { await observer?.stop(); } catch { /* ignore */ }
  try { await daemon?.stop(); } catch { /* ignore */ }
  try { await sup?.stop(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
