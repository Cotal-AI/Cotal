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
  recordAtomicKey, RETIREMENT_FRONTIER, evictDeniedPrincipal, MEMBERSHIP_INBOX_PREFIX,
  epfSubject, epfStreamName, epwSubject, epwStreamName, poolConsumerConfig, poolDurable,
  publishFactCreateOnly, readLastFact, parseWorkTerminalFact, parseDecisionFact, workTerminalSubject,
} from "@cotal-ai/core";
import { openAdmissionMediator, mediatedRequestFromSubject, obtainEpfObligation, drainTargetForEndpoint, type MediatedRequest } from "../src/index.js";
import { openLifecycleRegistry, activateLifecycle, registryStores, observeGate, reopenGate, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { stageAgentMint, finalizeAgentMint, credRowKey, type EvictPrincipal } from "../src/credential-ledger.js";
import { runAgentRetirementBarrier, resumeAgentRetirement, type RetirementDeps, type PoolCleanerBind } from "../src/retirement-barrier.js";

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
  const reg = await openLifecycleRegistry(nc, SPACE);
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
    await js.publish(epwSubject(SPACE, args.endpoint, POOL, { ...args.caller, id: args.id }), enc.encode(JSON.stringify({ item: args.id })));
  };

  const events: string[] = [];
  const frontierKeyOf = (uid: string) => recordAtomicKey(RETIREMENT_FRONTIER, [uid]);
  const mkDeps = (opts: { failCleanerOpen?: boolean; guardUid?: string } = {}): RetirementDeps => ({
    evictPrincipal: async (p) => { const r = await liveEvict(p); events.push(`evict:${p}:${JSON.stringify(r)}`); return r; },
    drainTargetObligations: async (endpoint, targetUid) => {
      const med = meds[endpoint as keyof typeof meds];
      if (med === undefined) throw new Error(`no mediator for endpoint ${endpoint}`);
      await drainTargetForEndpoint(med, targetUid, { reconcileAcceptedRoute: async () => {} });
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
  c("the cleaner settled exactly the three item classes (terminal-ACK / expired / retired)",
    cleanedA !== undefined && cleanedA.ackedTerminal === 1 && cleanedA.settledExpired === 1 && cleanedA.settledRetired === 1, cleanedA);
  {
    const row = JSON.parse(dec.decode((await authKv.get(credRowKey(uid1, "root0001")))!.value)) as { state: string };
    c("the root credential row is revoked", row.state === "revoked", row);
    const ownRef = { endpoint: EP, pool: POOL, acceptance: { ...cOwn, id: "own001" } };
    const term = parseWorkTerminalFact(await readLastFact(jsm, epfStreamName(SPACE), workTerminalSubject(SPACE, ownRef)), workTerminalSubject(SPACE, ownRef), ownRef);
    c("the retiring target's live item carries a core-valid `retired` terminal bound to the op + target",
      term.disposition === "retired" && term.opId === op1 && term.targetUid === uid1, term);
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
