/**
 * The D13 (4) admission-mediator smoke (SPEC §13.6/§13.8/§13.9): the create-fence + proof-gated
 * admission over a LIVE broker, the per-class decision coordinates (epf + self), self-class
 * crash recovery (landed / re-apply / superseded), and the immutable-policy stage → drain →
 * promote cycle with the drain-window admission pause.
 *
 * Runs against a real nats-server with JetStream (no callout needed: the mediator is a trusted
 * writer over the records store). Broker killed by exact PID; never pkill nats-server.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, recordAtomicKey, GOVERN_HEAD,
  createRecordEntry, updateRecordEntry, readRecordLeader, epfSubject, epfStreamName, readLastFact,
} from "@cotal-ai/core";
import {
  openLifecycleRegistry, openAdmissionMediator, obtainEpfObligation, obtainSelfObligation,
  acceptSelfObligation, recoverSelfObligation, settleEpfOrSelfObligation, assertAdmissionProof,
  readEnforcedPolicy, publishPolicyVersion, stagePolicySelector, promotePolicySelector,
  drainEndpointPolicy,
} from "../src/index.js";
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();
const sha256hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const SPACE = "medsmoke";
const EP = "term";
const MGR = "mgr-1";
const NOW = 1_700_000_000_000;
const CALLER = { owner: "local", actor: "caller", uid: "u".repeat(26) };

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
  const reg = await openLifecycleRegistry(nc, SPACE);
  const { recordsKv } = registryStores(reg);
  let clock = NOW;
  const med = await openAdmissionMediator(nc, SPACE, EP, { now: () => clock, proofTtlMs: 1000 });

  console.log("A. the govern head + immutable policy version (publish is content-addressed + idempotent)");
  const policyV1 = await publishPolicyVersion(reg, EP, { capacity: 10, v: 1 });
  c("a published policy version keys on its own value digest (self-certifying)", policyV1.key === `policy.${EP}.${policyV1.digestHex}` && policyV1.digestHex.length === 64);
  const policyV1again = await publishPolicyVersion(reg, EP, { capacity: 10, v: 1 });
  c("re-publishing identical bytes is idempotent (same key, same revision)", policyV1again.key === policyV1.key && policyV1again.revision === policyV1.revision);
  // Enforce v1 by CASing the selector onto the govern head directly (the registration path owns
  // this; the smoke seeds it).
  const govKey = recordAtomicKey(GOVERN_HEAD, [EP]);
  await createRecordEntry(recordsKv, govKey, { commands: {}, enforcedPolicyKey: policyV1.key, enforcedPolicyRevision: policyV1.revision });
  const enforced = await readEnforcedPolicy(med);
  c("the mediator reads the enforced policy leader-served + self-certified", (enforced.policy as { capacity: number }).capacity === 10 && enforced.revision === policyV1.revision);

  console.log("B. a target-bound epf obligation: create-fence, proof, join, settle");
  const actT = await activateLifecycle(reg, { owner: "local", actor: "target", managerInstance: MGR });
  const tgt = { owner: "local", actor: "target", lifecycleUid: actT.mapping.lifecycleUid };
  const got = await obtainEpfObligation(med, { target: tgt, caller: CALLER, id: "req0001", fingerprint: "fp1", sourceSeq: 7, route: "effects" });
  c("a target-bound epf obtain wins its row (provisional, epf-class, pinned mappingRevision)",
    got.row.state === "provisional" && got.row.decision === "epf" && got.row.mappingRevision === actT.revision && !got.joined, got.row);
  assertAdmissionProof(med, got.proof, got.key);
  c("its proof validates against the mediator + obligation key", true);
  // A byte-identical retry JOINS the same winner (same fingerprint + route).
  const gotAgain = await obtainEpfObligation(med, { target: tgt, caller: CALLER, id: "req0001", fingerprint: "fp1", sourceSeq: 9, route: "effects" });
  c("a redelivery with the same identity JOINS the winner (never a second obligation)", gotAgain.joined && gotAgain.key === got.key, { joined: gotAgain.joined });
  // A DIFFERENT fingerprint on the same key is a conflict.
  await rejects("a mismatched fingerprint on the same acceptance key refuses (conflict, not a second row)",
    () => obtainEpfObligation(med, { target: tgt, caller: CALLER, id: "req0001", fingerprint: "DIFFERENT", sourceSeq: 1, route: "effects" }), "conflict");
  // Settle it through the decision coordinate (a rejection); a re-obtain then refuses.
  const settled = await settleEpfOrSelfObligation(med, got.key, "the smoke drains it");
  c("settling an unresolved epf row publishes its terminal rejection", settled === "rejected");
  // The rejection fact lands on the EPF decision subject keyed by the CALLER TRIPLE + id (NOT the
  // endpoint token): read it back at exactly that subject and confirm it is the caller's rejection.
  {
    const decSubject = epfSubject(SPACE, EP, ["dec", CALLER.owner, CALLER.actor, CALLER.uid, "req0001"]);
    const factRaw = await readLastFact(await jetstreamManager(nc!), epfStreamName(SPACE), decSubject);
    const fact = factRaw as { decision?: string; caller?: { id?: string; lifecycleUid?: string } } | undefined;
    c("…the rejection fact is on the caller-triple decision subject (proves the key is parsed at the right offset)",
      fact?.decision === "rejected" && fact?.caller?.id === `${CALLER.owner}.${CALLER.actor}` && fact?.caller?.lifecycleUid === CALLER.uid, fact);
  }
  await rejects("a re-obtain on a settled acceptance key refuses (a settled identity never re-admits)",
    () => obtainEpfObligation(med, { target: tgt, caller: CALLER, id: "req0001", fingerprint: "fp1", sourceSeq: 7, route: "effects" }), "failed-precondition");

  console.log("C. the create-fence refuses a non-active target");
  await rejects("an epf obtain against an UNKNOWN target refuses (a non-current target admits nothing)",
    () => obtainEpfObligation(med, { target: { owner: "local", actor: "ghost", lifecycleUid: "g".repeat(26) }, caller: CALLER, id: "req0009", fingerprint: "fp", sourceSeq: 1, route: "effects" }), "failed-precondition");

  console.log("D. a self-class obligation: accept → guarded commit → terminal, and the drain-race");
  const recKey = `svc.${EP}.${"i".repeat(26)}.status`;
  const desired = enc.encode(JSON.stringify({ epoch: 2, state: "running", observedSpecRevision: 1 }));
  const commit: CommitValue = { enc: "b64u", bytes: Buffer.from(desired).toString("base64url") };
  const selfGot = await obtainSelfObligation(med, {
    policy: true, caller: CALLER, id: "self0001",
    commit: { commitKey: recKey, commitBaseRevision: 0, commitValue: commit, commitDigest: sha256hex(desired) },
  });
  c("a self obtain wins a self-class row pinning the complete commit intent + policyRevision",
    selfGot.row.decision === "self" && selfGot.row.policyRevision === policyV1.revision && selfGot.row.commit?.commitKey === recKey, selfGot.row);
  await acceptSelfObligation(med, selfGot.proof);
  // Under the accepted row, run the guarded commit (create-only the status record), then recover
  // drives the row to terminal (it reads the record digests to the intent = LANDED).
  await createRecordEntry(recordsKv, recKey, JSON.parse(dec.decode(desired)));
  const recovered = await recoverSelfObligation(med, selfGot.key, { applyCommit: async () => { throw new Error("should not re-apply a landed commit"); } });
  c("recovering an accepted self row whose commit LANDED drives it to terminal (landed)", recovered === "landed");

  console.log("E. self-class recovery RE-APPLIES a crashed-before-commit intent from the pinned bytes");
  const recKey2 = `svc.${EP}.${"j".repeat(26)}.status`;
  const desired2 = enc.encode(JSON.stringify({ epoch: 3, state: "running", observedSpecRevision: 1 }));
  const selfGot2 = await obtainSelfObligation(med, {
    policy: true, caller: { ...CALLER, uid: "v".repeat(26) }, id: "self0002",
    commit: { commitKey: recKey2, commitBaseRevision: 0, commitValue: { enc: "b64u", bytes: Buffer.from(desired2).toString("base64url") }, commitDigest: sha256hex(desired2) },
  });
  await acceptSelfObligation(med, selfGot2.proof);
  // The writer CRASHED before its commit: the record does not exist. Recovery re-applies the
  // pinned bytes then terminalizes.
  let applied: Uint8Array | undefined;
  const recovered2 = await recoverSelfObligation(med, selfGot2.key, { applyCommit: async (k, bytes) => { applied = bytes; await createRecordEntry(recordsKv, k, JSON.parse(dec.decode(bytes))); } });
  c("recovering an accepted self row whose commit DID NOT run re-applies the pinned bytes (re-applied)", recovered2 === "re-applied" && applied !== undefined && sha256hex(applied!) === sha256hex(desired2));
  const written = await readRecordLeader(await jetstreamManager(nc), SPACE, recKey2);
  c("…and the re-applied record is exactly the pinned value", written !== undefined && (written.value as { epoch: number }).epoch === 3);

  console.log("F. the immutable-policy stage → drain → promote cycle with the drain-window pause");
  const policyV2 = await publishPolicyVersion(reg, EP, { capacity: 20, v: 2 });
  await stagePolicySelector(reg, EP, policyV2.key);
  // While a pending policy is staged, a policy-admitted obtain PAUSES (create-fence refusal).
  await rejects("a policy-admitted obtain PAUSES while a pendingPolicy is staged (the drain window)",
    () => obtainSelfObligation(med, { policy: true, caller: { ...CALLER, uid: "w".repeat(26) }, id: "paused1", commit: { commitKey: `svc.${EP}.x.status`, commitBaseRevision: 0, commitValue: { enc: "b64u", bytes: "" }, commitDigest: sha256hex(new Uint8Array()) } }), "failed-precondition");
  c("…and readEnforcedPolicy itself refuses inside the drain window (no admission judged against a half-mutated policy)", await (async () => { try { await readEnforcedPolicy(med); return false; } catch (e) { return e instanceof EpEnvelopeError && e.code === "failed-precondition"; } })());
  // Drain to quiescence, then promote under the branded witness.
  const drain = await drainEndpointPolicy(med, { applyCommit: async () => { throw new Error("no accepted self rows expected"); } });
  c("the policy drain reaches quiescence", drain.passes >= 1);
  const promoted = await promotePolicySelector(reg, EP, drain.quiescence);
  c("promote moves pending → enforced (v2 now governs)", promoted.enforcedPolicyKey === policyV2.key && promoted.enforcedPolicyRevision === policyV2.revision);
  const enforced2 = await readEnforcedPolicy(med);
  c("…and the mediator now admits again under the new enforced policy (capacity 20)", (enforced2.policy as { capacity: number }).capacity === 20);
  // A hand-assembled quiescence witness never authorizes a promote.
  await stagePolicySelector(reg, EP, policyV1.key);
  await rejects("a hand-assembled drain witness never authorizes a promote",
    () => promotePolicySelector(reg, EP, { endpoint: EP, pendingPolicyKey: policyV1.key } as never), "failed-precondition");

  console.log("G. a proof never crosses endpoints or outlives its TTL");
  const medOther = await openAdmissionMediator(nc, SPACE, "other", { now: () => clock, proofTtlMs: 1000 });
  const g2 = await obtainEpfObligation(med, { target: tgt, caller: { ...CALLER, uid: "y".repeat(26) }, id: "req0100", fingerprint: "fp", sourceSeq: 1, route: "effects" });
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

function rejectsSync(n: string, fn: () => unknown, code?: string): void {
  try { fn(); c(n, false, "no throw"); } catch (e) { c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`); }
}

console.log(fail === 0 ? `\nADMISSION MEDIATOR SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nADMISSION MEDIATOR SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
