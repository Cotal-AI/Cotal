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
import { jetstreamManager } from "@nats-io/jetstream";
import { createSpaceAuth, ensureAuthorityStores, epAuthBucket, isReachable, mintLifecycleUid, recordAtomicKey, recordsBucket, recordsKvStreamName, RETIREMENT_FRONTIER, serverConfig, type EvictionResult } from "@cotal-ai/core";
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
  const retireArgs = { owner: OWNER, actor: "worker3", lifecycleUid: uid3, opId: retireOp, endpoints: [], frontierStreams: [recordsKvStreamName(space)] };
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
    check("the FRONTIER record was written by the resume over the REAL barrier credential (the frontier.* row)",
      frontier !== undefined && frontier.opId === retireOp && Object.keys(frontier.streams).includes(recordsKvStreamName(space)), frontier);
  }
  check("the resumed retirement revoked the family and verified-evicted the alias principal",
    retireEvicted.includes(`${OWNER}.worker3`)
    && retireResumeLines.some((l) => l.includes(`resumed retirement ${retireOp}`)), { retireEvicted, retireResumeLines });

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
