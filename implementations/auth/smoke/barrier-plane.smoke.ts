/**
 * R1/#29 barrier-executor plane smoke (SPEC 13.1/13.9) — proves the auth service's THIRD
 * self-minted connection (the BARRIER EXECUTOR) end-to-end:
 *
 *  - {@link authorityBarrierGrants} connId hygiene (a subject-unsafe connId never widens the inbox);
 *  - GRANT SUFFICIENCY by execution: the FULL takeover barrier (durable intent, freeze CAS,
 *    LastPerSubject family enumeration via the per-run consumer, revokes, epoch head CAS,
 *    reopen) runs over a connection holding EXACTLY that profile;
 *  - GRANT CONFINEMENT: no mint-key writes (`bysrc.`/`uid.`), no `srcgate.`/`session.` writes,
 *    no stream create, no consumer authority on the records stream;
 *  - {@link enumerateOperationIntents}: skips the multi-segment session release pins, sees real
 *    intents, throws on an unknown-kind intent (closed set);
 *  - BOOT CRASH-RESUME through the REAL plane ({@link openAuthAuthorityPlane}): a mid-crash
 *    takeover (evictor failed, gate frozen, intent durable) is finished by the next boot when
 *    eviction verifies, and a boot whose eviction still fails comes up ANYWAY with the alias
 *    left frozen (fail-closed, loud) — one wedged alias never holds the whole space hostage;
 *  - the {@link makeDeliveryAdminEvictor} seam fails CLOSED (verifiedGone:false, honest note)
 *    when no delivery daemon serves the rail.
 *
 * Run: pnpm smoke:barrier-plane:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { contractDigest, createEndpointStreams, createSpaceAuth, ensureAuthorityStores, epAuthBucket, epfStreamName, epfSubject, epwStreamName, epwSubject, isReachable, mintLifecycleUid, publishFactCreateOnly, readLastFact, readRecordLeader, recordAtomicKey, recordsBucket, RETIREMENT_FRONTIER, serverConfig, updateRecordEntry, type EvictionResult } from "@cotal-ai/core";
import { openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, obtainSelfObligation, acceptSelfObligation } from "../src/admission-mediator.js";
import { makeRecordsScannerOverConnection } from "../src/records-scanner.js";
import { deriveOwnerToken, openAuthAuthorityPlane } from "../src/index.js";
import { authorityBarrierGrants, barrierExecutorSettlementGrants, openAuthorityClient } from "../src/authority-client.js";
import { makeDeliveryAdminEvictor } from "../src/barrier-evict.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { observeGate, openLifecycleRegistry, readLifecycleHeadForOperation, registryStores } from "../src/lifecycle-registry.js";
import { credRowKey, enumerateOperationIntents, parseLedgerRow, runAgentTakeoverBarrier, type EvictPrincipal } from "../src/credential-ledger.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "../src/retirement-barrier.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const throwsSync = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
const rejects = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error)?.message ?? String(e); } };

const space = `barpl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), "cotal-barpl-"));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const okEvictor = (calls: string[]): EvictPrincipal => async (principal) => {
  calls.push(principal);
  return { principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult;
};
const failEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: true, note: "probe: eviction refused" });

/** "denied" iff the failure is an authorization rejection — anything else rethrows so a broken
 *  fixture can never false-pass as confinement. */
async function denied(fn: () => Promise<unknown>): Promise<"allowed" | "denied"> {
  try {
    await fn();
    return "allowed";
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/permission|authorization|not authorized|timeout/i.test(msg)) return "denied";
    throw e;
  }
}

let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let barrier: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  // ---- A. connId subject hygiene ----
  const okId = "abcd1234efgh";
  check("the barrier grant builds a scoped inbox for a well-formed connId", authorityBarrierGrants(space, okId).subscribe[0] === `_INBOX_${okId}.>`);
  for (const bad of [">", "*", "a.b", ""]) {
    check(`barrier grant REFUSES a subject-unsafe connId ${JSON.stringify(bad)}`, throwsSync(() => authorityBarrierGrants(space, bad)));
  }
  // The D14 executor-settlement composition (SPEC 13.9 "Retirement settlement"): per listed pool
  // the wrk terminal publish + the lease CAS, plus ONE EPF leader read; poolless refuses; no
  // epw enqueue row ever (the expired-only reconcile structurally never repairs).
  check("the executor settlement grant emits exactly the per-pool wrk publish + lease CAS + one EPF leader read",
    JSON.stringify(barrierExecutorSettlementGrants(space, "jobsrv", ["pa", "pb"]).publish) === JSON.stringify([
      `cotal.${space}.epf.jobsrv.wrk.pa.>`,
      `$KV.${recordsBucket(space)}.lease.jobsrv.pa.>`,
      `cotal.${space}.epf.jobsrv.wrk.pb.>`,
      `$KV.${recordsBucket(space)}.lease.jobsrv.pb.>`,
      `$JS.API.STREAM.MSG.GET.EPF_${space}`,
    ]));
  check("the executor settlement grant REFUSES a poolless list (a poolless settlement authority is none)",
    throwsSync(() => barrierExecutorSettlementGrants(space, "jobsrv", [])));
  check("the executor settlement grant emits NO epw enqueue and NO consumer authority",
    barrierExecutorSettlementGrants(space, "jobsrv", ["pa"]).publish.every((r) => !r.includes(".epw.") && !r.includes("CONSUMER.")));

  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // ---- B. seed through the real issuance path (writer profile, unchanged) ----
  writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
  // The endpoint streams (EPF/EPW/EPE/...) must exist for the retirement frontier step to read
  // their last_seq; a real deployment creates them at space setup. The grant fix (barrier holds
  // STREAM.INFO on the frontier set) is what F2 exercises, but INFO on a nonexistent stream is
  // 'stream not found', so create them here as the provisioner would.
  await createEndpointStreams(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
  const wreg = await openLifecycleRegistry(writer.nc, space);
  const uid1 = mintLifecycleUid();
  const cred1 = await ensureRootCredential(wreg, { owner: OWNER, actor: "worker1", lifecycleUid: uid1, managerInstance: "smoke" });

  // ---- the barrier connection under test ----
  barrier = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-barrier:${space}`, grants: (id) => authorityBarrierGrants(space, id), log: quiet });
  // The barrier profile holds NO auth-stream CONSUMER.CREATE; enumeration runs on the SEALED scanner
  // (a SEPARATE credential — modeled here over the broad writer connection, since the barrier cred
  // deliberately cannot create a consumer). The registry threads the scanner's closed ops.
  const breg = await openLifecycleRegistry(barrier.nc, space, makeLedgerScannerOverConnection(writer.nc, space));
  check("ALLOWED: the barrier connection binds + shape-proves both stores (STREAM.INFO)", true);

  // ---- E1. intent discovery baseline: empty, and session release pins are skipped ----
  check("enumerateOperationIntents on a fresh space sees no intents", (await enumerateOperationIntents(breg)).length === 0);
  // Planted through the WRITER (the session ledger's side of the `stage.` family): the barrier
  // profile deliberately cannot write multi-segment stage keys (see the DENIED check below).
  await registryStores(wreg).authKv.put("stage.session.sess1.c", new TextEncoder().encode(JSON.stringify({ kid: "k", party: "c" })));
  check("a multi-segment stage.session release pin is NOT an operation intent", (await enumerateOperationIntents(breg)).length === 0);

  // ---- C. GRANT SUFFICIENCY: the full takeover barrier over the barrier profile ----
  const evicted: string[] = [];
  const op1 = mintLifecycleUid();
  const res = await runAgentTakeoverBarrier(breg, { owner: OWNER, actor: "worker1", lifecycleUid: uid1, opId: op1 }, { evictPrincipal: okEvictor(evicted) });
  check("the FULL takeover barrier completes over the barrier grant profile", res.toEpoch === 2 && res.toGeneration === 2, res);
  check("the barrier revoked the incarnation's root credential row", res.revokedRows === 1, res.revokedRows);
  check("the barrier verified-evicted the alias principal", evicted.includes(`${OWNER}.worker1`), evicted);
  const rowEntry = await registryStores(wreg).authKv.get(credRowKey(uid1, cred1));
  check("the root credential row reads revoked after the barrier", parseLedgerRow(rowEntry!.value, credRowKey(uid1, cred1)).state === "revoked");
  const gate1 = await observeGate(breg, uid1);
  check("the issuance gate reopened at the successor generation", gate1?.row.state === "open" && gate1.row.generation === 2, gate1?.row);
  const head1 = await readLifecycleHeadForOperation(breg, OWNER, "worker1");
  check("the head advanced to epoch 2 with the operation stamped", head1?.mapping.processEpoch === 2 && head1.mapping.lastTakeoverOpId === op1, head1?.mapping);
  // C1 (panel HIGH, all lanes): the takeover's epoch CAS CLEARS currentCredentialId (which named
  // the now-revoked root). Leaving it set permanently wedges the successor mint. Proven load-bearing:
  // the head's root slot is absent, and a fresh-root mint for the SAME lifecycle then succeeds (the
  // old bug returned permission-denied here).
  check("C1: the head no longer names the revoked root credential after the takeover (slot cleared)",
    head1?.mapping.currentCredentialId === undefined, head1?.mapping);
  const cred1b = await ensureRootCredential(wreg, { owner: OWNER, actor: "worker1", lifecycleUid: uid1, managerInstance: "smoke" });
  check("C1: a successor root mint for the same lifecycle SUCCEEDS after the takeover (no wedge)",
    typeof cred1b === "string" && cred1b !== cred1, { cred1, cred1b });
  const head1b = await readLifecycleHeadForOperation(breg, OWNER, "worker1");
  check("C1: the head now names the FRESH successor root credential", head1b?.mapping.currentCredentialId === cred1b, head1b?.mapping);

  // ---- E2. the completed operation's intent is discoverable (and correctly attributed) ----
  const intents = await enumerateOperationIntents(breg);
  check("enumerateOperationIntents sees the takeover intent with its coordinates", intents.length === 1 && intents[0].opId === op1 && intents[0].kind === "takeover" && intents[0].lifecycleUid === uid1, intents);

  // ---- D. GRANT CONFINEMENT ----
  const bkvm = new Kvm(barrier.nc);
  const authKvB = await bkvm.open(epAuthBucket(space));
  const recKvB = await bkvm.open(recordsBucket(space));
  const enc = new TextEncoder();
  check("DENIED: a bysrc. lineage WRITE (mint keys are not the barrier's)", (await denied(() => authKvB.put(`bysrc.k.i.${uid1}.x`, enc.encode("{}")))) === "denied");
  check("DENIED: a srcgate. WRITE (handle revocation is not this slice's grant)", (await denied(() => authKvB.put("srcgate.k.i", enc.encode("{}")))) === "denied");
  check("DENIED: a session. WRITE (session reconcile is an injected seam)", (await denied(() => authKvB.put("session.s1", enc.encode("{}")))) === "denied");
  check("DENIED: a multi-segment stage.session pin WRITE (the barrier's stage row is one-token stage.*)", (await denied(() => authKvB.put("stage.session.sess9.c", enc.encode("{}")))) === "denied");
  check("DENIED: a records uid. reservation WRITE", (await denied(() => recKvB.put(`uid.${mintLifecycleUid()}`, enc.encode("{}")))) === "denied");
  check("DENIED: STREAM.CREATE (the barrier never provisions stores)", (await denied(() => barrier!.nc.request(`$JS.API.STREAM.CREATE.FORGED_${space}`, enc.encode(JSON.stringify({ name: `FORGED_${space}`, subjects: [`forged.${space}`] })), { timeout: 1500 }))) === "denied");
  check("DENIED: CONSUMER.CREATE on the RECORDS stream (enumeration is auth-store-only)", (await denied(() => barrier!.nc.request(`$JS.API.CONSUMER.CREATE.KV_${recordsBucket(space)}.probe${Date.now() % 1000}`, enc.encode(JSON.stringify({ stream_name: `KV_${recordsBucket(space)}`, config: { ack_policy: "none" } })), { timeout: 1500 }))) === "denied");
  // 46e778f RE-VERIFY (security/fact/distsys/freelance, unanimous HIGH): the barrier holds NO
  // auth-stream CONSUMER.CREATE at all — a create-request BODY is not subject-ACL confinable, so
  // ANY create grant admits a `durable_name` + PUSH `deliver_subject` consumer that exports every
  // current/future auth row and SURVIVES this connection + JWT revoke (nats-server#8274). Bare and
  // legacy DURABLE.CREATE stay denied, AND the exact exploit — the previously-ALLOWED EXTENDED form
  // (matching name token + full auth-bucket filter) with a durable + foreign-deliver body — is now
  // denied. The family enumeration the barrier actually runs (via the SEPARATE sealed auth-ledger
  // scanner, not this barrier credential) proved sufficient at section C (`revokedRows === 1`
  // requires that scan to have worked while THIS credential holds no create at all).
  const authStream = `KV_${epAuthBucket(space)}`;
  check("DENIED: a BARE CONSUMER.CREATE on the auth stream (no pinned filter => body-selectable)",
    (await denied(() => barrier!.nc.request(`$JS.API.CONSUMER.CREATE.${authStream}`, enc.encode(JSON.stringify({ stream_name: authStream, config: { ack_policy: "none" } })), { timeout: 1500 }))) === "denied");
  check("DENIED: a legacy DURABLE.CREATE on the auth stream",
    (await denied(() => barrier!.nc.request(`$JS.API.CONSUMER.DURABLE.CREATE.${authStream}.persist${Date.now() % 1000}`, enc.encode(JSON.stringify({ stream_name: authStream, config: { durable_name: "persist", ack_policy: "none" } })), { timeout: 1500 }))) === "denied");
  const exploitName = `evil${Date.now() % 1000}`;
  const exploitFilter = `$KV.${epAuthBucket(space)}.>`;
  check("DENIED: the EXACT EXPLOIT — EXTENDED create (matching name+filter) with a DURABLE + PUSH body (persistent auth-row exporter)",
    (await denied(() => barrier!.nc.request(
      `$JS.API.CONSUMER.CREATE.${authStream}.${exploitName}.${exploitFilter}`,
      enc.encode(JSON.stringify({ stream_name: authStream, config: { name: exploitName, durable_name: exploitName, filter_subject: exploitFilter, deliver_subject: `attacker.exfil.${space}`, deliver_policy: "all", ack_policy: "none" } })),
      { timeout: 1500 }))) === "denied");
  // No surviving consumer: a WRITER-side (allow-all) INFO confirms the exploit left nothing behind
  // — the denial is at publish, so no durable exporter can persist.
  check("no exploit consumer survives on the auth stream (denied at publish, nothing created)",
    (await rejects(() => jetstreamManager(writer!.nc).then((m) => m.consumers.info(authStream, exploitName)))).length > 0);

  // The barrier holds NO consumer verbs at all — not even against the SEALED scanner's own consumer
  // name (`cotal-ledger-scan`): it can neither inspect, drain, nor delete the sealed scanner's read.
  // (The scanner's CREATE/INFO/NEXT/DELETE live on its own separate credential, never this one.)
  const SCAN_NAME = "cotal-ledger-scan";
  check("DENIED: foreign CONSUMER.INFO on the sealed scanner's consumer name",
    (await denied(() => barrier!.nc.request(`$JS.API.CONSUMER.INFO.${authStream}.${SCAN_NAME}`, enc.encode(""), { timeout: 1500 }))) === "denied");
  check("DENIED: foreign CONSUMER.DELETE on the sealed scanner's consumer name",
    (await denied(() => barrier!.nc.request(`$JS.API.CONSUMER.DELETE.${authStream}.${SCAN_NAME}`, enc.encode(""), { timeout: 1500 }))) === "denied");
  check("DENIED: foreign CONSUMER.MSG.NEXT on the sealed scanner's consumer name",
    (await denied(() => barrier!.nc.request(`$JS.API.CONSUMER.MSG.NEXT.${authStream}.${SCAN_NAME}`, enc.encode(JSON.stringify({ batch: 1, no_wait: true })), { timeout: 1500 }))) === "denied");

  // ---- F. BOOT CRASH-RESUME through the real plane ----
  const uid2 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "worker2", lifecycleUid: uid2, managerInstance: "smoke" });
  const wedgeOp = mintLifecycleUid();
  const wedgeMsg = await rejects(() => runAgentTakeoverBarrier(breg, { owner: OWNER, actor: "worker2", lifecycleUid: uid2, opId: wedgeOp }, { evictPrincipal: failEvictor }));
  check("a takeover whose eviction cannot verify THROWS (fail-closed)", wedgeMsg.length > 0, wedgeMsg.slice(0, 80));
  const wedged = await observeGate(breg, uid2);
  check("the wedged gate stays FROZEN by the crashed operation", wedged?.row.state === "frozen" && wedged.row.op?.opId === wedgeOp, wedged?.row);

  // A boot whose eviction STILL fails comes up anyway — the alias stays frozen, loudly.
  const lines: string[] = [];
  const planeStillWedged = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => lines.push(l), probeEvictor: failEvictor });
  await planeStillWedged.close();
  const stillFrozen = await observeGate(breg, uid2);
  check("a boot with failing eviction still comes up; the alias stays frozen (fail-closed)", stillFrozen?.row.state === "frozen" && stillFrozen.row.op?.opId === wedgeOp, stillFrozen?.row);
  check("the failed resume is LOUD in the service log", lines.some((l) => l.includes(`resuming takeover ${wedgeOp}`) && l.includes("FAILED")), lines);

  // The next boot, with eviction verifying, finishes the owed operation before answering.
  const resumeEvicted: string[] = [];
  const planeResumed = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet, probeEvictor: okEvictor(resumeEvicted) });
  await planeResumed.close();
  const resumedGate = await observeGate(breg, uid2);
  const resumedHead = await readLifecycleHeadForOperation(breg, OWNER, "worker2");
  check("the next boot RESUMES the owed takeover: gate reopened at the successor generation", resumedGate?.row.state === "open" && resumedGate.row.generation === 2, resumedGate?.row);
  check("the resumed takeover advanced the epoch and stamped its op", resumedHead?.mapping.processEpoch === 2 && resumedHead.mapping.lastTakeoverOpId === wedgeOp, resumedHead?.mapping);
  check("the resume verified-evicted the alias principal", resumeEvicted.includes(`${OWNER}.worker2`), resumeEvicted);

  // ---- F2. BOOT CRASH-RESUME of a RETIREMENT through the real plane (#29 piece 4) ----
  // Stage a mid-crash retirement exactly like the takeover wedge: containment eviction fails,
  // the gate stays frozen by the op, the durable intent survives. The endpoint list is empty
  // (no pools for this alias), so the resume exercises the full rail EXCEPT the cleaner step:
  // drain (zero obligations via the sealed records scanner), the FRONTIER record write on the
  // REAL barrier credential (the `frontier.*` grant row, denied before piece 4), and both
  // terminals.
  const uid3 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "worker3", lifecycleUid: uid3, managerInstance: "smoke" });
  const unreached = (what: string) => async (): Promise<never> => { throw new Error(`${what} must not be reached while staging the wedge`); };
  const wedgeDeps = (evict: EvictPrincipal): RetirementDeps => ({
    evictPrincipal: evict,
    drainTargetObligations: unreached("drain"),
    openCleaner: unreached("openCleaner"), retireCleanerCredential: unreached("retireCleanerCredential"),
    openExecutor: unreached("openExecutor"), retireExecutorCredential: unreached("retireExecutorCredential"),
    now: Date.now,
  });
  const retireOp = mintLifecycleUid();
  // Production frontier set: EPF + EPW (the normative retirement contract, retirement-barrier.smoke
  // uses these). Step 6 does STREAM.INFO on each over the REAL barrier credential, so this proves
  // authorityBarrierGrants carries their INFO rows (the prior records-only F2 masked the gap).
  const retireArgs = { owner: OWNER, actor: "worker3", lifecycleUid: uid3, opId: retireOp, endpoints: [], frontierStreams: [epfStreamName(space), epwStreamName(space)] };
  const retireWedgeMsg = await rejects(() => runAgentRetirementBarrier(breg, retireArgs, wedgeDeps(failEvictor)));
  check("a retirement whose eviction cannot verify THROWS (fail-closed)", retireWedgeMsg.length > 0, retireWedgeMsg.slice(0, 80));
  const retireWedged = await observeGate(breg, uid3);
  check("the wedged retirement gate stays FROZEN by the crashed op", retireWedged?.row.state === "frozen" && retireWedged.row.op?.opId === retireOp, retireWedged?.row);

  const retireLines: string[] = [];
  const planeRetireWedged = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => retireLines.push(l), probeEvictor: failEvictor });
  await planeRetireWedged.close();
  check("a boot with failing eviction leaves the retirement frozen and is LOUD",
    (await observeGate(breg, uid3))?.row.state === "frozen"
    && retireLines.some((l) => l.includes(`resuming retirement ${retireOp}`) && l.includes("FAILED")), retireLines);

  const retireEvicted: string[] = [];
  const retireResumeLines: string[] = [];
  const planeRetireResumed = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => retireResumeLines.push(l), probeEvictor: okEvictor(retireEvicted) });
  await planeRetireResumed.close();
  const retiredGate = await observeGate(breg, uid3);
  const retiredHead = await readLifecycleHeadForOperation(breg, OWNER, "worker3");
  check("the next boot RESUMES the owed retirement: gate terminal under the op (never reopened)",
    retiredGate?.row.state === "retired" && retiredGate.row.op?.opId === retireOp, retiredGate?.row);
  check("the head is terminal `retired` (the alias is replaceable now)", retiredHead?.mapping.state === "retired", retiredHead?.mapping);
  {
    const fr = await registryStores(breg).recordsKv.get(recordAtomicKey(RETIREMENT_FRONTIER, [uid3]));
    const frontier = fr && fr.operation === "PUT" ? JSON.parse(new TextDecoder().decode(fr.value)) as { opId: string; streams: Record<string, number> } : undefined;
    check("the FRONTIER record was written by the resume over the REAL barrier credential (frontier.* write + EPF/EPW STREAM.INFO)",
      frontier !== undefined && frontier.opId === retireOp
      && Object.keys(frontier.streams).sort().join() === [epfStreamName(space), epwStreamName(space)].sort().join(), frontier);
  }
  check("the resumed retirement revoked the family and verified-evicted the alias principal",
    retireEvicted.includes(`${OWNER}.worker3`)
    && retireResumeLines.some((l) => l.includes(`resumed retirement ${retireOp}`)), { retireEvicted, retireResumeLines });

  // ---- F3. the assembled drain fails CLOSED + OPERATOR-legible on unmaterialized accepted work
  // (#29 HIGH 1 scoped narrow): the production drain holds no records-write authority, so an
  // accepted obligation whose route was never materialized cannot be reconciled here. The resume
  // must leave the alias FROZEN (not lost) with an operator-legible message, not the mediator's
  // developer-vocabulary throw. Real plane, real mediator profile. ----
  const uid4 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "worker4", lifecycleUid: uid4, managerInstance: "smoke" });
  {
    // Seed an ACCEPTED effects obligation under the retiring target, with no completion marker
    // (unmaterialized), through the real mediator profile + the plane's sealed records scanner.
    const recScanner = makeRecordsScannerOverConnection(writer.nc, space);
    const EP = "manager";
    const med = await openAdmissionMediator(writer.nc, space, EP, { recordsScanner: recScanner });
    const caller = { owner: OWNER, actor: "acaller", uid: "a".repeat(26) };
    const target = { owner: OWNER, actor: "worker4", lifecycleUid: uid4 };
    const req = mediatedRequestFromSubject(`cotal.${space}.epj.${EP}.admit.${caller.owner}.${caller.actor}.${caller.uid}`);
    const fpAcc = contractDigest({ id: "acc001" });
    const got = await obtainEpfObligation(med, req, { target, id: "acc001", fingerprint: fpAcc, sourceSeq: 1, route: "effects" });
    // Forge the acceptance decision fact the accepted row derives from (else the drain hits a
    // corruption check before reconcileAcceptedRoute); route effects, no completion marker.
    const D = contractDigest({ probe: true });
    const from = { id: `${caller.owner}.${caller.actor}`, name: "c" };
    const decFact = {
      v: 1, id: "acc001", decision: "accepted", fingerprint: fpAcc,
      request: { v: 1, id: "acc001", op: { endpoint: EP, command: "run", inputDigest: D, outputDigest: D }, class: "journal", replyExpected: false, deadlineMs: 5000, args: {}, from, target },
      caller: { id: from.id, lifecycleUid: caller.uid }, contractDigests: { input: D, output: D },
      authzDecision: { revision: 1, epoch: 1 }, route: "effects", sourceSeq: 1, ts: 1, target,
    };
    const decSubject = epfSubject(space, EP, ["dec", caller.owner, caller.actor, caller.uid, "acc001"]);
    if (!(await publishFactCreateOnly(jetstream(writer.nc), decSubject, new TextEncoder().encode(JSON.stringify(decFact)))).won) throw new Error("acceptance forge lost");
    await updateRecordEntry(registryStores(wreg).recordsKv, got.key, { ...got.row, state: "accepted" }, got.revision); // accepted, unmaterialized (no done marker)
  }
  const retireOp4 = mintLifecycleUid();
  const wedge4 = await rejects(() => runAgentRetirementBarrier(breg, {
    owner: OWNER, actor: "worker4", lifecycleUid: uid4, opId: retireOp4,
    endpoints: [], frontierStreams: [epfStreamName(space), epwStreamName(space)],
  }, wedgeDeps(failEvictor)));
  check("the retirement wedges at eviction with the accepted obligation still pending", wedge4.length > 0, wedge4.slice(0, 80));

  const drainLines: string[] = [];
  const planeDrainWedged = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => drainLines.push(l), probeEvictor: okEvictor([]) });
  await planeDrainWedged.close();
  check("the resume gets past eviction and FAILS CLOSED at the drain on in-flight accepted EFFECTS work",
    (await observeGate(breg, uid4))?.row.state === "frozen"
    && (await readLifecycleHeadForOperation(breg, OWNER, "worker4"))?.mapping.state !== "retired", await observeGate(breg, uid4));
  check("the effects freeze is OPERATOR-legible (FROZEN not lost + the real self-heal NEXT), never a seam-dep throw or a stale build pointer",
    drainLines.some((l) => l.includes(`resuming retirement ${retireOp4}`) && l.includes("FROZEN, not lost")
      && l.includes("serving endpoint's own writer")
      && !l.includes("cancelEffectsRoute was given") && !l.includes("#29") && !l.includes("commit-applier")), drainLines);

  // ---- F4. the CONFINED drain repairers AUTO-COMPLETE covered accepted work over the REAL
  // per-op reduced credentials (#29 HIGH 1 functional closure): an accepted SELF commit that
  // never landed re-applies (guarded create at its pinned base) and an accepted POOL route that
  // never enqueued re-materializes from the mediator-derived CLOSED repair command — the
  // retirement then COMPLETES on resume instead of freezing. Real plane, real broker ACLs on the
  // per-repair exact-coordinate credentials. ----
  const uid5 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "worker5", lifecycleUid: uid5, managerInstance: "smoke" });
  const F4_COMMIT_KEY = `goal.manager.${OWNER}.bcaller.${"b".repeat(26)}.g00001.spec`;
  const f4Desired = { probe: "f4", v: 1 };
  const F4_POOL = "workpool";
  const f4Caller = { owner: OWNER, actor: "bcaller", uid: "b".repeat(26) };
  {
    const recScanner = makeRecordsScannerOverConnection(writer.nc, space);
    const EP = "manager";
    const med = await openAdmissionMediator(writer.nc, space, EP, { recordsScanner: recScanner });
    const target = { owner: OWNER, actor: "worker5", lifecycleUid: uid5 };
    const req = mediatedRequestFromSubject(`cotal.${space}.epj.${EP}.admit.${f4Caller.owner}.${f4Caller.actor}.${f4Caller.uid}`);
    // (a) the accepted SELF row whose commit never landed (crash after accept, before the write).
    const selfGot = await obtainSelfObligation(med, req, {
      target, id: "self0001",
      commit: {
        commitKey: F4_COMMIT_KEY, commitBaseRevision: 0,
        commitValue: { enc: "b64u", bytes: Buffer.from(JSON.stringify(f4Desired)).toString("base64url") },
        commitDigest: contractDigest(f4Desired),
      },
    });
    await acceptSelfObligation(med, selfGot.proof);
    // (b) the accepted POOL row whose enqueue never landed (crash before enqueue), with the
    // durable acceptance decision the mediator derives the repair from.
    const fpP = contractDigest({ id: "pool0001" });
    const gotP = await obtainEpfObligation(med, req, { target, id: "pool0001", fingerprint: fpP, sourceSeq: 2, route: `pool.${F4_POOL}` });
    const D2 = contractDigest({ probe: "f4p" });
    const from2 = { id: `${f4Caller.owner}.${f4Caller.actor}`, name: "c" };
    const decFact2 = {
      v: 1, id: "pool0001", decision: "accepted", fingerprint: fpP,
      request: { v: 1, id: "pool0001", op: { endpoint: EP, command: "run", inputDigest: D2, outputDigest: D2 }, class: "journal", replyExpected: false, deadlineMs: 5000, args: {}, from: from2, target },
      caller: { id: from2.id, lifecycleUid: f4Caller.uid }, contractDigests: { input: D2, output: D2 },
      authzDecision: { revision: 1, epoch: 1 }, route: `pool.${F4_POOL}`, workExpiry: Date.now() + 300_000, sourceSeq: 2, ts: 1, target,
    };
    const decSubject2 = epfSubject(space, EP, ["dec", f4Caller.owner, f4Caller.actor, f4Caller.uid, "pool0001"]);
    if (!(await publishFactCreateOnly(jetstream(writer.nc), decSubject2, new TextEncoder().encode(JSON.stringify(decFact2)))).won) throw new Error("pool acceptance forge lost");
    await updateRecordEntry(registryStores(wreg).recordsKv, gotP.key, { ...gotP.row, state: "accepted" }, gotP.revision);
  }
  const retireOp5 = mintLifecycleUid();
  const wedge5 = await rejects(() => runAgentRetirementBarrier(breg, {
    owner: OWNER, actor: "worker5", lifecycleUid: uid5, opId: retireOp5,
    endpoints: [], frontierStreams: [epfStreamName(space), epwStreamName(space)],
  }, wedgeDeps(failEvictor)));
  check("F4: the retirement wedges at eviction with covered accepted work still pending", wedge5.length > 0, wedge5.slice(0, 80));
  const repairLines: string[] = [];
  const planeRepair = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: (l) => repairLines.push(l), probeEvictor: okEvictor([]) });
  await planeRepair.close();
  {
    const committed = await readRecordLeader(registryStores(wreg).jsm, space, F4_COMMIT_KEY);
    check("F4: the per-op COMMIT APPLIER landed the accepted self-commit (guarded create, pinned digest)",
      committed !== undefined && contractDigest(committed.value) === contractDigest(f4Desired), committed?.value);
    const itemSubject = epwSubject(space, "manager", F4_POOL, { owner: f4Caller.owner, actor: f4Caller.actor, uid: f4Caller.uid, id: "pool0001" });
    const item = await readLastFact(registryStores(wreg).jsm, epwStreamName(space), itemSubject);
    check("F4: the per-op POOL RECONCILER re-enqueued the mediator's closed repair (live EPW item, canonical acceptance bytes)",
      item !== undefined && (item as { id?: string }).id === "pool0001" && (item as { workExpiry?: number }).workExpiry !== undefined, item);
    check("F4: the retirement COMPLETED on resume (head retired) - covered accepted work no longer freezes the alias",
      (await readLifecycleHeadForOperation(breg, OWNER, "worker5"))?.mapping.state === "retired"
      && repairLines.some((l) => l.includes("applied the accepted self-commit"))
      && repairLines.some((l) => l.includes("re-enqueued the accepted pool item")), repairLines.filter((l) => l.includes("drain-repair")));
  }

  // ---- G. the delivery-admin eviction seam fails CLOSED with no daemon on the rail ----
  const seam = makeDeliveryAdminEvictor({ space, server: SERVERS, dataAccount, log: quiet });
  const seamRes = await seam(`${OWNER}.worker1`);
  check("no delivery daemon => verifiedGone:false (the barrier would stay frozen)", seamRes.verifiedGone === false && seamRes.scanComplete === false, seamRes);
  check("the seam's failure carries an honest note", typeof seamRes.note === "string" && seamRes.note.length > 0, seamRes.note);

  // ---- E3. a garbled intent poisons the store LOUDLY (last: it breaks later enumerations) ----
  await registryStores(breg).authKv.put(`stage.${mintLifecycleUid()}`, enc.encode(JSON.stringify({ kind: "weird" })));
  const poisonMsg = await rejects(() => enumerateOperationIntents(breg));
  check("an unknown-kind operation intent THROWS (closed set; garbled state never drives a barrier)", poisonMsg.includes("unknown kind"), poisonMsg.slice(0, 100));

  console.log(`\nBARRIER-PLANE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await barrier?.close().catch(() => {});
  await writer?.close().catch(() => {});
  srv.kill();
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
}
