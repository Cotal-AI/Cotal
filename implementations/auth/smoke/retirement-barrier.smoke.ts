/**
 * The D13 (5) retirement-barrier smoke (SPEC §13.1/§13.8/§13.9): the FULL terminal barrier over
 * a LIVE broker in the normative order — intent → gate freeze → head retiring → containment
 * (revoke + live verified eviction) → obligation drain to quiescence → the exact-pool terminal
 * cleaner under a DISTINCT live connection (terminal-ACK, expired settle, retired settle with
 * acceptance re-bind, foreign-live refusal) → the cleaner fence (credential retired + principal
 * LIVE-evicted BEFORE any frontier) → frontier record → gate terminal → head terminal → the
 * alias replaceable only now, with a fresh UID. Plus the wedge/resume boundary and the
 * authority negatives (stranger opId, foreign frontier, one-barrier-at-a-time, no reopen).
 *
 * Real nats-server with JetStream + a REAL system account (CONNZ + KICK live, the credential-
 * ledger smoke's harness). Broker killed by exact PID; never pkill nats-server.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, contractDigest, createRecordEntry, updateRecordEntry, epAuthBucket,
  recordAtomicKey, recordSpecKey, RECORD_KINDS, RETIREMENT_FRONTIER, evictDeniedPrincipal, MEMBERSHIP_INBOX_PREFIX,
  effectFactOf, epfEffectSubject, epfSubject, epfStreamName, epwSubject, epwStreamName, poolConsumerConfig, poolDurable,
  publishFactCreateOnly, readLastFact, parseWorkTerminalFact, parseDecisionFact, workTerminalSubject,
  recordStatusKey, goalResultSubject, parseGoalResultFact, goalCancelledResultOf,
} from "@cotal-ai/core";
import { openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, drainTargetForEndpoint, type MediatedRequest } from "../src/admission-mediator.js";
import { openLifecycleRegistry, activateLifecycle, registryStores, observeGate, reopenGate, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { stageAgentMint, finalizeAgentMint, credRowKey, type EvictPrincipal } from "../src/credential-ledger.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { makeRecordsScannerOverConnection } from "../src/records-scanner.js";
import { runAgentRetirementBarrier, resumeAgentRetirement, settlementForIntent, type RetirementDeps, type PoolCleanerBind, type RetirementExecutorBind } from "../src/retirement-barrier.js";
import { drainRepairPrincipals } from "../src/drain-repair.js";
import { workPoolContext } from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
  return cond();
};

const SPACE = "retire";
const EP = "term";
const EP2 = "blocker";
const POOL = "workpool";
// A second pool used ONLY by E2, whose barrier aborts at the executor mint BEFORE its pool item is
// cleaned; an own pool keeps that deliberately-orphaned item off every other scenario's pool.
const POOL2 = "execpool";
const MGR = "mgr-1";
const NOW = 1_700_000_000_000;
const D = contractDigest({ s: 1 });
const fp = (tag: string): string => contractDigest({ fp: tag });
const EVICT_OPTS = { maxWaitMs: 1500, settleMs: 200, maxVerifyRounds: 3 } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

const PORT = await pickFreePort();
// #4 repro: the applier principal of scenario H's op, surfaced as a static-conf user whose CONNZ
// `authorized_user` name maps back to `local.epapl_<hash>` (principalFromName splits the first
// dash). A live connection under it models a repair bearer still connected when the barrier is
// about to close the frontier; the drain-repair fence must cluster-verified-evict it first.
const OP_H = "h".repeat(26);
const APPLIER_USER = drainRepairPrincipals(OP_H)[0]!.principal.replace(".", "-"); // local.epapl_<hash> -> local-epapl_<hash>
const sd = mkdtempSync(join(tmpdir(), "cotal-retire-"));
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
system_account: SYS
jetstream { store_dir: ${JSON.stringify(sd)} }
accounts {
  SYS: { users = [ { user: "sys", password: "pw" } ] }
  APP: {
    jetstream: enabled
    users = [
      { user: "auth", password: "pw" }
      { user: "local-victim", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
      { user: "local-cleaner", password: "pw" }
      { user: "local-executor", password: "pw" }
      { user: "${APPLIER_USER}", password: "pw" }
    ]
  }
}
`);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

let nc: NatsConnection | undefined, sysObserver: NatsConnection | undefined, sysEvictor: NatsConnection | undefined,
  victim: NatsConnection | undefined;
const cleanerConns: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://auth:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "auth", pass: "pw" });
  sysObserver = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "sys", pass: "pw", inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 });
  sysEvictor = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "sys", pass: "pw", maxReconnectAttempts: 0 });
  const liveEvict: EvictPrincipal = (principal) => evictDeniedPrincipal(sysObserver!, sysEvictor!, "APP", principal, EVICT_OPTS);

  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  // ONE sealed records scanner shared by the barrier registry AND both mediators (its internal lock
  // serializes every obligation scan over the one records-stream consumer name; site 3).
  const recScanner = makeRecordsScannerOverConnection(nc, SPACE);
  const reg = await openLifecycleRegistry(nc, SPACE, makeLedgerScannerOverConnection(nc, SPACE), recScanner);
  const { recordsKv, authKv } = registryStores(reg);
  let clock = NOW;
  const meds = {
    [EP]: await openAdmissionMediator(nc, SPACE, EP, { now: () => clock, recordsScanner: recScanner }),
    [EP2]: await openAdmissionMediator(nc, SPACE, EP2, { now: () => clock, recordsScanner: recScanner }),
  };
  const mkReq = (endpoint: string, cc: { owner: string; actor: string; uid: string }): MediatedRequest =>
    mediatedRequestFromSubject(`cotal.${SPACE}.epj.${endpoint}.admit.${cc.owner}.${cc.actor}.${cc.uid}`);
  // Pre-created pool durables (the provisioner's job), short AckWait so a dead owner's
  // un-ACKed delivery redelivers into the cleaner within the smoke budget.
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, EP, POOL, { ackWaitMs: 700 }));
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, EP2, POOL, { ackWaitMs: 700 }));

  /** Forge the CANONICAL acceptance decision fact an endpoint canonicalizer would have written
   *  for a pool-routed journal submission (core-valid: the cleaner re-binds through it). */
  const acceptPoolItem = async (args: {
    endpoint: string; caller: { owner: string; actor: string; uid: string }; id: string;
    target?: { owner: string; actor: string; lifecycleUid: string }; workExpiry: number; sourceSeq: number;
    /** The pool the item routes to; defaults to POOL. */
    pool?: string;
    /** Write the acceptance decision fact but NOT the EPW item (the crash-before-enqueue state). */
    skipEnqueue?: boolean;
  }): Promise<void> => {
    const pool = args.pool ?? POOL;
    const from = { id: `${args.caller.owner}.${args.caller.actor}`, name: "c" };
    const request: Record<string, unknown> = {
      v: 1, id: args.id, op: { endpoint: args.endpoint, command: "run", inputDigest: D, outputDigest: D },
      class: "journal", replyExpected: false, deadlineMs: 5000, args: {}, from,
    };
    if (args.target !== undefined) request.target = args.target;
    const fact: Record<string, unknown> = {
      v: 1, id: args.id, decision: "accepted", fingerprint: fp(args.id), request,
      caller: { id: from.id, lifecycleUid: args.caller.uid },
      contractDigests: { input: D, output: D }, authzDecision: { revision: 1, epoch: 1 },
      route: `pool.${pool}`, workExpiry: args.workExpiry, sourceSeq: args.sourceSeq, ts: NOW,
    };
    if (args.target !== undefined) fact.target = args.target;
    const subject = epfSubject(SPACE, args.endpoint, ["dec", args.caller.owner, args.caller.actor, args.caller.uid, args.id]);
    parseDecisionFact(fact, subject); // the forge must be core-valid or the probe proves nothing
    if (!(await publishFactCreateOnly(js, subject, enc.encode(JSON.stringify(fact)))).won) throw new Error(`acceptance forge lost on ${subject}`);
    if (args.skipEnqueue !== true)
      await js.publish(epwSubject(SPACE, args.endpoint, pool, { ...args.caller, id: args.id }), enc.encode(JSON.stringify({ item: args.id })));
  };

  const events: string[] = [];
  const frontierKeyOf = (uid: string) => recordAtomicKey(RETIREMENT_FRONTIER, [uid]);
  const mkDeps = (opts: { failCleanerOpen?: boolean; failExecutorOpen?: boolean; guardUid?: string } = {}): RetirementDeps => ({
    evictPrincipal: async (p) => {
      // The drain-repair fence (§13.1, #4) precedes THIS retirement's frontier, exactly like the
      // cleaner/executor fence: a repair-principal evict that ran AFTER a frontier existed would
      // mean the applier could have written its last-value record past the cutoff.
      if (opts.guardUid !== undefined && /^local\.(epapl|eprec|epcan)_/.test(p)) {
        const fr = await recordsKv.get(frontierKeyOf(opts.guardUid));
        if (fr && fr.operation === "PUT") throw new Error(`a drain-repair principal (${p}) was evicted AFTER a frontier record existed (${opts.guardUid})`);
      }
      const r = await liveEvict(p); events.push(`evict:${p}:${JSON.stringify(r)}`); return r;
    },
    drainTargetObligations: async (endpoint, targetUid) => {
      const med = meds[endpoint as keyof typeof meds];
      if (med === undefined) throw new Error(`no mediator for endpoint ${endpoint}`);
      await drainTargetForEndpoint(med, targetUid, { cancelEffectsRoute: async ({ key }) => {
        const [cOwner, cActor, cUid, id] = key.split(".").slice(3);
        const decSubject = epfSubject(SPACE, endpoint, ["dec", cOwner, cActor, cUid, id]);
        const decision = parseDecisionFact(await readLastFact(jsm, epfStreamName(SPACE), decSubject), decSubject);
        if (decision.decision !== "accepted") throw new Error(`expected accepted decision at ${decSubject}`);
        await publishFactCreateOnly(js, epfEffectSubject(SPACE, endpoint, { owner: cOwner, actor: cActor, uid: cUid }, id), enc.encode(JSON.stringify(effectFactOf(decision, clock))));
      } });
    },
    openCleaner: async ({ endpoint, pools }): Promise<PoolCleanerBind> => {
      if (opts.failCleanerOpen) throw new Error("simulated crash at cleaner mint");
      events.push(`openCleaner:${endpoint}:${pools.join(",")}`);
      const conn = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-cleaner", pass: "pw", reconnect: false });
      cleanerConns.push(conn);
      return { jsm: await jetstreamManager(conn), js: jetstream(conn), principal: "local.cleaner" };
    },
    retireCleanerCredential: async () => {
      // The order probe: the cleaner fence MUST precede THIS retirement's frontier record (§13.1).
      if (opts.guardUid !== undefined) {
        const fr = await recordsKv.get(frontierKeyOf(opts.guardUid));
        if (fr && fr.operation === "PUT") throw new Error(`cleaner retired AFTER a frontier record existed (${opts.guardUid})`);
      }
      events.push("retireCleanerCredential");
      // Deliberately does NOT close the connection: the barrier's own verified eviction must
      // kill the live cleaner (the deny-new half is the deployment's; kill-live is the barrier's).
    },
    openExecutor: async ({ endpoint, pools }): Promise<RetirementExecutorBind> => {
      if (opts.failExecutorOpen) throw new Error("simulated crash at executor mint");
      events.push(`openExecutor:${endpoint}:${pools.join(",")}`);
      const conn = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-executor", pass: "pw", reconnect: false });
      cleanerConns.push(conn);
      // A REAL constructed (branded, space-bonded) work context over the executor's OWN
      // connection: the settlement seam asserts the brand, a hand-assembled bundle would throw.
      return { work: await workPoolContext(conn, SPACE), principal: "local.executor" };
    },
    retireExecutorCredential: async () => {
      // The same order probe: the executor fence too precedes THIS retirement's frontier (§13.1).
      if (opts.guardUid !== undefined) {
        const fr = await recordsKv.get(frontierKeyOf(opts.guardUid));
        if (fr && fr.operation === "PUT") throw new Error(`executor retired AFTER a frontier record existed (${opts.guardUid})`);
      }
      events.push("retireExecutorCredential");
    },
    now: () => clock,
    cleaner: { fetchExpiresMs: 1000, maxStalledPasses: 4 },
  });

  console.log("A. the full barrier in the normative order");
  const act1 = await activateLifecycle(reg, { owner: "local", actor: "victim", managerInstance: MGR });
  const uid1 = act1.mapping.lifecycleUid;
  const tgt1 = { owner: "local", actor: "victim", lifecycleUid: uid1 };
  await finalizeAgentMint(reg, await stageAgentMint(reg, { lifecycleUid: uid1, credentialId: "root0001", holderPrincipal: "local.victim", sourceChain: ["root"], exp: NOW + 60_000 }));
  // reconnect: false models the deny-new outcome for a static conf user (the credential-ledger
  // smoke's rationale): the barrier drives a REAL KICK and the kicked client cannot return.
  victim = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-victim", pass: "pw", reconnect: false });
  let victimClosed = false;
  victim.closed().then(() => { victimClosed = true; }, () => { victimClosed = true; });

  // The obligations under the retiring target: one PROVISIONAL (the drain must settle it) and
  // one ACCEPTED pool row whose EPW item exists (the drain verifies its route postcondition).
  const cOwn = { owner: "local", actor: "caller", uid: "a".repeat(26) };
  const cPr = { owner: "local", actor: "caller", uid: "b".repeat(26) };
  await obtainEpfObligation(meds[EP], mkReq(EP, cPr), { target: tgt1, id: "pr0001", fingerprint: fp("pr0001"), sourceSeq: 3, route: "effects" });
  const own = await obtainEpfObligation(meds[EP], mkReq(EP, cOwn), { target: tgt1, id: "own001", fingerprint: fp("own001"), sourceSeq: 4, route: `pool.${POOL}` });
  await updateRecordEntry(recordsKv, own.key, { ...own.row, state: "accepted" }, own.revision); // the canonicalizer accepted it
  await acceptPoolItem({ endpoint: EP, caller: cOwn, id: "own001", target: tgt1, workExpiry: NOW + 100_000, sourceSeq: 4 });
  // A FOREIGN (untargeted) item already past its own horizon: the cleaner settles it `expired`.
  const cFor = { owner: "local", actor: "other", uid: "d".repeat(26) };
  await acceptPoolItem({ endpoint: EP, caller: cFor, id: "for001", workExpiry: NOW - 5, sourceSeq: 6 });
  // Reachable commit crash: the lease CAS committed, but the owner died before publishing `wrk`.
  // Retirement must derive/publish COMMITTED from this authoritative lease, never overwrite it.
  const cCommitted = { owner: "local", actor: "worker", uid: "f".repeat(26) };
  await acceptPoolItem({ endpoint: EP, caller: cCommitted, id: "com001", target: tgt1, workExpiry: NOW + 100_000, sourceSeq: 7 });
  await createRecordEntry(recordsKv, recordSpecKey(RECORD_KINDS.lease, [EP, POOL, cCommitted.owner, cCommitted.actor, cCommitted.uid, "com001"]), {
    v: 1, state: "settled", sourceSeq: 7, attempt: 1,
    worker: { kind: "agent", owner: "local", actor: "worker", lifecycleUid: "w".repeat(26) },
    fencingToken: 1, leaseDeadline: NOW + 5_000, workExpiry: NOW + 100_000,
    disposition: "committed", outcome: { preserved: true }, committedTs: NOW - 1,
  });
  // An item ALREADY durably terminal: the cleaner only ACKs it.
  const cDone = { owner: "local", actor: "other", uid: "e".repeat(26) };
  const doneRef = { endpoint: EP, pool: POOL, acceptance: { ...cDone, id: "done01" } };
  await js.publish(epwSubject(SPACE, EP, POOL, doneRef.acceptance), enc.encode(JSON.stringify({ item: "done01" })));
  if (!(await publishFactCreateOnly(js, workTerminalSubject(SPACE, doneRef), enc.encode(JSON.stringify({ v: 1, disposition: "expired", pool: POOL, caller: doneRef.acceptance, workExpiry: NOW - 9, ts: NOW - 9 })))).won)
    throw new Error("pre-terminal forge lost");

  c("the victim principal is live before the barrier", !victim.isClosed());
  const op1 = "1".repeat(26);
  const res1 = await runAgentRetirementBarrier(reg, {
    owner: "local", actor: "victim", lifecycleUid: uid1, opId: op1,
    frontierStreams: [epfStreamName(SPACE), epwStreamName(SPACE)],
  }, mkDeps({ guardUid: uid1 }));
  c("the barrier revokes the family and live-evicts the alias + cleaner principals",
    res1.revokedRows >= 1 && res1.evictedPrincipals.includes("local.victim"), res1);
  c("the victim's live connection was killed by the containment eviction", await until(() => victimClosed || victim!.isClosed()), events.filter((e) => e.startsWith("evict:")));
  c("the drain drove this endpoint's obligations", res1.drainedEndpoints.includes(EP), res1.drainedEndpoints);
  const cleanedA = res1.cleaned[`${EP}/${POOL}`];
  c("the cleaner settled terminal/committed-crash, expired, and retired item classes",
    cleanedA !== undefined && cleanedA.ackedTerminal === 2 && cleanedA.settledExpired === 1 && cleanedA.settledRetired === 1, cleanedA);
  {
    const row = JSON.parse(dec.decode((await authKv.get(credRowKey(uid1, "root0001")))!.value)) as { state: string };
    c("the root credential row is revoked", row.state === "revoked", row);
    const ownRef = { endpoint: EP, pool: POOL, acceptance: { ...cOwn, id: "own001" } };
    const term = parseWorkTerminalFact(await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, ownRef)), workTerminalSubject(SPACE, ownRef), ownRef);
    c("the retiring target's live item carries a core-valid `retired` terminal bound to the op + target",
      term.disposition === "retired" && term.opId === op1 && term.targetUid === uid1, term);
    const committedRef = { endpoint: EP, pool: POOL, acceptance: { ...cCommitted, id: "com001" } };
    const committed = parseWorkTerminalFact(await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, committedRef)), workTerminalSubject(SPACE, committedRef), committedRef);
    c("a committed lease with no wrk is recovered as its committed terminal, never retired",
      committed.disposition === "committed" && (committed.outcome as { preserved?: boolean }).preserved === true, committed);
    const forRef = { endpoint: EP, pool: POOL, acceptance: { ...cFor, id: "for001" } };
    const termFor = parseWorkTerminalFact(await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, forRef)), workTerminalSubject(SPACE, forRef), forRef);
    c("the foreign expired item was settled `expired` against its OWN horizon", termFor.disposition === "expired", termFor);
    const decSubject = epfSubject(SPACE, EP, ["dec", cPr.owner, cPr.actor, cPr.uid, "pr0001"]);
    const rj = parseDecisionFact(await readLastFact(jsm, epfStreamName(SPACE), decSubject), decSubject);
    c("the provisional obligation was settled through its decision coordinate (rejection fact)", rj.decision === "rejected");
    const info = await (await js.consumers.get(epwStreamName(SPACE), poolDurable(EP, POOL))).info(false);
    c("the pool is PROVEN quiescent (zero pending, zero ack-pending)", info.num_pending === 0 && info.num_ack_pending === 0, info);
    const fr = await recordsKv.get(frontierKeyOf(uid1));
    const frontier = JSON.parse(dec.decode(fr!.value)) as { opId: string; streams: Record<string, number> };
    c("the frontier record binds this op and covers the named streams",
      frontier.opId === op1 && Object.keys(frontier.streams).sort().join() === [epfStreamName(SPACE), epwStreamName(SPACE)].sort().join(), frontier);
    const gate = await observeGate(reg, uid1);
    c("the gate is terminal under this op (a retirement freeze never reopens)", gate!.row.state === "retired" && gate!.row.op?.opId === op1);
    const head = await readLifecycleHeadForOperation(reg, "local", "victim");
    c("the head is retired with no op intent (terminal asserts the completed barrier)", head!.mapping.state === "retired" && head!.mapping.op === undefined);
    c("the cleaner fence ran before the frontier (retire recorded, no early frontier throw)", events.includes("retireCleanerCredential"));
    c("the SPLIT ran: the executor bind was opened for the op's exact pools and retired before the frontier",
      events.includes(`openExecutor:${EP}:${POOL}`) && events.includes("retireExecutorCredential"), events);
    c("BOTH per-op principals were evicted at the fence (cleaner AND executor, §13.1)",
      events.some((e) => e.startsWith("evict:local.cleaner:")) && events.some((e) => e.startsWith("evict:local.executor:")), events);
    const lastExecutor = cleanerConns[cleanerConns.length - 1];
    const lastCleaner = cleanerConns[cleanerConns.length - 2];
    c("the cleaner's own live connection was killed by the fence eviction", await until(() => lastCleaner.isClosed()));
    c("the executor's own live connection was killed by the fence eviction too", await until(() => lastExecutor.isClosed()));
  }
  const act2 = await activateLifecycle(reg, { owner: "local", actor: "victim", managerInstance: MGR });
  c("only a RETIRED predecessor is replaceable, and the successor gets a FRESH uid at epoch 1",
    act2.mapping.lifecycleUid !== uid1 && act2.mapping.processEpoch === 1);
  const again = await runAgentRetirementBarrier(reg, {
    owner: "local", actor: "victim", lifecycleUid: uid1, opId: op1,
    frontierStreams: [epfStreamName(SPACE), epwStreamName(SPACE)],
  }, mkDeps());
  c("re-running the completed op is idempotent (terminal recognized, frontiers returned, nothing re-moved)",
    again.revokedRows === 0 && again.frontiers[epfStreamName(SPACE)] === res1.frontiers[epfStreamName(SPACE)], again);

  console.log("B. a live, unexpired, FOREIGN-target item on a discovered pool wedges the barrier resumably");
  const act3 = await activateLifecycle(reg, { owner: "local", actor: "victim2", managerInstance: MGR });
  const uid3 = act3.mapping.lifecycleUid;
  const tgt3 = { owner: "local", actor: "victim2", lifecycleUid: uid3 };
  const actLive = await activateLifecycle(reg, { owner: "local", actor: "bystander", managerInstance: MGR });
  // victim2's OWN accepted pool item on EP2/POOL: with no caller hint, THIS is what puts EP2/POOL
  // into the retirement's DISCOVERED inventory, so the cleaner drives this pool - and there meets
  // the live foreign item below. (The cleaner settles victim2's own item `retired` on the first
  // run, then stalls on the foreign one, so the resume settles only the foreign item `expired`.)
  const cV2 = { owner: "local", actor: "caller", uid: "c".repeat(26) };
  const v2o = await obtainEpfObligation(meds[EP2], mkReq(EP2, cV2), { target: tgt3, id: "v2p001", fingerprint: fp("v2p001"), sourceSeq: 9, route: `pool.${POOL}` });
  await updateRecordEntry(recordsKv, v2o.key, { ...v2o.row, state: "accepted" }, v2o.revision);
  await acceptPoolItem({ endpoint: EP2, caller: cV2, id: "v2p001", target: tgt3, workExpiry: NOW + 100_000, sourceSeq: 9 });
  // The FOREIGN (bystander-target) live item sharing that same discovered pool: the cleaner can
  // never settle it under victim2's retirement, so it wedges quiescence until it expires.
  const cBlk = { owner: "local", actor: "caller", uid: "f".repeat(26) };
  await acceptPoolItem({ endpoint: EP2, caller: cBlk, id: "blk001", target: { owner: "local", actor: "bystander", lifecycleUid: actLive.mapping.lifecycleUid }, workExpiry: NOW + 50_000, sourceSeq: 8 });
  const op3 = "3".repeat(26);
  await rejects("the cleaner refuses quiescence over a live foreign-target item (never settled, never ACKed) and the barrier fails resumable",
    () => runAgentRetirementBarrier(reg, {
      owner: "local", actor: "victim2", lifecycleUid: uid3, opId: op3,
      frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps({ guardUid: uid3 })), "unavailable");
  {
    const gate = await observeGate(reg, uid3);
    const head = await readLifecycleHeadForOperation(reg, "local", "victim2");
    c("the wedged barrier holds containment: gate frozen by the op, head retiring, no frontier",
      gate!.row.state === "frozen" && gate!.row.op?.opId === op3 && head!.mapping.state === "retiring" && (await recordsKv.get(frontierKeyOf(uid3))) === null);
    c("the foreign item was NOT settled (no terminal fact exists for it)",
      (await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, { endpoint: EP2, pool: POOL, acceptance: { ...cBlk, id: "blk001" } }))) === undefined);
  }
  await rejects("a retiring alias is not replaceable while the barrier is wedged",
    () => activateLifecycle(reg, { owner: "local", actor: "victim2", managerInstance: MGR }), "failed-precondition");
  await rejects("a mint under the frozen gate refuses (the containment bar holds)",
    () => stageAgentMint(reg, { lifecycleUid: uid3, credentialId: "late0001", holderPrincipal: "local.victim2", sourceChain: ["root"], exp: NOW + 60_000 }), "permission-denied");
  await rejects("a SECOND retirement operation refuses while the first owns the freeze (one barrier at a time)",
    () => runAgentRetirementBarrier(reg, {
      owner: "local", actor: "victim2", lifecycleUid: uid3, opId: "4".repeat(26),
      frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps()), "failed-precondition");
  await rejects("the opId resumes only its OWN operation (intent identity is pinned)",
    () => runAgentRetirementBarrier(reg, {
      owner: "local", actor: "victim", lifecycleUid: uid1, opId: op3,
      frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps()), "permission-denied");
  await rejects("a stranger's opId has nothing to resume", () => resumeAgentRetirement(reg, "9".repeat(26), mkDeps()), "not-found");
  {
    const gate = await observeGate(reg, uid3);
    await rejects("a retirement freeze NEVER reopens (its only exit is the terminal)",
      () => reopenGate(reg, { lifecycleUid: uid3, revision: gate!.revision, opId: op3 }), "failed-precondition");
  }
  clock += 60_000; // the blocker passes its OWN workExpiry: reconciliation may now settle it
  const res3 = await resumeAgentRetirement(reg, op3, mkDeps({ guardUid: uid3 }));
  c("the resumed op completes from the durable intent alone once the blocker expires (settled `expired`, not `retired`)",
    res3.cleaned[`${EP2}/${POOL}`]?.settledExpired === 1 && res3.cleaned[`${EP2}/${POOL}`]?.settledRetired === 0, res3.cleaned);
  {
    const head = await readLifecycleHeadForOperation(reg, "local", "victim2");
    const gate = await observeGate(reg, uid3);
    c("…and lands the full terminal (gate retired by the op, head retired)",
      head!.mapping.state === "retired" && gate!.row.state === "retired" && gate!.row.op?.opId === op3);
  }

  console.log("C. a foreign frontier record fails the barrier closed");
  const act5 = await activateLifecycle(reg, { owner: "local", actor: "poison", managerInstance: MGR });
  const uid5 = act5.mapping.lifecycleUid;
  await createRecordEntry(recordsKv, frontierKeyOf(uid5), { lifecycleUid: uid5, opId: "8".repeat(26), streams: {} });
  await rejects("a frontier record under a FOREIGN op refuses (a frontier records once, under its own retirement)",
    () => runAgentRetirementBarrier(reg, {
      owner: "local", actor: "poison", lifecycleUid: uid5, opId: "7".repeat(26),
      frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps()), "permission-denied");
  {
    const gate = await observeGate(reg, uid5);
    c("…and the gate stays frozen (fail-closed, the terminal never lands over a foreign frontier)", gate!.row.state === "frozen");
  }

  console.log("C2. an out-of-closed-set frontier stream refuses before any gate movement (#29 HIGH 2)");
  {
    const actCS = await activateLifecycle(reg, { owner: "local", actor: "cset", managerInstance: MGR });
    const uidCS = actCS.mapping.lifecycleUid;
    await rejects("a frontierStream outside retirementFrontierStreams refuses (only granted lifecycle-data streams may be fenced)",
      () => runAgentRetirementBarrier(reg, {
        owner: "local", actor: "cset", lifecycleUid: uidCS, opId: "c".repeat(26),
        frontierStreams: [`KV_${epAuthBucket(SPACE)}`], // the AUTH store: a real stream, but NOT a frontier stream
      }, mkDeps()), "failed-precondition");
    c("…and the gate was NOT moved (validation precedes the freeze CAS)",
      (await observeGate(reg, uidCS))?.row.state === "open");
  }

  console.log("D. the drain discovers an ACCEPTED-EPF-ONLY target (no provisional/self beside it)");
  {
    // The reachable state the critic flagged: a canonicalizer accepted a pool-routed EPF row and
    // crashed BEFORE the enqueue, so retirement starts with ONLY that accepted EPF row. The
    // barrier's endpoint discovery must include it, or it closes frontiers without running the
    // accept-side route reconciliation. A drain fake that records the endpoint it was asked to
    // drain proves discovery reached it; the injected reconciler establishes the EPW item so the
    // route postcondition is met.
    const act6 = await activateLifecycle(reg, { owner: "local", actor: "acconly", managerInstance: MGR });
    const uid6 = act6.mapping.lifecycleUid;
    const tgt6 = { owner: "local", actor: "acconly", lifecycleUid: uid6 };
    const cAcc = { owner: "local", actor: "caller", uid: "k".repeat(26) };
    const ao = await obtainEpfObligation(meds[EP], mkReq(EP, cAcc), { target: tgt6, id: "ao0001", fingerprint: fp("ao0001"), sourceSeq: 12, route: `pool.${POOL}` });
    await updateRecordEntry(recordsKv, ao.key, { ...ao.row, state: "accepted" }, ao.revision); // accepted, EPW never enqueued (crash before enqueue)
    // The canonicalizer's acceptance decision fact exists (it wrote it before crashing); only the
    // EPW enqueue is missing. The reconciler is what recovers the enqueue.
    await acceptPoolItem({ endpoint: EP, caller: cAcc, id: "ao0001", target: tgt6, workExpiry: NOW + 100_000, sourceSeq: 12, skipEnqueue: true });
    const drainedEps: string[] = [];
    // The reconciler executes the mediator's CLOSED repair command (exact subject + canonical
    // acceptance-derived bytes) — the crash-before-enqueue repair, on the new boundary.
    const reconEnqueue = async (repair: { subject: string; bytes: Uint8Array }) => { await js.publish(repair.subject, repair.bytes); };
    const deps6: RetirementDeps = {
      ...mkDeps({ guardUid: uid6 }),
      drainTargetObligations: async (endpoint, targetUid) => {
        drainedEps.push(endpoint);
        await drainTargetForEndpoint(meds[endpoint as keyof typeof meds], targetUid, { reconcilePoolRoute: reconEnqueue });
      },
    };
    const res6 = await runAgentRetirementBarrier(reg, {
      owner: "local", actor: "acconly", lifecycleUid: uid6, opId: "6".repeat(26),
      frontierStreams: [epfStreamName(SPACE)],
    }, deps6);
    c("the barrier DISCOVERS and drains an accepted-EPF-only endpoint before the cleaner/frontiers (accept-side reconciliation runs)",
      drainedEps.includes(EP) && res6.drainedEndpoints.includes(EP), { drainedEps, reported: res6.drainedEndpoints });
    const head = await readLifecycleHeadForOperation(reg, "local", "acconly");
    c("…and the barrier completes to retired (the accepted-EPF route was verified, not skipped)", head!.mapping.state === "retired");
  }

  console.log("E. the cleaner kill-live runs even if the credential revoke throws");
  {
    // The reachable failure: retireCleanerCredential (an injected deployment op over a bounded-
    // lived cred) throws on a broker/API outage while the cleaner connection is still live. The
    // fence must still verified-evict the cleaner principal, then fail the barrier loud.
    const act7 = await activateLifecycle(reg, { owner: "local", actor: "revfail", managerInstance: MGR });
    const uid7 = act7.mapping.lifecycleUid;
    // revfail's OWN accepted pool item on EP/POOL: the DISCOVERED inventory the cleaner opens over
    // (no caller hint drives it), so the injected openCleaner/retire path is actually reached.
    const cRev = { owner: "local", actor: "caller", uid: "r".repeat(26) };
    const rvo = await obtainEpfObligation(meds[EP], mkReq(EP, cRev), { target: { owner: "local", actor: "revfail", lifecycleUid: uid7 }, id: "rv0001", fingerprint: fp("rv0001"), sourceSeq: 33, route: `pool.${POOL}` });
    await updateRecordEntry(recordsKv, rvo.key, { ...rvo.row, state: "accepted" }, rvo.revision);
    await acceptPoolItem({ endpoint: EP, caller: cRev, id: "rv0001", target: { owner: "local", actor: "revfail", lifecycleUid: uid7 }, workExpiry: NOW + 100_000, sourceSeq: 33 });
    let evictedCleaner = false;
    let liveConn: NatsConnection | undefined;
    const deps7: RetirementDeps = {
      ...mkDeps({ guardUid: uid7 }),
      openCleaner: async (): Promise<PoolCleanerBind> => {
        liveConn = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "local-cleaner", pass: "pw", reconnect: false });
        cleanerConns.push(liveConn);
        return { jsm: await jetstreamManager(liveConn), js: jetstream(liveConn), principal: "local.cleaner" };
      },
      retireCleanerCredential: async () => { throw new Error("simulated revoke outage"); },
      evictPrincipal: async (p) => { const r = await liveEvict(p); if (p === "local.cleaner") evictedCleaner = true; return r; },
    };
    await rejects("the barrier fails loud when the cleaner-credential revoke (deny-new) throws",
      () => runAgentRetirementBarrier(reg, {
        owner: "local", actor: "revfail", lifecycleUid: uid7, opId: "5".repeat(26),
        frontierStreams: [epfStreamName(SPACE)],
      }, deps7), "unavailable");
    c("…but the cleaner principal was STILL verified-evicted (kill-live is not skipped by a deny-new failure)", evictedCleaner);
    c("…the live cleaner connection is dead, and no frontier recorded (fail-closed)",
      await until(() => liveConn?.isClosed() === true) && (await recordsKv.get(frontierKeyOf(uid7))) === null);
  }

  console.log("E2. a failed executor mint fences the already-minted cleaner (fail-closed)");
  {
    const actE2 = await activateLifecycle(reg, { owner: "local", actor: "execfail", managerInstance: MGR });
    const uidE2 = actE2.mapping.lifecycleUid;
    // execfail's OWN accepted pool item on EP/POOL2: the DISCOVERED inventory (no caller hint), so
    // the cleaner step runs and reaches the executor mint we fail below. It routes to POOL2 because
    // the barrier aborts before this item is settled, and its own pool keeps that orphan off every
    // other scenario's shared pool.
    const cExe = { owner: "local", actor: "caller", uid: "z".repeat(26) };
    const xfo = await obtainEpfObligation(meds[EP], mkReq(EP, cExe), { target: { owner: "local", actor: "execfail", lifecycleUid: uidE2 }, id: "xf0001", fingerprint: fp("xf0001"), sourceSeq: 34, route: `pool.${POOL2}` });
    await updateRecordEntry(recordsKv, xfo.key, { ...xfo.row, state: "accepted" }, xfo.revision);
    await acceptPoolItem({ endpoint: EP, caller: cExe, id: "xf0001", target: { owner: "local", actor: "execfail", lifecycleUid: uidE2 }, workExpiry: NOW + 100_000, sourceSeq: 34, pool: POOL2 });
    const mark = events.length;
    await rejects("the barrier fails loud when the executor mint throws (the gate stays frozen)",
      () => runAgentRetirementBarrier(reg, {
        owner: "local", actor: "execfail", lifecycleUid: uidE2, opId: "x".repeat(26),
        frontierStreams: [epfStreamName(SPACE)],
      }, mkDeps({ failExecutorOpen: true, guardUid: uidE2 })));
    const tail = events.slice(mark);
    c("…the already-minted cleaner was fenced first (retired + principal evicted, no live cleaner)",
      tail.includes("retireCleanerCredential") && tail.some((e) => e.startsWith("evict:local.cleaner:")), tail);
    c("…no executor retire/evict ran (nothing was minted) and no frontier recorded",
      !tail.includes("retireExecutorCredential") && !tail.some((e) => e.startsWith("evict:local.executor:"))
      && (await recordsKv.get(frontierKeyOf(uidE2))) === null);
    const lastConn = cleanerConns[cleanerConns.length - 1];
    c("…the cleaner connection is dead", await until(() => lastConn.isClosed()));
  }

  console.log("F. a late row on an already-drained endpoint forces another drain");
  {
    const act8 = await activateLifecycle(reg, { owner: "local", actor: "late", managerInstance: MGR });
    const uid8 = act8.mapping.lifecycleUid;
    const target8 = { owner: "local", actor: "late", lifecycleUid: uid8 };
    const caller8 = { owner: "local", actor: "caller", uid: "m".repeat(26) };
    const first = await obtainEpfObligation(meds[EP], mkReq(EP, caller8), { target: target8, id: "late01", fingerprint: fp("late01"), sourceSeq: 31, route: "effects" });
    const lateKey = `oblig.${uid8}.${EP}.${caller8.owner}.${caller8.actor}.${caller8.uid}.late02`;
    const base = mkDeps({ guardUid: uid8 });
    let drainCalls = 0;
    let injected = false;
    const deps8: RetirementDeps = {
      ...base,
      drainTargetObligations: async (endpoint, targetUid, opId) => {
        drainCalls++;
        await base.drainTargetObligations(endpoint, targetUid, opId);
        if (!injected) {
          injected = true;
          await createRecordEntry(recordsKv, lateKey, { ...first.row, opId: "8".repeat(26), fingerprint: fp("late02"), sourceSeq: 32 });
        }
      },
    };
    await runAgentRetirementBarrier(reg, {
      owner: "local", actor: "late", lifecycleUid: uid8, opId: "9".repeat(26),
      frontierStreams: [epfStreamName(SPACE)],
    }, deps8);
    const lateDecisionSubject = epfSubject(SPACE, EP, ["dec", caller8.owner, caller8.actor, caller8.uid, "late02"]);
    const lateDecision = parseDecisionFact(await readLastFact(jsm, epfStreamName(SPACE), lateDecisionSubject), lateDecisionSubject);
    c("the same endpoint was re-drained for the newly observed row identity", drainCalls === 2 && lateDecision.decision === "rejected", { drainCalls, lateDecision });
  }

  console.log("G. the executor settlement seam is effective-inventory-closed (the confused-deputy guard)");
  {
    const { work } = registryStores(reg);
    const actHostage = await activateLifecycle(reg, { owner: "local", actor: "hostage", managerInstance: MGR });
    const actRetire = await activateLifecycle(reg, { owner: "local", actor: "victim9", managerInstance: MGR });
    const intent = {
      kind: "retirement" as const, lifecycleUid: actRetire.mapping.lifecycleUid, owner: "local", actor: "victim9",
      fromGeneration: 1, frontierStreams: [epfStreamName(SPACE)],
    };
    const settle = settlementForIntent(work, intent, { endpoint: EP, pools: [POOL] }, SPACE, "g".repeat(26), () => clock);
    // An item legitimately in the LISTED pool, but accepted for a DIFFERENT live target: the
    // subtler branch — the ref itself is in-intent, only the acceptance's target is foreign.
    const cHost = { owner: "local", actor: "chost", uid: "p".repeat(26) };
    await acceptPoolItem({ endpoint: EP, caller: cHost, id: "host01", target: { owner: "local", actor: "hostage", lifecycleUid: actHostage.mapping.lifecycleUid }, workExpiry: clock + 100_000, sourceSeq: 41, skipEnqueue: true });
    const hostRef = { endpoint: EP, pool: POOL, acceptance: { ...cHost, id: "host01" } };
    const itemBytes = enc.encode(JSON.stringify({ item: "host01" }));
    await rejects("a ref on a foreign endpoint refuses before any lease read or CAS",
      () => settle({ ref: { ...hostRef, endpoint: EP2 }, itemBytes, disposition: "retired" }), "permission-denied");
    await rejects("a ref on an unlisted pool refuses",
      () => settle({ ref: { ...hostRef, pool: "smuggled" }, itemBytes, disposition: "retired" }), "permission-denied");
    await rejects("a listed-pool item accepted for a FOREIGN target never retires under this intent",
      () => settle({ ref: hostRef, itemBytes, disposition: "retired" }), "permission-denied");
    await rejects("a live item never settles `expired` before its own acceptance horizon",
      () => settle({ ref: hostRef, itemBytes, disposition: "expired" }), "permission-denied");
    c("the refusals settled nothing: the foreign-target item has no terminal fact",
      (await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, hostRef))) === undefined);
  }

  console.log("H. the drain-repair fence live-evicts the per-op repair principals before the frontier (#4)");
  {
    // The reachable defect (#4): the drain's confined repair executors (commit applier / pool-route
    // reconciler / effects canceller) mint short-lived per-op credentials INSIDE the drain and
    // close each after its one write, but they are self-minted data-account bearers with NO ledger
    // row (no connect-time deny-new) and a bounded JWT life. A repair connection still live when
    // the frontier closes could write PAST the cutoff — and the APPLIER's records-KV last-value
    // write is returned to a normal reader REGARDLESS of the cutoff. The barrier must join all
    // three repair principals into the SAME fence as the cleaner/executor (cluster-verified evict)
    // BEFORE any frontier records.
    const actH = await activateLifecycle(reg, { owner: "local", actor: "repairfence", managerInstance: MGR });
    const uidH = actH.mapping.lifecycleUid;
    const tgtH = { owner: "local", actor: "repairfence", lifecycleUid: uidH };
    // One provisional so the drain drives this endpoint (the op reaches the repair fence).
    const cH = { owner: "local", actor: "caller", uid: "h".repeat(26) };
    await obtainEpfObligation(meds[EP], mkReq(EP, cH), { target: tgtH, id: "rf0001", fingerprint: fp("rf0001"), sourceSeq: 20, route: "effects" });
    // A LIVE connection under this op's APPLIER principal (local.epapl_<hash>): a repair bearer
    // still connected when the barrier is about to close the frontier.
    const applierConn = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: APPLIER_USER, pass: "pw", reconnect: false });
    cleanerConns.push(applierConn);
    let applierClosed = false;
    applierConn.closed().then(() => { applierClosed = true; }, () => { applierClosed = true; });
    const [applierP, reconP, cancP] = drainRepairPrincipals(OP_H).map((r) => r.principal);
    c("the applier repair connection is live before the barrier", !applierConn.isClosed());
    const mark = events.length;
    await runAgentRetirementBarrier(reg, {
      owner: "local", actor: "repairfence", lifecycleUid: uidH, opId: OP_H,
      frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps({ guardUid: uidH }));
    const tail = events.slice(mark);
    c("the drain-repair fence evicted ALL THREE per-op repair principals (applier/reconciler/canceller, #4)",
      tail.some((e) => e.startsWith(`evict:${applierP}:`)) && tail.some((e) => e.startsWith(`evict:${reconP}:`)) && tail.some((e) => e.startsWith(`evict:${cancP}:`)), tail);
    c("the live applier connection was KILLED by the fence (its post-frontier last-value write can never land)",
      await until(() => applierClosed || applierConn.isClosed()));
    const head = await readLifecycleHeadForOperation(reg, "local", "repairfence");
    c("…and the barrier still completes to retired with a frontier (the fence precedes the frontier)",
      head!.mapping.state === "retired" && (await recordsKv.get(frontierKeyOf(uidH))) !== null);
  }

  console.log("I. discovery (the barrier takes no hint) must not close frontiers over un-cleaned accepted pool work (#F)");
  {
    // The reachable defect (#F): the barrier takes NO caller pool hint, so the cleaner loop
    // `for (const spec of cleanerInventory)` would run zero times unless the inventory is DISCOVERED
    // from the target's own accepted pool obligations. The drain's accept-side check treats a bare
    // LIVE EPW item as route-established (materialized) and declares quiescence, but the item is never
    // SETTLED (no `wrk` terminal, still pending on the pool). Under the DEFECT the barrier records the
    // frontier and completes: an orphaned, still-live pool item survives past the retirement cutoff.
    // The fix DISCOVERS the (endpoint, pools) inventory from the `oblig.<uid>.>` set.
    const actF = await activateLifecycle(reg, { owner: "local", actor: "poolorphan", managerInstance: MGR });
    const uidF = actF.mapping.lifecycleUid;
    const tgtF = { owner: "local", actor: "poolorphan", lifecycleUid: uidF };
    const cF = { owner: "local", actor: "caller", uid: "n".repeat(26) };
    const of = await obtainEpfObligation(meds[EP], mkReq(EP, cF), { target: tgtF, id: "orf001", fingerprint: fp("orf001"), sourceSeq: 21, route: `pool.${POOL}` });
    await updateRecordEntry(recordsKv, of.key, { ...of.row, state: "accepted" }, of.revision); // the canonicalizer accepted it
    await acceptPoolItem({ endpoint: EP, caller: cF, id: "orf001", target: tgtF, workExpiry: NOW + 100_000, sourceSeq: 21 }); // decision fact + LIVE EPW item
    const orfRef = { endpoint: EP, pool: POOL, acceptance: { ...cF, id: "orf001" } };
    // No hint is possible any more; the barrier must DISCOVER EP/POOL from the accepted obligation.
    const resF = await runAgentRetirementBarrier(reg, {
      owner: "local", actor: "poolorphan", lifecycleUid: uidF, opId: "f".repeat(26),
      frontierStreams: [epfStreamName(SPACE), epwStreamName(SPACE)],
    }, mkDeps({ guardUid: uidF }));
    // FIX EXPECTATION: the barrier must NOT leave the accepted pool item un-settled. Either it
    // discovered EP/POOL and cleaned it (a `wrk` terminal + a quiescent pool), or it failed closed
    // (no frontier). On the DEFECT both fail: the item is orphaned AND the frontier recorded.
    const wrkF = await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, orfRef));
    const info = await (await js.consumers.get(epwStreamName(SPACE), poolDurable(EP, POOL))).info(false);
    c("the accepted pool item was SETTLED (a `wrk` terminal exists — the cleaner ran over the discovered inventory, #F)",
      wrkF !== undefined, { cleaned: resF.cleaned, drained: resF.drainedEndpoints });
    c("the pool is quiescent after the retirement (zero pending, zero ack-pending — no orphaned live EPW, #F)",
      info.num_pending === 0 && info.num_ack_pending === 0, info);
  }

  console.log("J. cancel-first: a RUNNING action goal is never create-only cancelled by a retirement (fact#2)");
  {
    // The reachable defect (fact#2, ACTIONS variant): the drain's effects-canceller writes a
    // create-only `cancelled` goal result WITHOUT consulting the goal state machine. For an action
    // already `running`, the external action MAY have effected, so a create-only cancelled would
    // beat the executor's real completion and violate SPEC 13.6 ("a reader that sees cancelled
    // KNOWS the effect did not run"). The fix leader-reads the goal status and REFUSES the drain
    // for any state past `accepted`, letting the goal terminalize through its OWN machine.
    const actI = await activateLifecycle(reg, { owner: "local", actor: "actiongoal", managerInstance: MGR });
    const uidI = actI.mapping.lifecycleUid;
    const tgtI = { owner: "local", actor: "actiongoal", lifecycleUid: uidI };
    const cI = { owner: "local", actor: "caller", uid: "i".repeat(26) };
    const GOAL = "gA00001";
    // An accepted EFFECTS obligation whose acceptance carries a goalId (=> an ACTION), targeting the
    // retiring lifecycle; no completion marker yet (the action is in-flight).
    const og = await obtainEpfObligation(meds[EP], mkReq(EP, cI), { target: tgtI, id: "act001", fingerprint: fp("act001"), sourceSeq: 50, route: "effects" });
    await updateRecordEntry(recordsKv, og.key, { ...og.row, state: "accepted" }, og.revision);
    const fromI = { id: `${cI.owner}.${cI.actor}`, name: "c" };
    const decI: Record<string, unknown> = {
      v: 1, id: "act001", decision: "accepted", fingerprint: fp("act001"),
      request: { v: 1, id: "act001", goalId: GOAL, op: { endpoint: EP, command: "run", inputDigest: D, outputDigest: D }, class: "journal", replyExpected: false, deadlineMs: 5000, args: {}, from: fromI, target: tgtI },
      caller: { id: fromI.id, lifecycleUid: cI.uid }, target: tgtI,
      contractDigests: { input: D, output: D }, authzDecision: { revision: 1, epoch: 1 },
      route: "effects", sourceSeq: 50, ts: NOW,
    };
    const decSubjI = epfSubject(SPACE, EP, ["dec", cI.owner, cI.actor, cI.uid, "act001"]);
    parseDecisionFact(decI, decSubjI); // the forge must be core-valid or the probe proves nothing
    if (!(await publishFactCreateOnly(js, decSubjI, enc.encode(JSON.stringify(decI)))).won) throw new Error("action acceptance forge lost");
    // The goal is RUNNING (the executor entered the effecting edge).
    await createRecordEntry(recordsKv, recordStatusKey(RECORD_KINDS.goal, [EP, cI.owner, cI.actor, cI.uid, GOAL]), { state: "running", observedSpecRevision: 1 });
    const goalRefI = { endpoint: EP, caller: cI, goalId: GOAL };
    const resultSubjI = goalResultSubject(SPACE, goalRefI);
    const opI = "i".repeat(26);
    // The FAITHFUL retirement canceller (what the real drain-repair one does for a goal): a
    // create-only goalCancelledResultOf on the result subject. The fix must REFUSE before it runs.
    const cancelDeps: RetirementDeps = {
      ...mkDeps({ guardUid: uidI }),
      drainTargetObligations: async (endpoint, targetUid) => {
        await drainTargetForEndpoint(meds[endpoint as keyof typeof meds], targetUid, {
          cancelEffectsRoute: async (repair) => {
            const t = repair.acceptance.target!;
            await publishFactCreateOnly(js, repair.subject, enc.encode(JSON.stringify(goalCancelledResultOf(repair.acceptance, { opId: opI, target: t }, NOW))));
          },
        });
      },
    };
    await rejects("the drain REFUSES to create-only cancel a RUNNING action goal (never contradicts a real completion, fact#2)",
      () => runAgentRetirementBarrier(reg, {
        owner: "local", actor: "actiongoal", lifecycleUid: uidI, opId: opI,
        frontierStreams: [epfStreamName(SPACE)],
      }, cancelDeps), "unavailable");
    c("NO cancelled goal result was written over the running action (its completion is not preempted, fact#2)",
      (await readLastFact(jsm, epfStreamName(SPACE), resultSubjI)) === undefined);
    // The executor's REAL completion can still land create-only (proving the retirement never beat it).
    const realDone = { v: 1, goalId: GOAL, fingerprint: fp("act001"), state: "succeeded", outcomeDigest: contractDigest({ ok: true }), data: { ok: true }, ts: NOW };
    c("the action's REAL completion (succeeded) still wins the result subject after the refusal",
      (await publishFactCreateOnly(js, resultSubjI, enc.encode(JSON.stringify(realDone)))).won);
    const done = parseGoalResultFact(await readLastFact(jsm, epfStreamName(SPACE), resultSubjI), resultSubjI, goalRefI);
    c("…and the recorded terminal is `succeeded`, not `cancelled` (the effect that ran is honestly recorded)", done.state === "succeeded", done);
  }

  await nc.drain().catch(() => {});
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  for (const conn of cleanerConns) { try { await conn.close(); } catch { /* closed */ } }
  try { await victim?.close(); } catch { /* closed */ }
  try { await sysObserver?.close(); } catch { /* closed */ }
  try { await sysEvictor?.close(); } catch { /* closed */ }
  try { await nc?.close(); } catch { /* closed */ }
  broker.kill("SIGKILL"); // exact PID — never pkill nats-server
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nRETIREMENT BARRIER SMOKE OK ✅  (${ok} passed, ${fail} failed)` : `\nRETIREMENT BARRIER SMOKE FAILED ❌  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
