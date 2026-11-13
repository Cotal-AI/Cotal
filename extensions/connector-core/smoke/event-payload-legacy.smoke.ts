import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, CotalEndpoint, eventPayloadStream, standaloneConnectOpts, spaceMessageStreamConfigs } from "@cotal-ai/core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { bootBroker } from "../../../implementations/manager/smoke/_boot-broker.js";
import { AguiEmitter } from "../src/agui-emitter.js";
import { EventWal } from "../src/event-wal.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { runStarted, toolCallStart, toolCallArgs, toolCallEnd, toolCallResult } from "../src/agui.js";

const space = "legacyevents";
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
let endpoint: CotalEndpoint | undefined;
let root: string | undefined;
try {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    const jsm = await jetstreamManager(nc);
    for (const config of spaceMessageStreamConfigs(space))
      if (config.name !== eventPayloadStream(space)) await jsm.streams.add(config);
  } finally { await nc.close(); }
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const principal = { owner: "local", actor: identity.id };
  const channel = `events.${principal.owner}.${principal.actor}`;
  const agentCreds = await mintCreds(auth, identity, "agent", { principal, lifecycleUid, allowSubscribe: ["general", channel], allowPublish: [channel] });
  endpoint = new CotalEndpoint({ space, servers: broker.servers, creds: agentCreds, lifecycleUid, consume: false, registerPresence: false, watchPresence: false, watchChannels: false, channels: [], card: { id: identity.id, name: "legacy", kind: "agent" } });
  const warnings: string[] = [];
  endpoint.on("warning", error => warnings.push(error.message));
  await endpoint.start();
  // Wait for the endpoint's real history surface before starting the emitter.
  await endpoint.channelHistoryPage("general", { limit: 1 });
  root = await mkdtemp(join(tmpdir(), "legacy-events-"));
  await mkdir(join(root, "thread"));
  const src = join(root, "source.jsonl");
  await writeFile(src, "");
  const wal = await EventWal.open(join(root, "thread", "wal.json"), { space, threadId: "native", principal: `${endpoint.principal.owner}.${endpoint.principal.actor}`, subjectMayExist: false });
  const emitter = await AguiEmitter.start({ endpoint, wal, subjectFrontier: memorySubjectFrontier(), source: new JsonlFileSource(src), map: () => ({ runId: "run", events: [
    runStarted({ threadId: "native", runId: "run", timestamp: 1 }),
    toolCallStart({ toolCallId: "call", toolCallName: "bash", timestamp: 2 }),
    toolCallArgs({ toolCallId: "call", delta: "private-input-canary", timestamp: 2 }),
    toolCallEnd({ toolCallId: "call", timestamp: 3 }),
    toolCallResult({ messageId: "result", toolCallId: "call", content: "private-output-canary", timestamp: 3 }),
  ] }) });
  await emitter.pump();
  await writeFile(src, "{}\n");
  await emitter.pump();
  const history = JSON.stringify(await endpoint.channelHistoryPage(emitter.channel, { limit: 10 }));
  assert.ok(history.includes('"toolCallName":"bash"'), history);
  assert.ok(history.includes('"timestamp":2'), history);
  assert.ok(history.includes('"timestamp":3'), history);
  assert.ok(!history.includes("private-input-canary"));
  assert.ok(!history.includes("private-output-canary"));
  assert.ok(!history.includes("TOOL_CALL_ARGS"));
  assert.ok(!history.includes("TOOL_CALL_RESULT"));
  assert.ok(warnings.some(message => message.includes("event payloads unavailable") && message.includes("EVP_legacyevents") && message.includes("Upgrade")));
  assert.equal(wal.pending, null);
  console.log("PASS pre-upgrade stream absence reports unavailable payloads and preserves public names/times without payloads");
} finally {
  await endpoint?.stop();
  await broker.stop();
  if (root) await rm(root, { recursive: true, force: true });
}
