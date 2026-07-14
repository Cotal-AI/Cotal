/**
 * Per-channel attention test (no test runner) — spins up its OWN nats-server and drives a MeshAgent
 * directly to verify quiet/muted overrides (.internal/plans/per-channel-attention.md §8):
 *   - muted: channel ambient AND @-mentions are ack-dropped at ingest (not buffered, no wake); a DM still arrives;
 *   - quiet: channel ambient is buffered pull-only and never automatic; a quiet @-mention stays automatic;
 *   - precedence: quiet BUFFERS even under global focus (override wins); normal/muted still drop under focus;
 *   - boot seed: config.quiet/muted seed the map; reset on restart (a runtime setChannelMode is gone in a fresh agent);
 *   - presence mirror: setChannelMode/setAttention publish channelModes/attention to peers.
 * Run: pnpm smoke:channel-attention
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  chatSubject,
  isReachable,
  parsePrincipalKey,
  seedChannelRegistry,
  type CotalMessage,
} from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const servers = `nats://127.0.0.1:${PORT}`;
const space = "chanattnsmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), "cotal-chanattn-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space,
  name: "Otto",
  role: "generalist",
  servers,
  subscribe: ["normal-ch", "quiet-ch", "muted-ch"],
  allowSubscribe: ["normal-ch", "quiet-ch", "muted-ch"],
  allowPublish: ["normal-ch", "quiet-ch", "muted-ch"],
  quiet: ["quiet-ch"], // operator file default
  muted: ["muted-ch"], // operator file default
  kind: "agent",
  tls: false,
  id: "otto_agent",
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
let incoming: InboxItem[] = [];
let mentionWake: InboxItem[] = [];
agent.on("incoming", (i: InboxItem) => incoming.push(i));
agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));
const reset = () => {
  agent.drainInbox();
  incoming = [];
  mentionWake = [];
};

const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["normal-ch", "quiet-ch", "muted-ch"] });
pub.on("error", () => {});

const rawChat = async (id: string, subjectChannel: string, payloadChannel: string): Promise<void> => {
  const principal = parsePrincipalKey(pub.card.id);
  if (!principal) throw new Error(`publisher has no principal: ${pub.card.id}`);
  const msg: CotalMessage = {
    id,
    ts: Date.now(),
    space,
    from: pub.card,
    channel: payloadChannel,
    parts: [{ kind: "text", text: id }],
  };
  const js = (pub as unknown as {
    js: { publish(subject: string, data: string, opts: { msgID: string }): Promise<unknown> };
  }).js;
  await js.publish(chatSubject(space, principal.owner, principal.actor, subjectChannel), JSON.stringify(msg), { msgID: id });
};

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // Replay ON for all three so focus-recall has data to (correctly) skip for overridden channels.
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: true }, channels: {} } });

  // ---- boot seed: config.quiet/muted populate the map before any connection ----
  check("boot seeds quiet from file default", agent.channelMode("quiet-ch") === "quiet");
  check("boot seeds muted from file default", agent.channelMode("muted-ch") === "muted");
  check("normal channel has no override", agent.channelMode("normal-ch") === undefined);

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);
  await sleep(300);

  // ---- file-default modes are visible in presence at BOOT, before any runtime toggle ----
  const bootSeen = pub.getRoster().find((p) => p.card.id === agent.id);
  check("file-default channelModes visible in presence at boot (no toggle yet)",
    bootSeen?.channelModes?.["quiet-ch"] === "quiet" && bootSeen?.channelModes?.["muted-ch"] === "muted");

  // ============ muted: ack-dropped at ingest (incl. @mention); DM still arrives ============
  reset();
  await pub.multicast("muted-ambient", { channel: "muted-ch" });
  await sleep(350);
  check("muted ambient is NOT buffered", agent.inboxCount() === 0);
  check("muted ambient fires no 'incoming'", incoming.length === 0);

  await pub.multicast("muted-mention", { channel: "muted-ch", mentions: ["otto"] });
  await sleep(350);
  check("muted @-mention is NOT buffered", agent.inboxCount() === 0);
  check("muted @-mention does NOT wake (no mention-wake)", mentionWake.length === 0);
  check("muted @-mention fires no 'incoming'", incoming.length === 0);

  await pub.unicast(agent.id, "muted-dm");
  await sleep(350);
  check("a DM still pierces (buffered, kind=dm)", agent.inboxCount() === 1 && incoming.at(-1)?.kind === "dm");

  // ============ quiet: buffered + readable, but ambient is NOT wake-eligible; mention IS ============
  reset();
  await pub.multicast("quiet-ambient", { channel: "quiet-ch" });
  await sleep(350);
  check("quiet ambient IS buffered (readable)", agent.inboxCount() === 1 && incoming.length === 1);
  check("quiet ambient is NOT wake-eligible (pendingWake)", agent.pendingWake() === 0);
  check("quiet ambient is excluded from automatic delivery", agent.peekInbox("automatic").length === 0 && agent.peekInbox("pull-only")[0]?.text === "quiet-ambient");

  await pub.multicast("quiet-mention", { channel: "quiet-ch", mentions: ["otto"] });
  await sleep(350);
  check("quiet @-mention is buffered", agent.inboxCount() === 2);
  check("quiet @-mention IS wake-eligible (only the mention)", agent.pendingWake() === 1);
  check("quiet @-mention remains automatic", agent.peekInbox("automatic")[0]?.text === "quiet-mention");

  reset();
  await rawChat("quiet-subject-wins", "quiet-ch", "normal-ch");
  await sleep(350);
  check(
    "subject-authenticated quiet channel overrides a mismatched payload label",
    agent.peekInbox("pull-only")[0]?.channel === "quiet-ch" && agent.peekInbox("automatic").length === 0,
  );
  reset();
  await rawChat("muted-subject-wins", "muted-ch", "normal-ch");
  await sleep(350);
  check("subject-authenticated muted channel cannot be bypassed by a payload label", agent.inboxCount() === 0);

  // ============ normal channel: wake-eligible under open, NOT under dnd ============
  reset();
  await pub.multicast("normal-ambient", { channel: "normal-ch" });
  await sleep(350);
  check("normal ambient buffered + wake-eligible under open", agent.inboxCount() === 1 && agent.pendingWake() === 1);
  await agent.setAttention("dnd");
  check("same normal ambient is NOT wake-eligible under dnd", agent.pendingWake() === 0);
  await agent.setAttention("open");

  // Quiet can sit physically ahead of normal dnd ambient and a DM without joining or blocking
  // their automatic FIFO lane. Under dnd, only the DM is wake-eligible.
  reset();
  await agent.setAttention("dnd");
  await pub.multicast("dnd-quiet", { channel: "quiet-ch" });
  await pub.multicast("dnd-normal", { channel: "normal-ch" });
  await pub.unicast(agent.id, "dnd-dm");
  await sleep(450);
  check("[quiet, dnd ambient, DM] keeps quiet out of the automatic lane", agent.peekInbox("automatic").map((i) => i.text).join() === "dnd-normal,dnd-dm");
  check("[quiet, dnd ambient, DM] preserves quiet in the pull lane", agent.peekInbox("pull-only").map((i) => i.text).join() === "dnd-quiet");
  check("automatic-lane count excludes the older quiet item", agent.inboxCount("automatic") === 2);
  check("under dnd only the DM wakes, while normal ambient can still ride that turn", agent.pendingWake() === 1);
  await agent.setAttention("open");

  // ============ precedence: quiet buffers even under global focus; normal/muted drop ============
  reset();
  await agent.setAttention("focus");
  await pub.multicast("quiet-under-focus", { channel: "quiet-ch" });
  await sleep(350);
  check("quiet OVERRIDES focus → still buffered", agent.inboxCount() === 1 && incoming.at(-1)?.text === "quiet-under-focus");
  await pub.multicast("normal-under-focus", { channel: "normal-ch" });
  await sleep(350);
  check("normal ambient is ack-dropped under global focus", agent.inboxCount() === 1);
  await pub.multicast("muted-under-focus", { channel: "muted-ch" });
  await sleep(350);
  check("muted still dropped under focus", agent.inboxCount() === 1);
  await agent.setAttention("open");

  // ============ focus recall skips overridden channels (no resurface, no duplicate) ============
  reset();
  await agent.setAttention("focus"); // fresh focusSince watermark
  await pub.multicast("recall-normal", { channel: "normal-ch" }); // ack-dropped under focus → recallable
  await pub.multicast("recall-muted", { channel: "muted-ch" }); // dropped (muted) → must NOT recall
  await pub.multicast("recall-quiet", { channel: "quiet-ch" }); // buffered (quiet overrides focus) → must NOT duplicate
  await sleep(450);
  const recall = await agent.recallAmbient();
  const rtexts = recall.items.map((i) => i.text);
  check("recall surfaces a NORMAL channel's focus-dropped ambient", rtexts.includes("recall-normal"));
  check("recall SKIPS muted channel (no resurface)", !rtexts.includes("recall-muted"));
  check("recall SKIPS quiet channel (already buffered live, no duplicate)", !rtexts.includes("recall-quiet"));
  await agent.setAttention("open");

  // ============ receive-time snapshot: mode toggles never reclassify buffered items ============
  reset();
  await pub.multicast("pre-mute", { channel: "normal-ch" });
  await sleep(350);
  check("normal ambient buffered before mute", agent.inboxCount() === 1);
  await agent.setChannelMode("normal-ch", "muted");
  check("muting does NOT purge already-buffered items (prospective)", agent.inboxCount() === 1);
  await agent.setChannelMode("normal-ch", "normal");

  reset();
  await pub.multicast("normal-before-quiet", { channel: "normal-ch" });
  await sleep(350);
  await agent.setChannelMode("normal-ch", "quiet");
  check("normal→quiet does not suppress an already-automatic item", agent.peekInbox("automatic")[0]?.text === "normal-before-quiet" && agent.pendingWake() === 1);
  agent.drainInbox();
  await pub.multicast("quiet-before-normal", { channel: "normal-ch" });
  await sleep(350);
  await agent.setChannelMode("normal-ch", "normal");
  check("quiet→normal does not release an old pull-only item", agent.peekInbox("automatic").length === 0 && agent.peekInbox("pull-only")[0]?.text === "quiet-before-normal" && agent.pendingWake() === 0);

  // ============ focus recall follows receive-time channel mode across toggles ============
  reset();
  await agent.setAttention("focus");
  await pub.multicast("focus-normal-before-quiet", { channel: "normal-ch" });
  await sleep(200);
  await agent.setChannelMode("normal-ch", "quiet");
  await pub.multicast("focus-quiet-after-toggle", { channel: "normal-ch" });
  await sleep(300);
  const pulledQuiet = agent.drainInbox(undefined, "pull-only");
  const recallAfterQuiet = await agent.recallAmbient();
  check("normal→quiet focus pull keeps the quiet item destructive and recalls the earlier normal item", pulledQuiet.some((i) => i.text === "focus-quiet-after-toggle") && recallAfterQuiet.items.some((i) => i.text === "focus-normal-before-quiet"));
  check("normal→quiet focus recall does not duplicate the buffered quiet item", !recallAfterQuiet.items.some((i) => i.text === "focus-quiet-after-toggle"));
  await agent.setAttention("open");
  await agent.setChannelMode("normal-ch", "normal");

  reset();
  await agent.setChannelMode("normal-ch", "quiet");
  await agent.setAttention("focus");
  await pub.multicast("focus-quiet-before-normal", { channel: "normal-ch" });
  await sleep(200);
  await agent.setChannelMode("normal-ch", "normal");
  await pub.multicast("focus-normal-after-toggle", { channel: "normal-ch" });
  await sleep(300);
  const recallAfterNormal = await agent.recallAmbient();
  check("quiet→normal focus recall includes later normal traffic", recallAfterNormal.items.some((i) => i.text === "focus-normal-after-toggle"));
  check("quiet→normal focus recall excludes the earlier buffered quiet item", !recallAfterNormal.items.some((i) => i.text === "focus-quiet-before-normal"));
  await agent.setAttention("open");
  await agent.setChannelMode("normal-ch", "normal");

  // ============ presence mirror: peers see attention + channelModes (advisory) ============
  await agent.setAttention("dnd");
  await agent.setChannelMode("normal-ch", "muted"); // runtime override on top of file defaults
  await sleep(400);
  const peer = pub.getRoster().find((p) => p.card.id === agent.id);
  check("peer sees global attention in presence", peer?.attention === "dnd");
  check("peer sees runtime + file channelModes in presence",
    peer?.channelModes?.["normal-ch"] === "muted" &&
    peer?.channelModes?.["quiet-ch"] === "quiet" &&
    peer?.channelModes?.["muted-ch"] === "muted");

  // clearing a mode with "normal" removes it from the published map
  await agent.setChannelMode("normal-ch", "normal");
  await sleep(300);
  const peer2 = pub.getRoster().find((p) => p.card.id === agent.id);
  check("clearing to normal drops the key", peer2?.channelModes?.["normal-ch"] === undefined);

  // ============ reset on restart: a fresh agent seeds from the file only ============
  const fresh = new MeshAgent(cfg);
  check("restart drops the runtime override", fresh.channelMode("normal-ch") === undefined);
  check("restart keeps the file default", fresh.channelMode("quiet-ch") === "quiet" && fresh.channelMode("muted-ch") === "muted");

  // ============ offline scrub: a graceful leave clears attention + channelModes for peers ============
  await agent.setAttention("dnd");
  await sleep(150);
  await agent.stop(); // graceful → publishes offline
  await sleep(450);
  const off = pub.getRoster().find((p) => p.card.id === agent.id);
  check("offline peer is scrubbed of attention + channelModes (no stale hints)",
    off?.status === "offline" && off?.attention === undefined && off?.channelModes === undefined);

  console.log(`\nPER-CHANNEL ATTENTION TESTS PASSED ✅  (${pass} checks)`);
  await pub.stop();
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
