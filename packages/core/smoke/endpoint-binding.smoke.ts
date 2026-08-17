/**
 * v0.4 §13.12 binding smoke — the per-space control-surface resources against a real ≥2.12
 * broker: idempotent creation, the exact config the table declares (allow_direct split,
 * schedules split, duplicate-window floor, WorkQueue), and the LOAD-BEARING live behaviors the
 * design rests on: the mediated schedule→fire path (fired message carries the broker-authored
 * `Nats-Scheduler` origin; same-subject re-arm replaces, never duplicates), the ADR-51
 * confused-deputy closure (scheduling headers on the schedules-DISABLED request stream cannot
 * cause a fire), auth-store per-key TTL (cred rows expire; the bucket has no age retention),
 * and the EPW reconciliation predicate (an acked item leaves the WorkQueue, an in-flight one
 * stays direct-readable).
 *
 * Run: pnpm smoke:ep-binding   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers, nanos } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams, registerRecordKind, RECORD_KINDS,
  epjStreamName, epfStreamName, epeStreamName, eptReqStreamName, eptStreamName,
  eprStreamName, epwStreamName, epcStreamName, epAuthBucket, recordsBucket, recordsKvStreamName,
  EPJ_DUPLICATE_WINDOW_MS,
  canonDurable, poolDurable, timerWriterDurable, recordWriterDurable, effectsDurable,
  decisionReaderDurable, goalReaderDurable, eventReaderDurable, recordReaderDurable,
  canonConsumerConfig, poolConsumerConfig, timerWriterConsumerConfig,
  recordWriterConsumerConfig, effectsConsumerConfig, decisionReaderConfig, goalReaderConfig,
  eventReaderConfig, recordReaderConfig,
  canonicalizerGrants, canonicalizerWorkGrants, activatorGrants, activatorContext, readPoolOccupancy,
  effectsBindGrants, recordWriterGrants, timerWriterGrants,
  poolOwnerBindGrants, readerBindGrants, provisionerConsumerGrants,
  commitPrincipalGrants, goalWriterGrants, contractPublisherGrants, recordAtomicKey,
  eptSubject, epwSubject, epjSubject, appendSubmission,
  AUTHORITY_KIND_DEFS, callerReadableRecordKind,
  BASELINE_DELIVERY_COMMANDS, BASELINE_SELF_LIFECYCLE_COMMANDS, SPAWN_CREATE_COMMANDS, SPAWN_OWNER_LIFECYCLE_COMMANDS,
  baselineCallerCapabilities, spawnCallerCapabilities, CREDENTIAL_LIFETIMES, credentialLifetime,
  SESSION_TERMINAL_STATES, SCHEMA_PROFILE, BROKER_FLOOR, meetsBrokerFloor,
  EP_AUTHZ_MODES, isEpAuthzMode, VOID_SCHEMA, VOID_SCHEMA_ARTIFACT_DIGEST, contractDigest,
  EP_ERROR_CODES, RESERVED_COMMANDS,
  type EpCaller, type RecordKindDef,
  assertFactRetentionFloor, IDEMPOTENCY_HORIZON_MS_DEFAULT, RECEIPT_RETENTION_MS_DEFAULT,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
// A PASSING CELL PRINTS: `mutation-proof` counts `✓` marks to tell "the mutation applied and no
// cell caught it" apart from "the run died before reaching the cell". A suite silent on success
// reports zero marks, so that protection is inert while the runner still prints a count.
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown) => { try { fn(); c(n, false, "no throw"); } catch { c(n, true); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epbind";
const UID = "u".repeat(26);
const IID = "i".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

// ── name grammar (broker-free) ──
c("stream names are the §13.12 forms",
  epjStreamName(SPACE) === "EPJ_epbind" && epfStreamName(SPACE) === "EPF_epbind"
  && epeStreamName(SPACE) === "EPE_epbind" && eptReqStreamName(SPACE) === "EPT_REQ_epbind"
  && eptStreamName(SPACE) === "EPT_epbind" && eprStreamName(SPACE) === "EPR_epbind"
  && epwStreamName(SPACE) === "EPW_epbind" && epcStreamName(SPACE) === "EPC_epbind"
  && recordsBucket(SPACE) === "cotal_records_epbind" && epAuthBucket(SPACE) === "cotal_auth_epbind");
c("the §13.9 consumer-name grammar builds its documented forms",
  canonDurable("manager") === "canon_manager"
  && poolDurable("manager", "builds") === "pool_manager_builds"
  && timerWriterDurable(SPACE) === "timerw_epbind"
  && recordWriterDurable(SPACE, "svc") === "recw_epbind-svc"
  && effectsDurable("manager") === "eff_manager"
  && decisionReaderDurable(UID, "manager") === `dec_${UID}-manager`
  && goalReaderDurable(UID, "manager") === `goal_${UID}-manager`
  && eventReaderDurable(UID, "manager", "g1", 0) === `eve_${UID}-manager-g1-0`
  && recordReaderDurable(UID, "g1", 1) === `rec_${UID}-g1-1`);
throws("a pool token with an underscore refuses (the LAST-`_` parse is the collision argument)",
  () => poolDurable("manager", "bad_pool"));
throws("a dotted (reverse-DNS) kind refuses a writer durable (dots are illegal in durable names)",
  () => recordWriterDurable(SPACE, "com.example.kind"));
throws("a negative reader subtree index refuses", () => eventReaderDurable(UID, "manager", "g1", -1));

// The event-reader durable name is INJECTIVE: `<gid>` is separator-free, so the two soft
// components `<e>` and `<gid>` can never collide across a `-` (the panel's HIGH finding).
throws("a grant id with a `-` refuses (would make eve_<uid>-<e>-<gid>-<n> non-injective)",
  () => eventReaderDurable(UID, "manager", "g-1", 0));
throws("a grant id with a `_` refuses (same injectivity argument)",
  () => eventReaderDurable(UID, "manager", "g_1", 0));
c("distinct (endpoint, gid) pairs never collide on one eve durable name",
  eventReaderDurable(UID, "a-b", "c", 0) !== eventReaderDurable(UID, "a", "bc", 0));

c("infra consumer configs carry the matrix's full-tail single filters",
  canonConsumerConfig(SPACE, "manager").filter_subject === "cotal.epbind.epj.manager.>"
  && effectsConsumerConfig(SPACE, "manager").filter_subject === "cotal.epbind.epf.manager.dec.>"
  && recordWriterConsumerConfig(SPACE, RECORD_KINDS.svc).filter_subject === "cotal.epbind.epr.*.*.*.svc.>"
  && timerWriterConsumerConfig(SPACE).filter_subject === "cotal.epbind.ept.*.*.*.*.schedule"
  && poolConsumerConfig(SPACE, "manager", "builds").filter_subject === "cotal.epbind.epw.manager.builds.>"
  && decisionReaderConfig(SPACE, "manager", caller).filter_subject === `cotal.epbind.epf.manager.dec.u_abc.worker.${UID}.>`
  && goalReaderConfig(SPACE, "manager", caller).filter_subject === `cotal.epbind.epf.manager.goal.u_abc.worker.${UID}.>`);

// A ZERO-qualifier kind's writer filter is the EXACT kind subject (no `.>`) — `>` needs a
// trailing token, so `<kind>.>` would miss every write for a global (qualifier-free) record.
const globalKind = registerRecordKind({ kind: "com.acme.global", qualifiers: [], split: true, writers: { spec: "x", status: "x" }, mediation: "mediated" });
c("a zero-qualifier kind's writer filter is exact (no trailing `>`, which would match nothing)",
  recordWriterConsumerConfig(SPACE, globalKind).filter_subject === "cotal.epbind.epr.*.*.*.com_acme_global");
c("a qualified kind's writer filter keeps its `.>` tail",
  recordWriterConsumerConfig(SPACE, RECORD_KINDS.goal).filter_subject === "cotal.epbind.epr.*.*.*.goal.>");

// The two dynamic reader families the module now completes: exact full-tail granted subtrees.
const eveSubtree = `cotal.${SPACE}.epe.manager.${IID}.7.goal.u_abc.worker.${UID}.>`;
const recSubtree = `$KV.${recordsBucket(SPACE)}.svc.manager.${IID}.status`;
c("the event-reader config carries its exact granted event subtree + injective durable",
  eventReaderConfig(SPACE, { uid: UID, endpoint: "manager", grantId: "g1", index: 0, subtree: eveSubtree }).filter_subject === eveSubtree);
c("the record-reader config carries its exact $KV granted subtree",
  recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: recSubtree }).filter_subject === recSubtree);
throws("a reader subtree that is not a full literal tail refuses (a relative tail matches nothing)",
  () => eventReaderConfig(SPACE, { uid: UID, endpoint: "manager", grantId: "g1", index: 0, subtree: "epe.manager.foo" }));
// Wildcard confinement at the grant seams: a poisoned name, subtree, or filter component must
// refuse loudly, never broaden an emitted row or reader past the §13.9 matrix — while the
// matrix's NORMATIVE whole-token `*` positions (instanceId/epoch in the per-goal row) admit.
c("the normative per-goal event subtree (interior `*` positions) admits",
  eventReaderConfig(SPACE, { uid: UID, endpoint: "manager", grantId: "g1", index: 0, subtree: `cotal.${SPACE}.epe.manager.*.*.goal.u_abc.worker.${UID}.>` }).filter_subject
    === `cotal.${SPACE}.epe.manager.*.*.goal.u_abc.worker.${UID}.>`);
c("an interior `*` in a granted record subtree admits (all instances of one kind+endpoint)",
  recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.svc.manager.*.status` }).filter_subject
    === `$KV.${recordsBucket(SPACE)}.svc.manager.*.status`);
throws("an event-reader subtree naming a different endpoint than its durable refuses (provenance divergence)",
  () => eventReaderConfig(SPACE, { uid: UID, endpoint: "manager", grantId: "g1", index: 0, subtree: `cotal.${SPACE}.epe.other.${IID}.7.goal.u_abc.worker.${UID}.>` }));
throws("an event-reader subtree wildcarding the endpoint position refuses (provenance must be literal)",
  () => eventReaderConfig(SPACE, { uid: UID, endpoint: "manager", grantId: "g1", index: 0, subtree: `cotal.${SPACE}.epe.*.${IID}.7.goal.u_abc.worker.${UID}.>` }));
throws("a whole-bucket record subtree refuses (a bare `>` tail is not a caller capability)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.>` }));
throws("a cross-kind record subtree refuses (`*` kind reads every registered kind)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.*.>` }));
throws("a mid-subtree `>` refuses (only one TRAILING subtree wildcard)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.svc.>.status` }));
// ENFORCED partition, ALLOWLIST not deny-list (panel + freelance a559d9c re-verify, #8274): a
// reader durable's kind MUST be a registered CALLER-readable record kind, so it can never target
// an authority-control subtree (above all `oblig.`, the sealed scanner's exclusive domain) NOR an
// unregistered kind — both would durably export state past revoke. Driven by AUTHORITY_KIND_DEFS,
// the same canonical collection the registry is built from (no parallel deny-list to drift).
throws("a record-reader on the OBLIG subtree refuses (the sealed scanner's exclusive domain, #8274)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.oblig.${UID}.manager.>` }));
throws("a record-reader on the OBLIG subtree with a `*` target position refuses",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.oblig.*.manager.>` }));
// Every PURE authority kind (kind not also a caller RECORD_KIND) is refused — iterated over the
// canonical collection, so a NEW authority def added to AUTHORITY_KIND_DEFS is covered by
// construction (the anti-drift proof: the exclusion is not a hand-kept parallel list).
for (const def of AUTHORITY_KIND_DEFS) {
  if (callerReadableRecordKind(def.kind)) continue; // dual-token (lifecycle) is head-guarded below
  throws(`a record-reader on the authority-control kind ${def.kind} refuses (authority-only, never a caller read)`,
    () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.${def.kind}.manager.>` }));
}
// An UNREGISTERED kind is refused too (the allowlist rejects it; a deny-list would have let it
// through — the freelance a559d9c finding).
throws("a record-reader on an UNREGISTERED kind refuses (allowlist: only registered caller kinds)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.futureauth.manager.>` }));
// The two allowlist refusals are DISTINCT teaching messages (the ux review): the authority branch
// says forbidden-by-design (no recourse), the unregistered branch says typo-or-registerRecordKind
// (the caller's actual next step). A lumped message half-teaches: the 2am typo case scans a
// forbidden-kinds list its kind is not in and has no next step.
const msgOf = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };
const authMsg = msgOf(() => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.oblig.${UID}.manager.>` }));
c("the authority-kind refusal names the by-design forbidden branch (sealed scanner, no recourse)",
  authMsg.includes("authority-control kind") && authMsg.includes("sealed scanner") && !authMsg.includes("registerRecordKind"), authMsg);
const unregMsg = msgOf(() => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.futureauth.manager.>` }));
c("the unregistered-kind refusal gives the caller's next step (typo / registerRecordKind, §13.7)",
  unregMsg.includes("not a registered record kind") && unregMsg.includes("typo") && unregMsg.includes("registerRecordKind") && !unregMsg.includes("authority-control"), unregMsg);
// DUAL-token (lifecycle): the atomic HEAD `lifecycle.<owner>.<actor>` is authority; deeper per-UID
// audit detail is caller-readable. Head-matching filters refuse; strictly-deeper filters admit.
throws("a lifecycle reader matching the exact HEAD key refuses (the authority mapping, not audit)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.worker` }));
throws("a lifecycle reader `lifecycle.>` refuses (the `>` can match the head)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.>` }));
throws("a lifecycle reader `lifecycle.<owner>.>` refuses (the `>` can still match the head)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.>` }));
c("a lifecycle reader on the per-UID audit DETAIL admits (deeper than the head)",
  recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.worker.${UID}.spec` }).filter_subject
    === `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.worker.${UID}.spec`);
c("a lifecycle reader `lifecycle.<owner>.<actor>.>` admits (strictly deeper than the head, all audit under owner.actor)",
  recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.worker.>` }).filter_subject
    === `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.worker.>`);
// STRICTLY-DEEPER completeness (the fact/contract alignment round): a fully-concrete dual-token
// filter SHALLOWER than the head matches no record at all (head = exact arity, audit = deeper),
// so it is a DEAD grant and refuses loud at mint time — which is what makes the SPEC sentence
// "admits only a filter strictly deeper than the head" true, not an overclaim.
throws("a bare `lifecycle` concrete filter refuses (shallower than the head: a dead grant)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle` }));
throws("a `lifecycle.<owner>` concrete filter refuses (still shallower than the 3-token head)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc` }));
// RUNTIME INTEGRITY of the canonical classification (the security mutability round): `readonly`
// is type-level only, so the collection, every def, and every qualifiers array must be FROZEN,
// and a mutation attempt must THROW (ESM strict mode) — and even after attempted mutation the
// exact head still rejects (the seam consults a private module-load snapshot, not the live
// export). Identity (single source) is not integrity (unchangeable); this proves both.
c("AUTHORITY_KIND_DEFS, every def, and every qualifiers array are runtime-frozen",
  Object.isFrozen(AUTHORITY_KIND_DEFS)
  && AUTHORITY_KIND_DEFS.every((d) => Object.isFrozen(d) && Object.isFrozen(d.qualifiers) && d.qualifiers.every((q) => Object.isFrozen(q)) && Object.isFrozen(d.writers)));
c("RECORD_KINDS and its defs are runtime-frozen too (same public security surface)",
  Object.isFrozen(RECORD_KINDS) && Object.values(RECORD_KINDS).every((d) => Object.isFrozen(d)));
throws("splicing a def OUT of AUTHORITY_KIND_DEFS throws (the guard cannot be removed live)",
  () => (AUTHORITY_KIND_DEFS as unknown as RecordKindDef[]).splice(0, 1));
throws("reassigning a def's kind throws (the classification cannot be re-pointed live)",
  () => { (AUTHORITY_KIND_DEFS[0] as unknown as { kind: string }).kind = "moved"; });
throws("pushing into a def's qualifiers throws (the head arity cannot be re-shaped live)",
  () => (AUTHORITY_KIND_DEFS[0].qualifiers as unknown as unknown[]).push({}));
throws("AFTER the attempted mutations the exact lifecycle head STILL refuses (the seam reads a private snapshot)",
  () => recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lifecycle.u_abc.worker` }));
// The SAME class swept across core's other exported security collections (the freelance cold
// read after afa715b): the baseline grant vocabularies and credential lifetimes sit on the
// MINTING path (a push/reassignment widened every subsequently minted grant, executed repro),
// the session terminal states arm the revocation backstop, the schema profile is the DoS
// ceiling, the broker floor is the startup gate. All runtime-frozen; the minting-path
// consumers read private module-load snapshots.
c("the baseline/spawn command vocabularies are frozen",
  [BASELINE_DELIVERY_COMMANDS, BASELINE_SELF_LIFECYCLE_COMMANDS, SPAWN_CREATE_COMMANDS, SPAWN_OWNER_LIFECYCLE_COMMANDS].every((a) => Object.isFrozen(a)));
throws("pushing a command into the baseline vocabulary throws (no post-import grant widening)",
  () => (BASELINE_SELF_LIFECYCLE_COMMANDS as unknown as string[]).push("attach"));
c("the minted baseline/spawn surfaces are unchanged after the attempted push (private snapshots)",
  baselineCallerCapabilities().length === 4 && spawnCallerCapabilities("u_abc").length === 5);
c("CREDENTIAL_LIFETIMES and every policy are frozen",
  Object.isFrozen(CREDENTIAL_LIFETIMES) && Object.values(CREDENTIAL_LIFETIMES).every((p) => Object.isFrozen(p)));
throws("nulling a one-shot TTL throws (a non-expiring provisioner credential cannot be minted in)",
  () => { (credentialLifetime("provisioner") as { defaultTtlSeconds?: number }).defaultTtlSeconds = undefined; });
c("SESSION_TERMINAL_STATES / SCHEMA_PROFILE / BROKER_FLOOR are frozen",
  Object.isFrozen(SESSION_TERMINAL_STATES) && Object.isFrozen(SCHEMA_PROFILE) && Object.isFrozen(BROKER_FLOOR));
throws("splicing 'closed' out of the terminal states throws (the revocation backstop stays armed)",
  () => (SESSION_TERMINAL_STATES as unknown as string[]).splice(0, 1));
throws("raising the schema maxDepth throws (the DoS ceiling is not caller-tunable)",
  () => { (SCHEMA_PROFILE as unknown as { maxDepth: number }).maxDepth = Number.MAX_SAFE_INTEGER; });
throws("lowering the broker floor throws", () => { (BROKER_FLOOR as unknown as { minor: number }).minor = 0; });
c("meetsBrokerFloor still refuses 2.11 after the attempted lowering", meetsBrokerFloor("2.11.0") === false);
// The second sweep round (freelance post-be454a7): two more live-consulted security exports plus
// two contract-honesty vocabularies. EP_AUTHZ_MODES gates the cluster document's targeted modes
// (a push widened accepted authority); VOID_SCHEMA is compiled by the describe surface and its
// digest was computed once (a reassign diverged the digest from the object).
c("EP_AUTHZ_MODES / VOID_SCHEMA / EP_ERROR_CODES / RESERVED_COMMANDS are frozen",
  Object.isFrozen(EP_AUTHZ_MODES) && Object.isFrozen(VOID_SCHEMA) && Object.isFrozen(EP_ERROR_CODES) && Object.isFrozen(RESERVED_COMMANDS));
throws("pushing an authz mode throws (a cluster document cannot admit a wider mode after import)",
  () => (EP_AUTHZ_MODES as unknown as string[]).push("evil"));
c("isEpAuthzMode still refuses an unregistered mode after the attempted push (private set)", isEpAuthzMode("evil") === false);
throws("reassigning the void schema type throws (its pinned artifact digest stays honest)",
  () => { (VOID_SCHEMA as unknown as { type: string }).type = "string"; });
c("the void-schema artifact digest still matches the frozen object", contractDigest(VOID_SCHEMA) === VOID_SCHEMA_ARTIFACT_DIGEST);
c("a lease reader admits (a caller-readable record kind with no authority head)",
  recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: `$KV.${recordsBucket(SPACE)}.lease.manager.pa.u_abc.worker.${UID}.exp001.status` }).filter_subject
    === `$KV.${recordsBucket(SPACE)}.lease.manager.pa.u_abc.worker.${UID}.exp001.status`);

// ── §13.9 API grant rows: the single source, exact matrix strings (broker-free) ──
c("the canonicalizer grants own + consume its EPJ durable (create pins the full-tail filter)",
  JSON.stringify(canonicalizerGrants(SPACE, "manager")) === JSON.stringify([
    "$JS.API.CONSUMER.CREATE.EPJ_epbind.canon_manager.cotal.epbind.epj.manager.>",
    "$JS.API.CONSUMER.INFO.EPJ_epbind.canon_manager",
    "$JS.API.CONSUMER.MSG.NEXT.EPJ_epbind.canon_manager",
    "$JS.ACK.EPJ_epbind.canon_manager.>",
  ]));
c("effects grants are BIND-ONLY (no CREATE, no DELETE)",
  effectsBindGrants(SPACE, "manager").every((r) => !r.includes(".CREATE.") && !r.includes(".DELETE."))
  && effectsBindGrants(SPACE, "manager").length === 3);
c("pool-owner grants are BIND-ONLY on the pre-created pool durable",
  poolOwnerBindGrants(SPACE, "manager", "builds").includes("$JS.ACK.EPW_epbind.pool_manager_builds.>")
  && poolOwnerBindGrants(SPACE, "manager", "builds").every((r) => !r.includes(".CREATE.")));
c("the canonicalizer POOL-ROUTE grants are exactly the matrix rows (enqueue publish + the fencing leader read)",
  JSON.stringify(canonicalizerWorkGrants(SPACE, "manager")) === JSON.stringify([
    "cotal.epbind.epw.manager.>",
    "$JS.API.STREAM.MSG.GET.EPW_epbind",
  ]));
c("the EPW leader read is TRUSTED-CANONICALIZER-ONLY: no pool-owner, effects, or EPJ fragment carries it",
  [...poolOwnerBindGrants(SPACE, "manager", "builds"), ...effectsBindGrants(SPACE, "manager"), ...canonicalizerGrants(SPACE, "manager")]
    .every((r) => !r.includes("STREAM.MSG.GET")));
c("the record-writer and timer-writer grants own their durables",
  recordWriterGrants(SPACE, RECORD_KINDS.svc).some((r) => r.startsWith("$JS.API.CONSUMER.CREATE.EPR_epbind.recw_epbind-svc."))
  && timerWriterGrants(SPACE).some((r) => r.startsWith("$JS.API.CONSUMER.CREATE.EPT_REQ_epbind.timerw_epbind.")));
c("a reader bind grant is INFO/MSG.NEXT/ACK on the reader's own stream, never create",
  readerBindGrants(recordsKvStreamName(SPACE), recordReaderConfig(SPACE, { uid: UID, grantId: "g1", index: 0, subtree: recSubtree })).length === 3);
// ── D14: the commit principal + contract publisher (§13.9 matrix rows, exact strings) ──
const CONN = "ibxsmoke0123456789";
const COMMIT_ROWS = [
  "cotal.epbind.epf.manager.goal.*.*.*.*.result",
  "cotal.epbind.epf.manager.eff.>",
  "cotal.epbind.epf.manager.receipt.>",
  "cotal.epbind.epf.manager.wrk.>",
  "cotal.epbind.epf.manager.cp.>",
  "$KV.cotal_records_epbind.goal.manager.>",
  "$KV.cotal_records_epbind.cp.manager.>",
  "$KV.cotal_records_epbind.lease.manager.>",
  // §13.9 "Claim / action / checkpoint commits" enumerates SIX record kinds on this row, not three. These were built on the Model-B
  // overlay instead, where one connection binds AND commits, so nothing noticed for as long as that
  // overlay was the only caller — and a commit principal minted from this builder alone would be
  // denied the launch election, the name claim, and the cutover manifest at commit time.
  "$KV.cotal_records_epbind.goaleff.manager.>",
  "$KV.cotal_records_epbind.epname.manager.>",
  "$KV.cotal_records_epbind.epmig.manager",
  "$JS.API.STREAM.MSG.GET.EPF_epbind",
  "$JS.API.STREAM.MSG.GET.KV_cotal_records_epbind",
  "$JS.API.INFO",
];
c("the commit principal's rows are exactly the two §13.9 matrix rows (five fact families, the goal terminal at its EXACT-ARITY leaf with no epoch-scoped variant + the SIX record-key prefixes §13.9 `Claim / action / checkpoint commits` (SPEC:2912) enumerates + the two leader-served fencing reads), never dec/quar",
  (() => {
    const g = commitPrincipalGrants(SPACE, "manager", CONN);
    return JSON.stringify(g.publish) === JSON.stringify(COMMIT_ROWS)
      && JSON.stringify(g.subscribe) === JSON.stringify([`_INBOX_${CONN}.>`])
      && !g.publish.some((r) => r.includes(".dec.") || r.includes(".quar.") || r.includes("DIRECT.GET"));
  })());
// AN EXACT-LIST CELL NAMES ONE ASSERTION FOR EVERY ROW IN IT. Three separate mutations — drop
// `goaleff`, drop `epname`, widen `epmig` to a subtree — all reddened the same conjunctive cell, so
// the suite went red without being able to say which grant died. Per-row cells below; the exact
// list above still holds the CLOSURE (nothing extra), which per-row membership cannot.
for (const kind of ["goaleff", "epname", "epmig"] as const) {
  const row = kind === "epmig" ? "$KV.cotal_records_epbind.epmig.manager" : `$KV.cotal_records_epbind.${kind}.manager.>`;
  c(`the commit principal holds the \`${kind}\` key EXACTLY as §13.9 \`Claim / action / checkpoint commits\` (SPEC:2912) spells it (\`epmig\` is ONE key, never a subtree)`,
    commitPrincipalGrants(SPACE, "manager", CONN).publish.includes(row), row);
}
// ── the three journal-action coordination kinds ────────────────────────────────────────────
// Registration and grant are TWO claims and this needed both. A registry entry pins a key
// grammar and confers no authority; the grant builder decides the commit path's records keys BY
// KIND and default-denies anything it does not name. Either half alone ships something that looks
// present and does nothing, which is why each is asserted separately below.
for (const [kind, quals] of [["goaleff", 6], ["epname", 2], ["epmig", 1]] as const) {
  const def = RECORD_KINDS[kind as keyof typeof RECORD_KINDS];
  c(`\`${kind}\` is a REGISTERED core record kind`, def !== undefined && def.kind === kind, def);
  c(`\`${kind}\` is UNSPLIT (an atomic coordination row, no .spec/.status)`, def?.split === false, def?.split);
  c(`\`${kind}\` is written by the commit path`,
    def?.writers.spec === "commit-path" && def?.writers.status === "commit-path", def?.writers);
  c(`\`${kind}\` pins ${quals} qualifier(s)`, def?.qualifiers.length === quals, def?.qualifiers.length);
}
// The GRAMMARS, built rather than described — a key grammar stated in a comment is not a key.
c("`goaleff` keys on the caller triple, the goalId AND the acceptance generation",
  recordAtomicKey(RECORD_KINDS.goaleff, ["manager", "u_abc", "worker", "u".repeat(26), "g1", "77"])
  === `goaleff.manager.u_abc.worker.${"u".repeat(26)}.g1.77`);
// Keyed by the NAME, not by a caller: two callers racing for one name MUST contend on one key, and
// a caller-scoped grammar would make that contention impossible by construction.
c("`epname` keys on the NAME, with no caller triple",
  recordAtomicKey(RECORD_KINDS.epname, ["manager", "worker-7"]) === "epname.manager.worker-7");
c("`epmig` is ONE key per endpoint", recordAtomicKey(RECORD_KINDS.epmig, ["manager"]) === "epmig.manager");

// RAISED, NOT SETTLED — and asserted so it cannot merge unnoticed. These three are ordinary
// (non-authority) kinds, so `callerReadableRecordKind` admits them and the reader-config seam would
// accept a durable over their subtrees. For `goaleff` that mirrors `goalidx`, whose key also
// carries the caller triple. For `epname` and `epmig` it does NOT: their keys carry no caller, so
// an admitted filter is endpoint-wide — every name claim, and the cutover manifest. Whether that is
// correct is an authority decision inside an authority change, so it is pinned here at today's
// answer rather than quietly chosen; if the ruling narrows it, this cell dies and says so.
for (const kind of ["goaleff", "epname", "epmig"])
  c(`TODAY: \`${kind}\` is caller-readable (non-authority) — pinned here, decided at grant-issuance time`,
    callerReadableRecordKind(kind) === true);

const GW = goalWriterGrants(SPACE, "manager", CONN);
c("the self-mediated goal-writer (P2 item 2) is the commit principal PLUS the goal `.bind` leaf, the must-5 reconcile-index write, and the must-5 own-gate read — nothing else",
  JSON.stringify(GW.publish) === JSON.stringify([
    "cotal.epbind.epf.manager.goal.*.*.*.*.bind",
    "$KV.cotal_records_epbind.goalidx.manager.>",
    "$JS.API.STREAM.MSG.GET.KV_cotal_auth_epbind",
    ...COMMIT_ROWS,
  ]) && JSON.stringify(GW.subscribe) === JSON.stringify([`_INBOX_${CONN}.>`]), GW.publish);
// SPELLED AS A COMPOSITION, not as a re-listing. The three coordination kinds were written out here
// as well as on the commit row, which made this overlay look like their source; they are §13.9
// "Claim / action / checkpoint commits" commit-row grants that every commit principal holds, and this profile only INHERITS them. Reusing
// `COMMIT_ROWS` is what makes that structural rather than a claim in a comment: the day the commit
// row changes, this cell moves with it or fails, and it cannot drift into a private copy again.
// the item-2 privilege separation: the goal-writer carries the `.bind` leaf the serve cred never does
c("the `.bind` leaf is the goal-writer's FIRST row — the privilege that separates it from a serve credential",
  GW.publish[0] === "cotal.epbind.epf.manager.goal.*.*.*.*.bind");
// must-5: the reconcile-index write is key-pinned to THIS endpoint's index subtree, and the own-gate
// read is the auth store's leader MSG.GET (the goal-writer holds NO records CONSUMER authority — the
// boot sweep enumerates the index over the provisioner, never this standing connection).
c("the must-5 reconcile-index write is key-pinned to THIS endpoint's index subtree",
  GW.publish.includes("$KV.cotal_records_epbind.goalidx.manager.>"));
c("the must-5 own-gate read is the auth store's leader MSG.GET",
  GW.publish.includes("$JS.API.STREAM.MSG.GET.KV_cotal_auth_epbind"));
c("the goal-writer forges no decision and binds no consumer",
  !GW.publish.some((r) => r.includes(".dec.") || r.includes(".quar.") || r.includes("DIRECT.GET") || r.includes("CONSUMER.")));
// `epmig` is ONE key per endpoint, so its row is the exact key and NOT a `.>` subtree: a wildcard
// here would grant an endpoint-wide namespace for a single-key kind. Asserted NEGATIVELY as well,
// because `includes(exact)` stays true when a widened row is added ALONGSIDE it.
c("`epmig` reaches the goal-writer as ONE key, never widened to a subtree",
  GW.publish.includes("$KV.cotal_records_epbind.epmig.manager")
  && !GW.publish.includes("$KV.cotal_records_epbind.epmig.manager.>"));
c("the contract publisher's rows are exactly the §13.9 publication + subject-confined read-back (no STREAM.INFO, no MSG.GET, no consumer authority)",
  (() => {
    const g = contractPublisherGrants(SPACE, CONN);
    return JSON.stringify(g.publish) === JSON.stringify([
      "cotal.epbind.epc.*",
      "$JS.API.DIRECT.GET.EPC_epbind.cotal.epbind.epc.>",
      "$JS.API.INFO",
    ]) && JSON.stringify(g.subscribe) === JSON.stringify([`_INBOX_${CONN}.>`])
      && !g.publish.some((r) => r.includes("STREAM.INFO") || r.includes("STREAM.MSG.GET") || r.includes("CONSUMER."));
  })());

c("the provisioner grants pair a full-tail CREATE with a DELETE per pre-created durable, nothing else",
  (() => {
    const rows = provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: poolConsumerConfig(SPACE, "manager", "builds") }]);
    return rows.length === 2
      && rows[0] === "$JS.API.CONSUMER.CREATE.EPW_epbind.pool_manager_builds.cotal.epbind.epw.manager.builds.>"
      && rows[1] === "$JS.API.CONSUMER.DELETE.EPW_epbind.pool_manager_builds"
      && !rows.some((r) => r.includes("MSG.NEXT") || r.includes(".INFO.")); // the provisioner never consumes
  })());
throws("a raw (unbranded) config in a reader bind grant refuses (only §13.9 family configs)",
  () => readerBindGrants(recordsKvStreamName(SPACE), { durable_name: "*" }));
throws("a family config paired with a foreign stream refuses (no cross-family pairing)",
  () => provisionerConsumerGrants([{ stream: "EPW_epbind.>", config: poolConsumerConfig(SPACE, "manager", "builds") }]));
throws("a pool config on another family's stream refuses (create-side provenance)",
  () => provisionerConsumerGrants([{ stream: epeStreamName(SPACE), config: poolConsumerConfig(SPACE, "manager", "builds") }]));
throws("a raw config with a whole-stream `>` filter refuses (no arbitrary create authority)",
  () => provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: { durable_name: "pool_manager_builds", filter_subject: ">" } }]));
throws("a raw config broadening a literal durable to the whole plane refuses",
  () => provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: { durable_name: "pool_manager_builds", filter_subject: "cotal.epbind.epw.>" } }]));
throws("a raw config binding a durable to another endpoint's pool refuses (misattribution)",
  () => provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: { durable_name: "pool_manager_builds", filter_subject: "cotal.epbind.epw.other.secret.>" } }]));
throws("a mid-filter `>` in a pre-created durable's create row refuses (broadened matrix row)",
  () => provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: { durable_name: "pool_manager_builds", filter_subject: "cotal.epbind.epw.>.builds" } }]));
// The brand is a TUPLE snapshot, not object identity alone: a branded config whose fields were
// mutated after mint is not §13.9 authority.
throws("a branded config with a post-mint MUTATED filter refuses (foreign-pool capture)",
  () => {
    const cfg = poolConsumerConfig(SPACE, "manager", "builds");
    cfg.filter_subject = `cotal.${SPACE}.epw.other.secret.>`;
    return provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: cfg }]);
  });
throws("a branded config with a post-mint MUTATED durable refuses (foreign-durable create/delete)",
  () => {
    const cfg = poolConsumerConfig(SPACE, "manager", "builds");
    cfg.durable_name = "pool_other_secret";
    return provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: cfg }]);
  });
throws("a branded reader config with a post-mint MUTATED durable refuses (victim-durable bind)",
  () => {
    const cfg = decisionReaderConfig(SPACE, "manager", { owner: "u_abc", actor: "worker", uid: UID });
    cfg.durable_name = `dec_${"v".repeat(26)}-manager`;
    return readerBindGrants(epfStreamName(SPACE), cfg);
  });
throws("a branded config with a post-mint deliver_subject refuses (family consumers are PULL-only)",
  () => {
    const cfg = poolConsumerConfig(SPACE, "manager", "builds");
    cfg.deliver_subject = "attacker.sink";
    return provisionerConsumerGrants([{ stream: epwStreamName(SPACE), config: cfg }]);
  });

// ── the §13.12 fact-retention floor (broker-free) ───────────────────────────────────────────────
// The horizon is realized BY retention and never by a clock: the create-only CAS returns the
// recorded decision for exactly as long as the fact exists. So a fact age under the horizon does
// not shorten a guarantee, it removes the mechanism — and a redelivered submission whose fact has
// been evicted is accepted as NEW WORK.
//
// THIS CHECK EXISTS BECAUSE THE INVARIANT WAS DELEGATED TO A LAYER THAT DID NOT EXIST. The field's
// contract said horizons are "enforced by policy above the broker", and nothing was above the
// broker: the constant naming the horizon had ZERO readers in the tree. The cell below pins that
// directly, because an exported constant with no readers is a claim nobody is making, and it is
// the cheapest possible signal for "an invariant that was described and never wired".
const HORIZON = 24 * 60 * 60 * 1000;
c("the horizon constant is what the floor is measured against — it now has a READER, which is the "
  + "whole tell: before this check it was exported and read by nothing, so the invariant it names "
  + "participated in no code path at all",
  IDEMPOTENCY_HORIZON_MS_DEFAULT === HORIZON, IDEMPOTENCY_HORIZON_MS_DEFAULT);
throws("a fact age BELOW the horizon is refused at creation, not clamped and not accepted",
  () => assertFactRetentionFloor(HORIZON - 1, HORIZON));
throws("and a wildly short one is refused the same way (a minute against a day)",
  () => assertFactRetentionFloor(60_000, HORIZON));
// The two values that must NOT throw, without which the check is "refuse every configuration" and
// every positive cell above still passes.
// A BARE CALL IS NOT A CELL, and the harness is what taught me: these were written as
// `assertFactRetentionFloor(x, y); c(label, true)`, so a mutant that made one of them THROW killed
// the process before the named cell could print. Two mutants graded WRONG-RED — "exited 1 but never
// printed the expected failure" — at 105 marks against a 151 baseline, which is the mark count doing
// exactly the job it exists for. It is the mirror of a bare `throws` passing on the wrong refusal:
// there the cell is green for the wrong reason, here the cell never runs at all.
type FloorTerms = number | { horizonMs: number; resultRetentionMs?: number; receiptRetentionMs?: number };
const admitsFloor = (label: string, factMaxAgeMs: number | undefined, terms: FloorTerms) => {
  try { assertFactRetentionFloor(factMaxAgeMs, terms); c(label, true); }
  catch (e) { c(label, false, (e as Error).message); }
};
/** A refusal whose MESSAGE must name a thing. `throws` proves only that something threw, and three
 *  terms that all throw are indistinguishable to it. */
const throwsMsg = (label: string, fn: () => unknown, needle: string) => {
  try { fn(); c(label, false, "expected a throw, got a value"); }
  catch (e) { const m = String((e as Error).message); c(label, m.includes(needle), m); }
};
admitsFloor("an OMITTED fact age is admitted: no age eviction means the floor cannot be breached", undefined, HORIZON);
admitsFloor("and an explicit 0 is admitted for the same reason — 0 is the documented no-eviction "
  + "spelling, not a zero-length retention", 0, HORIZON);
// THE FLOOR IS A MAX OVER THREE TERMS, NOT THE HORIZON. This pair used to read
// "a fact age EXACTLY at the horizon is admitted" and it was WRONG — 24 h of EPF retention evicts
// the 90-day receipts whose reconstruction source the acceptance fact IS. A reviewer found it by
// reading the spec sentence the row cited rather than the row. The lesson generalises past this
// cell: **the guard passed the value a caller was most likely to write first**, which is worse than
// no guard, because it certifies it.
throws("a fact age exactly at the IDEMPOTENCY HORIZON is refused — the horizon is not the floor",
  () => assertFactRetentionFloor(HORIZON, HORIZON));
admitsFloor("a fact age exactly at the FLOOR (the largest term, receipt retention) is admitted: "
  + "`below`, not `at or below`", RECEIPT_RETENTION_MS_DEFAULT, HORIZON);
admitsFloor("and a longer retention is admitted (SPEC's floor is a minimum, never a target)",
  RECEIPT_RETENTION_MS_DEFAULT * 2, HORIZON);
// WHICH TERM BINDS is part of the contract, not decoration: the three differ by two orders of
// magnitude, so "below 7776000000" leaves an operator guessing which promise it broke.
throwsMsg("the refusal NAMES the binding term (receipt retention, not the horizon it is not)",
  () => assertFactRetentionFloor(HORIZON, HORIZON), "declared receiptRetentionMs");
throwsMsg("and when a DECLARED term is the largest, that one is named instead",
  () => assertFactRetentionFloor(RECEIPT_RETENTION_MS_DEFAULT, { horizonMs: RECEIPT_RETENTION_MS_DEFAULT * 3 }),
  "declared idempotencyHorizonMs");
admitsFloor("a declared receipt retention BELOW the default lowers the floor with it — the terms are "
  + "declared, never compiled in", 2 * HORIZON,
  { horizonMs: HORIZON, resultRetentionMs: HORIZON, receiptRetentionMs: 2 * HORIZON });
// The horizon is DECLARED, never compiled in — the same lesson as the admission ceiling. A space
// retaining decisions for a year must have its fact age measured against ITS horizon, and this cell
// is the one that fails if the floor is ever hardcoded to the module default.
//
// IT DID NOT USED TO BE. Written as "48h of facts under a 90-day declared horizon", it proved
// nothing about the declared term: 90 days is EXACTLY the receipt default, so the receipt term
// bound the floor and 48h was refused whether the declared horizon was read or replaced by the
// module constant. Hardcoding the horizon left the cell green. **A cell that varies one term to a
// value another term already reaches cannot tell the two apart** — the fact age has to land in the
// gap the declared term opens ABOVE every default, or the defaults answer for it.
throws("the floor is measured against the DECLARED horizon, not this module's default: 100 days of "
  + "facts is refused under a 120-day declared horizon, though it clears every default",
  () => assertFactRetentionFloor(100 * HORIZON, 120 * HORIZON));
throws("a non-positive declared horizon is refused rather than treated as absent",
  () => assertFactRetentionFloor(HORIZON, 0));
throws("a fractional fact age is refused (a wire duration is a safe integer)",
  () => assertFactRetentionFloor(HORIZON + 0.5, HORIZON));

// ── the resources + live behaviors (real broker) ──
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-epbind-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);

  // A BARE CALL IS NOT A CELL. These two were `await …; await …; c("is idempotent", true)`, so a
  // mutant that made EITHER call throw ended the run with no assertion name on it — and the FIRST
  // call is not the idempotence claim at all, it is the setup. Split and named: a failure now says
  // which of the two broke.
  await (async () => {
    try { await createEndpointStreams(jsm, kvm, SPACE); c("createEndpointStreams builds the space resources", true); }
    catch (e) { c("createEndpointStreams builds the space resources", false, (e as Error).message); }
  })();
  await (async () => {
    try { await createEndpointStreams(jsm, kvm, SPACE); c("an identical re-run is idempotent", true); }
    catch (e) { c("an identical re-run is idempotent", false, (e as Error).message); }
  })();

  // REACH, not just behaviour. Every floor cell above calls the validator DIRECTLY, and a validator
  // that is exported and never invoked passes all of them — the same shape as registering a record
  // kind without granting it. This one goes through the real entry point, and it must refuse BEFORE
  // touching the broker: a config that breaches the floor may not leave a half-built space behind.
  {
    const breaching = { space: `${SPACE}-floor`, factMaxAgeMs: 60_000 };
    let threw: Error | undefined;
    try { await createEndpointStreams(jsm, kvm, breaching.space, { factMaxAgeMs: breaching.factMaxAgeMs }); }
    catch (e) { threw = e as Error; }
    c("createEndpointStreams REFUSES a fact age below the floor — the floor is reached from the real entry point",
      threw !== undefined && /below the declared receiptRetentionMs/.test(threw.message), threw?.message);
    // …and refused EARLY: no stream of that space exists, so the breach never half-built anything.
    let leaked = false;
    try { await jsm.streams.info(epfStreamName(breaching.space)); leaked = true; } catch { /* absent, as required */ }
    c("and it refused BEFORE creating anything — the breaching space has no EPF stream", !leaked);
  }

  // Config assertions — the §13.12 table, read back from the broker.
  const cfg = async (name: string) => (await jsm.streams.info(name)).config;
  const epj = await cfg(epjStreamName(SPACE));
  c("EPJ has NO Direct Get (nothing reads it but the canonicalizer + harness MSG.GET)", !epj.allow_direct);
  c("EPJ's duplicate window is pinned to the server minimum, never the 120s default",
    epj.duplicate_window === nanos(EPJ_DUPLICATE_WINDOW_MS));
  const epf = await cfg(epfStreamName(SPACE));
  c("EPF serves Direct Get (the last-by-subject fact reads)", epf.allow_direct === true);
  // THE RETENTION FLOOR IS THE AGE TERM ONLY, AND THE RULE IS WIDER THAN THE AGE TERM. SPEC:3189-3195
  // forbids "not only age eviction below the horizon but every conforming alternative that erases it
  // while `MaxAge` still passes": a finite MaxMsgs/MaxBytes/MaxMsgsPerSubject with DiscardOld, a
  // per-message TTL, rollup/compaction, or a retention-policy change. The floor validator checks the
  // age term and nothing else, so the ledger row read FIXED while four of the five causes were
  // unguarded — a reviewer caught the overclaim.
  //
  // These are not settable through `EndpointStreamOptions` today, and THAT IS THE WEAKER CLAIM: it
  // is a fact about the option surface, and it stops being true the first time someone adds an
  // option. Asserted here against the config the broker actually holds, so it is a fact about the
  // stream — and it reddens on the widening rather than on the incident.
  c("EPF has NO non-age removal cause: unlimited count/bytes/per-subject, no message TTL, no rollup, Limits retention (SPEC:3189-3195)",
    epf.max_msgs === -1 && epf.max_bytes === -1 && epf.max_msgs_per_subject === -1
    && !epf.allow_msg_ttl && !epf.allow_rollup_hdrs && epf.retention === "limits",
    { max_msgs: epf.max_msgs, max_bytes: epf.max_bytes, max_msgs_per_subject: epf.max_msgs_per_subject,
      allow_msg_ttl: epf.allow_msg_ttl, allow_rollup_hdrs: epf.allow_rollup_hdrs, retention: epf.retention });
  const eptReq = await cfg(eptReqStreamName(SPACE));
  c("EPT_REQ has message schedules DISABLED", !eptReq.allow_msg_schedules);
  const ept = await cfg(eptStreamName(SPACE));
  c("EPT has message schedules ENABLED", ept.allow_msg_schedules === true);
  const epw = await cfg(epwStreamName(SPACE));
  c("EPW is a WorkQueue with NO Direct Get (the reconciliation probe is fencing → leader-served STREAM.MSG.GET only, SPEC:2931, §13.9 `Work-pool reconciliation probe`)",
    epw.retention === "workqueue" && epw.allow_direct === false);
  const epc = await cfg(epcStreamName(SPACE));
  c("EPC has no age eviction (artifacts are permanent)", epc.allow_direct === true && epc.max_age === 0);
  c("EPC permanence is broker-enforced (deny_delete + deny_purge: a digest subject can never be emptied and re-created)",
    epc.deny_delete === true && epc.deny_purge === true);
  {
    let purged = false;
    try { await jsm.streams.purge(epcStreamName(SPACE)); purged = true; } catch { /* refused by the broker — the probe's expectation */ }
    c("a purge against EPC is refused BY THE BROKER (permanence is not configured-by-omission)", !purged);
  }
  c("records KV serves Direct Get", (await cfg(`KV_${recordsBucket(SPACE)}`)).allow_direct === true);
  const auth = await cfg(`KV_${epAuthBucket(SPACE)}`);
  c("auth KV is leader-served ONLY (allow_direct=false; fences need read-your-writes)", auth.allow_direct === false);
  c("auth KV has per-key TTL machinery ON and NO bucket age retention",
    auth.allow_msg_ttl === true && auth.max_age === 0);

  // Live: the mediated timer path. The timer writer arms on `.armed` targeting the sibling
  // `.fire`; the broker fires and stamps the schedule's own subject into `Nats-Scheduler`.
  // Generation 1 is armed for a deadline the test WAITS PAST, so if the replacement did not
  // purge it, gen1 would fire and show up — its absence is a positive proof of replacement,
  // not merely "we stopped watching before it was due" (the panel's under-specification note).
  const armed = eptSubject(SPACE, "manager", IID, 1, "t1", "armed");
  const fire = eptSubject(SPACE, "manager", IID, 1, "t1", "fire");
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const h1 = headers();
  h1.set("Nats-Schedule", `@at ${at(1200)}`); // gen1's OWN deadline — the test waits well past it
  h1.set("Nats-Schedule-Target", fire);
  await js.publish(armed, new TextEncoder().encode(JSON.stringify({ timerId: "t1", generation: 1 })), { headers: h1 });
  const h2 = headers();
  h2.set("Nats-Schedule", `@at ${at(2500)}`); // the replacement, published before gen1 is due
  h2.set("Nats-Schedule-Target", fire);
  await js.publish(armed, new TextEncoder().encode(JSON.stringify({ timerId: "t1", generation: 2 })), { headers: h2 });
  const armedCount = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: armed })).state.subjects?.[armed];
  c("a same-subject re-arm REPLACES the schedule (server rollup, §13.12)", armedCount === 1);

  // Live: the ADR-51 confused deputy. A `.schedule` REQUEST carrying scheduling headers lands
  // (or is refused) on the schedules-DISABLED stream — either way it can never cause a fire.
  const victimFire = eptSubject(SPACE, "manager", IID, 1, "victim", "fire");
  const dep = headers();
  dep.set("Nats-Schedule", `@at ${at(1000)}`);
  dep.set("Nats-Schedule-Target", victimFire);
  let deputyRefused = false;
  try {
    await js.publish(eptSubject(SPACE, "manager", IID, 1, "victim", "schedule"), new Uint8Array(0), { headers: dep });
  } catch {
    deputyRefused = true; // refusing the publish outright also closes the deputy
  }

  await wait(3400); // PAST gen1's +1200, gen2's +2500, and the deputy's +1000 — every deadline is due
  const fireState = (await jsm.streams.info(eptStreamName(SPACE), { subjects_filter: fire })).state.subjects?.[fire] ?? 0;
  const fired = await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: fire });
  c("the armed schedule FIRED onto its sibling .fire", fired !== null);
  c("the fired message carries the broker-authored Nats-Scheduler = its own .armed subject (§13.2 origin check)",
    fired?.header?.get("Nats-Scheduler") === armed);
  c("EXACTLY ONE fire exists and it is generation 2 — gen1's own deadline elapsed without firing (purged)",
    fireState === 1 && fired !== null && JSON.parse(new TextDecoder().decode(fired.data)).generation === 2);
  let victimFired = true;
  try {
    victimFired = (await jsm.streams.getMessage(eptStreamName(SPACE), { last_by_subj: victimFire })) !== null;
  } catch { victimFired = false; }
  c(`scheduling headers on the request stream are ${deputyRefused ? "refused" : "inert"} — the deputy cannot fire (past its +1000 deadline)`,
    !victimFired);

  // Live: auth-store per-key TTL — a cred row expires by itself; authority keys persist.
  const authKv = await kvm.open(epAuthBucket(SPACE));
  await authKv.create(`cred.${UID}.c1`, new TextEncoder().encode("{}"), "1s");
  await authKv.create(`gate.${UID}`, new TextEncoder().encode(`{"state":"open"}`));
  const live = await authKv.get(`cred.${UID}.c1`);
  c("a TTL'd cred row is readable before expiry", live !== null && live.operation === "PUT");
  await wait(2200);
  // Expiry leaves a MaxAge purge MARKER on the key (operation PURGE, empty value) — the marker
  // itself carries the bucket's markerTTL and then vanishes. A ledger reader treats DEL/PURGE
  // as absent, the standard KV discipline.
  const expired = await authKv.get(`cred.${UID}.c1`);
  c("the cred row EXPIRED by per-key TTL (gone, or its transient MaxAge purge marker)",
    expired === null || (expired.operation === "PURGE" && expired.value.length === 0));
  const gate = await authKv.get(`gate.${UID}`);
  c("the un-TTL'd gate row persists (no bucket age retention)", gate !== null && gate.operation === "PUT");

  // Live: EPW reconciliation predicate + redelivery. A short ack_wait makes redelivery
  // observable: an acked item leaves the WorkQueue; a DELIVERED-but-unacked item stays
  // LEADER-readable (STREAM.MSG.GET, never Direct Get — EPW is allow_direct:false so the fencing
  // probe cannot take the stale follower path) AND is redelivered to the owner after ack_wait
  // (the §13.6 predicate is about in-flight work, not merely pending storage — the panel's
  // redelivery note).
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "builds", { ackWaitMs: 1500 }));
  const item1 = epwSubject(SPACE, "manager", "builds", { ...caller, id: "req-1" });
  const item2 = epwSubject(SPACE, "manager", "builds", { ...caller, id: "req-2" });
  await js.publish(item1, new TextEncoder().encode("w1"));
  await js.publish(item2, new TextEncoder().encode("w2"));
  const poolC = await js.consumers.get(epwStreamName(SPACE), poolDurable("manager", "builds"));
  // Deliver item1 and ACK it; deliver item2 and DO NOT ack it (leave it in-flight).
  let acked: string | undefined, inflightSubj: string | undefined, inflightDeliveries = 0;
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2000 })) { acked = m.subject; m.ack(); }
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2000 })) { inflightSubj = m.subject; inflightDeliveries = m.info.deliveryCount; /* no ack */ }
  c("the pool consumer delivers work items in order", acked === item1 && inflightSubj === item2);
  await wait(300); // let the ack commit (WorkQueue removal)
  let ackedGone = false;
  try { ackedGone = (await jsm.streams.getMessage(epwStreamName(SPACE), { last_by_subj: item1 })) === null; }
  catch (e) { ackedGone = (e as { code?: unknown })?.code === 10037; } // no message found = gone
  c("an ACKED item has LEFT the WorkQueue (leader-served probe finds nothing)", ackedGone);
  const inflight = await jsm.streams.getMessage(epwStreamName(SPACE), { last_by_subj: item2 });
  c("a DELIVERED-but-unacked item REMAINS leader-readable (the §13.6 reconciliation predicate, STREAM.MSG.GET)",
    inflight !== null && inflightDeliveries === 1);
  // The follower path is STRUCTURALLY forbidden: a Direct Get on EPW is refused (allow_direct:false),
  // so no reconciler can accidentally take the stale-read path the predicate must never use.
  let directRefused = false;
  try { await jsm.direct.getMessage(epwStreamName(SPACE), { last_by_subj: item2 }); }
  catch { directRefused = true; }
  c("a Direct Get on EPW is refused (allow_direct:false forbids the fencing probe's stale-read path)", directRefused);
  // Cross ack_wait: the same in-flight item redelivers to the owner (delivery count advances).
  await wait(1600);
  let redeliverySubj: string | undefined, redeliveryCount = 0;
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2500 })) { redeliverySubj = m.subject; redeliveryCount = m.info.deliveryCount; m.ack(); }
  c("an un-acked item REDELIVERS to the owner after ack_wait (redelivery count advances)",
    redeliverySubj === item2 && redeliveryCount === 2);

  // Live: the canonicalizer's durable form consumes exactly its endpoint's submissions.
  await jsm.consumers.add(epjStreamName(SPACE), canonConsumerConfig(SPACE, "manager"));
  await appendSubmission(js, epjSubject(SPACE, { endpoint: "manager", command: "spawn", caller }), { v: 1, id: "req-1" });
  await appendSubmission(js, epjSubject(SPACE, { endpoint: "other", command: "spawn", caller }), { v: 1, id: "req-2" });
  const canonC = await js.consumers.get(epjStreamName(SPACE), canonDurable("manager"));
  const cb = await canonC.fetch({ max_messages: 2, expires: 1500 });
  const got: string[] = [];
  for await (const m of cb) { got.push(m.subject); m.ack(); }
  c("the canonicalizer durable sees ONLY its own endpoint's submissions",
    got.length === 1 && got[0].startsWith("cotal.epbind.epj.manager."));

  // ── SCOPED-CREDENTIAL confinement (§13.9 matrix rows 2271/2272 live): a second broker runs
  // plain user authorization where `canon` holds EXACTLY the canonicalizerWorkGrants rows (plus
  // $JS.API.INFO to bind the JS API and its own inbox) and `agent` holds neither. The broker,
  // not a handler, must let the canonicalizer enqueue + leader-read while denying everyone else
  // the body-selected EPW read.
  {
    const SPORT = await pickFreePort();
    const sd2 = mkdtempSync(join(tmpdir(), "cotal-epbind-auth-"));
    const canonRows = canonicalizerWorkGrants(SPACE, "manager");
    writeFileSync(join(sd2, "server.conf"), [
      `port: ${SPORT}`,
      `jetstream { store_dir: ${JSON.stringify(join(sd2, "js"))} }`,
      "authorization {",
      "  users [",
      `    { user: "admin", password: "pw" }`,
      `    { user: "canon", password: "pw", permissions: { publish = ${JSON.stringify([...canonRows, "$JS.API.INFO"])}, subscribe = ["_INBOX.>"] } }`,
      `    { user: "agent", password: "pw", permissions: { publish = ["$JS.API.INFO"], subscribe = ["_INBOX.>"] } }`,
      `    { user: "activator", password: "pw", permissions: { publish = ${JSON.stringify(activatorGrants(SPACE, "manager", "builds", "actconn01").publish)}, subscribe = ${JSON.stringify(activatorGrants(SPACE, "manager", "builds", "actconn01").subscribe)} } }`,
      "  ]",
      "}",
    ].join("\n"));
    const broker2 = spawn("nats-server", ["-c", join(sd2, "server.conf")], { stdio: "ignore" });
    try {
      let up2 = false;
      for (let i = 0; i < 50 && !up2; i++) { up2 = await isReachable(`nats://127.0.0.1:${SPORT}`); if (!up2) await wait(100); }
      if (!up2) throw new Error("the authorization broker did not come up");
      const ncAdmin = await connect({ servers: `nats://127.0.0.1:${SPORT}`, user: "admin", pass: "pw" });
      const jsmAdmin = await jetstreamManager(ncAdmin);
      await createEndpointStreams(jsmAdmin, new Kvm(ncAdmin), SPACE);
      await jsmAdmin.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "builds"));

      const ncCanon = await connect({ servers: `nats://127.0.0.1:${SPORT}`, user: "canon", pass: "pw" });
      const jsCanon = jetstream(ncCanon, { timeout: 2000 });
      const jsmCanon = await jetstreamManager(ncCanon, { timeout: 2000 });
      const scopedItem = epwSubject(SPACE, "manager", "builds", { ...caller, id: "scoped-1" });
      {
        const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
        const ack = await jsCanon.publish(scopedItem, new TextEncoder().encode("scoped"), { headers: h });
        c("the scoped canonicalizer credential ENQUEUES (the epw publish row is live-sufficient)", ack.seq > 0);
      }
      const scopedRead = await jsmCanon.streams.getMessage(epwStreamName(SPACE), { last_by_subj: scopedItem });
      c("the scoped canonicalizer credential leader-reads the item (STREAM.MSG.GET row live-sufficient)",
        scopedRead !== null && scopedRead.subject === scopedItem);
      let canonDirectDenied = false;
      try { await jsmCanon.direct.getMessage(epwStreamName(SPACE), { last_by_subj: scopedItem }); }
      catch { canonDirectDenied = true; }
      c("the scoped canonicalizer CANNOT take the follower path (Direct Get denied by grant AND allow_direct:false)", canonDirectDenied);

      const ncAgent = await connect({ servers: `nats://127.0.0.1:${SPORT}`, user: "agent", pass: "pw" });
      const jsAgent = jetstream(ncAgent, { timeout: 1500 });
      const jsmAgent = await jetstreamManager(ncAgent, { timeout: 1500 });
      let agentReadDenied = false;
      try { await jsmAgent.streams.getMessage(epwStreamName(SPACE), { last_by_subj: scopedItem }); }
      catch { agentReadDenied = true; }
      c("a NON-canonicalizer credential is DENIED the body-selected EPW leader read (broker-enforced)", agentReadDenied);
      let agentEnqueueDenied = false;
      try {
        const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
        await jsAgent.publish(epwSubject(SPACE, "manager", "builds", { ...caller, id: "scoped-evil" }), new TextEncoder().encode("evil"), { headers: h });
      } catch { agentEnqueueDenied = true; }
      c("a NON-canonicalizer credential is DENIED the pool enqueue (broker-enforced)", agentEnqueueDenied);

      // The ACTIVATOR profile (§13.9 matrix): exactly ONE row — the per-pool Consumer INFO. The
      // narrow context binds without $JS.API.INFO (checkAPI: false), the occupancy read works,
      // and every other JetStream surface is broker-denied.
      const ncAct = await connect({ servers: `nats://127.0.0.1:${SPORT}`, user: "activator", pass: "pw", inboxPrefix: "_INBOX_actconn01" });
      const actx = await activatorContext(ncAct, SPACE);
      const actOcc = await readPoolOccupancy(actx, "manager", "builds");
      c("the activator credential (INFO + scoped inbox, no account-wide _INBOX) reads occupancy over its confined reply inbox", actOcc.occupancy === 1, actOcc);
      // FOREIGN-INBOX denial: the SAME credential on a connection whose inbox prefix does NOT
      // match its grant cannot receive the reply — the scoped inbox is real confinement.
      const ncActWrong = await connect({ servers: `nats://127.0.0.1:${SPORT}`, user: "activator", pass: "pw", inboxPrefix: "_INBOX_foreign" });
      const jsmActWrong = await jetstreamManager(ncActWrong, { timeout: 1200, checkAPI: false });
      let foreignInboxDenied = false;
      try { await jsmActWrong.consumers.info(epwStreamName(SPACE), poolDurable("manager", "builds")); }
      catch { foreignInboxDenied = true; }
      c("the activator on a FOREIGN inbox prefix cannot read replies (the scoped inbox is real confinement, not decoration)", foreignInboxDenied);
      await ncActWrong.close().catch(() => {});
      const jsmAct = await jetstreamManager(ncAct, { timeout: 1500, checkAPI: false });
      let actGetDenied = false;
      try { await jsmAct.streams.getMessage(epwStreamName(SPACE), { last_by_subj: scopedItem }); }
      catch { actGetDenied = true; }
      c("the activator is DENIED the body-selected EPW leader read (INFO-only, no reconciliation authority)", actGetDenied);
      let actNextDenied = false;
      try { await ncAct.request(`$JS.API.CONSUMER.MSG.NEXT.${epwStreamName(SPACE)}.${poolDurable("manager", "builds")}`, new TextEncoder().encode("{}"), { timeout: 1200 }); }
      catch { actNextDenied = true; }
      c("the activator is DENIED pool consume (MSG.NEXT; watching is never draining)", actNextDenied);
      let actCreateDenied = false;
      try { await jsmAct.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "evil")); }
      catch { actCreateDenied = true; }
      c("the activator is DENIED consumer creation (no self-widened watch surface)", actCreateDenied);
      let actPubDenied = false;
      try {
        const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
        await jetstream(ncAct, { timeout: 1200 }).publish(epwSubject(SPACE, "manager", "builds", { ...caller, id: "act-evil" }), new TextEncoder().encode("evil"), { headers: h });
      } catch { actPubDenied = true; }
      c("the activator is DENIED the pool enqueue (watching is never writing)", actPubDenied);
      await ncAct.close().catch(() => {});
      await ncCanon.close().catch(() => {}); await ncAgent.close().catch(() => {}); await ncAdmin.close().catch(() => {});
    } finally {
      if (broker2.pid) { try { process.kill(broker2.pid, "SIGKILL"); } catch { /* gone */ } }
      await wait(200);
      rmSync(sd2, { recursive: true, force: true });
    }
  }

  await nc.drain().catch(() => {});
  console.log(`\nENDPOINT BINDING SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  if (broker.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
