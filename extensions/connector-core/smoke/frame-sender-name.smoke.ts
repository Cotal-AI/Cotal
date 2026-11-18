/**
 * A frame marks the sender's name and role as the sender's own claim, beside the id the broker
 * checked.
 *
 * Two peers DM a real MeshAgent on a real broker. One is `lead`. The other is a different
 * principal that also calls itself `lead`. A sender writes its own name and role, in the payload
 * and in its own presence row alike, so nothing a receiver reads binds a name to one principal.
 * The frame therefore says the name is unverified, and the `sender_id` beside it is the identity
 * that tells the two apart. Checked on the `cotal_inbox` reply, the injected block, the preview row
 * and the wake-hint label, which all render the sender through `fmtFrom`.
 *
 * Run: pnpm smoke:frame-sender-name
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { formatInjection } from "../src/control.js";
import { fmtFrom, renderInboxPreview } from "../src/framing.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "framesendername";
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], {
  stdio: ["ignore", "pipe", "pipe"],
});
let brokerOutput = "";
broker.stdout?.on("data", (chunk) => { brokerOutput += String(chunk); });
broker.stderr?.on("data", (chunk) => { brokerOutput += String(chunk); });
const releaseBroker = teardownOnSignal(broker, dir);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const receiverConfig: AgentConfig = {
  space,
  name: "Receiver",
  id: "receiver_frame",
  servers,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
  kind: "agent",
  tls: false,
  lifecycleUid: mintLifecycleUid(),
};
const receiver = new MeshAgent(receiverConfig);
receiver.on("error", () => {});
const peer = (id: string) => new CotalEndpoint({
  space, servers, card: { id, name: "lead", role: "reviewer", kind: "agent" }, channels: [], lifecycleUid: mintLifecycleUid(),
});
const lead = peer("lead_frame");
const impostor = peer("impostor_frame");
lead.on("error", () => {});
impostor.on("error", () => {});

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100, output: () => brokerOutput });
  await lead.start();
  await impostor.start();
  await receiver.start();

  await lead.unicast(receiver.id, "from the real lead");
  await impostor.unicast(receiver.id, "from a peer that also calls itself lead");
  for (let i = 0; i < 100 && receiver.inboxCount() < 2; i++) await sleep(50);
  const items = receiver.peekInbox();
  check("both DMs reach the real MeshAgent", items.length === 2, items.map((i) => i.fromId));

  const forged = items.find((i) => i.text.startsWith("from a peer"));
  assert(forged, "the impostor's DM is buffered");
  check("the wake-hint label marks the claimed name and role as unverified", fmtFrom(forged) === "lead/reviewer (unverified name)", fmtFrom(forged));

  const preview = renderInboxPreview(receiver.inboxSnapshot()).rows.join("\n");
  check("the preview rows mark the claimed name as unverified", preview.includes("[DM from lead/reviewer (unverified name)] from a peer"), preview);

  const injected = formatInjection(items) ?? "";
  check("the injected block marks the impostor's claimed name and names its own sender_id",
    injected.includes(`[DM from lead/reviewer (unverified name)] [sender_id="local.impostor_frame"`), injected);

  const inbox = cotalToolSpecs(receiverConfig).find((spec) => spec.name === "cotal_inbox");
  assert(inbox, "cotal_inbox spec exists");
  const result = await inbox.run(receiver, receiverConfig, {});
  const lines = result.text.split("\n").filter((l) => l.startsWith("[DM from"));
  check("the cotal_inbox reply marks both claimed names as unverified",
    lines.length === 2 && lines.every((l) => l.startsWith("[DM from lead/reviewer (unverified name)] [sender_id=")), lines);
  check("and the two senders are told apart only by the sender_id the broker checked",
    lines.some((l) => l.includes(`sender_id="local.lead_frame"`)) && lines.some((l) => l.includes(`sender_id="local.impostor_frame"`)), lines);
  finish();
} finally {
  await receiver.stop().catch(() => {});
  await lead.stop().catch(() => {});
  await impostor.stop().catch(() => {});
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
