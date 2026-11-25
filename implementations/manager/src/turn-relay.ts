import { jetstream } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError, rejectionText, digestIdToken, submissionFingerprint, goalRefOf,
  bindGoal, createGoal, recordGoalIndex, clearGoalIndex, readGoalResult, readGoalStatus,
  readGoalSpec, commitGoalResult, requestGoalCancel, goalAlreadyTerminal, transitionGoal,
  settleGoalUncertain, GOAL_TERMINAL_STATES, MAX_SCHEDULE_MS, mintCheckpoint,
  resumeCheckpoint, readCheckpointSettle, readCheckpointSpec, expireCheckpoint,
  type ActionContext, type GoalRef, type GoalIndexEntry, type GoalResultFact,
  type CheckpointSettleFact, type EpServeContext, type Connector,
} from "@cotal-ai/core";
import type { ManagedAgent } from "./manager.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";

/** Cadence of the turn-deadline sweep while turns are pending: the poll that turns an elapsed
 *  hold's fire into its expired settle and commits the deadline terminal. Deadlines are
 *  minutes-scale; a few seconds of lateness on the commit is invisible to the run. */
const TURN_SWEEP_MS = 5_000;
/** How long a settled turn's answer is kept so a RETRIED yield hears it instead of `not-found`.
 *  The window a lost reply is retried in is seconds; five minutes is generous for that and short
 *  enough that the map drains between bursts rather than growing for the process lifetime. */
export const TURN_ANSWER_RETENTION_MS = 5 * 60_000;
/** The cancel reason of an inherited once task whose spawn has no succeeded terminal. */
const NEVER_SERVED = "never served: the manager restarted before the spawn's readiness verdict";
/** Said by every settle of an inherited once task whose seat this manager does not hold. */
const UNHELD_SEAT = "the manager does not hold the seat; it may still be running";

/** The `turn` acceptance floor: the resolved seat incarnation the payload is addressed to, the
 *  goal coordinates the caller follows to the terminal, and the ABSOLUTE deadline the goal-bound
 *  hold is armed at - a follower bounds its wait on `deadlineAt`, never a relative window. */
export interface TurnAcceptance {
  name: string;
  owner: string;
  actor: string;
  uid: string;
  goalId: string;
  fingerprint: string;
  /** Absent only on a `once` task with no deadline. */
  deadlineAt?: number;
  executor: { lifecycleUid: string; epoch: number };
}

/** One relayed turn awaiting its seat's yield. `holdEpoch` is the ACCEPT-time serve epoch: the
 *  acceptance floor reports it as the executor epoch, so a restarted manager (whose current epoch
 *  moved on) carries it here - and in the index entry's note - to serve the same floor again. */
export interface PendingTurn {
  ref: GoalRef;
  goalId: string;
  seat: { name: string; owner: string; actor: string; uid: string };
  payload: string;
  acceptedAt: number;
  /** Absent only on a `once` task with no deadline: it never expires, and it has no hold. */
  deadlineAt?: number;
  holdToken?: string;
  holdEpoch: number;
  /** Set on the task of a `once` seat. It is not served before the spawn's readiness verdict, and
   *  its terminal stops the seat. */
  once?: { deliverable: boolean };
  /** The goal-chain link the caller declared (lang §5.3), mirrored into every terminal's data. */
  handoffFrom?: string;
  /** When the seat's `turn-pending` first served this turn. Until then the turn sweep repeats the
   *  seat's notice, because a seat that was offline when it went out never heard it. */
  pulledAt?: number;
  /** When the addressed seat incarnation was reaped, if it died before yielding. A dead target
   *  has NO early goal ending (a completion must prove the executor's LIVE currency, and the
   *  hold is only owner-expirable once due - SPEC 13.6 item 7), so the entry rides to its
   *  deadline; this stamp makes the deadline terminal say what actually happened. */
  seatDiedAt?: number;
}

/** The turn relay's durable half of a pending entry, riding the goal-index `note` (opaque to
 *  core): what a successor incarnation needs beyond the acceptance floor to rebuild the relay. */
interface TurnNote {
  payload: string;
  /** Absent only when `once` is set and the task has no deadline. */
  deadlineAt?: number;
  holdEpoch: number;
  /** The deadline hold's token. A note written before it was recorded has none: that hold's token
   *  was derived from the goal id alone, and adoption must find the hold actually minted. */
  holdToken?: string;
  handoffFrom?: string;
  /** The task of a `once` seat. Its index entry outlives the terminal until the seat's exit is
   *  proved, because a seat that may still be running the task is a debt a successor must settle. */
  once?: true;
  /** The connector whose {@link Connector.retireAfterExit} must prove a once seat's launched
   *  processes gone before its debt clears. */
  retire?: string;
  /** A once task's spawn goal id, under the task's own caller and endpoint. The task is served only
   *  after that goal's succeeded terminal is written, so a successor reads the terminal as whether
   *  it was. A note without it is treated as a task never served. */
  spawn?: string;
}

function parseTurnNote(raw: string): TurnNote | undefined {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return undefined; }
  if (o === null || typeof o !== "object") return undefined;
  const n = o as Record<string, unknown>;
  if (n.once !== undefined && n.once !== true) return undefined;
  if (typeof n.payload !== "string" || typeof n.holdEpoch !== "number") return undefined;
  if (typeof n.deadlineAt !== "number" && !(n.once === true && n.deadlineAt === undefined)) return undefined;
  if (n.holdToken !== undefined && typeof n.holdToken !== "string") return undefined;
  if (n.handoffFrom !== undefined && typeof n.handoffFrom !== "string") return undefined;
  if (n.retire !== undefined && (n.once !== true || typeof n.retire !== "string")) return undefined;
  if (n.spawn !== undefined && (n.once !== true || typeof n.spawn !== "string")) return undefined;
  return {
    payload: n.payload, holdEpoch: n.holdEpoch,
    ...(typeof n.deadlineAt === "number" ? { deadlineAt: n.deadlineAt } : {}),
    ...(typeof n.holdToken === "string" ? { holdToken: n.holdToken } : {}),
    ...(typeof n.handoffFrom === "string" ? { handoffFrom: n.handoffFrom } : {}),
    ...(n.once === true ? { once: true as const } : {}),
    ...(typeof n.retire === "string" ? { retire: n.retire } : {}),
    ...(typeof n.spawn === "string" ? { spawn: n.spawn } : {}),
  };
}

/** The seat whose launched processes a connector must prove gone before a once task's debt clears. */
export interface OnceRetire {
  connector: string;
  name: string;
  uid: string;
}

function retireOf(d: { seat: { name: string; uid: string }; retire?: string }): OnceRetire | undefined {
  return d.retire === undefined ? undefined : { connector: d.retire, name: d.seat.name, uid: d.seat.uid };
}

/** The relay record of a `once` task. The prompt is only ever the string value of `context`, so a
 *  prompt shaped like a run payload stays text and cannot add an `ask` or a `checkpoint`; the
 *  `once` block is the manager's, rendered by the seat beside the prompt. */
export function onceTurnNote(o: { prompt: string; spawner: string; deadlineAt?: number; holdEpoch: number; holdToken?: string; retire?: string; spawn: string }): { payload: string; note: string } {
  const payload = JSON.stringify({ context: o.prompt, once: { spawner: o.spawner, ...(o.deadlineAt !== undefined ? { deadlineAt: o.deadlineAt } : {}) } });
  const note = JSON.stringify({
    payload, holdEpoch: o.holdEpoch,
    ...(o.deadlineAt !== undefined ? { deadlineAt: o.deadlineAt } : {}),
    ...(o.holdToken !== undefined ? { holdToken: o.holdToken } : {}),
    once: true,
    ...(o.retire !== undefined ? { retire: o.retire } : {}),
    spawn: o.spawn,
  } satisfies TurnNote);
  return { payload, note };
}

/** A turn hold's token, DERIVED from the relay key, so two callers' turns under one goal id never
 *  share a hold. */
export function turnHoldToken(key: string): string {
  return digestIdToken(`${key}:turn-deadline`);
}

/** A goal's caller-scoped relay key. */
export function goalKey(ref: GoalRef): string {
  return `${ref.caller.owner}.${ref.caller.actor}.${ref.caller.uid}.${ref.goalId}`;
}

/** A caught value as a lifecycle envelope, or undefined when it is not one. A thrown Proxy can throw
 *  from `instanceof` itself, so the test runs inside the guard. */
export function caughtEnvelope(e: unknown): EpEnvelopeError | undefined {
  try {
    return e instanceof EpEnvelopeError ? e : undefined;
  } catch {
    return undefined;
  }
}

/** Current goal authority and exact-seat lifecycle operations used by the turn relay. */
export interface TurnRelayDeps {
  /** Returns the current standing goal authority, absent before start and after stop. */
  goalWriter(): { ctx: ActionContext } | undefined;
  /** Returns the current serving connection and its active issuance epoch. */
  serviceServe(): { nc: NatsConnection; grant: { epoch: number } } | undefined;
  /** The configured space is fixed before the relay is constructed. */
  readonly space: string;
  /** Reads the current persisted instance id, which startup resolves after manager construction. */
  managerInstanceId(): string;
  /** The admitted execution mode is fixed for this manager. */
  readonly execution: "runtime" | "none";
  /** The fixed workload refusal is the same literal the manager control boundary returns. */
  readonly executionRefusal: string;
  /** Manager writes this boot gate only after enumerating and reconciling inherited goals. */
  goalReconcileDone(): boolean;
  /** Returns the manager readiness budget at the time inherited work is examined. */
  readinessTimeoutMs(): number;
  /** Reads the current signing-trust and user-mode fields before checking inherited seat custody. */
  adoptsSeats(): boolean;
  /** Reports whether static reconciliation still owes a verdict for this exact lifecycle. */
  onceSeatReconciling(uid: string): boolean;
  /** Refuses terminal writes whose accepted epoch is no longer current. */
  assertGoalWriterEpochCurrent(epoch: number): Promise<void>;
  /** Publishes advisory progress without changing the durable terminal outcome. */
  emitGoalProgress(ref: GoalRef, epoch: number, event: Record<string, unknown>): void;
  /** Notifies only the addressed incarnation over its current issued generation. */
  noticeSeatTurns(seat: PendingTurn["seat"]): void;
  /** Returns zero only for the current managed seat or personal participant, otherwise null. */
  turnExecutorEpoch(name: string, owner: string, actor: string, uid: string): number | null;
  /** Stops only the addressed once incarnation and preserves a completed readiness verdict. */
  endOnceSeat(pending: PendingTurn, reason: string): void;
  /** Resolves only an exact owner, actor and lifecycle match in managed custody. */
  findManagedByTarget(target: { owner: string; actor: string; lifecycleUid: string }): ManagedAgent | undefined;
  /** Stops the owned once seat and reaps its own helpers through normal lifecycle hooks. */
  stopOnceSeat(agent: ManagedAgent, reason: string): void;
  /** Records an exit watch that settles this seat task only after proved process exit. */
  watchOnceExit(agent: ManagedAgent): void;
  /** Requires connector proof of launched-work closure before returning a discard receipt. */
  retireOnceSeat(seat: OnceRetire): Promise<{ discard(): Promise<void> }>;
  /** Removes only the completed task key from the manager exit-watch index. */
  forgetOnceWatch(key: string): void;
}

/** Pending relays, retry answers, deadline sweeps and once-task debts for this manager. */
export class TurnRelay {
  /**
   * The turn relay's same-incarnation idempotency map ({@link goalAcceptances}'s twin), by
   * {@link goalKey}: a same-goal retry serves the identical acceptance; cross-incarnation retries
   * rebuild from the goal-index entry (its acceptance floor + note).
   *
   * One entry per turn this incarnation accepted: the acceptance a duplicate submission is served
   * from, and - once the turn settles - the answer a RETRIED yield is served from.
   *
   * A yield's reply can be lost, and the retry used to find the pending turn already deleted and
   * hear `not-found`, which a seat reads as "drop it": failure reported for work that committed.
   * The settled answer lives here for a bounded window instead, and the sweep drops it after,
   * which is also what keeps this map from being one entry per turn for the process lifetime.
   *
   * `ref` is the goal coordinates the durable terminal is published under. A late yield that
   * arrives after pendingTurns is gone and before `settled` is remembered (or after a concurrent
   * sweep dropped the settled field) still has to name that terminal, never `not-found`. The
   * index entry is not that answer: it is cleared at commit, and the yield path never consults it.
   *
   * `leftoverSince` is when the pending latch dropped. An unsettled leftover ages off that stamp,
   * never off `acceptance.deadlineAt`: a turn that expired after a long outage would otherwise be
   * pruned on the first sweep tick, taking the GoalRef with it, and a late yield in the retry
   * window would hear `not-found` again.
   */
  private turnAcceptances = new Map<string, { acceptance: TurnAcceptance; ref?: GoalRef; leftoverSince?: number; settled?: { state: string; at: number } }>();
  /** Every relayed turn awaiting its seat's yield, by {@link goalKey}. The seat's `turn-pending` pull
   *  scans it; the deadline sweep drives expiry; a seat reap stamps its entries `seatDiedAt`, which
   *  the deadline terminal carries as `agentDownAt` so the run reads that death as L4002.
   *  Rebuilt at boot from goal-index entries carrying a turn note. */
  private pendingTurns = new Map<string, PendingTurn>();
  /** The deadline sweep behind {@link pendingTurns}: takes the hold's fire into an expired
   *  settle and commits the deadline terminal. Unref'd; idle when no turn is pending. */
  private turnSweepTimer?: ReturnType<typeof setInterval>;
  /** Once tasks whose ending is owed, by {@link goalKey}: the task can no longer run (its seat's
   *  exit is proved, or it was never served), so it is cancelled if it has no terminal and its index
   *  entry is dropped. A settle that fails stays here and the turn sweep retries it. */
  private readonly onceSettles = new Map<string, { ref: GoalRef; reason: string; retire?: OnceRetire; flight?: Promise<void> }>();
  /** Once tasks a predecessor accepted, by seat uid, until this incarnation binds the seat or
   *  proves it gone. `readinessMs` bounds how long a seat no reconcile here can account for is
   *  waited for. */
  private readonly onceInherited = new Map<string, { ref: GoalRef; seat: { name: string; owner: string; actor: string; uid: string }; deadlineAt?: number; readinessMs: number; retire?: string }>();
  /** Inherited once seats this manager does not hold whose task has a terminal, by lifecycle uid.
   *  Every pull from one is answered `stop`, and its notice repeats until a pull has carried it. */
  private readonly onceStops = new Map<string, { owner: string; actor: string; name: string; uid: string; told?: true }>();
  /** When the goal reconcile finished: the start of an inherited once task's wait for its seat. */
  private goalReconcileDoneAt = 0;

  constructor(private readonly deps: TurnRelayDeps) {}

  private get goalWriter(): ReturnType<TurnRelayDeps["goalWriter"]> { return this.deps.goalWriter(); }
  private get serviceServe(): ReturnType<TurnRelayDeps["serviceServe"]> { return this.deps.serviceServe(); }
  private get goalReconcileDone(): boolean { return this.deps.goalReconcileDone(); }

  markReconciled(at: number): void { this.goalReconcileDoneAt = at; }

  hasAcceptance(key: string): boolean { return this.turnAcceptances.has(key); }

  pendingForSeat(c: { owner: string; actor: string; uid: string }): PendingTurn | undefined {
    return [...this.pendingTurns.values()].find((p) => p.seat.owner === c.owner && p.seat.actor === c.actor && p.seat.uid === c.uid);
  }

  pendingSeats(): PendingTurn["seat"][] {
    return [...new Map([...this.pendingTurns.values()].map((p) => [`${p.seat.owner}.${p.seat.actor}.${p.seat.uid}`, p.seat])).values()];
  }

  // ---- the turn relay (§8 durable actions) ------------------------------------------------------
  //
  // A seat is NOT an endpoint: a run's `turn(agent, payload)` rides the manager, which accepts it
  // as a goal (the spawn-as-action pattern minus the launch closure), parks the payload durably on
  // the goal-index entry's note, and lets the seat PULL it (`turn-pending`) and answer it
  // (`turn-yield`) under its own `manager.self` reach. The deadline is a goal-bound HOLD minted at
  // accept: the delivery daemon's timer writer pumps its schedule, the fire settles it `expired`,
  // and THIS manager commits the deny (`hold-expired` is the predicate core verifies). Three
  // endings, one each: yield -> succeeded (the TurnResult rides the terminal's data), deadline ->
  // failed `turn-deadline`, and a seat death before that is stamped by the reap hook so the same
  // terminal carries `agentDownAt` (the run reads it as L4002). The adoption sweep stamps nothing.

  /** Accept one `turn` goal against a live managed seat. Mirrors {@link serveSpawnGoal}'s accept
   *  path (idempotent retry map, index-CAS-before-bind, create-only bindGoal) but runs it INLINE:
   *  there is no launch to hand off, so the accept either completes durably or unwinds its own
   *  bound goal with a `failed` terminal before refusing. */
  async serveTurnGoal(
    ctx: EpServeContext,
    target: { kind: "managed"; agent: Pick<ManagedAgent, "once">; name: string } | { kind: "personal"; name: string },
  ): Promise<TurnAcceptance> {
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing; turn-as-action cannot accept (SPEC 13.6)");
    const serve = this.serviceServe;
    if (!serve) throw new EpEnvelopeError("unavailable", "the manager service endpoint is not serving; a turn's deadline hold is armed over its connection (SPEC 13.9)");
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; retry shortly (SPEC 13.6)");
    const t = ctx.request.target!; // targeted command: the serve boundary enforced presence + currency
    const name = target.name;
    const goalId = ctx.request.id;
    const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
    const ref = goalRefOf(ctx.subject, goalId);
    const key = goalKey(ref);
    const executor = { lifecycleUid: this.deps.managerInstanceId(), epoch: this.serviceServe?.grant.epoch ?? 0 };
    const acceptedAt = Date.now();

    const prior = this.turnAcceptances.get(key)?.acceptance;
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint)
        throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission; one goalId never carries two specs (SPEC 13.6)`);
      return prior;
    }
    // Refused here, before anything durable, so the caller's goal id stays free for another seat.
    this.assertSeatTurnFree(name, t, goalId);
    if (target.kind === "managed" && target.agent.once)
      throw new EpEnvelopeError("failed-precondition", `seat "${name}" is a once seat; it takes only the task it was spawned with`, undefined, "not-executed");

    const raw = (ctx.request.args ?? {}) as Record<string, unknown>;
    const payload = String(raw.payload);
    const deadlineAt = raw.deadlineAt === undefined ? acceptedAt + Number(raw.deadlineMs) : Number(raw.deadlineAt);
    if (deadlineAt <= acceptedAt)
      throw new EpEnvelopeError("deadline-exceeded", `goal "${goalId}" names a deadline already past (${new Date(deadlineAt).toISOString()}); a turn with no time left to serve it is never accepted (SPEC 13.6)`);
    const deadlineMs = deadlineAt - acceptedAt;
    const handoffFrom = raw.handoffFrom === undefined ? undefined : String(raw.handoffFrom);
    const holdToken = turnHoldToken(key);
    const note = JSON.stringify({ payload, deadlineAt, holdEpoch: executor.epoch, holdToken, ...(handoffFrom !== undefined ? { handoffFrom } : {}) } satisfies TurnNote);

    // A goal that already ENDED is never accepted again, whatever the retry carries: the bind is
    // create-only and outlives an unwind (the failed terminal, the cleared index), so a retry of an
    // unwound accept would otherwise re-record an index entry over a tombstone and, before that
    // check existed, be served an acceptance rebuilt from it — a live deadline on a turn no seat
    // would ever be shown. The terminal is the durable answer, and it is read before anything is
    // written.
    const ended = await readGoalResult(gw.ctx, ref);
    if (ended !== undefined)
      throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" already ended ${ended.state}; a bound goal is never accepted again (SPEC 13.6)`);
    // Index-CAS-before-bind, exactly as spawn: the entry (floor + note) is the durable relay
    // record a successor rebuilds from, so it must exist before the acceptance is servable.
    const idx = await recordGoalIndex(gw.ctx, ref, executor.lifecycleUid, { name, owner: t.owner, actor: t.actor, uid: t.lifecycleUid, readinessDeadlineMs: deadlineMs }, note);
    if (!idx.recorded && idx.existing.iid !== executor.lifecycleUid)
      throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted by instance "${idx.existing.iid}"; that instance owns its relay and this attempt provisions nothing (SPEC 13.6)`);
    const b = await bindGoal(gw.ctx, ref, fingerprint);
    if (!b.bound) {
      if (b.existing.fingerprint !== fingerprint)
        throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound to a different submission; one goalId never carries two specs (SPEC 13.6)`);
      // Same submission, bound, not ended, and not in the acceptance map. Every relay this
      // incarnation holds is in that map (the accept path and the boot sweep both write it), so
      // this is a goal nobody is relaying: an earlier attempt bound it and could not finish its
      // unwind, or a predecessor's relay was left unadopted. Nothing here can rebuild a relay a
      // seat will be shown, so the caller is refused rather than served an acceptance no pending
      // entry backs; the index entry this attempt recorded is withdrawn with it.
      if (idx.recorded) await clearGoalIndex(gw.ctx, ref);
      throw new EpEnvelopeError("unavailable", `goal "${goalId}" is bound but no relay of it is pending on this instance; retry (SPEC 13.6)`);
    }
    try {
      await createGoal(gw.ctx, ref, {
        fingerprint,
        command: ctx.subject.command,
        caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
        acceptedEpoch: executor.epoch,
        requestId: goalId,
        sourceSeq: 0,
        acceptedAt,
        readinessDeadlineMs: deadlineMs,
        // The §13.6 target pin: the seat INCARNATION this payload is addressed to. A successor
        // under the same name is a different addressee; its uid differs and the pin holds that.
        target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid, mappingRevision: 0 },
      });
      // The deadline, as a goal-bound hold on the plane: its EXPIRED settle is the one predicate
      // `commitGoalResult` accepts for the deny. The record rides the goal-writer's KV; the
      // `.schedule` request rides the SERVE connection, because the timer row is the serving
      // instance's own (`ept.<e>.<iid>.<epoch>.*.schedule`, SPEC 13.9) and the goal-writer holds
      // none. Measured on an auth mesh: minted over the goal-writer, the schedule publish was
      // broker-denied and every accept unwound.
      await mintCheckpoint(gw.ctx.kv, jetstream(serve.nc), this.deps.space, {
        ref: { endpoint: ref.endpoint, token: holdToken },
        instanceId: this.deps.managerInstanceId(),
        epoch: executor.epoch,
        goal: { caller: { owner: ctx.subject.caller.owner, actor: ctx.subject.caller.actor, uid: ctx.subject.caller.uid }, goalId },
        holder: { id: MANAGER_ENDPOINT, lifecycleUid: this.deps.managerInstanceId() },
        deadline: deadlineAt,
        now: acceptedAt,
      });
      // Again after the awaits, with no await before the maps are written: another caller's
      // accept of this id to this seat may have finished meanwhile, and this unwinds the loser.
      this.assertSeatTurnFree(name, t, goalId);
    } catch (e) {
      // The accept is inline (no launch closure to fail later), so a post-bind throw unwinds HERE:
      // commit the failed terminal this attempt owns, clear the index, and refuse the accept — an
      // accepted-but-unanswered goal must never be left for the boot sweep to find (H1's rule).
      const msg = rejectionText(e);
      try {
        await this.deps.assertGoalWriterEpochCurrent(executor.epoch);
        // The goal is TARGET-PINNED, so its completion proves the seat's currency exactly as the
        // yield's does (managed-seat epochs are 0 within an incarnation; the resolver answers from
        // the live agents map). Committed without it, core refused the terminal and the unwind
        // left a bound goal with no ending for every retry to find.
        await commitGoalResult(gw.ctx, {
          ref, now: Date.now(), cause: "complete", state: "failed", data: { error: msg },
          committer: { instanceId: this.deps.managerInstanceId(), epoch: executor.epoch },
          executor: { lifecycleUid: t.lifecycleUid, epoch: 0 },
          resolveCurrentEpoch: (current) => this.deps.turnExecutorEpoch(name, t.owner, t.actor, current.lifecycleUid),
        });
        await clearGoalIndex(gw.ctx, ref);
      } catch (e2) { console.error(`! turn accept unwind for ${goalId}: ${rejectionText(e2)}`); }
      throw caughtEnvelope(e) ?? new EpEnvelopeError("internal", `turn accept for ${goalId} failed: ${msg}`);
    }
    const pending: PendingTurn = {
      ref, goalId,
      seat: { name, owner: t.owner, actor: t.actor, uid: t.lifecycleUid },
      payload, acceptedAt, deadlineAt,
      holdToken, holdEpoch: executor.epoch,
      ...(handoffFrom !== undefined ? { handoffFrom } : {}),
    };
    this.pendingTurns.set(key, pending);
    this.ensureTurnSweep();
    this.deps.noticeSeatTurns(pending.seat);
    const acceptance: TurnAcceptance = { name, owner: t.owner, actor: t.actor, uid: t.lifecycleUid, goalId, fingerprint, deadlineAt, executor };
    this.turnAcceptances.set(key, { acceptance, ref });
    this.deps.emitGoalProgress(ref, executor.epoch, { phase: "relayed" });
    return acceptance;
  }
  /** The seat's pull: every pending turn addressed to the CALLER's incarnation, oldest first.
   *  The uid is part of the address - a successor seat never receives a predecessor's turn. */
  turnPendingFor(c: { owner: string; actor: string; uid: string }): { turns: { goalId: string; payload: string; acceptedAt: number; deadlineAt?: number; once?: true }[]; notices: true; stop?: true } {
    // AN EMPTY LIST IS AN ANSWER, so it must not be given before the index is rebuilt. Between
    // registration and `reconcileGoalIndex`, `pendingTurns` holds nothing a predecessor accepted,
    // and a seat that pulls in that window is told authoritatively that it has no turn. The seat
    // treats a refusal as "keep what you hold" and an empty list as "you hold nothing", so the
    // window has to refuse, the same way `serveTurnGoal` does.
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; the pending-turn index is not rebuilt yet, retry (SPEC 13.6)");
    // A once seat this manager does not hold, whose task has ended, is told to end itself. Nothing
    // else rides that answer, and the settled task is never served again.
    const stop = this.onceStops.get(c.uid);
    if (stop !== undefined && stop.owner === c.owner && stop.actor === c.actor) {
      stop.told = true;
      return { turns: [], notices: true, stop: true };
    }
    // Two turns on one seat are serialized at the dispatch (cotal-lang 6.5): only the oldest
    // unsettled one is served, and the next surfaces once it yields or its deadline denies, so a
    // seat is never shown two turns at once.
    // An ELAPSED turn is not servable: its hold is expirable and its run has already thrown from
    // its own pause, so handing it to the seat buys work whose yield is refused. It also cannot be
    // allowed to stay the head, or one expired turn dams every later turn for that seat. A once
    // task is not served before its spawn's readiness verdict, and one with no deadline never
    // elapses.
    const now = Date.now();
    const head = [...this.pendingTurns.values()]
      .filter((p) => p.seat.owner === c.owner && p.seat.actor === c.actor && p.seat.uid === c.uid)
      .filter((p) => (p.deadlineAt === undefined || now < p.deadlineAt) && p.once?.deliverable !== false)
      .sort((x, y) => x.acceptedAt - y.acceptedAt)
      .slice(0, 1);
    for (const p of head) p.pulledAt ??= now;
    const turns = head.map((p) => ({ goalId: p.goalId, payload: p.payload, acceptedAt: p.acceptedAt, ...(p.deadlineAt !== undefined ? { deadlineAt: p.deadlineAt } : {}), ...(p.once ? { once: true as const } : {}) }));
    return { turns, notices: true };
  }
  /** A seat names a turn by goal id alone when it yields, so one incarnation holding two callers'
   *  turns under one id could not say which of the two it answered. */
  private assertSeatTurnFree(name: string, t: { owner: string; actor: string; lifecycleUid: string }, goalId: string): void {
    if (this.seatTurnKey({ owner: t.owner, actor: t.actor, uid: t.lifecycleUid }, goalId) !== undefined)
      throw new EpEnvelopeError("failed-precondition", `seat "${name}" already holds another caller's turn "${goalId}"; a seat yields by goal id, so it is never handed two turns under one (SPEC 13.6)`);
  }
  /** The relay key of the turn addressed to seat incarnation `c` under `goalId`, pending or kept
   *  for a retried yield. The accept path never hands one incarnation two turns under one goal
   *  id, so at most one matches. */
  private seatTurnKey(c: { owner: string; actor: string; uid: string }, goalId: string): string | undefined {
    for (const [key, { acceptance: a }] of this.turnAcceptances)
      if (a.goalId === goalId && a.owner === c.owner && a.actor === c.actor && a.uid === c.uid) return key;
    return undefined;
  }
  /** The seat's yield: claim the hold (one-use; expiry fails closed), then commit the goal
   *  `succeeded` carrying the TurnResult. A yield AFTER the deadline drives the deadline terminal
   *  instead and refuses - the expiry outcome stands, never a late success over it. */
  async serveTurnYield(c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>): Promise<{ goalId: string; state: string }> {
    if (this.deps.execution === "none") throw new EpEnvelopeError("unimplemented", this.deps.executionRefusal);
    // Same boot window as the pull, and checked first because it is the earlier boot phase: before
    // the index is rebuilt a predecessor's accepted turn is not in `pendingTurns`, and `not-found`
    // would tell the seat to drop work it is holding.
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; this yield's turn may not be indexed yet, retry (SPEC 13.6)");
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing (SPEC 13.6)");
    const goalId = String(raw.goalId);
    const status = String(raw.status);
    const to = raw.to === undefined ? undefined : String(raw.to);
    const yieldNote = raw.note === undefined ? undefined : String(raw.note);
    if (status === "handoff" && (to === undefined || to.length === 0))
      throw new EpEnvelopeError("failed-precondition", `a handoff yield names its addressee ("to"); a handoff to nobody relays nothing`);
    const key = this.seatTurnKey(c, goalId);
    if (key === undefined) throw new EpEnvelopeError("not-found", `no pending turn "${goalId}" on this manager`);
    const p = this.pendingTurns.get(key);
    if (!p) return this.settledTurnAnswer(key, goalId);
    await this.claimTurnHold(p);
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    await this.deps.assertGoalWriterEpochCurrent(epoch);
    const at = Date.now();
    const data = { status, ...(to !== undefined ? { to } : {}), ...(yieldNote !== undefined ? { note: yieldNote } : {}), ...(p.handoffFrom !== undefined ? { handoffFrom: p.handoffFrom } : {}), at };
    // The goal is TARGET-PINNED, so this completion proves the EXECUTOR's (the seat's) fresh
    // currency, not the manager's: managed-seat epochs are 0 within an incarnation (the same
    // convention resolveTarget serves), and the resolver answers from the live agents map — a
    // seat that died between its yield call and this commit refuses `expired` here.
    const { fact } = await commitGoalResult(gw.ctx, {
      ref: p.ref, now: at, cause: "complete", state: "succeeded", data,
      committer: { instanceId: this.deps.managerInstanceId(), epoch },
      executor: { lifecycleUid: p.seat.uid, epoch: 0 },
      resolveCurrentEpoch: (target) => this.deps.turnExecutorEpoch(p.seat.name, p.seat.owner, p.seat.actor, target.lifecycleUid),
    });
    this.deps.emitGoalProgress(p.ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
    // A once task's index entry is its seat's debt, dropped at the seat's proved exit.
    if (!p.once) await clearGoalIndex(gw.ctx, p.ref);
    this.pendingTurns.delete(key);
    this.deps.noticeSeatTurns(p.seat);
    this.markTurnLatchDropped(key, at);
    this.rememberSettledTurn(key, fact.state, at);
    if (p.once) this.deps.endOnceSeat(p, `yielded ${status}`);
    this.maybeStopTurnSweep();
    return { goalId, state: fact.state };
  }
  /** A seat's answer for a turn no longer pending. A REPLY THAT WAS LOST IS NOT AN ANSWER THAT
   *  FAILED: the commit deleted the pending turn, so a retry found nothing and heard `not-found`,
   *  which a seat reads as "drop it", reporting failure for work the run already has. The answer
   *  the first reply carried is served again instead, to the addressee it was addressed to and
   *  nobody else. */
  private async settledTurnAnswer(key: string, goalId: string): Promise<{ goalId: string; state: string }> {
    const settled = this.turnAcceptances.get(key);
    if (settled !== undefined) {
      if (settled.settled !== undefined) return { goalId, state: settled.settled.state };
      // The in-memory answer is not yet remembered (pending deleted before the terminal CAS,
      // or a concurrent sweep dropped `settled` while the commit was still in flight). The
      // durable terminal is the one the run already has; name it, never `not-found`.
      if (settled.ref !== undefined && this.goalWriter) {
        const ended = await readGoalResult(this.goalWriter.ctx, settled.ref);
        if (ended !== undefined) {
          this.rememberSettledTurn(key, ended.state, ended.ts);
          return { goalId, state: ended.state };
        }
      }
    }
    throw new EpEnvelopeError("not-found", `no pending turn "${goalId}" on this manager`);
  }
  /** Claim a pending turn's deadline hold before the seat's answer commits: one use, and a hold
   *  that already expired drives the deadline terminal instead and refuses the answer. A once task
   *  with no deadline has no hold. */
  private async claimTurnHold(p: PendingTurn): Promise<void> {
    if (p.holdToken === undefined) return;
    const gw = this.goalWriter!;
    const cpRef = { endpoint: p.ref.endpoint, token: p.holdToken };
    try {
      await resumeCheckpoint(gw.ctx.kv, gw.ctx.js, gw.ctx.jsm, this.deps.space, { ref: cpRef, presenter: { id: MANAGER_ENDPOINT, lifecycleUid: this.deps.managerInstanceId() }, now: Date.now() });
    } catch (e) {
      const settle = await readCheckpointSettle(gw.ctx.jsm, this.deps.space, cpRef).catch(() => undefined);
      if (settle?.settle === "expired") {
        await this.commitTurnDeadline(p);
        throw new EpEnvelopeError("failed-precondition", `turn "${p.goalId}" elapsed its deadline before the seat answered; the deadline terminal stands (SPEC 13.6)`);
      }
      // Already resumed BY THIS MANAGER (the hold is holder-bound): a prior attempt claimed it
      // and then failed to commit. Fall through and commit; the claim is ours to finish.
      if (settle?.settle !== "resumed") throw e;
    }
  }
  /** A once seat's report that its task's handoff to its harness was not confirmed. The seat sealed
   *  the task before it reported, so nothing hands it over again; the task fails
   *  `delivery-unconfirmed` and the seat is stopped. The commit proves the seat's live currency, as
   *  a yield's does: a seat already gone commits nothing here, and its exit cancels the task. Only
   *  the addressed seat may report, only for its once task; a repeat after the terminal is answered
   *  with it. */
  async serveTurnUnconfirmed(c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>): Promise<{ goalId: string; state: string }> {
    if (this.deps.execution === "none") throw new EpEnvelopeError("unimplemented", this.deps.executionRefusal);
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; this report's turn may not be indexed yet, retry (SPEC 13.6)");
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing (SPEC 13.6)");
    const goalId = String(raw.goalId);
    const key = this.seatTurnKey(c, goalId);
    if (key === undefined) throw new EpEnvelopeError("not-found", `no pending turn "${goalId}" on this manager`);
    const p = this.pendingTurns.get(key);
    if (!p) return this.settledTurnAnswer(key, goalId);
    if (!p.once)
      throw new EpEnvelopeError("failed-precondition", `turn "${goalId}" is a run's turn; turn-unconfirmed reports only a once task, and a run's turn is offered again`);
    await this.claimTurnHold(p);
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    await this.deps.assertGoalWriterEpochCurrent(epoch);
    const at = Date.now();
    const { fact } = await commitGoalResult(gw.ctx, {
      ref: p.ref, now: at, cause: "complete", state: "failed", data: { reason: "delivery-unconfirmed", at },
      committer: { instanceId: this.deps.managerInstanceId(), epoch },
      executor: { lifecycleUid: p.seat.uid, epoch: 0 },
      resolveCurrentEpoch: (target) => this.deps.turnExecutorEpoch(p.seat.name, p.seat.owner, p.seat.actor, target.lifecycleUid),
    });
    this.deps.emitGoalProgress(p.ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
    this.pendingTurns.delete(key);
    this.deps.noticeSeatTurns(p.seat);
    this.markTurnLatchDropped(key, at);
    this.rememberSettledTurn(key, fact.state, at);
    this.deps.endOnceSeat(p, "delivery-unconfirmed");
    this.maybeStopTurnSweep();
    return { goalId, state: fact.state };
  }
  /** The caller withdraws a turn it submitted (the reserved `cancel`, SPEC 13.6 item 4), so the
   *  seat is not shown it again and a late yield is answered from the cancelled terminal. Only a
   *  relay this incarnation holds is moved to `cancelling`, because only its holder can commit the
   *  terminal; an ended goal is refused with its cached outcome, which keeps a repeated cancel
   *  idempotent. The pending entry is the latch the yield and the deadline sweep race on, taken
   *  before the first await so a concurrent cancel finds nothing to take. A failed cancel puts it
   *  back so the relay still ends at its deadline, unless something ended the relay while it was
   *  held: a yield that read the entry first, or this commit with only its reply lost. An entry
   *  whose outcome cannot be read back stays out and converges through the goal index at the
   *  next boot, as a failed deadline commit does. */
  async serveTurnCancel(ctx: EpServeContext): Promise<{ goalId: string; state: string }> {
    if (this.deps.execution === "none") throw new EpEnvelopeError("unimplemented", this.deps.executionRefusal);
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; the pending-turn index is not rebuilt yet, retry (SPEC 13.6)");
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing (SPEC 13.6)");
    const raw = (ctx.request.args ?? {}) as Record<string, unknown>;
    const goalId = String(raw.goalId);
    const ref = goalRefOf(ctx.subject, goalId);
    const key = goalKey(ref);
    const p = this.pendingTurns.get(key);
    if (p === undefined) {
      const ended = await readGoalResult(gw.ctx, ref);
      if (ended !== undefined) throw goalAlreadyTerminal(goalId, ended);
      throw new EpEnvelopeError("failed-precondition", `no turn "${goalId}" of this caller is pending on this manager; cancel withdraws a relayed turn (SPEC 13.6)`);
    }
    this.pendingTurns.delete(key);
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    let fact: GoalResultFact;
    try {
      await requestGoalCancel(gw.ctx, { request: ctx.subject, goalId, mode: (raw.mode ?? "graceful") as "graceful" | "terminate" });
      await this.deps.assertGoalWriterEpochCurrent(epoch);
      ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "cancel", data: { cancelledBy: "caller" }, committer: { instanceId: this.deps.managerInstanceId(), epoch } }));
    } catch (e) {
      // The remembered answer is read after the durable one, with no await before the put back:
      // a yield that has dropped the entry remembered its answer, and one still committing drops
      // the entry it finds. An ended relay is stamped so its acceptance still ages off.
      if ((await readGoalResult(gw.ctx, ref)) !== undefined) this.markTurnLatchDropped(key);
      else if (this.turnAcceptances.get(key)?.settled === undefined) this.pendingTurns.set(key, p);
      throw e;
    }
    this.deps.emitGoalProgress(ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
    this.deps.noticeSeatTurns(p.seat);
    this.markTurnLatchDropped(key);
    this.rememberSettledTurn(key, fact.state, Date.now());
    if (p.once) this.deps.endOnceSeat(p, "cancelled");
    else await clearGoalIndex(gw.ctx, ref);
    this.maybeStopTurnSweep();
    return { goalId, state: fact.state };
  }
  /** Commit the deadline terminal for one pending turn whose hold settled EXPIRED: the deny's
   *  predicate is that recorded settle, verified by core against the spec's goal binding. The map
   *  delete is the idempotency latch (yield-loss and sweep race here); a commit failure after it
   *  converges through the goal index at the next boot, the same narrow leg spawn leaves open. */
  private async commitTurnDeadline(p: PendingTurn): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    const key = goalKey(p.ref);
    if (!this.pendingTurns.delete(key)) return;
    this.deps.noticeSeatTurns(p.seat);
    this.markTurnLatchDropped(key);
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    try {
      await this.deps.assertGoalWriterEpochCurrent(epoch);
      const { fact } = await commitGoalResult(gw.ctx, { ref: p.ref, now: Date.now(), cause: "deny", denial: { kind: "hold-expired", token: p.holdToken! }, data: { reason: "turn-deadline", ...(p.seatDiedAt !== undefined ? { agentDownAt: p.seatDiedAt } : {}), ...(p.handoffFrom !== undefined ? { handoffFrom: p.handoffFrom } : {}), ...(this.onceSeatUnheld(p) ? { seat: UNHELD_SEAT } : {}) }, committer: { instanceId: this.deps.managerInstanceId(), epoch } });
      this.deps.emitGoalProgress(p.ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
      // Remember BEFORE the index clear: a late yield that arrives after the pending latch
      // (the delete at the top of this function) and after this CAS has to name this terminal.
      // Clearing first, then remembering, left a window where maybeStopTurnSweep saw no pending
      // turn and no settled answer, wiped the acceptance, and rememberSettledTurn no-op'd.
      this.rememberSettledTurn(key, fact.state, Date.now());
      if (p.once) this.deps.endOnceSeat(p, "turn-deadline");
      else await clearGoalIndex(gw.ctx, p.ref);
    } catch (e) {
      console.error(`! turn deadline terminal for ${p.goalId}: ${rejectionText(e)}`);
      // A once seat stops at its deadline whether or not the terminal landed, and the task stays
      // pending so the turn sweep writes the terminal again while this manager runs.
      if (p.once) {
        this.pendingTurns.set(key, p);
        this.deps.endOnceSeat(p, "turn-deadline");
        this.ensureTurnSweep();
      }
    }
    this.maybeStopTurnSweep();
  }
  /** The reap hook: a pending turn addressed to the reaped INCARNATION is MARKED dead, never
   *  settled early - no honest terminal exists for it (a completion must prove the executor's
   *  live currency, and the hold is only expirable once due), so the entry rides to its deadline
   *  and the deny then records both facts. The addressee's own client observes the death from
   *  presence long before that, which is the run's L4002. */
  failSeatTurns(name: string, uid: string): void {
    for (const p of this.pendingTurns.values()) {
      if (p.seat.name !== name || p.seat.uid !== uid || p.seatDiedAt !== undefined) continue;
      p.seatDiedAt = Date.now();
      console.error(`turn ${p.goalId}: addressed seat ${name}/${uid} died before yielding; the deadline terminal will record it`);
    }
  }
  /** Settle one DUE hold as its owner: the manager minted it, so once the deadline has passed it
   *  expires the pause itself ({@link expireCheckpoint}, the guard-hold precedent) rather than
   *  waiting on the broker's fire - which it holds no grant to read, and which a hold minted under
   *  a predecessor's epoch would carry on a subject this incarnation never subscribes. Idempotent
   *  by the plane: a yield that claimed the hold first is observed as `resumed` and left to its
   *  own commit, and an already-expired hold returns its recorded settle. */
  private async expireTurnHold(p: PendingTurn): Promise<CheckpointSettleFact | undefined> {
    const gw = this.goalWriter;
    if (!gw) return undefined;
    return expireCheckpoint(gw.ctx.kv, gw.ctx.js, gw.ctx.jsm, this.deps.space, { ref: { endpoint: p.ref.endpoint, token: p.holdToken! }, now: Date.now() });
  }
  private ensureTurnSweep(): void {
    if (this.turnSweepTimer !== undefined) return;
    const t = setInterval(() => { void this.sweepTurnDeadlines().catch((e) => console.error(`! turn deadline sweep: ${rejectionText(e)}`)); }, TURN_SWEEP_MS);
    t.unref?.();
    this.turnSweepTimer = t;
  }
  /** The answer a retried yield is served, held for {@link TURN_ANSWER_RETENTION_MS}. Only for a
   *  turn this incarnation accepted: an entry it has no acceptance for is one it cannot vouch for. */
  private rememberSettledTurn(key: string, state: string, at: number): void {
    const entry = this.turnAcceptances.get(key);
    if (entry === undefined) return;
    entry.settled = { state, at };
  }
  /** Stamp when the pending latch dropped, so an unsettled leftover ages off that instant rather
   *  than the original deadline. Idempotent: the first drop is the one the retry window starts at. */
  private markTurnLatchDropped(key: string, at = Date.now()): void {
    const entry = this.turnAcceptances.get(key);
    if (entry === undefined || entry.leftoverSince !== undefined) return;
    entry.leftoverSince = at;
  }
  /** Stop the sweep only when it has nothing left to do. It drives elapsed turns to their deadline
   *  terminals AND drops settled answers once their retry window has passed, so a stop while the
   *  second is still owed would leave one entry per turn for the process lifetime. */
  private maybeStopTurnSweep(): void {
    if (this.pendingTurns.size > 0 || this.onceSettles.size > 0 || this.onceInherited.size > 0 || [...this.onceStops.values()].some((s) => !s.told)) return;
    // An acceptance with no `settled` yet is the in-flight deadline commit: pending was the
    // latch and is already gone, the terminal CAS has not returned, and a concurrent sweep
    // tick used to clear the map here, so rememberSettledTurn no-op'd and a late yield heard
    // `not-found` for a deny the run already has. Prune is the only deleter; stop only when
    // it has left nothing.
    if (this.turnAcceptances.size > 0) return;
    this.stopTurnSweep();
  }
  private stopTurnSweep(): void {
    if (this.turnSweepTimer === undefined) return;
    clearInterval(this.turnSweepTimer);
    this.turnSweepTimer = undefined;
  }
  /** Drive every elapsed pending turn to its deadline terminal. Only entries at/past their own
   *  `deadlineAt` are read at all; a `resumed` settle is a yield mid-commit and is left alone. */
  private async sweepTurnDeadlines(): Promise<void> {
    const now = Date.now();
    // A settled answer is kept only as long as a lost reply could still be retried under it.
    // An UNSETTLED acceptance whose pending latch is already gone is the in-flight (or failed)
    // deadline commit: keep it for the same window so a late yield can still read the durable
    // terminal, then drop it so a commit that never remembered cannot pin the sweep forever.
    for (const [key, e] of [...this.turnAcceptances.entries()]) {
      if (this.pendingTurns.has(key)) continue;
      // Unsettled leftovers age off the latch-drop stamp, never `deadlineAt`.
      const at = e.settled?.at ?? e.leftoverSince;
      if (at !== undefined && now - at >= TURN_ANSWER_RETENTION_MS) this.turnAcceptances.delete(key);
    }
    // The prune above is the one event after which the sweep may have nothing left to do, and
    // the settle-time callers cannot see it: they run when an answer has just been remembered.
    this.maybeStopTurnSweep();
    // A notice is at-most-once, so a seat offline when it went out has not pulled its head turn.
    // Repeat the notice until it does; a seat that pulled is not told again for that turn.
    const heads = new Map<string, PendingTurn>();
    for (const p of this.pendingTurns.values()) {
      if ((p.deadlineAt !== undefined && now >= p.deadlineAt) || p.once?.deliverable === false) continue;
      const k = `${p.seat.owner}.${p.seat.actor}.${p.seat.uid}`;
      const h = heads.get(k);
      if (h === undefined || p.acceptedAt < h.acceptedAt) heads.set(k, p);
    }
    for (const p of heads.values()) if (p.pulledAt === undefined) this.deps.noticeSeatTurns(p.seat);
    for (const stop of this.onceStops.values()) if (!stop.told) this.deps.noticeSeatTurns(stop);
    for (const owed of [...this.onceSettles.values()]) if (!owed.flight) void this.settleOnceTurn(owed.ref, owed.reason);
    if (this.onceInherited.size > 0) await this.settleInheritedOnce().catch((e) => console.error(`! inherited once tasks: ${rejectionText(e)}`));
    for (const p of [...this.pendingTurns.values()]) {
      if (p.deadlineAt === undefined || now < p.deadlineAt) continue;
      try {
        const settle = await this.expireTurnHold(p);
        if (settle?.settle === "expired") await this.commitTurnDeadline(p);
      } catch (e) { console.error(`! turn deadline sweep for ${p.goalId}: ${rejectionText(e)}`); }
    }
  }
  /** Adopt one inherited TURN goal at boot (the reconcile sweep's turn branch): a non-terminal
   *  entry carrying a parseable note rebuilds its pending relay - never an `uncertain` settle,
   *  because the deadline hold IS this goal's bounded ending and it survived the restart. No
   *  liveness verdict is made here (the agents map is empty during reconcile, so absence means
   *  "not yet re-registered", never "dead"); a garbled note or a floor that does not name the
   *  seat's owner is logged and left, the dead-pointer honesty rule. */
  async adoptTurnGoal(entry: { ref: GoalRef; iid: string; allocated?: GoalIndexEntry["allocated"]; note?: string }): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    const status = await readGoalStatus(gw.ctx, entry.ref);
    if (status === undefined) return; // index points at no goal record: a dead pointer, left for honesty
    const parsed = entry.note !== undefined ? parseTurnNote(entry.note) : undefined;
    const ownOnce = parsed?.once === true && entry.iid === this.deps.managerInstanceId() && entry.allocated?.owner !== undefined;
    if (GOAL_TERMINAL_STATES.includes(status.value.state)) {
      // A once task's entry is its seat's debt until that seat's exit is proved, so it outlives
      // the terminal: the stop the predecessor owed may never have landed.
      if (ownOnce) await this.inheritOnce(entry.ref, entry.allocated!, parsed!);
      else await clearGoalIndex(gw.ctx, entry.ref);
      return;
    }
    if (entry.iid !== this.deps.managerInstanceId()) {
      console.error(`turn reconcile ${entry.ref.goalId}: accepted by instance "${entry.iid}", not this incarnation "${this.deps.managerInstanceId()}"; left for its owner (never a cross-instance settle)`);
      return;
    }
    if (entry.allocated?.owner === undefined || parsed === undefined) {
      console.error(`turn reconcile ${entry.ref.goalId}: the relay record is garbled (no floor naming the seat's owner, or an unparseable note); left unsettled`);
      return;
    }
    const spec = await readGoalSpec(gw.ctx, entry.ref);
    if (spec === undefined) {
      // NOW IS NOT WHEN THIS WAS ACCEPTED. `acceptedAt` is what orders a seat's queue, and a turn
      // stamped with the boot instant sorts BEHIND every turn accepted since — a predecessor's
      // oldest turn served last, which is the one thing the ordering exists to prevent. A goal
      // with an index entry and no spec is a relay record that is not readable, and this is the
      // same verdict the garbled-note branch above reaches: left unsettled, said out loud.
      console.error(`turn reconcile ${entry.ref.goalId}: the goal spec is unreadable, so its acceptance time is unknown; left unsettled rather than re-stamped with the boot instant`);
      return;
    }
    const p: PendingTurn = {
      ref: entry.ref, goalId: entry.ref.goalId,
      seat: { name: entry.allocated.name, owner: entry.allocated.owner, actor: entry.allocated.actor, uid: entry.allocated.uid },
      payload: parsed.payload,
      acceptedAt: spec.value.acceptedAt,
      holdEpoch: parsed.holdEpoch,
      ...(parsed.deadlineAt !== undefined ? { deadlineAt: parsed.deadlineAt, holdToken: parsed.holdToken ?? turnHoldToken(entry.ref.goalId) } : {}),
      ...(parsed.handoffFrom !== undefined ? { handoffFrom: parsed.handoffFrom } : {}),
      // An inherited once task is served again only once its seat is bound to this incarnation.
      ...(parsed.once ? { once: { deliverable: false } } : {}),
    };
    // The hold is the relay's bounded ending, minted AFTER the index entry and the goal record,
    // so a crash between them leaves a goal with no hold: nothing could ever settle it, and the
    // sweep would report the same missing pause every tick. Left unsettled, said once.
    if (p.holdToken !== undefined && (await readCheckpointSpec(gw.ctx.kv, { endpoint: p.ref.endpoint, token: p.holdToken })) === undefined) {
      // A once task's hold is minted before its seat launches, so without one no seat ever ran it:
      // the task is cancelled and its entry dropped, with nothing launched to prove gone.
      if (parsed.once) { await this.settleOnceTurn(p.ref, "launch-failed"); return; }
      console.error(`turn reconcile ${p.goalId}: its deadline hold was never minted (the accept crashed before it); left unsettled`);
      return;
    }
    // A once task whose spawn has no succeeded terminal was never served, whatever seat exists:
    // it is cancelled, its row is not rebuilt so a later pull finds nothing, and its seat is
    // settled as an inherited debt.
    if (parsed.once && !(await this.onceServed(entry.ref, parsed))) {
      await this.commitOnceCancel(entry.ref, NEVER_SERVED);
      await this.inheritOnce(entry.ref, entry.allocated, parsed);
      return;
    }
    const key = goalKey(p.ref);
    this.pendingTurns.set(key, p);
    // THE ACCEPTANCE TOO, or the adopted turn's answer is never remembered: `rememberSettledTurn`
    // writes only against an acceptance this incarnation holds, and adoption rebuilt the pending
    // relay without one, so a yield whose reply was lost after a restart still heard `not-found`
    // on the very path adoption exists for. The acceptance is rebuilt from the same records the
    // relay was: the spec holds the fingerprint, the index holds the seat, the note the deadline.
    this.turnAcceptances.set(key, {
      acceptance: {
        name: p.seat.name, owner: p.seat.owner, actor: p.seat.actor, uid: p.seat.uid, goalId: p.goalId,
        fingerprint: spec.value.fingerprint, deadlineAt: p.deadlineAt,
        executor: { lifecycleUid: this.deps.managerInstanceId(), epoch: p.holdEpoch },
      },
      ref: p.ref,
    });
    // NO LIVENESS VERDICT AT BOOT. The agents map is empty here: seats are re-registered later,
    // by the resume path, so `not in the map` at this moment means "not yet re-registered", never
    // "dead". Stamping death from it marked EVERY adopted turn as a dead seat, and its deadline
    // terminal then carried `agentDownAt`, so the run raised L4002 for a seat that was alive the
    // whole time where the reference says L4003. The reap hook is the only honest writer of that
    // fact: it fires when a managed seat actually dies.
    console.error(`turn reconcile ${p.goalId}: pending relay to ${p.seat.name}/${p.seat.uid} adopted (deadline ${p.deadlineAt ?? "none"})`);
    if (parsed.once) await this.inheritOnce(entry.ref, entry.allocated, parsed);
    this.ensureTurnSweep();
  }
  // ---- once (a spawn whose prompt is its one relayed task) ----------------------------------------
  //
  // A once spawn's prompt is not a kickoff: the manager accepts it as one turn addressed to the
  // allocated incarnation, under the spawner's own caller triple and a goal id derived from the
  // spawn's, so the spawner reads the task's outcome with `goal-result`. The seat is served it from
  // the spawn's readiness verdict on. The task's terminal (yield, deadline) stops the seat, and the
  // seat's proved exit cancels a task that has none. Until that exit, the task's index entry is the
  // seat's debt: a successor finds it there.

  /** Accept a once spawn's task, inline in the spawn's accept seam: nothing has launched yet, so a
   *  refusal here fails the spawn and leaves no seat. Mirrors {@link serveTurnGoal}'s accept, with
   *  the goal ref and the seat given rather than read off a request. A task with no deadline mints
   *  no hold; its goal still records the spawn's readiness budget, which a successor needs to settle
   *  it. */
  async acceptOnceTurn(o: {
    spawnRef: GoalRef; fingerprint: string; command: string; executor: { lifecycleUid: string; epoch: number }; acceptedAt: number;
    seat: { name: string; owner: string; actor: string; uid: string }; prompt: string; spawner: string; deadlineMs: number | undefined; readinessDeadlineMs: number; retire?: string;
  }): Promise<{ ref: GoalRef; deadlineAt?: number }> {
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing; a once task cannot be accepted (SPEC 13.6)");
    const serve = this.serviceServe;
    if (o.deadlineMs !== undefined && !serve)
      throw new EpEnvelopeError("unavailable", "the manager service endpoint is not serving; a once task's deadline hold is armed over its connection (SPEC 13.9)");
    const ref: GoalRef = { endpoint: o.spawnRef.endpoint, caller: { ...o.spawnRef.caller }, goalId: digestIdToken(`${o.spawnRef.goalId}:once`) };
    const key = goalKey(ref);
    const deadlineAt = o.deadlineMs === undefined ? undefined : o.acceptedAt + o.deadlineMs;
    if (deadlineAt !== undefined && deadlineAt > MAX_SCHEDULE_MS)
      throw new EpEnvelopeError("failed-precondition", `once: the deadline ends after the deadline scheduler's last instant (the end of year 9999)`);
    const holdToken = deadlineAt === undefined ? undefined : turnHoldToken(key);
    const { payload, note } = onceTurnNote({ prompt: o.prompt, spawner: o.spawner, holdEpoch: o.executor.epoch, ...(deadlineAt !== undefined ? { deadlineAt, holdToken } : {}), ...(o.retire !== undefined ? { retire: o.retire } : {}), spawn: o.spawnRef.goalId });
    const { seat } = o;
    const idx = await recordGoalIndex(gw.ctx, ref, o.executor.lifecycleUid, { name: seat.name, owner: seat.owner, actor: seat.actor, uid: seat.uid, readinessDeadlineMs: o.readinessDeadlineMs }, note);
    if (!idx.recorded)
      throw new EpEnvelopeError("failed-precondition", `once: the task goal "${ref.goalId}" is already recorded; a spawn accepts its task once (SPEC 13.6)`);
    const b = await bindGoal(gw.ctx, ref, o.fingerprint);
    if (!b.bound) {
      await clearGoalIndex(gw.ctx, ref);
      throw new EpEnvelopeError("failed-precondition", `once: the task goal "${ref.goalId}" is already bound; a spawn accepts its task once (SPEC 13.6)`);
    }
    try {
      await createGoal(gw.ctx, ref, {
        fingerprint: o.fingerprint,
        command: o.command,
        caller: { id: `${ref.caller.owner}.${ref.caller.actor}`, lifecycleUid: ref.caller.uid },
        acceptedEpoch: o.executor.epoch,
        requestId: ref.goalId,
        sourceSeq: 0,
        acceptedAt: o.acceptedAt,
        readinessDeadlineMs: o.readinessDeadlineMs,
        target: { owner: seat.owner, actor: seat.actor, lifecycleUid: seat.uid, mappingRevision: 0 },
      });
      if (deadlineAt !== undefined)
        await mintCheckpoint(gw.ctx.kv, jetstream(serve!.nc), this.deps.space, {
          ref: { endpoint: ref.endpoint, token: holdToken! },
          instanceId: this.deps.managerInstanceId(),
          epoch: o.executor.epoch,
          goal: { caller: { ...ref.caller }, goalId: ref.goalId },
          holder: { id: MANAGER_ENDPOINT, lifecycleUid: this.deps.managerInstanceId() },
          deadline: deadlineAt,
          now: o.acceptedAt,
        });
    } catch (e) {
      // Nothing launched and nothing was served, so the task is withdrawn with `cancel`.
      try {
        await transitionGoal(gw.ctx, ref, "cancelling", { fields: { cancelMode: "terminate" } });
        await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "cancel", data: { cancelledBy: "manager", reason: "accept-failed" }, committer: { instanceId: this.deps.managerInstanceId(), epoch: o.executor.epoch } });
        await clearGoalIndex(gw.ctx, ref);
      } catch (e2) { console.error(`! once task accept unwind for ${ref.goalId}: ${rejectionText(e2)}`); }
      throw e;
    }
    this.pendingTurns.set(key, {
      ref, goalId: ref.goalId, seat: { ...seat }, payload, acceptedAt: o.acceptedAt, holdEpoch: o.executor.epoch,
      ...(deadlineAt !== undefined ? { deadlineAt, holdToken } : {}),
      once: { deliverable: false },
    });
    this.turnAcceptances.set(key, {
      acceptance: { name: seat.name, owner: seat.owner, actor: seat.actor, uid: seat.uid, goalId: ref.goalId, fingerprint: o.fingerprint, ...(deadlineAt !== undefined ? { deadlineAt } : {}), executor: o.executor },
      ref,
    });
    this.ensureTurnSweep();
    this.deps.emitGoalProgress(ref, o.executor.epoch, { phase: "relayed" });
    return { ref, ...(deadlineAt !== undefined ? { deadlineAt } : {}) };
  }
  /** Serve a once task from now on: its spawn's succeeded terminal is written. */
  openOnceDelivery(ref: GoalRef): void {
    const p = this.pendingTurns.get(goalKey(ref));
    if (p?.once === undefined || p.once.deliverable) return;
    p.once.deliverable = true;
    this.deps.noticeSeatTurns(p.seat);
  }
  /** End a once task that can no longer run: once its connector, when it has a `retire` hook, proves
   *  the seat's launched processes gone, cancel the task with `reason` if it has no terminal yet,
   *  then drop its index entry. One flight per task; a failure keeps it in {@link onceSettles} and
   *  the turn sweep retries it. */
  settleOnceTurn(ref: GoalRef, reason: string, retire?: OnceRetire): Promise<void> {
    const key = goalKey(ref);
    const owed = this.onceSettles.get(key) ?? { ref, reason, ...(retire !== undefined ? { retire } : {}) };
    if (owed.flight) return owed.flight;
    this.onceSettles.set(key, owed);
    const flight = this.runOnceSettle(key, owed).finally(() => { owed.flight = undefined; });
    owed.flight = flight;
    return flight;
  }
  private async runOnceSettle(key: string, owed: { ref: GoalRef; reason: string; retire?: OnceRetire }): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    // The pending entry is the latch the yield and the deadline race on; a task settled here is
    // served to no one again.
    const p = this.pendingTurns.get(key);
    // A task past its deadline owes the deadline terminal, which the turn sweep writes again until
    // it lands; the settle waits for it rather than record a cancel in its place.
    const denyOwed = p?.deadlineAt !== undefined && p.deadlineAt <= Date.now();
    if (p && !denyOwed) {
      this.pendingTurns.delete(key);
      this.markTurnLatchDropped(key);
      this.deps.noticeSeatTurns(p.seat);
    }
    try {
      if (denyOwed) throw new Error("its deadline terminal is not written yet");
      // A seat whose exit is proved may have left processes of its own running the task: the task
      // is not recorded as ended, nor its debt cleared, before they are proved gone.
      const retired = owed.retire === undefined ? undefined : await this.deps.retireOnceSeat(owed.retire);
      await this.commitOnceCancel(owed.ref, owed.reason);
      await clearGoalIndex(gw.ctx, owed.ref);
      this.onceSettles.delete(key);
      this.deps.forgetOnceWatch(key);
      await retired?.discard().catch((e: unknown) => console.error(`! once task ${owed.ref.goalId}: its retirement receipt was not discarded (${rejectionText(e)})`));
    } catch (e) {
      console.error(`! once task ${owed.ref.goalId} (${owed.reason}): ${rejectionText(e)}; retried by the turn sweep`);
      this.ensureTurnSweep();
    }
    this.maybeStopTurnSweep();
  }
  /** Cancel a once task with `reason` unless it already has a terminal. */
  async commitOnceCancel(ref: GoalRef, reason: string): Promise<void> {
    const gw = this.goalWriter!;
    if ((await readGoalResult(gw.ctx, ref)) !== undefined) return;
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    await this.deps.assertGoalWriterEpochCurrent(epoch);
    if ((await readGoalStatus(gw.ctx, ref))?.value.state !== "cancelling")
      await transitionGoal(gw.ctx, ref, "cancelling", { fields: { cancelMode: "terminate" } });
    const { fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "cancel", data: { cancelledBy: "manager", reason }, committer: { instanceId: this.deps.managerInstanceId(), epoch } });
    this.deps.emitGoalProgress(ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
    this.rememberSettledTurn(goalKey(ref), fact.state, Date.now());
  }
  /** Record a once task a predecessor accepted, and bind its seat if this incarnation already
   *  adopted it. The static adoption and the goal reconcile run in either order, so each side
   *  binds what the other has already found. */
  private async inheritOnce(ref: GoalRef, allocated: NonNullable<GoalIndexEntry["allocated"]>, note: TurnNote): Promise<void> {
    this.onceInherited.set(allocated.uid, {
      ref, seat: { name: allocated.name, owner: allocated.owner!, actor: allocated.actor, uid: allocated.uid },
      ...(note.deadlineAt !== undefined ? { deadlineAt: note.deadlineAt } : {}),
      readinessMs: allocated.readinessDeadlineMs ?? this.deps.readinessTimeoutMs(),
      ...(note.retire !== undefined ? { retire: note.retire } : {}),
    });
    const a = this.deps.findManagedByTarget({ owner: allocated.owner!, actor: allocated.actor, lifecycleUid: allocated.uid });
    if (a !== undefined) await this.bindOnceSeat(a);
    this.ensureTurnSweep();
  }
  /** An inherited once task whose seat this manager cannot hold: it adopts no seats (an open or
   *  user-mode mesh) and the seat is not bound here. */
  private onceSeatUnheld(p: PendingTurn): boolean {
    return p.once !== undefined && this.onceInherited.has(p.seat.uid) && !(this.deps.adoptsSeats());
  }
  /** Whether a once task was served: its spawn's succeeded terminal is written. */
  private async onceServed(ref: GoalRef, note: TurnNote): Promise<boolean> {
    if (note.spawn === undefined) return false;
    const spawn = await readGoalResult(this.goalWriter!.ctx, { endpoint: ref.endpoint, caller: ref.caller, goalId: note.spawn });
    return spawn?.state === "succeeded";
  }
  /** Make an adopted seat a once seat again: its exit settles its task, and the task is served to
   *  it. A task that ended before the restart owes the stop the predecessor may not have made. */
  async bindOnceSeat(a: ManagedAgent): Promise<void> {
    const inherited = this.onceInherited.get(a.lifecycleUid);
    if (inherited === undefined || a.once !== undefined) return;
    this.onceInherited.delete(a.lifecycleUid);
    a.once = { ref: inherited.ref, ...(inherited.retire !== undefined ? { retire: inherited.retire } : {}) };
    this.deps.watchOnceExit(a);
    const p = this.pendingTurns.get(goalKey(inherited.ref));
    if (p?.once) {
      p.once.deliverable = true;
      this.deps.noticeSeatTurns(p.seat);
      return;
    }
    const ended = this.goalWriter ? await readGoalResult(this.goalWriter.ctx, inherited.ref) : undefined;
    if (ended !== undefined) this.deps.stopOnceSeat(a, "turn-ended");
  }
  /** Inherited once tasks whose seat is not bound here. On a static mesh the boot reconcile adopts
   *  every seat it can and reaps the rest by their custody reference, so once it has finished with
   *  a seat's slot, an unbound seat is proved gone. A manager that adopts no seats cannot reach the
   *  old seat or prove its exit: it does not serve the task to it, a task with a deadline ends at
   *  that deadline, and one without is settled `uncertain` after one readiness window. Its debt is
   *  never cleared here, since nothing proves that seat gone. */
  private async settleInheritedOnce(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw || !this.goalReconcileDone) return;
    const adopts = this.deps.adoptsSeats();
    for (const [uid, d] of [...this.onceInherited]) {
      const live = this.deps.findManagedByTarget({ owner: d.seat.owner, actor: d.seat.actor, lifecycleUid: uid });
      if (live !== undefined) { await this.bindOnceSeat(live); continue; }
      if (adopts) {
        const reconciling = this.deps.onceSeatReconciling(uid);
        if (reconciling) continue;
        this.onceInherited.delete(uid);
        void this.settleOnceTurn(d.ref, "seat-exited", retireOf(d));
        continue;
      }
      if ((await readGoalResult(gw.ctx, d.ref)) !== undefined) {
        this.onceInherited.delete(uid);
        this.keepUnprovedOnceDebt(d);
        continue;
      }
      if (d.deadlineAt !== undefined || Date.now() - this.goalReconcileDoneAt < d.readinessMs) continue;
      this.onceInherited.delete(uid);
      const key = goalKey(d.ref);
      this.pendingTurns.delete(key);
      this.markTurnLatchDropped(key);
      try {
        await settleGoalUncertain(gw.ctx, { ref: d.ref, now: Date.now(), committer: { instanceId: this.deps.managerInstanceId(), epoch: this.serviceServe?.grant.epoch ?? 0 }, reason: `the manager restarted and could not reach the seat; ${UNHELD_SEAT}, and the task may have run in part or in full` });
        this.keepUnprovedOnceDebt(d);
      } catch (e) { console.error(`! inherited once task ${d.ref.goalId}: ${rejectionText(e)}`); }
    }
  }
  /** An inherited task's seat this manager cannot reach: its terminal stands, and its index entry,
   *  the seat's debt, stays recorded, because nothing here can prove that seat gone. The seat is
   *  told to end itself on its next pull, and its notice repeats until a pull carries that. */
  private keepUnprovedOnceDebt(d: { ref: GoalRef; seat: { name: string; owner: string; actor: string; uid: string } }): void {
    console.error(`! once task ${d.ref.goalId}: this manager cannot reach seat ${d.seat.name}/${d.seat.uid} to prove it gone; its debt stays in the goal index, and the seat is told to end itself`);
    this.onceStops.set(d.seat.uid, { ...d.seat });
    this.deps.noticeSeatTurns(d.seat);
    this.ensureTurnSweep();
  }
}
