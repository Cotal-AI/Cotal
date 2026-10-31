import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, countedAssert, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  authorizeServeGrant, compileContract, contractDigest, createEndpointStreams, epCallerReplyFilter, epRequestSubject,
  isReachable, mintLifecycleUid, openRecordsBucket, parseDescribeObservation, parseEpSubject, recordSpecKey, RECORD_KINDS,
  serveEndpoint, VOID_SCHEMA, type DescribeRequestContext, type EpCaller, type EndpointReply,
} from "../src/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const space = "describe-observation", endpoint = "org.example.describe", owner = `u_${"a".repeat(26)}`;
const caller = { owner, actor: "caller", uid: mintLifecycleUid() }, instanceId = mintLifecycleUid();
const nonce = () => randomUUID().replaceAll("-", "");
const request = () => ({ v: 1, id: nonce(), op: { endpoint, command: "describe" }, class: "ephemeral",
  replyExpected: true, deadlineMs: 2000, from: { id: `${owner}.caller`, name: "caller", opaque: { retained: true } },
  auth: "opaque-fixture", extension: { unknown: { retained: true } } });
const subject = epRequestSubject(space, { endpoint, command: "describe", route: { mode: "one" }, caller, nonce: nonce() });
const raw = request(), observed = parseDescribeObservation(space, subject, raw);
assert.equal(observed.fingerprint, contractDigest({ subject, envelope: raw }));
assert.equal(parseDescribeObservation(space, subject, { ...raw, extension: { unknown: { retained: false } } }).fingerprint === observed.fingerprint, false);
assert.equal(parseDescribeObservation(space, subject, { ...raw, from: { ...raw.from, opaque: { retained: false } } }).fingerprint === observed.fingerprint, false);
assert.equal(parseDescribeObservation(space, subject, Object.fromEntries(Object.entries(raw).reverse())).fingerprint, observed.fingerprint);
assert.throws(() => parseDescribeObservation("other", subject, raw));
assert.throws(() => parseDescribeObservation(space, subject, { ...raw, args: { not: "void" } }));
assert.throws(() => parseDescribeObservation(space, subject, { ...raw, bind: { instanceId, epoch: 1 } }));
assert.throws(() => parseDescribeObservation(space, subject, { ...raw, op: { ...raw.op, inputDigest: contractDigest({}) } }));
assert.throws(() => parseDescribeObservation(space, subject, { ...raw, class: "journal", replyExpected: false }));
const cast = { ...raw, replyExpected: false }; delete (cast as Partial<typeof raw>).deadlineMs;
assert.equal(parseDescribeObservation(space, subject, cast).deadlineMs, undefined, "no finite deadline is invented for a cast");

const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined, serving: ReturnType<typeof serveEndpoint> | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const records = await openRecordsBucket(nc, space), compiled = compileContract({ root: VOID_SCHEMA });
  const document = { urn: endpoint, revision: 1, attributes: [], events: [], commands: ["read", "hidden"].map((name) => ({
    name, class: "ephemeral", targeted: false, capability: `orders.${name}`, inputDigest: compiled.closureDigest, outputDigest: compiled.closureDigest,
  })) };
  const manifest = { v: 1, root: contractDigest(document), members: [] };
  const artifacts = new Map<string, unknown>([[contractDigest(document), document], [contractDigest(manifest), manifest]]);
  await records.create(recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]), new TextEncoder().encode(JSON.stringify({
    endpoint, owner, clusterDigests: [contractDigest(manifest)], protocol: { v: 1 },
  })));
  const grant = await authorizeServeGrant(records, { space, endpoint, instanceId, epoch: 1, holder: { owner },
    authority: { authorize: () => ({ authorized: true, revision: 1 }) }, readProcessEpoch: () => 1,
    readClusterArtifact: (digest) => artifacts.get(digest) });
  const contexts: Array<{ who: EpCaller; context: DescribeRequestContext }> = [];
  serving = serveEndpoint(nc, space, grant, ["read", "hidden"].map((command) => ({ command,
    contract: { input: compiled, output: compiled }, handler: () => null })), { view: (who, context) => {
    assert.ok(context); assert.ok(Object.isFrozen(context) && Object.isFrozen(context.identity));
    assert.ok(context.receivedAtMonotonicMs <= performance.now());
    assert.equal(JSON.stringify(context).includes("opaque-fixture"), false, "context exposes no raw auth payload");
    contexts.push({ who: { ...who }, context }); return { commands: ["read"] };
  } });
  await nc.flush();
  for (const who of [caller, { ...caller, generation: "a".repeat(32) }]) {
    for (const route of [{ mode: "one" as const }, { mode: "all" as const }, { mode: "inst" as const, instanceId }]) {
      const req = request(), reqNonce = nonce(), wireSubject = epRequestSubject(space, { endpoint, command: "describe", caller: who, route, nonce: reqNonce });
      const reply = new Promise<EndpointReply>((resolve, reject) => {
        const timer = setTimeout(() => { sub.unsubscribe(); reject(new Error("Describe reply timeout")); }, 3000);
        const sub = nc!.subscribe(epCallerReplyFilter(space, who), { callback: (error, message) => {
          if (error) { clearTimeout(timer); sub.unsubscribe(); reject(error); return; }
          const parsed = parseEpSubject(message.subject);
          if (!parsed || parsed.plane !== "reply" || parsed.nonce !== reqNonce) return;
          clearTimeout(timer); sub.unsubscribe(); resolve(JSON.parse(new TextDecoder().decode(message.data)) as EndpointReply);
        } });
      });
      await nc.flush(); nc.publish(wireSubject, new TextEncoder().encode(JSON.stringify(req)));
      const result = await reply;
      assert.equal(result.ok, true);
      const answer = result.data as { public: boolean; descriptor: { clusters: Array<{ commands: string[]; document?: unknown }> } };
      assert.equal(answer.public, false); assert.deepEqual(answer.descriptor.clusters[0]!.commands, ["read"]);
      assert.equal(answer.descriptor.clusters[0]!.document, undefined, "partial inline disclosure remains suppressed");
      const captured = contexts.at(-1)!;
      assert.deepEqual(captured.who, who);
      assert.equal(captured.context.subject, wireSubject);
      assert.equal(captured.context.fingerprint, parseDescribeObservation(space, wireSubject, req).fingerprint);
      assert.deepEqual(captured.context.identity, { endpoint, instanceId, epoch: 1 });
      assert.equal(captured.context.deadlineMs, 2000);
    }
  }
  assert.equal(contexts.length, 6);
  console.log("Describe observation: full-envelope fingerprints and immutable real receive context passed on both rails/all routes; no remote policy authority claimed");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  await serving?.stop(); await nc?.close(); await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true }); release();
}
