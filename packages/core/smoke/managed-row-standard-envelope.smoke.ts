import assert from "node:assert/strict";
import {
  MANAGED_ROW_INPUT_CONTRACT,
  MANAGED_ROW_INPUT_DIGEST,
  MANAGED_ROW_OUTPUT_CONTRACT,
  MANAGED_ROW_OUTPUT_DIGEST,
  createManagedRowAttempt,
  endpointErrorReply,
  managedRowEndpointRequest,
  managedRowFailureKnowledge,
  managedRowSuccessReply,
  managedRowWireId,
  parseManagedRowReplyBytes,
  parseManagedRowRequestBytes,
  type CreateManagedRowIntent,
  type RevokeManagedRowIntent,
} from "../src/index.js";

const enc = new TextEncoder();
const caller = { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "manager", uid: "aaaaaaaaaaaaaaaaaaaaaaaaaa" };
const target = { owner: caller.owner, actor: "worker", lifecycleUid: "cccccccccccccccccccccccccc" };
const create: CreateManagedRowIntent = {
  ver: 1, command: "create-managed-row", requestId: "request_aaaaaaaa", operationId: "manager-spawn:cccccccccccccccccccccccccc",
  space: "task84", target, tokenHash: "a".repeat(64), scope: ["run", "spawn"], allowSubscribe: ["general"], allowPublish: ["general"],
};
const revoke: RevokeManagedRowIntent = {
  ver: 1, command: "revoke-managed-row", requestId: "request_bbbbbbbb", operationId: "manager-revoke:cccccccccccccccccccccccccc",
  space: "task84", target,
};

assert.match(MANAGED_ROW_INPUT_DIGEST, /^sha256:[a-f0-9]{64}$/);
assert.match(MANAGED_ROW_OUTPUT_DIGEST, /^sha256:[a-f0-9]{64}$/);
assert.equal(Object.isFrozen(MANAGED_ROW_INPUT_CONTRACT), true);
assert.equal(Object.isFrozen(MANAGED_ROW_OUTPUT_CONTRACT), true);

const attemptA = createManagedRowAttempt(caller, create, Buffer.alloc(16, 1));
const attemptB = createManagedRowAttempt(caller, create, Buffer.alloc(16, 2), undefined, { bind: { instanceId: "dddddddddddddddddddddddddd", epoch: 7 } });
assert.notEqual(attemptA.nonce, attemptB.nonce);
assert.equal(managedRowWireId(attemptA.intent), managedRowWireId(attemptB.intent));

const createEnvelope = managedRowEndpointRequest(attemptB, 12_345);
assert.deepEqual(createEnvelope.op, { endpoint: "auth", command: "create-managed-row", inputDigest: MANAGED_ROW_INPUT_DIGEST, outputDigest: MANAGED_ROW_OUTPUT_DIGEST });
assert.equal(createEnvelope.class, "ephemeral");
assert.equal(createEnvelope.replyExpected, true);
assert.equal(createEnvelope.from.id, `${caller.owner}.${caller.actor}`);
assert.equal(createEnvelope.target, undefined);
assert.deepEqual(createEnvelope.bind, { instanceId: "dddddddddddddddddddddddddd", epoch: 7 });
assert.equal(parseManagedRowRequestBytes(enc.encode(JSON.stringify(createEnvelope))).args.intent.command, "create-managed-row");

const revokeAttempt = createManagedRowAttempt(caller, revoke, Buffer.alloc(16, 3), undefined, { mappingRevision: 42 });
const revokeEnvelope = managedRowEndpointRequest(revokeAttempt, 9_999);
assert.deepEqual(revokeEnvelope.target, { ...target, mappingRevision: 42 });
assert.equal(parseManagedRowRequestBytes(enc.encode(JSON.stringify(revokeEnvelope))).envelope.target?.mappingRevision, 42);

for (const mutate of [
  (v: Record<string, unknown>) => ({ id: v.id, intent: create }),
  (v: Record<string, unknown>) => ({ ...v, op: { ...(v.op as object), inputDigest: `sha256:${"0".repeat(64)}` } }),
  (v: Record<string, unknown>) => ({ ...v, class: "journal" }),
  (v: Record<string, unknown>) => ({ ...v, replyExpected: false }),
]) {
  const altered = mutate(structuredClone(createEnvelope) as unknown as Record<string, unknown>);
  assert.throws(() => parseManagedRowRequestBytes(enc.encode(JSON.stringify(altered))));
}

const data = {
  ver: 1 as const, command: create.command, requestId: create.requestId, operationId: create.operationId, target: create.target,
  state: "live" as const, targetDigest: `sha256:${"b".repeat(64)}`, historyHead: "c".repeat(64),
};
const reply = managedRowSuccessReply(managedRowWireId(create), data);
const bytes = enc.encode(JSON.stringify(reply));
assert.deepEqual(parseManagedRowReplyBytes(bytes, managedRowWireId(create), create).data, data);
assert.equal(new TextDecoder().decode(bytes).includes('"v":1'), true);

const refusal = endpointErrorReply(managedRowWireId(create), new Error("ambiguous responder failure"));
assert.equal(refusal.error?.outcome, "unknown");
assert.equal(parseManagedRowReplyBytes(enc.encode(JSON.stringify(refusal)), managedRowWireId(create), create).error?.outcome, "unknown");
assert.equal(managedRowFailureKnowledge({ published: true, timedOut: true }), "unknown");
assert.equal(managedRowFailureKnowledge({ published: false, prePublicationRefusal: true }), "not-executed");
assert.equal(managedRowFailureKnowledge({ published: true, noRespondersSentinel: true }), "not-executed");
assert.equal(managedRowFailureKnowledge({ published: true, reply }), "executed");

const legacy = enc.encode(JSON.stringify({ ok: true, id: managedRowWireId(create), data }));
assert.throws(() => parseManagedRowReplyBytes(legacy, managedRowWireId(create), create), /version/i);

console.log("managed-row standard envelope core smoke: ok");
