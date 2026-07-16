/**
 * The D13 (4) admission-mediator smoke (SPEC §13.6/§13.8/§13.9): the create-fence + proof-gated
 * admission over a LIVE broker, the per-class decision coordinates (epf + self), self-class
 * crash recovery (landed / re-apply / superseded), and the immutable-policy stage → drain →
 * promote cycle with the drain-window pause. Includes the round-5 fold coverage: the
 * revision/space/opId-bound drain witness, the policy-scoped drain (target-only rows survive),
 * accepted-EPF route reconciliation before quiescence, post-create recheck movement, and
 * cross-process accept.
 *
 * Runs against a real nats-server with JetStream (no callout needed: the mediator is a trusted
 * writer over the records store). Broker killed by exact PID; never pkill nats-server.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, recordAtomicKey, GOVERN_HEAD, LIFECYCLE_HEAD,
  createRecordEntry, updateRecordEntry, readRecordLeader, contractDigest,
  epfSubject, epfStreamName, epwSubject, readLastFact, parseDecisionFact,
} from "@cotal-ai/core";
import { drainTargetForEndpoint } from "../src/index.js";
import {
  openLifecycleRegistry, openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, obtainSelfObligation,
  acceptSelfObligation, recoverSelfObligation, settleEpfOrSelfObligation, assertAdmissionProof, verifyAdmissionProof,
  readEnforcedPolicy, publishPolicyVersion, stagePolicySelector, promotePolicySelector,
  drainEndpointPolicy, type MediatedRequest,
} from "../src/index.js";
import { publishFactCreateOnly } from "@cotal-ai/core";
import { activateLifecycle } from "../src/lifecycle-registry.js";
import { registryStores } from "../src/lifecycle-registry.js";
import type { CommitValue } from "../src/admission-mediator.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const rejectsSync = (n: string, fn: () => unknown, code?: string): void => {
  try { fn(); c(n, false, "no throw"); } catch (e) { c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();
/** A wire fingerprint = the canonical digest of a distinguishing object (sha256:<hex>, the shape
 *  core's fact validators accept). */
const fp = (tag: string): string => contractDigest({ fp: tag });
/** A self commit intent from a record value: digest is the canonical value digest; bytes are a
 *  b64u JSON encoding of the value (the applier parses them). */
const commitOf = (value: unknown): { commitValue: CommitValue; commitDigest: string } => ({
  commitValue: { enc: "b64u", bytes: Buffer.from(enc.encode(JSON.stringify(value))).toString("base64url") },
  commitDigest: contractDigest(value),
});
const applyCommit = async (recordsKv: import("@nats-io/kv").KV, k: string, bytes: Uint8Array): Promise<void> => {
  await createRecordEntry(recordsKv, k, JSON.parse(dec.decode(bytes)));
};

const SPACE = "medsmoke";
const SPACE_B = "medsmokeb";
const EP = "term";
const MGR = "mgr-1";
const NOW = 1_700_000_000_000;
const CALLER = { owner: "local", actor: "caller", uid: "u".repeat(26) };
/** Build the BRANDED mediated request from an authenticated `epj` journal subject carrying the
 *  caller triple (the coordinate identity is subject-derived, never a body field). */
const mkReq = (cc: { owner: string; actor: string; uid: string }): MediatedRequest =>
  mediatedRequestFromSubject(`cotal.${SPACE}.epj.${EP}.admit.${cc.owner}.${cc.actor}.${cc.uid}`);

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-medsmoke-"));
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
jetstream { store_dir: "${sd}" }
accounts { APP: { jetstream: enabled, users = [ { user: "auth", password: "pw" } ] } }
`);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

let nc: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://auth:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "auth", pass: "pw" });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE_B);
  const reg = await openLifecycleRegistry(nc, SPACE);
  const { recordsKv } = registryStores(reg);
  let clock = NOW;
  const med = await openAdmissionMediator(nc, SPACE, EP, { now: () => clock, proofTtlMs: 1000 });
  const drainDeps = { applyCommit: (k: string, b: Uint8Array) => applyCommit(recordsKv, k, b), reconcileAcceptedRoute: async () => {} };

  console.log("A. the govern head + immutable content-addressed policy version");
  const policyV1 = await publishPolicyVersion(reg, EP, { capacity: 10, v: 1 });
  c("a published policy version keys on its own canonical value digest (self-certifying)", policyV1.key === `policy.${EP}.${policyV1.digestHex}` && policyV1.digestHex.length === 64);
  // RFC-8785: property ORDER does not change the key (a conforming impl content-addresses the same).
  const policyV1reordered = await publishPolicyVersion(reg, EP, { v: 1, capacity: 10 });
  c("re-publishing the same value with reordered keys lands on the SAME key (canonical, order-insensitive)", policyV1reordered.key === policyV1.key && policyV1reordered.revision === policyV1.revision);
  const govKey = recordAtomicKey(GOVERN_HEAD, [EP]);
  await createRecordEntry(recordsKv, govKey, { commands: {}, enforcedPolicyKey: policyV1.key, enforcedPolicyRevision: policyV1.revision });
  const enforced = await readEnforcedPolicy(med);
  c("the mediator reads the enforced policy leader-served + self-certified", (enforced.policy as { capacity: number }).capacity === 10 && enforced.revision === policyV1.revision);

  console.log("B. a target-bound epf obligation: create-fence, proof, join, settle (core-valid rejection)");
  const actT = await activateLifecycle(reg, { owner: "local", actor: "target", managerInstance: MGR });
  const tgt = { owner: "local", actor: "target", lifecycleUid: actT.mapping.lifecycleUid };
  const got = await obtainEpfObligation(med, mkReq(CALLER), { target: tgt, id: "req0001", fingerprint: fp("A"), sourceSeq: 7, route: "effects" });
  c("a target-bound epf obtain wins its row (provisional, epf-class, pinned mappingRevision)",
    got.row.state === "provisional" && got.row.decision === "epf" && got.row.mappingRevision === actT.revision && !got.joined, got.row);
  assertAdmissionProof(med, got.proof, got.key);
  c("its proof validates against the mediator + obligation key", true);
  const gotAgain = await obtainEpfObligation(med, mkReq(CALLER), { target: tgt, id: "req0001", fingerprint: fp("A"), sourceSeq: 9, route: "effects" });
  c("a redelivery with the same identity JOINS the winner (never a second obligation)", gotAgain.joined && gotAgain.key === got.key, { joined: gotAgain.joined });
  await rejects("a bad fingerprint shape refuses at obtain (must be sha256:<hex>, so the settle fact is core-valid)",
    () => obtainEpfObligation(med, mkReq(CALLER), { target: tgt, id: "req0002", fingerprint: "fp1", sourceSeq: 1, route: "effects" }), "failed-precondition");
  await rejects("sourceSeq 0 refuses at obtain (a decision fact needs a positive sourceSeq)",
    () => obtainEpfObligation(med, mkReq(CALLER), { target: tgt, id: "req0003", fingerprint: fp("z"), sourceSeq: 0, route: "effects" }), "failed-precondition");
  await rejects("a mismatched fingerprint on the same acceptance key refuses (conflict, not a second row)",
    () => obtainEpfObligation(med, mkReq(CALLER), { target: tgt, id: "req0001", fingerprint: fp("DIFFERENT"), sourceSeq: 1, route: "effects" }), "conflict");
  const settled = await settleEpfOrSelfObligation(med, got.key, "the smoke drains it");
  c("settling an unresolved epf row publishes its terminal rejection", settled === "rejected");
  // The rejection fact is CORE-VALID (consume it through parseDecisionFact, not a cast) and lands
  // on the caller-triple decision subject (proving the key offset).
  {
    const decSubject = epfSubject(SPACE, EP, ["dec", CALLER.owner, CALLER.actor, CALLER.uid, "req0001"]);
    const factRaw = await readLastFact(await jetstreamManager(nc!), epfStreamName(SPACE), decSubject);
    const fact = parseDecisionFact(factRaw, decSubject); // throws if the mediator emitted a core-invalid fact
    c("…the rejection fact PARSES via parseDecisionFact and is the caller's rejection", fact.decision === "rejected" && fact.caller.id === `${CALLER.owner}.${CALLER.actor}` && fact.caller.lifecycleUid === CALLER.uid, fact);
  }
  await rejects("a re-obtain on a settled acceptance key refuses (a settled identity never re-admits)",
    () => obtainEpfObligation(med, mkReq(CALLER), { target: tgt, id: "req0001", fingerprint: fp("A"), sourceSeq: 7, route: "effects" }), "failed-precondition");

  console.log("C. the create-fence refuses a non-active target");
  await rejects("an epf obtain against an UNKNOWN target refuses (a non-current target admits nothing)",
    () => obtainEpfObligation(med, mkReq(CALLER), { target: { owner: "local", actor: "ghost", lifecycleUid: "g".repeat(26) }, id: "req0009", fingerprint: fp("g"), sourceSeq: 1, route: "effects" }), "failed-precondition");

  console.log("D. a self-class obligation: accept → guarded commit → terminal, and the post-create recheck");
  const recKey = `svc.${EP}.${"i".repeat(26)}.status`;
  const desired = { epoch: 2, state: "running", observedSpecRevision: 1 };
  const selfGot = await obtainSelfObligation(med, mkReq(CALLER), { policy: true, id: "self0001", commit: { commitKey: recKey, commitBaseRevision: 0, ...commitOf(desired) } });
  c("a self obtain wins a self-class row pinning the complete commit intent + policyRevision",
    selfGot.row.decision === "self" && selfGot.row.policyRevision === policyV1.revision && selfGot.row.commit?.commitKey === recKey, selfGot.row);
  await acceptSelfObligation(med, selfGot.proof);
  await createRecordEntry(recordsKv, recKey, desired);
  const recovered = await recoverSelfObligation(med, selfGot.key, { applyCommit: async () => { throw new Error("should not re-apply a landed commit"); } });
  c("recovering an accepted self row whose commit LANDED drives it to terminal (landed)", recovered === "landed");
  // POST-CREATE RECHECK MOVEMENT: a target-bound obtain whose target head moves between the create
  // and the recheck settles its own provisional and refuses (no proof issues). Model it: obtain
  // wins + pins the head revision, then the head moves (a revision bump), then a JOINing obtain
  // rechecks the moved head and refuses.
  {
    const actM = await activateLifecycle(reg, { owner: "local", actor: "mover", managerInstance: MGR });
    const tgtM = { owner: "local", actor: "mover", lifecycleUid: actM.mapping.lifecycleUid };
    const g1 = await obtainEpfObligation(med, mkReq(CALLER), { target: tgtM, id: "mv0001", fingerprint: fp("mv"), sourceSeq: 1, route: "effects" });
    c("the mover obtain wins under the active head", g1.row.state === "provisional" && g1.row.mappingRevision === actM.revision);
    // Bump the mover head revision (same active mapping) so its pinned mappingRevision is stale.
    await updateRecordEntry(recordsKv, recordAtomicKey(LIFECYCLE_HEAD, ["local", "mover"]), { ...actM.mapping }, actM.revision);
    await rejects("a join whose pinned target head revision has moved refuses at the recheck (no proof issues)",
      () => obtainEpfObligation(med, mkReq(CALLER), { target: tgtM, id: "mv0001", fingerprint: fp("mv"), sourceSeq: 1, route: "effects" }), "failed-precondition");
  }

  console.log("E. self recovery RE-APPLIES from pinned bytes, and SUPERSEDES a moved record");
  const recKey2 = `svc.${EP}.${"j".repeat(26)}.status`;
  const desired2 = { epoch: 3, state: "running", observedSpecRevision: 1 };
  const selfGot2 = await obtainSelfObligation(med, mkReq({ ...CALLER, uid: "v".repeat(26) }), { policy: true, id: "self0002", commit: { commitKey: recKey2, commitBaseRevision: 0, ...commitOf(desired2) } });
  await acceptSelfObligation(med, selfGot2.proof);
  let reappliedBytes: Uint8Array | undefined;
  const recovered2 = await recoverSelfObligation(med, selfGot2.key, { applyCommit: async (k, bytes) => { reappliedBytes = bytes; await applyCommit(recordsKv, k, bytes); } });
  c("recovering an accepted self row whose commit DID NOT run re-applies the pinned bytes (re-applied)", recovered2 === "re-applied" && reappliedBytes !== undefined);
  const written = await readRecordLeader(await jetstreamManager(nc), SPACE, recKey2);
  c("…and the re-applied record is exactly the pinned value", written !== undefined && (written.value as { epoch: number }).epoch === 3);
  // SUPERSEDED: the record already moved PAST the commit's base revision to a foreign value.
  const recKey3 = `svc.${EP}.${"k".repeat(26)}.status`;
  await createRecordEntry(recordsKv, recKey3, { epoch: 1, state: "old", observedSpecRevision: 1 });
  const moved = await readRecordLeader(await jetstreamManager(nc), SPACE, recKey3);
  const selfGot3 = await obtainSelfObligation(med, mkReq({ ...CALLER, uid: "s".repeat(26) }), { policy: true, id: "self0003", commit: { commitKey: recKey3, commitBaseRevision: (moved!.revision + 5), ...commitOf({ epoch: 9, state: "wanted", observedSpecRevision: 1 }) } });
  await acceptSelfObligation(med, selfGot3.proof);
  const recovered3 = await recoverSelfObligation(med, selfGot3.key, { applyCommit: async () => { throw new Error("must not re-apply a superseded commit"); } });
  c("recovering an accepted self row whose record moved PAST its base is superseded (never re-applies)", recovered3 === "superseded");
  // CROSS-PROCESS ACCEPT: a NEW mediator instance (a restarted writer) joins the provisional and accepts.
  const recKey4 = `svc.${EP}.${"m".repeat(26)}.status`;
  const commit4 = commitOf({ epoch: 4, state: "running", observedSpecRevision: 1 });
  const selfGot4 = await obtainSelfObligation(med, mkReq({ ...CALLER, uid: "x".repeat(26) }), { policy: true, id: "self0004", commit: { commitKey: recKey4, commitBaseRevision: 0, ...commit4 } });
  const medReborn = await openAdmissionMediator(nc!, SPACE, EP, { now: () => clock, proofTtlMs: 1000 });
  const rejoin = await obtainSelfObligation(medReborn, mkReq({ ...CALLER, uid: "x".repeat(26) }), { policy: true, id: "self0004", commit: { commitKey: recKey4, commitBaseRevision: 0, ...commit4 } });
  c("a restarted writer (new mediator) JOINS its own provisional self obligation", rejoin.joined && rejoin.key === selfGot4.key);
  await acceptSelfObligation(medReborn, rejoin.proof);
  const rec4 = await recoverSelfObligation(medReborn, rejoin.key, { applyCommit: async (k, b) => applyCommit(recordsKv, k, b) });
  c("…and the reborn writer drives its accepted obligation to terminal", rec4 === "re-applied");

  console.log("F. stage → policy-scoped drain → promote, the pause, and the bound witness");
  const policyV2 = await publishPolicyVersion(reg, EP, { capacity: 20, v: 2 });
  // A TARGET-ONLY provisional that the policy drain must NOT touch (it is not policy-governed).
  const targetOnly = await obtainEpfObligation(med, mkReq({ ...CALLER, uid: "t".repeat(26) }), { target: tgt, id: "tonly001", fingerprint: fp("t"), sourceSeq: 3, route: "effects" });
  c("a target-only (no policy pin) provisional exists before the stage", targetOnly.row.policyRevision === undefined && targetOnly.row.mappingRevision !== undefined);
  await stagePolicySelector(reg, EP, policyV2.key);
  await rejects("a policy-admitted obtain PAUSES while a pendingPolicy is staged (the drain window)",
    () => obtainSelfObligation(med, mkReq({ ...CALLER, uid: "w".repeat(26) }), { policy: true, id: "paused1", commit: { commitKey: `svc.${EP}.pw.status`, commitBaseRevision: 0, ...commitOf({ a: 1 }) } }), "failed-precondition");
  c("…and readEnforcedPolicy itself refuses inside the drain window", await (async () => { try { await readEnforcedPolicy(med); return false; } catch (e) { return e instanceof EpEnvelopeError && e.code === "failed-precondition"; } })());
  const drain = await drainEndpointPolicy(med, drainDeps);
  c("the policy drain reaches quiescence (target-only row ignored, not settled)", drain.passes >= 1);
  c("…the target-only provisional SURVIVES the policy drain (still provisional, not burned)",
    (await (async () => { const r = await readRecordLeader(await jetstreamManager(nc!), SPACE, targetOnly.key); return (r?.value as { state?: string })?.state; })()) === "provisional");
  // A cross-space witness reuse refuses (attack A): the SAME content-addressed policy staged in
  // space B, promoted with space A's witness.
  {
    const regB = await openLifecycleRegistry(nc!, SPACE_B);
    const kvB = registryStores(regB).recordsKv;
    const pV2b = await publishPolicyVersion(regB, EP, { capacity: 20, v: 2 });
    const pV1b = await publishPolicyVersion(regB, EP, { capacity: 10, v: 1 });
    await createRecordEntry(kvB, recordAtomicKey(GOVERN_HEAD, [EP]), { commands: {}, enforcedPolicyKey: pV1b.key, enforcedPolicyRevision: pV1b.revision });
    await stagePolicySelector(regB, EP, pV2b.key);
    await rejects("space A's drain witness cannot promote space B's identical staged mutation (cross-space refuse)",
      () => promotePolicySelector(regB, EP, drain.quiescence), "permission-denied");
  }
  const promoted = await promotePolicySelector(reg, EP, drain.quiescence);
  c("promote moves pending → enforced (v2 now governs)", promoted.enforcedPolicyKey === policyV2.key && promoted.enforcedPolicyRevision === policyV2.revision);
  c("…and the mediator admits again under the new enforced policy (capacity 20)", ((await readEnforcedPolicy(med)).policy as { capacity: number }).capacity === 20);
  await rejects("the CONSUMED witness cannot promote a second time (a witness authorizes exactly one promote)",
    () => promotePolicySelector(reg, EP, drain.quiescence), "failed-precondition");
  // A hand-assembled witness never authorizes a promote.
  await stagePolicySelector(reg, EP, policyV1.key);
  await rejects("a hand-assembled drain witness never authorizes a promote",
    () => promotePolicySelector(reg, EP, { space: SPACE, endpoint: EP, pendingPolicyKey: policyV1.key, pendingPolicyRevision: policyV1.revision, mutationOpId: "x".repeat(26), governStageRevision: 1 } as never), "failed-precondition");

  console.log("H. the round-6 fold: state-aware proof, TTL cap, decision-winner bind");
  // TTL cap: an unbounded proof TTL is refused at open.
  await rejects("an over-cap proofTtlMs is refused (a proof is bounded-lived)",
    () => openAdmissionMediator(nc!, SPACE, EP, { now: () => clock, proofTtlMs: 10 * 60_000 }), "failed-precondition");
  // State-aware proof: a self obtain's proof is INERT once a drain settles its row, even though
  // its brand/bind/expiry still look valid (state-blind assertAdmissionProof would pass).
  {
    const sg = await obtainSelfObligation(med, mkReq({ ...CALLER, uid: "q".repeat(26) }), { target: tgt, id: "state01", commit: { commitKey: `svc.${EP}.st.status`, commitBaseRevision: 0, ...commitOf({ v: 1 }) } });
    assertAdmissionProof(med, sg.proof, sg.key); // structural check still passes
    await settleEpfOrSelfObligation(med, sg.key, "the smoke settles it before accept");
    await rejects("acceptSelfObligation refuses once a drain settled the row (state-aware proof, not state-blind)",
      () => acceptSelfObligation(med, sg.proof), "failed-precondition");
    await rejects("verifyAdmissionProof refuses a settled row's proof directly",
      () => verifyAdmissionProof(med, sg.proof, sg.key), "failed-precondition");
  }
  // Decision-winner bind: a decision fact on an obligation's coordinate carrying a FOREIGN
  // acceptance identity (different fingerprint) never silently settles the obligation.
  {
    const dg = await obtainEpfObligation(med, mkReq({ ...CALLER, uid: "d".repeat(26) }), { target: tgt, id: "bind01", fingerprint: fp("REAL"), sourceSeq: 5, route: "effects" });
    const decSubject = epfSubject(SPACE, EP, ["dec", CALLER.owner, CALLER.actor, "d".repeat(26), "bind01"]);
    // Hand-publish a rejection fact with a DIFFERENT fingerprint on the coordinate.
    const foreign = { v: 1, id: "bind01", decision: "rejected", fingerprint: fp("FOREIGN"), error: { code: "failed-precondition" }, caller: { id: `${CALLER.owner}.${CALLER.actor}`, lifecycleUid: "d".repeat(26) }, sourceSeq: 9, ts: NOW };
    await publishFactCreateOnly(registryStores(reg).js, decSubject, enc.encode(JSON.stringify(foreign)));
    await rejects("a foreign-fingerprint decision fact on the coordinate NEVER settles the obligation (fail loud)",
      () => settleEpfOrSelfObligation(med, dg.key, "the smoke tries to settle"), "internal");
  }

  console.log("I. the obligation identity is broker-derived, not a body field (B1 structural half)");
  {
    // A hand-assembled MediatedRequest (not from mediatedRequestFromSubject) never authorizes.
    const forged: MediatedRequest = { endpoint: EP, caller: { owner: "local", actor: "caller", uid: "u".repeat(26) } };
    await rejects("a hand-assembled request (bypassing the subject parser) refuses (identity is subject-derived)",
      () => obtainEpfObligation(med, forged, { target: tgt, id: "forge1", fingerprint: fp("f"), sourceSeq: 1, route: "effects" }), "permission-denied");
    // A request parsed from a FOREIGN endpoint's subject refuses at THIS endpoint's mediator.
    const foreignReq = mediatedRequestFromSubject(`cotal.${SPACE}.epj.other.admit.local.caller.${"u".repeat(26)}`);
    await rejects("a request whose subject names a DIFFERENT endpoint refuses (a mediator admits only its own endpoint)",
      () => obtainEpfObligation(med, foreignReq, { target: tgt, id: "foreign1", fingerprint: fp("f"), sourceSeq: 1, route: "effects" }), "permission-denied");
    // A non-request/journal subject refuses at construction.
    rejectsSync("a non-request subject refuses at mediatedRequestFromSubject (only request/journal carry an authenticated caller)",
      () => mediatedRequestFromSubject(`cotal.${SPACE}.epf.${EP}.dec.whatever`), "failed-precondition");
    // The obligation KEY carries the SUBJECT's caller triple, proving the coordinate is
    // subject-derived (the id is the only caller-chosen token).
    const idg = await obtainEpfObligation(med, mkReq({ owner: "local", actor: "caller", uid: "n".repeat(26) }), { target: tgt, id: "subj001", fingerprint: fp("s"), sourceSeq: 1, route: "effects" });
    c("the obligation key embeds the SUBJECT-derived caller triple", idg.key === `oblig.${tgt.lifecycleUid}.${EP}.local.caller.${"n".repeat(26)}.subj001`, idg.key);
  }

  console.log("J. the round-7 fold: commit-digest integrity at obtain, sourceSeq bind, accepted-EPF postcondition");
  {
    // B2: a self obtain whose b64u value does NOT digest to commitDigest refuses AT OBTAIN,
    // never reaching accepted where recovery would wedge the drain.
    const realCommit = commitOf({ x: 1 });
    await rejects("a self obtain whose value does not canonically digest to commitDigest refuses at obtain",
      () => obtainSelfObligation(med, mkReq({ ...CALLER, uid: "a".repeat(26) }), { target: tgt, id: "mm0001", commit: { commitKey: `svc.${EP}.mm.status`, commitBaseRevision: 0, commitValue: { enc: "b64u", bytes: Buffer.from(enc.encode(JSON.stringify({ x: 2 }))).toString("base64url") }, commitDigest: realCommit.commitDigest } }), "failed-precondition");
    // b64u that is not canonical base64url (stray pad bits) refuses.
    await rejects("a non-canonical base64url commit value refuses at obtain",
      () => obtainSelfObligation(med, mkReq({ ...CALLER, uid: "b".repeat(26) }), { target: tgt, id: "mm0002", commit: { commitKey: `svc.${EP}.mm.status`, commitBaseRevision: 0, commitValue: { enc: "b64u", bytes: "eyJhIjoxfR" }, commitDigest: contractDigest({ a: 1 }) } }), "failed-precondition");
    // A ref to a non-immutable (non-policy) key refuses.
    await rejects("a commit-value ref to a non-immutable key refuses at obtain",
      () => obtainSelfObligation(med, mkReq({ ...CALLER, uid: "c".repeat(26) }), { target: tgt, id: "mm0003", commit: { commitKey: `svc.${EP}.mm.status`, commitBaseRevision: 0, commitValue: { enc: "ref", key: `svc.${EP}.x.status` }, commitDigest: contractDigest({ a: 1 }) } }), "failed-precondition");

    // H2: a decision fact with the row's fingerprint + route but a FOREIGN sourceSeq never settles it.
    const sg = await obtainEpfObligation(med, mkReq({ ...CALLER, uid: "e".repeat(26) }), { target: tgt, id: "ss0001", fingerprint: fp("SS"), sourceSeq: 11, route: "effects" });
    {
      const decSubject = epfSubject(SPACE, EP, ["dec", CALLER.owner, CALLER.actor, "e".repeat(26), "ss0001"]);
      const foreignSeq = { v: 1, id: "ss0001", decision: "rejected", fingerprint: fp("SS"), error: { code: "failed-precondition" }, caller: { id: `${CALLER.owner}.${CALLER.actor}`, lifecycleUid: "e".repeat(26) }, sourceSeq: 99, ts: NOW };
      await publishFactCreateOnly(registryStores(reg).js, decSubject, enc.encode(JSON.stringify(foreignSeq)));
      await rejects("a decision fact with a FOREIGN sourceSeq (same fp/route) never settles the obligation",
        () => settleEpfOrSelfObligation(med, sg.key, "the smoke tries to settle"), "internal");
    }

    // B4: an ACCEPTED pool-routed epf row whose EPW item is MISSING fails the drain (the drain
    // owns the postcondition; a no-op reconciler cannot fake it), and a reconciler that
    // establishes the item lets the drain reach quiescence. Uses a FRESH isolated target so the
    // drain sees only this row (the earlier probes left poisoned provisionals under `tgt`).
    const actB4 = await activateLifecycle(reg, { owner: "local", actor: "b4target", managerInstance: MGR });
    const tgtB4 = { owner: "local", actor: "b4target", lifecycleUid: actB4.mapping.lifecycleUid };
    const POOL = "workpool";
    const pg = await obtainEpfObligation(med, mkReq({ ...CALLER, uid: "f".repeat(26) }), { target: tgtB4, id: "acc001", fingerprint: fp("P"), sourceSeq: 4, route: `pool.${POOL}` });
    await updateRecordEntry(recordsKv, pg.key, { ...pg.row, state: "accepted" }, pg.revision); // canonicalizer accepted it
    await rejects("a drain over an accepted pool row with a MISSING EPW item + no-op reconciler fails closed (postcondition unmet)",
      () => drainTargetForEndpoint(med, tgtB4.lifecycleUid, { applyCommit: (k, b) => applyCommit(recordsKv, k, b), reconcileAcceptedRoute: async () => {} }), "unavailable");
    const epwSubj = epwSubject(SPACE, EP, POOL, { owner: CALLER.owner, actor: CALLER.actor, uid: "f".repeat(26), id: "acc001" });
    const reconcileEnqueues = async () => { await registryStores(reg).js.publish(epwSubj, enc.encode(JSON.stringify({ item: 1 }))); };
    const drained = await drainTargetForEndpoint(med, tgtB4.lifecycleUid, { applyCommit: (k, b) => applyCommit(recordsKv, k, b), reconcileAcceptedRoute: reconcileEnqueues });
    c("…a reconciler that establishes the EPW item lets the drain reach quiescence (postcondition met)", drained.passes >= 1 && drained.reconciledAcceptedEpf >= 1, drained);
  }

  console.log("G. a proof never crosses endpoints or outlives its TTL");
  const medOther = await openAdmissionMediator(nc, SPACE, "other", { now: () => clock, proofTtlMs: 1000 });
  const g2 = await obtainEpfObligation(med, mkReq({ ...CALLER, uid: "y".repeat(26) }), { target: tgt, id: "req0100", fingerprint: fp("p"), sourceSeq: 1, route: "effects" });
  rejectsSync("a proof issued by endpoint A refuses at endpoint B's mediator", () => assertAdmissionProof(medOther, g2.proof, g2.key), "permission-denied");
  clock += 2000; // past the 1000ms TTL
  rejectsSync("an expired proof refuses (the current obligation state is re-checked, never the stale proof)", () => assertAdmissionProof(med, g2.proof, g2.key), "deadline-exceeded");

  await nc.drain().catch(() => {});
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  try { await nc?.close(); } catch { /* closed */ }
  broker.kill("SIGKILL"); // exact PID — never pkill nats-server
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nADMISSION MEDIATOR SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nADMISSION MEDIATOR SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
