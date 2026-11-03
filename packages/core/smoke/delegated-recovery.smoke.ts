import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAccount } from "@nats-io/nkeys";
import { contractDigest, mintLifecycleUid, newIdentity } from "../src/index.js";
import { managedRuntimeKey } from "../src/managed-handoff.js";
import {
  DELEGATED_RECOVERY_REASONS,
  parseDelegatedRecoveryDescriptor,
  parseRemoteDelegatedRecoveryLaunchRequest,
  parseRemoteDelegatedRecoveryRequest,
  parseRemoteDelegatedRecoveryResult,
} from "../src/delegated-recovery.js";
import { parseRemoteDelegatedUserIntentExecutionRequest } from "../src/remote-manager-authority.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: unknown): string => contractDigest(value).slice("sha256:".length);
const uid = mintLifecycleUid;
const account = createAccount();
const envelope = {
  v: 1, kind: "manager-delegated-recovery", actor: "cli", space: "recovery-test",
  accountPublicKey: account.getPublicKey(), assignmentRevision: 3, instanceId: uid(),
  managerLifecycleUid: uid(), currentRegistrationRevision: 7, serveEpoch: 9,
  registrationProof: "sha256:" + "a".repeat(64), requestId: randomBytes(16).toString("base64url"),
  identities: Object.fromEntries(["supervisor", "executor", "serve", "goalWriter", "sessionLedger"].map(name => [name, { id: newIdentity().id }])),
};
account.clear();
const target = { owner: "u_" + "a".repeat(26), actor: "child", lifecycleUid: uid() };
const intentId = uid();
const origin = {
  space: envelope.space, accountPublicKey: envelope.accountPublicKey,
  managerInstanceId: envelope.instanceId, managerLifecycleUid: envelope.managerLifecycleUid,
  assignmentRevision: envelope.assignmentRevision, enrollmentRegistrationRevision: 2,
  enrollmentRegistrationDigest: "b".repeat(64), enrollmentServeEpoch: 1, intentId, target: clone(target),
};
const binding = {
  scanId: uid(), accountPublicKey: envelope.accountPublicKey, managerInstanceId: envelope.instanceId,
  managerLifecycleUid: envelope.managerLifecycleUid, assignmentRevision: envelope.assignmentRevision,
  currentRegistrationRevision: envelope.currentRegistrationRevision, currentServeEpoch: envelope.serveEpoch,
  sourceRevision: 5, memberCount: 1, membersDigest: "c".repeat(64),
};
const proof = { storeBindingDigest: "d".repeat(64), storeIdentityDigest: "e".repeat(64), actorTokenDigest: "f".repeat(64), sentinelDigest: "0".repeat(64) };
const authority = { ...target, scope: ["spawn"], allowSubscribe: ["team"], allowPublish: ["team"], role: "worker", parent: target.owner + ".operator" };
const plan = { agent: "native", events: true, sourceDigest: "1".repeat(64) };
const descriptor = {
  v: 1, intentId, origin: clone(origin), target: clone(target), runtimeKind: "container",
  runtimeKey: managedRuntimeKey({ space: envelope.space, ...target }),
  launchIdentity: { ...plan, role: "worker", spawner: authority.parent, authorityParent: authority.parent },
  authorityDigest: hash(authority), localStoreBindingDigest: proof.storeBindingDigest,
  localStoreIdentityDigest: proof.storeIdentityDigest,
};
const retained = {
  intentId, intentRevision: 10, recoveryRevision: 4, target: clone(target), phase: "eligible",
  descriptor: clone(descriptor), descriptorDigest: hash(descriptor), authority: clone(authority),
  localProof: clone(proof), startedAt: "2026-10-14T00:00:00.000Z", executionIdentityDigest: "2".repeat(64), reasonCode: null,
};
const bodies = {
  confirm: { intentId, target: clone(target), expectedIntentRevision: 9, localProof: clone(proof) },
  scan: {},
  claim: { intentId, target: clone(target), expectedRecoveryRevision: 3, expectedOrigin: clone(origin), attemptId: uid(), scanBinding: clone(binding) },
  settle: { claimId: uid(), expectedRecoveryRevision: 4, settleId: uid(), observation: "held", reasonCode: "provider-unknown" },
  finish: { scanBinding: clone(binding), finishId: uid(), expectedScopeRevision: 5 },
  watch: { afterRevision: 0 },
};
type Operation = keyof typeof bodies;
const request = (operation: Operation, body: unknown = bodies[operation]) => ({ ...clone(envelope), operation, body: clone(body) });
const parse = (operation: Operation, body: unknown = bodies[operation]) => parseRemoteDelegatedRecoveryRequest(request(operation, body));
const reply = (operation: Operation, result: unknown) => {
  const { actor: _actor, registrationProof: _proof, identities: _identities, ...header } = envelope;
  return { ...clone(header), operation, ok: true, result: clone(result) };
};
const results = {
  confirm: { intentId, target: clone(target), intentRevision: 10, recoveryRevision: 4, prepared: true },
  scan: { scanBinding: clone(binding), records: [clone(retained)], nextCursor: null, complete: true },
  claim: { claimId: uid(), attemptId: bodies.claim.attemptId, record: clone(retained), claimEpoch: envelope.serveEpoch },
  settle: { claimId: bodies.settle.claimId, settleId: bodies.settle.settleId, recoveryRevision: 5, observation: "held" },
  finish: { finishId: bodies.finish.finishId, scanId: binding.scanId, scopeRevision: 6, admission: "open" },
  watch: { revision: 2, scanInvalidated: true },
};
const launch = () => {
  const { currentRegistrationRevision: _revision, ...header } = envelope;
  return { ...clone(header), kind: "manager-delegated-user-intent-execution", intentId, execute: {
    operation: "launch", target: { actor: target.actor, tokenHash: proof.actorTokenDigest },
    recoveryPlan: { runtimeKind: "container", launch: clone(plan), localStoreBindingDigest: proof.storeBindingDigest, localStoreIdentityDigest: proof.storeIdentityDigest },
  } };
};

const cases: [string, () => void][] = [];
const add = (name: string, run: () => void): void => { cases.push([name, run]); };
for (const operation of Object.keys(bodies) as Operation[]) add(`accept ${operation}`, () => { assert.equal(parse(operation).operation, operation); });
add("accept bound settlement", () => { assert.equal(parse("settle", { claimId: bodies.settle.claimId, expectedRecoveryRevision: 4, settleId: uid(), observation: "bound", executionIdentityDigest: "3".repeat(64) }).operation, "settle"); });
for (const [field, value] of [
  ["registrationProof", "a".repeat(64)], ["requestId", "short"], ["identities", {}],
  ["actor", "bad.actor"], ["instanceId", "bad-instance"], ["managerLifecycleUid", "bad-lifecycle"],
] as const) add(`reject stock-invalid ${field}`, () => { assert.throws(() => parseRemoteDelegatedRecoveryRequest({ ...request("watch"), [field]: value })); });
add("reject invalid account", () => { assert.throws(() => parseRemoteDelegatedRecoveryRequest({ ...request("watch"), accountPublicKey: "invalid" })); });
add("reject old scan epoch", () => { assert.throws(() => parse("scan", { cursor: "cursor", scanBinding: { ...binding, currentServeEpoch: 8 } })); });
add("reject foreign scan manager", () => { assert.throws(() => parse("scan", { cursor: "cursor", scanBinding: { ...binding, managerInstanceId: uid() } })); });
add("reject cursor without binding", () => { assert.throws(() => parse("scan", { cursor: "cursor" })); });
add("reject binding without cursor", () => { assert.throws(() => parse("scan", { scanBinding: binding })); });
add("reject unknown credential", () => { assert.throws(() => parseRemoteDelegatedRecoveryRequest({ ...request("watch"), actorToken: "not allowed" })); });
add("reject nested private identity", () => { const r = request("watch"); Object.assign(r.identities.supervisor, { seed: "not allowed" }); assert.throws(() => parseRemoteDelegatedRecoveryRequest(r)); });
add("reject inherited required envelope", () => { const r = request("watch"); const proto = { requestId: r.requestId }; Reflect.deleteProperty(r, "requestId"); Object.setPrototypeOf(r, proto); assert.throws(() => parseRemoteDelegatedRecoveryRequest(r)); });
add("reject nonenumerable unknown field", () => { const r = request("watch"); Object.defineProperty(r, "secret", { value: "not allowed" }); assert.throws(() => parseRemoteDelegatedRecoveryRequest(r)); });
add("reject symbol field", () => { const r = request("watch"); Object.defineProperty(r, Symbol("secret"), { value: "not allowed" }); assert.throws(() => parseRemoteDelegatedRecoveryRequest(r)); });
add("reject claim target change", () => { assert.throws(() => parse("claim", { ...bodies.claim, target: { ...target, lifecycleUid: uid() } })); });
add("reject claim intent change", () => { assert.throws(() => parse("claim", { ...bodies.claim, intentId: uid() })); });
add("reject origin assignment change", () => { assert.throws(() => parse("claim", { ...bodies.claim, expectedOrigin: { ...origin, assignmentRevision: 4 } })); });
add("reject mixed settlement", () => { assert.throws(() => parse("settle", { ...bodies.settle, executionIdentityDigest: "3".repeat(64) })); });
add("reject held without reason", () => { const body = clone(bodies.settle); Reflect.deleteProperty(body, "reasonCode"); assert.throws(() => parse("settle", body)); });
add("reject finish old epoch", () => { assert.throws(() => parse("finish", { ...bodies.finish, scanBinding: { ...binding, currentServeEpoch: 8 } })); });
add("accept descriptor", () => { assert.equal(parseDelegatedRecoveryDescriptor(descriptor).intentId, intentId); });
add("reject wrong runtime key", () => { assert.throws(() => parseDelegatedRecoveryDescriptor({ ...descriptor, runtimeKey: "cotal-" + "0".repeat(32) })); });
add("reject platform owner", () => { assert.throws(() => parseDelegatedRecoveryDescriptor({ ...descriptor, target: { ...target, owner: "p_" + "a".repeat(26) } })); });
add("reject parent from another owner", () => { const parent = "u_" + "b".repeat(26) + ".operator"; assert.throws(() => parseDelegatedRecoveryDescriptor({ ...descriptor, launchIdentity: { ...descriptor.launchIdentity, spawner: parent, authorityParent: parent } })); });
add("reject substituted spawner", () => { assert.throws(() => parseDelegatedRecoveryDescriptor({ ...descriptor, launchIdentity: { ...descriptor.launchIdentity, spawner: target.owner + ".other" } })); });
add("reject descriptor prompt", () => { assert.throws(() => parseDelegatedRecoveryDescriptor({ ...descriptor, launchIdentity: { ...descriptor.launchIdentity, prompt: "not retained" } })); });
add("reject malformed descriptor uid", () => { assert.throws(() => parseDelegatedRecoveryDescriptor({ ...descriptor, target: { ...target, lifecycleUid: "short" } })); });
add("accept opt-in launch", () => { assert.equal(parseRemoteDelegatedRecoveryLaunchRequest(launch()).execute.operation, "launch"); });
add("legacy parser refuses opt-in launch", () => { assert.throws(() => parseRemoteDelegatedUserIntentExecutionRequest(launch())); });
add("reject launch credential", () => { const r = launch(); Object.assign(r.execute.recoveryPlan, { actorToken: "not allowed" }); assert.throws(() => parseRemoteDelegatedRecoveryLaunchRequest(r)); });
add("reject retirement with recovery plan", () => { const r = launch(); r.execute.operation = "retire"; assert.throws(() => parseRemoteDelegatedRecoveryLaunchRequest(r)); });
add("reject launch bare proof", () => { const r = launch(); r.registrationProof = "a".repeat(64); assert.throws(() => parseRemoteDelegatedRecoveryLaunchRequest(r)); });
add("accept watch reply", () => { assert.equal(parseRemoteDelegatedRecoveryResult(reply("watch", results.watch), parse("watch")).ok, true); });
add("reject reply request mismatch", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult({ ...reply("watch", results.watch), requestId: randomBytes(16).toString("base64url") }, parse("watch"))); });
add("reject reply raw token", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult({ ...reply("watch", results.watch), actorToken: "not allowed" }, parse("watch"))); });
const failure = () => { const r: Record<string, unknown> = reply("watch", results.watch); Reflect.deleteProperty(r, "result"); return { ...r, ok: false, error: { code: "unavailable", reasonCode: "authority-unavailable" } }; };
add("accept bounded error reply", () => { assert.equal(parseRemoteDelegatedRecoveryResult(failure(), parse("watch")).ok, false); });
add("reject mixed reply", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult({ ...failure(), result: results.watch }, parse("watch"))); });
add("accept complete scan page", () => { assert.equal(parseRemoteDelegatedRecoveryResult(reply("scan", results.scan), parse("scan")).ok, true); });
add("reject page changed binding", () => { const body = { scanBinding: clone(binding), cursor: "cursor" }; assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, scanBinding: { ...binding, sourceRevision: 6 } }), parse("scan", body))); });
add("reject false scan completion", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, nextCursor: "next" }), parse("scan"))); });
add("reject duplicate scan member", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, scanBinding: { ...binding, memberCount: 2 }, records: [retained, retained] }), parse("scan"))); });
add("reject eligible record without proof", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, records: [{ ...retained, executionIdentityDigest: null }] }), parse("scan"))); });
add("reject altered authority digest", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, records: [{ ...retained, authority: { ...authority, scope: ["admin"] } }] }), parse("scan"))); });
add("reject altered descriptor digest", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, records: [{ ...retained, descriptorDigest: "a".repeat(64) }] }), parse("scan"))); });
add("accept claim reply", () => { assert.equal(parseRemoteDelegatedRecoveryResult(reply("claim", results.claim), parse("claim")).ok, true); });
add("reject changed claim target", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("claim", { ...results.claim, record: { ...retained, target: { ...target, lifecycleUid: uid() } } }), parse("claim"))); });
add("reject changed claim origin", () => { const d = clone(descriptor); d.origin.enrollmentRegistrationRevision++; assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("claim", { ...results.claim, record: { ...retained, descriptor: d, descriptorDigest: hash(d) } }), parse("claim"))); });
add("reject old claim epoch", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("claim", { ...results.claim, claimEpoch: 8 }), parse("claim"))); });
add("accept confirmation reply", () => { assert.equal(parseRemoteDelegatedRecoveryResult(reply("confirm", results.confirm), parse("confirm")).ok, true); });
add("reject changed confirmation target", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("confirm", { ...results.confirm, target: { ...target, lifecycleUid: uid() } }), parse("confirm"))); });
add("accept settlement reply", () => { assert.equal(parseRemoteDelegatedRecoveryResult(reply("settle", results.settle), parse("settle")).ok, true); });
add("reject changed settlement observation", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("settle", { ...results.settle, observation: "bound" }), parse("settle"))); });
add("accept finish reply", () => { assert.equal(parseRemoteDelegatedRecoveryResult(reply("finish", results.finish), parse("finish")).ok, true); });
add("reject wrong finished scan", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("finish", { ...results.finish, scanId: uid() }), parse("finish"))); });
add("reject negative watch revision", () => { assert.throws(() => parse("watch", { afterRevision: -1 })); });
add("request parser owns nested copies", () => { const r = request("confirm"); const parsed = parseRemoteDelegatedRecoveryRequest(r); Object.assign(r.body as object, { target: {} }); assert.equal(parsed.operation, "confirm"); if (parsed.operation === "confirm") assert.deepEqual(parsed.body.target, target); });
add("accept reordered binding properties", () => { const b = Object.fromEntries(Object.entries(binding).reverse()); assert.equal(parseRemoteDelegatedRecoveryResult(reply("scan", results.scan), parse("scan", { scanBinding: b, cursor: "cursor" })).ok, true); });
add("reject non-cli envelope actor", () => { assert.throws(() => parseRemoteDelegatedRecoveryRequest({ ...request("watch"), actor: "operator" })); });
add("reject another store proof", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, records: [{ ...retained, localProof: { ...proof, storeIdentityDigest: "9".repeat(64) } }] }), parse("scan"))); });
add("reject invalid birth time", () => { assert.throws(() => parseRemoteDelegatedRecoveryResult(reply("scan", { ...results.scan, records: [{ ...retained, startedAt: "tomorrow" }] }), parse("scan"))); });
add("reject inherited launch envelope", () => { const r = launch(); const proto = { requestId: r.requestId }; Reflect.deleteProperty(r, "requestId"); Object.setPrototypeOf(r, proto); assert.throws(() => parseRemoteDelegatedRecoveryLaunchRequest(r)); });

add("reason allowlist is frozen", () => { assert.equal(Object.isFrozen(DELEGATED_RECOVERY_REASONS), true); });

const EXPECTED_CELLS = 71;
let ran = 0;
for (const [name, run] of cases) {
  try { run(); }
  catch (error) { console.error(`FAIL: ${name}`); throw error; }
  ran++;
  console.log(`ok ${ran} - ${name}`);
}
assert.equal(ran, EXPECTED_CELLS, "delegated recovery cell inventory changed");
console.log(`delegated recovery: ${ran} cells passed`);
