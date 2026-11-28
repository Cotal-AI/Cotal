import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitBrokerReady, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, chatStream, chatSubject, isReachable, listSpaces, PLUGIN_CHANNEL_ROOT, readPluginChannelSpaceAuthority, setupSpaceStreams } from "../../src/index.js";
import { pluginChannelStream } from "../../src/plugin-channel-route.js";
import { pickFreePort } from "../_free-port.js";
import { startEnabledPluginSpace } from "./enabled-plugin-space.js";

type Check = (label: string, ok: boolean, detail?: unknown) => void;

export async function checkScopedSpaces(check: Check): Promise<void> {
  const f = await startEnabledPluginSpace();
  try {
    const signed = await f.mintAgent({ read: [f.channel, f.chatChannel], post: [f.chatChannel] });
    const writerGrant = await f.mintAgent({ post: [f.hiddenChannel] });
    const legacyGrant = await f.mintAgent({ post: [f.hiddenChannel], legacy: true });
    const chatViewer = await f.mintObserver();
    const writer = f.endpoint({ creds: writerGrant.creds, lifecycleUid: writerGrant.lifecycleUid, channels: [], consume: false,
      registerPresence: false, watchPresence: false, card: { name: "other-plugin", kind: "agent" } });
    const visible = f.endpoint({ creds: signed.creds, lifecycleUid: signed.lifecycleUid, channels: [], consume: false,
      registerPresence: false, watchPresence: false, card: { name: "scoped-view", kind: "agent" } });
    const legacy = f.endpoint({ creds: legacyGrant.creds, channels: [], consume: false,
      registerPresence: false, watchPresence: false, card: { name: "legacy-overview-writer", kind: "endpoint" } });
    await Promise.all([writer.start(), visible.start(), legacy.start()]);
    await visible.multicast("one ordinary CHAT row", { channel: f.chatChannel });
    await writer.multicast("one inaccessible retained EXT row", { channel: f.hiddenChannel });
    await legacy.multicast("one stale reserved CHAT row", { channel: f.hiddenChannel });
    const legacySubject = chatSubject(f.space, legacyGrant.owner, legacyGrant.actor, f.hiddenChannel);
    const rawChat = await f.jsm.streams.info(chatStream(f.space), { subjects_filter: ">" });
    const rawExt = await f.jsm.streams.info(pluginChannelStream(f.space));
    const opts = { servers: f.servers };
    const exact = await listSpaces({ ...opts, creds: signed.creds });
    const chat = await listSpaces({ ...opts, creds: chatViewer });
    const want = (channels: number) => [{ space: f.space, agents: 0, channels, messages: 1 }];
    check("scoped enabled spaces counts explicit plugin grants but excludes retained reserved CHAT and EXT messages",
      rawChat.state.messages === 2 && rawChat.state.subjects?.[legacySubject] === 1 && rawExt.state.messages === 1 &&
      JSON.stringify(exact) === JSON.stringify(want(2)) && JSON.stringify(chat) === JSON.stringify(want(1)),
      { exact, chat, rawChat: rawChat.state, extMessages: rawExt.state.messages });
    const mutable = { ...opts, creds: chatViewer };
    const pinned = listSpaces(mutable);
    mutable.creds = signed.creds;
    const pinnedRows = await pinned;
    check("spaces ignores a local credential change after starting its broker bind",
      JSON.stringify(pinnedRows) === JSON.stringify(want(1)), pinnedRows);
    const authority = await readPluginChannelSpaceAuthority(f.jsm, f.space);
    check("core index exports the signer-side live reader, which reads an enabled epoch", authority.state.enabled && authority.state.epoch === 1 && authority.revision > 0, authority);
    await f.writeProjection({ enabled: false, epoch: 2 });
    const refused = await listSpaces({ ...opts, creds: signed.creds }).then(() => "allowed", (error: unknown) => String(error));
    check("off space with a scoped credential keeps the legacy stream-list refusal", /Permissions Violation.*\$JS\.API\.STREAM\.NAMES/.test(refused), refused);
  } finally { await f.close(); }
}

export async function checkOpenSpaces(check: Check): Promise<void> {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const space = "space-overview-open";
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", dir], { stdio: "ignore" });
  const release = teardownOnSignal(broker, dir);
  const writer = new CotalEndpoint({ servers, space, channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { name: "open-overview", kind: "agent" } });
  try {
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
    await setupSpaceStreams({ servers, space });
    await writer.start();
    await writer.multicast("ordinary on open CHAT", { channel: "overview" });
    await writer.multicast("reserved-shaped on open CHAT", { channel: `${PLUGIN_CHANNEL_ROOT}.fixture.legacy` });
    const rows = await listSpaces({ servers });
    check("open space counts ordinary and reserved-shaped CHAT as legacy and keeps the four-field shape",
      JSON.stringify(rows) === JSON.stringify([{ space, agents: 0, channels: 2, messages: 2 }]), rows);
  } finally {
    try { await writer.stop(); }
    finally { await killAndAwaitExit(broker); release(); }
  }
}
