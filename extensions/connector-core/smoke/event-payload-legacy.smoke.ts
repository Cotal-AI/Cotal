import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { createRequire } from "node:module";
import { nativeNkeySigner } from "../../../packages/core/src/nkey-signer.js";
import { jetstreamManager } from "@nats-io/jetstream";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, CotalEndpoint, eventPayloadStream, standaloneConnectOpts, spaceMessageStreamConfigs, permissionsFor } from "@cotal-ai/core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { bootBroker } from "../../../implementations/manager/smoke/_boot-broker.js";
import { AguiEmitter } from "../src/agui-emitter.js";
import { EventWal } from "../src/event-wal.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { runStarted, toolCallStart, toolCallArgs, toolCallEnd, toolCallResult } from "../src/agui.js";

type NatsConnection = Awaited<ReturnType<typeof connect>>;
const requireCore = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const { encodeUser, fmtCreds } = requireCore("@nats-io/jwt");
const { fromPublic, fromSeed } = requireCore("@nats-io/nkeys");

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
  // Reproduce an older host's credential, not today's mint with its EVP info grant.
  const permissions = permissionsFor("agent", space, { ...principal, connId: identity.id, lifecycleUid }, { allowSubscribe: ["general", channel], allowPublish: [channel] });
  const infoSubject = `$JS.API.STREAM.INFO.${eventPayloadStream(space)}`;
  const denied = process.env.LEGACY_STREAM_ABSENT !== "1";
  const pub = permissions.pub as { allow: string[] };
  if (denied) pub.allow = pub.allow.filter(subject => subject !== infoSubject);
  const jwt = await encodeUser("legacy-agent", fromPublic(identity.id), fromPublic(auth.account.pub), permissions,
    { signer: nativeNkeySigner(new TextEncoder().encode(auth.account.signingSeed)) });
  const agentCreds = new TextDecoder().decode(fmtCreds(jwt, fromSeed(new TextEncoder().encode(identity.seed))));
  endpoint = new CotalEndpoint({ space, servers: broker.servers, creds: agentCreds, lifecycleUid, consume: false, registerPresence: false, watchPresence: false, watchChannels: false, channels: [], card: { id: identity.id, name: "legacy", kind: "agent" } });
  const warnings: string[] = [];
  endpoint.on("warning", error => warnings.push(error.message));
  await endpoint.start();
  // Wait for the endpoint's real history surface before starting the emitter.
  await endpoint.channelHistoryPage("general", { limit: 1 });
  // Count real transport requests, including any JetStream-internal retries.
  const agentNc = (endpoint as unknown as { nc: NatsConnection }).nc;
  const request = agentNc.request.bind(agentNc);
  const requests: string[] = [];
  const countedRequest: NatsConnection["request"] = (subject, data, options) => {
    requests.push(subject);
    return request(subject, data, options);
  };
  agentNc.request = countedRequest;
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
  await emitter.pump();
  const history = JSON.stringify(await endpoint.channelHistoryPage(emitter.channel, { limit: 10 }));
  assert.ok(history.includes('"toolCallName":"bash"'), history);
  assert.ok(history.includes('"timestamp":2'), history);
  assert.ok(history.includes('"timestamp":3'), history);
  assert.ok(!history.includes("private-input-canary"));
  assert.ok(!history.includes("private-output-canary"));
  assert.ok(!history.includes("TOOL_CALL_ARGS"));
  assert.ok(!history.includes("TOOL_CALL_RESULT"));
  assert.equal(warnings.filter(message => message.includes("event payloads unavailable")).length, 1);
  assert.ok(warnings.some(message => message.includes("EVP_legacyevents") && message.includes(denied ? "missing publish permission" : "is absent") && message.includes("Upgrade")));
  assert.equal(requests.filter(subject => subject === infoSubject).length, 1);
  assert.deepEqual(requests.filter(subject => (subject.includes("EVP_") || subject.includes(`cotal.${space}.evp.`)) && subject !== infoSubject), []);
  assert.equal(wal.pending, null);
  console.log(`PASS pre-upgrade ${denied ? "info permission refusal" : "stream absence"}: one real info request, one warning, names/times only`);

  await mkdir(join(root, "frozen"));
  const frozenPath = join(root, "frozen", "wal.json");
  const frozen = await EventWal.open(frozenPath, { space, threadId: "frozen", principal: `${endpoint.principal.owner}.${endpoint.principal.actor}`, subjectMayExist: false });
  const frontier = memorySubjectFrontier();
  await frozen.bindSubjectFrontier(frontier);
  await frozen.beginSend({ id: "frozenpublic", E: 0, seq: 1, sourceCursor: "cursor", body: [{ kind: "text", text: "status" }], brackets: { run: undefined, text: [], reasoning: [], tools: [] }, payload: { id: "frozenpayload", E: 0, body: [{ kind: "text", text: "frozen-private-canary" }] } });
  const before = await readFile(frozenPath, "utf8");
  requests.length = 0;
  await assert.rejects(AguiEmitter.start({ endpoint, wal: frozen, subjectFrontier: frontier, source: new JsonlFileSource(src), map: () => ({ runId: "run", events: [] }) }), /previously frozen sibling payload requires an available/);
  assert.equal(await readFile(frozenPath, "utf8"), before);
  assert.equal(JSON.stringify(frozen.pending?.payload?.body).includes("frozen-private-canary"), true);
  const afterRecovery = JSON.stringify(await endpoint.channelHistoryPage(channel, { limit: 10 }));
  assert.equal(afterRecovery, history);
  assert.equal(requests.filter(subject => subject === infoSubject).length, 1);
  assert.deepEqual(requests.filter(subject => (subject.includes("EVP_") || subject.includes(`cotal.${space}.evp.`)) && subject !== infoSubject), []);
  console.log("PASS frozen sibling remains byte-for-byte intact and is not published or discarded");

  // Synthetic taxonomy controls complement the real permission refusal above.
  const { PermissionViolationError, AuthorizationError } = requireCore("@nats-io/nats-core");
  const surface = endpoint as unknown as { jsm: { streams: { info: (stream: string) => Promise<never> } } };
  const originalManager = surface.jsm;
  try {
    for (const failure of [
      new AuthorizationError("authorization sentinel"),
      new Error("Permissions Violation for Publish"),
      new Error("transport sentinel"),
      new PermissionViolationError("wrong subject", "publish", "$JS.API.STREAM.INFO.CHAT_legacyevents"),
      new PermissionViolationError("inbox denied", "subscription", "_INBOX.test.*"),
      new PermissionViolationError("wrong operation", "subscription", infoSubject),
    ]) {
      surface.jsm = { streams: { info: async () => { throw failure; } } };
      const count = warnings.length;
      await assert.rejects(endpoint.eventPayloadLimit(), error => error === failure);
      assert.equal(warnings.length, count);
    }
  } finally { surface.jsm = originalManager; }
  console.log("PASS auth, transport, untyped text, other subjects and subscription refusals remain loud");
} finally {
  await endpoint?.stop();
  await broker.stop();
  if (root) await rm(root, { recursive: true, force: true });
}
