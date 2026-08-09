/**
 * #29 HIGH 3 plane-claim smoke (SPEC 13.13) — proves the cross-process single-plane exclusion
 * end-to-end over a REAL JWT-permission broker:
 *
 *  - closed row parse (structural refusals, no partial adoption);
 *  - virgin create wins WITHOUT consulting the oracle; a real guarded scan runs over the real
 *    grants (scanner profile + the guard's leader-served plane reads on the barrier profile);
 *  - LIVE PEER refuses with the state-1 copy ("stop the other auth process");
 *  - UNKNOWN / incomplete sweep / contradictory / foreign-echo verdicts refuse with the state-2
 *    copy (fail-safe wording, NEVER "stop the other"; the rail-down variant names the delivery
 *    daemon);
 *  - crash reclaim: both owner connections closed + a complete gone/gone sweep => revision-CAS
 *    reclaim (generation bumps); ONE still-live scanner blocks it;
 *  - claim loss DURING a scan discards the enumeration (the post-scan guard check); a lost claim
 *    refuses BEFORE the next scan; a fenced guard refuses with the state-3 copy;
 *  - clean release => the next open claims the released row without an oracle round;
 *  - a corrupt row refuses loudly and is never overwritten;
 *  - simultaneous virgin open: exactly ONE winner (broker-atomic create);
 *  - the REAL plane ({@link openAuthAuthorityPlane}): dual open refuses; a mid-life scanner death
 *    fences the plane loud (probePlaneDeath); close/reopen cycles cleanly.
 *
 * Run: pnpm smoke:plane-claim:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, epAuthBucket, isReachable, serverConfig, type EvictionResult, type PlaneConnTuple } from "@cotal-ai/core";
import { openAuthorityClient, authorityBarrierGrants } from "../src/authority-client.js";
import { openAuthLedgerScannerCandidate, makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { openRecordsScannerCandidate } from "../src/records-scanner.js";
import { acquirePlaneClaim, parsePlaneClaimRow, scannerDeathCopy, PLANE_CLAIM_KEY, type PlaneLivenessOracle } from "../src/plane-claim.js";
import { openAuthAuthorityPlane } from "../src/service.js";
import type { EvictPrincipal } from "../src/credential-ledger.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const rejects = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error)?.message ?? String(e); } };

const space = `plcl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), "cotal-plcl-"));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};

// Deterministic oracles. `never` fails the run if consulted (the create/released paths must not
// need an oracle); the rest answer with the QUERIED tuples (a bound echo) and a fixed verdict.
const neverOracle: PlaneLivenessOracle = async () => { throw new Error("the oracle must NOT be consulted on a create/released claim path"); };
const verdictOracle = (ledger: "live" | "gone" | "unknown", records: "live" | "gone" | "unknown", sweepComplete: boolean, note?: string): PlaneLivenessOracle =>
  async (q) => ({ ledger: { tuple: q.ledger, state: ledger }, records: { tuple: q.records, state: records }, sweepComplete, ...(note !== undefined ? { note } : {}) });
const foreignEchoOracle: PlaneLivenessOracle = async () => {
  const t: PlaneConnTuple = { serverId: "NFOREIGN", cid: 424242, userNkey: `U${"A".repeat(55)}` };
  return { ledger: { tuple: t, state: "gone" }, records: { tuple: t, state: "gone" }, sweepComplete: true };
};

// ---- A. closed row parse ----
console.log("A. closed claim-row parse");
{
  const enc = new TextEncoder();
  const t: PlaneConnTuple = { serverId: "NDSOMESERVER", cid: 7, userNkey: `U${"B".repeat(55)}` };
  const good = { v: 1, generation: 3, claimId: "c1", state: "held", ledger: t, records: t, openedAt: "2026-07-18T00:00:00.000Z" };
  check("a well-formed v1 row parses", parsePlaneClaimRow(enc.encode(JSON.stringify(good)))?.generation === 3);
  for (const [what, bad] of Object.entries({
    "garbled bytes": "not json{",
    "wrong version": JSON.stringify({ ...good, v: 2 }),
    "zero generation": JSON.stringify({ ...good, generation: 0 }),
    "unknown state": JSON.stringify({ ...good, state: "leased" }),
    "malformed tuple": JSON.stringify({ ...good, ledger: { ...t, cid: -1 } }),
    "bad nkey": JSON.stringify({ ...good, records: { ...t, userNkey: "not-a-key" } }),
    "an unknown extra field": JSON.stringify({ ...good, extra: 1 }),
    "a tuple carrying an unknown extra field": JSON.stringify({ ...good, ledger: { ...t, extra: 1 } }),
  })) {
    check(`a row with ${what} is REFUSED (undefined, never partially adopted)`, parsePlaneClaimRow(enc.encode(bad)) === undefined);
  }
}

let up = false;
for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

// A wide harness writer: store ensure + direct KV manipulation (claim steal / corruption).
const wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
const { ensureAuthorityStores } = await import("@cotal-ai/core");
const { jetstreamManager } = await import("@nats-io/jetstream");
await ensureAuthorityStores(await jetstreamManager(wide.nc), new Kvm(wide.nc), space);
const wideKv = await new Kvm(wide.nc).open(epAuthBucket(space));

const openCands = async () => ({
  ledger: await openAuthLedgerScannerCandidate({ server: SERVERS, space, dataAccount, log: quiet }),
  records: await openRecordsScannerCandidate({ server: SERVERS, space, dataAccount, log: quiet }),
});
const openBarrier = () => openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-barrier:${space}`, grants: (id) => authorityBarrierGrants(space, id), log: quiet });

try {
  // ---- B. virgin create wins, no oracle; a real guarded scan runs ----
  console.log("B. virgin create + guarded scan over the real grants");
  const b1 = await openBarrier();
  const c1 = await openCands();
  check("a plane candidate carries a claim-pinnable tuple (serverId + cid + user nkey)",
    c1.ledger.tuple.serverId.length > 0 && c1.ledger.tuple.cid > 0 && /^U/.test(c1.ledger.tuple.userNkey));
  const hold1 = await acquirePlaneClaim({ nc: b1.nc, space, ledger: c1.ledger.tuple, records: c1.records.tuple, oracle: neverOracle, log: quiet });
  check("the virgin create wins at generation 1 without consulting the oracle", hold1.generation === 1);
  const scanner1 = c1.ledger.activate(hold1.guard);
  const stage = await scanner1.scanStageFamily();
  check("a guarded sealed scan runs end-to-end over the REAL profiles (scanner grants + the guard's leader-served plane reads)", Array.isArray(stage) && stage.length === 0, stage);
  check("a candidate activates exactly once", await rejects(async () => c1.ledger.activate(hold1.guard)) !== "");

  // ---- C. the three refusal faces ----
  console.log("C. refusal faces (live / unknown / rail-down)");
  const b2 = await openBarrier();
  const c2 = await openCands();
  const live = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: verdictOracle("live", "gone", true), log: quiet }));
  check("STATE 1 live peer: refuses naming the live connection", live.includes("another auth plane already owns") && live.includes(String(c1.ledger.tuple.cid)));
  check("STATE 1 tells the operator to stop the OTHER process", live.includes("stop the other auth service process"));
  const unk = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: verdictOracle("gone", "unknown", false, "no conclusive reply for the records connection"), log: quiet }));
  check("STATE 2 unknown: fail-safe wording, cause included", unk.includes("cannot confirm the previous auth plane") && unk.includes("FAIL-SAFE"));
  check("STATE 2 NEVER says to stop the other process (the ghost-chase class)", !unk.includes("stop the other"));
  const raildown = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: verdictOracle("unknown", "unknown", false, "the delivery-admin rail is unreachable (no responders)"), log: quiet }));
  check("STATE 2 rail-down variant names the delivery daemon and the two-step recovery", raildown.includes("delivery daemon") && raildown.includes("cotal up"));
  const contradictory = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: verdictOracle("gone", "gone", false), log: quiet }));
  check("a gone verdict under an INCOMPLETE sweep never reclaims (refuses as state 2)", contradictory.includes("cannot confirm"));
  const foreign = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: foreignEchoOracle, log: quiet }));
  check("a FOREIGN oracle echo never authorizes (treated unknown)", foreign.includes("FOREIGN"));

  // ---- D. one-scanner-live blocks; dead-pair reclaim succeeds ----
  console.log("D. reclaim gates");
  const oneLive = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: verdictOracle("gone", "live", true), log: quiet }));
  check("ONE still-live scanner blocks reclaim (live-peer refusal)", oneLive.includes("another auth plane already owns"));
  // Kill the owner's pair (the crash): both connections drop; a complete gone/gone sweep reclaims.
  await c1.ledger.close();
  await c1.records.close();
  const hold2 = await acquirePlaneClaim({ nc: b2.nc, space, ledger: c2.ledger.tuple, records: c2.records.tuple, oracle: verdictOracle("gone", "gone", true), log: quiet });
  check("a dead pair under a COMPLETE sweep reclaims by revision-CAS (generation bumps)", hold2.generation === 2);
  check("the dead plane's stale guard REFUSES its next scan (a successor owns the claim)",
    (await rejects(() => scanner1.scanStageFamily())).includes("no longer held"));

  // ---- E. claim loss around a scan: pre refuses, mid discards ----
  console.log("E. guard around the scan");
  const enc = new TextEncoder();
  const steal = async () => {
    const cur = await wideKv.get(PLANE_CLAIM_KEY);
    if (cur === null) throw new Error("harness: no claim row to steal");
    const row = parsePlaneClaimRow(cur.value);
    if (row === undefined) throw new Error("harness: unparseable row");
    await wideKv.update(PLANE_CLAIM_KEY, enc.encode(JSON.stringify({ ...row, generation: row.generation + 1, claimId: "thief" })), cur.revision);
  };
  // Mid-scan steal via the smoke probe: the post-scan check DISCARDS the enumeration.
  const guarded = makeLedgerScannerOverConnection(wide.nc, space, { afterCreate: steal }, hold2.guard);
  const discarded = await rejects(() => guarded.scanStageFamily());
  check("a claim stolen DURING the scan DISCARDS the enumeration (post-scan guard)", discarded.includes("DISCARDING"));
  // The claim is now foreign: the next scan refuses BEFORE touching the literal consumer.
  const refused = await rejects(() => guarded.scanStageFamily());
  check("a lost claim refuses BEFORE the next scan (pre-scan guard)", refused.includes("refusing to enumerate"));
  // A fenced guard refuses with the ux state-3 copy without any broker round.
  hold2.fence(scannerDeathCopy(space, "records"));
  const fenced = await rejects(() => guarded.scanStageFamily());
  check("a fenced guard refuses with the STATE 3 copy (deliberate stop, restart NEXT)", fenced.includes("STOPPED scanning") && fenced.includes("restart the auth service"));
  await c2.ledger.close();
  await c2.records.close();

  // ---- E2. a tuple-only row rewrite is a LOST claim (identity is not integrity) ----
  console.log("E2. tuple-only mutation");
  {
    const cands = await openCands();
    const h = await acquirePlaneClaim({ nc: b2.nc, space, ledger: cands.ledger.tuple, records: cands.records.tuple, oracle: verdictOracle("gone", "gone", true), log: quiet });
    // Rewrite the row preserving claimId + generation but swapping ONE scanner tuple (a raw or
    // buggy writer): the guard must read this as a lost claim, never "still ours".
    const cur = await wideKv.get(PLANE_CLAIM_KEY);
    const row = parsePlaneClaimRow(cur!.value)!;
    await wideKv.update(PLANE_CLAIM_KEY, enc.encode(JSON.stringify({ ...row, ledger: { ...row.ledger, cid: row.ledger.cid + 1 } })), cur!.revision);
    const scan = makeLedgerScannerOverConnection(wide.nc, space, undefined, h.guard);
    const refusedTuple = await rejects(() => scan.scanStageFamily());
    check("a tuple-only mutation (same claimId + generation) REFUSES the scan", refusedTuple.includes("scanner tuples no longer match"));
    await h.release();
    const after = await wideKv.get(PLANE_CLAIM_KEY);
    check("release LEAVES a tuple-mutated row alone (a successor may own it)", parsePlaneClaimRow(after!.value)?.state === "held");
    await cands.ledger.close();
    await cands.records.close();
  }

  // ---- F. release fast-path + corruption ----
  console.log("F. release + corruption");
  // Repair the stolen row into a clean released state via a fresh legitimate claim/release.
  {
    const cands = await openCands();
    const b3 = await openBarrier();
    const h = await acquirePlaneClaim({ nc: b3.nc, space, ledger: cands.ledger.tuple, records: cands.records.tuple, oracle: verdictOracle("gone", "gone", true), log: quiet });
    await cands.ledger.close();
    await cands.records.close();
    await h.release();
    const cur = await wideKv.get(PLANE_CLAIM_KEY);
    check("a clean close CASes held -> released", cur !== null && parsePlaneClaimRow(cur.value)?.state === "released");
    // A released row is claimed WITHOUT an oracle round.
    const cands2 = await openCands();
    const h2 = await acquirePlaneClaim({ nc: b3.nc, space, ledger: cands2.ledger.tuple, records: cands2.records.tuple, oracle: neverOracle, log: quiet });
    check("a released row is claimed without an oracle round (generation keeps rising)", h2.generation > h.generation);
    await cands2.ledger.close();
    await cands2.records.close();
    await h2.release();
    await b3.close();
  }
  // Corruption: garbage bytes refuse loudly and are NEVER overwritten.
  {
    const cur = await wideKv.get(PLANE_CLAIM_KEY);
    await wideKv.update(PLANE_CLAIM_KEY, enc.encode("garbage{"), cur!.revision);
    const cands = await openCands();
    const msg = await rejects(() => acquirePlaneClaim({ nc: b2.nc, space, ledger: cands.ledger.tuple, records: cands.records.tuple, oracle: neverOracle, log: quiet }));
    check("a corrupt claim row refuses loudly (operator repair, fail-closed)", msg.includes("not a valid v1 claim"));
    const after = await wideKv.get(PLANE_CLAIM_KEY);
    check("the corrupt row was NOT overwritten (never reasoned over, never auto-repaired)", new TextDecoder().decode(after!.value) === "garbage{");
    await cands.ledger.close();
    await cands.records.close();
    // Repair for the sections below: put a released well-formed row back.
    const t = cands.ledger.tuple;
    await wideKv.update(PLANE_CLAIM_KEY, enc.encode(JSON.stringify({ v: 1, generation: 90, claimId: "repair", state: "released", ledger: t, records: t, openedAt: new Date().toISOString() })), after!.revision);
  }
  await b1.close();
  await b2.close();

  // ---- G. simultaneous open: exactly one winner ----
  console.log("G. simultaneous open (broker-atomic)");
  {
    const spaceG = `${space}g`;
    await ensureAuthorityStores(await jetstreamManager(wide.nc), new Kvm(wide.nc), spaceG);
    const mk = async () => ({
      b: await openAuthorityClient({ server: SERVERS, space: spaceG, dataAccount, label: `cotal:auth-barrier:${spaceG}`, grants: (id) => authorityBarrierGrants(spaceG, id), log: quiet }),
      l: await openAuthLedgerScannerCandidate({ server: SERVERS, space: spaceG, dataAccount, log: quiet }),
      r: await openRecordsScannerCandidate({ server: SERVERS, space: spaceG, dataAccount, log: quiet }),
    });
    const p1 = await mk(), p2 = await mk();
    // The loser's adjudication sees the winner's LIVE candidates - a live verdict is the truth here.
    const settle = await Promise.allSettled([
      acquirePlaneClaim({ nc: p1.b.nc, space: spaceG, ledger: p1.l.tuple, records: p1.r.tuple, oracle: verdictOracle("live", "live", true), log: quiet }),
      acquirePlaneClaim({ nc: p2.b.nc, space: spaceG, ledger: p2.l.tuple, records: p2.r.tuple, oracle: verdictOracle("live", "live", true), log: quiet }),
    ]);
    const winners = settle.filter((s) => s.status === "fulfilled");
    check("simultaneous virgin open yields EXACTLY ONE winner (broker-atomic create)", winners.length === 1, settle.map((s) => s.status));
    for (const x of [p1, p2]) { await x.l.close(); await x.r.close(); await x.b.close(); }
  }

  // ---- H. the REAL plane: dual open refuses; mid-life death fences; close/reopen cycles ----
  console.log("H. openAuthAuthorityPlane end-to-end");
  {
    const dir = join(tmp, "state");
    mkdirSync(dir, { recursive: true });
    const okEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult);
    const logs: string[] = [];
    let kills: { ledger: () => Promise<void>; records: () => Promise<void> } | undefined;
    const plane1 = await openAuthAuthorityPlane({
      server: SERVERS, space, dir, dataAccount, log: (l) => logs.push(l),
      probeEvictor: okEvictor, probePlaneOracle: neverOracle, probePlaneDeath: (k) => { kills = k; },
    });
    check("the real plane opens over the released row without an oracle round", logs.some((l) => l.includes("plane-claim: space")));
    // A second same-space plane: its adjudication sees plane1's LIVE scanners.
    const dual = await rejects(() => openAuthAuthorityPlane({
      server: SERVERS, space, dir, dataAccount, log: quiet,
      probeEvictor: okEvictor, probePlaneOracle: verdictOracle("live", "live", true),
    }));
    check("a second same-space plane REFUSES with the live-peer copy", dual.includes("another auth plane already owns"));
    // Mid-life scanner death: the plane fences itself LOUD (state 3) and survives to a clean close.
    await kills!.ledger();
    for (let i = 0; i < 50 && !logs.some((l) => l.includes("STOPPED scanning")); i++) await wait(100);
    check("a mid-life scanner death logs the STATE 3 copy (deliberate fail-closed stop)", logs.some((l) => l.includes("STOPPED scanning") && l.includes("restart the auth service")));
    // The fence is FATAL for the whole plane (fact HIGH): the signal fires with the state-3
    // OPERATOR copy (the daemon downs itself on it), while the authority faces refuse with the
    // AGENT-facing retryable copy — never the operator's restart instruction (ux audience split).
    const fencedReason = await Promise.race([plane1.fenced, wait(3000).then(() => "")]);
    check("the plane's FATAL signal resolves with the state-3 operator copy", fencedReason.includes("STOPPED scanning"));
    const authRefused = await rejects(() => plane1.authorizeConnect({} as never));
    check("a fenced plane REFUSES authorizeConnect with the agent-facing retryable copy", authRefused.includes("momentarily unavailable") && authRefused.includes("retry"));
    check("the agent-facing refusal never leaks the operator's restart instruction", !authRefused.includes("restart the auth service"));
    const mintRefused = await rejects(async () => plane1.mintConnectCredential({ owner: "local", actor: "x", lifecycleUid: "u" }));
    check("a fenced plane REFUSES mintConnectCredential the same way", mintRefused.includes("momentarily unavailable"));
    await plane1.close();
    // The successor takes over cleanly (the fenced plane released on close; no oracle needed).
    const plane2 = await openAuthAuthorityPlane({
      server: SERVERS, space, dir, dataAccount, log: quiet,
      probeEvictor: okEvictor, probePlaneOracle: neverOracle,
    });
    check("a successor plane opens cleanly after the fenced plane's close", true);
    await plane2.close();
  }
} finally {
  await wide.close();
  srv.kill("SIGTERM");
  if (srv.exitCode === null && srv.signalCode === null) await new Promise<void>((resolve) => { srv.once("exit", () => resolve()); setTimeout(resolve, 3000); });
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nPLANE-CLAIM SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nPLANE-CLAIM SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
