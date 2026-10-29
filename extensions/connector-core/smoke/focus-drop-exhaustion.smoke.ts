/** Live regression for focus mention delivery after the bounded hard-drop guard fills. */
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
const channels = ["team.a", "team.b", "team.c", "team.d", "team.e", "team.f", "team.last", "team.muted"];
const cfg: AgentConfig = { space: "focusdrop", name: "Otto", role: "generalist", servers, subscribe: channels, allowSubscribe: channels, allowPublish: channels, muted: ["team.muted"], kind: "agent", tls: false, id: "otto_agent", lifecycleUid: mintLifecycleUid() };
const agent = new MeshAgent(cfg);
const pub = new CotalEndpoint({ space: cfg.space, servers, card: { name: "publisher", kind: "agent", id: "publisher" }, channels, lifecycleUid: mintLifecycleUid() });
agent.on("error", () => {});
pub.on("error", () => {});
const wakes: InboxItem[] = [];
agent.on("mention-wake", (item: InboxItem) => wakes.push(item));
const specs = cotalToolSpecs(cfg);
const inbox = specs.find(s => s.name === "cotal_inbox")!;
const status = specs.find(s => s.name === "cotal_connection_status")!;
let passed = 0;
function check(name: string, condition: boolean): void { assert.ok(condition, name); passed++; console.log(`  ✓ ${name}`); }
async function until(name: string, condition: () => boolean): Promise<void> { const end = Date.now() + 15000; while (!condition()) { if (Date.now() > end) throw new Error(name); await new Promise(r => setTimeout(r, 25)); } }
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space: cfg.space, file: { defaults: { replay: true }, channels: {} } });
  await pub.start();
  agent.start();
  await agent.waitUntilConnected();
  check("healthy status has no channel degradation", !JSON.parse((await status.run(agent, cfg, {})).text).channelDeliveryIssue);
  await agent.setAttention("focus");
  // Retain a known muted decision before exhaustion so a later mode toggle cannot revive it.
  const muted = await pub.multicast("known-muted-mention", { channel: "team.muted", mentions: ["otto"] });
  for (const channel of channels.slice(0, 6)) for (let i = 0; i < 900; i++) await pub.multicast(`backlog-${channel}-${i}`, { channel });
  await until("drop tracking exhaustion", () => agent.channelDeliveryIssue !== undefined);
  check("exhaustion is derived from real live traffic", agent.connectionState === "degraded");
  const warning = await inbox.run(agent, cfg, { scope: "pull-only" });
  check("inbox reports exhausted drop tracking", warning.text.includes("Channel drop tracking exhausted"));
  const snapshot = JSON.parse((await status.run(agent, cfg, {})).text);
  check("connection status names degradation on a live transport", snapshot.state === "degraded" && snapshot.connected && snapshot.transportConnected && snapshot.channelDeliveryIssue.includes("drop tracking exhausted"));
  await pub.multicast("post-exhaustion-ambient", { channel: "team.last" });
  await pub.multicast("post-exhaustion-mention", { channel: "team.last", mentions: ["otto"] });
  await until("exhausted mention wake", () => wakes.some(i => i.text === "post-exhaustion-mention"));
  check("live mention still wakes", wakes.filter(i => i.text === "post-exhaustion-mention").length === 1);
  check("mention body stays in the pull lane, never automatic", agent.peekInbox("pull-only").some(i => i.text === "post-exhaustion-mention") && agent.peekInbox("automatic").length === 0);
  check("ambient remains fail-closed", !agent.peekInbox().some(i => i.text === "post-exhaustion-ambient") && !(await agent.recallAmbient()).items.some(i => i.text === "post-exhaustion-ambient"));
  const mentionReply = await inbox.run(agent, cfg, { scope: "pull-only" });
  check("public inbox returns the mention body and warning", mentionReply.text.includes("post-exhaustion-mention") && mentionReply.text.includes("Channel drop tracking exhausted"));
  check("pull clears only the returned buffered mention", !agent.peekInbox().some(i => i.text === "post-exhaustion-mention"));
  const postCapMuted = await pub.multicast("muted-after-exhaustion", { channel: "team.muted", mentions: ["otto"] });
  // A direct round trip is a delivery barrier for preceding channel publications.
  await pub.unicast(agent.id, "delivery-barrier");
  await until("delivery barrier", () => agent.peekInbox().some(i => i.text === "delivery-barrier"));
  check("muted mention does not wake or buffer", !wakes.some(i => i.text === "muted-after-exhaustion") && !agent.peekInbox().some(i => i.text === "muted-after-exhaustion"));
  await agent.setChannelMode("team.muted", "normal");
  let acked = false;
  agent.ep.emit("message", muted, { durable: true, ack: () => { acked = true; }, nak: () => {} }, { historical: false, kind: "channel" });
  check("known pre-exhaustion muted copy remains suppressed after unmute", acked && !wakes.some(i => i.id === muted.id) && !agent.peekInbox().some(i => i.id === muted.id));
  let postCapAcked = false;
  agent.ep.emit("message", postCapMuted, { durable: true, ack: () => { postCapAcked = true; }, nak: () => {} }, { historical: false, kind: "channel" });
  check("unknown late muted mention wakes after unmute with a pull-only body", !postCapAcked && wakes.filter(i => i.id === postCapMuted.id).length === 1 && agent.peekInbox("pull-only").some(i => i.id === postCapMuted.id) && !agent.peekInbox("automatic").some(i => i.id === postCapMuted.id));
  const residualReply = await inbox.run(agent, cfg, { scope: "pull-only" });
  check("late mention residual is surfaced with the exhaustion warning", residualReply.text.includes("muted-after-exhaustion") && residualReply.text.includes("Channel drop tracking exhausted") && postCapAcked);
  agent.ep.emit("message", postCapMuted, { durable: true, ack: () => {}, nak: () => {} }, { historical: false, kind: "channel" });
  check("the handled late mention is not surfaced a second time", wakes.filter(i => i.id === postCapMuted.id).length === 1 && !agent.peekInbox().some(i => i.id === postCapMuted.id));
  const replay = await pub.multicast("history-control", { channel: "team.muted" });
  agent.ep.emit("message", { ...replay, id: "historical-copy", mentions: ["otto"] }, { durable: false, ack: () => {}, nak: () => {} }, { historical: true, kind: "channel" });
  check("historical mentions cannot create a wake or buffered body", !wakes.some(i => i.id === "historical-copy") && !agent.peekInbox().some(i => i.id === "historical-copy"));
  await agent.setAttention("open");
  const empty = await inbox.run(agent, cfg, { scope: "pull-only" });
  check("degradation remains disclosed outside focus", empty.text.includes("Channel drop tracking exhausted"));
  console.log(`FOCUS DROP EXHAUSTION PASSED (${passed} checks)`);
} finally {
  await agent.stop();
  await pub.stop();
  broker.kill("SIGTERM");
  await new Promise<void>(resolve => { if (broker.exitCode !== null || broker.signalCode !== null) resolve(); else broker.once("exit", () => resolve()); });
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
