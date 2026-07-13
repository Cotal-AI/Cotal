/**
 * Claim work pools (SPEC §13.5 "claim", §13.6 predicate, §13.9 rows): competitive
 * at-most-one-winner acquisition from a durable pool, OWNER-MEDIATED end to end.
 *
 * The pool's owning endpoint holds the pool's single AckExplicit pull consumer
 * (`pool_<e>_<pool>`, provisioner-pre-created, exact filter); workers hold NO JetStream grant
 * on the pool and acquire, renew, and settle work exclusively through the owner's reserved
 * `lease` and `commit` commands on the ordinary `ep` rails. This is the only shape that
 * satisfies both claim invariants at once: the delivery's ack token never leaves the party
 * allowed to use it, and the attempt binding is OWNER-RECORDED at assignment (a worker-carried
 * "sequence + attempt" proves nothing about delivery; an owner assignment does).
 *
 * The stored pool message is WORK IDENTITY AND INPUT ONLY, never the authoritative lease:
 * broker redelivery re-delivers the same stored bytes, so a token in the payload cannot fence,
 * and the consumer's ack_wait is the broker's redelivery-to-owner timer only. The authoritative
 * lease lives in the `lease` record (§13.7 key grammar), first-wins idempotent CAS per
 * (item, attempt); `attempt` IS the broker delivery count of the owner's fetch; `fencingToken`
 * is CAS-incremented per attempt; `leaseDeadline` comes from the owner's own clock.
 *
 * Every commit is an atomic, idempotent per-item CREATE-ONLY CAS to the cached terminal fact
 * `epf.<endpoint>.wrk.<pool>.<acceptance identity>`: a committed item can never be leased
 * again, a duplicate commit returns the cached terminal outcome, and a raced commit loses
 * loudly. The owner acks the WorkQueue message only AFTER observing the committed terminal
 * state, so settled work is never re-enqueued as new; the §13.6 reconciliation predicate
 * (accepted + `now < workExpiry` + no terminal + no live pool entry) repairs the one
 * crash window (acceptance CAS'd, enqueue lost) by an idempotent create-only re-enqueue of
 * the SAME bytes under the SAME workExpiry. Expired work is never leased and never
 * re-enqueued: it settles terminally as `expired` and is acked without effect.
 */
import type { KV } from "@nats-io/kv";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epwSubject, epfSubject, assertBoundedOwner, assertLifecycleToken, type EpCaller } from "./endpoint-subjects.js";
import { RECORD_KINDS, recordSpecKey, createRecordEntry, updateRecordEntry } from "./endpoint-records.js";
import { epfStreamName, readLastFact } from "./endpoint-journal.js";
// The §13.12 resource names and consumer configs live in endpoint-binding.ts (the single source
// of the stream/durable table: epwStreamName, poolDurable, poolConsumerConfig); this module is
// the lease/commit/reconcile SEMANTICS over them.
import { epwStreamName } from "./endpoint-binding.js";

/** A pool item's coordinates: the pool plus the item's ACCEPTANCE IDENTITY (§13.2: the accepted
 *  submission's caller triple + request id — the four trailing subject tokens). */
export interface WorkItemRef {
  endpoint: string;
  pool: string;
  acceptance: EpCaller & { id: string };
}

/** The item's stored subject (`epw.<e>.<pool>.<cOwner>.<cActor>.<cUid>.<id>`). */
export function workItemSubject(space: string, ref: WorkItemRef): string {
  return epwSubject(space, ref.endpoint, ref.pool, ref.acceptance);
}

/** The item's terminal-fact subject (`epf.<e>.wrk.<pool>.<acceptance identity>`, §13.2). */
export function workTerminalSubject(space: string, ref: WorkItemRef): string {
  return epfSubject(space, ref.endpoint, ["wrk", ref.pool, ref.acceptance.owner, ref.acceptance.actor, ref.acceptance.uid, ref.acceptance.id]);
}

function leaseKeyOf(ref: WorkItemRef): string {
  return recordSpecKey(RECORD_KINDS.lease, [ref.endpoint, ref.pool, ref.acceptance.owner, ref.acceptance.actor, ref.acceptance.uid, ref.acceptance.id]);
}

/** Enqueue a pool item (the canonicalizer's seam, §13.6): CREATE-ONLY per acceptance-identity
 *  subject, so acceptance→enqueue spanning two streams stays idempotent — a duplicate or
 *  reconciliation re-enqueue of the same item loses its CAS harmlessly (`enqueued: false`).
 *  The bytes are the acceptance-derived work identity + input ONLY (never a lease/token: broker
 *  redelivery re-delivers stored bytes verbatim, so payload state cannot fence). */
export async function enqueueWorkItem(
  js: JetStreamClient,
  space: string,
  ref: WorkItemRef,
  itemBytes: Uint8Array,
): Promise<{ enqueued: boolean; seq?: number }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    const pa = await js.publish(workItemSubject(space, ref), itemBytes, { headers: h });
    return { enqueued: true, seq: pa.seq };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 10071 || code === 10164) return { enqueued: false }; // a prior enqueue exists (or existed) — the CAS loser never duplicates work
    throw e;
  }
}

/** The worker identity the OWNER binds at assignment: the broker-authenticated caller of the
 *  reserved `lease` command (principal + lifecycle UID, plus epoch for endpoint workers) —
 *  never a payload claim (§13.5). */
export interface WorkWorker {
  owner: string;
  actor: string;
  lifecycleUid: string;
  /** Present iff the worker is itself an endpoint instance (its fenced process epoch). */
  epoch?: number;
}

/** The authoritative lease value at `lease.<e>.<pool>.<acceptance>.spec` (§13.7): the
 *  owner-recorded assignment for the item's CURRENT attempt. */
export interface WorkLease {
  v: 1;
  /** The enqueued item's stream sequence — binds the lease to the exact stored execution. */
  sourceSeq: number;
  /** The broker delivery count of the owner's fetch: the ONLY evidence of delivery. */
  attempt: number;
  worker: WorkWorker;
  /** CAS-incremented once per attempt — the §13.8 monotonic fencing token. */
  fencingToken: number;
  /** From the OWNER's own clock; expiry revokes the claim even before reassignment. */
  leaseDeadline: number;
}

function assertSafeInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a non-negative safe integer; got ${JSON.stringify(v)}`);
  return v;
}

function parseWorker(raw: unknown, key: string): WorkWorker {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `lease record ${key} carries a non-object worker; garbled mediated lease state never authorizes (SPEC 13.5)`);
  const w = raw as { owner?: unknown; actor?: unknown; lifecycleUid?: unknown; epoch?: unknown };
  if (typeof w.owner !== "string" || typeof w.actor !== "string" || typeof w.lifecycleUid !== "string")
    throw new EpEnvelopeError("internal", `lease record ${key} worker is missing its principal/lifecycle binding; garbled state never authorizes (SPEC 13.5)`);
  if (w.epoch !== undefined && (typeof w.epoch !== "number" || !Number.isSafeInteger(w.epoch) || w.epoch < 0))
    throw new EpEnvelopeError("internal", `lease record ${key} worker epoch is not a safe integer; garbled state never authorizes (SPEC 13.5)`);
  return { owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid, ...(w.epoch !== undefined ? { epoch: w.epoch } : {}) };
}

function parseLease(raw: unknown, key: string): WorkLease {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `lease record ${key} is not an object; garbled mediated lease state never authorizes (SPEC 13.5)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1)
    throw new EpEnvelopeError("internal", `lease record ${key} has an unknown version ${JSON.stringify(o.v)}; garbled state never authorizes (SPEC 13.5)`);
  const sourceSeq = o.sourceSeq, attempt = o.attempt, fencingToken = o.fencingToken, leaseDeadline = o.leaseDeadline;
  for (const [name, v] of [["sourceSeq", sourceSeq], ["attempt", attempt], ["fencingToken", fencingToken], ["leaseDeadline", leaseDeadline]] as const)
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new EpEnvelopeError("internal", `lease record ${key} field ${name} is not a safe integer; garbled state never authorizes (SPEC 13.5)`);
  return {
    v: 1, sourceSeq: sourceSeq as number, attempt: attempt as number,
    worker: parseWorker(o.worker, key), fencingToken: fencingToken as number, leaseDeadline: leaseDeadline as number,
  };
}

function decodeJson(value: Uint8Array, key: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(value));
  } catch (e) {
    throw new EpEnvelopeError("internal", `record ${key} does not decode as JSON: ${(e as Error).message}`);
  }
}

/** Issue (or idempotently re-issue) the item's lease for the owner's CURRENT delivery — the
 *  handler seam of the reserved `lease` command, driven ONLY by the pool-owning endpoint
 *  after it fetched the item off its own durable (§13.5).
 *
 *  First-wins idempotent CAS per (item, attempt):
 *   - no record yet → create `{attempt, worker, fencingToken: 1, leaseDeadline: now + ttl}`;
 *   - the recorded attempt EQUALS this delivery → the SAME lease is returned unchanged (a
 *     duplicate or delayed `lease` call never re-assigns within an attempt — the recorded
 *     worker may differ from the asking one, and the commit gate binds to the RECORDED one);
 *   - the recorded attempt is OLDER → redelivery advanced, so the prior claim is superseded:
 *     revision-pinned update to the new attempt with `fencingToken + 1`;
 *   - the recorded attempt is NEWER → the caller's delivery is stale (`expired`).
 *  Expired WORK (`now >= workExpiry`, from the item's AcceptanceFact) is refused before any
 *  lease state is touched: an expired item is settled terminally by reconciliation, never
 *  leased (§13.6/§13.8). Lease EXPIRY (past `leaseDeadline`) does not re-open the attempt —
 *  it revokes the claim at the commit gate; only broker redelivery mints a new attempt. A
 *  SETTLED item (cached terminal exists) refuses here too: re-leasing committed work would
 *  re-execute an effect the terminal already caches. */
export async function leaseWorkItem(
  kv: KV,
  jsm: JetStreamManager,
  space: string,
  args: {
    ref: WorkItemRef;
    sourceSeq: number;
    attempt: number;
    worker: WorkWorker;
    /** The pool OWNER's own clock (never the worker's). */
    now: number;
    leaseTtlMs: number;
    /** The item's absolute work expiry, read from its AcceptanceFact (§13.8). */
    workExpiry: number;
  },
): Promise<WorkLease> {
  assertBoundedOwner(args.worker.owner, "lease worker owner");
  assertBoundedOwner(args.worker.actor, "lease worker actor");
  assertLifecycleToken(args.worker.lifecycleUid, "lease worker lifecycleUid");
  assertSafeInt(args.sourceSeq, "sourceSeq");
  assertSafeInt(args.now, "now");
  assertSafeInt(args.workExpiry, "workExpiry");
  if (!Number.isSafeInteger(args.attempt) || args.attempt < 1)
    throw new EpEnvelopeError("failed-precondition", `attempt must be a positive delivery count; got ${JSON.stringify(args.attempt)} (SPEC 13.5: the attempt IS the broker delivery count)`);
  if (!Number.isSafeInteger(args.leaseTtlMs) || args.leaseTtlMs <= 0)
    throw new EpEnvelopeError("failed-precondition", `leaseTtlMs must be a positive integer; got ${JSON.stringify(args.leaseTtlMs)}`);
  if (args.now >= args.workExpiry)
    throw new EpEnvelopeError("expired", `the item's workExpiry (${args.workExpiry}) has passed at the owner clock (${args.now}); expired work is settled terminally by reconciliation and MUST NOT be leased (SPEC 13.6/13.8)`);
  // "A committed item can never be leased again" is enforced IN this seam, never left to the
  // owner loop's discipline: a redelivery of settled work (a lost owner ack) must be observed
  // and acked without effect, and a re-lease would re-execute an effect the terminal already
  // caches (SPEC 13.5/13.6).
  if ((await readWorkTerminal(jsm, space, args.ref)) !== undefined)
    throw new EpEnvelopeError("failed-precondition", `the item already has a cached terminal state; a committed item can never be leased again - observe the terminal and ack the redelivery without effect (SPEC 13.5/13.6)`);

  const key = leaseKeyOf(args.ref);
  // Two passes: a lost CAS on either branch means a concurrent lease call decided first — the
  // re-read then lands on the equal-attempt idempotent branch (or a newer attempt). A second
  // consecutive loss is a real anomaly, surfaced loudly.
  for (let pass = 0; pass < 2; pass++) {
    const entry = await kv.get(key);
    if (!entry || entry.operation !== "PUT") {
      if (entry && entry.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `the lease record ${key} carries a ${entry.operation} marker; a deletion never resets an authoritative lease — reconcile the store (SPEC 13.5)`);
      const lease: WorkLease = { v: 1, sourceSeq: args.sourceSeq, attempt: args.attempt, worker: args.worker, fencingToken: 1, leaseDeadline: args.now + args.leaseTtlMs };
      try {
        await createRecordEntry(kv, key, lease);
        return lease;
      } catch (e) {
        if (e instanceof EpEnvelopeError && e.code === "conflict") continue; // a concurrent first lease won — re-read and re-decide
        throw e;
      }
    }
    const stored = parseLease(decodeJson(entry.value, key), key);
    if (stored.sourceSeq !== args.sourceSeq)
      throw new EpEnvelopeError("conflict", `the lease record for this acceptance identity binds stream sequence ${stored.sourceSeq}, not ${args.sourceSeq}; a request id becomes new work only after the old item's workExpiry AND fact retention have both passed (SPEC 13.8) — re-read and re-decide`);
    if (stored.attempt === args.attempt) return stored; // first-wins: the still-current attempt's lease, verbatim
    if (stored.attempt > args.attempt)
      throw new EpEnvelopeError("expired", `attempt ${args.attempt} is superseded: redelivery has advanced this item to attempt ${stored.attempt} (SPEC 13.5: an attempt is superseded once the delivery count advances)`);
    const next: WorkLease = { v: 1, sourceSeq: args.sourceSeq, attempt: args.attempt, worker: args.worker, fencingToken: stored.fencingToken + 1, leaseDeadline: args.now + args.leaseTtlMs };
    try {
      await updateRecordEntry(kv, key, next, entry.revision);
      return next;
    } catch (e) {
      if (e instanceof EpEnvelopeError && e.code === "conflict") continue; // a concurrent supersede won — re-read and re-decide
      throw e;
    }
  }
  throw new EpEnvelopeError("conflict", `the lease record ${key} moved twice during one lease call; re-read and re-decide (SPEC 13.8)`);
}

/** A pool item's cached terminal fact (`epf.<e>.wrk.<pool>.<acceptance>`): either a worker's
 *  COMMITTED outcome or reconciliation's terminal `expired` settlement. Create-only CAS per
 *  item — the first terminal wins, forever. */
export type WorkTerminalFact =
  | {
      v: 1; disposition: "committed"; pool: string; caller: EpCaller & { id: string };
      sourceSeq: number; attempt: number; fencingToken: number; worker: WorkWorker;
      outcome: unknown; ts: number;
    }
  | {
      v: 1; disposition: "expired"; pool: string; caller: EpCaller & { id: string };
      workExpiry: number; ts: number;
    };

function parseTerminal(raw: unknown, subject: string): WorkTerminalFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} is not an object; garbled mediated fact state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || (o.disposition !== "committed" && o.disposition !== "expired"))
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} has an unknown version/disposition; garbled state never authorizes (SPEC 13.6)`);
  return raw as WorkTerminalFact;
}

/** Read the item's cached terminal state (leader-served last-by-subject: the CAS-loser read
 *  needs read-your-writes against the leader that just rejected it, §13.4). `undefined` when
 *  the item has no terminal yet. */
export async function readWorkTerminal(
  jsm: JetStreamManager,
  space: string,
  ref: WorkItemRef,
): Promise<WorkTerminalFact | undefined> {
  const subject = workTerminalSubject(space, ref);
  const raw = await readLastFact(jsm, epfStreamName(space), subject);
  return raw === undefined ? undefined : parseTerminal(raw, subject);
}

/** Settle a claimed item — the handler seam of the reserved `commit` command, driven ONLY by
 *  the pool-owning endpoint on behalf of the broker-authenticated commit caller (§13.5). The
 *  gate validates, in order, against the OWNER-RECORDED lease and the owner's own clock:
 *  token currency (attempt + fencingToken), the caller IS the lease's bound worker, and the
 *  unexpired lease. Then ONE atomic create-only CAS writes the per-item terminal fact: the
 *  winner returns `won: true`; a duplicate/raced commit loses loudly (`won: false`) and
 *  returns the CACHED terminal outcome instead of writing anything. Only after observing the
 *  committed terminal does the owner ack the pool message ({@link readWorkTerminal} is that
 *  observation): the deletion capability never leaves the owner, and no worker-side ack can
 *  destroy an item whose commit was rejected. */
export async function commitWorkItem(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: {
    ref: WorkItemRef;
    /** The broker-authenticated caller of the `commit` command — never a payload claim. */
    caller: WorkWorker;
    /** The exact lease tuple the worker carries back (§13.5). */
    lease: { sourceSeq: number; attempt: number; fencingToken: number };
    outcome: unknown;
    /** The pool OWNER's own clock. */
    now: number;
  },
): Promise<{ won: boolean; fact: WorkTerminalFact }> {
  assertSafeInt(args.now, "now");
  const key = leaseKeyOf(args.ref);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `no lease is recorded for this item (${key}); a commit settles only owner-assigned work (SPEC 13.5)`);
  const stored = parseLease(decodeJson(entry.value, key), key);
  if (stored.sourceSeq !== args.lease.sourceSeq)
    throw new EpEnvelopeError("expired", `the commit names stream sequence ${args.lease.sourceSeq} but the lease binds ${stored.sourceSeq}; a stale execution binding never settles (SPEC 13.5)`);
  if (stored.attempt !== args.lease.attempt || stored.fencingToken !== args.lease.fencingToken)
    throw new EpEnvelopeError("expired", `stale fencing: the commit carries (attempt ${args.lease.attempt}, token ${args.lease.fencingToken}) but the current lease is (attempt ${stored.attempt}, token ${stored.fencingToken}); a superseded worker's write is rejected before or after reassignment (SPEC 13.5)`);
  const w = stored.worker;
  const sameWorker = w.owner === args.caller.owner && w.actor === args.caller.actor && w.lifecycleUid === args.caller.lifecycleUid
    && (w.epoch === undefined || w.epoch === args.caller.epoch);
  if (!sameWorker)
    throw new EpEnvelopeError("permission-denied", `the commit caller ${args.caller.owner}.${args.caller.actor}/${args.caller.lifecycleUid} is not the lease's bound worker ${w.owner}.${w.actor}/${w.lifecycleUid}; the binding is owner-recorded at assignment, never a payload claim (SPEC 13.5)`);
  if (args.now > stored.leaseDeadline)
    throw new EpEnvelopeError("expired", `the lease expired at ${stored.leaseDeadline} (owner clock ${args.now}); expiry revokes the claim even before reassignment (SPEC 13.5)`);

  const fact: WorkTerminalFact = {
    v: 1, disposition: "committed", pool: args.ref.pool, caller: args.ref.acceptance,
    sourceSeq: stored.sourceSeq, attempt: stored.attempt, fencingToken: stored.fencingToken,
    worker: stored.worker, outcome: args.outcome, ts: args.now,
  };
  const subject = workTerminalSubject(space, args.ref);
  const res = await publishCreateOnly(js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  if (res.won) return { won: true, fact };
  const winner = await readWorkTerminal(jsm, space, args.ref);
  if (winner === undefined)
    throw new EpEnvelopeError("internal", `the terminal CAS for ${subject} was lost but no winning fact is readable; the leader-served read must observe the winner (SPEC 13.4)`);
  return { won: false, fact: winner };
}

async function publishCreateOnly(js: JetStreamClient, subject: string, bytes: Uint8Array): Promise<{ won: boolean }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    await js.publish(subject, bytes, { headers: h });
    return { won: true };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 10071 || code === 10164) return { won: false };
    throw e;
  }
}

/** The §13.6 reconciliation verdict for one accepted, pool-routed item. */
export type WorkReconcileVerdict =
  | { state: "settled"; fact: WorkTerminalFact }
  | { state: "expired-settled"; fact: WorkTerminalFact }
  | { state: "live" }
  | { state: "re-enqueued"; seq: number };

/** Decide and repair one item against the §13.6 predicate — the canonicalizer's reconciliation
 *  seam (§13.9 row), for an ACCEPTED pool-routed item (its AcceptanceFact supplies `workExpiry`,
 *  `sourceSeq` is not needed: identity is the subject). In order:
 *   1. a terminal `wrk` fact exists → SETTLED (the owner acks without effect; settled work is
 *      never re-enqueued as new);
 *   2. `now >= workExpiry` → the item is DEAD, leased or not: settle it terminally as
 *      `expired` by the same create-only CAS (a raced settlement reads the winner) — an
 *      expired item is never re-enqueued;
 *   3. a live pool entry exists (subject-confined DIRECT get: an acked item has left the
 *      WorkQueue, an in-flight one remains readable) → LIVE, nothing to repair;
 *   4. otherwise the item is unambiguously never-enqueued-or-lost — the ONLY re-enqueueable
 *      state: re-enqueue the SAME acceptance-derived bytes create-only (the SAME workExpiry
 *      rides in the AcceptanceFact, which a re-enqueue never rewrites). */
export async function reconcileWorkItem(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: {
    ref: WorkItemRef;
    /** The acceptance-derived stored bytes (work identity + input only). */
    itemBytes: Uint8Array;
    /** From the item's AcceptanceFact — an absolute horizon a re-enqueue never resets. */
    workExpiry: number;
    now: number;
  },
): Promise<WorkReconcileVerdict> {
  assertSafeInt(args.now, "now");
  assertSafeInt(args.workExpiry, "workExpiry");
  const terminal = await readWorkTerminal(jsm, space, args.ref);
  if (terminal !== undefined) return { state: "settled", fact: terminal };
  if (args.now >= args.workExpiry) {
    const fact: WorkTerminalFact = {
      v: 1, disposition: "expired", pool: args.ref.pool, caller: args.ref.acceptance,
      workExpiry: args.workExpiry, ts: args.now,
    };
    const res = await publishCreateOnly(js, workTerminalSubject(space, args.ref), new TextEncoder().encode(JSON.stringify(fact)));
    if (res.won) return { state: "expired-settled", fact };
    const winner = await readWorkTerminal(jsm, space, args.ref);
    if (winner === undefined)
      throw new EpEnvelopeError("internal", `the expired-settlement CAS for this item was lost but no winning fact is readable (SPEC 13.4)`);
    return { state: "settled", fact: winner };
  }
  if (await liveEntryExists(jsm, space, args.ref)) return { state: "live" };
  const re = await enqueueWorkItem(js, space, args.ref, args.itemBytes);
  if (!re.enqueued) {
    // The create lost: a concurrent reconciler re-enqueued first, or the WorkQueue's per-subject
    // history refuses a second create after consumption. Re-probe: a live entry means repaired.
    if (await liveEntryExists(jsm, space, args.ref)) return { state: "live" };
    throw new EpEnvelopeError("failed-precondition", `the item is not settled, not expired, not live, and its create-only re-enqueue is refused by the stream's per-subject history; the store needs operator reconciliation (SPEC 13.6)`);
  }
  return { state: "re-enqueued", seq: re.seq! };
}

/** The §13.6 liveness read: the subject-confined DIRECT last-by-subject probe on the item's own
 *  subject (an acked item has LEFT the WorkQueue; an in-flight one remains readable). Absence
 *  surfaces as `null` or a no-message error depending on server version — both mean gone. */
async function liveEntryExists(jsm: JetStreamManager, space: string, ref: WorkItemRef): Promise<boolean> {
  try {
    return (await jsm.direct.getMessage(epwStreamName(space), { last_by_subj: workItemSubject(space, ref) })) !== null;
  } catch {
    return false;
  }
}
