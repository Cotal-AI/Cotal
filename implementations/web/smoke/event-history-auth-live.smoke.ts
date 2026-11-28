/** Real static-auth observer credentials, shipped web child process and HTTP event backfill.
 * Metadata survives a denied payload read. Owner payload reads include full arguments and results.
 * Run: pnpm smoke:web-event-history-auth-live
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, DEV_OWNER, eventChannel, isReachable, mintCreds, newIdentity, PLUGIN_CHANNEL_ROOT, serverConfig, setupSpaceStreams, type CotalMessage, type MembershipSnapshot, type Part, type Presence } from "@cotal-ai/core";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startEnabledPluginSpace } from "../../../packages/core/smoke/fixtures/enabled-plugin-space.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await wait(25);
  assert.ok(check(), label);
}

type FeedEvent = { event: string; data: { feed?: string; channel?: string; msg?: CotalMessage } };
function openFeed(base: string, cookie: string) {
  const events: FeedEvent[] = [];
  let failure: unknown;
  const request = get(`${base}/feed`, { headers: { cookie } }, (response) => {
    if (response.statusCode !== 200) {
      failure = new Error(`SSE returned HTTP ${response.statusCode}`);
      response.resume();
      return;
    }
    let pending = "";
    response.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const match = /^event: ([^\n]+)\ndata: ([^\n]+)$/.exec(block);
        if (!match) continue;
        try { events.push({ event: match[1], data: JSON.parse(match[2]) as FeedEvent["data"] }); }
        catch (error) { failure = error; }
      }
    });
  });
  request.on("error", (error) => { failure = error; });
  return {
    events,
    async ready() {
      await until(() => failure !== undefined || events.some(({ event }) => event === "hello"), "SSE hello arrived");
      if (failure) throw failure;
      return events.find(({ event }) => event === "hello")!.data.feed!;
    },
    close: () => request.destroy(),
  };
}

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "eventhistoryauth";
const legacyChannel = `${PLUGIN_CHANNEL_ROOT}.linear.legacy-inbox`;
const legacyText = "ordinary chat in a space with plugin channels off";
const sharedViewNotice = "Plugin channels are not shown in this shared view.";
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let child: ReturnType<typeof spawn> | undefined;
let agent: CotalEndpoint | undefined;

async function launchDashboard(endpoint: { servers: string; space: string; credsPath: string }) {
  const webPort = await freePort();
  const base = `http://127.0.0.1:${webPort}`;
  const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)), "--space", endpoint.space, "--server", endpoint.servers, "--creds", endpoint.credsPath, "--port", String(webPort), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;
  let log = "";
  const collect = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-16_384); };
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  let launch: string | undefined;
  for (let i = 0; i < 200 && !launch && proc.exitCode === null; i++) {
    launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0];
    if (!launch) await wait(100);
  }
  assert.ok(launch, `web launch failed: ${log.replace(/\?k=[A-Za-z0-9_-]+/g, "?k=[redacted]")}`);
  const exchange = await fetch(launch, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie && exchange.status === 302, "web launch exchanged session cookie");
  return { base, cookie, log: () => log };
}

async function stopDashboard(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
}

async function checkLegacyChannel(base: string, cookie: string, messageId: string): Promise<void> {
  const read = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
  const list = await read("/api/channels");
  assert.equal(list.status, 200);
  assert.ok((await list.json() as { channel: string }[]).some(({ channel }) => channel === legacyChannel), "off-space channel list retains plugin-shaped ordinary chat");
  const history = await read(`/api/channels/${encodeURIComponent(legacyChannel)}/history`);
  assert.equal(history.status, 200);
  const historyRows = await history.json() as { id: string; parts: { kind: string; text?: string }[] }[];
  assert.ok(historyRows.some((row) => row.id === messageId && row.parts.some((part) => part.kind === "text" && part.text === legacyText)), "off-space named history retains plugin-shaped ordinary chat");
  const activity = await read("/api/activity");
  assert.equal(activity.status, 200);
  assert.ok((await activity.json() as { entries: { mode: string; channel: string; msg: { id: string } }[] }).entries.some((row) => row.mode === "chat" && row.channel === legacyChannel && row.msg.id === messageId), "off-space activity retains the chat mode and destination");
  const page = await read("/");
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(sharedViewNotice), "off-space dashboard does not show the shared-view notice");
}

interface SharedViewCase {
  channel: string;
  ordinaryChannel: string;
  readerId: string;
  pluginOnlyId: string;
  retained: CotalMessage;
  publishVerified(): Promise<CotalMessage>;
  updateAttention(mixed: boolean): Promise<number>;
  heartbeatThenPluginMode(): Promise<{ activeAt: number; ts: number }>;
  updateMembership(mixed: boolean): Promise<number>;
}

function checkSharedMembership(snapshot: MembershipSnapshot, cell: SharedViewCase): void {
  assert.ok(snapshot.asOf !== undefined, "the shared snapshot includes the broker heartbeat");
  const member = snapshot.members.find(({ id }) => id === cell.readerId);
  assert.deepEqual(member?.live, [cell.ordinaryChannel], "shared live membership retains only the ordinary channel");
  assert.deepEqual(member?.durable, [cell.ordinaryChannel], "shared durable membership retains only the ordinary channel");
  assert.ok(!JSON.stringify(snapshot).includes(cell.channel), "shared membership has no plugin channel name");
  assert.ok(!snapshot.members.some(({ id }) => id === cell.pluginOnlyId), "shared membership omits the plugin-only member instead of sending empty arrays");
}

function checkPluginOnlyPresence(roster: Presence[], cell: SharedViewCase): void {
  const peer = roster.find(({ card }) => card.id === cell.pluginOnlyId);
  assert.ok(peer && !Object.hasOwn(peer, "channelModes"), "shared roster retains the plugin-only peer without an attention map");
}

async function readSharedView(base: string, cookie: string, cell: SharedViewCase): Promise<void> {
  const read = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, path);
    return response.text();
  };
  assert.ok((await read("/")).includes(sharedViewNotice), "the authenticated page confirms the isolated shared view");
  const list = JSON.parse(await read("/api/channels")) as { channel: string }[];
  assert.ok(list.some(({ channel }) => channel === cell.ordinaryChannel) && !list.some(({ channel }) => channel === cell.channel), "shared list includes ordinary chat but not the plugin channel");
  assert.deepEqual(JSON.parse(await read(`/api/channels/${encodeURIComponent(cell.channel)}/history`)), [], "named plugin history is empty in a shared view");
  const activity = await read("/api/activity");
  assert.ok(!activity.includes(cell.channel) && !activity.includes(cell.retained.id), "activity has neither the plugin channel nor its retained post");
  checkSharedMembership(JSON.parse(await read("/api/membership")) as MembershipSnapshot, cell);
  const roster = await read("/api/roster");
  const peers = JSON.parse(roster) as Presence[];
  const reader = peers.find(({ card }) => card.id === cell.readerId);
  assert.equal(reader?.channelModes?.[cell.ordinaryChannel], "quiet", "the shared roster includes the same reader's ordinary attention setting");
  assert.ok(!roster.includes(cell.channel), "shared roster has no plugin attention channel name");
  checkPluginOnlyPresence(peers, cell);
}

function hasMessage(events: FeedEvent[], event: string, id: string, channel?: string): boolean {
  return events.some((row) => row.event === event && row.data.msg?.id === id && (channel === undefined || row.data.channel === channel));
}

async function waitForDashboardPeer(base: string, cookie: string, id: string, check: (row: Presence) => boolean): Promise<void> {
  const untilRead = Date.now() + 10_000;
  for (;;) {
    const roster = await fetch(`${base}/api/roster`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(roster.status, 200);
    if ((await roster.json() as Presence[]).some((row) => row.card.id === id && check(row))) return;
    assert.ok(Date.now() < untilRead, "dashboard receives the hidden attention write");
    await wait(25);
  }
}

async function checkMetadataUpdates(base: string, cookie: string, feeds: { events: FeedEvent[] }[], cell: SharedViewCase): Promise<void> {
  const metadata = (rows: FeedEvent[]) => rows.filter(({ event }) => ["roster", "presence-view", "membership", "membership-read-failed"].includes(event));
  const baseline = feeds.map(({ events }) => {
    const lastRoster = events.filter(({ event }) => event === "roster").at(-1)!.data as unknown as Presence[];
    return lastRoster.find(({ card }) => card.id === cell.pluginOnlyId)!.ts;
  });
  const checkpoints = () => feeds.map(({ events }) => events.length);
  const since = (starts: number[]) => feeds.map(({ events }, i) => metadata(events.slice(starts[i])));
  const attentionStart = checkpoints();
  const ts = await cell.updateAttention(false);
  // HTTP returns the live roster without SSE dedup, so the changed raw timestamp proves the web
  // observer has consumed the update before we allow its debounced broadcast to settle.
  await waitForDashboardPeer(base, cookie, cell.pluginOnlyId, (row) => row.ts >= ts);
  await wait(400);
  assert.deepEqual(since(attentionStart), [[], []], "plugin-only attention changes emit no metadata frame");

  await cell.updateAttention(true);
  await until(() => since(attentionStart).every((rows) => rows.some(({ event }) => event === "roster")), "both viewers receive the visible attention change");
  await wait(400);
  for (const [i, frames] of since(attentionStart).entries()) {
    assert.deepEqual(frames.map(({ event }) => event), ["roster"], "mixed attention change emits exactly one roster frame and no health signal");
    const roster = frames[0].data as unknown as Presence[];
    const reader = roster.find(({ card }) => card.id === cell.readerId);
    assert.deepEqual(reader?.channelModes, { [cell.ordinaryChannel]: "muted" }, "only the visible attention change is sent");
    assert.equal(roster.find(({ card }) => card.id === cell.pluginOnlyId)?.ts, baseline[i], "unchanged peer timestamp does not expose the prior hidden write");
  }

  const workingStart = checkpoints();
  const working = await cell.heartbeatThenPluginMode();
  await waitForDashboardPeer(base, cookie, cell.pluginOnlyId, (row) => row.status === "working" && row.activeAt === working.activeAt && row.ts >= working.ts);
  await wait(400);
  assert.deepEqual(since(workingStart), [[], []], "a working peer's activity heartbeat and plugin-only mode change emit no metadata frame");

  const checkMembership = async (mixed: boolean) => {
    const starts = checkpoints();
    const asOf = await cell.updateMembership(mixed);
    await until(() => since(starts).every((rows) => rows.some(({ event, data }) => event === "membership" &&
      (data as unknown as MembershipSnapshot).asOf === asOf)), "both viewers receive the independent broker heartbeat");
    await wait(400);
    for (const frames of since(starts)) {
      assert.deepEqual(frames.map(({ event }) => event), ["membership"], "membership write and heartbeat produce no extra frame");
      const members = (frames[0].data as unknown as MembershipSnapshot).members;
      const reader = members.find(({ id }) => id === cell.readerId);
      assert.deepEqual(reader?.live, [cell.ordinaryChannel]);
      assert.deepEqual(reader?.durable, mixed ? [] : [cell.ordinaryChannel]);
      assert.ok(!members.some(({ id }) => id === cell.pluginOnlyId) && !members.some(({ live, durable }) =>
        [...live, ...durable].some((name) => name.startsWith(`${PLUGIN_CHANNEL_ROOT}.`))), "membership feed omits hidden bindings");
    }
  };
  await checkMembership(false);
  await checkMembership(true);
}

async function checkViewerFeeds(base: string, cookie: string, sender: Pick<CotalEndpoint, "card" | "principal" | "multicast">, frame: Part, enabled?: SharedViewCase): Promise<void> {
  const watching = openFeed(base, cookie);
  const other = openFeed(base, cookie);
  try {
    const [first, second] = await Promise.all([watching.ready(), other.ready()]);
    assert.ok(first && second && first !== second, "each viewer has its own feed");
    const watchUrl = `${base}/api/agents/${encodeURIComponent(sender.card.id)}/watch?feed=${encodeURIComponent(first)}`;
    const watch = await fetch(watchUrl, { method: "POST", headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(watch.status, 204);
    const plugin = enabled && await enabled.publishVerified();
    const metadata = await sender.multicast("", { channel: eventChannel(sender.principal), parts: [frame] });
    // The private frame and marker share the publisher and the observing CHAT tap.
    const markerChannel = enabled?.ordinaryChannel ?? legacyChannel;
    const marker = await sender.multicast("viewer barrier", { channel: markerChannel });
    const viewers = [watching, other];
    await until(() => viewers.every(({ events }) => hasMessage(events, "message", marker.id, markerChannel)), "both viewers see the ordinary live post");
    assert.ok(hasMessage(watching.events, "agent-frame", metadata.id), "the watching viewer receives the private frame");
    assert.ok(!other.events.some(({ data }) => data.msg?.id === metadata.id) && !hasMessage(watching.events, "message", metadata.id), "the frame does not reach the other viewer or the generic feed");
    if (enabled) {
      assert.ok(plugin && plugin.channel === enabled.channel, "the fixture verifies publication on the plugin rail");
      const rosters = (events: FeedEvent[]) => events.filter(({ event }) => event === "roster").map(({ data }) => data as unknown as Presence[]);
      await until(() => viewers.every(({ events }) => events.some(({ event }) => event === "membership") &&
        rosters(events).some((roster) => roster.some(({ card }) => card.id === enabled.pluginOnlyId))), "both viewers receive broker-backed membership and populated roster snapshots");
      for (const { events } of viewers) {
        checkSharedMembership(events.find(({ event }) => event === "membership")!.data as unknown as MembershipSnapshot, enabled);
        const populated = rosters(events).filter((roster) => roster.some(({ card }) => card.id === enabled.pluginOnlyId));
        for (const roster of populated) checkPluginOnlyPresence(roster, enabled);
        assert.ok(!JSON.stringify(events).includes(enabled.channel) && !events.some(({ data }) => data.msg?.id === plugin.id), "neither shared feed names the plugin channel or receives the plugin post");
        await readSharedView(base, cookie, enabled);
      }
      await checkMetadataUpdates(base, cookie, viewers, enabled);
    }
  } finally {
    watching.close();
    other.close();
  }
}

async function checkEnabledSpace(frame: Part): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { channel, chatChannel, endpoint, mintAgent } = fixture;
  try {
    await fixture.startDelivery();
    const [readCred, writeCred, pluginOnlyCred] = await Promise.all([
      mintAgent({ read: [channel] }),
      mintAgent({ post: [channel, chatChannel, `events.${DEV_OWNER}.>`] }),
      mintAgent({ read: [channel] }),
    ]);
    const reader = endpoint({ ...readCred, card: { kind: "agent", name: "plugin-reader" }, channels: [channel], allowSubscribe: [channel] });
    const writer = endpoint({ ...writeCred, card: { kind: "agent", name: "plugin-writer" }, channels: [], consume: false, registerPresence: false });
    const pluginOnly = endpoint({ ...pluginOnlyCred, card: { kind: "agent", name: "plugin-only-reader" }, channels: [channel], allowSubscribe: [channel] });
    const delivered = new Set<string>();
    reader.on("message", (msg, delivery, meta) => {
      if (meta.kind === "channel" && msg.channel === channel && !delivery.durable && !meta.historical) delivered.add(msg.id);
      delivery.ack();
    });
    await Promise.all([reader.start(), writer.start(), pluginOnly.start()]);
    assert.ok([reader, writer].every((ep) => ep.channelRoutingMode() === "isolated"), "fixture agents admit the isolated route");
    await reader.setChannelModes({ [channel]: "quiet", [chatChannel]: "quiet" });
    await pluginOnly.setChannelModes({ [channel]: "quiet" });
    await pluginOnly.setStatus("working");
    const retained = await writer.multicast("retained plugin post", { channel });
    assert.ok((await reader.channelHistory(channel, { limit: 10 })).some(({ id }) => id === retained.id), "the scoped reader sees retained plugin history before the dashboard reads");
    assert.ok((await reader.listChannels()).some((row) => row.channel === channel), "the scoped reader can discover the plugin channel");
    await fixture.seedMembership(readCred.principal, { live: [chatChannel, channel], durable: [chatChannel, channel] });
    await fixture.seedMembership(pluginOnlyCred.principal, { live: [channel], durable: [channel] });
    const credsPath = join(dir, "shared-observer.creds");
    const observerCreds = await fixture.mintObserver();
    const observer = endpoint({ creds: observerCreds, card: { kind: "endpoint", name: "metadata-witness" }, channels: [], consume: false, registerPresence: false, watchPresence: true });
    await observer.start();
    const members = (await observer.readMembership()).members;
    const raw = members.find(({ id }) => id === reader.card.id);
    assert.ok(raw?.live.includes(channel) && raw.durable.includes(channel), "the real broker snapshot contains the plugin membership before dashboard filtering");
    const rawPluginOnly = members.find(({ id }) => id === pluginOnly.card.id);
    assert.deepEqual([rawPluginOnly?.live, rawPluginOnly?.durable], [[channel], [channel]], "the fixture seeded a plugin-only member in the real broker snapshot");
    const rawPeer = () => observer.getRoster().find(({ card }) => card.id === pluginOnly.card.id);
    await until(() => rawPeer()?.status === "working" && rawPeer()?.channelModes?.[channel] === "quiet", "the broker watch receives the working peer's plugin-only attention setting");
    assert.deepEqual(rawPeer()?.channelModes, { [channel]: "quiet" }, "the real broker roster contains the plugin-only attention map before filtering");
    writeFileSync(credsPath, observerCreds, { mode: 0o600 });
    const dashboard = await launchDashboard({ servers: fixture.servers, space: fixture.space, credsPath });
    await checkViewerFeeds(dashboard.base, dashboard.cookie, writer, frame, {
      channel,
      ordinaryChannel: chatChannel,
      readerId: reader.card.id,
      pluginOnlyId: pluginOnly.card.id,
      retained,
      async publishVerified() {
        const post = await writer.multicast("live plugin post", { channel });
        await until(() => delivered.has(post.id), "the scoped subscriber receives the new plugin post live");
        return post;
      },
      async updateAttention(mixed) {
        const agent = mixed ? reader : pluginOnly;
        const mode = mixed ? "muted" : "normal";
        await agent.setChannelModes(mixed ? { [channel]: "muted", [chatChannel]: "muted" } : {});
        const peer = () => observer.getRoster().find(({ card }) => card.id === agent.card.id);
        await until(() => !!peer() && (peer()?.channelModes?.[channel] ?? "normal") === mode, "raw broker observer witnesses the changed plugin attention setting");
        return peer()!.ts;
      },
      async heartbeatThenPluginMode() {
        const activeAt = Date.now();
        pluginOnly.noteActivity(activeAt);
        await until(() => rawPeer()?.status === "working" && rawPeer()?.activeAt === activeAt, "a broker heartbeat carries the working peer's activity before the mode change");
        assert.equal(rawPeer()?.channelModes, undefined, "the heartbeat arrives before the plugin-only mode is set");
        const heartbeatTs = rawPeer()!.ts;
        await pluginOnly.setChannelModes({ [channel]: "muted" });
        await until(() => rawPeer()?.channelModes?.[channel] === "muted" && rawPeer()!.ts > heartbeatTs, "broker witnesses the plugin-only write after the activity heartbeat");
        return { activeAt, ts: rawPeer()!.ts };
      },
      async updateMembership(mixed) {
        const id = mixed ? readCred.principal : pluginOnlyCred.principal;
        const live = mixed ? [chatChannel, fixture.hiddenChannel] : [fixture.hiddenChannel];
        const durable = [fixture.hiddenChannel];
        await fixture.seedMembership(id, { live, durable });
        const snapshot = await observer.readMembership();
        const raw = snapshot.members.find((row) => row.id === id);
        assert.deepEqual([raw?.live, raw?.durable], [live, durable], "raw broker membership records the hidden write");
        assert.ok(snapshot.asOf !== undefined);
        return snapshot.asOf;
      },
    });
  } finally {
    try { await stopDashboard(); } finally { await fixture.close(); }
  }
}

try {
  for (let i = 0; i < 80 && !await isReachable(servers); i++) await wait(100);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const identity = newIdentity();
  agent = new CotalEndpoint({ servers, space, creds: await mintCreds(auth, identity, "agent", { principal: { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "fixture" }, allowPublish: ["events.u_aaaaaaaaaaaaaaaaaaaaaaaaaa.fixture", legacyChannel], lifecycleUid: "ee11ff22aa33bb4455cc66dd77" }), card: { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "fixture", name: "fixture", kind: "agent" }, channels: [], consume: false, registerPresence: false });
  agent.on("error", (error) => console.log(`publisher: ${error.message}`));
  await agent.start();
  const channel = eventChannel(agent.principal);
  const legacy = await agent.multicast(legacyText, { channel: legacyChannel });
  const frame = { kind: "ag-ui.frame", protocol: "ag-ui/0.0.57", threadId: "T1", runId: "R1", epoch: "E1", seq: 1, events: [{ type: "TOOL_CALL_START", toolCallId: "call1", toolCallName: "fixture" }, { type: "TOOL_CALL_END", toolCallId: "call1" }] };
  const metadata = await agent.multicast("", { channel, parts: [frame as unknown as Part] });
  const payloadId = "fixture-payload";
  await agent.publishEventPayload({ id: payloadId, expectedLastSubjectSeq: 0, parts: [{ ...frame, seq: 2, events: [{ type: "TOOL_CALL_ARGS", toolCallId: "call1", delta: '{"fixture":true}' }, { type: "TOOL_CALL_RESULT", toolCallId: "call1", content: "fixture-result" }] } as unknown as Part] });
  for (const owner of ["u_aaaaaaaaaaaaaaaaaaaaaaaaaa", "u_bbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
    const observerPath = join(dir, "observer.creds");
    writeFileSync(observerPath, await mintCreds(auth, newIdentity(), "observer", { principal: { owner, actor: "observer" } }), { mode: 0o600 });
    const { base, cookie, log } = await launchDashboard({ servers, space, credsPath: observerPath });
    await checkLegacyChannel(base, cookie, legacy.id);
    const response = await fetch(`${base}/api/agents/${encodeURIComponent(agent.card.id)}/events?limit=200`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    assert.ok(!log().includes(`Subscription to "cotal.${space}.evp.`), "payload tap uses only credential-covered subjects");
    assert.equal(response.status, 200);
    const result = JSON.parse(body) as { frames?: { id: string }[]; payloadRead?: { status: string; reason: string } };
    assert.ok(result.frames?.some((item) => item.id === metadata.id), "HTTP backfill retains completed call metadata");
    if (owner === agent.principal.owner) {
      assert.ok(result.frames?.some((item) => item.id === payloadId), "HTTP backfill includes stored tool payload");
      assert.ok(body.includes("fixture-result") && body.includes("TOOL_CALL_ARGS"), "HTTP payload preserves arguments and results");
      assert.equal(result.payloadRead, undefined, "successful payload read has no failure marker");
      await checkViewerFeeds(base, cookie, agent, frame as unknown as Part);
    } else {
      assert.equal(result.payloadRead?.status, "refused", "foreign observer gets typed payload refusal");
      assert.ok(result.payloadRead.reason.length > 0 && result.payloadRead.reason.length < 300, "refusal has a bounded safe explanation");
      assert.ok(!body.includes("fixture-result") && !body.includes("TOOL_CALL_ARGS"), "foreign observer receives no payload");
    }
    await stopDashboard();
  }
  await checkEnabledSpace(frame as unknown as Part);
  console.log("COTAL_SMOKE_SENTINEL cells=36 passed=36 failed=0");
} finally {
  await agent?.stop();
  await stopDashboard();
  release();
  if (broker.exitCode === null) { const exited = new Promise((resolve) => broker.once("exit", resolve)); broker.kill("SIGTERM"); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
