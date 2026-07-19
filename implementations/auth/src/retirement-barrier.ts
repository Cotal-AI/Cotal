/**
 * The D13 (5) TERMINAL RETIREMENT BARRIER + the EXACT-POOL TERMINAL CLEANER (SPEC §13.1, as
 * amended; the §13.9 cleaner matrix row). The third sibling of `lifecycle-registry.ts` /
 * `credential-ledger.ts`: the SAME minting authority over the SAME stores, reached only through
 * the sealed registry ({@link registryStores}).
 *
 * The barrier, in the NORMATIVE order (§13.1) — every boundary crash-resumable from the durable
 * `stage.<opId>` intent, and only the SAME operation resumes it:
 *  1. durable retirement intent (create-only, captured BEFORE any movement; it carries the
 *     caller's endpoint/pool HINT and the frontier stream set — the barrier DISCOVERS the real
 *     cleaner inventory from the target's own accepted pool obligations, §13.1 #F);
 *  2. CAS the issuance gate `open → frozen` carrying the intent (the bar: a staged mint loses
 *     its finalize touch) — a retirement freeze NEVER reopens (§13.1: its only exit is the
 *     terminal);
 *  3. CAS the head `active → retiring` bound to the same op (every currency seam now yields no
 *     current mapping and no current epoch; the alias is NOT replaceable);
 *  4. the shared containment core ({@link containLifecycleFamily}): revoke every ledger row
 *     under `cred.<uid>.>`, reconcile both halves of every session-derived credential, and
 *     VERIFIED cluster-wide eviction of every holder principal + the alias principal;
 *  5. drain the target's acceptance obligations to quiescence (§13.8): enumerate
 *     `oblig.<targetUid>.>` for endpoint discovery, drive each endpoint's injected drain
 *     ({@link drainTargetForEndpoint} over that endpoint's mediator), then RE-ENUMERATE and
 *     verify — the barrier OWNS the quiescence check, never the injected seam; then, BEFORE
 *     anything else proceeds, fence the drain's per-op repair principals (the commit applier /
 *     pool-route reconciler / effects canceller, {@link drainRepairPrincipals}) with a
 *     cluster-verified eviction — the APPLIER especially, whose records-KV last-value write is
 *     visible to a normal reader regardless of the frontier cutoff (#4);
 *  6. the exact-pool terminal cleaner ({@link runExactPoolCleaner}) under a DISTINCT,
 *     separately minted, bounded-lived profile per (op × endpoint), then — BEFORE any frontier
 *     records — revoke the cleaner's own credential and cluster-verify eviction of its
 *     principal (the §13.1 cleaner fence: no in-flight cleaner can ACK a redelivery or write a
 *     terminal after the alias is reused);
 *  7. record the per-stream retirement frontiers (`frontier.<lifecycleUid>`, create-only,
 *     never deleted — the cutoffs that bound the predecessor's half-open interval);
 *  8. CAS the gate `frozen → retired` (terminal; unlike takeover, never reopened);
 *  9. CAS the head `retiring → retired` — only now is the alias replaceable, and `retired`
 *     ASSERTS the completed barrier.
 *
 * FAIL-CLOSED CONTRACT: any failure after the freeze leaves the gate FROZEN and the head at its
 * current containment state (nothing mints, the alias is not replaceable); eviction failure is
 * `unavailable`; a live, unexpired, FOREIGN-target pool item is never settled or ACKed and the
 * barrier refuses to close frontiers while one remains (§13.9).
 *
 * SURFACE: NOTHING here is exported from the package index (the same discipline as the
 * takeover barrier); production wiring lands with the activation slices. The executor seam is
 * the sealed registry; an `opId` is an identifier, never a bearer capability.
 */
import { AckPolicy, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError,
  RETIREMENT_FRONTIER,
  assertLifecycleToken,
  assertPoolToken,
  createRecordEntry,
  endpointToken,
  epfStreamName,
  epfSubject,
  epwSubject,
  epwStreamName,
  parseDecisionFact,
  parseWorkTerminalFact,
  poolConsumerConfig,
  poolDurable,
  readLastFact,
  recordAtomicKey,
  reconcileWorkItem,
  retireWorkItem,
  retirementFrontierStreams,
  workTerminalSubject,
  type WorkPoolContext,
  type WorkItemRef,
  type WorkTerminalFact,
} from "@cotal-ai/core";
import {
  registryStores,
  registryRecordsScanner,
  observeGate,
  freezeGate,
  retireGate,
  readLifecycleHeadForOperation,
  beginHeadRetirementWithinBarrier,
  completeHeadRetirementWithinBarrier,
  type LifecycleRegistry,
} from "./lifecycle-registry.js";
import {
  containLifecycleFamily,
  createRowByteIdempotent,
  stageIntentKey,
  type TakeoverDeps,
} from "./credential-ledger.js";
import { enumerateObligationRows } from "./admission-mediator.js";
import { drainRepairPrincipals } from "./drain-repair.js";

const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// ---- the durable retirement intent (stage.<opId>, the takeover intent's sibling) --------------

/** One endpoint's EXACT pool list for the cleaner step — the cleaner profile's grant is minted
 *  from these (§13.9: never a pool wildcard). A caller may HINT them on the intent; the barrier
 *  UNIONS the hint with the pools it discovers from the target's own accepted pool obligations
 *  (#F), so the actual cleaner inventory is always a superset of any hint. */
export interface RetirementPoolSpec {
  endpoint: string;
  pools: string[];
}

/** The durable retirement intent at `stage.<opId>` — captured BEFORE the freeze; every resumed
 *  step works from these SAME coordinates ({@link resumeAgentRetirement}). */
export interface RetirementIntent {
  kind: "retirement";
  lifecycleUid: string;
  owner: string;
  actor: string;
  /** The gate generation the barrier freezes at (a retirement freeze never reopens, so there is
   *  no successor generation — the gate terminalizes at this one). */
  fromGeneration: number;
  /** The caller's (endpoint × pools) HINT for the cleaner. The barrier unions it with the pools it
   *  discovers from the target's accepted pool obligations (#F), so an empty hint is valid — the
   *  discovery finds the real inventory (the auth-admin despawn rail passes `[]`). */
  endpoints: RetirementPoolSpec[];
  /** The streams whose last sequence the frontier step records (§13.1: the deployment's
   *  lifecycle-bounded streams). */
  frontierStreams: string[];
}

function assertPoolSpecs(v: unknown, what: string): RetirementPoolSpec[] {
  if (!Array.isArray(v)) throw new EpEnvelopeError("failed-precondition", `${what} must be an array of { endpoint, pools } (SPEC 13.1)`);
  for (const e of v) {
    if (!isRec(e) || Object.keys(e).some((k) => k !== "endpoint" && k !== "pools"))
      throw new EpEnvelopeError("failed-precondition", `${what} entries are closed { endpoint, pools } objects (SPEC 13.1)`);
    endpointToken(e.endpoint as string);
    if (!Array.isArray(e.pools) || e.pools.length === 0)
      throw new EpEnvelopeError("failed-precondition", `${what} entry for "${String(e.endpoint)}" must list at least one exact pool (an empty list belongs to no entry at all, SPEC 13.9)`);
    for (const p of e.pools) assertPoolToken(p as string);
  }
  return v as RetirementPoolSpec[];
}

function assertFrontierStreams(v: unknown, what: string, space: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.length === 0))
    throw new EpEnvelopeError("failed-precondition", `${what} must be an array of non-empty stream names (SPEC 13.1)`);
  // CLOSED set (SPEC 13.1): a frontier stream is a per-space lifecycle-data stream the barrier is
  // GRANTED STREAM.INFO for, never a caller-selected arbitrary name. An out-of-set entry would
  // permission-deny at the frontier step on a real broker and wedge the resume; refuse it up front.
  const allowed = new Set(retirementFrontierStreams(space));
  for (const s of v as string[])
    if (!allowed.has(s))
      throw new EpEnvelopeError("failed-precondition", `${what}: ${JSON.stringify(s)} is not a retirement frontier stream; only the per-space lifecycle-data streams (${[...allowed].join(", ")}) may be fenced (SPEC 13.1)`);
  return v as string[];
}

function parseRetirementIntent(raw: Uint8Array, key: string, space: string): RetirementIntent {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the operation intent ${key} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the operation intent ${key} is not an object`);
  const allowed = new Set(["kind", "lifecycleUid", "owner", "actor", "fromGeneration", "endpoints", "frontierStreams"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the operation intent ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (o.kind !== "retirement" || typeof o.lifecycleUid !== "string" || typeof o.owner !== "string" || o.owner.length === 0 ||
      typeof o.actor !== "string" || o.actor.length === 0 || !uint(o.fromGeneration) || o.fromGeneration < 1)
    throw new EpEnvelopeError("internal", `the operation intent ${key} does not validate as a retirement intent (SPEC 13.1)`);
  try {
    assertLifecycleToken(o.lifecycleUid);
    assertPoolSpecs(o.endpoints, `intent ${key} endpoints`);
    assertFrontierStreams(o.frontierStreams, `intent ${key} frontierStreams`, space);
  } catch (e) {
    throw new EpEnvelopeError("internal", `the operation intent ${key} carries malformed coordinates: ${(e as Error).message}`);
  }
  return o as unknown as RetirementIntent;
}

async function readRetirementIntent(authKv: KV, opId: string, space: string): Promise<RetirementIntent | undefined> {
  const key = stageIntentKey(opId);
  const entry = await authKv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the operation intent ${key} carries a ${entry.operation} marker; an intent is never deleted while resumable (corruption, SPEC 13.12)`);
  return parseRetirementIntent(entry.value, key, space);
}

// ---- the injected capabilities ----------------------------------------------------------------

/** The cleaner's bind: JS handles over the cleaner's OWN authenticated connection (the
 *  separately minted, bounded-lived, exact-pool profile — NEVER the executor's or the revoked
 *  owner's connection) plus the CONNZ-attributable principal of that connection, which the
 *  barrier verified-evicts at the cleaner fence. */
export interface PoolCleanerBind {
  jsm: JetStreamManager;
  js: JetStreamClient;
  principal: string;
}

/** The settlement executor's bind: a space-bonded {@link WorkPoolContext} DERIVED from the
 *  executor's OWN authenticated connection (the separately minted, op-bounded settlement
 *  profile, SPEC 13.9 "Retirement settlement"; never the cleaner's bind and never the barrier's
 *  standing connection, so the settlement rights and the settlement code sit on ONE connection)
 *  plus that connection's CONNZ-attributable principal, which the barrier verified-evicts at
 *  the fence alongside the cleaner's. */
export interface RetirementExecutorBind {
  work: WorkPoolContext;
  principal: string;
}

/** The retirement barrier's injected capabilities — the takeover deps plus the retirement-only
 *  seams. Every seam is deployment-owned mechanics; the barrier owns the ORDER and the
 *  verification. */
export interface RetirementDeps extends TakeoverDeps {
  /** Drive ONE endpoint's obligations under the retiring target to §13.8 quiescence (wire to
   *  `drainTargetForEndpoint` over that endpoint's admission mediator). `opId` is the barrier's
   *  own durable operation id: the drain's per-op repair credentials (the confined
   *  commit-applier and pool-route reconciler) mint under it, so their principals are
   *  op-attributable and op-bounded. The barrier re-checks
   *  quiescence itself afterward; a drain that lied fails the barrier, not the invariant. */
  drainTargetObligations: (endpoint: string, targetUid: string, opId: string) => Promise<void>;
  /** Mint + connect the DISTINCT bounded-lived cleaner profile for (op × endpoint), granted
   *  exactly the listed pools (§13.9 cleaner row). */
  openCleaner: (args: { opId: string; endpoint: string; pools: string[] }) => Promise<PoolCleanerBind>;
  /** Revoke the cleaner bind's credential (the deny-new half) and release its resources. The
   *  barrier then verified-evicts the bind's principal itself (the kill-live half). Called on
   *  BOTH the success and the failure path — a wedged barrier never leaves a live cleaner. */
  retireCleanerCredential: (bind: PoolCleanerBind) => Promise<void>;
  /** Mint + connect the DISTINCT bounded-lived settlement-executor profile for (op × endpoint),
   *  granted exactly the listed pools' settlement rows (§13.9 "Retirement settlement": the lease
   *  CAS + `wrk` terminal publish + the leader-served EPF/records fencing reads; NO EPW read, that
   *  live-entry probe is unreachable from the settlement path). The barrier builds the settlement
   *  seam over THIS bind's work context, never its own standing connection. */
  openExecutor: (args: { opId: string; endpoint: string; pools: string[] }) => Promise<RetirementExecutorBind>;
  /** Revoke the executor bind's credential (the deny-new half); the barrier verified-evicts its
   *  principal too. Same discipline as the cleaner: called on success AND failure paths. */
  retireExecutorCredential: (bind: RetirementExecutorBind) => Promise<void>;
  /** The executor's clock (the `workExpiry` comparisons and the terminal-fact timestamps). */
  now: () => number;
  /** Cleaner pacing knobs (tests tighten them; production defaults hold). */
  cleaner?: { fetchExpiresMs?: number; maxStalledPasses?: number };
}

// ---- the exact-pool terminal cleaner (§13.9 matrix row) ---------------------------------------

/** What one pool's cleaning pass settled. */
export interface PoolCleanResult {
  /** Messages ACKed because their item was ALREADY durably terminal. */
  ackedTerminal: number;
  /** Items this run settled `expired` (their own `workExpiry` passed). */
  settledExpired: number;
  /** Items this run settled `retired` (re-bound to the retiring target via their acceptance). */
  settledRetired: number;
}

/** Executor-authority settlement seam. The cleaner supplies only delivery identity/bytes and a
 *  requested disposition; the implementation is closed over the durable retirement intent and
 *  independently re-derives every authority coordinate before touching the lease. */
export type SettleRetirementPoolItem = (args: {
  ref: WorkItemRef;
  itemBytes: Uint8Array;
  disposition: "expired" | "retired";
}) => Promise<WorkTerminalFact>;

/** Rebuild-and-compare parse of a delivered EPW message subject against the bound pool: the
 *  trailing four tokens are the acceptance identity, and the rebuilt subject must equal the
 *  delivered one exactly (bijective — a truncated or foreign-family subject never settles). */
function itemRefOf(space: string, endpoint: string, pool: string, subject: string): WorkItemRef {
  const toks = subject.split(".");
  const tail = toks.slice(-4);
  const ref: WorkItemRef = { endpoint, pool, acceptance: { owner: tail[0], actor: tail[1], uid: tail[2], id: tail[3] } };
  let rebuilt: string;
  try {
    rebuilt = epwSubject(space, endpoint, pool, ref.acceptance);
  } catch (e) {
    throw new EpEnvelopeError("internal", `the delivered pool message ${subject} does not carry a valid acceptance identity: ${(e as Error).message} (SPEC 13.2)`);
  }
  if (rebuilt !== subject)
    throw new EpEnvelopeError("internal", `the delivered pool message ${subject} does not rebuild from the bound pool coordinates (${rebuilt}); the durable's filter proof does not cover it (SPEC 13.9); refused`);
  return ref;
}

/** ACK a settled delivery with confirmation (§13.9: a fire-and-forget ACK is confirmed with
 *  AckSync or re-proven, never assumed). */
async function ackSync(m: { ackAck: () => Promise<boolean> }, subject: string): Promise<void> {
  if ((await m.ackAck()) !== true)
    throw new EpEnvelopeError("unavailable", `the cleaner's ACK for ${subject} was not confirmed by the server; re-run the barrier; the settled terminal makes the retry idempotent (SPEC 13.9)`);
}

/**
 * Run the exact-pool terminal cleaner over ONE named pool (§13.9 matrix row), on the CLEANER's
 * own bind. Bind-time re-proof first: the pre-created durable's filter is exactly the named
 * pool's subtree, pull mode, explicit ack, unlimited delivery ceiling. Then drain to a PROVEN
 * quiescent pool: for each delivered message — ACK only if the item is durably terminal; settle
 * `expired` when its own `workExpiry` passed (any target); settle `retired` ONLY after
 * re-binding the item to THIS operation's retiring target through its acceptance decision fact
 * (the `epw` subject carries no target); a live, unexpired, FOREIGN-target item is never
 * settled or ACKed and quiescence fails loud while one remains. Quiescence is a FRESH consumer
 * read showing zero `num_pending` and zero `num_ack_pending` (pre-existing owner ACKs drain
 * through `AckWait` redelivery into this loop).
 */
export async function runExactPoolCleaner(
  bind: PoolCleanerBind,
  args: {
    space: string; endpoint: string; pool: string;
    /** Executor-authority, effective-inventory-closed lease/terminal seam; never cleaner-owned handles. */
    settleItem: SettleRetirementPoolItem;
    /** The retiring target this operation may re-bind items to. */
    targetUid: string;
    now: () => number;
    fetchExpiresMs?: number; maxStalledPasses?: number;
  },
): Promise<PoolCleanResult> {
  const { space, endpoint, pool } = args;
  const targetUid = assertLifecycleToken(args.targetUid, "targetUid");
  const stream = epwStreamName(space);
  const durable = poolDurable(endpoint, pool);
  const expect = poolConsumerConfig(space, endpoint, pool);
  const expiresMs = args.fetchExpiresMs ?? 1_000;
  if (expiresMs < 1_000)
    throw new EpEnvelopeError("failed-precondition", `fetchExpiresMs ${expiresMs} is below the pull-consumer floor (1000ms); the client refuses shorter expirations`);
  const maxStalled = args.maxStalledPasses ?? 10;

  // Bind-time re-proof (§13.9): the durable this profile may NEXT/ACK is exactly the named
  // pool's pre-created consumer — never a wider filter, a push consumer, or a finite ceiling.
  let consumer;
  try {
    consumer = await bind.js.consumers.get(stream, durable);
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the cleaner cannot bind the pre-created pool durable ${durable} on ${stream}; this operation's discovered inventory named a pool that is not provisioned (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }
  const cfg = (await consumer.info(false)).config;
  if (cfg.filter_subject !== expect.filter_subject)
    throw new EpEnvelopeError("failed-precondition", `the pool durable ${durable} filters ${String(cfg.filter_subject)}, not exactly ${String(expect.filter_subject)}; the cleaner refuses a drifted filter (SPEC 13.9)`);
  if (cfg.deliver_subject !== undefined && cfg.deliver_subject !== "")
    throw new EpEnvelopeError("failed-precondition", `the pool durable ${durable} is a PUSH consumer; the cleaner binds pull mode only (SPEC 13.9)`);
  if (cfg.ack_policy !== AckPolicy.Explicit)
    throw new EpEnvelopeError("failed-precondition", `the pool durable ${durable} has ack policy ${String(cfg.ack_policy)}, not explicit; terminal-only ACK needs explicit acks (SPEC 13.9)`);
  if (cfg.max_deliver !== -1)
    throw new EpEnvelopeError("failed-precondition", `the pool durable ${durable} caps delivery at ${String(cfg.max_deliver)}; an exhausted item leaves the counters and falsifies quiescence (SPEC 13.9); the ceiling must be unlimited`);

  const counts: PoolCleanResult = { ackedTerminal: 0, settledExpired: 0, settledRetired: 0 };
  const foreignLive = new Map<string, string>(); // subject → why it may not be settled
  let stalled = 0;
  for (;;) {
    // The quiescence probe is a FRESH read (§13.9), never the cached info of an earlier pass.
    const info = await consumer.info(false);
    if (info.num_pending === 0 && info.num_ack_pending === 0) return counts;
    let progressed = 0;
    const iter = await consumer.fetch({ max_messages: 64, expires: expiresMs });
    for await (const m of iter) {
      const ref = itemRefOf(space, endpoint, pool, m.subject);
      const termSubject = workTerminalSubject(space, ref);
      const existing = await readLastFact(bind.jsm, epfStreamName(space), termSubject);
      if (existing !== undefined) {
        parseWorkTerminalFact(existing, termSubject, ref); // a garbled terminal never authorizes an ACK
        await ackSync(m, m.subject);
        counts.ackedTerminal++; progressed++;
        continue;
      }
      // No terminal: re-bind through the item's acceptance decision (§13.9: the epw subject
      // carries no target). An enqueued item without an acceptance is corruption, not absence.
      const decSubject = epfSubject(space, endpoint, ["dec", ref.acceptance.owner, ref.acceptance.actor, ref.acceptance.uid, ref.acceptance.id]);
      const decRaw = await readLastFact(bind.jsm, epfStreamName(space), decSubject);
      if (decRaw === undefined)
        throw new EpEnvelopeError("internal", `the pool item ${m.subject} has no decision fact; an enqueued item derives from an acceptance (corruption, SPEC 13.8); the cleaner refuses`);
      const fact = parseDecisionFact(decRaw, decSubject);
      if (fact.decision !== "accepted")
        throw new EpEnvelopeError("internal", `the pool item ${m.subject} sits under a REJECTED identity; a rejection never enqueues work (corruption, SPEC 13.8); the cleaner refuses`);
      if (fact.workExpiry === undefined)
        throw new EpEnvelopeError("internal", `the pool item ${m.subject} was accepted without a workExpiry; a pool-routed acceptance always carries the absolute horizon (corruption, SPEC 13.8); the cleaner refuses`);
      const now = args.now();
      if (now >= fact.workExpiry) {
        const settled = await args.settleItem({ ref, itemBytes: m.data, disposition: "expired" });
        const observedRaw = await readLastFact(bind.jsm, epfStreamName(space), termSubject);
        if (observedRaw === undefined)
          throw new EpEnvelopeError("internal", `the executor settled ${m.subject} but no terminal ${termSubject} is readable; the cleaner never ACKs an unproven settlement (SPEC 13.9)`);
        const observed = parseWorkTerminalFact(observedRaw, termSubject, ref);
        if (JSON.stringify(observed) !== JSON.stringify(settled))
          throw new EpEnvelopeError("internal", `the terminal ${termSubject} does not match the executor's lease-derived settlement; the cleaner refuses to ACK (SPEC 13.5/13.9)`);
        await ackSync(m, m.subject);
        if (observed.disposition === "expired") counts.settledExpired++;
        else if (observed.disposition === "retired") counts.settledRetired++;
        else counts.ackedTerminal++;
        progressed++;
        continue;
      }
      if (fact.target !== undefined && fact.target.lifecycleUid === targetUid) {
        const settled = await args.settleItem({ ref, itemBytes: m.data, disposition: "retired" });
        const observedRaw = await readLastFact(bind.jsm, epfStreamName(space), termSubject);
        if (observedRaw === undefined)
          throw new EpEnvelopeError("internal", `the executor settled ${m.subject} but no terminal ${termSubject} is readable; the cleaner never ACKs an unproven settlement (SPEC 13.9)`);
        const observed = parseWorkTerminalFact(observedRaw, termSubject, ref);
        if (JSON.stringify(observed) !== JSON.stringify(settled))
          throw new EpEnvelopeError("internal", `the terminal ${termSubject} does not match the executor's lease-derived settlement; the cleaner refuses to ACK (SPEC 13.5/13.9)`);
        await ackSync(m, m.subject);
        if (observed.disposition === "expired") counts.settledExpired++;
        else if (observed.disposition === "retired") counts.settledRetired++;
        else counts.ackedTerminal++;
        progressed++;
        continue;
      }
      // Live, unexpired, foreign target: NEVER settled or ACKed (§13.9). It stays delivered but
      // un-ACKed; quiescence cannot be declared while it remains, and the stall bound below
      // fails the barrier loud with its identity.
      foreignLive.set(m.subject, fact.target === undefined ? "untargeted acceptance" : `target ${fact.target.lifecycleUid}`);
    }
    if (progressed > 0) {
      stalled = 0;
      continue;
    }
    if (++stalled >= maxStalled) {
      const after = await consumer.info(false);
      const blockers = [...foreignLive.entries()].map(([s, why]) => `${s} (${why})`).join(", ");
      throw new EpEnvelopeError("unavailable", `the pool ${durable} did not reach quiescence (num_pending ${after.num_pending}, ack_pending ${after.num_ack_pending} after ${maxStalled} stalled passes)${blockers ? `; live foreign-target items are never settled by a retirement: ${blockers}` : ""}; the barrier refuses to close frontiers and stays resumable (SPEC 13.9)`);
    }
  }
}

// ---- the frontier record (frontier.<lifecycleUid>, records store, create-only) ----------------

interface FrontierRecord {
  lifecycleUid: string;
  opId: string;
  streams: Record<string, number>;
}

function parseFrontier(raw: unknown, key: string): FrontierRecord {
  if (!isRec(raw)) throw new EpEnvelopeError("internal", `the frontier record ${key} is not an object (SPEC 13.1)`);
  const allowed = new Set(["lifecycleUid", "opId", "streams"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the frontier record ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (typeof raw.lifecycleUid !== "string" || typeof raw.opId !== "string" || !isRec(raw.streams) ||
      Object.values(raw.streams).some((v) => !uint(v)))
    throw new EpEnvelopeError("internal", `the frontier record ${key} does not validate (SPEC 13.1)`);
  return raw as unknown as FrontierRecord;
}

// ---- the barrier ------------------------------------------------------------------------------

/** The barrier's outcome (durable facts, re-readable on resume; a resume that found the work
 *  already done reports zero counts, exactly the takeover discipline). */
export interface RetirementResult {
  opId: string;
  lifecycleUid: string;
  revokedRows: number;
  evictedPrincipals: string[];
  /** Endpoints whose obligations the drain step drove (discovery order, sorted). */
  drainedEndpoints: string[];
  /** Per `<endpoint>/<pool>` cleaning counts for the pools THIS run cleaned. */
  cleaned: Record<string, PoolCleanResult>;
  /** The recorded per-stream retirement frontiers. */
  frontiers: Record<string, number>;
}

/** Build the effective-inventory-closed executor settlement seam (§13.9): the returned function
 *  runs under the barrier's op-bounded authority and refuses any ref outside its effective
 *  inventory (the barrier-discovered `spec.pools`, hint ∪ accepted `oblig.<uid>.>` routes) or
 *  this retirement's lifecycle — a foreign endpoint or a pool outside its discovered spec, an
 *  unaccepted or non-pool decision, expiring a live item, or retiring an item accepted for a
 *  target outside this intent's lifecycle. The cleaner chooses refs; it can never borrow this
 *  authority beyond its discovered inventory or this retirement's lifecycle (the confused-deputy
 *  closure). */
export function settlementForIntent(
  work: WorkPoolContext,
  intent: RetirementIntent,
  spec: RetirementPoolSpec,
  space: string,
  opId: string,
  now: () => number,
): SettleRetirementPoolItem {
  const allowedPools = new Set(spec.pools);
  return async ({ ref, itemBytes, disposition }) => {
    if (ref.endpoint !== spec.endpoint || !allowedPools.has(ref.pool))
      throw new EpEnvelopeError("permission-denied", `the retirement executor for ${spec.endpoint} refuses item ${ref.endpoint}/${ref.pool}; this operation's barrier-discovered cleaner inventory grants only its endpoint's pools (SPEC 13.1/13.9)`);
    const decSubject = epfSubject(space, ref.endpoint, ["dec", ref.acceptance.owner, ref.acceptance.actor, ref.acceptance.uid, ref.acceptance.id]);
    const decRaw = await readLastFact(work.jsm, epfStreamName(space), decSubject);
    if (decRaw === undefined)
      throw new EpEnvelopeError("internal", `the retirement executor found no acceptance decision for ${decSubject}; cleaner-supplied coordinates never authorize settlement (SPEC 13.8)`);
    const fact = parseDecisionFact(decRaw, decSubject);
    if (fact.decision !== "accepted" || fact.route !== `pool.${ref.pool}` || fact.workExpiry === undefined)
      throw new EpEnvelopeError("permission-denied", `the retirement executor refuses ${decSubject}; it is not an accepted item for intent pool ${ref.pool} (SPEC 13.8/13.9)`);
    const clock = now();
    if (disposition === "expired") {
      if (clock < fact.workExpiry)
        throw new EpEnvelopeError("permission-denied", `the retirement executor refuses to expire live item ${decSubject}; its acceptance horizon is ${fact.workExpiry} (executor clock ${clock})`);
      const verdict = await reconcileWorkItem(work, { ref, itemBytes, workExpiry: fact.workExpiry, now: clock });
      if (!("fact" in verdict))
        throw new EpEnvelopeError("internal", `expired retirement settlement for ${decSubject} returned nonterminal state ${verdict.state}; the executor refuses to authorize an ACK`);
      return verdict.fact;
    }
    const target = fact.target;
    if (target === undefined || target.owner !== intent.owner || target.actor !== intent.actor || target.lifecycleUid !== intent.lifecycleUid)
      throw new EpEnvelopeError("permission-denied", `the retirement executor refuses to retire ${decSubject}; its accepted target is outside this durable retirement intent (SPEC 13.1/13.9)`);
    return (await retireWorkItem(work, {
      ref, workExpiry: fact.workExpiry, opId, targetUid: intent.lifecycleUid, now: clock,
    })).fact;
  };
}

/** One per-op credential under the §13.1 fence: its principal and its `retire` action. `retire`
 *  is a REAL deny-new for the cleaner/executor (it closes their tracked bounded-lived connection);
 *  for the applier/reconciler/canceller it is a documented NO-OP — those are self-minted
 *  data-account bearers with no ledger row and per-call self-closing connections, so there is
 *  nothing to revoke and kill-live is the whole containment ({@link drainRepairPrincipals}, #4). */
interface OpCredential {
  what: "cleaner" | "executor" | "applier" | "reconciler" | "canceller";
  principal: string;
  retire: () => Promise<void>;
}

/** The per-op credential fence (§13.1): run every credential's `retire` (the deny-new half, a
 *  no-op for the no-row repair bearers) AND the KILL-LIVE half — a cluster-verified eviction of
 *  every principal — on the success AND the failure path. A `retire` that THROWS must NOT skip any
 *  live eviction, and one principal's eviction failure must NOT skip the other's, or a live
 *  connection survives the failed barrier: every containment action runs, every failure is
 *  captured, THEN the barrier fails loud on the first. The VERIFIED EVICTION is the load-bearing
 *  half — for the repair bearers it is the ONLY half; the guarantee is that no LIVE connection
 *  under the principal survives when the frontier closes (a still-unexpired bearer could open a
 *  FRESH connect after the point-in-time scan — the named seed-dominated residual on
 *  {@link drainRepairPrincipals}). A `retire` failure still fails the barrier afterward so no
 *  frontier records while a credential may live, and the resume re-runs the whole fence. */
async function fenceOpCredentials(deps: RetirementDeps, creds: OpCredential[]): Promise<void> {
  const retireFailures: Array<{ c: OpCredential; e: unknown }> = [];
  for (const c of creds) {
    try {
      await c.retire();
    } catch (e) {
      retireFailures.push({ c, e });
    }
  }
  const evictFailures: unknown[] = [];
  for (const c of creds) {
    try {
      const res = await deps.evictPrincipal(c.principal);
      if (res.verifiedGone !== true)
        evictFailures.push(new EpEnvelopeError("unavailable", `the retirement barrier could not VERIFY eviction of the ${c.what} principal ${c.principal} (kicked ${res.kicked}, remaining ${res.remaining}, scanComplete ${res.scanComplete}${res.note ? `; ${res.note}` : ""}); no frontier may record over a live ${c.what} (SPEC 13.1)`));
    } catch (e) {
      evictFailures.push(e);
    }
  }
  if (evictFailures.length > 0) throw evictFailures[0];
  if (retireFailures.length > 0) {
    const { c, e } = retireFailures[0];
    throw new EpEnvelopeError("unavailable", `the ${c.what} principal ${c.principal} was verified-evicted (kill-live done) but revoking its credential (deny-new) failed; the barrier fails closed so no frontier records while the credential may live, and the resume re-runs the fence (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Run the cleaner step for one endpoint entry: mint BOTH per-op binds (the zero-write cleaner
 *  and the settlement executor, §13.9's split authority), build the settlement seam over the
 *  EXECUTOR's own work context, clean every listed pool, then — BEFORE anything else proceeds —
 *  fence both credentials (retire + verified-evict), on the failure path too (a wedged barrier
 *  never leaves a live cleaner or executor). */
async function cleanEndpointPools(
  intent: RetirementIntent,
  spec: RetirementPoolSpec,
  space: string,
  opId: string,
  deps: RetirementDeps,
  cleaned: Record<string, PoolCleanResult>,
): Promise<void> {
  const bind = await deps.openCleaner({ opId, endpoint: spec.endpoint, pools: [...spec.pools] });
  const cleanerCred: OpCredential = { what: "cleaner", principal: bind.principal, retire: () => deps.retireCleanerCredential(bind) };
  let exec: RetirementExecutorBind;
  try {
    exec = await deps.openExecutor({ opId, endpoint: spec.endpoint, pools: [...spec.pools] });
  } catch (e) {
    // A failed executor mint must not leave the already-minted cleaner live: run the full
    // cleaner fence first, then fail with the mint error (a fence failure wins by throwing).
    await fenceOpCredentials(deps, [cleanerCred]);
    throw e;
  }
  const settleItem = settlementForIntent(exec.work, intent, spec, space, opId, deps.now);
  let cleanerError: unknown;
  try {
    for (const pool of spec.pools) {
      cleaned[`${spec.endpoint}/${pool}`] = await runExactPoolCleaner(bind, {
        space, endpoint: spec.endpoint, pool, settleItem, targetUid: intent.lifecycleUid,
        now: deps.now, fetchExpiresMs: deps.cleaner?.fetchExpiresMs, maxStalledPasses: deps.cleaner?.maxStalledPasses,
      });
    }
  } catch (e) {
    cleanerError = e;
  }
  await fenceOpCredentials(deps, [
    cleanerCred,
    { what: "executor", principal: exec.principal, retire: () => deps.retireExecutorCredential(exec) },
  ]);
  if (cleanerError !== undefined) throw cleanerError;
}

/**
 * Run the FULL terminal retirement barrier for a managed-agent lifecycle (SPEC 13.1, in the
 * normative order — module header). Idempotent/crash-resumable: every step re-checks durable
 * state, so calling it again with the SAME `opId` (directly or via
 * {@link resumeAgentRetirement}) finishes the same operation; a different operation's freeze, a
 * foreign generation movement, or a stranger's opId refuses before any CAS.
 */
export async function runAgentRetirementBarrier(
  reg: LifecycleRegistry,
  args: {
    owner: string; actor: string; lifecycleUid: string; opId: string;
    endpoints: RetirementPoolSpec[]; frontierStreams: string[];
  },
  deps: RetirementDeps,
): Promise<RetirementResult> {
  const { space, authKv, recordsKv, jsm } = registryStores(reg);
  const opId = assertLifecycleToken(args.opId);
  assertLifecycleToken(args.lifecycleUid);
  const frontierKey = recordAtomicKey(RETIREMENT_FRONTIER, [args.lifecycleUid]);

  // 0. The durable intent: read-or-create BEFORE any gate movement. An existing intent's
  // coordinates WIN (they are the operation; the caller's args merely re-address it).
  let intent = await readRetirementIntent(authKv, opId, space);
  if (intent !== undefined) {
    if (intent.lifecycleUid !== args.lifecycleUid || intent.owner !== args.owner || intent.actor !== args.actor)
      throw new EpEnvelopeError("permission-denied", `the operation intent ${stageIntentKey(opId)} belongs to lifecycle ${intent.lifecycleUid} ("${intent.owner}/${intent.actor}"), not ${args.lifecycleUid} ("${args.owner}/${args.actor}"); an opId resumes only its OWN operation (SPEC 13.1)`);
  } else {
    assertPoolSpecs(args.endpoints, "endpoints");
    assertFrontierStreams(args.frontierStreams, "frontierStreams", space);
    const head = await readLifecycleHeadForOperation(reg, args.owner, args.actor);
    if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== args.lifecycleUid)
      throw new EpEnvelopeError("failed-precondition", `retirement for "${args.owner}/${args.actor}" requires an ACTIVE head at uid ${args.lifecycleUid}; found ${head === undefined ? "no head" : `${head.mapping.state} at ${head.mapping.lifecycleUid}`} (SPEC 13.1)`);
    const gate0 = await observeGate(reg, args.lifecycleUid);
    if (gate0 === undefined)
      throw new EpEnvelopeError("failed-precondition", `lifecycle ${args.lifecycleUid} has no issuance gate; nothing to retire (SPEC 13.1)`);
    if (gate0.row.state !== "open" || gate0.row.generation < 1)
      throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${gate0.row.state}" at generation ${gate0.row.generation}; a retirement freezes an OPEN, mintable gate (another operation owns a frozen one, SPEC 13.1)`);
    const fresh: RetirementIntent = {
      kind: "retirement", lifecycleUid: args.lifecycleUid, owner: args.owner, actor: args.actor,
      fromGeneration: gate0.row.generation, endpoints: args.endpoints, frontierStreams: args.frontierStreams,
    };
    await createRowByteIdempotent(authKv, stageIntentKey(opId), fresh);
    intent = await readRetirementIntent(authKv, opId, space);
    if (intent === undefined) throw new EpEnvelopeError("internal", `the operation intent ${stageIntentKey(opId)} vanished after its create (SPEC 13.12)`);
  }

  // 1. Freeze the gate under OUR intent — or recognize our own freeze (resume) or our own
  // completed terminal (resume of the tail). A freeze-CAS loss to a mint's finalize touch
  // re-observes and retries, bounded (the normative serialization on one key).
  for (let attempt = 0; ; attempt++) {
    const gate = await observeGate(reg, intent.lifecycleUid);
    if (gate === undefined)
      throw new EpEnvelopeError("internal", `the issuance gate for ${intent.lifecycleUid} vanished mid-operation; a gate is never deleted (corruption, SPEC 13.12)`);
    if (gate.row.state === "frozen") {
      if (gate.row.op?.opId !== opId)
        throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${intent.lifecycleUid} is frozen by operation ${gate.row.op?.opId ?? "<none>"}, not ${opId}; one barrier at a time (SPEC 13.1)`);
      break; // our freeze (fresh or resumed) — proceed into containment
    }
    if (gate.row.state === "retired") {
      if (gate.row.op?.opId !== opId)
        throw new EpEnvelopeError("permission-denied", `the issuance gate for ${intent.lifecycleUid} was terminalized by operation ${gate.row.op?.opId ?? "<none>"}, not ${opId} (SPEC 13.1)`);
      // OUR gate terminal is durable, so steps ≤ 7 completed; only the head terminal may
      // remain. Verify the frontier (it precedes the gate terminal in this op) and finish.
      const fr = await recordsKv.get(frontierKey);
      if (!fr || fr.operation !== "PUT")
        throw new EpEnvelopeError("internal", `the gate for ${intent.lifecycleUid} is retired by ${opId} but its frontier record ${frontierKey} is ${!fr ? "absent" : `a ${fr.operation} marker`}; the frontier precedes the gate terminal (corruption, SPEC 13.1)`);
      const frontier = parseFrontier(JSON.parse(dec.decode(fr.value)), frontierKey);
      if (frontier.opId !== opId || frontier.lifecycleUid !== intent.lifecycleUid)
        throw new EpEnvelopeError("internal", `the frontier record ${frontierKey} belongs to operation ${frontier.opId}, not ${opId} (corruption, SPEC 13.1)`);
      const head = await readLifecycleHeadForOperation(reg, intent.owner, intent.actor);
      if (head === undefined)
        throw new EpEnvelopeError("internal", `the head for "${intent.owner}/${intent.actor}" is gone; a head is never deleted (corruption, SPEC 13.12)`);
      if (head.mapping.lifecycleUid === intent.lifecycleUid)
        await completeHeadRetirementWithinBarrier(reg, { owner: intent.owner, actor: intent.actor, lifecycleUid: intent.lifecycleUid, opId });
      // else: a successor already replaced the retired head — only a retired predecessor is
      // replaceable, so OUR terminal completed (SPEC 13.1).
      return { opId, lifecycleUid: intent.lifecycleUid, revokedRows: 0, evictedPrincipals: [], drainedEndpoints: [], cleaned: {}, frontiers: frontier.streams };
    }
    // open
    if (gate.row.generation !== intent.fromGeneration)
      throw new EpEnvelopeError("conflict", `the issuance gate for ${intent.lifecycleUid} is open at generation ${gate.row.generation}, not this retirement's captured generation ${intent.fromGeneration}; a foreign operation moved it; the intent is stale, nothing was moved, retry with a fresh operation (SPEC 13.1)`);
    // HEAD GUARD immediately before the freeze CAS (the takeover discipline): a stale intent
    // must refuse WITHOUT moving the gate.
    const headNow = await readLifecycleHeadForOperation(reg, intent.owner, intent.actor);
    if (headNow === undefined || headNow.mapping.state !== "active" || headNow.mapping.lifecycleUid !== intent.lifecycleUid)
      throw new EpEnvelopeError("conflict", `the head for "${intent.owner}/${intent.actor}" is ${headNow === undefined ? "gone" : `${headNow.mapping.state} (uid ${headNow.mapping.lifecycleUid})`}, not active at this retirement's uid; the intent is stale and the gate was not moved (SPEC 13.1)`);
    try {
      await freezeGate(reg, { lifecycleUid: intent.lifecycleUid, revision: gate.revision, op: { opId, kind: "retirement" } });
      break;
    } catch (e) {
      if (e instanceof EpEnvelopeError && e.code === "conflict" && attempt < 4) continue;
      throw e;
    }
  }

  // 2. The head containment CAS `active → retiring`, bound to this op (idempotent on resume).
  await beginHeadRetirementWithinBarrier(reg, { owner: intent.owner, actor: intent.actor, lifecycleUid: intent.lifecycleUid, opId });

  // 3. The shared containment core: revoke every family row, reconcile session pairs, VERIFIED
  // eviction of every holder + the alias principal.
  const { revokedRows, evictedPrincipals } = await containLifecycleFamily(
    reg, { owner: intent.owner, actor: intent.actor, lifecycleUid: intent.lifecycleUid, barrier: "retirement" }, deps,
  );

  // 4. Drain the target's acceptance obligations to quiescence (§13.8/§13.1). The barrier owns
  // BOTH the endpoint discovery and the final quiescence check; the injected per-endpoint drain
  // is mechanics. Every writer that observed the pre-retiring mapping is settled HERE, before
  // the cleaner runs and before any frontier closes.
  // Discovery counts EVERY non-terminal row: a provisional to settle, an accepted SELF to drive
  // terminal, AND an accepted EPF whose route reconciliation must be VERIFIED before frontiers
  // close (an accepted-before-enqueue crash leaves an accepted EPF row with no provisional or
  // self beside it; skipping its endpoint would close frontiers over never-enqueued accepted
  // work the cleaner cannot repair). drainTargetForEndpoint drains its whole target prefix to
  // quiescence (settling provisionals, driving accepted-self terminal, and running
  // verifyAcceptedEpfRoute for every accepted-EPF row), so once every endpoint that carries a
  // non-terminal row has had its drain RUN, the target is quiescent. `rejected`/`terminal` rows
  // are already settled. New rows cannot appear (the head is `retiring`, so every obtain fails
  // its currency read), which is why re-enumeration converges.
  const drainedEndpoints: string[] = [];
  const verifiedAcceptedEpf = new Set<string>();
  for (let pass = 1; ; pass++) {
    const rows = await enumerateObligationRows(registryRecordsScanner(reg), `oblig.${intent.lifecycleUid}.>`);
    const nonTerminal = rows.filter((r) => r.row.state === "provisional" || r.row.state === "accepted");
    const needingDrain = nonTerminal.filter((r) => r.row.state !== "accepted" || r.row.decision !== "epf" || !verifiedAcceptedEpf.has(`${r.key}@${r.revision}`));
    if (needingDrain.length === 0) break; // all accepted EPF rows seen here were route-verified at this exact revision
    const endpoints = [...new Set(needingDrain.map((r) => r.key.split(".")[2]))].sort();
    if (pass > 4)
      throw new EpEnvelopeError("unavailable", `the obligation drain for ${intent.lifecycleUid} did not reach quiescence in ${pass - 1} passes (${needingDrain.length} row(s) still needing drain, first ${needingDrain[0]?.key}); investigate before retiring (SPEC 13.8)`);
    for (const ep of endpoints) {
      await deps.drainTargetObligations(ep, intent.lifecycleUid, opId);
      if (!drainedEndpoints.includes(ep)) drainedEndpoints.push(ep);
      for (const r of nonTerminal)
        if (r.key.split(".")[2] === ep && r.row.state === "accepted" && r.row.decision === "epf")
          verifiedAcceptedEpf.add(`${r.key}@${r.revision}`);
    }
  }

  // 4.5 THE DRAIN-REPAIR FENCE (§13.1, #4). The drain's confined repair executors — the commit
  // APPLIER, the pool-route reconciler, and the effects canceller — mint short-lived per-op
  // credentials INSIDE drainTargetObligations (drain-repair.ts) and close each after its one
  // write. Each is a self-minted data-account bearer with NO ledger row (so there is no
  // connect-time deny-new to revoke) and only a bounded JWT life. The GUARANTEE the fence adds is
  // KILL-LIVE: a cluster-verified eviction confirms no LIVE connection under the principal survives
  // when the frontier closes — an in-flight publish, or a close() whose socket error was swallowed,
  // is KICKed and confirmed gone (the connections are minted `noReconnect`, so the KICK is durable
  // in one round). The APPLIER is the priority: its records-KV LAST-VALUE write (last_by_subj on
  // goal/cp) is returned to a normal reader REGARDLESS of the per-stream cutoff, so a LIVE
  // post-frontier applier write would be an observable overwrite/DEL (the reconciler/canceller
  // epw/epf appends only land past the interval and are excluded). Join all three into the SAME
  // fence as the cleaner/executor BEFORE any frontier records, exactly where the drain that spawned
  // them just returned. `retire` is a documented no-op (no ledger row + per-call self-closing
  // connections = nothing to revoke). NOT covered, by design: a fresh malicious connect with a
  // still-unexpired bearer AFTER this point-in-time scan — the seed-dominated named residual on
  // {@link drainRepairPrincipals}. Op-derived and idempotent, so a crash-resume re-drains then
  // re-runs this same fence.
  await fenceOpCredentials(deps, drainRepairPrincipals(opId).map((r) => ({
    what: r.what, principal: r.principal, retire: async () => {},
  })));

  // 4b. Build this operation's EFFECTIVE INVENTORY (#F) = obligation-discovered pools UNION the
  // caller's optional hint. The auth-admin despawn rail cannot know the target's pool work and
  // passes `[]`, so the barrier itself must DISCOVER every (endpoint, pool) the retiring lifecycle
  // has ACCEPTED pool work on. Without discovery, the cleaner loop below runs zero times over an
  // empty hint and the frontier closes over un-cleaned items: a bare live EPW is route-MATERIALIZED
  // (the drain's `established`) but NOT retirement-terminal until the cleaner settles it (§13.1/13.9).
  // Discover from the SAME stable, never-deleted `oblig.<uid>.>` set the drain just drove to
  // quiescence — the head is `retiring`, so no new row can appear and the enumeration is
  // deterministic across resumes. The `intent.endpoints` hint is NOT merely a discovery aid: it is a
  // TRUSTED ADDITIVE AUTHORITY input, because every hinted pool enters the cleaner/executor grant
  // directly below (a hinted pool with NO accepted obligation still gets a bounded per-op credential —
  // the grant-widening the durable intent's trust buys). A compromised bearer's residual is scoped by
  // the EXACT per-pool cleaner/executor GRANTS (the minted credential ACL), NOT by settlementForIntent,
  // which a compromise simply bypasses; settlementForIntent binds only HONEST execution to the
  // effective-inventory spec.pools + this intent's owner/actor/uid + the decision/horizon/retire-target
  // checks. So the residual covers the WHOLE effective inventory, and no pool is claimed to hold this
  // lifecycle's accepted work.
  const cleanerPools = new Map<string, Set<string>>();
  const addPool = (endpoint: string, pool: string): void => {
    const e = endpointToken(endpoint);
    (cleanerPools.get(e) ?? cleanerPools.set(e, new Set()).get(e)!).add(assertPoolToken(pool));
  };
  for (const spec of intent.endpoints) for (const pool of spec.pools) addPool(spec.endpoint, pool);
  for (const r of await enumerateObligationRows(registryRecordsScanner(reg), `oblig.${intent.lifecycleUid}.>`)) {
    if (r.row.state !== "accepted" || r.row.decision !== "epf" || r.row.route === undefined || !r.row.route.startsWith("pool.")) continue;
    addPool(r.key.split(".")[2]!, r.row.route.slice("pool.".length));
  }
  const cleanerInventory: RetirementPoolSpec[] = [...cleanerPools]
    .map(([endpoint, pools]) => ({ endpoint, pools: [...pools].sort() }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));

  // 5. The exact-pool terminal cleaner, per (op × endpoint): the zero-write cleaner bind plus
  // the settlement-executor bind (§13.9 split), BOTH revoked and verified-evicted BEFORE any
  // frontier records (§13.1 fence). Runs over the DISCOVERED inventory, so every endpoint/pool the
  // retiring lifecycle has accepted pool work on is settled before the frontier closes (#F).
  const cleaned: Record<string, PoolCleanResult> = {};
  for (const spec of cleanerInventory) {
    await cleanEndpointPools(intent, spec, space, opId, deps, cleaned);
  }

  // 6. Record the per-stream retirement frontiers (create-only; an existing record is THIS
  // op's completed step — a foreign one refuses; a marker is corruption).
  let frontiers: Record<string, number>;
  const existingFrontier = await recordsKv.get(frontierKey);
  if (existingFrontier !== undefined && existingFrontier !== null) {
    if (existingFrontier.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the frontier record ${frontierKey} carries a ${existingFrontier.operation} marker; a frontier is never deleted (corruption, SPEC 13.12)`);
    const parsed = parseFrontier(JSON.parse(dec.decode(existingFrontier.value)), frontierKey);
    if (parsed.opId !== opId || parsed.lifecycleUid !== intent.lifecycleUid)
      throw new EpEnvelopeError("permission-denied", `the frontier record ${frontierKey} belongs to operation ${parsed.opId}; a frontier records once, under its own retirement (SPEC 13.1)`);
    frontiers = parsed.streams;
  } else {
    frontiers = {};
    for (const stream of intent.frontierStreams) {
      let last: number;
      try {
        last = (await jsm.streams.info(stream)).state.last_seq;
      } catch (e) {
        throw new EpEnvelopeError("failed-precondition", `the frontier step cannot read the stream ${stream} named by the intent; a missing cutoff never closes a lifecycle interval (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
      }
      frontiers[stream] = last;
    }
    const record: FrontierRecord = { lifecycleUid: intent.lifecycleUid, opId, streams: frontiers };
    try {
      await createRecordEntry(recordsKv, frontierKey, record);
    } catch (e) {
      // A concurrent resume of the SAME op may have recorded first: observe and verify.
      const after = await recordsKv.get(frontierKey);
      if (!after || after.operation !== "PUT") throw e;
      const parsed = parseFrontier(JSON.parse(dec.decode(after.value)), frontierKey);
      if (parsed.opId !== opId || parsed.lifecycleUid !== intent.lifecycleUid)
        throw new EpEnvelopeError("permission-denied", `the frontier record ${frontierKey} was created by operation ${parsed.opId}; a frontier records once, under its own retirement (SPEC 13.1)`);
      frontiers = parsed.streams;
    }
  }

  // 7. The gate terminal `frozen → retired` (op-pinned; a retirement freeze never reopens).
  const gateNow = await observeGate(reg, intent.lifecycleUid);
  if (gateNow === undefined)
    throw new EpEnvelopeError("internal", `the issuance gate for ${intent.lifecycleUid} vanished before its terminal (corruption, SPEC 13.12)`);
  await retireGate(reg, { lifecycleUid: intent.lifecycleUid, revision: gateNow.revision, opId });

  // 8. The head terminal `retiring → retired` — the barrier's last step; only now is the alias
  // replaceable, and `retired` asserts the completed cleanup.
  await completeHeadRetirementWithinBarrier(reg, { owner: intent.owner, actor: intent.actor, lifecycleUid: intent.lifecycleUid, opId });

  return { opId, lifecycleUid: intent.lifecycleUid, revokedRows, evictedPrincipals, drainedEndpoints, cleaned, frontiers };
}

/** Resume a crashed retirement from its durable intent alone (`{ opId }` — SPEC 13.1). Re-runs
 *  {@link runAgentRetirementBarrier} with the intent's own coordinates; a stranger's opId (no
 *  intent) is `not-found`. */
export async function resumeAgentRetirement(reg: LifecycleRegistry, opId: string, deps: RetirementDeps): Promise<RetirementResult> {
  const { space, authKv } = registryStores(reg);
  const intent = await readRetirementIntent(authKv, assertLifecycleToken(opId), space);
  if (intent === undefined)
    throw new EpEnvelopeError("not-found", `no operation intent exists at ${stageIntentKey(opId)}; there is nothing to resume (SPEC 13.1)`);
  return runAgentRetirementBarrier(reg, {
    owner: intent.owner, actor: intent.actor, lifecycleUid: intent.lifecycleUid, opId,
    endpoints: intent.endpoints, frontierStreams: intent.frontierStreams,
  }, deps);
}
