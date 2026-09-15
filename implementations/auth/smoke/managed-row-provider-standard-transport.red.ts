import assert from "node:assert/strict";
import {
  MANAGED_ROW_INPUT_DIGEST,
  MANAGED_ROW_OUTPUT_DIGEST,
  ManagedRowAttemptError,
  canonicalJson,
  createManagedRowAttempt,
  endpointErrorReply,
  epReplySubject,
  managedRowSuccessReply,
  managedRowWireId,
  parseManagedRowRequestBytes,
  type CreateManagedRowIntent,
  type EndpointReply,
} from "@cotal-ai/core";
import { sendManagedRowAttemptWithTransport, type ManagedRowTransportConnection, type ManagedRowTransportMessage } from "../src/provider.js";

const enc = new TextEncoder();
const caller = { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "manager", uid: "aaaaaaaaaaaaaaaaaaaaaaaaaa" };
const responder = { endpoint: "auth", instanceId: "dddddddddddddddddddddddddd", epoch: 7 };
const intent: CreateManagedRowIntent = {
  ver: 1, command: "create-managed-row", requestId: "request_provider", operationId: "manager-spawn:cccccccccccccccccccccccccc",
  space: "task84", target: { owner: caller.owner, actor: "worker", lifecycleUid: "cccccccccccccccccccccccccc" },
  tokenHash: "a".repeat(64), scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"],
};
const answer = enc.encode(canonicalJson(managedRowSuccessReply(managedRowWireId(intent), {
  ver: 1, command: intent.command, requestId: intent.requestId, operationId: intent.operationId, target: intent.target,
  state: "live", targetDigest: `sha256:${"b".repeat(64)}`, historyHead: "c".repeat(64),
})));

type Callback = (error: Error | null, msg: ManagedRowTransportMessage) => void;
interface Script { reply?: (publish: { subject: string; data: Uint8Array; reply?: string }, callback: Callback) => void; connectError?: Error; subscribeError?: Error; flushError?: Error; publishError?: Error; connectMs?: number; flushMs?: number }
function harness(script: Script) {
  const order: string[] = [];
  let now = 0;
  let callback: Callback | undefined;
  let filter = "", closed = false, unsubscribed = false;
  const connection: ManagedRowTransportConnection = {
    subscribe(subject, opts) { order.push("subscribe"); if (script.subscribeError) throw script.subscribeError; filter = subject; callback = opts.callback; return { unsubscribe() { order.push("unsubscribe"); unsubscribed = true; } }; },
    async flush() { order.push("flush"); now += script.flushMs ?? 0; if (script.flushError) throw script.flushError; },
    publish(subject, data, opts) {
      order.push("publish");
      if (script.publishError) throw script.publishError;
      script.reply?.({ subject, data, reply: opts?.reply }, callback!);
    },
    async close() { order.push("close"); closed = true; },
  };
  return {
    deps: {
      open: async () => { order.push("connect"); now += script.connectMs ?? 0; if (script.connectError) throw script.connectError; return connection; },
      now: () => now,
      setTimer: (run: () => void, delayMs: number) => setTimeout(run, delayMs),
      clearTimer: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
    state: () => ({ order, filter, closed, unsubscribed }),
  };
}

const attemptA = createManagedRowAttempt(caller, intent, Buffer.alloc(16, 1), undefined, { bind: { instanceId: responder.instanceId, epoch: responder.epoch } });
const attemptB = createManagedRowAttempt(caller, intent, Buffer.alloc(16, 2), undefined, { bind: { instanceId: responder.instanceId, epoch: responder.epoch } });
let publishedA: { subject: string; data: Uint8Array; reply?: string } | undefined;
const success = harness({ reply: (publish, callback) => {
  publishedA = publish;
  queueMicrotask(() => callback(null, { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptA.nonce }), data: answer }));
} });
const exact = await sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 1_000 }, success.deps);
assert.equal(Buffer.compare(Buffer.from(exact.bytes), Buffer.from(answer)), 0);
assert.equal(exact.data.operationId, intent.operationId);
assert.deepEqual(success.state().order.slice(0, 3), ["connect", "subscribe", "flush"]);
assert.equal(success.state().order.indexOf("subscribe") < success.state().order.indexOf("publish"), true);
assert.equal(success.state().unsubscribed, true); assert.equal(success.state().closed, true);
assert.equal(success.state().filter.endsWith(`.${attemptA.nonce}`), true);
assert.equal(publishedA?.reply, undefined, "reserved no-responders sentinel is outside the existing exact grant and remains unclaimed");
const request = parseManagedRowRequestBytes(publishedA!.data).envelope;
assert.deepEqual(request.op, { endpoint: "auth", command: intent.command, inputDigest: MANAGED_ROW_INPUT_DIGEST, outputDigest: MANAGED_ROW_OUTPUT_DIGEST });
assert.equal(request.class, "ephemeral"); assert.equal(request.replyExpected, true); assert.equal(request.deadlineMs, 1_000);
assert.equal(request.from.id, `${caller.owner}.${caller.actor}`); assert.equal(request.target, undefined); assert.deepEqual(request.bind, attemptA.bind);
assert.equal(new TextDecoder().decode(publishedA!.data), canonicalJson(JSON.parse(new TextDecoder().decode(publishedA!.data))));

let elapsedPublish: { data: Uint8Array } | undefined;
const elapsed = harness({ connectMs: 20, flushMs: 30, reply: (publish, callback) => { elapsedPublish = publish; queueMicrotask(() => callback(null, { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptA.nonce }), data: answer })); } });
await sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 100 }, elapsed.deps);
assert.equal(parseManagedRowRequestBytes(elapsedPublish!.data).envelope.deadlineMs, 50, "connect and flush consumption reduces the listener budget");

let expiredPublished = false;
const expired = harness({ connectMs: 60, flushMs: 40, reply: () => { expiredPublished = true; } });
await assert.rejects(() => sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 100 }, expired.deps),
  (error: unknown) => error instanceof ManagedRowAttemptError && error.knowledge === "not-executed");
assert.equal(expiredPublished, false);

let publishedB: { data: Uint8Array } | undefined;
const retry = harness({ reply: (publish, callback) => { publishedB = publish; queueMicrotask(() => callback(null, { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptB.nonce }), data: answer })); } });
await sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptB, timeoutMs: 1_000 }, retry.deps);
assert.notEqual(success.state().filter, retry.state().filter);
assert.equal(parseManagedRowRequestBytes(publishedA!.data).envelope.id, parseManagedRowRequestBytes(publishedB!.data).envelope.id);
assert.equal(success.state().closed, true, "the prior connection closes before retry completes");

for (const [outcome, knowledge] of [["not-executed", "not-executed"], ["executed", "executed"], ["unknown", "unknown"]] as const) {
  const failure: EndpointReply = endpointErrorReply(managedRowWireId(intent), new Error(`held ${outcome}`), outcome);
  const h = harness({ reply: (_publish, callback) => queueMicrotask(() => callback(null, { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptA.nonce }), data: enc.encode(JSON.stringify(failure)) })) });
  await assert.rejects(() => sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 1_000 }, h.deps),
    (error: unknown) => error instanceof ManagedRowAttemptError && error.knowledge === knowledge && error.reply?.error?.outcome === outcome);
  assert.equal(h.state().closed, true); assert.equal(h.state().unsubscribed, true);
}

for (const script of [{ connectError: new Error("connect refused") }, { subscribeError: new Error("subscribe refused") }, { flushError: new Error("flush refused") }, { publishError: new Error("publish refused") }]) {
  const h = harness(script);
  await assert.rejects(() => sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 50 }, h.deps),
    (error: unknown) => error instanceof ManagedRowAttemptError && error.knowledge === "not-executed");
  assert.equal(h.state().closed, script.connectError !== undefined ? false : true);
}

const silent = harness({});
await assert.rejects(() => sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 5 }, silent.deps),
  (error: unknown) => error instanceof ManagedRowAttemptError && error.knowledge === "unknown");
assert.equal(silent.state().closed, true); assert.equal(silent.state().unsubscribed, true);

for (const reply of [
  { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptA.nonce }), data: enc.encode("not-json") },
  { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptA.nonce }), data: enc.encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(answer)), id: "wrong" })) },
  { subject: epReplySubject("task84", { ...responder, caller, nonce: attemptA.nonce }), data: enc.encode(JSON.stringify(managedRowSuccessReply(managedRowWireId(intent), { ...(JSON.parse(new TextDecoder().decode(answer)).data), operationId: "foreign-operation-id" }))) },
  { subject: epReplySubject("task84", { endpoint: "auth", instanceId: "eeeeeeeeeeeeeeeeeeeeeeeeee", epoch: 7, caller, nonce: attemptA.nonce }), data: answer },
  { subject: epReplySubject("task84", { endpoint: "auth", instanceId: responder.instanceId, epoch: 8, caller, nonce: attemptA.nonce }), data: answer },
]) {
  const h = harness({ reply: (_publish, callback) => queueMicrotask(() => callback(null, reply)) });
  await assert.rejects(() => sendManagedRowAttemptWithTransport({ server: "offline.invalid", credentials: "fixture", attempt: attemptA, timeoutMs: 5 }, h.deps),
    (error: unknown) => error instanceof ManagedRowAttemptError && error.knowledge === "unknown");
}

console.log("TASK84 MANAGED ROW PROVIDER STANDARD TRANSPORT 24 checks passed, 0 failed");
