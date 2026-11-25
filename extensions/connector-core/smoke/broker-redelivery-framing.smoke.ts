/**
 * Broker redelivery framing tells a queued message from an unconfirmed handoff.
 *
 * Three real MeshAgents on a private broker keep the product's native 60-second ack wait, and every
 * cell runs inside the same wait:
 *  - a DM this session queued and never handed over is redelivered at count 2, and its first frame
 *    and first `cotal_inbox` read carry no redelivery label;
 *  - a DM this session held for a frame and released unacked, as a failed turn does, is redelivered
 *    at count 2 and says that an earlier handoff in this session was not confirmed;
 *  - a DM whose first copy reaches a restarted session as a redelivery keeps the prior model handoff
 *    unknown, since nothing local records what the earlier session did with it.
 *
 * Run: pnpm smoke:broker-redelivery-framing
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { CotalEndpoint, dmDurable, dmStream, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent, type InboxItem } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { formatInjection } from "../src/control.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "brokerredeliveryframing";
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], {
  stdio: ["ignore", "pipe", "pipe"],
});
let brokerOutput = "";
broker.stdout?.on("data", (chunk) => { brokerOutput += String(chunk); });
broker.stderr?.on("data", (chunk) => { brokerOutput += String(chunk); });
const releaseBroker = teardownOnSignal(broker, dir);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const config = (id: string, name: string, lifecycleUid: string): AgentConfig => ({
  space,
  name,
  id,
  servers,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
  kind: "agent",
  tls: false,
  lifecycleUid,
});
const lifecycleUid = mintLifecycleUid();
const receiverConfig = config("receiver_agent228", "Receiver", lifecycleUid);
const receiver = new MeshAgent(receiverConfig);
receiver.on("error", () => {});
const incoming: InboxItem[] = [];
receiver.on("incoming", (item) => incoming.push({ ...item }));
// The restart cell: one lifecycle, received first by a session that stops before handing it over.
const restartConfig = config("restart_agent228", "Restarted", mintLifecycleUid());
const before = new MeshAgent(restartConfig);
before.on("error", () => {});
let after: MeshAgent | undefined;
const sender = new CotalEndpoint({
  space,
  servers,
  card: { id: "sender_agent228", name: "Sender", kind: "agent" },
  channels: [],
  lifecycleUid: mintLifecycleUid(),
});
sender.on("error", () => {});
const byText = (agent: MeshAgent, text: string) => agent.peekInbox().find((i) => i.text === text);

try {
  await awaitBrokerReady(() => isReachable(servers), {
    servers,
    attempts: 50,
    delayMs: 100,
    output: () => brokerOutput,
  });
  await sender.start();
  await receiver.start();
  await before.start();
  check("both receivers joined the private broker", receiver.connected === true && before.connected === true);

  const observer = await connect({ servers });
  const consumer = await (await jetstreamManager(observer)).consumers.info(
    dmStream(space),
    dmDurable("local", receiverConfig.id!, lifecycleUid),
  );
  check("the real DM consumer retains the native 60-second ack wait", consumer.config.ack_wait === 60_000_000_000, consumer.config.ack_wait);
  await observer.close();

  await sender.unicast(receiver.id, "agent-228-queued");
  await sender.unicast(receiver.id, "agent-228-handed-over");
  await sender.unicast(before.id, "agent-228-restarted");
  for (let i = 0; i < 100 && (incoming.length < 2 || !byText(before, "agent-228-restarted")); i++) await sleep(50);
  const queued = byText(receiver, "agent-228-queued");
  const handed = byText(receiver, "agent-228-handed-over");
  check("each first broker delivery reaches its MeshAgent at count 1",
    queued?.deliveryCount === 1 && handed?.deliveryCount === 1 && byText(before, "agent-228-restarted")?.deliveryCount === 1,
    incoming.map((i) => [i.text, i.deliveryCount]));

  // A frame holds its batch for its turn. A failed turn releases the hold without an ack.
  assert(queued && handed, "both DMs are buffered");
  check("the handed-over DM is held for a frame", receiver.holdInFlight([handed.recvKey]) === true);
  receiver.releaseInFlight([handed.recvKey]);
  await before.stop();
  after = new MeshAgent(restartConfig);
  after.on("error", () => {});
  await after.start();

  const redelivered = () => byText(receiver, "agent-228-queued")?.deliveryCount === 2
    && byText(receiver, "agent-228-handed-over")?.deliveryCount === 2
    && byText(after!, "agent-228-restarted") !== undefined;
  for (let i = 0; i < 750 && !redelivered(); i++) await sleep(100);
  check("native ack expiry redelivers each DM", redelivered(), {
    receiver: receiver.peekInbox().map((i) => [i.text, i.deliveryCount]),
    restarted: after.peekInbox().map((i) => [i.text, i.deliveryCount]),
  });

  const queuedFrame = formatInjection([byText(receiver, "agent-228-queued")!]) ?? "";
  check("a queued DM's first frame carries no redelivery label", !queuedFrame.includes("redelivery") && !queuedFrame.includes("handoff"), queuedFrame);
  const handedFrame = formatInjection([byText(receiver, "agent-228-handed-over")!]) ?? "";
  check("a DM released unacked says an earlier handoff in this session was not confirmed",
    handedFrame.includes("broker redelivery, delivery 2: an earlier handoff in this session was not confirmed"), handedFrame);

  const restarted = byText(after, "agent-228-restarted");
  check("a restarted session's first copy is already a redelivery", restarted !== undefined && restarted.deliveryCount! > 1 && restarted.firstDeliveryCount === restarted.deliveryCount, restarted);
  const restartedFrame = formatInjection([restarted!]) ?? "";
  check("a restarted session keeps the prior model handoff unknown",
    restartedFrame.includes(`broker redelivery, delivery ${restarted?.deliveryCount}: prior model handoff unknown`), restartedFrame);

  const inbox = cotalToolSpecs(receiverConfig).find((spec) => spec.name === "cotal_inbox");
  assert(inbox, "cotal_inbox spec exists");
  const result = await inbox.run(receiver, receiverConfig, {});
  const line = (text: string) => result.text.split("\n").find((l) => l.includes(text)) ?? "";
  check("the first inbox read shows the queued DM without a redelivery label",
    line("agent-228-queued") !== "" && !line("agent-228-queued").includes("redelivery"), result.text);
  check("the first inbox read keeps the unconfirmed handoff on the released DM",
    line("agent-228-handed-over").includes("an earlier handoff in this session was not confirmed"), result.text);
  check("the first inbox read clears both messages", receiver.inboxCount() === 0, receiver.inboxCount());
  finish();
} finally {
  await receiver.stop().catch(() => {});
  await before.stop().catch(() => {});
  await after?.stop().catch(() => {});
  await sender.stop().catch(() => {});
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
