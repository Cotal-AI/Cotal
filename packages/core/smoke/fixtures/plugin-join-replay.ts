import { setTimeout as wait } from "node:timers/promises";
import { jetstreamManager } from "@nats-io/jetstream";
import { dmStream, type CotalEndpoint, type CotalMessage, type Delivery, type MessageMeta } from "../../src/index.js";
import { openChannelRegistry, writeChannelDefaults } from "../../src/channels.js";
import type { EndpointConsumers } from "../../src/endpoint-consumers.js";
import type { ConnectionState } from "../../src/endpoint-connection-state.js";
import { PLUGIN_MENTION_POINTER_KEY } from "../../src/types.js";
import { PLUGIN_FANOUT_DURABLE, pluginChannelStream, pluginChannelSubject } from "../../src/plugin-channel-route.js";
import { isConsumerNotFound } from "../../src/jetstream-missing.js";
import { startEnabledPluginSpace } from "./enabled-plugin-space.js";

type Check = (label: string, ok: boolean, detail?: unknown) => void;
type EnabledPluginSpace = Awaited<ReturnType<typeof startEnabledPluginSpace>>;
type Received = { id: string; historical: boolean };
const internals = (ep: CotalEndpoint) => ep as unknown as { consumers: EndpointConsumers; conn: ConnectionState };
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 120 && !predicate(); i++) await wait(50);
  return predicate();
};

export async function checkPluginJoinReplay(check: Check): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { channel, hiddenChannel, endpoint, mintAgent, space } = fixture;
  try {
    const sender = await mintAgent({ post: [channel, hiddenChannel] });
    const recipient = await mintAgent({ read: [channel, hiddenChannel] });
    const writer = endpoint({ creds: sender.creds, lifecycleUid: sender.lifecycleUid, consume: false,
      registerPresence: false, watchPresence: false, card: { kind: "agent", name: "join-writer" } });
    const reader = endpoint({ creds: recipient.creds, lifecycleUid: recipient.lifecycleUid, channels: [hiddenChannel],
      registerPresence: false, watchPresence: false, card: { kind: "agent", name: "join-reader" } });
    const received: Received[] = [];
    let otherLive = 0;
    reader.on("message", (msg: CotalMessage, delivery: Delivery, meta: MessageMeta) => {
      if (msg.channel === channel) received.push({ id: msg.id, historical: meta.historical });
      if (msg.channel === hiddenChannel && !meta.historical) otherLive++;
      delivery.ack();
    });
    await Promise.all([reader.start(), writer.start()]);
    const retained = await writer.multicast("before the join", { channel });
    const { consumers } = internals(reader);
    const originalSubscribe = consumers.subscribeChat.bind(consumers);
    const originalConfirm = consumers.confirmChatSub.bind(consumers);
    let during: CotalMessage | undefined;
    // Pause immediately before creating the subscription, then publish before it exists. A
    // second post is sent after broker confirmation and must be coalesced with join replay.
    consumers.subscribeChat = (name) => { if (name !== channel) originalSubscribe(name); };
    let gap: CotalMessage | undefined;
    consumers.confirmChatSub = async () => {
      gap = await writer.multicast("before the subscription is installed", { channel });
      originalSubscribe(channel);
      await originalConfirm();
      during = await writer.multicast("after the subscription is confirmed", { channel });
      await until(() => received.some(({ id }) => id === during?.id));
    };
    try {
      const joined = await reader.joinChannel(channel);
      const matches = (id?: string) => received.filter((row) => row.id === id);
      check("plugin join recovers the pre-subscribe gap and coalesces a post after confirmation", joined.joined &&
        joined.backfilled === 2 && matches(retained.id)[0]?.historical === true &&
        matches(gap?.id).length === 1 && matches(gap?.id)[0]?.historical === true &&
        matches(during?.id).length === 1 && matches(during?.id)[0]?.historical === false, received);
    } finally {
      consumers.subscribeChat = originalSubscribe;
      consumers.confirmChatSub = originalConfirm;
    }
    await reader.leaveChannel(channel);
    received.length = 0;
    const api = internals(reader).conn.js!.consumers;
    const get = api.get.bind(api);
    let shortened = false;
    api.get = async (...args) => {
      const consumer = await get(...args);
      if (args[0] !== pluginChannelStream(space)) return consumer;
      const fetch = consumer.fetch.bind(consumer);
      consumer.fetch = (opts) => {
        if (shortened || !opts || (opts.max_messages ?? 0) < 2) return fetch(opts);
        shortened = true;
        return fetch({ ...opts, max_messages: 1 });
      };
      return consumer;
    };
    try {
      const joined = await reader.joinChannel(channel);
      check("plugin join re-counts pending after a short pull and delivers the remaining rows", shortened && joined.joined &&
        joined.backfilled === 3 && received.length === 3 && received.every((row) => row.historical), received);
    } finally { api.get = get; }
    const live = await writer.multicast("live before a pressured recovery", { channel });
    const sawLive = await until(() => received.some(({ id }) => id === live.id));
    // Flood the other joined channel with a parallel stream of live receipts. Flush the writer
    // before asserting recovery, so this also checks that the burst reached the real subscription.
    const subject = pluginChannelSubject(space, sender.owner, sender.actor, hiddenChannel);
    const wire = internals(writer).conn.nc!;
    for (let i = 0; i < 8193; i++) wire.publish(subject, JSON.stringify({ ...live, channel: hiddenChannel, id: `other-channel-${i}` }));
    await wire.flush();
    const pressureObserved = await until(() => otherLive === 8193);
    await reader.reconnect();
    check("one joined channel's 8193 broker live receipts cannot evict another channel's receipt", sawLive && pressureObserved &&
      consumers.pluginReceiptSnapshot(hiddenChannel).size === 8192 && received.filter(({ id }) => id === live.id).length === 1,
      { otherLive, observed: received.filter(({ id }) => id === live.id).length });
    await checkSameSubscriptionEviction(check, fixture, sender, writer, reader, received);
  } finally { await fixture.close(); }
  await checkFailedPluginFrontierRecovery(check);
}

async function checkSameSubscriptionEviction(check: Check, fixture: EnabledPluginSpace, sender: { owner: string; actor: string },
  writer: CotalEndpoint, reader: CotalEndpoint, received: Received[]): Promise<void> {
  const { endpoint, mintAgent, space, channel } = fixture;
  // Send the burst on a different sender subject so EXT's per-subject retention cannot trim
  // the oldest test post. All posts match the same concrete subscription on the reader.
  const burstSender = await mintAgent({ post: [channel] });
  const burstWriter = endpoint({ creds: burstSender.creds, lifecycleUid: burstSender.lifecycleUid, consume: false,
    registerPresence: false, watchPresence: false, card: { kind: "agent", name: "burst-writer" } });
  await burstWriter.start();
  const wire = internals(burstWriter).conn.nc!;
  const { consumers } = internals(reader);
  const subject = pluginChannelSubject(space, sender.owner, sender.actor, channel);
  const burstSubject = pluginChannelSubject(space, burstSender.owner, burstSender.actor, channel);
  const count = (id: string) => received.filter((row) => row.id === id).length;
  const oldest = await writer.multicast("oldest receipt before the same-subscription burst", { channel });
  const sawOldest = await until(() => count(oldest.id) === 1);
  const template = await burstWriter.multicast("start the same-subscription burst", { channel });
  const sawStart = await until(() => count(template.id) === 1);
  for (let i = 0; i < 8190; i++) wire.publish(burstSubject, JSON.stringify({ ...template, id: `same-channel-${i}` }));
  await wire.flush();
  const sawBurst = await until(() => received.filter(({ id }) => id.startsWith("same-channel-")).length === 8190);
  const oldestKey = JSON.stringify([subject, oldest.id]);
  const atLimit = consumers.pluginReceiptSnapshot(channel);
  const newest = await writer.multicast("one receipt beyond the same-subscription bound", { channel });
  const sawNewest = await until(() => count(newest.id) === 1);
  const overLimit = consumers.pluginReceiptSnapshot(channel);
  const beforeRecovery = received.length;
  await reader.reconnect();
  check("the same subscription retains 8192 receipts and repeats only the evicted post on recovery", sawOldest && sawStart && sawBurst && sawNewest &&
    atLimit.size === 8192 && atLimit.has(oldestKey) && overLimit.size === 8192 && !overLimit.has(oldestKey) &&
    overLimit.has(JSON.stringify([subject, newest.id])) && count(oldest.id) === 2 && count(newest.id) === 1 &&
    received.length === beforeRecovery + 1,
    { oldest: count(oldest.id), newest: count(newest.id), atLimit: atLimit.size, overLimit: overLimit.size, sawBurst,
      repeats: received.length - beforeRecovery });
}

async function checkFailedPluginFrontierRecovery(check: Check): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { channel, endpoint, mintAgent, provisioner, space } = fixture;
  try {
    // Plugin channels use space defaults, not the legacy CHAT registry entry for the same name.
    const registry = await openChannelRegistry(internals(provisioner).conn.nc!, space);
    await writeChannelDefaults(registry, { replay: false });
    const sender = await mintAgent({ post: [channel] });
    const recipient = await mintAgent({ read: [channel] });
    const writer = endpoint({ creds: sender.creds, lifecycleUid: sender.lifecycleUid, consume: false,
      registerPresence: false, watchPresence: false, card: { kind: "agent", name: "frontier-writer" } });
    let beforeBind: (() => Promise<void>) | undefined;
    const reader = endpoint({ creds: recipient.creds, lifecycleUid: recipient.lifecycleUid, channels: [],
      registerPresence: false, watchPresence: false, card: { kind: "agent", name: "frontier-reader" },
      beforeBind: async () => { await beforeBind?.(); } });
    const received: Received[] = [];
    reader.on("message", (msg, delivery, meta) => {
      if (msg.channel === channel) received.push({ id: msg.id, historical: meta.historical });
      delivery.ack();
    });
    await Promise.all([reader.start(), writer.start()]);
    const retained = await writer.multicast("retained before joining with replay off", { channel });
    const api = internals(reader).conn.js!.consumers;
    const get = api.get.bind(api);
    const failure = new Error("fixture transient EXT frontier read failure");
    let failed = false;
    let warnings = 0;
    reader.on("warning", (error) => { if (error === failure) warnings++; });
    api.get = async (...args) => {
      const consumer = await get(...args);
      if (!failed && args[0] === pluginChannelStream(space)) {
        failed = true;
        consumer.fetch = async () => { throw failure; };
      }
      return consumer;
    };
    const joined = await reader.joinChannel(channel).finally(() => { api.get = get; });
    const live = await writer.multicast("live after joining without a frontier", { channel });
    const count = (id?: string) => received.filter((row) => row.id === id).length;
    const sawLive = await until(() => count(live.id) === 1);
    await reader.reconnect();
    const recoveredWithoutReplay = count(retained.id) === 0 && count(live.id) === 1;
    const offline: CotalMessage[] = [];
    beforeBind = async () => {
      const post = await writer.multicast("missed after a successful frontier read", { channel });
      if (count(post.id) !== 0) throw new Error("fixture post arrived before the new reader subscribed");
      offline.push(post);
    };
    await reader.reconnect();
    beforeBind = undefined;
    await reader.reconnect();
    const missed = offline[0];
    check("a failed plugin join frontier honors replay off on retry, then catches up once from the real frontier",
      joined.joined && joined.backfilled === 0 && failed && warnings === 1 && sawLive && recoveredWithoutReplay &&
      count(retained.id) === 0 && count(live.id) === 1 && offline.length === 1 && !!missed && count(missed.id) === 1 &&
      received.some(({ id, historical }) => id === missed?.id && !historical), { failed, warnings, received, missed: missed?.id });
  } finally { await fixture.close(); }
}

export async function checkPluginFirstFanout(check: Check): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { channel, endpoint, mintAgent, space } = fixture;
  try {
    const [sender, recipient] = await Promise.all([mintAgent({ post: [channel] }), mintAgent({ read: [channel] })]);
    const writer = endpoint({ creds: sender.creds, lifecycleUid: sender.lifecycleUid, consume: false,
      registerPresence: false, watchPresence: false, card: { kind: "agent", name: "early-writer" } });
    const reader = endpoint({ creds: recipient.creds, lifecycleUid: recipient.lifecycleUid, channels: [],
      registerPresence: true, watchPresence: false, card: { kind: "agent", name: "early-recipient" } });
    const pointed: unknown[] = [];
    reader.on("message", (msg: CotalMessage, delivery: Delivery) => {
      for (const part of msg.parts) {
        if (part.kind === "data" && part.data && typeof part.data === "object" && PLUGIN_MENTION_POINTER_KEY in part.data)
          pointed.push(part.data[PLUGIN_MENTION_POINTER_KEY]);
      }
      delivery.ack();
    });
    await Promise.all([reader.start(), writer.start()]);
    await internals(reader).conn.nc!.flush();
    const early = await writer.multicast("retained before the first delivery host bind", { channel, mentions: ["early-recipient"] });
    let missing = false;
    const stream = pluginChannelStream(space);
    const daemon = await fixture.startDelivery(async (ep) => {
      const jsm = await jetstreamManager(internals(ep).conn.nc!);
      missing = await jsm.consumers.info(stream, PLUGIN_FANOUT_DURABLE).then(() => false, (error) => {
        if (!isConsumerNotFound(error)) throw error;
        return true;
      });
      if (!(await until(() => ep.getRoster().some(({ card }) => card.name === "early-recipient"))))
        throw new Error("first delivery fixture could not resolve its mention target before arming");
    });
    const delivered = await until(() =>
      pointed.some((value) => !!value && typeof value === "object" && "message" in value && value.message === early.id));
    const consumer = await (await jetstreamManager(internals(daemon).conn.nc!)).consumers.info(stream, PLUGIN_FANOUT_DURABLE);
    check("first EXT fan-out bind routes a retained mention accepted before the consumer existed", missing && delivered,
      { pointed, pending: consumer.num_pending, delivered: consumer.delivered, floor: consumer.ack_floor, mode: consumer.config.deliver_policy,
        roster: daemon.getRoster().map(({ card }) => card.name), missing });
  } finally { await fixture.close(); }
}

export async function checkEnabledUnreadableAuthority(check: Check): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { channel, chatChannel, endpoint, jsm, mintAgent, space } = fixture;
  try {
    const daemon = await fixture.startDelivery();
    const next = internals(daemon).conn;
    const daemonWire = next.nc!;
    let ready = 0;
    const warnings: Error[] = [];
    daemon.on("transport", ({ connected }) => { if (connected && next.nc === daemonWire) ready++; });
    daemon.on("warning", (error) => {
      if (error.message.includes("plugin channel authority unavailable")) warnings.push(error);
    });
    const sender = await mintAgent({ post: [channel, chatChannel] });
    const target = await mintAgent({ read: [channel, chatChannel] });
    const writer = endpoint({ creds: sender.creds, lifecycleUid: sender.lifecycleUid, consume: false,
      registerPresence: false, watchPresence: false, card: { kind: "agent", name: "authority-writer" } });
    const reader = endpoint({ creds: target.creds, lifecycleUid: target.lifecycleUid, channels: [],
      watchPresence: false, card: { kind: "agent", name: "authority-target" } });
    const received = new Set<string>();
    reader.on("message", (msg, delivery) => { received.add(msg.id); delivery.ack(); });
    await Promise.all([writer.start(), reader.start()]);
    if (!(await until(() => daemon.getRoster().some(({ card }) => card.name === "authority-target"))))
      throw new Error("enabled authority fixture never saw its mention target");
    await fixture.writeAuthority({ version: 1, enabled: true, epoch: "unreadable" });
    await daemonWire.reconnect();
    const degraded = await until(() => ready === 1 || daemonWire.isClosed());
    await daemonWire.reconnect();
    const reread = await until(() => ready === 2 || daemonWire.isClosed());
    const before = (await jsm.streams.info(dmStream(space))).state.last_seq;
    const plugin = await writer.multicast("isolated body while authority is unavailable", { channel, mentions: ["authority-target"] });
    const chat = await writer.multicast("ordinary CHAT during authority failure", { channel: chatChannel, mentions: ["authority-target"] });
    check("unreadable enabled authority keeps ordinary CHAT delivery, withholds EXT notices and reports the cause once", degraded && reread &&
      ready === 2 && next.nc === daemonWire && !next.pluginChannelsEnabled && next.pluginChannelEpoch === undefined &&
      warnings.length === 1 && warnings[0].message.includes("invalid or unsupported plugin channel space state") &&
      await until(() => received.has(chat.id)) && !received.has(plugin.id) &&
      (await jsm.streams.info(dmStream(space))).state.last_seq === before, { ready, warnings, received: [...received] });
  } finally { await fixture.close(); }
}
