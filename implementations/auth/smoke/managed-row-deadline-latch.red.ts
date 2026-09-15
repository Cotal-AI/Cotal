import assert from "node:assert/strict";
import { handleManagedRowNativeRequest } from "../src/auth-admin.js";
import {
  createManagedRowAttempt,
  epRequestSubject,
  managedRowEndpointRequest,
  managedRowSuccessReply,
  managedRowWireId,
  parseEpSubject,
  type CreateManagedRowIntent,
} from "@cotal-ai/core";

const caller = { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "manager", uid: "aaaaaaaaaaaaaaaaaaaaaaaaaa" };
const intent: CreateManagedRowIntent = {
  ver: 1, command: "create-managed-row", requestId: "request_deadline", operationId: "manager-spawn:cccccccccccccccccccccccccc",
  space: "task84", target: { owner: caller.owner, actor: "worker", lifecycleUid: "cccccccccccccccccccccccccc" },
  tokenHash: "a".repeat(64), scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"],
};
const responder = { endpoint: "auth", instanceId: "dddddddddddddddddddddddddd", epoch: 7 };
const attempt = createManagedRowAttempt(caller, intent, Buffer.alloc(16, 9), undefined, { bind: { instanceId: responder.instanceId, epoch: responder.epoch } });
const parsed = parseEpSubject(epRequestSubject("task84", { route: { mode: "one" }, endpoint: "auth", command: intent.command, caller, nonce: attempt.nonce }));
assert(parsed && parsed.plane === "request");
const request = managedRowEndpointRequest(attempt, 50);

let now = 100;
let timer: (() => void) | undefined;
let releaseFinal!: () => void;
const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
let enteredFinal = false;
let effects = 0;
const exact = new TextEncoder().encode(JSON.stringify(managedRowSuccessReply(managedRowWireId(intent), {
  ver: 1, command: intent.command, requestId: intent.requestId, operationId: intent.operationId, target: intent.target,
  state: "live", targetDigest: `sha256:${"b".repeat(64)}`, historyHead: "c".repeat(64),
})));

const pending = handleManagedRowNativeRequest("task84", parsed, new TextEncoder().encode(JSON.stringify(request)), {
  admit: async ({ phase }: { phase: "initial" | "final" }) => {
    if (phase === "final") { enteredFinal = true; await finalGate; }
  },
  resolveTarget: async () => ({ lifecycleUid: intent.target.lifecycleUid, mappingRevision: 1 }),
  execute: async ({ finalAdmission, assertPreEffectOpen }: { finalAdmission(): Promise<void>; assertPreEffectOpen(): void }) => {
    await finalAdmission();
    assertPreEffectOpen();
    effects++;
    return exact;
  },
}, {
  responder,
  clock: {
    now: () => now,
    setTimer: (run: () => void) => { timer = run; return 1; },
    clearTimer: () => {},
  },
});

await Promise.race([
  (async () => { while (!enteredFinal) await new Promise((resolve) => setImmediate(resolve)); })(),
  pending.then(() => { throw new Error("request settled before final admission"); }, (error) => { throw error; }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("fixture did not reach final admission within 1s")), 1_000)),
]);
now = 151;
assert(timer, "deadline timer was armed");
timer();
releaseFinal();
await assert.rejects(() => pending, (error: unknown) => error instanceof Error && /deadline/i.test(error.message));
assert.equal(effects, 0, "a final admission continuation completing after deadline must not enter the mutation region");

let initialNow = 200;
let initialTimer: (() => void) | undefined;
let releaseInitial!: () => void;
const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
let enteredInitial = false;
let initialEffects = 0;
const initialPending = handleManagedRowNativeRequest("task84", parsed, new TextEncoder().encode(JSON.stringify(request)), {
  admit: async ({ phase }: { phase: "initial" | "final" }) => {
    if (phase === "initial") { enteredInitial = true; await initialGate; }
  },
  resolveTarget: async () => ({ lifecycleUid: intent.target.lifecycleUid, mappingRevision: 1 }),
  execute: async () => { initialEffects++; return exact; },
}, {
  responder,
  clock: {
    now: () => initialNow,
    setTimer: (run: () => void) => { initialTimer = run; return 2; },
    clearTimer: () => {},
  },
});
await Promise.race([
  (async () => { while (!enteredInitial) await new Promise((resolve) => setImmediate(resolve)); })(),
  initialPending.then(() => { throw new Error("request settled before initial admission"); }, (error) => { throw error; }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("fixture did not reach initial admission within 1s")), 1_000)),
]);
initialNow = 251;
assert(initialTimer, "initial deadline timer was armed");
initialTimer();
releaseInitial();
await assert.rejects(() => initialPending, /deadline/i);
assert.equal(initialEffects, 0, "an initial admission continuation completing after deadline must not dispatch the executor");

let postNow = 300;
let postTimer: (() => void) | undefined;
let effectStarted = false;
let releaseEffect!: () => void;
const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
const postPending = handleManagedRowNativeRequest("task84", parsed, new TextEncoder().encode(JSON.stringify(request)), {
  admit: async () => {},
  resolveTarget: async () => ({ lifecycleUid: intent.target.lifecycleUid, mappingRevision: 1 }),
  execute: async ({ finalAdmission, assertPreEffectOpen }: { finalAdmission(): Promise<void>; assertPreEffectOpen(): void }) => {
    await finalAdmission(); assertPreEffectOpen(); effectStarted = true; await effectGate; return exact;
  },
}, {
  responder,
  clock: { now: () => postNow, setTimer: (run: () => void) => { postTimer = run; return 3; }, clearTimer: () => {} },
});
await Promise.race([
  (async () => { while (!effectStarted) await new Promise((resolve) => setImmediate(resolve)); })(),
  postPending.then(() => { throw new Error("request settled before effect start"); }, (error) => { throw error; }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("fixture did not reach effect start within 1s")), 1_000)),
]);
postNow = 351;
assert(postTimer, "post-effect deadline timer was armed");
postTimer();
releaseEffect();
await assert.rejects(() => postPending, (error: unknown) => error instanceof Error && /unknown|deadline/i.test(error.message));

console.log("managed-row monotonic deadline latch RED target: passed");
