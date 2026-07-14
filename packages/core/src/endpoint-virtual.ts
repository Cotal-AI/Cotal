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
 *    honest). The read FAILS CLOSED: a missing/unreadable consumer is `unavailable` (never a
 *    fabricated zero), and a pool consumer whose reported `max_deliver` is not unlimited is
 *    `failed-precondition` (a finite delivery ceiling strands exhausted items outside BOTH
 *    counters, silently falsifying occupancy; MaxDeliver is editable post-create, so creation
 *    intent alone proves nothing at read time). An over-capacity verdict is the caller's
 *    durable `resource-exhausted` decision fact, never an accepted-and-stranded submission.
 *  - SERIAL admission ({@link virtualAdmissionConsumerConfig}): the virtual endpoint's
 *    canonicalizer durable pins `max_ack_pending: 1` BY CONSTRUCTION, so count → decide →
 *    enqueue cannot interleave across submissions (the race a concurrent admission pair would
 *    open). The pin is on the ADMISSION durable only: pool-worker execution concurrency is an
 *    independent knob, and occupancy already counts every worker's `num_ack_pending`.
 *  - ACTIVATION ({@link startVirtualActivator}): exact Consumer INFO is a request/reply
 *    SNAPSHOT — there is no broker wakeup — so watching is BOUNDED POLLING with backoff to a
 *    FINITE maximum interval, and an INFO failure is LOUD (the required `onError` seam) while
 *    polling continues. The activator's broker authority is exactly that INFO read; the start
 *    is a TARGET-BOUND mediated seam (`startInstance()`, fully bound at construction, no
 *    arguments to widen), and liveness is answered through a caller seam (`isLive()`), so the
 *    activator profile needs NO pool consume/ack, no stream read, no consumer create/delete
 *    (the smoke default-deny-greps this module for those tokens). Single-writer per identity
 *    is not re-fenced here: a duplicate start resolves at registration, where
 *    `registerServiceInstance`'s §13.1 issuance barrier and the instance-record CAS + epoch
 *    already serialize it.
 *  - RESTART-INTENSITY supervision ({@link noteInstanceRestart}): the restart history is
 *    DURABLE (it rides the instance's own `svc….status` record, so the supervisor's restart
 *    does not amnesty the count) and every note is a revision-pinned CAS (two concurrent notes
 *    can never merge-lose a restart). More than `maxRestarts` (default
 *    {@link RESTART_MAX_DEFAULT}) within `restartWindowMs` (default
 *    {@link RESTART_WINDOW_MS_DEFAULT}) escalates: the status records
 *    {@link SERVICE_ESCALATED} (further notes REFUSE — the instance stops restarting) and the
 *    caller's D13 retire seam (`retireLifecycle`, the §13.1 terminal barrier) is invoked. The
 *    seam is HONEST about its two halves: the escalated status commits durably first, and a
 *    retire-hook failure surfaces as `unavailable` with the status half already standing
 *    (retirement retries; it never un-escalates).
 *
 * Passivation is composition, not new machinery: drain, `writeServiceStatus` to
 * `SERVICE_EXITED`, exit; durable reminders ride the timer plane (`emitScheduleRequest`).
 */
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epwStreamName, poolDurable, canonConsumerConfig } from "./endpoint-binding.js";
import { AckPolicy, type ConsumerConfig } from "@nats-io/jetstream";
import {
  reconcileWorkItem,
  type WorkPoolContext,
  type WorkItemRef,
} from "./endpoint-work.js";
import {
  writeServiceStatus,
  parseServiceStatus,
  SERVICE_ESCALATED,
  SERVICE_EXITED,
  type ServiceStatus,
} from "./endpoint-service.js";
import { RECORD_KINDS, recordStatusKey } from "./endpoint-records.js";
import { assertLifecycleToken } from "./endpoint-subjects.js";

function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 virtual)`);
}
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// ---- occupancy (the shared reader: admission + activator) -------------------------------------

/** The pool's admission occupancy (§13.6): stored-and-uncounted states do not exist while the
 *  reader's invariants hold (WorkQueue retention + unlimited delivery + explicit ack). */
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
 * snapshot; leader-routed like every JS API call). FAIL CLOSED, never fabricated:
 *  - a missing or unreadable consumer is `unavailable` (an admission fence cannot treat
 *    ignorance as an empty pool);
 *  - a reported `max_deliver` other than -1 (unlimited) is `failed-precondition`: a message
 *    that exhausts a finite ceiling stays STORED but leaves both counters, so the sum would
 *    silently undercount; MaxDeliver is editable post-create, so this is checked at EVERY
 *    read, not trusted from creation ({@link poolConsumerConfig} pins -1 at create);
 *  - a non-explicit ack policy is `failed-precondition` (without an ack barrier,
 *    `num_ack_pending` does not mean "work still owned").
 */
export async function readPoolOccupancy(
  ctx: WorkPoolContext,
  endpoint: string,
  pool: string,
): Promise<PoolOccupancy> {
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
  if (info.config.ack_policy !== AckPolicy.Explicit)
    throw new EpEnvelopeError("failed-precondition", `pool consumer ${durable} reports ack_policy "${String(info.config.ack_policy)}", not explicit; without the ack barrier num_ack_pending does not mean owned work (SPEC 13.9)`);
  if (!uint(info.num_pending) || !uint(info.num_ack_pending))
    throw new EpEnvelopeError("internal", `pool consumer ${durable} reported non-integer counters (num_pending ${String(info.num_pending)}, num_ack_pending ${String(info.num_ack_pending)})`);
  return { pending: info.num_pending, ackPending: info.num_ack_pending, occupancy: info.num_pending + info.num_ack_pending };
}

// ---- the serial admission durable --------------------------------------------------------------

/**
 * The VIRTUAL endpoint's canonicalizer durable: {@link canonConsumerConfig} with
 * `max_ack_pending` PINNED to 1 (not an option — the pin is the point). One submission is in
 * the admission path at a time, so the count → decide → enqueue sequence is SERIAL and two
 * concurrent submissions cannot both observe the same free slot. Pool-worker execution
 * concurrency is untouched: occupancy already counts every worker's `num_ack_pending`, and the
 * worker durable keeps its own knobs.
 */
export function virtualAdmissionConsumerConfig(
  space: string,
  endpoint: string,
  opts: { ackWaitMs?: number } = {},
): Partial<ConsumerConfig> {
  return canonConsumerConfig(space, endpoint, { ackWaitMs: opts.ackWaitMs, maxAckPending: 1 });
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
  /** True iff the pool has a free slot under `capacity` AFTER repair. A false verdict is the
   *  caller's durable `resource-exhausted` decision fact (§13.6), not an error. */
  admitted: boolean;
  occupancy: PoolOccupancy;
  capacity: number;
  /** How many outstanding acceptances the pre-admission reconciliation re-enqueued. */
  repaired: number;
}

/**
 * The §13.6 admission fence, in the canonicalizer's decide path (admission BEFORE decision):
 *  1. RECONCILE the caller's outstanding acceptances first (`reconcileWorkItem` per item, the
 *     §13.6 predicate): an accepted item with no terminal, no settled lease, and no live pool
 *     entry is re-enqueued NOW, so repaired work is inside the count new work competes under
 *     (counting first would admit over it);
 *  2. read occupancy FRESH ({@link readPoolOccupancy}, fail-closed);
 *  3. verdict: `occupancy < capacity`.
 * The verdict is only serializable under the {@link virtualAdmissionConsumerConfig} pin
 * (`max_ack_pending: 1`): this function is one step of that serial loop, not a fence of its
 * own. Infrastructure failures THROW (`unavailable`/`failed-precondition`); only a genuine
 * over-capacity state returns `admitted: false`.
 */
export async function admitVirtualWork(
  ctx: WorkPoolContext,
  args: {
    endpoint: string;
    pool: string;
    /** The pool's declared admission bound (from the endpoint's activation policy). */
    capacity: number;
    /** The canonicalizer's own accepted-but-unsettled items (its journal redeliveries). */
    outstanding?: OutstandingAcceptance[];
    now: number;
  },
): Promise<VirtualAdmissionVerdict> {
  if (!Number.isSafeInteger(args.capacity) || args.capacity <= 0)
    invalid(`admission capacity ${String(args.capacity)} is not a positive integer`);
  if (!Number.isSafeInteger(args.now)) invalid(`now ${String(args.now)} is not an integer`);
  let repaired = 0;
  for (const o of args.outstanding ?? []) {
    const verdict = await reconcileWorkItem(ctx, { ref: o.ref, itemBytes: o.itemBytes, workExpiry: o.workExpiry, now: args.now });
    if (verdict.state === "re-enqueued") repaired++;
  }
  const occupancy = await readPoolOccupancy(ctx, args.endpoint, args.pool);
  return { admitted: occupancy.occupancy < args.capacity, occupancy, capacity: args.capacity, repaired };
}

// ---- the activator -----------------------------------------------------------------------------

export interface VirtualActivatorOpts {
  ctx: WorkPoolContext;
  endpoint: string;
  pool: string;
  /** The TARGET-BOUND mediated start seam: fully bound at construction (no arguments, so a
   *  compromised activator cannot redirect it), resolved by the supervisor/manager that holds
   *  the actual start authority. Idempotence against a concurrent start is the registration
   *  barrier's job, not this seam's. It MUST refuse an escalated identity (§13.6). */
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
  /** Stop polling. Idempotent; a start already in flight completes on its own. */
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
      infoErrors++;
      opts.onError("info", e);
      delay = Math.min(maxPollMs, delay * 2);
      schedule();
      return;
    }
    lastOccupancy = occ.occupancy;
    if (occ.occupancy > 0) {
      delay = pollMs; // work present: poll at base rate
      if (!startInFlight) {
        startInFlight = true;
        // Deliberately NOT awaited by the tick chain: a slow or wedged start must not stop the
        // polling that makes the wedge observable. The flag dedupes; errors surface via onError.
        void (async () => {
          try {
            if (!(await opts.isLive())) {
              starts++;
              await opts.startInstance();
            }
          } catch (e) {
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
/** The status field carrying the durable restart history (timestamps within the window). */
export const RESTART_HISTORY_FIELD = "restarts";

const td = new TextDecoder();

/**
 * Note one restart of a virtual instance, DURABLY and CAS-fenced (§13.6 supervision):
 *  - the restart history rides the instance's `svc….status` record, so a supervisor restart
 *    does not amnesty the count;
 *  - the write is pinned to the revision THIS call read (`expectedStatusRevision`), so two
 *    concurrent notes can never merge-lose a restart (one loses `conflict` and retries);
 *  - a stored {@link SERVICE_ESCALATED} state REFUSES (`failed-precondition`): the instance has
 *    stopped restarting, terminally;
 *  - more than `maxRestarts` timestamps within `restartWindowMs` (the pruned history plus this
 *    note) ESCALATES: the status commits {@link SERVICE_ESCALATED} first, then the caller's D13
 *    retire seam runs (`retireLifecycle`, the §13.1 terminal barrier). A retire failure is
 *    `unavailable` with the escalated status already durable — honest halves, the retirement
 *    retries, nothing un-escalates.
 * A non-escalating note records {@link SERVICE_EXITED} (the instance just died; its successor
 * writes `ready` itself when it registers) with the pruned history plus this note.
 */
export async function noteInstanceRestart(
  kv: KV,
  args: {
    endpoint: string;
    instanceId: string;
    /** The dying instance's epoch (still the mapping's current one until a successor activates). */
    epoch: number;
    now: number;
    maxRestarts?: number;
    restartWindowMs?: number;
    /** The trusted lifecycle-mapping reader (same seam as {@link writeServiceStatus}). */
    readProcessEpoch: () => Promise<number> | number;
    /** The D13/§13.1 terminal retire seam, invoked ONLY on escalation. */
    retireLifecycle: () => Promise<void>;
  },
): Promise<{ escalated: boolean; restartsInWindow: number }> {
  const maxRestarts = args.maxRestarts ?? RESTART_MAX_DEFAULT;
  const windowMs = args.restartWindowMs ?? RESTART_WINDOW_MS_DEFAULT;
  if (!Number.isSafeInteger(args.now) || args.now < 0) invalid(`now ${String(args.now)} is not an unsigned integer`);
  if (!Number.isSafeInteger(maxRestarts) || maxRestarts <= 0) invalid(`maxRestarts ${String(args.maxRestarts)} is not a positive integer`);
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) invalid(`restartWindowMs ${String(args.restartWindowMs)} is not a positive integer`);
  if (typeof args.retireLifecycle !== "function") invalid("retireLifecycle is required; escalation without terminal retirement is a half-fence");

  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  const key = recordStatusKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const stored = await kv.get(key);
  let prior: ServiceStatus | undefined;
  let expectedStatusRevision = 0;
  if (stored && stored.operation === "PUT") {
    prior = parseServiceStatus(JSON.parse(td.decode(stored.value)));
    expectedStatusRevision = stored.revision;
  } else if (stored && stored.operation !== "PUT") {
    throw new EpEnvelopeError("failed-precondition", `the status for "${args.endpoint}/${args.instanceId}" carries a ${stored.operation} marker; supervising over a deletion would resurrect authoritative state (SPEC 13.12)`);
  }
  if (prior?.state === SERVICE_ESCALATED)
    throw new EpEnvelopeError("failed-precondition", `"${args.endpoint}/${args.instanceId}" is escalated; the instance has stopped restarting and its lifecycle retires terminally (SPEC 13.6), a further restart note never applies`);

  const rawHistory = prior?.[RESTART_HISTORY_FIELD] ?? [];
  if (!Array.isArray(rawHistory) || !rawHistory.every((t) => Number.isSafeInteger(t) && t >= 0))
    throw new EpEnvelopeError("internal", `the stored restart history for "${args.endpoint}/${args.instanceId}" is garbled; a mediated-writer record that does not validate is a writer bug (SPEC 13.3)`);
  const pruned = (rawHistory as number[]).filter((t) => t <= args.now && args.now - t < windowMs);
  pruned.push(args.now);
  const escalated = pruned.length > maxRestarts;

  const status: ServiceStatus = {
    epoch: args.epoch,
    state: escalated ? SERVICE_ESCALATED : SERVICE_EXITED,
    observedSpecRevision: prior?.observedSpecRevision ?? 0,
    [RESTART_HISTORY_FIELD]: pruned,
  };
  await writeServiceStatus(kv, {
    endpoint: args.endpoint,
    instanceId: iId,
    epoch: args.epoch,
    status,
    readProcessEpoch: args.readProcessEpoch,
    expectedStatusRevision,
  });
  if (escalated) {
    try {
      await args.retireLifecycle();
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `"${args.endpoint}/${args.instanceId}" escalated durably (the status stands and blocks restarts) but the lifecycle retire seam failed; retirement must be retried, nothing un-escalates (SPEC 13.6/13.1): ${(e as Error)?.message ?? String(e)}`);
    }
  }
  return { escalated, restartsInWindow: pruned.length };
}
