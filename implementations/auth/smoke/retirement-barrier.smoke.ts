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
  isReachable, EpEnvelopeError, createEndpointStreams, contractDigest, createRecordEntry, updateRecordEntry,
  recordAtomicKey, recordSpecKey, RECORD_KINDS, RETIREMENT_FRONTIER, evictDeniedPrincipal, MEMBERSHIP_INBOX_PREFIX,
  effectFactOf, epfEffectSubject, epfSubject, epfStreamName, epwSubject, epwStreamName, poolConsumerConfig, poolDurable,
  publishFactCreateOnly, readLastFact, parseWorkTerminalFact, parseDecisionFact, workTerminalSubject,
} from "@cotal-ai/core";
import { openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, drainTargetForEndpoint, type MediatedRequest } from "../src/index.js";
import { openLifecycleRegistry, activateLifecycle, registryStores, observeGate, reopenGate, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { stageAgentMint, finalizeAgentMint, credRowKey, type EvictPrincipal } from "../src/credential-ledger.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { runAgentRetirementBarrier, resumeAgentRetirement, settlementForIntent, type RetirementDeps, type PoolCleanerBind } from "../src/retirement-barrier.js";

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
const MGR = "mgr-1";
const NOW = 1_700_000_000_000;
const D = contractDigest({ s: 1 });
const fp = (tag: string): string => contractDigest({ fp: tag });
const EVICT_OPTS = { maxWaitMs: 1500, settleMs: 200, maxVerifyRounds: 3 } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-retire-"));
writeFileSync(join(sd, "server.conf"), `
port: ${PORT}
listen: 127.0.0.1:${PORT}
system_account: SYS
jetstream { store_dir: "${sd}" }
accounts {
  SYS: { users = [ { user: "sys", password: "pw" } ] }
  APP: {
    jetstream: enabled
    users = [
      { user: "auth", password: "pw" }
      { user: "local-victim", password: "pw", permissions: { publish: { allow: ["victim.>"] }, subscribe: { allow: ["victim.>", "_INBOX.>"] } } }
      { user: "local-cleaner", password: "pw" }
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
  const reg = await openLifecycleRegistry(nc, SPACE, makeLedgerScannerOverConnection(nc, SPACE));
  const { recordsKv, authKv } = registryStores(reg);
  let clock = NOW;
  const meds = {
    [EP]: await openAdmissionMediator(nc, SPACE, EP, { now: () => clock }),
    [EP2]: await openAdmissionMediator(nc, SPACE, EP2, { now: () => clock }),
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
    /** Write the acceptance decision fact but NOT the EPW item (the crash-before-enqueue state). */
    skipEnqueue?: boolean;
  }): Promise<void> => {
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
      route: `pool.${POOL}`, workExpiry: args.workExpiry, sourceSeq: args.sourceSeq, ts: NOW,
    };
    if (args.target !== undefined) fact.target = args.target;
    const subject = epfSubject(SPACE, args.endpoint, ["dec", args.caller.owner, args.caller.actor, args.caller.uid, args.id]);
    parseDecisionFact(fact, subject); // the forge must be core-valid or the probe proves nothing
    if (!(await publishFactCreateOnly(js, subject, enc.encode(JSON.stringify(fact)))).won) throw new Error(`acceptance forge lost on ${subject}`);
    if (args.skipEnqueue !== true)
      await js.publish(epwSubject(SPACE, args.endpoint, POOL, { ...args.caller, id: args.id }), enc.encode(JSON.stringify({ item: args.id })));
  };

  const events: string[] = [];
  const frontierKeyOf = (uid: string) => recordAtomicKey(RETIREMENT_FRONTIER, [uid]);
  const mkDeps = (opts: { failCleanerOpen?: boolean; guardUid?: string } = {}): RetirementDeps => ({
    evictPrincipal: async (p) => { const r = await liveEvict(p); events.push(`evict:${p}:${JSON.stringify(r)}`); return r; },
    drainTargetObligations: async (endpoint, targetUid) => {
      const med = meds[endpoint as keyof typeof meds];
      if (med === undefined) throw new Error(`no mediator for endpoint ${endpoint}`);
      await drainTargetForEndpoint(med, targetUid, { reconcileAcceptedRoute: async (row, key) => {
        if (row.route !== "effects") return;
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
    endpoints: [{ endpoint: EP, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE), epwStreamName(SPACE)],
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
    const lastCleaner = cleanerConns[cleanerConns.length - 1];
    c("the cleaner's own live connection was killed by the fence eviction", await until(() => lastCleaner.isClosed()));
  }
  const act2 = await activateLifecycle(reg, { owner: "local", actor: "victim", managerInstance: MGR });
  c("only a RETIRED predecessor is replaceable, and the successor gets a FRESH uid at epoch 1",
    act2.mapping.lifecycleUid !== uid1 && act2.mapping.processEpoch === 1);
  const again = await runAgentRetirementBarrier(reg, {
    owner: "local", actor: "victim", lifecycleUid: uid1, opId: op1,
    endpoints: [{ endpoint: EP, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE), epwStreamName(SPACE)],
  }, mkDeps());
  c("re-running the completed op is idempotent (terminal recognized, frontiers returned, nothing re-moved)",
    again.revokedRows === 0 && again.frontiers[epfStreamName(SPACE)] === res1.frontiers[epfStreamName(SPACE)], again);

  console.log("B. a live, unexpired, FOREIGN-target item wedges the barrier resumably");
  const act3 = await activateLifecycle(reg, { owner: "local", actor: "victim2", managerInstance: MGR });
  const uid3 = act3.mapping.lifecycleUid;
  const actLive = await activateLifecycle(reg, { owner: "local", actor: "bystander", managerInstance: MGR });
  const cBlk = { owner: "local", actor: "caller", uid: "f".repeat(26) };
  await acceptPoolItem({ endpoint: EP2, caller: cBlk, id: "blk001", target: { owner: "local", actor: "bystander", lifecycleUid: actLive.mapping.lifecycleUid }, workExpiry: NOW + 50_000, sourceSeq: 8 });
  const op3 = "3".repeat(26);
  await rejects("the cleaner refuses quiescence over a live foreign-target item (never settled, never ACKed) and the barrier fails resumable",
    () => runAgentRetirementBarrier(reg, {
      owner: "local", actor: "victim2", lifecycleUid: uid3, opId: op3,
      endpoints: [{ endpoint: EP2, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE)],
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
      endpoints: [{ endpoint: EP2, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps()), "failed-precondition");
  await rejects("the opId resumes only its OWN operation (intent identity is pinned)",
    () => runAgentRetirementBarrier(reg, {
      owner: "local", actor: "victim", lifecycleUid: uid1, opId: op3,
      endpoints: [], frontierStreams: [epfStreamName(SPACE)],
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
      endpoints: [], frontierStreams: [epfStreamName(SPACE)],
    }, mkDeps()), "permission-denied");
  {
    const gate = await observeGate(reg, uid5);
    c("…and the gate stays frozen (fail-closed, the terminal never lands over a foreign frontier)", gate!.row.state === "frozen");
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
    const reconEnqueue = async () => { await js.publish(epwSubject(SPACE, EP, POOL, { ...cAcc, id: "ao0001" }), enc.encode(JSON.stringify({ item: "ao0001" }))); };
    const deps6: RetirementDeps = {
      ...mkDeps({ guardUid: uid6 }),
      drainTargetObligations: async (endpoint, targetUid) => {
        drainedEps.push(endpoint);
        await drainTargetForEndpoint(meds[endpoint as keyof typeof meds], targetUid, { reconcileAcceptedRoute: reconEnqueue });
      },
    };
    const res6 = await runAgentRetirementBarrier(reg, {
      owner: "local", actor: "acconly", lifecycleUid: uid6, opId: "6".repeat(26),
      endpoints: [{ endpoint: EP, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE)],
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
        endpoints: [{ endpoint: EP, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE)],
      }, deps7), "unavailable");
    c("…but the cleaner principal was STILL verified-evicted (kill-live is not skipped by a deny-new failure)", evictedCleaner);
    c("…the live cleaner connection is dead, and no frontier recorded (fail-closed)",
      await until(() => liveConn?.isClosed() === true) && (await recordsKv.get(frontierKeyOf(uid7))) === null);
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
      drainTargetObligations: async (endpoint, targetUid) => {
        drainCalls++;
        await base.drainTargetObligations(endpoint, targetUid);
        if (!injected) {
          injected = true;
          await createRecordEntry(recordsKv, lateKey, { ...first.row, opId: "8".repeat(26), fingerprint: fp("late02"), sourceSeq: 32 });
        }
      },
    };
    await runAgentRetirementBarrier(reg, {
      owner: "local", actor: "late", lifecycleUid: uid8, opId: "9".repeat(26),
      endpoints: [{ endpoint: EP, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE)],
    }, deps8);
    const lateDecisionSubject = epfSubject(SPACE, EP, ["dec", caller8.owner, caller8.actor, caller8.uid, "late02"]);
    const lateDecision = parseDecisionFact(await readLastFact(jsm, epfStreamName(SPACE), lateDecisionSubject), lateDecisionSubject);
    c("the same endpoint was re-drained for the newly observed row identity", drainCalls === 2 && lateDecision.decision === "rejected", { drainCalls, lateDecision });
  }

  console.log("G. the executor settlement seam is intent-closed (the confused-deputy guard)");
  {
    const { work } = registryStores(reg);
    const actHostage = await activateLifecycle(reg, { owner: "local", actor: "hostage", managerInstance: MGR });
    const actRetire = await activateLifecycle(reg, { owner: "local", actor: "victim9", managerInstance: MGR });
    const intent = {
      kind: "retirement" as const, lifecycleUid: actRetire.mapping.lifecycleUid, owner: "local", actor: "victim9",
      fromGeneration: 1, endpoints: [{ endpoint: EP, pools: [POOL] }], frontierStreams: [epfStreamName(SPACE)],
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
