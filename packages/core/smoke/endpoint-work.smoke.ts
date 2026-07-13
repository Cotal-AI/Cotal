/**
 * v0.4 §13.5/§13.6 claim work-pool smoke — the owner-mediated lease/commit semantics against a
 * real broker: create-only enqueue (idempotent, acceptance-identity-keyed), first-wins
 * idempotent lease per (item, attempt) with the attempt = the broker delivery count, fencing
 * advance on redelivery, the commit gate (token currency AND bound worker AND unexpired lease,
 * against the OWNER's clock), the per-item terminal CAS (duplicate returns the cache, a race
 * loses loudly), the never-lease rules (committed / expired / stale attempt), and the §13.6
 * reconciliation predicate (settled / expired-settled / live / re-enqueued).
 *
 * Run: pnpm smoke:ep-work   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, epwStreamName, poolDurable, poolConsumerConfig,
  enqueueWorkItem, leaseWorkItem, commitWorkItem, readWorkTerminal, reconcileWorkItem,
  workItemSubject, workTerminalSubject, openRecordsBucket,
  type EpCaller, type WorkItemRef, type WorkWorker,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epwork";
const UID = "u".repeat(26);
const caller: EpCaller & { id: string } = { owner: "u_abc", actor: "worker", uid: UID, id: "req-1" };
const ref = (id: string, pool = "builds"): WorkItemRef => ({ endpoint: "manager", pool, acceptance: { ...caller, id } });
const workerA: WorkWorker = { owner: "u_wrk", actor: "alpha", lifecycleUid: "a".repeat(26) };
const workerB: WorkWorker = { owner: "u_wrk", actor: "beta", lifecycleUid: "b".repeat(26) };
const enc = (s: string) => new TextEncoder().encode(s);

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epwork-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const kv = await openRecordsBucket(nc, SPACE);
  const NOW = 1_000_000; // the owner's clock is an input everywhere — the smoke owns time
  const EXPIRY = NOW + 60_000;

  // ── enqueue: create-only per acceptance identity ──
  const r1 = ref("req-1");
  const e1 = await enqueueWorkItem(js, SPACE, r1, enc("w1"));
  c("the first enqueue of an item wins its create-only CAS", e1.enqueued && typeof e1.seq === "number");
  const e1dup = await enqueueWorkItem(js, SPACE, r1, enc("w1"));
  c("a duplicate enqueue of the same acceptance identity loses harmlessly (idempotent bridge, §13.6)", !e1dup.enqueued);

  // ── owner fetch off the provisioner-pre-created pool durable (short ack_wait for redelivery) ──
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "builds", { ackWaitMs: 1500 }));
  const poolC = await js.consumers.get(epwStreamName(SPACE), poolDurable("manager", "builds"));
  let m1: { subject: string; seq: number; deliveryCount: number; ack: () => void } | undefined;
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2000 }))
    m1 = { subject: m.subject, seq: m.seq, deliveryCount: m.info.deliveryCount, ack: () => m.ack() };
  c("the owner fetches the stored item (delivery count 1)", m1?.subject === workItemSubject(SPACE, r1) && m1?.deliveryCount === 1);

  // ── lease: first-wins idempotent per (item, attempt); owner-recorded worker binding ──
  await rejects("a lease for EXPIRED work refuses before touching any state (settled by reconciliation, never leased)",
    () => leaseWorkItem(kv, jsm, SPACE, { ref: r1, sourceSeq: m1!.seq, attempt: 1, worker: workerA, now: EXPIRY + 1, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "expired");
  const lease1 = await leaseWorkItem(kv, jsm, SPACE, { ref: r1, sourceSeq: m1!.seq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
  c("the first lease records attempt 1, fencing token 1, the OWNER's deadline, and the broker-authenticated worker",
    lease1.attempt === 1 && lease1.fencingToken === 1 && lease1.leaseDeadline === NOW + 5_000 && lease1.worker.actor === "alpha");
  const lease1b = await leaseWorkItem(kv, jsm, SPACE, { ref: r1, sourceSeq: m1!.seq, attempt: 1, worker: workerB, now: NOW + 100, leaseTtlMs: 5_000, workExpiry: EXPIRY });
  c("a duplicate/delayed lease call for the STILL-CURRENT attempt returns the SAME lease (first-wins: no reassignment within an attempt)",
    lease1b.fencingToken === 1 && lease1b.worker.actor === "alpha" && lease1b.leaseDeadline === NOW + 5_000);
  await rejects("a lease naming a DIFFERENT stream sequence for the same identity refuses loudly (execution binding)",
    () => leaseWorkItem(kv, jsm, SPACE, { ref: r1, sourceSeq: m1!.seq + 99, attempt: 1, worker: workerB, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "conflict");

  // ── commit gate: token currency, bound worker, unexpired lease — then ONE terminal CAS ──
  await rejects("a commit by a worker that is NOT the lease's bound worker refuses (owner-recorded binding, never a payload claim)",
    () => commitWorkItem(kv, js, jsm, SPACE, { ref: r1, caller: workerB, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 200 }), "permission-denied");
  await rejects("a commit carrying a STALE fencing token refuses as expired",
    () => commitWorkItem(kv, js, jsm, SPACE, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 99 }, outcome: { built: true }, now: NOW + 200 }), "expired");
  await rejects("a commit AFTER the lease deadline refuses as expired (expiry revokes the claim even before reassignment)",
    () => commitWorkItem(kv, js, jsm, SPACE, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 5_001 }), "expired");
  const commit1 = await commitWorkItem(kv, js, jsm, SPACE, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 300 });
  c("the bound worker's in-deadline commit WINS the per-item terminal CAS",
    commit1.won && commit1.fact.disposition === "committed" && (commit1.fact.disposition === "committed" ? (commit1.fact.outcome as { built: boolean }).built : false));
  const commit1dup = await commitWorkItem(kv, js, jsm, SPACE, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: false }, now: NOW + 400 });
  c("a duplicate commit LOSES LOUDLY and returns the CACHED terminal outcome, never re-deciding",
    !commit1dup.won && commit1dup.fact.disposition === "committed" && (commit1dup.fact.disposition === "committed" ? (commit1dup.fact.outcome as { built: boolean }).built === true : false));

  // ── the owner acks ONLY after observing the committed terminal; settled work never re-enqueues ──
  const observed = await readWorkTerminal(jsm, SPACE, r1);
  c("the owner's pre-ack observation reads the committed terminal fact", observed?.disposition === "committed");
  m1!.ack();
  await wait(300);
  const rec1 = await reconcileWorkItem(js, jsm, SPACE, { ref: r1, itemBytes: enc("w1"), workExpiry: EXPIRY, now: NOW + 500 });
  c("reconciliation classifies a committed item SETTLED (acked without effect; settled work is never re-enqueued as new)",
    rec1.state === "settled" && rec1.state === "settled" && rec1.fact.disposition === "committed");

  // ── redelivery advances the attempt; the superseded worker's write is rejected ──
  const r2 = ref("req-2");
  const e2 = await enqueueWorkItem(js, SPACE, r2, enc("w2"));
  let m2: { seq: number; deliveryCount: number; ack: () => void } | undefined;
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2000 }))
    m2 = { seq: m.seq, deliveryCount: m.info.deliveryCount, ack: () => m.ack() };
  c("the second item delivers at attempt 1", m2?.deliveryCount === 1 && m2?.seq === e2.seq);
  const lease2a = await leaseWorkItem(kv, jsm, SPACE, { ref: r2, sourceSeq: m2!.seq, attempt: m2!.deliveryCount, worker: workerA, now: NOW, leaseTtlMs: 1_000, workExpiry: EXPIRY });
  c("worker A holds attempt 1", lease2a.fencingToken === 1);
  await wait(1700); // cross ack_wait: the broker redelivers the un-acked item to the OWNER
  let m2r: { seq: number; deliveryCount: number; ack: () => void } | undefined;
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2500 }))
    m2r = { seq: m.seq, deliveryCount: m.info.deliveryCount, ack: () => m.ack() };
  c("the un-acked item REDELIVERS to the owner with an advanced delivery count", m2r?.deliveryCount === 2 && m2r?.seq === m2!.seq);
  await rejects("a lease call carrying the SUPERSEDED attempt refuses once the record advances",
    async () => {
      await leaseWorkItem(kv, jsm, SPACE, { ref: r2, sourceSeq: m2!.seq, attempt: 2, worker: workerB, now: NOW + 2_000, leaseTtlMs: 5_000, workExpiry: EXPIRY });
      return leaseWorkItem(kv, jsm, SPACE, { ref: r2, sourceSeq: m2!.seq, attempt: 1, worker: workerA, now: NOW + 2_100, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    }, "expired");
  const lease2b = await leaseWorkItem(kv, jsm, SPACE, { ref: r2, sourceSeq: m2!.seq, attempt: 2, worker: workerB, now: NOW + 2_200, leaseTtlMs: 5_000, workExpiry: EXPIRY });
  c("the redelivered attempt's lease CAS-advanced the fencing token to worker B", lease2b.fencingToken === 2 && lease2b.worker.actor === "beta");
  await rejects("the SUPERSEDED worker's commit (old attempt + old token) is rejected before or after reassignment",
    () => commitWorkItem(kv, js, jsm, SPACE, { ref: r2, caller: workerA, lease: { sourceSeq: m2!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 2_300 }), "expired");
  const commit2 = await commitWorkItem(kv, js, jsm, SPACE, { ref: r2, caller: workerB, lease: { sourceSeq: m2!.seq, attempt: 2, fencingToken: 2 }, outcome: { built: "by-b" }, now: NOW + 2_400 });
  c("the CURRENT attempt's bound worker settles the item", commit2.won);
  await rejects("a lease on a SETTLED item refuses in the seam (a committed item can never be leased again; observe the terminal and ack)",
    () => leaseWorkItem(kv, jsm, SPACE, { ref: r2, sourceSeq: m2!.seq, attempt: 3, worker: workerA, now: NOW + 2_500, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "failed-precondition");
  m2r!.ack();

  // ── commit without any recorded lease refuses ──
  await rejects("a commit with NO recorded lease refuses (a commit settles only owner-assigned work)",
    () => commitWorkItem(kv, js, jsm, SPACE, { ref: ref("req-never-leased"), caller: workerA, lease: { sourceSeq: 1, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW }), "failed-precondition");

  // ── §13.6 reconciliation: the lost-enqueue repair and the live/expired verdicts ──
  const r3 = ref("req-3");
  const rec3 = await reconcileWorkItem(js, jsm, SPACE, { ref: r3, itemBytes: enc("w3"), workExpiry: EXPIRY, now: NOW });
  c("an accepted item with no terminal and no live entry is the ONLY re-enqueueable state → re-enqueued", rec3.state === "re-enqueued");
  const rec3b = await reconcileWorkItem(js, jsm, SPACE, { ref: r3, itemBytes: enc("w3"), workExpiry: EXPIRY, now: NOW + 1 });
  c("a second reconciliation of the repaired item classifies LIVE (the create-only re-enqueue is idempotent)", rec3b.state === "live");

  // ── expired work: settled terminally as `expired`, never leased, never re-enqueued ──
  const r4 = ref("req-4");
  const rec4 = await reconcileWorkItem(js, jsm, SPACE, { ref: r4, itemBytes: enc("w4"), workExpiry: NOW - 1, now: NOW });
  c("an item past its workExpiry settles terminally as `expired` (never re-enqueued)",
    rec4.state === "expired-settled" && rec4.state === "expired-settled" && rec4.fact.disposition === "expired");
  const rec4b = await reconcileWorkItem(js, jsm, SPACE, { ref: r4, itemBytes: enc("w4"), workExpiry: NOW - 1, now: NOW + 1 });
  c("a raced/duplicate expired settlement reads the winning terminal (settled)", rec4b.state === "settled");
  await rejects("a lease attempt on the expired-settled item refuses",
    () => leaseWorkItem(kv, jsm, SPACE, { ref: r4, sourceSeq: 42, attempt: 1, worker: workerA, now: NOW + 2, leaseTtlMs: 5_000, workExpiry: NOW - 1 }), "expired");

  // ── the wrk fact subject is caller- and pool-scoped (distinct identities never collide) ──
  c("terminal subjects are acceptance-identity-scoped",
    workTerminalSubject(SPACE, r1) !== workTerminalSubject(SPACE, r2)
    && workTerminalSubject(SPACE, r1).includes(".wrk.builds.u_abc.worker."));

  // ── a DEL marker on the lease record never resets an authoritative lease ──
  {
    const rDel = ref("req-5");
    const eDel = await enqueueWorkItem(js, SPACE, rDel, enc("w5"));
    await leaseWorkItem(kv, jsm, SPACE, { ref: rDel, sourceSeq: eDel.seq!, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    await kv.delete(`lease.manager.builds.u_abc.worker.${UID}.req-5.spec`);
    await rejects("a DEL marker on the lease record refuses (a deletion never resets an authoritative lease)",
      () => leaseWorkItem(kv, jsm, SPACE, { ref: rDel, sourceSeq: eDel.seq!, attempt: 1, worker: workerB, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "failed-precondition");
  }

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT WORK SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
