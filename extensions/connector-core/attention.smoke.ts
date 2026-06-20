/**
 * Attention-mode test (no test runner) — spins up its OWN nats-server and drives a MeshAgent
 * directly to verify the `focus` ingest ack-drop + replay-gated recall (.internal/plans/attention-modes.md §9):
 *   - ambient on a replay channel: ack-dropped at ingest (not buffered, no "incoming");
 *   - a channel @-mention: wakes ("mention-wake") but is NOT buffered;
 *   - a DM: buffered (kind="dm") + "incoming";
 *   - recallAmbient: replays the ack-dropped ambient + mention from the replay=on channel as
 *     historical, and returns NOTHING from a replay=off channel (the gate).
 * Run: pnpm smoke:attention
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { MeshAgent } from "./src/agent.js";
import type { AgentConfig } from "./src/config.js";
import type { InboxItem } from "./src/agent.js";

const PORT = 14237;
const servers = `nats://127.0.0.1:${PORT}`;
const space = "attnsmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "cotal-attn-"));
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
  subscribe: ["open-ch", "quiet-ch"], // open-ch: replay=on; quiet-ch: replay=off
  allowSubscribe: ["open-ch", "quiet-ch"],
  allowPublish: ["open-ch", "quiet-ch"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
const incoming: InboxItem[] = [];
const mentionWake: InboxItem[] = [];
agent.on("incoming", (i: InboxItem) => incoming.push(i));
agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));

// A plain endpoint that publishes ambient/mentions/DMs at the agent.
const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: ["open-ch", "quiet-ch"] });
pub.on("error", () => {});

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // One channel replays (recall surfaces it), one does not (recall must gate it out).
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { "open-ch": { replay: true }, "quiet-ch": { replay: false } } } });

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);
  await sleep(300);

  await agent.setAttention("focus");
  check("attention is focus", agent.attention === "focus");

  // ---- ambient on a replay channel: ack-dropped, never buffered ----
  await pub.multicast("ambient-1", { channel: "open-ch" });
  await sleep(400);
  check("focus ack-drops ambient (not buffered)", agent.inboxCount() === 0);
  check("focus ambient fires no 'incoming'", incoming.length === 0);

  // ---- a channel @-mention: wakes but is NOT buffered ----
  await pub.multicast("mention-1", { channel: "open-ch", mentions: ["otto"] });
  await sleep(400);
  check("focus @-mention wakes ('mention-wake')", mentionWake.length === 1 && mentionWake[0].text === "mention-1");
  check("focus @-mention is not buffered", agent.inboxCount() === 0);
  check("focus @-mention fires no 'incoming'", incoming.length === 0);

  // ---- a DM: buffered (kind=dm) + 'incoming' ----
  await pub.unicast(agent.id, "dm-1");
  await sleep(400);
  check("focus buffers a DM", agent.inboxCount() === 1 && agent.directedPendingCount() === 1);
  check("focus DM fires 'incoming' with kind=dm", incoming.length === 1 && incoming[0].kind === "dm" && incoming[0].text === "dm-1");

  // ---- prove the replay gate: ambient on a replay=off channel ----
  await pub.multicast("quiet-1", { channel: "quiet-ch" });
  await sleep(400);
  check("focus ack-drops ambient on replay=off channel too", agent.inboxCount() === 1); // still just the DM

  // ---- recallAmbient: replay-gated catch-up since entering focus ----
  const r = await agent.recallAmbient();
  const texts = r.items.map((i) => i.text);
  check("recall returns ambient + mention from the replay=on channel", texts.includes("ambient-1") && texts.includes("mention-1"));
  check("recalled items are historical", r.items.every((i) => i.historical));
  check("recall GATES OUT the replay=off channel", !texts.includes("quiet-1"));

  console.log(`\nATTENTION TESTS PASSED ✅  (${pass} checks)`);
  await agent.stop();
  await pub.stop();
} finally {
  srv.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
