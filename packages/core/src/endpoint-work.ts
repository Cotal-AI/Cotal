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
 * and the consumer's ack_wait is the broker's redelivery-to-owner timer only.
 *
 * THE LEASE RECORD IS THE SINGLE PER-ITEM LINEARIZATION POINT. The `lease` record
 * (`lease.<e>.<pool>.<acceptance>`, §13.7) holds the owner-recorded assignment for the item's
 * CURRENT attempt AND its settlement state (`leased` | `settled`). A redelivery-advance, a
 * commit, and an expiry all contend on this ONE key's revision, so lease currency and terminal
 * settlement share a fence rather than reading across KV + EPF: the winner of the lease's CAS to
 * `settled` decides the disposition, and the per-item terminal fact
 * `epf.<endpoint>.wrk.<pool>.<acceptance identity>` is DERIVED from the settled lease (published
 * create-only, idempotently, by the committing worker's owner or by reconciliation). This closes
 * the double-effect windows a cross-store read-then-write left open (a stale attempt committing
 * after reassignment; an already-settled item being leased again).
 *
 * Every accepted item carries an absolute `workExpiry` (from its AcceptanceFact, §13.8). The
 * lease deadline is CLAMPED to it (`min(now + ttl, workExpiry)`), so no valid lease outlives the
 * horizon, and commit additionally refuses at `now >= workExpiry`: the item is dead once it
 * passes, leased or not. An endpoint worker's process epoch is freshly resolved and re-checked
 * at commit (§13.8), so a superseded process cannot settle a lease its predecessor held.
 */
import type { KV } from "@nats-io/kv";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/transport-node";
import { rawDigest } from "./canonical.js";
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

/** A trusted, space-bonded work-pool context: the KV + JS + JSM + space are bundled by ONE
 *  constructor so a caller can never check a space-A lease against space-B facts (the resources
 *  are not independently injectable at each call). Every seam takes this context. */
export interface WorkPoolContext {
  kv: KV;
  js: JetStreamClient;
  jsm: JetStreamManager;
  space: string;
}

/** Bond the resources to one space. */
export function workPoolContext(kv: KV, js: JetStreamClient, jsm: JetStreamManager, space: string): WorkPoolContext {
  if (typeof space !== "string" || space.length === 0) throw new EpEnvelopeError("failed-precondition", "a work-pool context needs a space");
  return { kv, js, jsm, space };
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

function assertSafeInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a non-negative safe integer; got ${JSON.stringify(v)}`);
  return v;
}

/** The no-message result of a subject-confined last-by-subject read (JetStream err_code 10037):
 *  the ONLY error that means "genuinely absent". Every other failure (permission, transport,
 *  server) is `unavailable`, never fabricated as absence. */
function isNoMessage(e: unknown): boolean {
  return (e as { code?: unknown })?.code === 10037;
}

/** Enqueue a pool item (the canonicalizer's seam, §13.6): CREATE-ONLY per acceptance-identity
 *  subject, so acceptance→enqueue spanning two streams stays idempotent — a duplicate or
 *  reconciliation re-enqueue of the same item loses its CAS harmlessly. The bytes are the
 *  acceptance-derived work identity + input ONLY (never a lease/token). A CAS loss is only a
 *  benign duplicate if the stored bytes are BYTE-IDENTICAL to the ones offered (same
 *  acceptance-derived work): a differing prior body under the same identity is a canonicalizer
 *  mixup and fails loud, never silently executes the wrong input. */
export async function enqueueWorkItem(
  ctx: WorkPoolContext,
  ref: WorkItemRef,
  itemBytes: Uint8Array,
): Promise<{ enqueued: boolean; seq?: number }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  const subject = workItemSubject(ctx.space, ref);
  try {
    const pa = await ctx.js.publish(subject, itemBytes, { headers: h });
    return { enqueued: true, seq: pa.seq };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    // A prior enqueue exists (or existed and was consumed). If a live entry remains, verify its
    // bytes match; a consumed-and-gone entry (no message) is a settled/in-flight item the caller
    // reconciles, not a mismatch.
    let stored;
    try { stored = await ctx.jsm.direct.getMessage(epwStreamName(ctx.space), { last_by_subj: subject }); }
    catch (ge) { if (isNoMessage(ge)) return { enqueued: false }; throw new EpEnvelopeError("unavailable", `the enqueue CAS lost and the stored item is not readable to verify identity (SPEC 13.6): ${(ge as Error)?.message ?? String(ge)}`); }
    if (stored !== null && rawDigest(stored.data) !== rawDigest(itemBytes))
      throw new EpEnvelopeError("conflict", `an item with acceptance identity "${ref.acceptance.id}" is already enqueued with DIFFERENT bytes; idempotency is same-subject AND same-bytes — a differing body is a canonicalizer mixup, never silently accepted (SPEC 13.6)`);
    return { enqueued: false };
  }
}

/** The worker identity the OWNER binds at assignment: the broker-authenticated caller of the
 *  reserved `lease` command (§13.5), DISCRIMINATED by kind. An `endpoint` worker (an endpoint
 *  instance draining the pool) MUST carry its fenced process `epoch`, freshly re-checked at
 *  commit; an `agent` worker has no epoch (its lifecycle UID is the whole currency). The kind is
 *  structural so a missing epoch can never silently disable the fence. */
export type WorkWorker =
  | { kind: "agent"; owner: string; actor: string; lifecycleUid: string }
  | { kind: "endpoint"; owner: string; actor: string; lifecycleUid: string; epoch: number };

function assertWorker(w: WorkWorker, what: string): WorkWorker {
  assertBoundedOwner(w.owner, `${what} owner`);
  assertBoundedOwner(w.actor, `${what} actor`);
  assertLifecycleToken(w.lifecycleUid, `${what} lifecycleUid`);
  if (w.kind === "endpoint") {
    if (!Number.isSafeInteger(w.epoch) || w.epoch < 0)
      throw new EpEnvelopeError("failed-precondition", `${what} is an endpoint worker but carries no valid epoch; an endpoint worker's process epoch is its fence (SPEC 13.8)`);
    return { kind: "endpoint", owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid, epoch: w.epoch };
  }
  if (w.kind !== "agent")
    throw new EpEnvelopeError("failed-precondition", `${what} has an unknown worker kind; a worker is "agent" or "endpoint" (SPEC 13.5)`);
  return { kind: "agent", owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid };
}

function parseWorker(raw: unknown, key: string): WorkWorker {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `lease record ${key} carries a non-object worker; garbled mediated lease state never authorizes (SPEC 13.5)`);
  const w = raw as Record<string, unknown>;
  if (typeof w.owner !== "string" || typeof w.actor !== "string" || typeof w.lifecycleUid !== "string" || (w.kind !== "agent" && w.kind !== "endpoint"))
    throw new EpEnvelopeError("internal", `lease record ${key} worker is missing its kind/principal/lifecycle binding; garbled state never authorizes (SPEC 13.5)`);
  if (w.kind === "endpoint" && (typeof w.epoch !== "number" || !Number.isSafeInteger(w.epoch) || w.epoch < 0))
    throw new EpEnvelopeError("internal", `lease record ${key} endpoint worker has no valid epoch; garbled state never authorizes (SPEC 13.5)`);
  return w.kind === "endpoint"
    ? { kind: "endpoint", owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid, epoch: w.epoch as number }
    : { kind: "agent", owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid };
}

function sameWorker(a: WorkWorker, b: WorkWorker): boolean {
  return a.kind === b.kind && a.owner === b.owner && a.actor === b.actor && a.lifecycleUid === b.lifecycleUid
    && (a.kind !== "endpoint" || (b.kind === "endpoint" && a.epoch === b.epoch));
}

/** The authoritative lease value at `lease.<e>.<pool>.<acceptance>.spec` (§13.7). The lease is
 *  the item's per-item state machine: `leased` (a live assignment for the CURRENT attempt) or
 *  `settled` (terminal — carries the disposition + committed outcome so the terminal fact is
 *  derivable). */
export interface WorkLease {
  v: 1;
  state: "leased" | "settled";
  /** The enqueued item's stream sequence — binds the lease to the exact stored execution. */
  sourceSeq: number;
  /** The broker delivery count of the owner's fetch: the ONLY evidence of delivery. */
  attempt: number;
  worker: WorkWorker;
  /** CAS-incremented once per attempt — the §13.8 monotonic fencing token. */
  fencingToken: number;
  /** From the OWNER's own clock, CLAMPED to `workExpiry`; expiry revokes the claim. */
  leaseDeadline: number;
  /** The item's absolute work horizon (§13.8), persisted so commit fences on it too. */
  workExpiry: number;
  /** Present iff `state === "settled"`: how it settled and (for a commit) the cached outcome. */
  disposition?: "committed" | "expired";
  outcome?: unknown;
  committedTs?: number;
}

function parseLease(raw: unknown, key: string): WorkLease {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `lease record ${key} is not an object; garbled mediated lease state never authorizes (SPEC 13.5)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || (o.state !== "leased" && o.state !== "settled"))
    throw new EpEnvelopeError("internal", `lease record ${key} has an unknown version/state; garbled state never authorizes (SPEC 13.5)`);
  for (const [name, v] of [["sourceSeq", o.sourceSeq], ["attempt", o.attempt], ["fencingToken", o.fencingToken], ["leaseDeadline", o.leaseDeadline], ["workExpiry", o.workExpiry]] as const)
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new EpEnvelopeError("internal", `lease record ${key} field ${name} is not a safe integer; garbled state never authorizes (SPEC 13.5)`);
  if (o.state === "settled" && o.disposition !== "committed" && o.disposition !== "expired")
    throw new EpEnvelopeError("internal", `settled lease record ${key} has no valid disposition; garbled state never authorizes (SPEC 13.5)`);
  return {
    v: 1, state: o.state, sourceSeq: o.sourceSeq as number, attempt: o.attempt as number,
    worker: parseWorker(o.worker, key), fencingToken: o.fencingToken as number,
    leaseDeadline: o.leaseDeadline as number, workExpiry: o.workExpiry as number,
    ...(o.state === "settled" ? { disposition: o.disposition as "committed" | "expired", outcome: o.outcome, committedTs: o.committedTs as number | undefined } : {}),
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
 *  reserved `lease` command's handler seam, driven ONLY by the pool-owning endpoint after it
 *  fetched the item off its own durable (§13.5).
 *
 *  First-wins idempotent CAS per (item, attempt):
 *   - no record → create `leased {attempt, worker, fencingToken: 1, leaseDeadline, workExpiry}`;
 *   - the recorded attempt EQUALS this delivery → the SAME lease returns unchanged (no
 *     reassignment within an attempt; the commit gate binds to the RECORDED worker);
 *   - the recorded attempt is OLDER → redelivery advanced: revision-pinned update to the new
 *     attempt with `fencingToken + 1`;
 *   - the recorded attempt is NEWER → the caller's delivery is stale (`expired`).
 *  Refusals before touching state: EXPIRED work (`now >= workExpiry`, settled by reconciliation,
 *  never leased) and a SETTLED lease (`state === "settled"` — a committed item can never be
 *  leased again, fenced on the SAME key, no cross-store read). `leaseDeadline` is CLAMPED to
 *  `workExpiry` so no valid lease outlives the horizon. A DEL marker on the lease refuses. */
export async function leaseWorkItem(
  ctx: WorkPoolContext,
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
  const worker = assertWorker(args.worker, "lease worker");
  assertSafeInt(args.sourceSeq, "sourceSeq");
  assertSafeInt(args.now, "now");
  assertSafeInt(args.workExpiry, "workExpiry");
  if (!Number.isSafeInteger(args.attempt) || args.attempt < 1)
    throw new EpEnvelopeError("failed-precondition", `attempt must be a positive delivery count; got ${JSON.stringify(args.attempt)} (SPEC 13.5)`);
  if (!Number.isSafeInteger(args.leaseTtlMs) || args.leaseTtlMs <= 0)
    throw new EpEnvelopeError("failed-precondition", `leaseTtlMs must be a positive integer; got ${JSON.stringify(args.leaseTtlMs)}`);
  if (args.now >= args.workExpiry)
    throw new EpEnvelopeError("expired", `the item's workExpiry (${args.workExpiry}) has passed at the owner clock (${args.now}); expired work is settled by reconciliation, never leased (SPEC 13.6/13.8)`);
  const leaseDeadline = Math.min(args.now + args.leaseTtlMs, args.workExpiry); // no valid lease outlives the horizon
  const key = leaseKeyOf(args.ref);
  for (let pass = 0; pass < 2; pass++) {
    const entry = await ctx.kv.get(key);
    if (!entry || entry.operation !== "PUT") {
      if (entry && entry.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `the lease record ${key} carries a ${entry.operation} marker; a deletion never resets an authoritative lease (SPEC 13.5)`);
      const lease: WorkLease = { v: 1, state: "leased", sourceSeq: args.sourceSeq, attempt: args.attempt, worker, fencingToken: 1, leaseDeadline, workExpiry: args.workExpiry };
      try { await createRecordEntry(ctx.kv, key, lease); return lease; }
      catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
    }
    const stored = parseLease(decodeJson(entry.value, key), key);
    if (stored.sourceSeq !== args.sourceSeq)
      throw new EpEnvelopeError("conflict", `the lease for this acceptance identity binds stream sequence ${stored.sourceSeq}, not ${args.sourceSeq}; a request id becomes new work only after workExpiry AND fact retention pass (SPEC 13.8)`);
    if (stored.state === "settled")
      throw new EpEnvelopeError("failed-precondition", `the item is already settled ${stored.disposition}; a committed item can never be leased again — observe the terminal and ack the redelivery without effect (SPEC 13.5/13.6)`);
    if (stored.attempt === args.attempt) return stored; // first-wins: the still-current attempt's lease, verbatim
    if (stored.attempt > args.attempt)
      throw new EpEnvelopeError("expired", `attempt ${args.attempt} is superseded: redelivery advanced this item to attempt ${stored.attempt} (SPEC 13.5)`);
    const next: WorkLease = { v: 1, state: "leased", sourceSeq: args.sourceSeq, attempt: args.attempt, worker, fencingToken: stored.fencingToken + 1, leaseDeadline, workExpiry: args.workExpiry };
    try { await updateRecordEntry(ctx.kv, key, next, entry.revision); return next; }
    catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
  }
  throw new EpEnvelopeError("conflict", `the lease record ${key} moved twice during one lease call; re-read and re-decide (SPEC 13.8)`);
}

/** A pool item's cached terminal fact (`epf.<e>.wrk.<pool>.<acceptance>`), DERIVED from the
 *  settled lease. Create-only CAS per item; the first terminal wins forever. */
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

/** Validate a terminal fact fully AND bind it to the subject it was read from (§13.4): a garbled
 *  or mis-subjected fact never counts as authoritative settlement (which would suppress all
 *  future leasing). */
function parseTerminal(raw: unknown, subject: string, ref: WorkItemRef): WorkTerminalFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || (o.disposition !== "committed" && o.disposition !== "expired"))
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} has an unknown version/disposition (SPEC 13.6)`);
  if (o.pool !== ref.pool)
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} names pool ${JSON.stringify(o.pool)}, not ${ref.pool}; a mis-subjected fact never authorizes (SPEC 13.4)`);
  const cr = o.caller as Record<string, unknown> | undefined;
  if (!cr || cr.owner !== ref.acceptance.owner || cr.actor !== ref.acceptance.actor || cr.uid !== ref.acceptance.uid || cr.id !== ref.acceptance.id)
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} carries a caller identity other than its subject's acceptance identity (SPEC 13.4)`);
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0)
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} has no valid ts (SPEC 13.6)`);
  if (o.disposition === "committed") {
    for (const [n, v] of [["sourceSeq", o.sourceSeq], ["attempt", o.attempt], ["fencingToken", o.fencingToken]] as const)
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
        throw new EpEnvelopeError("internal", `committed terminal fact on ${subject} field ${n} is not a safe integer (SPEC 13.6)`);
    parseWorker(o.worker, subject);
  } else if (typeof o.workExpiry !== "number" || !Number.isSafeInteger(o.workExpiry) || o.workExpiry < 0) {
    throw new EpEnvelopeError("internal", `expired terminal fact on ${subject} has no valid workExpiry (SPEC 13.6)`);
  }
  return o as WorkTerminalFact;
}

/** Read the item's cached terminal state (leader-served last-by-subject: the CAS-loser read
 *  needs read-your-writes, §13.4). `undefined` when the item has no terminal yet. */
export async function readWorkTerminal(ctx: WorkPoolContext, ref: WorkItemRef): Promise<WorkTerminalFact | undefined> {
  const subject = workTerminalSubject(ctx.space, ref);
  const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
  return raw === undefined ? undefined : parseTerminal(raw, subject, ref);
}

/** Build the terminal fact a settled lease derives. */
function terminalOf(ref: WorkItemRef, lease: WorkLease): WorkTerminalFact {
  if (lease.disposition === "committed")
    return { v: 1, disposition: "committed", pool: ref.pool, caller: ref.acceptance, sourceSeq: lease.sourceSeq, attempt: lease.attempt, fencingToken: lease.fencingToken, worker: lease.worker, outcome: lease.outcome, ts: lease.committedTs ?? 0 };
  return { v: 1, disposition: "expired", pool: ref.pool, caller: ref.acceptance, workExpiry: lease.workExpiry, ts: lease.committedTs ?? 0 };
}

/** Publish a settled lease's terminal fact create-only (idempotent: a lost CAS reads the winner,
 *  which — because the terminal is derived from the settled lease — is byte-consistent). */
async function publishTerminal(ctx: WorkPoolContext, ref: WorkItemRef, fact: WorkTerminalFact): Promise<{ won: boolean; fact: WorkTerminalFact }> {
  const subject = workTerminalSubject(ctx.space, ref);
  const res = await publishCreateOnly(ctx.js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  if (res.won) return { won: true, fact };
  const winner = await readWorkTerminal(ctx, ref);
  if (winner === undefined)
    throw new EpEnvelopeError("internal", `the terminal CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
  return { won: false, fact: winner };
}

/** Settle a claimed item — the reserved `commit` command's handler seam, driven ONLY by the
 *  pool-owning endpoint on behalf of the broker-authenticated commit caller (§13.5). Gate order
 *  against the OWNER-RECORDED lease and the owner's clock: execution binding (sourceSeq) →
 *  token currency (attempt + fencingToken) → the caller IS the lease's bound worker → FRESH
 *  epoch currency for an endpoint worker → `now < workExpiry` → `now < leaseDeadline`. Then the
 *  FENCE: a revision-pinned CAS advances the lease `leased → settled{committed, outcome}` — the
 *  SAME key a redelivery-advance contends on, so a stale attempt cannot slip a commit in after
 *  reassignment. Only after winning that CAS is the terminal fact (derived from the settled
 *  lease) published. A lost lease CAS means the lease advanced or settled concurrently: a
 *  same-tuple settle is a DUPLICATE (return the cached terminal, which DOMINATES lease-expiry —
 *  a true duplicate always sees its cached outcome, §13.5); anything else is `expired`/`conflict`.
 *
 *  `resolveCurrentEpoch` freshly resolves an endpoint worker's CURRENT process epoch from trusted
 *  authority (the lifecycle mapping) — a required seam for endpoint workers, absent for agents. */
export async function commitWorkItem(
  ctx: WorkPoolContext,
  args: {
    ref: WorkItemRef;
    /** The broker-authenticated caller of the `commit` command — never a payload claim. */
    caller: WorkWorker;
    /** The exact lease tuple the worker carries back (§13.5). */
    lease: { sourceSeq: number; attempt: number; fencingToken: number };
    outcome: unknown;
    /** The pool OWNER's own clock. */
    now: number;
    /** REQUIRED for an endpoint worker: fresh current-epoch resolver (null = retired/unknown
     *  lifecycle). Absent/ignored for an agent worker. */
    resolveCurrentEpoch?: (worker: WorkWorker) => Promise<number | null> | number | null;
  },
): Promise<{ won: boolean; fact: WorkTerminalFact }> {
  assertSafeInt(args.now, "now");
  const caller = assertWorker(args.caller, "commit caller");
  const key = leaseKeyOf(args.ref);
  const entry = await ctx.kv.get(key);
  if (!entry || entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `no lease is recorded for this item (${key}); a commit settles only owner-assigned work (SPEC 13.5)`);
  const stored = parseLease(decodeJson(entry.value, key), key);

  // A DUPLICATE (same worker, same lease tuple) always observes its cached terminal — the cache
  // lookup DOMINATES lease-expiry, so a slow-but-legitimate retry after its own commit never
  // sees `expired` (§13.5:1517-1519). A stale/foreign caller does NOT get here (identity + tuple
  // must match the settled lease).
  if (stored.state === "settled") {
    const dup = stored.sourceSeq === args.lease.sourceSeq && stored.attempt === args.lease.attempt
      && stored.fencingToken === args.lease.fencingToken && sameWorker(stored.worker, caller);
    if (dup) return publishTerminal(ctx, args.ref, terminalOf(args.ref, stored)); // idempotent republish; won:false once it already exists
    throw new EpEnvelopeError("conflict", `the item is already settled ${stored.disposition} under a different attempt/worker; this commit is superseded (SPEC 13.5)`);
  }

  if (stored.sourceSeq !== args.lease.sourceSeq)
    throw new EpEnvelopeError("expired", `the commit names stream sequence ${args.lease.sourceSeq} but the lease binds ${stored.sourceSeq}; a stale execution binding never settles (SPEC 13.5)`);
  if (stored.attempt !== args.lease.attempt || stored.fencingToken !== args.lease.fencingToken)
    throw new EpEnvelopeError("expired", `stale fencing: the commit carries (attempt ${args.lease.attempt}, token ${args.lease.fencingToken}) but the lease is (attempt ${stored.attempt}, token ${stored.fencingToken}) (SPEC 13.5)`);
  if (!sameWorker(stored.worker, caller))
    throw new EpEnvelopeError("permission-denied", `the commit caller is not the lease's bound worker (${stored.worker.owner}.${stored.worker.actor}/${stored.worker.lifecycleUid}); the binding is owner-recorded at assignment (SPEC 13.5)`);
  // FRESH lifecycle/epoch currency for an endpoint worker (§13.8): a superseded process cannot
  // settle its predecessor's lease.
  if (stored.worker.kind === "endpoint") {
    if (typeof args.resolveCurrentEpoch !== "function")
      throw new EpEnvelopeError("failed-precondition", `committing an endpoint worker's item requires a fresh-epoch resolver (SPEC 13.8: lifecycle/epoch currency is validated at the commit boundary)`);
    const current = await args.resolveCurrentEpoch(stored.worker);
    if (current === null)
      throw new EpEnvelopeError("expired", `the endpoint worker's lifecycle is retired/unknown; a retired worker cannot commit (SPEC 13.8)`);
    if (current !== stored.worker.epoch)
      throw new EpEnvelopeError("expired", `the endpoint worker's lease bound epoch ${stored.worker.epoch} but the current process epoch is ${current}; a superseded process cannot settle (SPEC 13.8)`);
  }
  if (args.now >= stored.workExpiry)
    throw new EpEnvelopeError("expired", `the item's workExpiry (${stored.workExpiry}) has passed at the owner clock (${args.now}); the item is dead, leased or not (SPEC 13.8)`);
  if (args.now >= stored.leaseDeadline)
    throw new EpEnvelopeError("expired", `the lease expired at ${stored.leaseDeadline} (owner clock ${args.now}); expiry revokes the claim AT that deadline (SPEC 13.5)`);

  // THE FENCE: advance the lease to settled on its OWN revision. A concurrent redelivery-advance
  // or expiry-settle contends on this exact revision; the loser re-reads and re-decides.
  const settled: WorkLease = { ...stored, state: "settled", disposition: "committed", outcome: args.outcome, committedTs: args.now };
  try {
    await updateRecordEntry(ctx.kv, key, settled, entry.revision);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const now2 = parseLease(decodeJson((await ctx.kv.get(key))!.value, key), key);
    if (now2.state === "settled" && now2.sourceSeq === args.lease.sourceSeq && now2.attempt === args.lease.attempt && sameWorker(now2.worker, caller))
      return publishTerminal(ctx, args.ref, terminalOf(args.ref, now2)); // our own settle raced in; idempotent
    if (now2.state === "settled")
      throw new EpEnvelopeError("conflict", `the item settled ${now2.disposition} concurrently under a different attempt/worker; this commit is superseded (SPEC 13.5)`);
    throw new EpEnvelopeError("expired", `a concurrent redelivery advanced the lease to attempt ${now2.attempt}; this commit is superseded (SPEC 13.5)`);
  }
  return publishTerminal(ctx, args.ref, terminalOf(args.ref, settled));
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
 *  seam (§13.9 row), for an ACCEPTED pool-routed item. The LEASE is consulted as the settlement
 *  arbiter so reconciliation never contradicts a committing worker:
 *   1. a terminal `wrk` fact exists → SETTLED (the owner acks without effect);
 *   2. the lease is `settled` (a commit fenced it, maybe crashed before publishing) → publish
 *      the derived terminal (idempotent) → SETTLED — recovery, never re-enqueued;
 *   3. `now >= workExpiry` → the item is DEAD, leased or not: fence it by CAS-settling the lease
 *      `expired` (racing a live commit on the SAME key; a lost CAS re-reads the winner), then
 *      publish the derived terminal → EXPIRED-SETTLED; with no lease record, the terminal
 *      create-only CAS is itself the arbiter (no commit can race a lease-less item);
 *   4. a live pool entry exists (subject-confined DIRECT get) → LIVE;
 *   5. else re-check the terminal (a commit may have landed since step 1), then re-enqueue the
 *      SAME acceptance-derived bytes create-only — the ONLY re-enqueueable state. */
export async function reconcileWorkItem(
  ctx: WorkPoolContext,
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
  const terminal = await readWorkTerminal(ctx, args.ref);
  if (terminal !== undefined) return { state: terminal.disposition === "expired" ? "expired-settled" : "settled", fact: terminal };

  const key = leaseKeyOf(args.ref);
  const leaseEntry = await ctx.kv.get(key);
  const lease = leaseEntry && leaseEntry.operation === "PUT" ? parseLease(decodeJson(leaseEntry.value, key), key) : undefined;

  // (2) a commit fenced the lease but may have crashed before publishing — finalize its terminal.
  if (lease?.state === "settled") {
    const pub = await publishTerminal(ctx, args.ref, terminalOf(args.ref, lease));
    return { state: pub.fact.disposition === "expired" ? "expired-settled" : "settled", fact: pub.fact };
  }

  // (3) dead item: fence via the lease (if one exists) so a live commit and this expiry contend
  // on the SAME revision, then derive the expired terminal.
  if (args.now >= args.workExpiry) {
    if (lease !== undefined) {
      const settledExpired: WorkLease = { ...lease, state: "settled", disposition: "expired", committedTs: args.now };
      try { await updateRecordEntry(ctx.kv, key, settledExpired, leaseEntry!.revision); }
      catch (e) {
        if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
        const now2 = parseLease(decodeJson((await ctx.kv.get(key))!.value, key), key);
        const pub = await publishTerminal(ctx, args.ref, terminalOf(args.ref, now2)); // a commit/expiry raced; publish the winner
        return { state: pub.fact.disposition === "expired" ? "expired-settled" : "settled", fact: pub.fact };
      }
      const pub = await publishTerminal(ctx, args.ref, terminalOf(args.ref, settledExpired));
      return { state: "expired-settled", fact: pub.fact };
    }
    // No lease: the terminal create-only CAS is the sole arbiter.
    const fact: WorkTerminalFact = { v: 1, disposition: "expired", pool: args.ref.pool, caller: args.ref.acceptance, workExpiry: args.workExpiry, ts: args.now };
    const pub = await publishTerminal(ctx, args.ref, fact);
    return { state: pub.fact.disposition === "expired" ? "expired-settled" : "settled", fact: pub.fact };
  }

  if (await liveEntryExists(ctx, args.ref)) return { state: "live" };
  // (5) re-check the terminal (a commit may have landed during the live probe) before re-enqueue.
  const late = await readWorkTerminal(ctx, args.ref);
  if (late !== undefined) return { state: late.disposition === "expired" ? "expired-settled" : "settled", fact: late };
  const re = await enqueueWorkItem(ctx, args.ref, args.itemBytes);
  if (!re.enqueued) {
    if (await liveEntryExists(ctx, args.ref)) return { state: "live" };
    const after = await readWorkTerminal(ctx, args.ref);
    if (after !== undefined) return { state: after.disposition === "expired" ? "expired-settled" : "settled", fact: after };
    throw new EpEnvelopeError("failed-precondition", `the item is not settled, not expired, not live, and its create-only re-enqueue is refused by the stream's per-subject history; needs operator reconciliation (SPEC 13.6)`);
  }
  return { state: "re-enqueued", seq: re.seq! };
}

/** The §13.6 liveness read: the subject-confined DIRECT last-by-subject probe on the item's own
 *  subject (an acked item has LEFT the WorkQueue; an in-flight one remains readable). ONLY the
 *  broker's no-message result is absence; every other failure is `unavailable`, never fabricated
 *  as "no live entry" (which would drive an incorrect re-enqueue). */
async function liveEntryExists(ctx: WorkPoolContext, ref: WorkItemRef): Promise<boolean> {
  try {
    return (await ctx.jsm.direct.getMessage(epwStreamName(ctx.space), { last_by_subj: workItemSubject(ctx.space, ref) })) !== null;
  } catch (e) {
    if (isNoMessage(e)) return false;
    throw new EpEnvelopeError("unavailable", `the reconciliation liveness probe failed (a failed observation is never absence, SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
  }
}
