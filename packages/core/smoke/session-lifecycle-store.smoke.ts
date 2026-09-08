/** Broker-free §4 operation/store invariant smoke using a revisioned in-memory KV. */
import {
  EpEnvelopeError,
  advanceSessionTrustedState,
  assertCurrentSessionFence,
  assertSessionManagementWritable,
  prepareSessionOperation,
  queryOperation,
  sessionOperationInput,
  sessionOperationInputDigest,
  updateSessionOperation,
  hasLiveNativeLifecycleBindingsForManager,
  lookupNativeLifecycleBindingsForManager,
  sessionBindingKey,
  type ResourceKey,
  type SessionOperationRecord,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => { if (value) ok++; else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); } };
const rejects = async (name: string, fn: () => Promise<unknown>, code: string) => {
  try { await fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};
const throws = (name: string, fn: () => unknown, code: string) => {
  try { fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};

type Row = { value: Uint8Array; revision: number; operation: "PUT" };
class MemKv {
  rows = new Map<string, Row>(); seq = 0;
  async get(key: string) { return this.rows.get(key) as never; }
  async put(key: string, value: Uint8Array, opts?: { previousSeq?: number }) {
    const row = this.rows.get(key);
    if ((opts?.previousSeq ?? -1) !== 0 || row) throw Object.assign(new Error("cas"), { code: 10071 });
    const revision = ++this.seq; this.rows.set(key, { value, revision, operation: "PUT" }); return revision;
  }
  async update(key: string, value: Uint8Array, expected: number) {
    const row = this.rows.get(key);
    if (!row || row.revision !== expected) throw Object.assign(new Error("cas"), { code: 10071 });
    const revision = ++this.seq; this.rows.set(key, { value, revision, operation: "PUT" }); return revision;
  }
}
const kv = new MemKv() as unknown as KV;
const resource: ResourceKey = {
  hostIdentity: "host:one", provider: "com.cotal.claude", nativeOwnerNamespace: "uid:1000",
  stableSessionId: "s-1", resourceGeneration: "created:1",
};
const base = {
  operationId: "op-1", resourceKey: resource,
  incarnationProof: { nativeHostIncarnation: "h-1", sessionIncarnation: "s-1", evidence: { immutable: "x" } },
  bindingId: "binding-1", expectedBindingRevision: 4, expectedControllerEpoch: 7,
  authenticatedActor: "u_alice.operator", action: "release" as const,
  intendedResult: { bindingState: "released", nativeState: "preserved" },
};

console.log("A. operation-id input fence and queryOperation");
c("queryOperation reports absent only without a row", (await queryOperation(kv, resource, "op-1")).state === "absent");
const first = await prepareSessionOperation(kv, base);
c("first operation prepare is created and queryable", first.created && (await queryOperation(kv, resource, "op-1")).state === "prepared");
const retry = await prepareSessionOperation(kv, { ...base, intendedResult: { nativeState: "preserved", bindingState: "released" } });
c("same operation input in different object-key order returns the recorded prepare", !retry.created && retry.record.inputDigest === first.record.inputDigest);
await rejects("reused operationId with DIFFERENT input is refused", () => prepareSessionOperation(kv, { ...base, action: "control", intendedResult: { input: "x" } }), "conflict");

const row = (kv as unknown as MemKv).rows.values().next().value as Row;
const terminal: SessionOperationRecord = {
  ...first.record,
  state: "terminal-success",
  result: { bindingState: "released" },
  proofOrigin: { kind: "receiver-receipt", receiver: "native-1", highestEpoch: 7, proves: "native-effect" },
};
await rejects("phase update cannot rewrite the operation's immutable input", () => updateSessionOperation(kv, {
  ...terminal,
  authenticatedActor: "u_alice.attacker",
  inputDigest: sessionOperationInputDigest(sessionOperationInput({ ...base, authenticatedActor: "u_alice.attacker" })),
}, row.revision), "conflict");
await updateSessionOperation(kv, terminal, row.revision);
const result = await queryOperation(kv, resource, "op-1");
c("queryOperation returns terminal result and native proof origin", result.state === "terminal-success" && result.proofOrigin?.proves === "native-effect" && (result.result as { bindingState: string }).bindingState === "released");
const journalOnly: SessionOperationRecord = {
  ...terminal,
  proofOrigin: { kind: "journal-receipt", journalRevision: 9, proves: "journal-transition-only" },
};
await rejects("a journal receipt cannot prove terminal native success", () => updateSessionOperation(kv, journalOnly, (kv as unknown as MemKv).rows.values().next().value!.revision), "internal");

console.log("B. monotonic trusted state, rollback read-only, and retired fences");
const state1 = await advanceSessionTrustedState(kv, resource, { epochFloor: 7, retireBindingIds: ["binding-old"] });
c("trusted state records the epoch floor and retired binding id", state1.epochFloor === 7 && state1.retiredBindingIds.includes("binding-old") && state1.managementMode === "writable");
const state2 = await advanceSessionTrustedState(kv, resource, { epochFloor: 3, retireBindingIds: ["binding-older"] });
c("epoch floor never resets and retired ids are unioned", state2.epochFloor === 7 && state2.retiredBindingIds.join(",") === "binding-old,binding-older");
const rolled = await advanceSessionTrustedState(kv, resource, { epochFloor: 3, observedNativeEpochFloor: 9 });
c("a store restored below the live receiver floor starts management recovery-read-only", rolled.epochFloor === 9 && rolled.managementMode === "management-recovery-read-only");
throws("recovery-read-only blocks management writes", () => assertSessionManagementWritable(rolled), "failed-precondition");

const writable = { ...state2, managementMode: "writable" as const };
const recorded = await queryOperation(kv, resource, "op-1");
c("a retired binding retry returns its recorded receipt instead of acting", assertCurrentSessionFence(writable, "binding-old", 7, recorded)?.state === "terminal-success");
throws("a retired binding without a receipt gets a stale rejection", () => assertCurrentSessionFence(writable, "binding-old", 7), "conflict");
throws("an old epoch cannot act on a new binding", () => assertCurrentSessionFence(writable, "binding-new", 6), "conflict");
c("current binding and epoch pass the fence", assertCurrentSessionFence(writable, "binding-new", 7) === undefined);

console.log("C. mutation controls");
c("operation digest covers expected revision/epoch and actor", sessionOperationInputDigest(sessionOperationInput(base)) !== sessionOperationInputDigest(sessionOperationInput({ ...base, expectedBindingRevision: 5 })));
c("operation digest covers incarnation proof", sessionOperationInputDigest(sessionOperationInput(base)) !== sessionOperationInputDigest(sessionOperationInput({ ...base, incarnationProof: { ...base.incarnationProof, sessionIncarnation: "s-2" } })));

console.log("D. fail-closed native-binding shutdown lookup");
const nativeBinding = {
  bindingId: "binding-live", resourceKey: resource, incarnationProof: base.incarnationProof,
  controllerEpoch: 7, managerPrincipal: "u_alice.manager", mode: "cooperative-exclusive" as const,
  rights: ["control", "release"] as const, state: "managed" as const, operationId: "op-live", desiredRevision: 1,
};
const bindingEntry = { key: sessionBindingKey(resource), value: new TextEncoder().encode(JSON.stringify(nativeBinding)), revision: 1, operation: "PUT" as const };
const scanLive = async () => [bindingEntry] as never;
c("live native lifecycle binding is found for its manager", await hasLiveNativeLifecycleBindingsForManager(kv, "u_alice.manager", scanLive));
c("a binding owned by another manager does not block this manager", !(await hasLiveNativeLifecycleBindingsForManager(kv, "u_bob.manager", scanLive)));
const scanLegacyOnly = async () => [] as never;
c("legacy managed seats are outside the sessionbinding family and retain legacy behavior", !(await hasLiveNativeLifecycleBindingsForManager(kv, "u_alice.manager", scanLegacyOnly)));
const scanBroken = async () => { throw new Error("store unavailable"); };
c("unreadable binding store fails closed as possibly live", await hasLiveNativeLifecycleBindingsForManager(kv, "u_alice.manager", scanBroken));
const unknown = await lookupNativeLifecycleBindingsForManager(kv, "u_alice.manager", async () => [{ ...bindingEntry, value: new TextEncoder().encode("not json") }] as never);
c("an unparseable binding row is an explicit unknown lookup", unknown.status === "unknown" && unknown.bindings.length === 0);

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
