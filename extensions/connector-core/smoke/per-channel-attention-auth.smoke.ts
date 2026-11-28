/**
 * Auth-mode per-channel attention e2e (no test runner) — the open `per-channel-attention.smoke.ts`
 * flow under JWT auth, the real deployment stack. Spins up its OWN JWT-auth nats-server, mints scoped
 * creds for the agent (Otto) and a peer (Pubby), and proves quiet/muted hold for an agent holding ONLY
 * the minted "agent" grants — AND that the per-channel modes + global attention round-trip through
 * presence over the wire so a *separate* peer sees them (the mesh-visibility contract):
 *   - boot seed from the agent's quiet/muted config;
 *   - muted: channel ambient AND @-mentions ack-dropped; a DM still pierces;
 *   - quiet: buffered + readable, not wake-eligible; a quiet @-mention IS wake-eligible;
 *   - precedence: quiet buffers even under global focus;
 *   - recall skips overridden channels (no muted resurface / quiet duplicate);
 *   - presence mirror: Pubby (separate creds) reads Otto's attention + channelModes over the wire;
 *   - reset on restart: a fresh agent seeds from config only.
 * Run: pnpm smoke:channel-attention:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  chatSubject,
  dmDurable,
  dmStream,
  PLUGIN_CHANNEL_ROOT,
  PLUGIN_MENTION_POINTER_KEY,
  seedChannelRegistry,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  mintLifecycleUid,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  unicastSubject,
  CONTROL_DELIVERY,
  DEV_OWNER,
  type CotalMessage,
} from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startEnabledPluginSpace } from "../../../packages/core/smoke/fixtures/enabled-plugin-space.js";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "chanattnsmoke-auth";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
let fail = 0;
// Counting convention (not assert-throw): this suite is graded by mutation-proof through
// connection-status.mutations.json's #445 entry, whose completion marker is a line the suite must
// print whether it passes or fails. A fail-fast check would exit at the first red and never reach it.
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) {
    fail++;
    process.exitCode = 1;
    console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    return;
  }
  pass++;
  console.log(`  ✓ ${name}`);
};

const channels = ["normal-ch", "quiet-ch", "muted-ch"];
const legacyChannel = `${PLUGIN_CHANNEL_ROOT}.linear.legacy`;
const legacyGrant = `${PLUGIN_CHANNEL_ROOT}.>`;
const ageChannel = "age-control";
const routingRetry = "The connection is not ready to route plugin channels. Try again once connected.";
const runTool = (seat: MeshAgent, name: string, args: Record<string, unknown> = {}) =>
  cotalToolSpecs(seat.config, "smoke").find((tool) => tool.name === name)!.run(seat, seat.config, args);
const waitFor = async (test: () => boolean) => {
  for (let i = 0; i < 75; i++) {
    if (test()) return true;
    await sleep(100);
  }
  return false;
};

async function checkPluginToolDelivery(agent: MeshAgent, chatOnly: MeshAgent, publisher: CotalEndpoint, plugin: string, chat: string, daemonId: string): Promise<void> {
  const run = runTool;

  const initial = await publisher.multicast("plugin join history", { channel: plugin });
  const pluginJoin = await run(agent, "cotal_join", { channel: plugin });
  const chatJoin = await run(agent, "cotal_join", { channel: chat });
  const chatSend = await run(agent, "cotal_send", { channel: chat, text: "ordinary tool post" });
  const pluginSend = await run(agent, "cotal_send", { text: "plugin tool post" });
  check("the same connector tools join and post on both rails without promising a plugin stored copy",
    !chatJoin.isError && !pluginJoin.isError && !chatSend.isError && !pluginSend.isError &&
    agent.joinedChannels().includes(plugin) && !agent.ep.hasDurableMembership(plugin) &&
    pluginSend.text.startsWith(`Posted to #${plugin}`) && !pluginJoin.text.includes("offline won't be replayed"),
    { chatJoin, pluginJoin, chatSend, pluginSend });
  const scopedList = await run(agent, "cotal_channels", { filter: plugin });
  const info = await run(agent, "cotal_channel_info", { channel: plugin });
  check("plugin list and info reflect the caller's join with no shared registry metadata",
    !scopedList.isError && scopedList.text.includes(`● #${plugin}`) && !scopedList.text.includes("durable backstop") &&
    !info.isError && info.text === `#${plugin}: no shared registry entry. Replay on join is on.`, { scopedList, info });

  check("joined plugin history is historical and never starts an automatic turn",
    await waitFor(() => agent.peekInbox("pull-only").some((item) => item.id === initial.id && item.historical)) &&
    !agent.peekInbox("automatic").some((item) => item.id === initial.id));
  const historical = await run(agent, "cotal_inbox", { peek: true });
  check("the existing inbox renders retained plugin posts in its history framing",
    !historical.isError && historical.text.includes("plugin join history") && historical.text.includes("(history)"));
  agent.drainInbox();

  const pluginFrontier = await agent.ep.channelFrontier(plugin);
  for (let i = 0; i < 6; i++) await publisher.multicast(`chat sequence fixture ${i}`, { channel: chat });
  const chatFrontier = await agent.ep.channelFrontier(chat);
  check("the focus cells use distinct broker offsets for chat and plugin history", chatFrontier > pluginFrontier + 1);
  await agent.setAttention("focus");
  await publisher.multicast("plugin in focus", { channel: plugin });
  await publisher.multicast("chat in focus", { channel: chat });
  const recall = await agent.recallAmbient();
  check("focus recalls the two rails from separate watermarks",
    recall.items.some((item) => item.channel === plugin && item.text === "plugin in focus") &&
    recall.items.some((item) => item.channel === chat && item.text === "chat in focus") &&
    !recall.items.some((item) => item.id === initial.id), recall);
  await agent.setAttention("open");

  const mode = await run(agent, "cotal_channel_mode", { channel: plugin, mode: "quiet" });
  const ambient = await publisher.multicast("quiet plugin ambient", { channel: plugin });
  check("quiet plugin ambient waits for a pull",
    !mode.isError && await waitFor(() => agent.peekInbox("pull-only").some((item) => item.id === ambient.id)) &&
    !agent.peekInbox("automatic").some((item) => item.id === ambient.id));

  const incoming: string[] = [];
  const pointers = new Set<string>();
  agent.on("incoming", (item: InboxItem) => incoming.push(item.id));
  agent.ep.on("message", (msg) => {
    const part = msg.parts[0];
    const pointer = part?.kind === "data" &&
      (part.data as Record<string, { message?: string }> | null)?.[PLUGIN_MENTION_POINTER_KEY];
    if (pointer && typeof pointer.message === "string") pointers.add(pointer.message);
  });
  const joinedMention = await publisher.multicast("live plugin mention also stored as a pointer", { channel: plugin, mentions: [agent.displayName] });
  check("a joined plugin mention arrives once across live delivery and the directed pointer",
    await waitFor(() => pointers.has(joinedMention.id) && incoming.includes(joinedMention.id)) &&
    agent.peekInbox("automatic").filter((item) => item.id === joinedMention.id).length === 1 &&
    incoming.filter((id) => id === joinedMention.id).length === 1);

  await agent.leaveChannel(plugin);
  const fresh = await publisher.multicast("fresh plugin mention via pointer", { channel: plugin, mentions: [agent.displayName] });
  check("an unjoined quiet plugin channel wakes only for the resolved post, not its notice",
    await waitFor(() => pointers.has(fresh.id) && agent.peekInbox("automatic").some((item) => item.id === fresh.id && item.kind === "channel" &&
      item.channel === plugin && item.mentionsMe && !item.historical)) && !agent.joinedChannels().includes(plugin) &&
    !agent.peekInbox().some((item) => item.kind === "dm" && item.fromId === daemonId));

  await agent.setChannelMode(plugin, "muted");
  await agent.setChannelMode(chat, "muted");
  const rawModes = (await chatOnly.ep.readPresence()).find((p) => p.card.id === agent.id)?.channelModes;
  const roster = await run(chatOnly, "cotal_roster");
  check("a CHAT-only peer sees ordinary mute but no plugin name in presence or the roster",
    agent.channelMode(plugin) === "muted" && rawModes?.[chat] === "muted" &&
    Object.keys(rawModes).every((name) => !name.startsWith(`${PLUGIN_CHANNEL_ROOT}.`)) &&
    !roster.isError && roster.text.includes(`locally muted #${chat}`) && !roster.text.includes(`#${PLUGIN_CHANNEL_ROOT}.`), { rawModes, roster });
  const muted = await publisher.multicast("muted plugin mention", { channel: plugin, mentions: [agent.displayName] });
  chatOnly.drainInbox();
  const outside = await publisher.multicast("plugin mention for chat-only seat", { channel: plugin, mentions: [chatOnly.displayName] });
  check("muted plugin pointers and plugin posts for an ordinary chat wildcard do not wake their recipients",
    await waitFor(() => pointers.has(muted.id)) &&
    !agent.peekInbox().some((item) => item.id === muted.id || item.id.includes(muted.id)) && chatOnly.pendingWake() === 0 &&
    !chatOnly.peekInbox().some((item) => item.id === outside.id || item.id.includes(outside.id) || item.channel === plugin));

  const listed = await run(chatOnly, "cotal_channels", { all: true });
  check("even an all-channel listing cannot discover a plugin name outside the issued credential",
    chatOnly.config.allowSubscribe.includes(plugin) && !listed.isError && !listed.text.includes(`#${plugin}`), listed);

  await agent.setChannelMode(plugin, "normal");
  await agent.joinChannel(plugin);
  agent.drainInbox();
  let duringGap: Promise<CotalMessage> | undefined;
  const publishInGap = (state: { connected: boolean }) => {
    if (state.connected || duringGap) return;
    const now = Date.now;
    Date.now = () => now() - 6 * 60_000;
    try {
      duringGap = publisher.multicast("aged plugin post during reconnect", { channel: plugin, mentions: [agent.displayName] });
    } finally {
      Date.now = now;
    }
  };
  agent.on("transport", publishInGap);
  try {
    const returned = await agent.reconnect();
    const missed = await duringGap;
    check("an aged post in a genuine transport gap catches up as plugin history without a wake",
      returned.ok && missed !== undefined &&
      await waitFor(() => agent.peekInbox("pull-only").some((item) => item.id === missed.id && item.historical)) &&
      !agent.peekInbox("automatic").some((item) => item.id === missed.id), { returned, missed });
  } finally {
    agent.off("transport", publishInGap);
  }
}

async function checkPluginToolPermissions(limited: MeshAgent, wildcard: MeshAgent, readOnly: MeshAgent, publisher: CotalEndpoint, plugin: string, chat: string) {
  const family = `${PLUGIN_CHANNEL_ROOT}.linear.>`;
  const root = `${PLUGIN_CHANNEL_ROOT}.>`;
  const rootJoin = await runTool(wildcard, "cotal_join", { channel: root });
  const familyJoin = await runTool(wildcard, "cotal_join", { channel: family });
  check("a plugin subtree grant refuses the shared root and joins its own family history-only",
    rootJoin.isError === true && rootJoin.text.includes("outside your read ACL") && !wildcard.joinedChannels().includes(root) &&
    !familyJoin.isError && familyJoin.text.includes("retained in channel history, not stored as individual copies") && wildcard.joinedChannels().includes(family),
    { rootJoin, familyJoin });

  const before = await publisher.channelFrontier(plugin);
  const absent = `${plugin}.missing`;
  for (const [tool, args, expected] of [
    ["cotal_send", { text: "no write" }, "outside your post ACL"],
    ["cotal_join", {}, "outside your read ACL"],
    ["cotal_channel_info", {}, "no shared registry entry. Replay on join is on."],
    ["cotal_channel_mode", { mode: "quiet" }, "is not within your read ACL"],
  ] as const) {
    const existing = await runTool(limited, tool, { ...args, channel: plugin });
    const missing = await runTool(limited, tool, { ...args, channel: absent });
    check(`${tool} gives a CHAT-only seat the same answer for an existing and absent plugin name`,
      existing.isError === missing.isError && Boolean(existing.isError) === (tool !== "cotal_channel_info") &&
      existing.text.includes(expected) && existing.text.replaceAll(plugin, "CHANNEL") === missing.text.replaceAll(absent, "CHANNEL"),
      { existing, missing });
  }
  const spawn = await limited.spawn("unauthorized-helper", undefined, { join: [plugin] });
  check("CHAT-only spawn cannot delegate a plugin join", !spawn.ok && spawn.error?.includes("a spawn can only hand on channels") === true, spawn);

  const send = cotalToolSpecs(readOnly.config, "smoke").find((tool) => tool.name === "cotal_send")!;
  const help = (send.schema.shape.channel as { description?: string }).description;
  const noDefault = await runTool(readOnly, "cotal_send", { text: "no default" });
  check("send help does not promise the read-only plugin as a default",
    help?.includes("If there is no default, give a channel you may post to") === true && !help.includes(`default: ${plugin}`) &&
    noDefault.isError === true && noDefault.text.includes("there is no default"), { help, noDefault });

  const mode = readOnly.ep.channelRoutingMode;
  const chatMode = limited.ep.channelRoutingMode;
  readOnly.ep.channelRoutingMode = limited.ep.channelRoutingMode = () => undefined;
  try {
    const send = await runTool(limited, "cotal_send", { channel: plugin, text: "not ready" });
    const omit = await runTool(readOnly, "cotal_send", { text: "not ready either" });
    const join = await runTool(limited, "cotal_join", { channel: plugin });
    const rootWhileUnknown = await runTool(limited, "cotal_join", { channel: root });
    const chatSend = await runTool(limited, "cotal_send", { channel: chat, text: "ordinary chat control" });
    check("unknown routing refuses plugin sends and joins at the client while ordinary CHAT sends still work",
      [send, omit, join, rootWhileUnknown].every((r) => r.isError && r.text.endsWith(routingRetry)) && !chatSend.isError &&
      await publisher.channelFrontier(plugin) === before, { send, omit, join, rootWhileUnknown, chatSend });
    const priorMode = limited.channelMode(plugin);
    const attention = await runTool(limited, "cotal_channel_mode", { channel: plugin, mode: "muted" });
    const chatAttention = await runTool(limited, "cotal_channel_mode", { channel: chat, mode: "quiet" });
    check("unknown routing refuses plugin attention without changing local state and permits CHAT attention",
      attention.isError === true && attention.text.endsWith(routingRetry) && limited.channelMode(plugin) === priorMode &&
      !chatAttention.isError && limited.channelMode(chat) === "quiet", { attention, chatAttention });
    const spawn = await limited.spawn("not-ready-helper", undefined, { join: [plugin] });
    check("unknown routing refuses spawn delegation of a plugin join with the retry sentence",
      !spawn.ok && spawn.error === `join: ${routingRetry}`, spawn);
  } finally {
    readOnly.ep.channelRoutingMode = mode;
    limited.ep.channelRoutingMode = chatMode;
  }
}

async function checkPluginPointerAdmission(seat: MeshAgent, publisher: CotalEndpoint, plugin: string, daemonId: string) {
  const mode = seat.ep.channelRoutingMode;
  const lease = seat.ep.readDeliveryLeaseEntry;
  const raw = new Set<string>();
  const events: string[] = [];
  const noRaw = () => !seat.peekInbox().some((item) => item.kind === "dm" && item.fromId === daemonId);
  seat.ep.on("message", (msg) => {
    if (msg.from.id === daemonId) raw.add(msg.id);
  });
  seat.on("incoming", (item: InboxItem) => events.push(item.id));
  const received = (post: CotalMessage) => [...raw].some((id) => id.includes(post.id));
  const surfaced = (post: CotalMessage) => seat.peekInbox("automatic").filter((item) => item.id === post.id &&
    item.kind === "channel" && item.channel === plugin && item.mentionsMe && !item.historical).length === 1;
  const publish = (text: string) => publisher.multicast(text, { channel: plugin, mentions: [seat.displayName] });

  // Hold only the connector's view of admission, not the live broker delivery or the daemon read.
  seat.ep.channelRoutingMode = () => undefined;
  try {
    const post = await publish("mention during unknown route");
    const queued = await waitFor(() => received(post)) && noRaw() && !surfaced(post);
    seat.ep.channelRoutingMode = mode;
    check("a real notice received before route admission resolves to one channel mention, never a DM",
      queued && await waitFor(() => surfaced(post)) && noRaw() && events.filter((id) => id === post.id).length === 1);
  } finally {
    seat.ep.channelRoutingMode = mode;
  }

  let failedReads = 0;
  seat.ep.readDeliveryLeaseEntry = async () => { failedReads++; throw new Error("fixture lease read temporarily unavailable"); };
  try {
    const post = await publish("mention during unreadable lease");
    const queued = await waitFor(() => received(post) && failedReads > 0) && noRaw() && !surfaced(post);
    seat.ep.readDeliveryLeaseEntry = lease;
    check("a real notice received during lease-read failure resolves once after recovery",
      queued && await waitFor(() => surfaced(post)) && noRaw() && events.filter((id) => id === post.id).length === 1);
  } finally {
    seat.ep.readDeliveryLeaseEntry = lease;
  }

  seat.ep.readDeliveryLeaseEntry = async () => { throw new Error("fixture lease read unavailable past deadline"); };
  try {
    const post = await publish("mention past admission deadline");
    const dropped = await waitFor(() => received(post) && seat.droppedPluginMentionNotices === 1);
    seat.ep.readDeliveryLeaseEntry = lease;
    const peek = await runTool(seat, "cotal_inbox", { peek: true });
    const drain = await runTool(seat, "cotal_inbox");
    const again = await runTool(seat, "cotal_inbox", { peek: true });
    const note = "Dropped plugin mention notices: 1.";
    check("a notice in isolated mode that exceeds the lease-read deadline is counted without a body and clears only on read",
      dropped && noRaw() && peek.text.includes(note) && drain.text.includes(note) && !again.text.includes(note) &&
      !peek.text.includes("mention past admission deadline") && !drain.text.includes("mention past admission deadline"));
  } finally {
    seat.ep.readDeliveryLeaseEntry = lease;
  }
}

async function checkLegacyEndpoint(config: AgentConfig, publisher: CotalEndpoint, publisherCreds: string, seatCreds: string, lifecycleUid: string) {
  const seat = new MeshAgent({ ...config, kind: "endpoint", name: "legacy-endpoint-seat", role: undefined,
    id: undefined, creds: seatCreds, lifecycleUid, subscribe: [], muted: [legacyChannel] });
  seat.on("error", () => {});
  try {
    void seat.start().catch(() => {});
    await seat.waitUntilConnected();
    const join = await runTool(seat, "cotal_join", { channel: legacyChannel });
    const send = await runTool(seat, "cotal_send", { channel: legacyChannel, text: "ordinary chat from an endpoint seat" });
    const presence = (await seat.ep.readPresence()).find((p) => p.card.id === seat.id);
    check("a scoped endpoint seat admits legacy routing and can join and send on a plugin-shaped CHAT name",
      seat.ep.channelRoutingMode() === "legacy" && !join.isError && !send.isError && presence?.card.kind === "endpoint" &&
      presence.channelModes?.[legacyChannel] === "muted", { join, send, presence });

    const parts: CotalMessage["parts"] = [{ kind: "data", data: {
      [PLUGIN_MENTION_POINTER_KEY]: { channel: legacyChannel, message: "ordinary-dm-data", seq: 1 },
    } }];
    const received = new Set<string>();
    seat.ep.on("message", (m: CotalMessage) => received.add(m.id));
    const mode = seat.ep.channelRoutingMode;
    seat.ep.channelRoutingMode = () => undefined;
    try {
      const one = await publisher.unicast(seat.id, "", { parts });
      const two = await publisher.unicast(seat.id, "", { parts });
      const waiting = await waitFor(() => received.has(one.id) && received.has(two.id)) && seat.inboxCount() === 0;
      const sender = publisher.principal;
      const nc = await connect({ servers: config.servers, authenticator: credsAuthenticator(new TextEncoder().encode(publisherCreds)), inboxPrefix: `_INBOX_${sender.actor}` });
      try {
        const recipient = seat.ep.principal;
        const subject = unicastSubject(config.space, recipient.owner, recipient.actor, sender.owner, sender.actor);
        const otherSpace = { ...one, id: "ordinary-other-space-envelope", space: "another-space" };
        await jetstream(nc).publish(subject, JSON.stringify(otherSpace), { msgID: otherSpace.id });
        check("pointer-shaped mail declaring another space does not enter this space's routing hold",
          await waitFor(() => seat.peekInbox("automatic").some((i) => i.id === otherSpace.id && i.kind === "dm")));
      } finally {
        await nc.close();
      }
      seat.ep.channelRoutingMode = mode;
      const delivered = await waitFor(() => [one.id, two.id].every((id) => seat.peekInbox("automatic").some((i) => i.id === id && i.kind === "dm")));
      const inbox = await runTool(seat, "cotal_inbox", { peek: true });
      check("two ordinary DMs with identical pointer-shaped data reach the inbox on legacy admission without a drop count",
        waiting && delivered && seat.droppedPluginMentionNotices === 0 && !inbox.text.includes("Dropped plugin mention notices:"));
    } finally {
      seat.ep.channelRoutingMode = mode;
    }
  } finally {
    await seat.stop();
  }
}

async function checkNarrowedPluginPointer(provisioner: Pick<CotalEndpoint, "commitAcl">, publisher: CotalEndpoint, seat: MeshAgent, plugin: string, chat: string): Promise<void> {
  const config = seat.config;
  const uid = config.lifecycleUid!;
  await seat.stop();
  const creds = typeof config.creds === "function" ? await config.creds() : config.creds!;
  const recipient = seat.ep.principal;
  const nc = await connect({ servers: config.servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${recipient.actor}` });
  let post: CotalMessage;
  try {
    const jsm = await jetstreamManager(nc);
    const info = () => jsm.consumers.info(dmStream(config.space), dmDurable(recipient.owner, recipient.actor, uid));
    const before = (await info()).num_pending;
    post = await publisher.multicast("plugin mention before narrowing", { channel: plugin, mentions: [seat.displayName] });
    let stored = false;
    for (let i = 0; i < 50; i++) {
      if ((await info()).num_pending > before) { stored = true; break; }
      await sleep(100);
    }
    check("the daemon queued directed mail before the recipient's grant narrowed", stored);
  } finally {
    await nc.close();
  }
  await provisioner.commitAcl(seat.id, uid, [chat]);
  const returned = new MeshAgent({ ...config, subscribe: [chat] });
  returned.on("error", () => {});
  let denied = false;
  const read = returned.ep.readPluginMentionHistory.bind(returned.ep);
  returned.ep.readPluginMentionHistory = async (pointer) => {
    try {
      return await read(pointer);
    } catch (error) {
      if (pointer.message === post.id && (error as Error).message.includes("access or delivery binding could not be verified")) denied = true;
      throw error;
    }
  };
  try {
    await returned.start();
    const control = await publisher.unicast(returned.id, "ordinary mail after denied plugin pointer");
    for (let i = 0; i < 50 && (!denied || !returned.peekInbox().some((item) => item.id === control.id)); i++) await sleep(100);
    check("live ACL narrowing blocks a queued plugin pointer and leaves ordinary mail deliverable",
      denied && returned.peekInbox("automatic").some((item) => item.id === control.id) &&
      !returned.peekInbox().some((item) => item.channel === plugin || item.id === post.id || item.id.includes(post.id)));
  } finally {
    await returned.stop();
  }
}

async function checkLatePluginPointer(fixture: Awaited<ReturnType<typeof startEnabledPluginSpace>>, daemon: Pick<CotalEndpoint, "principal" | "card" | "renewDeliveryLease" | "unicastAttributed">, revision: number, seat: MeshAgent, publisher: CotalEndpoint) {
  const { channel, space, jsm } = fixture;
  const notices = new Map<string, CotalMessage>();
  const incoming: InboxItem[] = [];
  const focusWakes: InboxItem[] = [];
  seat.ep.on("message", (m: CotalMessage) => { if (m.from.id === daemon.card.id) notices.set(m.id, m); });
  seat.on("incoming", (item: InboxItem) => incoming.push(item));
  seat.on("mention-wake", (item: InboxItem) => focusWakes.push(item));

  const stream = dmStream(space);
  const windowMs = ((await jsm.streams.info(stream)).config.duplicate_window ?? 0) / 1_000_000;
  if (windowMs < 120_000 || windowMs >= 299_000) throw new Error(`expected a DM duplicate window of two to five minutes, got ${windowMs}ms`);
  const creds = typeof seat.config.creds === "function" ? await seat.config.creds() : seat.config.creds!;
  const nc = await connect({ servers: fixture.servers, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${seat.ep.principal.actor}` });
  try {
    const scoped = await jetstreamManager(nc);
    const durable = dmDurable(seat.ep.principal.owner, seat.ep.principal.actor, seat.config.lifecycleUid!);
    const cursor = () => scoped.consumers.info(stream, durable);
    const before = (await cursor()).delivered.stream_seq;
    const post = await publisher.multicast("late daemon notice uses the original post identity", { channel, mentions: [seat.displayName] });
    const first = await waitFor(() => seat.peekInbox("automatic").some((i) => i.id === post.id && i.mentionsMe));
    const firstNotice = [...notices.values()].find((m) => m.id.includes(post.id));
    const firstSeq = (await cursor()).delivered.stream_seq;
    if (!firstNotice || firstSeq <= before) throw new Error("the first daemon notice was not delivered from the DM stream");
    const shown = seat.drainInbox().filter((i) => i.id === post.id && i.mentionsMe);

    // Advance both ordinary handled windows through the exact-drain path used by adapters that
    // commit a turn after its original buffered entries have gone. No fake plugin event is emitted.
    seat.drainInboxDeliveries(Array.from({ length: 8192 }, (_, i) => `ordinary-handled-${i}`));
    const deadline = performance.now() + windowMs + 1000;
    while (performance.now() < deadline) {
      revision = await daemon.renewDeliveryLease(0, revision);
      await sleep(Math.min(5_000, Math.ceil(deadline - performance.now())));
    }
    const second = await daemon.unicastAttributed(seat.id, "", { parts: firstNotice.parts });
    let committed = false;
    for (let i = 0; i < 50 && !committed; i++) {
      const info = await cursor();
      committed = info.ack_floor.stream_seq >= second.ack.seq;
      if (!committed) await sleep(100);
    }
    const delivered = (await cursor()).delivered.stream_seq === second.ack.seq;
    const evidence = { firstSeq, secondSeq: second.ack.seq, committed, delivered, elapsedMs: second.msg.ts - firstNotice.ts,
      windowMs, wakes: incoming.filter((i) => i.id === post.id && i.mentionsMe).length };
    console.log(`  late pointer replay: ${JSON.stringify(evidence)}`);
    check("two distinct daemon pointer records beyond the broker window yield one plugin post and mention",
      first && shown.length === 1 && notices.has(second.msg.id) && firstSeq < second.ack.seq &&
      !second.ack.duplicate && firstNotice.id !== second.msg.id && evidence.elapsedMs > windowMs && committed && delivered &&
      evidence.wakes === 1 && focusWakes.every((i) => i.id !== post.id) &&
      !seat.peekInbox().some((i) => i.id === post.id || i.id === firstNotice.id || i.id === second.msg.id), evidence);
  } finally {
    await nc.close();
  }
}

async function checkEnabledPluginChannels(): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const seats: MeshAgent[] = [];
  try {
    const { servers, space, channel: plugin, chatChannel: chat } = fixture;
    const daemon = await fixture.startDelivery();
    const startSeat = async (name: string, read: string[], post: string[], subscribe: string[], options: Partial<Pick<AgentConfig, "allowSubscribe" | "quiet" | "muted" | "kind">> = {}) => {
      const grant = await fixture.mintAgent({ read, post });
      const seat = new MeshAgent({ name, servers, space, kind: "agent", tls: false, id: grant.actor,
        creds: grant.creds, lifecycleUid: grant.lifecycleUid, subscribe, allowSubscribe: read, allowPublish: post, ...options });
      seats.push(seat);
      seat.on("error", () => {});
      await seat.start();
      return seat;
    };
    const publisher = await startSeat("plugin-publisher", [chat, plugin], [chat, plugin], []);
    const seat = await startSeat("plugin-seat", [chat, plugin], [chat, plugin], []);
    const chatOnly = await startSeat("chat-only-seat", [">"], [">"], [">"], { allowSubscribe: [">", plugin] });
    const limited = await startSeat("limited-seat", [">"], [">"], [">"]);
    const wildcard = await startSeat("wildcard-seat", [`${PLUGIN_CHANNEL_ROOT}.linear.>`], [], []);
    const readOnly = await startSeat("read-only-seat", [plugin], [">"], [plugin]);
    const pending = await startSeat("pending-seat", [plugin], [], []);
    const endpointSeat = await startSeat("plugin-endpoint-seat", [chat, plugin], [plugin], [], { kind: "endpoint", quiet: [chat, plugin] });
    const endpointModes = (await limited.ep.readPresence()).find((p) => p.card.id === endpointSeat.id)?.channelModes;
    check("an endpoint seat admits isolated routing and keeps boot plugin attention out of shared presence",
      endpointSeat.connected && endpointSeat.ep.channelRoutingMode() === "isolated" && endpointSeat.channelMode(plugin) === "quiet" &&
      endpointModes?.[chat] === "quiet" && !Object.hasOwn(endpointModes, plugin), endpointModes);
    const replay = await startSeat("pointer-replay-seat", [plugin], [], []);
    const lease = await daemon.acquireDeliveryLease(0);
    const ready = await daemon.markDeliveryLeaseReady(0, lease);
    const rosterReady = () => [seat.id, chatOnly.id, pending.id, replay.id].every((id) => daemon.getRoster().some((p) => p.card.id === id));
    for (let i = 0; i < 50 && !rosterReady(); i++) await sleep(100);
    check("the enabled daemon sees the authenticated test seats and holds their delivery lease",
      rosterReady() && await seat.ep.deliveryLeaseHolder(0) === daemon.card.id);
    await checkPluginToolDelivery(seat, chatOnly, publisher.ep, plugin, chat, daemon.card.id);
    const renewed = await daemon.renewDeliveryLease(0, ready);
    await checkPluginToolPermissions(limited, wildcard, readOnly, publisher.ep, plugin, chat);
    await checkPluginPointerAdmission(pending, publisher.ep, plugin, daemon.card.id);
    const replayRevision = await daemon.renewDeliveryLease(0, renewed);
    await checkNarrowedPluginPointer(fixture.provisioner, publisher.ep, seat, plugin, chat);
    await checkLatePluginPointer(fixture, daemon, replayRevision, replay, publisher.ep);
  } finally {
    await Promise.allSettled(seats.map((seat) => seat.stop()));
    await fixture.close();
  }
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });

  // Privileged setup: streams + presence KV, channel registry (replay ON so recall has data to skip),
  // and the two peers' bind-only durables + scoped "agent" creds.
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: mgrCreds });
  await seedChannelRegistry({ servers, space, creds: mgrCreds, file: { defaults: { replay: true }, channels: { "fx51-durable": { deliveryClass: "durable" }, "fx51fam.dur": { deliveryClass: "durable" }, "fx51star.dur": { deliveryClass: "durable" }, "fx51left.dur": { deliveryClass: "durable" }, "fx51left.sub.dur": { deliveryClass: "durable" }, [legacyChannel]: { deliveryClass: "live", description: "Legacy chat" }, [ageChannel]: { deliveryClass: "live" }, "normal-ch": { description: "Ordinary chat" } } } });
  const mgr = new CotalEndpoint({ space, servers, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();

  const ottoId = newIdentity();
  const pubbyId = newIdentity();
  // Presence/roster entries key by the PRINCIPAL dot-form (`local.<id>` = card.id under the owner+actor grammar).
  const ottoPrincipal = `${DEV_OWNER}.${ottoId.id}`;
  const ottoUid = mintLifecycleUid(); // one lifecycle uid per agent (SPEC §13.1)
  const pubbyUid = mintLifecycleUid();
  const chACL = { subscribe: channels, allowSubscribe: [...channels, legacyGrant, ageChannel, "fx51-durable", "fx51fam.>", "fx51star.*"], allowPublish: [...channels, legacyGrant, "fx51-durable", "fx51fam.dur", "fx51star.dur"] };
  const ottoCreds = await provisionAgent(mgr, auth, ottoId, { ...chACL, role: "generalist", lifecycleUid: ottoUid });
  const pubbyCreds = await provisionAgent(mgr, auth, pubbyId, { ...chACL, allowPublish: [...chACL.allowPublish, ageChannel], lifecycleUid: pubbyUid });
  // A reader provisioned WITHOUT any durable-read grant: it cannot join fx51-durable's backstop, so
  // its listChannels() row must render the cannot-establish health, never "active" or a bare
  // omission (the #445 undefined-state cell).
  const blindId = newIdentity();
  const blindUid = mintLifecycleUid();
  const blindChans = ["normal-ch"];
  const blindACL = { subscribe: blindChans, allowSubscribe: blindChans, allowPublish: blindChans };
  const blindCreds = await provisionAgent(mgr, auth, blindId, { ...blindACL, lifecycleUid: blindUid, role: "generalist" });

  const cfg: AgentConfig = {
    space,
    name: "Otto",
    role: "generalist",
    servers,
    creds: ottoCreds,
    subscribe: channels,
    allowSubscribe: [...channels, legacyGrant, ageChannel],
    allowPublish: [...channels, legacyGrant],
    quiet: ["quiet-ch"], // operator file default (not an ACL — rides the agent config)
    muted: ["muted-ch"],
    kind: "agent",
    tls: false,
    id: ottoId.id,
    lifecycleUid: ottoUid,
  };

  // ---- #445: deliveryHealth must track the daemon, never its residue ----
  // An in-process delivery endpoint serves ctl.delivery and holds the lease (the boot-retry suite's
  // shape). Otto joins the durable channel, the row reads active while the daemon serves, then the
  // daemon endpoint is stopped WITHOUT any lease release — stop() never releases the delivery lease
  // (#368), so the KV row stays behind ready:true exactly as a SIGKILLed daemon's does, and the
  // ctl.delivery responder is gone. The row must read degraded on the very next listChannels(),
  // never active, while hasDurableMembership still says true (session-local residue).
  const daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  await daemon.start();
  await daemon.startPlane3((owner, lifecycleUid) => daemon.aclForOwner(owner, lifecycleUid));
  const dcfg: AgentConfig = {
    space, name: "Otto", role: "generalist", servers, creds: ottoCreds,
    subscribe: [...channels, "fx51-durable", "fx51fam.>", "fx51star.*"], allowSubscribe: [...channels, "fx51-durable", "fx51fam.>", "fx51star.*"], allowPublish: channels,
    quiet: ["quiet-ch"], muted: ["muted-ch"], kind: "agent", tls: false, id: ottoId.id, lifecycleUid: ottoUid,
  };
  const dagent = new MeshAgent(dcfg);
  dagent.on("error", () => {});
  dagent.start();
  for (let i = 0; i < 50; i++) { if (dagent.connected) break; await sleep(200); }
  let durableUp = false;
  for (let i = 0; i < 20; i++) { if (dagent.ep.hasDurableMembership("fx51-durable")) { durableUp = true; break; } await sleep(500); }
  check("durable membership established (daemon serving)", durableUp);
  const dagentBoot = (dagent.ep as unknown as { bootMemberships: Pick<typeof dagent.ep, "fetchMemberships"> }).bootMemberships;
  const discover = dagentBoot.fetchMemberships.bind(dagentBoot);
  dagentBoot.fetchMemberships = async () => [{ channel: "fx51-durable", generation: 1, activated: true }];
  const originalServers = dcfg.servers;
  try {
    for (const hosted of [false, true]) {
      dcfg.servers = hosted ? "nats://host.example:4222" : originalServers;
      let message = "";
      try { await dagent.leaveChannel("fx51-durable"); } catch (error) { message = (error as Error).message; }
      check(hosted ? "hosted leave names the host update, not cotal up" : "local leave retains the daemon restart remedy",
        hosted ? message.includes("host must update") && !message.includes("cotal up") : message.includes("restart the daemon at this version"));
      check("refused leave preserves the joined durable channel", dagent.joinedChannels().includes("fx51-durable") && dagent.ep.hasDurableMembership("fx51-durable"));
    }
  } finally {
    dcfg.servers = originalServers;
    dagentBoot.fetchMemberships = discover;
  }
  // Otto also follows the family fx51fam.> from boot: its own membership row covers the durable
  // channel fx51fam.dur, which Otto never joins by name (#5404).
  let familyUp = false;
  for (let i = 0; i < 20; i++) { if (dagent.ep.hasDurableMembership("fx51fam.>")) { familyUp = true; break; } await sleep(500); }
  check("the family follow fx51fam.> holds a durable membership from boot", familyUp);
  // The daemon's readiness flip (lease ready:true) can lag the join responder; the active control
  // must wait for it, else it grades a still-binding daemon. In-process daemons acquire + flip the
  // lease themselves (the CLI daemon does this in runStartedDelivery).
  await daemon.acquireDeliveryLease(0).then((rev) => daemon.markDeliveryLeaseReady(0, rev)).catch(() => {});
  // listChannels enumerates retained traffic and cached channel registry rows. Seed an owned
  // retained message so the durable health assertions actually select this channel.
  await dagent.ep.multicast("owned durable health control", { channel: "fx51-durable" });
  await dagent.ep.multicast("owned family health control", { channel: "fx51fam.dur" });
  await dagent.ep.multicast("owned live pattern control", { channel: "fx51star.dur" });
  let leaseReady = false;
  for (let i = 0; i < 30; i++) { if ((await dagent.ep.readDeliveryLease(0))?.ready === true) { leaseReady = true; break; } await sleep(500); }
  check("daemon lease reads ready:true (serving)", leaseReady);
  const liveRows = await dagent.listChannels();
  check("deliveryHealth reads active while the daemon serves", liveRows.find((c) => c.channel === "fx51-durable")?.deliveryHealth === "active", liveRows.find((c) => c.channel === "fx51-durable"));
  const familyRow = liveRows.find((c) => c.channel === "fx51fam.>");
  check("the family follow is a row of its own, joined, with its membership's health active", familyRow?.follow === "family" && familyRow.joined && familyRow.deliveryHealth === "active", familyRow);
  const childRow = liveRows.find((c) => c.channel === "fx51fam.dur");
  check("a durable channel under the family reads active through the family's membership", childRow?.joined === true && childRow.deliveryHealth === "active", childRow);
  // A durable channel Otto reads only through the live pattern fx51star.* has no stored copies to
  // be healthy or not: no delivery health, never the degraded backstop warning.
  const starRow = liveRows.find((c) => c.channel === "fx51star.dur");
  check("a durable channel followed only through a pattern with * carries no delivery health", starRow?.joined === true && starRow.deliveryHealth === undefined, starRow);
  const channelsTool = cotalToolSpecs(dcfg, "smoke").find((t) => t.name === "cotal_channels")!;
  const listed = (await channelsTool.run(dagent, dcfg, {})).text;
  check("cotal_channels does not warn of a backstop on a channel followed only through a pattern with *",
    /#fx51star\.dur \(subscribed, replay on\)\n/.test(listed + "\n") && !/#fx51star\.dur[^\n]*durable backstop/.test(listed), listed);
  check("cotal_channels shows the family follow and its stored copies",
    listed.includes("● #fx51fam.> — family you follow: every channel under fx51fam, stored copies on for its durable channels"), listed);
  await daemon.stop(); // no graceful lease release — the ready:true residue stays
  const leaseAfterStop = await dagent.ep.readDeliveryLease(0);
  check("daemon stopped but its lease row still reads ready:true (residue)", leaseAfterStop?.ready === true, leaseAfterStop);
  const deadRows = await dagent.listChannels();
  const deadRow = deadRows.find((c) => c.channel === "fx51-durable");
  check("daemon gone + lease residue still ready ⇒ deliveryHealth degraded, NEVER active (#445)", deadRow?.deliveryHealth === "degraded", deadRow);
  check("…while hasDurableMembership still true (session-local residue)", dagent.ep.hasDurableMembership("fx51-durable") === true);
  const deadFamily = deadRows.find((c) => c.channel === "fx51fam.>");
  check("daemon gone ⇒ the family row reads degraded, never active", deadFamily?.deliveryHealth === "degraded", deadFamily);

  // The cannot-establish ("unknown") arm, driven through the route the fix actually has: a
  // responder-PRESENT error on fetchMemberships(). Every minted agent profile carries a read of the
  // delivery KV (provision.ts grants DLVKV to any agent), so "a reader without the delivery grant"
  // is not a shape provisionAgent can mint — the grant arm is covered by reading only. What a suite
  // CAN manufacture is a daemon that answers ctl.delivery with an error: a plain endpoint serving
  // the delivery control subject with {ok:false}, exactly as a shard-rechecking (quiesced) daemon's
  // responder does from behind its may-act fence. The agent's fetchMemberships() then throws
  // (responder present, errored) and health cannot be established.
  // First the premise probe: the blind reader's lease read does NOT throw (DLVKV rides every
  // agent profile), so its row can only read degraded/active — never the no-grant throw.
  const blind = new CotalEndpoint({ space, servers, creds: blindCreds, card: { name: "Blind", kind: "agent", id: blindId.id }, channels: [], lifecycleUid: blindUid, watchPresence: false, registerPresence: false });
  blind.on("error", () => {});
  await blind.start();
  let blindLeaseThrew = false;
  try { await blind.readDeliveryLease(0); } catch { blindLeaseThrew = true; }
  await blind.stop();
  check("every minted agent profile reads the delivery KV, so the no-grant premise is unmintable (unknown is covered by reading)", blindLeaseThrew === false, { blindLeaseThrew });

  // A daemon-shaped responder that answers every control op with an error — the wire shape a
  // shard-rechecking daemon presents from behind its may-act fence. The row must render unknown,
  // never active, degraded, or omitted. No startPlane3: the stub is the ONLY member of the
  // delivery queue group (the real daemon is stopped above), so it is guaranteed the request.
  const errdaemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery2", role: "delivery", kind: "endpoint" } });
  errdaemon.on("error", () => {});
  await errdaemon.start();
  const errSub = errdaemon.serveControl(CONTROL_DELIVERY, () => ({ ok: false, error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" }), { boundReply: true });
  // The stub's SUB is in flight when serveControl returns; a request published before the broker
  // registers it takes the no-responders outcome (undefined), not the responder-present error this
  // cell is about. Wait until the stub is the member that answers, bounded, before reading the row.
  let membershipsThrew = false;
  for (let i = 0; i < 50 && !membershipsThrew; i++) {
    try { await dagent.ep.fetchMemberships(); await sleep(100); } catch { membershipsThrew = true; }
  }
  const errRows = await dagent.listChannels();
  const errRow = errRows.find((c) => c.channel === "fx51-durable");
  check("a daemon answering errors (responder present, op refused) renders health unknown, never active/degraded/omitted (#445)",
    membershipsThrew && errRow?.deliveryHealth === "unknown", { membershipsThrew, errRow });
  const errFamily = errRows.find((c) => c.channel === "fx51fam.>");
  check("a daemon answering errors renders the family row unknown too", errFamily?.deliveryHealth === "unknown", errFamily);
  try { errSub.unsubscribe(); } catch { /* already gone */ }
  await errdaemon.stop();
  await dagent.stop();

  // ---- #5404: a sub-family held through the family above it, and a family a late refusal forces out ----
  // Fred follows fx51left.> from boot. With no daemon answering he joins fx51left.sub.>, which gets no
  // row of its own, and with a daemon back that sub-family still reads active, because fx51left.>'s
  // row stores its posts too. Then his credential renews onto one without fx51left.>: the broker
  // refuses the family's resubscription, and with the daemon answering errors its tombstone stays
  // pending, so cotal_channels shows a family he no longer follows with its cleanup pending.
  const fredId = newIdentity();
  const fredUid = mintLifecycleUid();
  const fredRead = ["normal-ch", "fx51left.>"];
  const fredWrite = ["normal-ch", "fx51left.dur", "fx51left.sub.dur"];
  await provisionAgent(mgr, auth, fredId, { subscribe: fredRead, allowSubscribe: fredRead, allowPublish: fredWrite, role: "generalist", lifecycleUid: fredUid });
  let fredNarrowed = false;
  const fredNarrow = await mintCreds(auth, fredId, "agent", { allowSubscribe: ["normal-ch"], allowPublish: fredWrite, role: "generalist", lifecycleUid: fredUid, expiresInSeconds: 600 });
  // A standing-renewal source: a fresh 40s credential each time until the switch, then the narrowed one.
  const fredCreds = async () => fredNarrowed
    ? fredNarrow
    : mintCreds(auth, fredId, "agent", { allowSubscribe: fredRead, allowPublish: fredWrite, role: "generalist", lifecycleUid: fredUid, expiresInSeconds: 40 });
  const newDaemon = async (name: string) => {
    const d = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name, role: "delivery", kind: "endpoint" } });
    d.on("error", () => {});
    await d.start();
    await d.startPlane3((owner, lifecycleUid) => d.aclForOwner(owner, lifecycleUid));
    await d.acquireDeliveryLease(0).then((rev) => d.markDeliveryLeaseReady(0, rev)).catch(() => {});
    return d;
  };
  const daemonB = await newDaemon("delivery-b");
  const fcfg: AgentConfig = {
    space, name: "Fred", role: "generalist", servers, creds: fredCreds,
    subscribe: fredRead, allowSubscribe: fredRead, allowPublish: fredWrite,
    kind: "agent", tls: false, id: fredId.id, lifecycleUid: fredUid,
  };
  const fred = new MeshAgent(fcfg);
  fred.on("error", () => {});
  fred.start();
  for (let i = 0; i < 50; i++) { if (fred.connected) break; await sleep(200); }
  let fredFamily = false;
  for (let i = 0; i < 20; i++) { if (fred.ep.hasDurableMembership("fx51left.>")) { fredFamily = true; break; } await sleep(500); }
  check("Fred's family fx51left.> holds a durable membership from boot", fredFamily);
  await daemonB.stop();
  const subJoin = await fred.joinChannel("fx51left.sub.>");
  check("with no daemon answering, the sub-family fx51left.sub.> joins live only, with no row of its own",
    subJoin.joined && !subJoin.durable && !fred.ep.hasDurableMembership("fx51left.sub.>"), subJoin);
  const daemonC = await newDaemon("delivery-c");
  let subRow: Awaited<ReturnType<MeshAgent["listChannels"]>>[number] | undefined;
  for (let i = 0; i < 20; i++) {
    subRow = (await fred.listChannels()).find((c) => c.channel === "fx51left.sub.>");
    if (subRow?.deliveryHealth === "active") break;
    await sleep(500);
  }
  check("a sub-family with no row of its own reads active through the family above it, whose row stores its posts",
    subRow?.follow === "family" && subRow.deliveryHealth === "active", subRow);
  await daemonC.stop();
  const errdaemon2 = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery-err", role: "delivery", kind: "endpoint" } });
  errdaemon2.on("error", () => {});
  await errdaemon2.start();
  const errSub2 = errdaemon2.serveControl(CONTROL_DELIVERY, () => ({ ok: false, error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" }), { boundReply: true });
  fredNarrowed = true;
  let leftPending = false;
  for (let i = 0; i < 120; i++) { if (fred.ep.pendingDurableLeaves().includes("fx51left.>")) { leftPending = true; break; } await sleep(500); }
  check("a renewal onto a credential without fx51left.> has the broker refuse it, and its tombstone stays pending while the daemon errs",
    leftPending && !fred.ep.joinedChannels().includes("fx51left.>"), { pending: fred.ep.pendingDurableLeaves(), joined: fred.ep.joinedChannels() });
  const leftRow = (await fred.listChannels()).find((c) => c.channel === "fx51left.>");
  check("the family left with its cleanup pending is still a family row, not followed", leftRow?.follow === "family" && leftRow.joined === false && leftRow.durableUnclosed === true, leftRow);
  const fredChannels = cotalToolSpecs(fcfg, "smoke").find((t) => t.name === "cotal_channels")!;
  const fredListed = (await fredChannels.run(fred, fcfg, {})).text;
  check("cotal_channels shows a family no longer followed with its cleanup pending",
    fredListed.includes("○ #fx51left.> — family you no longer follow · durable cleanup pending (§7 backstop may still deliver — retrying)"), fredListed);
  try { errSub2.unsubscribe(); } catch { /* already gone */ }
  await fred.stop();
  await errdaemon2.stop();

  // ---- boot seed from config (before connecting) ----
  const agent = new MeshAgent(cfg);
  agent.on("error", () => {});
  check("boot seeds quiet/muted from config under auth", agent.channelMode("quiet-ch") === "quiet" && agent.channelMode("muted-ch") === "muted");

  const incoming: InboxItem[] = [];
  const mentionWake: InboxItem[] = [];
  agent.on("incoming", (i: InboxItem) => incoming.push(i));
  agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));

  const pub = new CotalEndpoint({ space, servers, creds: pubbyCreds, card: { name: "Pubby", kind: "agent", id: pubbyId.id }, channels, lifecycleUid: pubbyUid });
  pub.on("error", () => {});

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected (scoped creds)", agent.connected === true);
  await sleep(300);

  // ---- file-default modes are visible in presence at BOOT over the auth wire, before any toggle ----
  const bootSeen = pub.getRoster().find((p) => p.card.id === ottoPrincipal);
  check("file-default channelModes visible in presence at boot under auth (no toggle yet)",
    bootSeen?.channelModes?.["quiet-ch"] === "quiet" && bootSeen?.channelModes?.["muted-ch"] === "muted");

  // ---- muted: ack-dropped (incl. @mention); DM pierces ----
  await pub.multicast("muted-ambient", { channel: "muted-ch" });
  await pub.multicast("muted-mention", { channel: "muted-ch", mentions: ["otto"] });
  await sleep(450);
  check("muted ambient + @-mention NOT buffered (over the wire, auth)", agent.inboxCount() === 0 && mentionWake.length === 0 && incoming.length === 0);
  await pub.unicast(agent.id, "dm-1");
  await sleep(400);
  check("a DM still pierces (kind=dm)", agent.inboxCount() === 1 && incoming.at(-1)?.kind === "dm");

  // ---- quiet: buffered, not wake-eligible; mention IS ----
  agent.drainInbox();
  incoming.length = 0;
  await pub.multicast("quiet-ambient", { channel: "quiet-ch" });
  await sleep(400);
  check("quiet ambient buffered but NOT wake-eligible", agent.inboxCount() === 1 && agent.pendingWake() === 0);
  await pub.multicast("quiet-mention", { channel: "quiet-ch", mentions: ["otto"] });
  await sleep(400);
  check("quiet @-mention is wake-eligible", agent.inboxCount() === 2 && agent.pendingWake() === 1);

  // ---- precedence: quiet buffers even under global focus; normal/muted drop ----
  agent.drainInbox();
  incoming.length = 0;
  await agent.setAttention("focus");
  await pub.multicast("quiet-focus", { channel: "quiet-ch" });
  await pub.multicast("normal-focus", { channel: "normal-ch" });
  await pub.multicast("muted-focus", { channel: "muted-ch" });
  await sleep(450);
  check("quiet overrides focus (buffered); normal+muted drop", agent.inboxCount() === 1 && incoming.at(-1)?.text === "quiet-focus");

  // ---- recall skips overridden channels (no resurface / duplicate) ----
  const recall = await agent.recallAmbient();
  const rtexts = recall.items.map((i) => i.text);
  check("recall surfaces NORMAL focus-dropped ambient", rtexts.includes("normal-focus"));
  check("recall SKIPS muted + quiet channels", !rtexts.includes("muted-focus") && !rtexts.includes("quiet-focus"));
  await agent.setAttention("open");

  // ---- presence mirror over the wire: a SEPARATE peer sees attention + channelModes ----
  await agent.setAttention("dnd");
  await agent.setChannelMode("normal-ch", "muted"); // runtime override on top of file defaults
  await sleep(500);
  const seen = pub.getRoster().find((p) => p.card.id === ottoPrincipal);
  check("peer reads Otto's global attention from presence (auth wire)", seen?.attention === "dnd");
  check("peer reads Otto's channelModes from presence (auth wire)",
    seen?.channelModes?.["normal-ch"] === "muted" && seen?.channelModes?.["quiet-ch"] === "quiet" && seen?.channelModes?.["muted-ch"] === "muted");
  await agent.setChannelMode("normal-ch", "normal");
  await sleep(400);
  check("clearing a mode removes the key for the peer", pub.getRoster().find((p) => p.card.id === ottoPrincipal)?.channelModes?.["normal-ch"] === undefined);

  // ---- reset on restart ----
  const fresh = new MeshAgent(cfg);
  check("restart drops runtime override, keeps file defaults",
    fresh.channelMode("normal-ch") === undefined && fresh.channelMode("quiet-ch") === "quiet" && fresh.channelMode("muted-ch") === "muted");

  await agent.setAttention("open");
  agent.drainInbox();
  const tools = cotalToolSpecs(cfg, "smoke");
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const send = tool("cotal_send");
  const normalSent = await send.run(agent, cfg, { text: "ordinary default" });
  const legacySent = await send.run(agent, cfg, { channel: legacyChannel, text: "legacy explicit" });
  check("off-space sends retain their ordinary chat receipts for plain and plugin-shaped names",
    normalSent.text === "Posted to #normal-ch. Agents on it see it; mention one to make it act." &&
    legacySent.text === `Posted to #${legacyChannel}. Agents on it see it; mention one to make it act.`, { normalSent, legacySent });
  check("plugin-shaped name in an off space keeps its ordinary CHAT history",
    (await pub.channelHistoryPage(legacyChannel, { limit: 1 })).items.some((m) => m.parts[0]?.kind === "text" && m.parts[0].text === "legacy explicit"));
  const list = await tool("cotal_channels").run(agent, cfg, {});
  const info = await tool("cotal_channel_info").run(agent, cfg, { channel: legacyChannel });
  check("off-space list and info retain plugin-shaped names from the ordinary registry",
    list.text.includes(`#${legacyChannel}`) && info.text.includes("operator's note — purpose: Legacy chat"), { list, info });
  const joined = await tool("cotal_join").run(agent, cfg, { channel: legacyChannel });
  const refused = await send.run(agent, cfg, { channel: ageChannel, text: "must not post" });
  check("off-space plugin-shaped join is live and a valid outside-post-ACL name still refuses",
    !joined.isError && joined.text.startsWith(`Joined #${legacyChannel} (live).`) &&
    refused.isError === true && refused.text.startsWith(`Can't post to #${ageChannel}: it's outside your post ACL`), { joined, refused });
  const ordinaryDm = await pub.unicast(agent.id, "ordinary DM", { parts: [
    { kind: "data", data: { [PLUGIN_MENTION_POINTER_KEY]: { channel: legacyChannel, message: "not-a-pointer", seq: 1 } } },
  ] });
  for (let i = 0; i < 30 && !agent.peekInbox().some((m) => m.id === ordinaryDm.id); i++) await sleep(100);
  check("off-space direct mail containing pointer-shaped data keeps ordinary DM framing",
    agent.peekInbox("automatic").some((m) => m.id === ordinaryDm.id && m.kind === "dm" && !m.historical));
  agent.drainInbox();

  const legacyEndpointId = newIdentity();
  const legacyEndpointUid = mintLifecycleUid();
  const legacyEndpointCreds = await provisionAgent(mgr, auth, legacyEndpointId, { ...chACL, lifecycleUid: legacyEndpointUid });
  await checkLegacyEndpoint(cfg, agent.ep, ottoCreds, legacyEndpointCreds, legacyEndpointUid);

  const ageDaemon = await newDaemon("delivery-age");
  try {
    const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(pubbyCreds)), inboxPrefix: `_INBOX_${pubbyId.id}` });
    try {
      const now = Date.now();
      for (const [id, ts] of [["fresh-stored-mention", now], ["old-stored-mention", now - 6 * 60_000]] as const) {
        const msg: CotalMessage = { id, ts, space, from: pub.card, channel: ageChannel, mentions: ["otto"], parts: [{ kind: "text", text: id }] };
        await jetstream(nc).publish(chatSubject(space, DEV_OWNER, pubbyId.id, ageChannel), JSON.stringify(msg), { msgID: id });
      }
      for (let i = 0; i < 50 && !agent.peekInbox().some((m) => m.id === "old-stored-mention"); i++) await sleep(100);
      check("fresh stored mention wakes and an older-than-five-minute copy is historical and pull-only",
        !agent.joinedChannels().includes(ageChannel) &&
        agent.peekInbox("automatic").some((m) => m.id === "fresh-stored-mention" && !m.historical) &&
        agent.peekInbox("pull-only").some((m) => m.id === "old-stored-mention" && m.historical) &&
        !agent.peekInbox("automatic").some((m) => m.id === "old-stored-mention"));
    } finally {
      await nc.close();
    }
  } finally {
    await ageDaemon.stop();
  }

  await agent.stop();
  await pub.stop();
  await mgr.stop();
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
await checkEnabledPluginChannels();
const EXPECTED_CELLS = 80;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
console.log(`SUITE COMPLETE: ${ran} cells`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
