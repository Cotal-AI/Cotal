/** Live exclusion-cap regression: mention wake must retain a pull body when recall skips its channel. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid, seedChannelRegistry } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent, type InboxItem } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";

const servers = `nats://127.0.0.1:${await pickFreePort()}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", servers.split(":").at(-1)!, "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const channels = ["team.a", "team.b", "team.healthy"];
const cfg: AgentConfig = { space: "focusexclusion", name: "Otto", role: "generalist", servers, subscribe: channels, allowSubscribe: channels, allowPublish: channels, kind: "agent", tls: false, id: "otto_agent", lifecycleUid: mintLifecycleUid() };
const agent = new MeshAgent(cfg);
const pub = new CotalEndpoint({ space: cfg.space, servers, card: { name: "publisher", kind: "agent", id: "publisher" }, channels, lifecycleUid: mintLifecycleUid() });
const inspector = new CotalEndpoint({ space: cfg.space, servers, card: { name: "inspector", kind: "agent", id: "inspector" }, channels: ["team.b"], lifecycleUid: mintLifecycleUid() });
agent.on("error", () => {});
inspector.on("error", () => {});
pub.on("error", () => {});
const wakes: InboxItem[] = [];
agent.on("mention-wake", (item: InboxItem) => wakes.push(item));
const inbox = cotalToolSpecs(cfg).find(s => s.name === "cotal_inbox")!;
let passed = 0;
function check(name: string, condition: boolean): void { assert.ok(condition, name); passed++; console.log(`  ✓ ${name}`); }
async function until(name: string, condition: () => boolean): Promise<void> { const end = Date.now() + 15000; while (!condition()) { if (Date.now() > end) throw new Error(name); await new Promise(r => setTimeout(r, 25)); } }
async function barrier(): Promise<void> { const msg = await pub.unicast(agent.id, "barrier"); await until("delivery barrier", () => agent.peekInbox().some(i => i.id === msg.id)); agent.drainInbox(undefined, "automatic"); }
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space: cfg.space, file: { defaults: { replay: true }, channels: {} } });
  await pub.start(); agent.start(); await agent.waitUntilConnected();
  await agent.setAttention("focus");
  await pub.multicast("bounded-positive", { channel: "team.b", mentions: ["otto"] });
  await until("positive wake", () => wakes.some(i => i.text === "bounded-positive"));
  check("bounded focus mention stays recall-only", !agent.peekInbox().some(i => i.text === "bounded-positive"));
  const positive = await inbox.run(agent, cfg, { scope: "pull-only" });
  check("bounded positive body is returned without warning", positive.text.includes("bounded-positive") && !positive.text.includes("Some earlier chatter"));
  await agent.setChannelMode("team.b", "quiet");
  await agent.setChannelMode("team.a", "quiet");
  await pub.multicast("excluded-B", { channel: "team.b" });
  for (let i = 0; i < 4095; i++) await pub.multicast(`old-A-${i}`, { channel: "team.a" });
  await barrier();
  check("4096 exclusions do not yet make B unsafe", !(await agent.recallAmbient()).droppedChannels.includes("team.b"));
  await pub.multicast("overflow-A", { channel: "team.a" });
  await barrier();
  const unsafe = await agent.recallAmbient();
  check("next exclusion marks B unsafe from actual traffic", unsafe.droppedChannels.includes("team.b"));
  check("exclusion exhaustion is distinct from hard-drop exhaustion", !agent.channelDeliveryIssue && agent.connectionState === "ready");
  // Quiet channels need the same pull-only fallback instead of their usual automatic mention lane.
  const quiet = await pub.multicast("unsafe-quiet-mention", { channel: "team.b", mentions: ["otto"] });
  await until("quiet mention wake", () => wakes.some(i => i.id === quiet.id));
  check("unsafe quiet mention is pull-only, never automatic", agent.peekInbox("pull-only").some(i => i.id === quiet.id) && !agent.peekInbox("automatic").some(i => i.id === quiet.id));
  await agent.setChannelMode("team.b", "normal");
  const live = await pub.multicast("unsafe-normal-mention", { channel: "team.b", mentions: ["otto"] });
  await until("normal mention wake", () => wakes.some(i => i.id === live.id));
  check("unsafe normal mention wakes once and retains a pull body", wakes.filter(i => i.id === live.id).length === 1 && agent.peekInbox("pull-only").some(i => i.id === live.id));
  check("normal fallback cannot auto-inject", !agent.peekInbox("automatic").some(i => i.id === live.id));
  await inspector.start();
  const retained = await inspector.recallChannel("team.b", 0);
  check("fresh body independently remains retained", retained.messages.some(m => m.id === live.id) && !retained.dropped && !retained.unanswered);
  await pub.multicast("unsafe-normal-ambient", { channel: "team.b" });
  await barrier();
  check("normal ambient keeps ack-drop handling", !agent.peekInbox().some(i => i.text === "unsafe-normal-ambient") && !(await agent.recallAmbient()).items.some(i => i.text === "unsafe-normal-ambient"));
  let duplicateAck = false;
  agent.ep.emit("message", live, { durable: true, ack: () => { duplicateAck = true; }, nak: () => {} }, { historical: false, kind: "channel" });
  check("pending duplicate coalesces without second wake", agent.peekInbox().filter(i => i.id === live.id).length === 1 && wakes.filter(i => i.id === live.id).length === 1);
  const replies: string[] = [];
  for (let i = 0; i < 5; i++) replies.push((await inbox.run(agent, cfg, { scope: "pull-only" })).text);
  check("public inbox returns both mention bodies once", replies.filter(t => t.includes("unsafe-normal-mention")).length === 1 && replies.filter(t => t.includes("unsafe-quiet-mention")).length === 1);
  check("warning still names unsafe channel", replies.every(t => t.includes("Some earlier chatter could not be recalled completely") && t.includes("#team.b")));
  check("pull acknowledges pending durable copy", duplicateAck && !agent.peekInbox().some(i => i.id === live.id));
  agent.ep.emit("message", live, { durable: true, ack: () => {}, nak: () => {} }, { historical: false, kind: "channel" });
  check("handled copy cannot surface or wake twice", !agent.peekInbox().some(i => i.id === live.id) && wakes.filter(i => i.id === live.id).length === 1);
  await agent.setChannelMode("team.b", "muted");
  await pub.multicast("unsafe-muted-mention", { channel: "team.b", mentions: ["otto"] });
  await barrier();
  check("unsafe muted mention stays suppressed", !agent.peekInbox().some(i => i.text === "unsafe-muted-mention") && !wakes.some(i => i.text === "unsafe-muted-mention"));
  await agent.setChannelMode("team.b", "normal");
  // Controlled historical metadata verifies that history cannot enter the new live fallback.
  const historical = { ...live, id: "historical-control", parts: [{ type: "text" as const, text: "unsafe-historical-mention" }] };
  agent.ep.emit("message", historical, { durable: false, ack: () => {}, nak: () => {} }, { historical: true, kind: "channel" });
  check("historical mention does not wake or become automatic", !wakes.some(i => i.id === historical.id) && !agent.peekInbox("automatic").some(i => i.id === historical.id));
  await pub.multicast("healthy-mention", { channel: "team.healthy", mentions: ["otto"] });
  await until("healthy wake", () => wakes.some(i => i.text === "healthy-mention"));
  check("unaffected channel keeps recall-only mention handling", !agent.peekInbox().some(i => i.text === "healthy-mention") && (await agent.recallAmbient()).items.some(i => i.text === "healthy-mention"));
  await agent.setAttention("open"); await agent.setAttention("focus");
  const next = await inbox.run(agent, cfg, { scope: "pull-only" });
  check("new focus epoch does not repeat previously returned mention", !next.text.includes("unsafe-normal-mention") && !next.text.includes("unsafe-quiet-mention"));
  console.log(`FOCUS EXCLUSION MENTION PASSED (${passed} checks)`);
} finally {
  await agent.stop(); await pub.stop(); await inspector.stop(); broker.kill("SIGTERM");
  await new Promise<void>(resolve => { if (broker.exitCode !== null || broker.signalCode !== null) resolve(); else broker.once("exit", () => resolve()); });
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}
