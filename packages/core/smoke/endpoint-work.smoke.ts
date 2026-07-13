/**
 * v0.4 §13.5/§13.6 claim work-pool smoke — the owner-mediated lease/commit semantics against a
 * real broker, with the LEASE record as the single per-item linearization point. Covers:
 * create-only enqueue (idempotent + byte-identity), first-wins idempotent lease (attempt = the
 * broker delivery count), fencing advance on redelivery, the commit gate (execution binding →
 * token → bound worker → FRESH endpoint epoch → workExpiry → leaseDeadline), the lease-fence CAS
 * (a stale attempt cannot commit after reassignment; an already-settled item cannot be leased),
 * the workExpiry commit fence + identity-bind, the duplicate-dominates-expiry cache rule, the
 * no-lease expiry settling THROUGH the lease key (a racing first lease contends), the detached
 * outcome snapshot, the budgeted/validated epoch resolver, and the §13.6 reconciliation
 * predicate incl. crashed-commit recovery and the DIRECT-failure distinction.
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
  workPoolContext, enqueueWorkItem, leaseWorkItem, commitWorkItem, readWorkTerminal, reconcileWorkItem,
  workItemSubject, workTerminalSubject, openRecordsBucket,
  type EpCaller, type WorkItemRef, type WorkWorker, type WorkPoolContext,
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
const workerA: WorkWorker = { kind: "agent", owner: "u_wrk", actor: "alpha", lifecycleUid: "a".repeat(26) };
const workerB: WorkWorker = { kind: "agent", owner: "u_wrk", actor: "beta", lifecycleUid: "b".repeat(26) };
const epWorker = (epoch: number): WorkWorker => ({ kind: "endpoint", owner: "u_wrk", actor: "svc", lifecycleUid: "e".repeat(26), epoch });
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
  const ctx: WorkPoolContext = workPoolContext(kv, js, jsm, SPACE);
  c("the work-pool context is FROZEN (the space bond cannot be swapped after construction)", Object.isFrozen(ctx));
  const NOW = 1_000_000;
  const EXPIRY = NOW + 60_000;

  // ── enqueue: create-only per acceptance identity + byte identity ──
  const r1 = ref("req-1");
  const e1 = await enqueueWorkItem(ctx, r1, enc("w1"));
  c("the first enqueue of an item wins its create-only CAS", e1.enqueued && typeof e1.seq === "number");
  const e1dup = await enqueueWorkItem(ctx, r1, enc("w1"));
  c("a duplicate enqueue with IDENTICAL bytes loses harmlessly (idempotent bridge, §13.6)", !e1dup.enqueued);
  await rejects("a duplicate enqueue with DIFFERENT bytes under the same identity fails loud (canonicalizer mixup, never silently accepted)",
    () => enqueueWorkItem(ctx, r1, enc("DIFFERENT")), "conflict");

  // ── owner fetch off the pool durable (short ack_wait for redelivery) ──
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "builds", { ackWaitMs: 1500 }));
  const poolC = await js.consumers.get(epwStreamName(SPACE), poolDurable("manager", "builds"));
  let m1: { subject: string; seq: number; deliveryCount: number; ack: () => void } | undefined;
  for await (const m of await poolC.fetch({ max_messages: 1, expires: 2000 }))
    m1 = { subject: m.subject, seq: m.seq, deliveryCount: m.info.deliveryCount, ack: () => m.ack() };
  c("the owner fetches the stored item (delivery count 1)", m1?.subject === workItemSubject(SPACE, r1) && m1?.deliveryCount === 1);

  // ── lease ──
  await rejects("a lease for EXPIRED work refuses before touching state",
    () => leaseWorkItem(ctx, { ref: r1, sourceSeq: m1!.seq, attempt: 1, worker: workerA, now: EXPIRY + 1, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "expired");
  const lease1 = await leaseWorkItem(ctx, { ref: r1, sourceSeq: m1!.seq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
  c("the first lease records attempt 1 / token 1 / the owner deadline / the recorded worker",
    lease1.state === "leased" && lease1.attempt === 1 && lease1.fencingToken === 1 && lease1.leaseDeadline === NOW + 5_000 && lease1.worker?.actor === "alpha");
  const lease1b = await leaseWorkItem(ctx, { ref: r1, sourceSeq: m1!.seq, attempt: 1, worker: workerB, now: NOW + 100, leaseTtlMs: 5_000, workExpiry: EXPIRY });
  c("a duplicate lease for the STILL-CURRENT attempt returns the SAME lease (no reassignment within an attempt)",
    lease1b.fencingToken === 1 && lease1b.worker?.actor === "alpha" && lease1b.leaseDeadline === NOW + 5_000);
  await rejects("a lease naming a DIFFERENT stream sequence for the same identity refuses",
    () => leaseWorkItem(ctx, { ref: r1, sourceSeq: m1!.seq + 99, attempt: 1, worker: workerB, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "conflict");
  {
    // leaseDeadline is CLAMPED to workExpiry (no valid lease outlives the horizon).
    const clampRef = ref("req-clamp");
    await enqueueWorkItem(ctx, clampRef, enc("wc"));
    const cl = await leaseWorkItem(ctx, { ref: clampRef, sourceSeq: 999, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 1_000_000, workExpiry: NOW + 500 });
    c("the lease deadline is clamped to workExpiry (min(now+ttl, workExpiry))", cl.leaseDeadline === NOW + 500);
  }

  // ── commit gate ──
  await rejects("a commit by a worker that is NOT the lease's bound worker refuses",
    () => commitWorkItem(ctx, { ref: r1, caller: workerB, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 200 }), "permission-denied");
  await rejects("a commit carrying a STALE fencing token refuses expired",
    () => commitWorkItem(ctx, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 99 }, outcome: { built: true }, now: NOW + 200 }), "expired");
  await rejects("a commit exactly AT the lease deadline refuses expired (inclusive: expiry revokes AT the deadline)",
    () => commitWorkItem(ctx, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 5_000 }), "expired");
  const commit1 = await commitWorkItem(ctx, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 300 });
  c("the bound worker's in-deadline commit wins the terminal (lease fenced settled → terminal derived)",
    commit1.won && commit1.fact.disposition === "committed" && (commit1.fact.disposition === "committed" ? (commit1.fact.outcome as { built: boolean }).built : false));
  const commit1dup = await commitWorkItem(ctx, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: false }, now: NOW + 400 });
  c("a duplicate commit returns the CACHED terminal, never re-deciding",
    !commit1dup.won && commit1dup.fact.disposition === "committed" && (commit1dup.fact.disposition === "committed" ? (commit1dup.fact.outcome as { built: boolean }).built === true : false));
  await rejects("a lease on a SETTLED item refuses on the SAME key (committed-never-leased-again, no cross-store read)",
    () => leaseWorkItem(ctx, { ref: r1, sourceSeq: m1!.seq, attempt: 2, worker: workerB, now: NOW + 500, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "failed-precondition");
  {
    // DUPLICATE-DOMINATES-EXPIRY: a true same-worker duplicate whose lease has since expired still
    // gets its cached terminal, never `expired`.
    const late = await commitWorkItem(ctx, { ref: r1, caller: workerA, lease: { sourceSeq: m1!.seq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 99_999 });
    c("a same-worker duplicate AFTER lease expiry still observes its cached terminal (cache dominates expiry, §13.5)",
      !late.won && late.fact.disposition === "committed");
  }
  m1!.ack();
  const rec1 = await reconcileWorkItem(ctx, { ref: r1, itemBytes: enc("w1"), workExpiry: EXPIRY, now: NOW + 600 });
  c("reconciliation classifies a committed item SETTLED (never re-enqueued)", rec1.state === "settled");

  // ── redelivery advances the attempt; the superseded worker is fenced. Isolated on its own
  //    pool so the intervening enqueues above don't sit ahead of it in the builds queue. ──
  await jsm.consumers.add(epwStreamName(SPACE), poolConsumerConfig(SPACE, "manager", "redeliv", { ackWaitMs: 1500 }));
  const poolR = await js.consumers.get(epwStreamName(SPACE), poolDurable("manager", "redeliv"));
  const r2 = ref("req-2", "redeliv");
  const e2 = await enqueueWorkItem(ctx, r2, enc("w2"));
  let m2: { seq: number; deliveryCount: number } | undefined;
  for await (const m of await poolR.fetch({ max_messages: 1, expires: 2000 })) m2 = { seq: m.seq, deliveryCount: m.info.deliveryCount };
  c("the second item delivers at attempt 1", m2?.deliveryCount === 1 && m2?.seq === e2.seq);
  await leaseWorkItem(ctx, { ref: r2, sourceSeq: m2!.seq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 1_000, workExpiry: EXPIRY });
  await wait(1700);
  let m2r: { deliveryCount: number; ack: () => void } | undefined;
  for await (const m of await poolR.fetch({ max_messages: 1, expires: 2500 })) m2r = { deliveryCount: m.info.deliveryCount, ack: () => m.ack() };
  c("the un-acked item REDELIVERS to the owner with an advanced delivery count", m2r?.deliveryCount === 2);
  await rejects("the SUPERSEDED attempt's lease call refuses once the record advanced",
    async () => {
      await leaseWorkItem(ctx, { ref: r2, sourceSeq: m2!.seq, attempt: 2, worker: workerB, now: NOW + 2_000, leaseTtlMs: 5_000, workExpiry: EXPIRY });
      return leaseWorkItem(ctx, { ref: r2, sourceSeq: m2!.seq, attempt: 1, worker: workerA, now: NOW + 2_100, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    }, "expired");
  await rejects("the SUPERSEDED worker's commit (old attempt+token) is rejected after reassignment (the shared-key fence)",
    () => commitWorkItem(ctx, { ref: r2, caller: workerA, lease: { sourceSeq: m2!.seq, attempt: 1, fencingToken: 1 }, outcome: { built: true }, now: NOW + 2_300 }), "expired");
  const commit2 = await commitWorkItem(ctx, { ref: r2, caller: workerB, lease: { sourceSeq: m2!.seq, attempt: 2, fencingToken: 2 }, outcome: { built: "by-b" }, now: NOW + 2_400 });
  c("the current attempt's bound worker settles the item", commit2.won);
  m2r!.ack();

  // ── HIGH 2: fresh endpoint-worker epoch currency at commit ──
  {
    const re = ref("req-ep");
    const eSeq = (await enqueueWorkItem(ctx, re, enc("we"))).seq!;
    await leaseWorkItem(ctx, { ref: re, sourceSeq: eSeq, attempt: 1, worker: epWorker(5), now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    await rejects("committing an endpoint worker with NO fresh-epoch resolver refuses",
      () => commitWorkItem(ctx, { ref: re, caller: epWorker(5), lease: { sourceSeq: eSeq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 100 }), "failed-precondition");
    await rejects("a SUPERSEDED endpoint epoch (current advanced past the lease's) cannot commit",
      () => commitWorkItem(ctx, { ref: re, caller: epWorker(5), lease: { sourceSeq: eSeq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 100, resolveCurrentEpoch: () => 6 }), "expired");
    await rejects("a RETIRED endpoint lifecycle (resolver returns null) cannot commit",
      () => commitWorkItem(ctx, { ref: re, caller: epWorker(5), lease: { sourceSeq: eSeq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 100, resolveCurrentEpoch: () => null }), "expired");
    const okEp = await commitWorkItem(ctx, { ref: re, caller: epWorker(5), lease: { sourceSeq: eSeq, attempt: 1, fencingToken: 1 }, outcome: { ep: true }, now: NOW + 100, resolveCurrentEpoch: () => 5 });
    c("an endpoint worker with a MATCHING fresh epoch commits", okEp.won && okEp.fact.disposition === "committed");
  }

  // ── HIGH 3: workExpiry commit fence ──
  {
    const rx = ref("req-x");
    const xSeq = (await enqueueWorkItem(ctx, rx, enc("wx"))).seq!;
    // lease with a huge ttl but a near workExpiry → deadline clamps to workExpiry
    const xLease = await leaseWorkItem(ctx, { ref: rx, sourceSeq: xSeq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 1_000_000, workExpiry: NOW + 1_000 });
    c("the lease deadline clamped to workExpiry", xLease.leaseDeadline === NOW + 1_000);
    await rejects("a commit PAST workExpiry refuses even within a (clamped) lease window (the item is dead, leased or not)",
      () => commitWorkItem(ctx, { ref: rx, caller: workerA, lease: { sourceSeq: xSeq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 1_000 }), "expired");
  }

  // ── commit without a lease ──
  await rejects("a commit with NO recorded lease refuses",
    () => commitWorkItem(ctx, { ref: ref("req-never"), caller: workerA, lease: { sourceSeq: 1, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW }), "failed-precondition");

  // ── §13.6 reconciliation: lost-enqueue repair, crashed-commit recovery, expired ──
  const r3 = ref("req-3");
  const rec3 = await reconcileWorkItem(ctx, { ref: r3, itemBytes: enc("w3"), workExpiry: EXPIRY, now: NOW });
  c("an accepted item with no terminal/lease/live entry is the ONLY re-enqueueable state → re-enqueued", rec3.state === "re-enqueued");
  const rec3b = await reconcileWorkItem(ctx, { ref: r3, itemBytes: enc("w3"), workExpiry: EXPIRY, now: NOW + 1 });
  c("a second reconciliation of the repaired item classifies LIVE", rec3b.state === "live");
  {
    // crashed-commit recovery: lease settled (committed) but the terminal fact never published.
    const rc = ref("req-crash");
    const cSeq = (await enqueueWorkItem(ctx, rc, enc("wcr"))).seq!;
    await leaseWorkItem(ctx, { ref: rc, sourceSeq: cSeq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    // manufacture the crash: write the settled lease directly, leave no terminal fact
    await kv.put(`lease.manager.builds.u_abc.worker.${UID}.req-crash.spec`, enc(JSON.stringify({ v: 1, state: "settled", sourceSeq: cSeq, attempt: 1, worker: workerA, fencingToken: 1, leaseDeadline: NOW + 5_000, workExpiry: EXPIRY, disposition: "committed", outcome: { recovered: true }, committedTs: NOW + 100 })));
    c("before recovery there is no terminal fact", (await readWorkTerminal(ctx, rc)) === undefined);
    const recCrash = await reconcileWorkItem(ctx, { ref: rc, itemBytes: enc("wcr"), workExpiry: EXPIRY, now: NOW + 200 });
    c("reconciliation FINALIZES a settled-lease-without-terminal (crashed-commit recovery) → settled, never re-enqueued",
      recCrash.state === "settled" && recCrash.fact.disposition === "committed");
    c("…and the recovered terminal is now published", (await readWorkTerminal(ctx, rc))?.disposition === "committed");
  }

  // ── expired work: settled terminally as `expired`, never leased/re-enqueued ──
  const r4 = ref("req-4");
  const rec4 = await reconcileWorkItem(ctx, { ref: r4, itemBytes: enc("w4"), workExpiry: NOW - 1, now: NOW });
  c("an item past its workExpiry settles terminally `expired` (never re-enqueued)",
    rec4.state === "expired-settled" && rec4.fact.disposition === "expired");
  const rec4b = await reconcileWorkItem(ctx, { ref: r4, itemBytes: enc("w4"), workExpiry: NOW - 1, now: NOW + 1 });
  c("a raced/duplicate expired settlement reads the winning terminal", rec4b.state === "expired-settled");
  await rejects("a lease on the expired-settled item refuses", // expired work refuses at the workExpiry guard
    () => leaseWorkItem(ctx, { ref: r4, sourceSeq: 42, attempt: 1, worker: workerA, now: NOW + 2, leaseTtlMs: 5_000, workExpiry: NOW - 1 }), "expired");

  // ── HIGH: no-lease expiry settles THROUGH the lease key, so a racing first lease contends ──
  {
    // An expired NEVER-LEASED item is settled by CAS-CREATING a worker-less settled:expired
    // lease on the LEASE KEY (never by writing the fact directly), so a racing first lease —
    // e.g. an owner whose clock is behind the reconciler's — contends on the same key and
    // observes the settlement instead of assigning dead work behind the expiry.
    const rr = ref("req-race");
    await enqueueWorkItem(ctx, rr, enc("wr"));
    const horizon = NOW + 100;
    const recR = await reconcileWorkItem(ctx, { ref: rr, itemBytes: enc("wr"), workExpiry: horizon, now: horizon });
    c("an expired never-leased item settles terminally `expired`", recR.state === "expired-settled" && recR.fact.disposition === "expired");
    const rrEntry = await kv.get(`lease.manager.builds.u_abc.worker.${UID}.req-race.spec`);
    const rrLease = rrEntry && rrEntry.operation === "PUT" ? JSON.parse(new TextDecoder().decode(rrEntry.value)) as { state: string; disposition: string; worker?: unknown } : undefined;
    c("…by CAS-creating a worker-less settled:expired LEASE record (the lease key is the arbiter, not the fact)",
      rrLease?.state === "settled" && rrLease?.disposition === "expired" && rrLease?.worker === undefined);
    await rejects("a racing first lease (owner clock still BEFORE the horizon) contends on the key and refuses settled",
      () => leaseWorkItem(ctx, { ref: rr, sourceSeq: 7, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: horizon }), "failed-precondition");
  }

  // ── workExpiry is identity-bound across lease calls ──
  {
    const rb2 = ref("req-bind");
    const bSeq = (await enqueueWorkItem(ctx, rb2, enc("wb"))).seq!;
    await leaseWorkItem(ctx, { ref: rb2, sourceSeq: bSeq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 1_000, workExpiry: EXPIRY });
    await rejects("a redelivery lease supplying a DIFFERENT workExpiry refuses (the horizon is fixed at acceptance, never re-set)",
      () => leaseWorkItem(ctx, { ref: rb2, sourceSeq: bSeq, attempt: 2, worker: workerB, now: NOW + 10, leaseTtlMs: 1_000, workExpiry: EXPIRY + 1 }), "conflict");
  }

  // ── the committed outcome is a detached strict-canonical snapshot ──
  {
    const rs = ref("req-snap");
    const sSeq = (await enqueueWorkItem(ctx, rs, enc("ws"))).seq!;
    await leaseWorkItem(ctx, { ref: rs, sourceSeq: sSeq, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    const out = { n: 1, tags: ["a"] };
    const snapCommit = await commitWorkItem(ctx, { ref: rs, caller: workerA, lease: { sourceSeq: sSeq, attempt: 1, fencingToken: 1 }, outcome: out, now: NOW + 10 });
    out.n = 999; out.tags.push("MUTATED");
    const snapFact = await readWorkTerminal(ctx, rs);
    c("the cached outcome is a DETACHED snapshot (a later caller mutation never reaches the lease or terminal)",
      snapCommit.won && snapFact?.disposition === "committed"
      && (snapFact.outcome as { n: number; tags: string[] }).n === 1
      && (snapFact.outcome as { n: number; tags: string[] }).tags.length === 1);
  }

  // ── the fresh-epoch resolver is BUDGETED and its answer is validated ──
  {
    const rbu = ref("req-budget");
    const buSeq = (await enqueueWorkItem(ctx, rbu, enc("wbu"))).seq!;
    await leaseWorkItem(ctx, { ref: rbu, sourceSeq: buSeq, attempt: 1, worker: epWorker(3), now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    await rejects("a HUNG epoch resolver refuses `unavailable` within the owner's budget, never a hung commit",
      () => commitWorkItem(ctx, { ref: rbu, caller: epWorker(3), lease: { sourceSeq: buSeq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 10, resolveCurrentEpoch: () => new Promise<never>(() => {}), epochResolveBudgetMs: 100 }), "unavailable");
    await rejects("a resolver returning a NON-INTEGER epoch never authorizes (fail-closed, not coerced)",
      () => commitWorkItem(ctx, { ref: rbu, caller: epWorker(3), lease: { sourceSeq: buSeq, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW + 10, resolveCurrentEpoch: (() => "3") as unknown as () => number, epochResolveBudgetMs: 100 }), "internal");
  }

  // ── a garbled cross-variant lease record never authorizes ──
  {
    const rg = ref("req-garbled");
    await kv.put(`lease.manager.builds.u_abc.worker.${UID}.req-garbled.spec`, enc(JSON.stringify({ v: 1, state: "leased", sourceSeq: 1, attempt: 1, worker: workerA, fencingToken: 1, leaseDeadline: NOW + 1_000, workExpiry: EXPIRY, disposition: "committed" })));
    await rejects("a `leased` record carrying settlement fields is garbled and never authorizes",
      () => commitWorkItem(ctx, { ref: rg, caller: workerA, lease: { sourceSeq: 1, attempt: 1, fencingToken: 1 }, outcome: {}, now: NOW }), "internal");
  }

  // ── malformed terminal fact does NOT count as settlement ──
  {
    const rb = ref("req-bad");
    await kv; // (no-op to keep the block scoped)
    // publish a wrong-pool terminal on the item's subject → parseTerminal must reject it as garbled
    const badSubj = workTerminalSubject(SPACE, rb);
    const h = (await import("@nats-io/transport-node")).headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(badSubj, enc(JSON.stringify({ v: 1, disposition: "committed", pool: "WRONG", caller: rb.acceptance, sourceSeq: 1, attempt: 1, fencingToken: 1, worker: workerA, outcome: {}, ts: NOW })), { headers: h });
    await rejects("a terminal fact whose pool does not match its subject is rejected as garbled (never authoritative settlement)",
      () => readWorkTerminal(ctx, rb), "internal");
  }

  c("terminal subjects are acceptance-identity-scoped",
    workTerminalSubject(SPACE, r1) !== workTerminalSubject(SPACE, r2) && workTerminalSubject(SPACE, r1).includes(".wrk.builds.u_abc.worker."));

  // ── a DEL marker on the lease record never resets an authoritative lease ──
  {
    const rDel = ref("req-5");
    const eDel = await enqueueWorkItem(ctx, rDel, enc("w5"));
    await leaseWorkItem(ctx, { ref: rDel, sourceSeq: eDel.seq!, attempt: 1, worker: workerA, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY });
    await kv.delete(`lease.manager.builds.u_abc.worker.${UID}.req-5.spec`);
    await rejects("a DEL marker on the lease record refuses (a deletion never resets an authoritative lease)",
      () => leaseWorkItem(ctx, { ref: rDel, sourceSeq: eDel.seq!, attempt: 1, worker: workerB, now: NOW, leaseTtlMs: 5_000, workExpiry: EXPIRY }), "failed-precondition");
  }

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT WORK SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
