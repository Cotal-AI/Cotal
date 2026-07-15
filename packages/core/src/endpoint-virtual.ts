/**
 * Virtual endpoints (SPEC §13.6): a registered endpoint (`spec.activation = on-demand`) with no
 * live instance. Submissions buffer on the ordinary journal plane; the CANONICALIZER (running
 * wherever the endpoint's activator/owning authority runs) checks pool admission BEFORE deciding,
 * and an ACTIVATOR watches the pool and starts an instance. This module owns the transport-thin
 * core of that loop; everything durable composes the existing work-pool, service-record, and
 * timer-plane primitives (never reinvented):
 *
 *  - ADMISSION ({@link admitVirtualWork}): occupancy is the pool consumer's
 *    `num_pending + num_ack_pending`, read FRESH from the exact per-pool Consumer INFO
 *    ({@link readPoolOccupancy}) — and only after RECONCILING the canonicalizer's own
 *    outstanding acceptances against the §13.6 predicate (reconcile-orphans-before-admit: an
 *    accepted-but-lost item is repaired INTO the pool first, so the count it competes under is
 *    honest). The read FAILS CLOSED against EVERY editable consumer knob: a missing/unreadable
 *    consumer is `unavailable` (never a fabricated zero); a reported `max_deliver` other than
 *    unlimited is `failed-precondition` (a finite ceiling strands exhausted items outside BOTH
 *    counters); a `filter_subject` that is not EXACTLY the pool's derived filter (or any
 *    multi-filter shape) is `failed-precondition` (a narrowed/foreign filter undercounts while
 *    stored work remains). Admission itself RE-PROVES the serial pin live: the canonicalizer
 *    durable's `max_ack_pending` must read 1 at every admit (MaxAckPending is editable, so
 *    creation intent proves nothing later). Capacity comes from the endpoint's REGISTERED
 *    {@link VirtualActivationPolicy} (closed schema, capacity required), never a free-floating
 *    knob. An over-capacity verdict is the caller's durable `resource-exhausted` decision fact,
 *    never an accepted-and-stranded submission.
 *  - SERIAL admission ({@link virtualAdmissionConsumerConfig}): the virtual endpoint's
 *    canonicalizer durable pins `max_ack_pending: 1` BY CONSTRUCTION, so count → decide →
 *    enqueue cannot interleave across submissions. The pin is on the ADMISSION durable only:
 *    pool-worker execution concurrency is an independent knob, and occupancy already counts
 *    every worker's `num_ack_pending`.
 *  - ACTIVATION ({@link startVirtualActivator} over an {@link activatorContext}): exact
 *    Consumer INFO is a request/reply SNAPSHOT — there is no broker wakeup — so watching is
 *    BOUNDED POLLING with backoff to a FINITE maximum interval, and an INFO failure is LOUD
 *    (the required `onError` seam) while polling continues. The activator runs over its own
 *    NARROW branded context (a JetStream manager bound with `checkAPI: false`; no KV, no
 *    publisher — an exact-INFO-only credential can construct it), its grant profile is exactly
 *    {@link activatorGrants} (the one `$JS.API.CONSUMER.INFO.EPW_<space>.pool_<e>_<pool>` row),
 *    and the start is a TARGET-BOUND mediated seam (`startInstance()`, fully bound at
 *    construction). `stop()` is re-checked after EVERY await: a not-yet-started activation
 *    never begins after stop (an already-running start completes on its own).
 *  - RESTART-INTENSITY supervision ({@link noteInstanceRestart}): the restart history is
 *    DURABLE and SUPERVISOR-OWNED — it rides the instance's `svc….status` record, and
 *    `writeServiceStatus` carries it forward through every ordinary (unpinned) instance write,
 *    so a successor's `ready` convergence can neither reset nor forge it. Every note is a
 *    revision-pinned CAS (two concurrent notes can never merge-lose a restart), each history
 *    entry is BOUND TO THE DYING PROCESS EPOCH (a real restart advances the epoch, so a
 *    retried/duplicated note for the same restart is an idempotent no-op, never a double
 *    count), and a CLOCK REGRESSION (`now` before the newest recorded restart) REFUSES rather
 *    than silently amnestying history. More than `maxRestarts` (default
 *    {@link RESTART_MAX_DEFAULT}) within `restartWindowMs` (default
 *    {@link RESTART_WINDOW_MS_DEFAULT}) escalates: the status records
 *    {@link SERVICE_ESCALATED} — IRREVERSIBLE at the status writer, excluded from scatter's
 *    live expected set — and the caller's D13 retire seam (`retireLifecycle`, the §13.1
 *    terminal barrier, MUST be idempotent) runs after. A retire failure surfaces `unavailable`
 *    with the escalation standing, and {@link reconcileEscalation} is the RETRY: it acts on
 *    already-escalated rows, re-invokes the idempotent retire seam until it succeeds, and
 *    marks completion durably (the pinned retirement mark is the ONE touch an escalated row
 *    admits, written directly by the reconciler).
 *
 * Passivation is composition, not new machinery: drain, `writeServiceStatus` to
 * `SERVICE_EXITED`, exit; durable reminders ride the timer plane (`emitScheduleRequest`).
 */
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epwStreamName, poolDurable, canonConsumerConfig, epjStreamName, canonDurable } from "./endpoint-binding.js";
import { AckPolicy, jetstreamManager, type ConsumerConfig, type JetStreamManager } from "@nats-io/jetstream";
import {
  reconcileWorkItem,
  assertWorkPoolContext,
  type WorkPoolContext,
  type WorkItemRef,
} from "./endpoint-work.js";
import { mintSupervisorWrite } from "./endpoint-supervisor.js";
import {
  writeServiceStatus,
  parseServiceStatus,
  parseServiceSpec,
  parseActivationPolicy,
  SERVICE_ESCALATED,
  SERVICE_EXITED,
  SERVICE_RESTART_HISTORY_FIELD,
  SERVICE_RETIRED_MARK_FIELD,
  type ServiceStatus,
  type VirtualActivationPolicy,
} from "./endpoint-service.js";
import { RECORD_KINDS, recordSpecKey, recordStatusKey, updateRecordEntry, readRecordLeader } from "./endpoint-records.js";
import { assertLifecycleToken, endpointToken, assertPoolToken } from "./endpoint-subjects.js";
import { spacePrefix, assertInboxConnId } from "./subjects.js";

function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 virtual)`);
}
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- the activator's narrow context ------------------------------------------------------------

/** The activator's NARROW broker context: a JetStream manager and the space, nothing else — no
 *  KV, no publisher, so a credential holding only the exact Consumer INFO row can construct it
 *  (`checkAPI: false`: binding does not require `$JS.API.INFO`). Branded like WorkPoolContext:
 *  a hand-assembled look-alike is rejected at every consuming seam. */
export interface ActivatorContext {
  jsm: JetStreamManager;
  space: string;
}

const ACTIVATOR_CONTEXTS = new WeakSet<ActivatorContext>();

export async function activatorContext(nc: NatsConnection, space: string): Promise<ActivatorContext> {
  spacePrefix(space); // boundary guard: usable space token, throws otherwise
  const ctx = Object.freeze({ jsm: await jetstreamManager(nc, { checkAPI: false }), space });
  ACTIVATOR_CONTEXTS.add(ctx);
  return ctx;
}

/** The activator principal's COMPLETE broker authority (§13.6/§13.9): the exact per-pool
 *  Consumer INFO PUBLISH row plus — since Consumer INFO is a request/reply call — the
 *  CONNECTION-SCOPED reply inbox SUBSCRIBE row `_INBOX_<connId>.>` (never account-wide
 *  `_INBOX.>`, which is cross-connection reply-read authority). The start is a mediated,
 *  target-bound seam (off-broker or its own ep rail), so it contributes no row here; NOTHING
 *  else — no MSG.NEXT/ACK, no EPW STREAM.MSG.GET, no consumer create/update/delete, no EPW
 *  publish. The credential's OWN lifetime/renewal/lifecycle-UID binding rides the production
 *  activator provisioning (the named manager-wiring slice); this is the confined subject set.
 *  `connId` is the connection's validated inbox nonce (the same `_INBOX_<connId>` prefix the
 *  connection sets); omit it to get the publish half alone. */
export function activatorGrants(space: string, endpoint: string, pool: string, connId?: string): { publish: string[]; subscribe: string[] } {
  const publish = [`$JS.API.CONSUMER.INFO.${epwStreamName(space)}.${poolDurable(endpoint, pool)}`];
  const subscribe = connId !== undefined ? [`_INBOX_${assertInboxConnId(connId)}.>`] : [];
  return { publish, subscribe };
}

// ---- occupancy (the shared reader: admission + activator) -------------------------------------

/** The pool's admission occupancy (§13.6): stored-and-uncounted states do not exist while the
 *  reader's invariants hold (WorkQueue retention + unlimited delivery + the exact pool filter +
 *  explicit ack). */
export interface PoolOccupancy {
  /** Not yet delivered to the pool consumer. */
  pending: number;
  /** Delivered, awaiting ack (a worker is on it, or redelivery is due). */
  ackPending: number;
  /** `pending + ackPending` — the §13.6 admission count. */
  occupancy: number;
}

/**
 * Read the pool's occupancy FRESH from the exact per-pool Consumer INFO (request/reply
 * snapshot; leader-routed like every JS API call). FAIL CLOSED, never fabricated — and every
 * EDITABLE knob the count depends on is re-proved at EVERY read, because a post-create
 * consumer edit must not silently falsify the fence:
 *  - a missing or unreadable consumer is `unavailable` (an admission fence cannot treat
 *    ignorance as an empty pool);
 *  - a reported `max_deliver` other than -1 (unlimited) is `failed-precondition`
 *    ({@link poolConsumerConfig} pins -1 at create; MaxDeliver is editable after);
 *  - a `filter_subject` that is not EXACTLY the pool's derived filter — or any multi-filter
 *    (`filter_subjects`) shape — is `failed-precondition`: FilterSubject is editable, and a
 *    narrowed/foreign filter reads 0 while stored work remains;
 *  - a non-explicit ack policy is `failed-precondition` (without an ack barrier,
 *    `num_ack_pending` does not mean "work still owned").
 * Accepts the branded {@link WorkPoolContext} (admission path) or the narrow branded
 * {@link ActivatorContext} (the watch loop); a hand-assembled context is refused.
 */
export async function readPoolOccupancy(
  ctx: WorkPoolContext | ActivatorContext,
  endpoint: string,
  pool: string,
): Promise<PoolOccupancy> {
  if (!ACTIVATOR_CONTEXTS.has(ctx as ActivatorContext)) assertWorkPoolContext(ctx as WorkPoolContext);
  const stream = epwStreamName(ctx.space);
  const durable = poolDurable(endpoint, pool);
  let info: Awaited<ReturnType<typeof ctx.jsm.consumers.info>>;
  try {
    info = await ctx.jsm.consumers.info(stream, durable);
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the pool occupancy read failed for ${stream}/${durable}; an admission fence fails closed, never open (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
  }
  if (info.config.max_deliver !== -1)
    throw new EpEnvelopeError("failed-precondition", `pool consumer ${durable} reports max_deliver ${String(info.config.max_deliver)}, not -1 (unlimited); a finite delivery ceiling strands exhausted items outside num_pending and num_ack_pending, so the occupancy sum would be a lie — repin the consumer (SPEC 13.6)`);
  const expectedFilter = `${spacePrefix(ctx.space)}.epw.${endpointToken(endpoint)}.${assertPoolToken(pool)}.>`;
  if ((info.config as { filter_subjects?: unknown }).filter_subjects !== undefined)
    throw new EpEnvelopeError("failed-precondition", `pool consumer ${durable} reports a multi-filter (filter_subjects); the §13.6 count is defined over exactly ONE pool filter — repin the consumer (SPEC 13.9)`);
  if (info.config.filter_subject !== expectedFilter)
    throw new EpEnvelopeError("failed-precondition", `pool consumer ${durable} reports filter "${String(info.config.filter_subject)}", not the pool's own "${expectedFilter}"; FilterSubject is editable post-create and a narrowed/foreign filter undercounts stored work — repin the consumer (SPEC 13.6/13.9)`);
  if (info.config.ack_policy !== AckPolicy.Explicit)
    throw new EpEnvelopeError("failed-precondition", `pool consumer ${durable} reports ack_policy "${String(info.config.ack_policy)}", not explicit; without the ack barrier num_ack_pending does not mean owned work (SPEC 13.9)`);
  if ((info.config as { deliver_subject?: unknown }).deliver_subject !== undefined)
    throw new EpEnvelopeError("failed-precondition", `pool consumer ${durable} is a PUSH consumer (deliver_subject set); the §13.6 pool is pull-only, a delete/recreate must not substitute a push shape — repin the consumer (SPEC 13.9)`);
  if (!uint(info.num_pending) || !uint(info.num_ack_pending) || !Number.isSafeInteger(info.num_pending + info.num_ack_pending))
    throw new EpEnvelopeError("internal", `pool consumer ${durable} reported non-safe-integer counters (num_pending ${String(info.num_pending)}, num_ack_pending ${String(info.num_ack_pending)})`);
  return { pending: info.num_pending, ackPending: info.num_ack_pending, occupancy: info.num_pending + info.num_ack_pending };
}

// ---- the serial admission durable --------------------------------------------------------------

/**
 * The VIRTUAL endpoint's canonicalizer durable: {@link canonConsumerConfig} with
 * `max_ack_pending` PINNED to 1 (not an option — the pin is the point). One submission is in
 * the admission path at a time, so the count → decide → enqueue sequence is SERIAL and two
 * concurrent submissions cannot both observe the same free slot. Pool-worker execution
 * concurrency is untouched: occupancy already counts every worker's `num_ack_pending`, and the
 * worker durable keeps its own knobs. Because MaxAckPending is EDITABLE post-create,
 * {@link admitVirtualWork} re-proves the live pin at every admission — creation intent alone
 * is not the invariant.
 */
export function virtualAdmissionConsumerConfig(
  space: string,
  endpoint: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return canonConsumerConfig(space, endpoint, { ackWaitMs: opts.ackWaitMs, maxAckPending: 1 });
}

// ---- the registered activation policy (bound to the svc registration, never caller-supplied) ---

/**
 * Read the endpoint's REGISTERED §13.6 activation policy from its `svc.<endpoint>.<instanceId>`
 * spec — the ONE authority for capacity and the restart knobs, so no decision or supervision
 * seam trusts a caller-supplied policy. The read is fail-closed: a missing registration is
 * `failed-precondition` (there is no policy to admit or supervise under), and a registration
 * without an `activation` block means the endpoint is not virtual, so a virtual decision over
 * it refuses. `readSpec` MUST be LEADER-SERVED (the policy read gates escalation/retirement and
 * capacity, so it is FENCING by use; a follower Direct Get could read a stale wider policy) and
 * returns the spec value plus its store revision, so a decision can carry the revision and
 * RE-PROVE it after its later awaits (a re-registration must not narrow the policy mid-flight).
 */
async function readRegisteredActivation(
  readSpec: () => Promise<{ value: unknown; revision: number } | undefined>,
  endpoint: string,
  instanceId: string,
): Promise<{ policy: VirtualActivationPolicy; revision: number }> {
  const iId = assertLifecycleToken(instanceId, "instanceId");
  const entry = await readSpec();
  if (entry === undefined)
    throw new EpEnvelopeError("failed-precondition", `endpoint "${endpoint}/${iId}" has no registered svc spec; a virtual decision has no policy to bind to (SPEC 13.6)`);
  const spec = parseServiceSpec(entry.value, { endpoint });
  if (spec.activation === undefined)
    throw new EpEnvelopeError("failed-precondition", `endpoint "${endpoint}/${iId}" is registered without an activation policy (not a virtual endpoint); no on-demand admission or restart supervision applies (SPEC 13.6)`);
  return { policy: parseActivationPolicy(spec.activation), revision: entry.revision };
}

// ---- admission ---------------------------------------------------------------------------------

/** One outstanding acceptance the canonicalizer must reconcile before it counts (§13.6: the
 *  acceptance→enqueue bridge is repaired by the decidable predicate, never guessed). */
export interface OutstandingAcceptance {
  ref: WorkItemRef;
  itemBytes: Uint8Array;
  workExpiry: number;
}

export interface VirtualAdmissionVerdict {
  /** True iff the pool has a free slot under the policy's capacity AFTER repair. A false
   *  verdict is the caller's durable `resource-exhausted` decision fact (§13.6), not an error. */
  admitted: boolean;
  occupancy: PoolOccupancy;
  capacity: number;
  /** How many outstanding acceptances the pre-admission reconciliation re-enqueued. */
  repaired: number;
  /** The RE-PROVEN registration revision the decision bound to (§13.6): the caller carries it
   *  into the acceptance commit so the accept CAS fences on the same policy coordinate. */
  policyRevision: number;
}

/**
 * The §13.6 admission fence, in the canonicalizer's decide path (admission BEFORE decision):
 *  1. RE-PROVE the serial pin LIVE: the canonicalizer durable must report
 *     `max_ack_pending === 1` and its exact EPJ filter (both editable post-create); a drifted
 *     admission durable means the serial invariant is GONE — refuse, never decide;
 *  2. RECONCILE the caller's outstanding acceptances (`reconcileWorkItem` per item, the §13.6
 *     predicate): an accepted item with no terminal, no settled lease, and no live pool entry
 *     is re-enqueued NOW, so repaired work is inside the count new work competes under;
 *  3. read occupancy FRESH ({@link readPoolOccupancy}, fail-closed against every editable knob);
 *  4. verdict: `occupancy < policy.capacity` (the REGISTERED activation policy, closed schema).
 * Infrastructure failures THROW (`unavailable`/`failed-precondition`); only a genuine
 * over-capacity state returns `admitted: false`.
 */
export async function admitVirtualWork(
  ctx: WorkPoolContext,
  args: {
    endpoint: string;
    pool: string;
    /** The registered instance whose `svc` spec carries the activation policy (§13.6): the
     *  capacity is READ from that registration, LEADER-SERVED, never taken from the caller. */
    instanceId: string;
    /** The canonicalizer's own accepted-but-unsettled items (its journal redeliveries). */
    outstanding?: OutstandingAcceptance[];
    now: number;
  },
): Promise<VirtualAdmissionVerdict> {
  assertWorkPoolContext(ctx);
  if (!Number.isSafeInteger(args.now)) invalid(`now ${String(args.now)} is not an integer`);
  // The capacity is bound to the REGISTERED policy, read leader-served (the admission fence is
  // a decision gate): a caller cannot pass a wider capacity than the endpoint registered.
  const specKey = recordSpecKey(RECORD_KINDS.svc, [args.endpoint, args.instanceId]);
  const readPolicy = () => readRegisteredActivation(() => readRecordLeader(ctx.jsm, ctx.space, specKey), args.endpoint, args.instanceId);
  const { policy, revision: policyRevision } = await readPolicy();

  // (1) The serial pin is proved LIVE at every admission, not assumed from creation.
  const admissionDurable = canonDurable(args.endpoint);
  let admissionInfo: Awaited<ReturnType<typeof ctx.jsm.consumers.info>>;
  try {
    admissionInfo = await ctx.jsm.consumers.info(epjStreamName(ctx.space), admissionDurable);
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the admission-durable read failed for ${admissionDurable}; the serial pin cannot be assumed, admission fails closed (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
  }
  if (admissionInfo.config.max_ack_pending !== 1)
    throw new EpEnvelopeError("failed-precondition", `admission durable ${admissionDurable} reports max_ack_pending ${String(admissionInfo.config.max_ack_pending)}, not 1; MaxAckPending is editable post-create and without the pin two submissions can observe the same free slot — repin the consumer (SPEC 13.6)`);
  // Re-prove the load-bearing shape too (defense against a delete/recreate substituting a
  // semantically different consumer that keeps the same max_ack_pending/filter): the serial
  // pin only serializes when ack is Explicit and delivery is pull (no deliver_subject).
  if (admissionInfo.config.ack_policy !== AckPolicy.Explicit)
    throw new EpEnvelopeError("failed-precondition", `admission durable ${admissionDurable} reports ack_policy "${String(admissionInfo.config.ack_policy)}", not explicit; max_ack_pending only serializes an ack-barriered consumer (SPEC 13.9)`);
  if ((admissionInfo.config as { deliver_subject?: unknown }).deliver_subject !== undefined)
    throw new EpEnvelopeError("failed-precondition", `admission durable ${admissionDurable} is a PUSH consumer (deliver_subject set); the canonicalizer is pull-only, a push shape does not serialize the decision path (SPEC 13.9)`);
  const expectedAdmissionFilter = `${spacePrefix(ctx.space)}.epj.${endpointToken(args.endpoint)}.>`;
  if ((admissionInfo.config as { filter_subjects?: unknown }).filter_subjects !== undefined || admissionInfo.config.filter_subject !== expectedAdmissionFilter)
    throw new EpEnvelopeError("failed-precondition", `admission durable ${admissionDurable} reports filter "${String(admissionInfo.config.filter_subject)}", not the endpoint's own "${expectedAdmissionFilter}"; a drifted admission filter serializes the wrong stream — repin the consumer (SPEC 13.9)`);

  // (2) Repair BEFORE counting.
  let repaired = 0;
  for (const o of args.outstanding ?? []) {
    const verdict = await reconcileWorkItem(ctx, { ref: o.ref, itemBytes: o.itemBytes, workExpiry: o.workExpiry, now: args.now });
    if (verdict.state === "re-enqueued") repaired++;
  }
  // (3) occupancy
  const occupancy = await readPoolOccupancy(ctx, args.endpoint, args.pool);
  // (4) RE-PROVE the policy revision after every await above: a re-registration that NARROWED
  // capacity mid-flight must not let this decision admit under the stale wider policy. The
  // decision binds the re-proven policy (§13.6); the caller carries `policyRevision` into the
  // acceptance commit so the accept CAS (after this helper returns) fences on the same coordinate.
  const fresh = await readPolicy();
  if (fresh.revision !== policyRevision)
    throw new EpEnvelopeError("conflict", `endpoint "${args.endpoint}/${args.instanceId}" re-registered during admission (policy revision ${policyRevision} → ${fresh.revision}); the decision refuses rather than admit under a stale policy (SPEC 13.6)`);
  return { admitted: occupancy.occupancy < fresh.policy.capacity, occupancy, capacity: fresh.policy.capacity, repaired, policyRevision: fresh.revision };
}

// ---- the activator -----------------------------------------------------------------------------

export interface VirtualActivatorOpts {
  /** The NARROW branded activator context ({@link activatorContext}) — the watch loop's whole
   *  broker surface is the exact Consumer INFO its {@link activatorGrants} row permits. */
  ctx: ActivatorContext;
  endpoint: string;
  pool: string;
  /** The TARGET-BOUND mediated start seam: fully bound at construction (no arguments, so a
   *  compromised activator cannot redirect it), resolved by the supervisor/manager that holds
   *  the actual start authority. Idempotence against a concurrent start is the registration
   *  barrier's job, not this seam's. It MUST refuse an escalated identity — production wires
   *  it through the supervisor, whose start path consults the status record
   *  ({@link SERVICE_ESCALATED} is irreversible and excluded from liveness). */
  startInstance(): Promise<void>;
  /** Mediated liveness: is a live instance already serving? Answered by the caller's authority
   *  (a `svc` record read, or the supervisor), so the activator itself stays INFO-only. */
  isLive(): Promise<boolean> | boolean;
  /** REQUIRED loud-failure seam: an unobserved activator failure is not allowed (`kind` is
   *  `info` for an occupancy-read failure, `start` for a start/liveness failure). Polling
   *  continues with backoff after either. */
  onError(kind: "info" | "start", err: unknown): void;
  /** Base poll interval (ms), default 500. Exact Consumer INFO is a snapshot; polling IS the
   *  watch — there is no broker wakeup to wait for. */
  pollMs?: number;
  /** FINITE backoff ceiling (ms), default 5000: quiet polls back off toward it, work resets to
   *  `pollMs`. Refused unless a safe integer >= pollMs (an unbounded interval is a liveness
   *  hole dressed as economy). */
  maxPollMs?: number;
  /** Injectable timer/clock (testability); defaults to Node setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimeoutFn?: (h: unknown) => void;
}

export interface VirtualActivator {
  /** Stop polling. Idempotent. Re-checked after EVERY await: a start not yet begun never
   *  begins after stop; a start already running completes on its own. */
  stop(): void;
  /** Loop observability (smoke assertions + operator introspection). */
  stats(): { polls: number; starts: number; infoErrors: number; startErrors: number; lastOccupancy: number };
}

/**
 * Watch one pool by BOUNDED POLLING of its exact Consumer INFO and start the instance through
 * the bound seam when there is work and no live instance. See the module header for the
 * authority profile this loop is confined to. One start is in flight at a time (the guard is
 * local dedupe, not the correctness fence — registration owns that); polls stay serial with the
 * tick chain, so a slow INFO read never stacks requests.
 */
export function startVirtualActivator(opts: VirtualActivatorOpts): VirtualActivator {
  if (!ACTIVATOR_CONTEXTS.has(opts.ctx))
    throw new EpEnvelopeError("failed-precondition", `the activator context was not constructed by activatorContext(); a hand-assembled resource bundle never authorizes (SPEC 13.4)`);
  const pollMs = opts.pollMs ?? 500;
  const maxPollMs = opts.maxPollMs ?? 5000;
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) invalid(`pollMs ${String(opts.pollMs)} is not a positive integer`);
  if (!Number.isSafeInteger(maxPollMs) || maxPollMs < pollMs)
    invalid(`maxPollMs ${String(opts.maxPollMs)} is not a FINITE integer >= pollMs ${pollMs}; the backoff ceiling bounds the activation delay`);
  if (typeof opts.onError !== "function") invalid("onError is required; an unobserved activator failure is a silent liveness hole");
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let timer: { unref?: () => void } | undefined;
  let startInFlight = false;
  let delay = pollMs;
  let polls = 0, starts = 0, infoErrors = 0, startErrors = 0, lastOccupancy = 0;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeoutFn(() => { void tick(); }, delay);
    timer.unref?.();
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    polls++;
    let occ: PoolOccupancy;
    try {
      occ = await readPoolOccupancy(opts.ctx, opts.endpoint, opts.pool);
    } catch (e) {
      if (stopped) return; // stop() during the INFO: report nothing, schedule nothing
      infoErrors++;
      opts.onError("info", e);
      delay = Math.min(maxPollMs, delay * 2);
      schedule();
      return;
    }
    if (stopped) return; // stop() during the INFO: a not-yet-started activation never begins
    lastOccupancy = occ.occupancy;
    if (occ.occupancy > 0) {
      delay = pollMs; // work present: poll at base rate
      if (!startInFlight) {
        startInFlight = true;
        // Deliberately NOT awaited by the tick chain: a slow or wedged start must not stop the
        // polling that makes the wedge observable. The flag dedupes; errors surface via onError.
        void (async () => {
          let begun = false;
          try {
            const live = await opts.isLive();
            if (stopped) return; // stop() during the liveness read: do not begin
            if (!live) {
              starts++;
              begun = true;
              await opts.startInstance();
            }
          } catch (e) {
            // A pre-start failure (a rejecting isLive) AFTER stop is SILENT: no start began, so
            // it is not a real activation fault, only a race the stop won. A failure once the
            // start actually BEGAN is always reported (the started work's result matters).
            if (!begun && stopped) return;
            startErrors++;
            opts.onError("start", e);
          } finally {
            startInFlight = false;
          }
        })();
      }
    } else {
      delay = Math.min(maxPollMs, delay * 2); // quiet: back off toward the finite ceiling
    }
    schedule();
  };
  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
    },
    stats: () => ({ polls, starts, infoErrors, startErrors, lastOccupancy }),
  };
}

// ---- restart-intensity supervision -------------------------------------------------------------

/** §13.6 defaults: more than 3 restarts within 60s escalates. */
export const RESTART_MAX_DEFAULT = 3;
export const RESTART_WINDOW_MS_DEFAULT = 60_000;
/** The SUPERVISOR-OWNED status field carrying the durable restart history: entries are
 *  `{ t, epoch }`, one per DYING PROCESS EPOCH (a real restart advances the epoch, so a
 *  replayed note is an idempotent no-op). The field is defined by the service module because
 *  {@link writeServiceStatus} carries it forward through instance-side writes. */
export const RESTART_HISTORY_FIELD = SERVICE_RESTART_HISTORY_FIELD;
/** The reconciler's durable retirement-complete mark (see {@link reconcileEscalation}). */
export const RETIRED_MARK_FIELD = SERVICE_RETIRED_MARK_FIELD;

/** One durable restart-history entry: when, and WHICH process epoch died. */
export interface RestartHistoryEntry {
  t: number;
  epoch: number;
}

const td = new TextDecoder();

function parseHistory(raw: unknown, what: string): RestartHistoryEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((e) => isRec(e) && uint(e.t) && uint(e.epoch)))
    throw new EpEnvelopeError("internal", `the stored restart history for ${what} is garbled; a mediated-writer record that does not validate is a writer bug (SPEC 13.3)`);
  return raw as unknown as RestartHistoryEntry[];
}

/**
 * Note one restart of a virtual instance, DURABLY and CAS-fenced (§13.6 supervision):
 *  - the restart history rides the instance's `svc….status` record and is SUPERVISOR-OWNED
 *    ({@link writeServiceStatus} carries it forward through every unpinned instance write, so
 *    a successor's ordinary `ready` convergence cannot reset or forge it);
 *  - the write is pinned to the revision THIS call read (`expectedStatusRevision`), so two
 *    concurrent notes can never merge-lose a restart (one loses `conflict` and retries);
 *  - each entry is BOUND to the dying process epoch: a note whose epoch is already recorded is
 *    an idempotent NO-OP (`duplicate: true`) — one physical restart counts once, however many
 *    times its notification is retried or duplicated;
 *  - a CLOCK REGRESSION (`now` before the newest recorded restart) REFUSES
 *    (`failed-precondition`): a rolled-back supervisor clock must not amnesty durable history;
 *  - a stored {@link SERVICE_ESCALATED} state REFUSES (`failed-precondition`): the instance
 *    has stopped restarting, terminally — {@link reconcileEscalation} is the retirement retry;
 *  - more than `maxRestarts` entries within `restartWindowMs` (the pruned history plus this
 *    note) ESCALATES: the status commits {@link SERVICE_ESCALATED} first (irreversible at the
 *    writer), then the caller's D13 retire seam runs (`retireLifecycle`, the §13.1 terminal
 *    barrier, MUST be idempotent). A retire failure is `unavailable` with the escalated status
 *    already durable — honest halves; {@link reconcileEscalation} retries until it completes.
 * A non-escalating note records {@link SERVICE_EXITED} (the instance just died; its successor
 * writes `ready` itself when it registers) with the pruned history plus this note.
 */
export async function noteInstanceRestart(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    /** The DYING instance's epoch (still the mapping's current one until a successor activates). */
    epoch: number;
    now: number;
    /** The trusted lifecycle-mapping reader (same seam as {@link writeServiceStatus}). */
    readProcessEpoch: () => Promise<number> | number;
    /** LEADER-SERVED reader of the endpoint's `svc.<endpoint>.<instanceId>` spec (value +
     *  revision). The restart-intensity thresholds are FENCING by use (they gate escalation and
     *  retirement), so the policy MUST NOT be read through a follower-capable KV get — a stale
     *  wider window would suppress an escalation. Production wires the records-KV leader-served
     *  `STREAM.MSG.GET` reader here (the same one the admission fence uses). */
    readSpecLeader: () => Promise<{ value: unknown; revision: number } | undefined>;
    /** The D13/§13.1 terminal retire seam, invoked ONLY on escalation. MUST be idempotent
     *  ({@link reconcileEscalation} re-invokes it on retry). */
    retireLifecycle: () => Promise<void>;
  },
): Promise<{ escalated: boolean; restartsInWindow: number; duplicate: boolean }> {
  if (!uint(args.now)) invalid(`now ${String(args.now)} is not an unsigned integer`);
  if (!uint(args.epoch)) invalid(`epoch ${String(args.epoch)} is not an unsigned integer`);
  if (typeof args.retireLifecycle !== "function") invalid("retireLifecycle is required; escalation without terminal retirement is a half-fence");
  if (typeof args.readSpecLeader !== "function") invalid("readSpecLeader is required; the restart-intensity policy is FENCING and must be read leader-served, never a follower KV get (SPEC 13.6/13.9)");

  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  const what = `"${args.endpoint}/${args.instanceId}"`;
  // The restart-intensity thresholds are bound to the REGISTERED activation policy, read
  // LEADER-SERVED (fencing by use), never caller-supplied and never follower-stale: a supervisor
  // cannot loosen the window to suppress an escalation, and a stale wider window cannot either.
  const { policy } = await readRegisteredActivation(args.readSpecLeader, args.endpoint, iId);
  const maxRestarts = policy.maxRestarts ?? RESTART_MAX_DEFAULT;
  const windowMs = policy.restartWindowMs ?? RESTART_WINDOW_MS_DEFAULT;
  const key = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const stored = await kv.get(key);
  let prior: ServiceStatus | undefined;
  let expectedStatusRevision = 0;
  if (stored && stored.operation === "PUT") {
    prior = parseServiceStatus(JSON.parse(td.decode(stored.value)));
    expectedStatusRevision = stored.revision;
  } else if (stored && stored.operation !== "PUT") {
    throw new EpEnvelopeError("failed-precondition", `the status for ${what} carries a ${stored.operation} marker; supervising over a deletion would resurrect authoritative state (SPEC 13.12)`);
  }
  if (prior?.state === SERVICE_ESCALATED)
    throw new EpEnvelopeError("failed-precondition", `${what} is escalated; the instance has stopped restarting and its lifecycle retires terminally (SPEC 13.6; reconcileEscalation is the retirement retry), a further restart note never applies`);

  const history = parseHistory(prior?.[RESTART_HISTORY_FIELD], what);
  // CLOCK REGRESSION is checked BEFORE the duplicate short-circuit: a rolled-back supervision
  // clock must fail loud on EVERY note, including a replay, rather than silently returning a
  // stale window count computed against the bad clock (SPEC 13.6).
  const newest = history.reduce((m, e) => Math.max(m, e.t), 0);
  if (args.now < newest)
    throw new EpEnvelopeError("failed-precondition", `${what}: the supervision clock ${args.now} is BEHIND the newest recorded restart ${newest}; a clock regression must not amnesty durable history (SPEC 13.6) — restore the clock or reconcile manually`);
  if (history.some((e) => e.epoch === args.epoch)) {
    // The SAME dying epoch is already recorded: this note is a replay/duplicate of a restart
    // already counted — idempotent no-op (a real restart advances the epoch).
    const inWindow = history.filter((e) => args.now - e.t < windowMs).length;
    return { escalated: false, restartsInWindow: inWindow, duplicate: true };
  }
  const pruned = history.filter((e) => args.now - e.t < windowMs);
  pruned.push({ t: args.now, epoch: args.epoch });
  const escalated = pruned.length > maxRestarts;

  const status: ServiceStatus = {
    epoch: args.epoch,
    state: escalated ? SERVICE_ESCALATED : SERVICE_EXITED,
    observedSpecRevision: prior?.observedSpecRevision ?? 0,
    [RESTART_HISTORY_FIELD]: pruned,
  };
  const committedRevision = await writeServiceStatus(kv, {
    endpoint: args.endpoint,
    instanceId: iId,
    epoch: args.epoch,
    status,
    readProcessEpoch: args.readProcessEpoch,
    expectedStatusRevision,
    supervisor: mintSupervisorWrite(), // the package-private authority to originate the history + escalation
  });
  if (escalated) {
    try {
      await args.retireLifecycle();
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `${what} escalated durably (the status stands and blocks restarts) but the lifecycle retire seam failed; reconcileEscalation retries it, nothing un-escalates (SPEC 13.6/13.1): ${(e as Error)?.message ?? String(e)}`);
    }
    // Best-effort retirement-complete mark (the ONE touch an escalated row admits, pinned).
    // A failure here is harmless: reconcileEscalation re-invokes the idempotent retire seam
    // and writes the mark on its own pass.
    try {
      await updateRecordEntry(kv, key, { ...status, [RETIRED_MARK_FIELD]: args.now }, committedRevision);
    } catch {
      /* reconciler backstop */
    }
  }
  return { escalated, restartsInWindow: pruned.length, duplicate: false };
}

/**
 * The escalation RETIREMENT reconciler (§13.6: "the lifecycle retires terminally" must survive
 * a crash or a failed retire between the escalation CAS and the barrier): acts on an
 * already-escalated status row, re-invokes the caller's IDEMPOTENT retire seam until it
 * succeeds, and then durably marks completion (a revision-pinned direct update — the one touch
 * an escalated row admits; {@link writeServiceStatus} refuses everything else). Run it on
 * supervisor startup and whenever {@link noteInstanceRestart} refuses on an escalated row.
 * Returns what it found and whether THIS pass did the retirement.
 */
export async function reconcileEscalation(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    now: number;
    retireLifecycle: () => Promise<void>;
  },
): Promise<{ escalated: boolean; retired: boolean; acted: boolean }> {
  if (typeof args.retireLifecycle !== "function") invalid("retireLifecycle is required");
  if (!uint(args.now)) invalid(`now ${String(args.now)} is not an unsigned integer`);
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  const key = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const stored = await kv.get(key);
  if (!stored) return { escalated: false, retired: false, acted: false }; // TRUE absence: never escalated
  // A DEL/PURGE marker is CORRUPTION, not clean absence: reconciling over it could let an
  // escalated identity's retirement silently never run. Fail closed (§13.12 retention floor).
  if (stored.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the status for "${args.endpoint}/${args.instanceId}" carries a ${stored.operation} marker; a deletion is never clean absence, an escalated identity must not skip retirement (SPEC 13.12)`);
  const status = parseServiceStatus(JSON.parse(td.decode(stored.value)));
  if (status.state !== SERVICE_ESCALATED) return { escalated: false, retired: false, acted: false };
  if (status[RETIRED_MARK_FIELD] !== undefined) return { escalated: true, retired: true, acted: false };
  try {
    await args.retireLifecycle();
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `the retirement of escalated "${args.endpoint}/${args.instanceId}" failed again; the escalation stands and this reconciler retries (SPEC 13.6/13.1): ${(e as Error)?.message ?? String(e)}`);
  }
  try {
    await updateRecordEntry(kv, key, { ...status, [RETIRED_MARK_FIELD]: args.now }, stored.revision);
  } catch (e) {
    throw new EpEnvelopeError("conflict", `the retirement of "${args.endpoint}/${args.instanceId}" completed but its mark lost a CAS (a concurrent reconciler passed); re-run to converge: ${(e as Error)?.message ?? String(e)}`);
  }
  return { escalated: true, retired: true, acted: true };
}
