/**
 * Per-channel attention test (no test runner) — spins up its OWN nats-server and drives a MeshAgent
 * directly to verify quiet/muted overrides (.internal/plans/per-channel-attention.md §8):
 *   - muted: channel ambient AND @-mentions are ack-dropped at ingest (not buffered, no wake); a DM still arrives;
 *   - quiet: channel ambient is buffered (readable) but NOT wake-eligible (pendingWake excludes it); a quiet @-mention IS wake-eligible;
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
import { CotalEndpoint, isReachable, seedChannelRegistry, mintLifecycleUid } from "@cotal-ai/core";
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
  lifecycleUid: mintLifecycleUid(),
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

const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["normal-ch", "quiet-ch", "muted-ch"], lifecycleUid: mintLifecycleUid() });
pub.on("error", () => {});

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

  await pub.multicast("quiet-mention", { channel: "quiet-ch", mentions: ["otto"] });
  await sleep(350);
  check("quiet @-mention is buffered", agent.inboxCount() === 2);
  check("quiet @-mention IS wake-eligible (only the mention)", agent.pendingWake() === 1);

  // ============ normal channel: wake-eligible under open, NOT under dnd ============
  reset();
  await pub.multicast("normal-ambient", { channel: "normal-ch" });
  await sleep(350);
  check("normal ambient buffered + wake-eligible under open", agent.inboxCount() === 1 && agent.pendingWake() === 1);
  await agent.setAttention("dnd");
  check("same normal ambient is NOT wake-eligible under dnd", agent.pendingWake() === 0);
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

  // ============ prospective mute: already-buffered items are NOT purged ============
  reset();
  await pub.multicast("pre-mute", { channel: "normal-ch" });
  await sleep(350);
  check("normal ambient buffered before mute", agent.inboxCount() === 1);
  await agent.setChannelMode("normal-ch", "muted");
  check("muting does NOT purge already-buffered items (prospective)", agent.inboxCount() === 1);
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
