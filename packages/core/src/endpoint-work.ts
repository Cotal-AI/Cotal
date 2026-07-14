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
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { canonicalJson, rawDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epwSubject, epfSubject, assertBoundedOwner, assertLifecycleToken, type EpCaller } from "./endpoint-subjects.js";
import { RECORD_KINDS, recordSpecKey, createRecordEntry, updateRecordEntry, openRecordsBucket } from "./endpoint-records.js";
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

/** A trusted, space-bonded work-pool context: the KV + JS + JSM are all DERIVED from one
 *  binding-layer connection and one space by the constructor (never injected independently), so
 *  a caller can never check a space-A lease against space-B facts. Every seam takes this
 *  context. */
export interface WorkPoolContext {
  kv: KV;
  js: JetStreamClient;
  jsm: JetStreamManager;
  space: string;
}

/** Bond the resources to one space by CONSTRUCTION: the JetStream client, the manager, and the
 *  records KV (the space's own bucket) all derive from the ONE connection passed in — four
 *  already-separated resources are not accepted, so the advertised bond is real, not asserted.
 *  The returned context is FROZEN (no later swap) and BRANDED: every seam accepts only a
 *  context this constructor built, so a hand-assembled structural look-alike (the cross-space
 *  mixup the bond exists to prevent) is rejected at the consuming boundary. */
export async function workPoolContext(nc: NatsConnection, space: string): Promise<WorkPoolContext> {
  if (nc === null || typeof nc !== "object" || typeof (nc as unknown as { close?: unknown }).close !== "function")
    throw new EpEnvelopeError("failed-precondition", "a work-pool context is constructed from ONE binding-layer connection; separate resources are never accepted (SPEC 13.4)");
  if (typeof space !== "string" || space.length === 0) throw new EpEnvelopeError("failed-precondition", "a work-pool context needs a space");
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, space);
  const ctx = Object.freeze({ kv, js, jsm, space });
  BRANDED_CONTEXTS.add(ctx);
  return ctx;
}

const BRANDED_CONTEXTS = new WeakSet<WorkPoolContext>();

function assertCtx(ctx: WorkPoolContext): void {
  if (!BRANDED_CONTEXTS.has(ctx))
    throw new EpEnvelopeError("failed-precondition", `the work-pool context was not constructed by workPoolContext(); a hand-assembled resource bundle never authorizes - the space bond is constructed, not asserted (SPEC 13.4)`);
}

/** Snapshot the item ref to a validated, DETACHED copy at seam entry, BEFORE the first await:
 *  a caller-shared mutable ref can otherwise split one operation's identity across its lease
 *  CAS and its terminal publish (settle item A, publish item B). Every seam works only on
 *  this copy. */
function snapshotRef(ref: WorkItemRef): WorkItemRef {
  // Every property is READ EXACTLY ONCE: a getter answering differently between a validation
  // read and a copy read must not split what was checked from what is used.
  if (ref === null || typeof ref !== "object")
    throw new EpEnvelopeError("failed-precondition", `a work-item ref must carry string endpoint/pool and a full acceptance identity (SPEC 13.2)`);
  const endpoint = ref.endpoint;
  const pool = ref.pool;
  const a = ref.acceptance;
  if (typeof endpoint !== "string" || typeof pool !== "string" || a === null || typeof a !== "object")
    throw new EpEnvelopeError("failed-precondition", `a work-item ref must carry string endpoint/pool and a full acceptance identity (SPEC 13.2)`);
  const owner = a.owner;
  const actor = a.actor;
  const uid = a.uid;
  const id = a.id;
  if (typeof owner !== "string" || typeof actor !== "string" || typeof uid !== "string" || typeof id !== "string")
    throw new EpEnvelopeError("failed-precondition", `a work-item ref must carry string endpoint/pool and a full acceptance identity (SPEC 13.2)`);
  return { endpoint, pool, acceptance: { owner, actor, uid, id } };
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

/** Execution coordinates (sourceSeq/attempt/fencingToken) are POSITIVE at issue, parse, and
 *  commit — symmetrically. Zero is reserved for the worker-less never-leased expiry sentinel;
 *  admitting it anywhere else would durably poison the terminal rail (parseTerminal refuses
 *  zero coordinates, so a zero-coordinate settle could never be projected). */
function assertPositiveInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a positive safe integer; got ${JSON.stringify(v)} (SPEC 13.5)`);
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
  itemRef: WorkItemRef,
  itemBytes: Uint8Array,
): Promise<{ enqueued: boolean; seq?: number }> {
  assertCtx(ctx);
  const ref = snapshotRef(itemRef);
  if (!(itemBytes instanceof Uint8Array))
    throw new EpEnvelopeError("failed-precondition", `itemBytes must be a Uint8Array (the acceptance-derived stored bytes, SPEC 13.6)`);
  const bytes = new Uint8Array(itemBytes); // real copy detached at entry: the published body and the CAS-loss identity check read the SAME bytes. NOT .slice() — a Node Buffer (Buffer extends Uint8Array, so it passes the guard above) .slice()s to an ALIASING view, which a caller mutating itemBytes during the publish await would still corrupt; new Uint8Array(...) always copies into a fresh ArrayBuffer.
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  const subject = workItemSubject(ctx.space, ref);
  try {
    const pa = await ctx.js.publish(subject, bytes, { headers: h });
    return { enqueued: true, seq: pa.seq };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    // A prior enqueue exists (or existed and was consumed). If a live entry remains, verify its
    // bytes match; a consumed-and-gone entry (no message) is a settled/in-flight item the caller
    // reconciles, not a mismatch.
    let stored;
    // LEADER-SERVED STREAM.MSG.GET, never a follower Direct Get (SPEC 13.6:1797-1799): this read
    // gates the enqueue decision (a stale follower miss would re-arm settled work), so it is a
    // fencing read and must go to the stream leader that just rejected the CAS — read-your-writes.
    try { stored = await ctx.jsm.streams.getMessage(epwStreamName(ctx.space), { last_by_subj: subject }); }
    catch (ge) { if (isNoMessage(ge)) return { enqueued: false }; throw new EpEnvelopeError("unavailable", `the enqueue CAS lost and the stored item is not readable to verify identity (SPEC 13.6): ${(ge as Error)?.message ?? String(ge)}`); }
    if (stored !== null && rawDigest(stored.data) !== rawDigest(bytes)) // the DETACHED bytes, the ones actually published — not the caller-owned itemBytes a mutation could have changed during the publish await
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

/** Detach + validate a caller-supplied worker at seam entry, reading each property EXACTLY
 *  ONCE (single-read: a getter answering differently between a validation read and a
 *  construction read must not split the principal that was checked from the one persisted). */
function assertWorker(w: WorkWorker, what: string): WorkWorker {
  const kind = w.kind;
  const owner = w.owner;
  const actor = w.actor;
  const lifecycleUid = w.lifecycleUid;
  assertBoundedOwner(owner, `${what} owner`);
  assertBoundedOwner(actor, `${what} actor`);
  assertLifecycleToken(lifecycleUid, `${what} lifecycleUid`);
  if (kind === "endpoint") {
    const epoch = w.epoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      throw new EpEnvelopeError("failed-precondition", `${what} is an endpoint worker but carries no valid epoch; an endpoint worker's process epoch is its fence (SPEC 13.8)`);
    return Object.freeze({ kind: "endpoint", owner, actor, lifecycleUid, epoch });
  }
  if (kind !== "agent")
    throw new EpEnvelopeError("failed-precondition", `${what} has an unknown worker kind; a worker is "agent" or "endpoint" (SPEC 13.5)`);
  return Object.freeze({ kind: "agent", owner, actor, lifecycleUid });
}

function assertClosedKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      throw new EpEnvelopeError("internal", `${what} carries unknown field ${JSON.stringify(k)}; a closed schema admits no extras - garbled state never authorizes (SPEC 13.4)`);
}

function parseWorker(raw: unknown, key: string): WorkWorker {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `lease record ${key} carries a non-object worker; garbled mediated lease state never authorizes (SPEC 13.5)`);
  const w = raw as Record<string, unknown>;
  if (typeof w.owner !== "string" || typeof w.actor !== "string" || typeof w.lifecycleUid !== "string" || (w.kind !== "agent" && w.kind !== "endpoint"))
    throw new EpEnvelopeError("internal", `lease record ${key} worker is missing its kind/principal/lifecycle binding; garbled state never authorizes (SPEC 13.5)`);
  if (w.kind === "endpoint" && (typeof w.epoch !== "number" || !Number.isSafeInteger(w.epoch) || w.epoch < 0))
    throw new EpEnvelopeError("internal", `lease record ${key} endpoint worker has no valid epoch; garbled state never authorizes (SPEC 13.5)`);
  assertClosedKeys(w, w.kind === "endpoint" ? ["kind", "owner", "actor", "lifecycleUid", "epoch"] : ["kind", "owner", "actor", "lifecycleUid"], `worker on ${key}`);
  return w.kind === "endpoint"
    ? { kind: "endpoint", owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid, epoch: w.epoch as number }
    : { kind: "agent", owner: w.owner, actor: w.actor, lifecycleUid: w.lifecycleUid };
}

function sameWorker(a: WorkWorker | undefined, b: WorkWorker | undefined): boolean {
  if (a === undefined || b === undefined) return false;
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
  /** Present for `leased` and `settled:committed` (and kept on a leased-then-expired
   *  settlement); ABSENT only for the NEVER-LEASED `settled:expired` sentinel (reconciliation
   *  settled a dead item that was accepted+enqueued but never leased). */
  worker?: WorkWorker;
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

/** Closed per-state/per-disposition validation (§13.4/§13.5): a `leased` lease MUST carry a
 *  worker + positive attempt/sourceSeq and NO settlement fields; a `settled:committed` MUST
 *  carry a worker + a present `outcome` + committedTs + positive execution coordinates (its
 *  terminal fact derives from them); a `settled:expired` carries committedTs, KEEPS its worker
 *  when it was ever leased (worker-less = the never-leased sentinel), and never an outcome.
 *  Unknown fields and garbled cross-variant state never authorize. */
function parseLease(raw: unknown, key: string): WorkLease {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `lease record ${key} is not an object; garbled mediated lease state never authorizes (SPEC 13.5)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || (o.state !== "leased" && o.state !== "settled"))
    throw new EpEnvelopeError("internal", `lease record ${key} has an unknown version/state; garbled state never authorizes (SPEC 13.5)`);
  assertClosedKeys(o, ["v", "state", "sourceSeq", "attempt", "worker", "fencingToken", "leaseDeadline", "workExpiry", "disposition", "outcome", "committedTs"], `lease record ${key}`);
  for (const [name, v] of [["sourceSeq", o.sourceSeq], ["attempt", o.attempt], ["fencingToken", o.fencingToken], ["leaseDeadline", o.leaseDeadline], ["workExpiry", o.workExpiry]] as const)
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new EpEnvelopeError("internal", `lease record ${key} field ${name} is not a safe integer; garbled state never authorizes (SPEC 13.5)`);
  const committed = o.state === "settled" && o.disposition === "committed";
  const expired = o.state === "settled" && o.disposition === "expired";
  if (o.state === "settled" && !committed && !expired)
    throw new EpEnvelopeError("internal", `settled lease record ${key} has no valid disposition; garbled state never authorizes (SPEC 13.5)`);
  if (o.state === "leased" && (o.disposition !== undefined || o.outcome !== undefined || o.committedTs !== undefined))
    throw new EpEnvelopeError("internal", `leased lease record ${key} carries settlement fields; garbled cross-variant state never authorizes (SPEC 13.5)`);
  if (expired && o.outcome !== undefined)
    throw new EpEnvelopeError("internal", `expired lease record ${key} carries an outcome; garbled cross-variant state never authorizes (SPEC 13.5)`);
  const needsWorker = o.state === "leased" || committed;
  // An EXECUTED coordinate set (any record that carries a worker, including a worker-bearing
  // expired record) is positive across ALL THREE coordinates; only the worker-less never-leased
  // expiry sentinel may carry zeros.
  const executed = needsWorker || o.worker !== undefined;
  if (executed && ((o.attempt as number) < 1 || (o.sourceSeq as number) < 1 || (o.fencingToken as number) < 1))
    throw new EpEnvelopeError("internal", `lease record ${key} is ${o.state}/${String(o.disposition ?? "")} with zero execution coordinates (attempt/sourceSeq/fencingToken); garbled state never authorizes (SPEC 13.5)`);
  if (committed && !("outcome" in o))
    throw new EpEnvelopeError("internal", `committed lease record ${key} carries no outcome; garbled state never authorizes (SPEC 13.5)`);
  if (o.state === "settled" && (typeof o.committedTs !== "number" || !Number.isSafeInteger(o.committedTs) || o.committedTs < 0))
    throw new EpEnvelopeError("internal", `settled lease record ${key} has no valid committedTs; garbled state never authorizes (SPEC 13.5)`);
  const worker = needsWorker || o.worker !== undefined ? parseWorker(o.worker, key) : undefined;
  return {
    v: 1, state: o.state, sourceSeq: o.sourceSeq as number, attempt: o.attempt as number,
    ...(worker !== undefined ? { worker } : {}),
    fencingToken: o.fencingToken as number,
    leaseDeadline: o.leaseDeadline as number, workExpiry: o.workExpiry as number,
    ...(o.state === "settled" ? { disposition: o.disposition as "committed" | "expired", outcome: o.outcome, committedTs: o.committedTs as number } : {}),
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
  assertCtx(ctx);
  // Snapshot the FULL operation input to detached, validated locals at entry, BEFORE the first
  // await; nothing below reads args again (a live args object mutated across an await must not
  // move any coordinate mid-seam).
  const ref = snapshotRef(args.ref);
  const worker = assertWorker(args.worker, "lease worker");
  const sourceSeq = assertPositiveInt(args.sourceSeq, "sourceSeq"); // positive at ISSUE: a zero here would create a lease parseLease refuses forever
  const now = assertSafeInt(args.now, "now");
  const workExpiry = assertSafeInt(args.workExpiry, "workExpiry");
  const attempt = args.attempt;
  const leaseTtlMs = args.leaseTtlMs;
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new EpEnvelopeError("failed-precondition", `attempt must be a positive delivery count; got ${JSON.stringify(attempt)} (SPEC 13.5)`);
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0)
    throw new EpEnvelopeError("failed-precondition", `leaseTtlMs must be a positive integer; got ${JSON.stringify(leaseTtlMs)}`);
  if (now >= workExpiry)
    throw new EpEnvelopeError("expired", `the item's workExpiry (${workExpiry}) has passed at the owner clock (${now}); expired work is settled by reconciliation, never leased (SPEC 13.6/13.8)`);
  const leaseDeadline = Math.min(now + leaseTtlMs, workExpiry); // no valid lease outlives the horizon
  const key = leaseKeyOf(ref);
  for (let pass = 0; pass < 2; pass++) {
    const entry = await ctx.kv.get(key);
    if (!entry || entry.operation !== "PUT") {
      if (entry && entry.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `the lease record ${key} carries a ${entry.operation} marker; a deletion never resets an authoritative lease (SPEC 13.5)`);
      const lease: WorkLease = { v: 1, state: "leased", sourceSeq, attempt, worker, fencingToken: 1, leaseDeadline, workExpiry };
      try { await createRecordEntry(ctx.kv, key, lease); return lease; }
      catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
    }
    const stored = parseLease(decodeJson(entry.value, key), key);
    // Settlement DOMINATES every binding check: a never-leased expired settlement carries
    // sentinel coordinates (sourceSeq 0), so binding refusals on a settled item would mislead.
    if (stored.state === "settled")
      throw new EpEnvelopeError("failed-precondition", `the item is already settled ${stored.disposition}; a committed item can never be leased again — observe the terminal and ack the redelivery without effect (SPEC 13.5/13.6)`);
    if (stored.sourceSeq !== sourceSeq)
      throw new EpEnvelopeError("conflict", `the lease for this acceptance identity binds stream sequence ${stored.sourceSeq}, not ${sourceSeq}; a request id becomes new work only after workExpiry AND fact retention pass (SPEC 13.8)`);
    // `workExpiry` is IDENTITY-BOUND: it is set once from the AcceptanceFact and every later
    // lease call for the same execution MUST carry the SAME horizon (a redelivery cannot extend
    // or shorten the absolute work expiry, SPEC 13.8).
    if (stored.workExpiry !== workExpiry)
      throw new EpEnvelopeError("conflict", `the lease binds workExpiry ${stored.workExpiry} but this call supplies ${workExpiry}; the absolute work horizon is fixed at acceptance and never re-set (SPEC 13.8)`);
    if (stored.attempt === attempt) return stored; // first-wins: the still-current attempt's lease, verbatim
    if (stored.attempt > attempt)
      throw new EpEnvelopeError("expired", `attempt ${attempt} is superseded: redelivery advanced this item to attempt ${stored.attempt} (SPEC 13.5)`);
    const next: WorkLease = { v: 1, state: "leased", sourceSeq, attempt, worker, fencingToken: stored.fencingToken + 1, leaseDeadline, workExpiry };
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
  if (!cr || typeof cr !== "object" || cr.owner !== ref.acceptance.owner || cr.actor !== ref.acceptance.actor || cr.uid !== ref.acceptance.uid || cr.id !== ref.acceptance.id)
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} carries a caller identity other than its subject's acceptance identity (SPEC 13.4)`);
  assertClosedKeys(cr, ["owner", "actor", "uid", "id"], `terminal-fact caller on ${subject}`);
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0)
    throw new EpEnvelopeError("internal", `work terminal fact on ${subject} has no valid ts (SPEC 13.6)`);
  if (o.disposition === "committed") {
    assertClosedKeys(o, ["v", "disposition", "pool", "caller", "sourceSeq", "attempt", "fencingToken", "worker", "outcome", "ts"], `committed terminal fact on ${subject}`);
    for (const [n, v] of [["sourceSeq", o.sourceSeq], ["attempt", o.attempt], ["fencingToken", o.fencingToken]] as const)
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
        throw new EpEnvelopeError("internal", `committed terminal fact on ${subject} field ${n} is not a positive safe integer; a committed item was delivered and fenced (SPEC 13.6)`);
    if (!("outcome" in o))
      throw new EpEnvelopeError("internal", `committed terminal fact on ${subject} carries no outcome; garbled state never authorizes (SPEC 13.6)`);
    return {
      v: 1, disposition: "committed", pool: ref.pool, caller: ref.acceptance,
      sourceSeq: o.sourceSeq as number, attempt: o.attempt as number, fencingToken: o.fencingToken as number,
      worker: parseWorker(o.worker, subject), outcome: o.outcome, ts: o.ts,
    };
  }
  assertClosedKeys(o, ["v", "disposition", "pool", "caller", "workExpiry", "ts"], `expired terminal fact on ${subject}`);
  if (typeof o.workExpiry !== "number" || !Number.isSafeInteger(o.workExpiry) || o.workExpiry < 0)
    throw new EpEnvelopeError("internal", `expired terminal fact on ${subject} has no valid workExpiry (SPEC 13.6)`);
  return { v: 1, disposition: "expired", pool: ref.pool, caller: ref.acceptance, workExpiry: o.workExpiry, ts: o.ts };
}

/** Read the item's cached terminal state (leader-served last-by-subject: the CAS-loser read
 *  needs read-your-writes, §13.4). `undefined` when the item has no terminal yet. */
export async function readWorkTerminal(ctx: WorkPoolContext, itemRef: WorkItemRef): Promise<WorkTerminalFact | undefined> {
  assertCtx(ctx);
  const ref = snapshotRef(itemRef);
  const subject = workTerminalSubject(ctx.space, ref);
  const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
  return raw === undefined ? undefined : parseTerminal(raw, subject, ref);
}

/** Build the terminal fact a settled lease derives. */
function terminalOf(ref: WorkItemRef, lease: WorkLease): WorkTerminalFact {
  if (lease.disposition === "committed") {
    if (lease.worker === undefined || lease.committedTs === undefined)
      throw new EpEnvelopeError("internal", `a committed lease for ${ref.acceptance.id} is missing its worker/committedTs; garbled state never authorizes (SPEC 13.5)`);
    return { v: 1, disposition: "committed", pool: ref.pool, caller: ref.acceptance, sourceSeq: lease.sourceSeq, attempt: lease.attempt, fencingToken: lease.fencingToken, worker: lease.worker, outcome: lease.outcome, ts: lease.committedTs };
  }
  return { v: 1, disposition: "expired", pool: ref.pool, caller: ref.acceptance, workExpiry: lease.workExpiry, ts: lease.committedTs ?? 0 };
}

/** Publish a settled lease's terminal fact create-only. A lost CAS reads the winner and PROVES
 *  it canonically equals the fact this caller derived from the authoritative settled lease —
 *  every legitimate publisher derives from that same lease, so a mismatch is a foreign/garbled
 *  write and fails loud instead of being returned as "the winner". */
async function publishTerminal(ctx: WorkPoolContext, ref: WorkItemRef, fact: WorkTerminalFact): Promise<{ won: boolean; fact: WorkTerminalFact }> {
  const subject = workTerminalSubject(ctx.space, ref);
  const res = await publishCreateOnly(ctx.js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  if (res.won) return { won: true, fact };
  const winner = await readWorkTerminal(ctx, ref);
  if (winner === undefined)
    throw new EpEnvelopeError("internal", `the terminal CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
  if (canonicalJson(winner) !== canonicalJson(fact))
    throw new EpEnvelopeError("internal", `the terminal CAS winner on ${subject} does not match the fact derived from the authoritative settled lease; a foreign/garbled terminal never authorizes (SPEC 13.4)`);
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
    /** OWNER-CONTROLLED budget on the resolver await (default 5000ms): a stuck lifecycle
     *  authority is a bounded `unavailable` refusal, never a hung commit. */
    epochResolveBudgetMs?: number;
  },
): Promise<{ won: boolean; fact: WorkTerminalFact }> {
  assertCtx(ctx);
  // Snapshot EVERY operation input at entry, BEFORE the first await: a caller-shared mutable
  // ref/tuple/outcome/clock/resolver can otherwise split one commit's identity across the lease
  // CAS and the terminal publish (settle item A, publish item B) or move the validated clock.
  const ref = snapshotRef(args.ref);
  // Read the lease reference ONCE into a local, then validate/copy its fields from that one
  // reference: a shifting `args.lease` getter must not splice three separately-read fields into
  // a composite tuple no single input ever carried.
  const leaseArg = args.lease;
  const tuple = {
    sourceSeq: assertPositiveInt(leaseArg?.sourceSeq, "lease.sourceSeq"),
    attempt: assertPositiveInt(leaseArg?.attempt, "lease.attempt"),
    fencingToken: assertPositiveInt(leaseArg?.fencingToken, "lease.fencingToken"),
  };
  const outcomeSnapshot: unknown = JSON.parse(canonicalJson(args.outcome === undefined ? null : args.outcome));
  const now = assertSafeInt(args.now, "now");
  const caller = assertWorker(args.caller, "commit caller");
  const resolveCurrentEpoch = args.resolveCurrentEpoch;
  const epochResolveBudgetMs = args.epochResolveBudgetMs;
  const key = leaseKeyOf(ref);
  const entry = await ctx.kv.get(key);
  if (!entry || entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `no lease is recorded for this item (${key}); a commit settles only owner-assigned work (SPEC 13.5)`);
  const stored = parseLease(decodeJson(entry.value, key), key);

  // A DUPLICATE (same worker, same lease tuple) always observes its cached terminal — the cache
  // lookup DOMINATES lease-expiry, so a slow-but-legitimate retry after its own commit never
  // sees `expired` (§13.5:1517-1519). A stale/foreign caller does NOT get here (identity + tuple
  // must match the settled lease).
  if (stored.state === "settled") {
    const dup = stored.sourceSeq === tuple.sourceSeq && stored.attempt === tuple.attempt
      && stored.fencingToken === tuple.fencingToken && sameWorker(stored.worker, caller);
    if (dup) return publishTerminal(ctx, ref, terminalOf(ref, stored)); // idempotent republish; won:false once it already exists
    throw new EpEnvelopeError("conflict", `the item is already settled ${stored.disposition} under a different attempt/worker; this commit is superseded (SPEC 13.5)`);
  }

  // parseLease guarantees a `leased` record carries its worker; narrow for the checks below.
  const bound = stored.worker;
  if (bound === undefined)
    throw new EpEnvelopeError("internal", `leased record ${key} has no worker; garbled state never authorizes (SPEC 13.5)`);
  if (stored.sourceSeq !== tuple.sourceSeq)
    throw new EpEnvelopeError("expired", `the commit names stream sequence ${tuple.sourceSeq} but the lease binds ${stored.sourceSeq}; a stale execution binding never settles (SPEC 13.5)`);
  if (stored.attempt !== tuple.attempt || stored.fencingToken !== tuple.fencingToken)
    throw new EpEnvelopeError("expired", `stale fencing: the commit carries (attempt ${tuple.attempt}, token ${tuple.fencingToken}) but the lease is (attempt ${stored.attempt}, token ${stored.fencingToken}) (SPEC 13.5)`);
  if (!sameWorker(bound, caller))
    throw new EpEnvelopeError("permission-denied", `the commit caller is not the lease's bound worker (${bound.owner}.${bound.actor}/${bound.lifecycleUid}); the binding is owner-recorded at assignment (SPEC 13.5)`);
  // FRESH lifecycle/epoch currency for an endpoint worker (§13.8): a superseded process cannot
  // settle its predecessor's lease.
  if (bound.kind === "endpoint") {
    if (typeof resolveCurrentEpoch !== "function")
      throw new EpEnvelopeError("failed-precondition", `committing an endpoint worker's item requires a fresh-epoch resolver (SPEC 13.8: lifecycle/epoch currency is validated at the commit boundary)`);
    const budget = epochResolveBudgetMs ?? 5_000;
    if (!Number.isSafeInteger(budget) || budget <= 0)
      throw new EpEnvelopeError("failed-precondition", `epochResolveBudgetMs must be a positive integer; got ${JSON.stringify(epochResolveBudgetMs)}`);
    const current = await resolveWithBudget(resolveCurrentEpoch(bound), budget);
    if (current !== null && (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0))
      throw new EpEnvelopeError("internal", `the fresh-epoch resolver returned ${JSON.stringify(current)}; a non-integer epoch never authorizes (SPEC 13.8)`);
    if (current === null)
      throw new EpEnvelopeError("expired", `the endpoint worker's lifecycle is retired/unknown; a retired worker cannot commit (SPEC 13.8)`);
    if (current !== bound.epoch)
      throw new EpEnvelopeError("expired", `the endpoint worker's lease bound epoch ${bound.epoch} but the current process epoch is ${current}; a superseded process cannot settle (SPEC 13.8)`);
  }
  if (now >= stored.workExpiry)
    throw new EpEnvelopeError("expired", `the item's workExpiry (${stored.workExpiry}) has passed at the owner clock (${now}); the item is dead, leased or not (SPEC 13.8)`);
  if (now >= stored.leaseDeadline)
    throw new EpEnvelopeError("expired", `the lease expired at ${stored.leaseDeadline} (owner clock ${now}); expiry revokes the claim AT that deadline (SPEC 13.5)`);

  // THE FENCE: advance the lease to settled on its OWN revision. A concurrent redelivery-advance
  // or expiry-settle contends on this exact revision; the loser re-reads and re-decides.
  const settled: WorkLease = { ...stored, state: "settled", disposition: "committed", outcome: outcomeSnapshot, committedTs: now };
  try {
    await updateRecordEntry(ctx.kv, key, settled, entry.revision);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const now2 = parseLease(decodeJson((await ctx.kv.get(key))!.value, key), key);
    if (now2.state === "settled" && now2.sourceSeq === tuple.sourceSeq && now2.attempt === tuple.attempt && sameWorker(now2.worker, caller))
      return publishTerminal(ctx, ref, terminalOf(ref, now2)); // our own settle raced in; idempotent
    if (now2.state === "settled")
      throw new EpEnvelopeError("conflict", `the item settled ${now2.disposition} concurrently under a different attempt/worker; this commit is superseded (SPEC 13.5)`);
    throw new EpEnvelopeError("expired", `a concurrent redelivery advanced the lease to attempt ${now2.attempt}; this commit is superseded (SPEC 13.5)`);
  }
  return publishTerminal(ctx, ref, terminalOf(ref, settled));
}

/** Bound the fresh-epoch resolver await: past the budget the commit REFUSES `unavailable`
 *  (fail-closed, retryable) instead of hanging on a stuck lifecycle authority. */
async function resolveWithBudget(p: Promise<number | null> | number | null, budgetMs: number): Promise<number | null> {
  // race Promise.resolve(p) UNCONDITIONALLY: a non-native/cross-realm thenable is not an
  // `instanceof Promise`, and returning it directly would await it unbounded.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `the fresh-epoch resolver did not answer within ${budgetMs}ms; a stuck lifecycle authority is a bounded refusal, never a hung commit (SPEC 13.8)`)), budgetMs);
  });
  try { return await Promise.race([Promise.resolve(p), deadline]); } finally { clearTimeout(timer); }
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
 *      publish the derived terminal → EXPIRED-SETTLED; with no lease record, a worker-less
 *      `settled:expired` lease is CAS-CREATED on the same key first, so a racing FIRST lease
 *      contends there instead of assigning dead work behind the expiry;
 *   4. a live pool entry exists (subject-confined LEADER-SERVED STREAM.MSG.GET, §13.6:1797-1799 —
 *      a fencing read whose stale follower miss would re-arm settled work) → LIVE;
 *   5. else re-check the terminal (a commit may have landed since step 1), then re-enqueue the
 *      SAME acceptance-derived bytes create-only — the ONLY re-enqueueable state.
 *  Fail-closed preconditions: a DEL/PURGE marker on the lease REFUSES before any classification
 *  (reconciling over a deletion could recreate authoritative state), and whenever a lease record
 *  exists the caller-supplied `workExpiry` must EQUAL the persisted horizon (§13.8) — a mis-wired
 *  reconciliation never expires a live lease against a foreign horizon. */
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
  assertCtx(ctx);
  // Snapshot the FULL operation input at entry (ref, clock, horizon, and a DETACHED copy of the
  // item bytes): nothing below reads args again, so a mid-flight mutation cannot re-enqueue
  // different bytes or move the horizon between classification and repair.
  const ref = snapshotRef(args.ref);
  const now = assertSafeInt(args.now, "now");
  const workExpiry = assertSafeInt(args.workExpiry, "workExpiry");
  if (!(args.itemBytes instanceof Uint8Array))
    throw new EpEnvelopeError("failed-precondition", `itemBytes must be a Uint8Array (the acceptance-derived stored bytes, SPEC 13.6)`);
  const itemBytes = new Uint8Array(args.itemBytes); // real copy (NOT .slice(): a Node Buffer aliases through .slice(), defeating the detachment; new Uint8Array(...) always copies)
  const key = leaseKeyOf(ref);
  // A DEL/PURGE marker on the lease is REFUSED before any classification (same fail-closed rule
  // as lease/commit): reconciling over a deletion could recreate authoritative state.
  const readLease = (entry: Awaited<ReturnType<KV["get"]>>): WorkLease | undefined => {
    if (!entry) return undefined;
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the lease record ${key} carries a ${entry.operation} marker; a deletion never resets an authoritative lease - reconcile the store (SPEC 13.5)`);
    const rec = parseLease(decodeJson(entry.value, key), key);
    // The horizon is IDENTITY-BOUND (§13.8): whenever a record exists, the caller-supplied
    // workExpiry must equal the persisted one before ANY classification - a mis-wired
    // reconciliation must not expire a live lease early (or late) against a foreign horizon.
    if (rec.workExpiry !== workExpiry)
      throw new EpEnvelopeError("conflict", `the lease binds workExpiry ${rec.workExpiry} but this reconcile supplies ${workExpiry}; the absolute work horizon is fixed at acceptance and never re-set (SPEC 13.8)`);
    return rec;
  };
  const terminal = await readWorkTerminal(ctx, ref);
  if (terminal !== undefined) return { state: terminal.disposition === "expired" ? "expired-settled" : "settled", fact: terminal };

  const leaseEntry = await ctx.kv.get(key);
  const lease = readLease(leaseEntry);

  // (2) a commit fenced the lease but may have crashed before publishing — finalize its terminal.
  if (lease?.state === "settled") {
    const pub = await publishTerminal(ctx, ref, terminalOf(ref, lease));
    return { state: pub.fact.disposition === "expired" ? "expired-settled" : "settled", fact: pub.fact };
  }

  // (3) dead item: the LEASE KEY is the arbiter either way. With a lease, CAS-settle it expired
  // on its revision (a live commit contends on the SAME key); with NO lease, CAS-CREATE a
  // worker-less settled:expired record create-only, so a racing FIRST lease loses its create and
  // observes the settlement instead of assigning dead work. Only a settled lease derives the
  // terminal — the EPF fact never leads the lease.
  if (now >= workExpiry) {
    for (let pass = 0; pass < 2; pass++) {
      const entry = pass === 0 ? leaseEntry : await ctx.kv.get(key);
      const cur = readLease(entry);
      if (cur?.state === "settled") { // a commit/expiry won; finalize the winner's terminal
        const pub = await publishTerminal(ctx, ref, terminalOf(ref, cur));
        return { state: pub.fact.disposition === "expired" ? "expired-settled" : "settled", fact: pub.fact };
      }
      const settledExpired: WorkLease = cur !== undefined
        ? { ...cur, state: "settled", disposition: "expired", committedTs: now }
        : { v: 1, state: "settled", sourceSeq: 0, attempt: 0, fencingToken: 0, leaseDeadline: workExpiry, workExpiry, disposition: "expired", committedTs: now };
      try {
        if (cur !== undefined) await updateRecordEntry(ctx.kv, key, settledExpired, entry!.revision);
        else await createRecordEntry(ctx.kv, key, settledExpired);
      } catch (e) {
        if (e instanceof EpEnvelopeError && e.code === "conflict") continue; // a lease/commit raced in on the same key; re-read and re-decide
        throw e;
      }
      const pub = await publishTerminal(ctx, ref, terminalOf(ref, settledExpired));
      return { state: "expired-settled", fact: pub.fact };
    }
    throw new EpEnvelopeError("conflict", `the lease record ${key} moved twice during one reconcile; re-read and re-decide (SPEC 13.8)`);
  }

  if (await liveEntryExists(ctx, ref)) return { state: "live" };
  // (5) re-check the terminal (a commit may have landed during the live probe) before re-enqueue.
  const late = await readWorkTerminal(ctx, ref);
  if (late !== undefined) return { state: late.disposition === "expired" ? "expired-settled" : "settled", fact: late };
  const re = await enqueueWorkItem(ctx, ref, itemBytes);
  if (!re.enqueued) {
    if (await liveEntryExists(ctx, ref)) return { state: "live" };
    const after = await readWorkTerminal(ctx, ref);
    if (after !== undefined) return { state: after.disposition === "expired" ? "expired-settled" : "settled", fact: after };
    throw new EpEnvelopeError("failed-precondition", `the item is not settled, not expired, not live, and its create-only re-enqueue is refused by the stream's per-subject history; needs operator reconciliation (SPEC 13.6)`);
  }
  return { state: "re-enqueued", seq: re.seq! };
}

/** The §13.6 liveness read: the subject-confined LEADER-SERVED last-by-subject probe on the
 *  item's own subject (an acked item has LEFT the WorkQueue; an in-flight one remains readable).
 *  STREAM.MSG.GET, never a follower Direct Get (SPEC 13.6:1797-1799): the result gates the
 *  re-enqueue decision, so a stale follower miss would re-arm settled work. ONLY the broker's
 *  no-message result is absence; every other failure is `unavailable`, never fabricated as "no
 *  live entry" (which would drive an incorrect re-enqueue). */
async function liveEntryExists(ctx: WorkPoolContext, ref: WorkItemRef): Promise<boolean> {
  try {
    return (await ctx.jsm.streams.getMessage(epwStreamName(ctx.space), { last_by_subj: workItemSubject(ctx.space, ref) })) !== null;
  } catch (e) {
    if (isNoMessage(e)) return false;
    throw new EpEnvelopeError("unavailable", `the reconciliation liveness probe failed (a failed observation is never absence, SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
  }
}
