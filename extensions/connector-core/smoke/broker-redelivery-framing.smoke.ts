/**
 * Broker redelivery framing uses the broker's real count without inventing a prior model handoff.
 *
 * The recipient buffers one genuine DM and performs no inbox read or automatic context handoff.
 * The pre-provisioned consumer keeps the product's native 60-second ack wait. Once JetStream
 * redelivers the still-pending copy, the first possible automatic frame and the first cotal_inbox
 * read must say that prior model handling is unknown. They must not claim a prior run from the
 * broker count alone.
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

const lifecycleUid = mintLifecycleUid();
const receiverId = "receiver_agent228";
const receiverConfig: AgentConfig = {
  space,
  name: "Receiver",
  id: receiverId,
  servers,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
  kind: "agent",
  tls: false,
  lifecycleUid,
};
const receiver = new MeshAgent(receiverConfig);
receiver.on("error", () => {});
const incoming: InboxItem[] = [];
receiver.on("incoming", (item) => incoming.push({ ...item }));
const sender = new CotalEndpoint({
  space,
  servers,
  card: { id: "sender_agent228", name: "Sender", kind: "agent" },
  channels: [],
  lifecycleUid: mintLifecycleUid(),
});
sender.on("error", () => {});
let previousInboxReads = 0;

try {
  await awaitBrokerReady(() => isReachable(servers), {
    servers,
    attempts: 50,
    delayMs: 100,
    output: () => brokerOutput,
  });
  await sender.start();
  await receiver.start();
  check("receiver joined the private broker", receiver.connected === true);

  const observer = await connect({ servers });
  const consumer = await (await jetstreamManager(observer)).consumers.info(
    dmStream(space),
    dmDurable("local", receiverId, lifecycleUid),
  );
  check("the real DM consumer retains the native 60-second ack wait", consumer.config.ack_wait === 60_000_000_000, consumer.config.ack_wait);
  await observer.close();

  await sender.unicast(receiver.id, "unique-agent-228-current-base");
  for (let i = 0; i < 100 && incoming.length < 1; i++) await sleep(50);
  check("the first broker delivery reaches the real MeshAgent at count 1", incoming.length === 1 && incoming[0]?.deliveryCount === 1, incoming.map((i) => i.deliveryCount));
  check("no inbox or context handoff occurred before redelivery", previousInboxReads === 0 && receiver.inboxCount() === 1, { previousInboxReads, inbox: receiver.inboxCount() });

  for (let i = 0; i < 750 && incoming.length < 2; i++) await sleep(100);
  const buffered = receiver.peekInbox();
  check("native ack expiry produces broker delivery count 2", incoming.length >= 2 && buffered[0]?.deliveryCount === 2, { incoming: incoming.length, counts: buffered.map((i) => i.deliveryCount) });

  const frame = formatInjection(buffered) ?? "";
  check("the first possible context frame labels prior model handoff unknown", frame.includes("broker redelivery, delivery 2: prior model handoff unknown"), frame);
  check("the first possible context frame does not invent a prior run", !frame.includes("may already have run") && previousInboxReads === 0, { frame, previousInboxReads });

  const inbox = cotalToolSpecs(receiverConfig).find((spec) => spec.name === "cotal_inbox");
  assert(inbox, "cotal_inbox spec exists");
  previousInboxReads += 1;
  const result = await inbox.run(receiver, receiverConfig, {});
  check("the first inbox read preserves the same unknown handoff distinction", result.text.includes("broker redelivery, delivery 2: prior model handoff unknown"), result.text);
  check("the first inbox read clears exactly the one message", receiver.inboxCount() === 0, receiver.inboxCount());
  finish();
} finally {
  await receiver.stop().catch(() => {});
  await sender.stop().catch(() => {});
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
