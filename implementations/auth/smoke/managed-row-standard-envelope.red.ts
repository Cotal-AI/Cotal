import assert from "node:assert/strict";
import { authAdminListenerGrants, handleManagedRowNativeRequest } from "../src/auth-admin.js";
import {
  createManagedRowAttempt,
  epRequestSubject,
  managedRowEndpointRequest,
  managedRowSuccessReply,
  managedRowWireId,
  parseEndpointReply,
  parseEpSubject,
  type CreateManagedRowIntent,
  type EndpointRequest,
  type RevokeManagedRowIntent,
} from "@cotal-ai/core";

const enc = new TextEncoder();
const dec = new TextDecoder();
const caller = { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "manager", uid: "aaaaaaaaaaaaaaaaaaaaaaaaaa" };
const target = { owner: caller.owner, actor: "worker", lifecycleUid: "cccccccccccccccccccccccccc" };
const responder = { endpoint: "auth", instanceId: "dddddddddddddddddddddddddd", epoch: 7 };
const create: CreateManagedRowIntent = {
  ver: 1, command: "create-managed-row", requestId: "request_aaaaaaaa", operationId: "manager-spawn:cccccccccccccccccccccccccc",
  space: "task84", target, tokenHash: "a".repeat(64), scope: ["run", "spawn"], allowSubscribe: ["general"], allowPublish: ["general"],
};
const revoke: RevokeManagedRowIntent = {
  ver: 1, command: "revoke-managed-row", requestId: "request_bbbbbbbb", operationId: "manager-revoke:cccccccccccccccccccccccccc",
  space: "task84", target,
};

function subject(intent: CreateManagedRowIntent | RevokeManagedRowIntent, nonce: string) {
  const raw = epRequestSubject("task84", {
    route: { mode: "one" }, endpoint: "auth", command: intent.command, caller, nonce,
    ...(intent.command === "revoke-managed-row" ? { target: { mode: "ledger" as const, tOwner: intent.target.owner } } : {}),
  });
  const parsed = parseEpSubject(raw);
  assert(parsed && parsed.plane === "request");
  return parsed;
}

function body(env: EndpointRequest): Uint8Array { return enc.encode(JSON.stringify(env)); }
function result(intent: CreateManagedRowIntent | RevokeManagedRowIntent): Uint8Array {
  return enc.encode(JSON.stringify(managedRowSuccessReply(managedRowWireId(intent), {
    ver: 1, command: intent.command, requestId: intent.requestId, operationId: intent.operationId, target: intent.target,
    state: intent.command === "create-managed-row" ? "live" : "tombstone", targetDigest: `sha256:${"b".repeat(64)}`, historyHead: "c".repeat(64),
  })));
}

let effects = 0;
const baseDeps = {
  admit: async () => {},
  resolveTarget: async () => ({ lifecycleUid: target.lifecycleUid, mappingRevision: 42 }),
  execute: async ({ finalAdmission, assertPreEffectOpen }: { finalAdmission(): Promise<void>; assertPreEffectOpen(): void }) => {
    await finalAdmission();
    assertPreEffectOpen();
    effects++;
    return result(create);
  },
};

const attempt = createManagedRowAttempt(caller, create, Buffer.alloc(16, 1), undefined, { bind: { instanceId: responder.instanceId, epoch: responder.epoch } });
const env = managedRowEndpointRequest(attempt, 1_000);
const exact = await handleManagedRowNativeRequest("task84", subject(create, attempt.nonce), body(env), baseDeps, { responder });
assert.equal(parseEndpointReply(JSON.parse(dec.decode(exact))).ok, true);
assert.equal(JSON.parse(dec.decode(exact)).v, 1);
assert.equal(effects, 1);

await assert.rejects(
  () => handleManagedRowNativeRequest("task84", subject(create, attempt.nonce), enc.encode(JSON.stringify({ id: managedRowWireId(create), intent: create })), baseDeps, { responder }),
  /request|envelope|version/i,
);

for (const [label, mutate] of [
  ["digest", (v: EndpointRequest) => ({ ...v, op: { ...v.op, outputDigest: `sha256:${"0".repeat(64)}` } })],
  ["class", (v: EndpointRequest) => ({ ...v, class: "journal" as const, replyExpected: false })],
  ["verb", (v: EndpointRequest) => ({ ...v, replyExpected: false })],
  ["from", (v: EndpointRequest) => ({ ...v, from: { id: "u_bbbbbbbbbbbbbbbbbbbbbbbbbb.manager", name: "manager" } })],
  ["target", (v: EndpointRequest) => ({ ...v, target })],
  ["bind", (v: EndpointRequest) => ({ ...v, bind: { instanceId: "eeeeeeeeeeeeeeeeeeeeeeeeee", epoch: responder.epoch } })],
  ["bind-epoch", (v: EndpointRequest) => ({ ...v, bind: { instanceId: responder.instanceId, epoch: responder.epoch + 1 } })],
] as const) {
  const before = effects;
  await assert.rejects(() => handleManagedRowNativeRequest("task84", subject(create, attempt.nonce), body(mutate(env)), baseDeps, { responder }), undefined, label);
  assert.equal(effects, before, label);
}

const revokeAttempt = createManagedRowAttempt(caller, revoke, Buffer.alloc(16, 2), undefined, {
  bind: { instanceId: responder.instanceId, epoch: responder.epoch }, mappingRevision: 42,
});
const revokeEnv = managedRowEndpointRequest(revokeAttempt, 1_000);
let revokeEffects = 0;
const revokeDeps = {
  ...baseDeps,
  execute: async ({ finalAdmission, assertPreEffectOpen }: { finalAdmission(): Promise<void>; assertPreEffectOpen(): void }) => {
    await finalAdmission(); assertPreEffectOpen(); revokeEffects++; return result(revoke);
  },
};
await handleManagedRowNativeRequest("task84", subject(revoke, revokeAttempt.nonce), body(revokeEnv), revokeDeps, { responder });
assert.equal(revokeEffects, 1);
for (const alteredTarget of [
  { ...target, actor: "foreign", mappingRevision: 42 },
  { ...target, lifecycleUid: "eeeeeeeeeeeeeeeeeeeeeeeeee", mappingRevision: 42 },
]) {
  await assert.rejects(() => handleManagedRowNativeRequest("task84", subject(revoke, revokeAttempt.nonce), body({ ...revokeEnv, target: alteredTarget }), revokeDeps, { responder }), /target|lifecycle/i);
  assert.equal(revokeEffects, 1);
}
await assert.rejects(() => handleManagedRowNativeRequest("task84", subject(revoke, revokeAttempt.nonce), body(revokeEnv), {
  ...revokeDeps, resolveTarget: async () => ({ lifecycleUid: target.lifecycleUid, mappingRevision: 43 }),
}, { responder }), /revision|expired/i);
assert.equal(revokeEffects, 1);

await assert.rejects(() => handleManagedRowNativeRequest("task84", subject(revoke, revokeAttempt.nonce), body(revokeEnv), {
  ...revokeDeps, resolveTarget: async () => undefined,
}, { responder }), /mapping|expired|absent/i);
assert.equal(revokeEffects, 1);

const grants = authAdminListenerGrants("task84", "conn12345", responder);
assert.equal(grants.subscribe.some((row) => row.includes("create-managed-row")), true);
console.log("managed-row standard envelope listener RED target: passed");
