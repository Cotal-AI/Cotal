/** Native authority-reader coverage. Retirement markers use the real CAS primitives; this
 * suite does not claim to exercise the barrier's eviction or work-cleaning orchestration. */
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import { createSuite } from "@cotal-ai/smoke-kit";
import { credRowKey, epAuthBucket, isPermissionDenied, lifecycleHeadKey, mintLifecycleUid, recordsBucket,
  retirementFrontierStreams, spaceQuiescenceReaderGrants } from "@cotal-ai/core";
import { activateLifecycle, beginHeadRetirementWithinBarrier, completeHeadRetirementWithinBarrier,
  freezeGate, observeGate, retireGate } from "../src/lifecycle-registry.js";
import { finalizeAgentMint, stageAgentMint, stageIntentKey } from "../src/credential-ledger.js";
import { observeAuthorityQuiescence } from "../src/quiescence-authority.js";
import { openFixture } from "./_service-custody-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await openFixture("quiet-authority", { limited: true });
let readerConnection: NatsConnection | undefined;
const nowMs = Date.now(), expiredAt = nowMs + 60_001;
try {
  if (!fx.user) throw new Error("fixture did not start an operator-mode broker");
  const user = await fx.user("quiescence-reader", id => {
    const grants = spaceQuiescenceReaderGrants(fx.space, id);
    return { pub: grants.pub.allow, sub: grants.sub.allow };
  });
  readerConnection = await connect({ servers: fx.server, authenticator: user.authenticator, inboxPrefix: `_INBOX_${user.id}`, reconnect: false });
  const kvm = new Kvm(readerConnection);
  const auth = await kvm.open(epAuthBucket(fx.space), { allow_direct: false });
  const records = await kvm.open(recordsBucket(fx.space), { allow_direct: false });
  const observe = (at = expiredAt, accountPublicKey = fx.accountPublicKey) =>
    observeAuthorityQuiescence(auth, records, { space: fx.space, accountPublicKey, nowMs: at });
  const clear = async () => { const r = await observe(); return !r.unknown && r.liveAuthorityRows === 0 && r.unsettledAuthorityRows === 0; };
  check("an initialized authority plane without actors is observed clear", await clear());
  const alias = { owner: "local", actor: "worker", managerInstance: "fixture" };
  const activated = await activateLifecycle(fx.reg, alias);
  const uid = activated.mapping.lifecycleUid;
  check("a fully activated alias without credentials has no live authority", await clear());
  const staged = await stageAgentMint(fx.reg, { lifecycleUid: uid, credentialId: "root1", holderPrincipal: "local.worker", sourceChain: ["root"], exp: nowMs + 60_000 });
  await finalizeAgentMint(fx.reg, staged);
  const live = await observe(nowMs);
  check("a canonical unexpired credential blocks idle admission", !live.unknown && live.liveAuthorityRows === 1, live);
  check("ledger expiry is compared in milliseconds", await clear());

  const opId = mintLifecycleUid();
  const intent = { kind: "retirement", lifecycleUid: uid, owner: alias.owner, actor: alias.actor, fromGeneration: 1, frontierStreams: retirementFrontierStreams(fx.space) };
  await fx.auth.put(stageIntentKey(opId), JSON.stringify(intent), { previousSeq: 0 });
  check("a retirement intent preceding its freeze remains unfinished", (await observe()).unsettledAuthorityRows > 0 && !(await observe()).unknown);
  const gate = await observeGate(fx.reg, uid);
  if (!gate) throw new Error("activation did not leave its gate");
  const frozen = await freezeGate(fx.reg, { lifecycleUid: uid, revision: gate.revision, op: { kind: "retirement", opId } });
  const target = { owner: alias.owner, actor: alias.actor, lifecycleUid: uid, opId };
  await beginHeadRetirementWithinBarrier(fx.reg, target);
  check("a frozen gate and retiring head block quiescence", (await observe()).unsettledAuthorityRows > 0 && !(await observe()).unknown);
  await retireGate(fx.reg, { lifecycleUid: uid, revision: frozen.revision, opId });
  check("a retired gate does not hide the unfinished head terminal", (await observe()).unsettledAuthorityRows > 0 && !(await observe()).unknown);
  await completeHeadRetirementWithinBarrier(fx.reg, target);
  check("the completed native retirement markers leave a retained intent without debt", await clear());
  await activateLifecycle(fx.reg, alias);
  check("a same-alias successor does not resurrect the predecessor's completed intent", await clear());

  const invalid = async (label: string, kv: KV, key: string, change: (value: Record<string, unknown>) => unknown) => {
    const entry = await kv.get(key);
    if (!entry) throw new Error("positive authority row missing");
    await kv.put(key, JSON.stringify(change(entry.json<Record<string, unknown>>())));
    check(`${label} is unknown`, (await observe()).unknown);
    await kv.put(key, entry.value);
    check(`${label} has an independently repaired positive control`, !(await observe()).unknown);
  };
  await invalid("a malformed credential expiry", fx.auth, credRowKey(uid, "root1"), row => ({ ...row, exp: "expired" }));
  await invalid("an unknown operation kind", fx.auth, stageIntentKey(opId), row => ({ ...row, kind: "unsupported" }));

  const reservation = fx.reservation();
  const bootstrapped = await fx.bootstrap(reservation);
  const service = await observe();
  check("actual service custody bootstrap rows parse without an ordinary-shape substitution",
    bootstrapped.kind === "active" && !service.unknown && service.liveAuthorityRows === 1, service);
  check("service custody bound to another account is unknown", (await observe(expiredAt, "A".repeat(56))).unknown);
  const keys = fx.keys(reservation);
  if (bootstrapped.kind !== "active") throw new Error("service fixture did not finish its bootstrap");
  await invalid("a malformed service root mirror", fx.auth, keys.root(bootstrapped.root.credentialId), row => ({ ...row, serviceCustody: { v: 1, uidDigest: "wrong" } }));
  await invalid("a malformed service head mirror", fx.records, keys.head, row => ({ ...row, serviceCustody: { v: 1, uidDigest: "wrong" } }));
  const denied = await auth.put(credRowKey(uid, "root1"), "{}").then(() => false, error => { if (!isPermissionDenied(error)) throw error; return true; });
  check("the reader cannot rewrite credential expiry or revocation", denied && !(await observe()).unknown);
  await readerConnection.close();
  check("a closed observation connection gives unknown rather than empty", (await observe()).unknown);
  // The retired predecessor's intent still names the original alias, whose replacement was read above.
  check("the successor head really exists under the canonical alias key", (await fx.records.get(lifecycleHeadKey(alias.owner, alias.actor)))?.operation === "PUT");
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : "unknown failure"}`, false);
} finally {
  await readerConnection?.close();
  await fx.close();
  if (passed() + failed() !== 22) check(`cell count: ran ${passed() + failed()}, expected 22`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
