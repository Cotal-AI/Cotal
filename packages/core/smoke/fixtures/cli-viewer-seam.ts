import { setTimeout as wait } from "node:timers/promises";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import {
  channelBucket, chatStream, chatWildcard, credsFromJwt, newIdentity, unicastSubject, type CotalEndpoint, type CotalMessage,
} from "../../src/index.js";
import { PLUGIN_CHANNEL_ROOT, pluginChannelSubject } from "../../src/plugin-channel-route.js";
import { startEnabledPluginSpace } from "./enabled-plugin-space.js";

type Fixture = Awaited<ReturnType<typeof startEnabledPluginSpace>>;
type Check = (name: string, condition: boolean, detail?: unknown) => void;

async function until(condition: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return true;
    await wait(50);
  }
  return false;
}

async function viewerCreds(fixture: Fixture, subjects: string[]): Promise<string> {
  const { space, auth } = fixture;
  const id = newIdentity();
  // The stock observer deliberately has neither DM nor EXT tap grants. Use a read-only fixture
  // credential to exercise all three rails and leave reserved CHAT suppression to the endpoint.
  const jwt = await encodeUser("cli-viewer-smoke", fromPublic(id.id), fromPublic(auth.account.pub), {
    pub: { allow: ["$JS.API.INFO", `$JS.API.STREAM.INFO.${chatStream(space)}`, `$JS.API.STREAM.MSG.GET.KV_${channelBucket(space)}`] },
    sub: { allow: [`_INBOX_${id.id}.>`, ...subjects] },
  }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) });
  return credsFromJwt(jwt, id);
}

function openViewer(fixture: Fixture, creds: string, name: string, subjects: { chat: string; dm: string; plugin: string }) {
  const opened: NatsConnection[] = [];
  const bound: NatsConnection[] = [];
  const transportReady: NatsConnection[] = [];
  const pluginTaps = new Map<NatsConnection, Subscription>();
  const seen = new Set<string>();
  const ep = fixture.endpoint({ creds, consume: false, channels: [], registerPresence: false, watchPresence: false,
    watchChannels: false, readChannelRoutingProjection: true, card: { kind: "endpoint", name },
    onConnection(wire) {
      opened.push(wire);
      // Observe the actual NATS subscription, so a silent handler alone cannot pass retirement.
      const subscribe = wire.subscribe.bind(wire);
      wire.subscribe = (...args) => {
        const sub = subscribe(...args);
        if (args[0] === subjects.plugin) pluginTaps.set(wire, sub);
        return sub;
      };
    },
  });
  ep.on("connection", ({ connected }) => { if (connected) bound.push(opened.at(-1)!); });
  ep.on("transport", ({ connected }) => { if (connected) transportReady.push(opened.at(-1)!); });
  const receive = (_subject: string, msg: CotalMessage | undefined) => { if (msg) seen.add(msg.id); };
  for (const subject of Object.values(subjects)) ep.tap(receive, { subject });
  return { ep, opened, bound, transportReady, pluginTaps, seen };
}

async function checkStrictConsumer(check: Check, fixture: Fixture, identity: Awaited<ReturnType<Fixture["mintAgent"]>>) {
  let wire: NatsConnection | undefined;
  let ready = false;
  const agent = fixture.endpoint({ creds: identity.creds, lifecycleUid: identity.lifecycleUid,
    channels: [fixture.chatChannel], consume: true, readChannelRoutingProjection: true,
    registerPresence: false, watchPresence: false, watchChannels: false, card: { kind: "agent", name: "strict-consumer" },
    onConnection: (nc) => { wire = nc; } });
  agent.on("connection", ({ connected }) => { if (connected) ready = true; });
  const outcome = await agent.start().then(() => undefined, (error: unknown) => error);
  check("consuming agent rejects the malformed projection after dial without binding",
    outcome instanceof Error && outcome.message === "invalid plugin channel route projection fields" &&
    !ready && wire?.isClosed() === true, outcome);
}

async function checkDegradedFeed(check: Check, fixture: Fixture, viewer: ReturnType<typeof openViewer>,
  writer: CotalEndpoint, legacyWriter: CotalEndpoint, recipient: string, phase: string) {
  const reserved = await legacyWriter.multicast(`reserved CHAT ${phase}`, { channel: fixture.hiddenChannel });
  const extension = await writer.multicast(`EXT ${phase}`, { channel: fixture.channel });
  const chat = await writer.multicast(`ordinary CHAT ${phase}`, { channel: fixture.chatChannel });
  const dm = await writer.unicast(recipient, `DM ${phase}`);
  check(`${phase}: viewer gets ordinary CHAT and DM over the broker`,
    await until(() => viewer.seen.has(chat.id) && viewer.seen.has(dm.id)));
  // The ordinary CHAT post follows reserved CHAT on the same wildcard subscription, so it
  // witnesses that the broker has delivered through the point at which reserved CHAT was sent.
  const rows = await viewer.ep.listChannels();
  check(`${phase}: unknown routing suppresses reserved listings and taps, not ordinary CHAT`,
    viewer.ep.channelRoutingMode() === undefined && !viewer.seen.has(reserved.id) && !viewer.seen.has(extension.id) &&
    rows.some(({ channel, messages }) => channel === fixture.chatChannel && messages > 0) &&
    rows.every(({ channel }) => channel !== PLUGIN_CHANNEL_ROOT && !channel.startsWith(`${PLUGIN_CHANNEL_ROOT}.`)), rows);
  const history = await viewer.ep.channelHistory(fixture.hiddenChannel, { limit: 1 }).then(() => undefined, (error: unknown) => error);
  check(`${phase}: reserved channel history refuses on the unknown route`,
    history instanceof Error && history.message === "plugin channel routing projection is unavailable", history);
}

async function checkDegradedRecall(check: Check, fixture: Fixture, legacyWriter: CotalEndpoint) {
  const { hiddenChannel, chatChannel, space } = fixture;
  await fixture.enableLegacyReplay();
  const stale = await legacyWriter.multicast("retained and replayable on legacy CHAT", { channel: hiddenChannel });
  const legacy = await fixture.mintAgent({ read: [hiddenChannel, chatChannel], legacy: true });
  const opts = { creds: legacy.creds, lifecycleUid: legacy.lifecycleUid, consume: false, channels: [],
    registerPresence: false, readOnce: true, card: { kind: "endpoint" as const, name: "recall-viewer" } };
  const control = fixture.endpoint(opts);
  const chatRequests: string[] = [];
  const stream = chatStream(space);
  const viewer = fixture.endpoint({ ...opts, readChannelRoutingProjection: true, onConnection(wire) {
    const request = wire.request;
    wire.request = (...args) => {
      if (args[0].startsWith("$JS.API.") && args[0].split(".").includes(stream)) chatRequests.push(args[0]);
      return request.apply(wire, args);
    };
  } });
  await control.start();
  await control.channelHistoryPage(hiddenChannel, { limit: 1 });
  const legacyRows = await control.recallChannel(hiddenChannel, 0);
  await control.stop();

  await viewer.start();
  const policy = await viewer.channelReplayPolicy(hiddenChannel);
  await viewer.channelHistoryPage(chatChannel, { limit: 1 }); // Initialize the JetStream manager on the viewer.
  const ordinary = await viewer.recallChannel(chatChannel, 0);
  const observedChatRead = chatRequests.length > 0;
  chatRequests.length = 0;
  const refusal = await viewer.recallChannel(hiddenChannel, 0).then(() => undefined, (error: unknown) => error);
  check("degraded viewer refuses recall of a replayable reserved name without reading CHAT",
    policy.registered && policy.replay && legacyRows.messages.some(({ id }) => id === stale.id) && ordinary.messages.length > 0 && !ordinary.unanswered &&
    observedChatRead && viewer.channelRoutingMode() === undefined && chatRequests.length === 0 &&
    refusal instanceof Error && refusal.message === "plugin channel routing projection is unavailable",
    { policy, legacy: legacyRows.messages.length, ordinary: ordinary.messages.length, observedChatRead, chatRequests, refusal });
}

async function checkDegradedPublish(check: Check, fixture: Fixture) {
  const legacy = await fixture.mintAgent({ post: [fixture.hiddenChannel, fixture.chatChannel], legacy: true });
  let wire: NatsConnection | undefined;
  const viewer = fixture.endpoint({ creds: legacy.creds, consume: false, channels: [], registerPresence: false,
    watchPresence: false, watchChannels: false, readChannelRoutingProjection: true,
    card: { kind: "endpoint", name: "degraded-legacy-publisher" }, onConnection(nc) { wire = nc; } });
  await viewer.start();
  const info = () => fixture.jsm.streams.info(chatStream(fixture.space));
  const before = (await info()).state.last_seq;
  const errorMessage = (error: unknown) => (error as Error).message;
  const expected = "plugin channel routing projection is unavailable";
  const simple = await viewer.multicast("must not enter legacy CHAT", { channel: fixture.hiddenChannel })
    .then(() => undefined, errorMessage);
  const append = { channel: fixture.hiddenChannel, id: "degraded-viewer-append", expectedLastSubjectSeq: 0,
    parts: [{ kind: "text" as const, text: "must not append to legacy CHAT" }] };
  const serial = await viewer.multicastExpecting(append).then(() => undefined, errorMessage);
  const sizing = await Promise.resolve().then(() => viewer.encodedSize(append)).then(() => undefined, errorMessage);
  await wire!.flush();
  check("degraded viewer with a legacy write grant refuses both reserved publish paths and sizing before any CHAT write",
    viewer.channelRoutingMode() === undefined && simple === expected && serial === expected && sizing === expected &&
    (await info()).state.last_seq === before, { simple, serial, sizing, before });
  // The same credential remains usable for an ordinary post on this connection.
  const ordinary = await viewer.multicast("ordinary CHAT publish while degraded", { channel: fixture.chatChannel });
  check("degraded viewer can still publish ordinary CHAT with the existing grant", Boolean(ordinary.id) && (await info()).state.last_seq === before + 1);
}

export async function checkCliViewerSeam(check: Check): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { space, chatChannel, channel, hiddenChannel, endpoint, mintAgent } = fixture;
  try {
    const sender = await mintAgent({ post: [chatChannel, channel] });
    const recipient = await mintAgent({ read: [chatChannel] });
    const legacy = await mintAgent({ post: [hiddenChannel], legacy: true });
    const publisher = (creds: string, name: string, kind: "agent" | "endpoint") => endpoint({ creds, channels: [],
      consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name, kind } });
    const writer = publisher(sender.creds, "viewer-writer", "agent");
    // Model a still-connected pre-activation publisher with a real legacy CHAT write grant.
    const legacyWriter = publisher(legacy.creds, "legacy-viewer-writer", "endpoint");
    const subjects = { chat: chatWildcard(space), dm: unicastSubject(space, recipient.owner, recipient.actor, "*", "*"),
      plugin: pluginChannelSubject(space, "*", "*", channel) };
    const creds = await viewerCreds(fixture, Object.values(subjects));
    const viewer = openViewer(fixture, creds, "admitted-cli-viewer", subjects);
    await Promise.all([writer.start(), legacyWriter.start(), viewer.ep.start()]);
    const old = viewer.bound[0]!;
    await old.flush();
    const chat = await writer.multicast("ordinary CHAT before corruption", { channel: chatChannel });
    const dm = await writer.unicast(recipient.principal, "DM before corruption");
    const extension = await writer.multicast("EXT before corruption", { channel });
    const admitted = await until(() => [chat, dm, extension].every(({ id }) => viewer.seen.has(id)));
    check("admitted viewer lists its EXT grant and taps ordinary CHAT, DM and EXT before corruption",
      admitted && viewer.ep.channelRoutingMode() === "isolated" &&
      (await viewer.ep.listChannels()).some((row) => row.channel === channel));

    await fixture.writeProjection({ enabled: true, epoch: "invalid" });
    await old.reconnect();
    const replaced = await until(() => viewer.bound.length === 2 && old.isClosed());
    const replacement = viewer.bound[1];
    check("admitted viewer's failed native projection read forces a full bind and retires its old EXT tap",
      replaced && replacement !== old && viewer.opened.length === 2 && viewer.transportReady.filter((wire) => wire === old).length === 1 &&
      viewer.pluginTaps.get(old)?.isClosed() === true && viewer.pluginTaps.size === 1 && viewer.ep.channelRoutingMode() === undefined);
    if (replaced && replacement) {
      await replacement.flush();
      await checkDegradedFeed(check, fixture, viewer, writer, legacyWriter, recipient.principal, "replacement viewer");
    }

    await checkStrictConsumer(check, fixture, recipient);
    const fresh = openViewer(fixture, creds, "fresh-cli-viewer", subjects);
    await fresh.ep.start();
    const freshWire = fresh.bound[0]!;
    await freshWire.flush();
    check("fresh viewer binds around the malformed projection without arming an EXT tap",
      !freshWire.isClosed() && fresh.pluginTaps.size === 0 && fresh.ep.channelRoutingMode() === undefined);
    await checkDegradedFeed(check, fixture, fresh, writer, legacyWriter, recipient.principal, "fresh viewer");
    await checkDegradedRecall(check, fixture, legacyWriter);
    await checkDegradedPublish(check, fixture);
    const cid = freshWire.info!.client_id;
    await fixture.writeProjection({ enabled: true, epoch: 1 });
    const restored = await until(() => fresh.ep.channelRoutingMode() === "isolated" && fresh.pluginTaps.has(freshWire));
    if (restored) await freshWire.flush();
    const after = await writer.multicast("EXT after projection recovers", { channel });
    check("restored projection re-arms the withheld EXT tap without a reconnect or transport readiness event", restored &&
      fresh.opened.length === 1 && fresh.bound.length === 1 && fresh.transportReady.length === 1 && !freshWire.isClosed() &&
      freshWire.info?.client_id === cid && fresh.pluginTaps.size === 1 && await until(() => fresh.seen.has(after.id)));
  } finally {
    await fixture.close();
  }
}
