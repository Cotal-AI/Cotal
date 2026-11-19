/** A run's pause timers: arming or attaching to a checkpoint pause, pushing its deadline,
 *  claiming its fire, cancelling it, re-reading a wait's recorded message, and waiting for the
 *  pause's one-use settlement. The mesh handler composes it and passes its connections, binding,
 *  watcher and run services, each read at its use. */
import {
  EpEnvelopeError, chatStream, eptStreamName, eptSubject, handleCheckpointFire, heartbeatCheckpoint, mintCheckpoint,
  readCheckpointSettle, readCheckpointSpec, readCheckpointStatus, reconcileCheckpointSchedule, resumeCheckpoint,
  type CheckpointRef, type CheckpointSettleFact, type CotalMessage,
} from "@cotal-ai/core";
import { Cancelled, type CancelSignal } from "@cotal-ai/lang";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { delay } from "./delay.js";
import { servedDespiteStarvation, type LoopLagObserver } from "./host-starvation.js";
import type { MeshHandlerBinding, RunMeshServices, SettleWatcher } from "./mesh-handler.js";
import { PauseOverdue } from "./run-pause-host.js";

/** How often a pause that nobody will answer looks for the broker's fire. Same argument as
 *  `WAIT_POLL_MS`: the deadline is durable and this is only how late its observation can be. */
export const FIRE_POLL_MS = 2_000;

export function decodeMessage(data: Uint8Array): CotalMessage | undefined {
  try {
    const v = JSON.parse(new TextDecoder().decode(data)) as CotalMessage;
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    // Someone else's malformed publish is not this run's failure. It does not match, and the wait
    // goes on waiting — which is what would happen if the message had never been sent.
    return undefined;
  }
}

/** What the pause timers read from the handler that composes them, each at its use. */
export interface PauseTimerDeps {
  binding(): MeshHandlerBinding;
  kv(): KV;
  js(): JetStreamClient;
  jsm(): JetStreamManager;
  watcher(): SettleWatcher;
  services(): RunMeshServices | undefined;
  lag(): LoopLagObserver;
  onStarved(note: string): void;
  now(): number;
  withdrawCancelledRelay(goalId: string, deadlineAt?: number): Promise<void>;
}

/** The pause timer and settle members of a mesh handler, over the handler's own inputs. */
export class PauseTimers {
  constructor(private readonly deps: PauseTimerDeps) {}

  private get binding(): MeshHandlerBinding { return this.deps.binding(); }
  private get kv(): KV { return this.deps.kv(); }
  private get js(): JetStreamClient { return this.deps.js(); }
  private get jsm(): JetStreamManager { return this.deps.jsm(); }
  private get watcher(): SettleWatcher { return this.deps.watcher(); }
  private get services(): RunMeshServices | undefined { return this.deps.services(); }
  private get lag(): LoopLagObserver { return this.deps.lag(); }
  private get onStarved(): (note: string) => void { return this.deps.onStarved; }
  private now(): number { return this.deps.now(); }
  private withdrawCancelledRelay(goalId: string, deadlineAt?: number): Promise<void> { return this.deps.withdrawCancelledRelay(goalId, deadlineAt); }

  /**
   * Arm this pause, or ATTACH to the one already recorded under the same token.
   *
   * A mint is idempotent only if the whole spec is identical, so the recorded spec is the
   * authority for BOTH halves of the mint's identity and a resume may not recompute either. The
   * deadline, because `now() + duration` is a different deadline a second later, and the plane
   * reads a different deadline as a different intent. And the HOLDER, because a resumed run does
   * not necessarily arrive under the principal that minted its pause: the CLI mints a fresh holder
   * per invocation, and a cross-host adoption is a different principal by definition. Only the
   * recorded holder itself may mint again — completing its own crash between the spec and the
   * status, where the identical spec is exactly what makes the retry idempotent. Everyone else
   * attaches. Measured before the repair, through the CLI: one `resume` of a checkpoint-parked
   * run re-minted under its own fresh holder, the plane refused ("a token is minted once"), and
   * the interpreter recorded that infrastructure refusal as the step's own failure (L4000) — a
   * stranded run whose journal blames the program.
   *
   * An already-passed deadline cannot be minted at all, correctly, because a due pause is not being
   * armed. It needs its schedule re-emitted at the status's current generation, which is the
   * reconciler's job — the same operation an attaching successor needs, so the two share the exit.
   * A first arm whose deadline has passed has nothing to attach to and raises `PauseOverdue`.
   * A spec with no status that this holder cannot complete is unrepairable from here, so it is
   * raised rather than waited on.
   */
  async arm(ref: CheckpointRef, deadline: number): Promise<void> {
    // #1508: every read and write below rides a client-side deadline, and a deadline that elapsed
    // because THIS PROCESS was off the CPU is not evidence about the plane. See `host-starvation`.
    return await servedDespiteStarvation(() => this.armOnce(ref, deadline), this.lag, `arming the pause ${ref.token}`, this.onStarved);
  }

  /** `arm`, answering `true` when the deadline passed before anything was minted for it. Only a
   *  first arm finds that (`PauseOverdue`), and there is then no pause to settle, so a caller whose
   *  deadline is its own outcome takes `true` as that outcome. Cancellation still wins. */
  async armUnlessDue(ref: CheckpointRef, deadline: number, signal: CancelSignal): Promise<boolean> {
    try {
      await this.arm(ref, deadline);
      return false;
    } catch (error) {
      if (error instanceof PauseOverdue) {
        if (signal.cancelled) throw new Cancelled(signal.reason ?? "cancelled");
        return true;
      }
      throw error;
    }
  }

  private async armOnce(ref: CheckpointRef, deadline: number): Promise<void> {
    if (this.services) return this.services.pauses.arm(ref.token, deadline);
    // Over already: an expiry or an answer landed while this host was away. Nothing to arm, and the
    // caller reads the fact next.
    if ((await readCheckpointSettle(this.jsm, this.binding.space, ref)) !== undefined) return;
    const prior = await readCheckpointSpec(this.kv, ref);
    const now = this.now();
    if (prior === undefined) {
      // The first arm: this driver's own mint, under its own holder, at the deadline the caller
      // computed from the duration it was just handed.
      if (deadline <= now) throw new PauseOverdue(ref.token, deadline, now);
      await mintCheckpoint(this.kv, this.js, this.binding.space, {
        ref,
        instanceId: this.binding.instanceId,
        epoch: this.binding.epoch,
        holder: this.binding.holder,
        deadline,
        now,
      });
      return;
    }
    const mine = prior.holder.id === this.binding.holder.id
      && prior.holder.lifecycleUid === this.binding.holder.lifecycleUid;
    if (mine && prior.initialDeadline > now) {
      // A retry of this holder's own mint: idempotent-if-identical, and the one path that can
      // repair a crash between the spec and the status, because only an identical spec completes.
      await mintCheckpoint(this.kv, this.js, this.binding.space, {
        ref,
        instanceId: this.binding.instanceId,
        epoch: this.binding.epoch,
        holder: this.binding.holder,
        deadline: prior.initialDeadline,
        now,
      });
      return;
    }
    // ATTACH: the pause exists and is not this attempt's to mint — another holder's pause, or this
    // holder's own come back overdue (a due pause is being collected, not armed). Both need the
    // same thing: the schedule re-emitted at THIS instance's coordinates, so the fire lands where
    // this driver is listening. The settle the caller waits on next is coordinate-free.
    const status = await readCheckpointStatus(this.kv, ref);
    if (status === undefined) {
      throw new Error(
        `checkpoint "${ref.token}" carries a spec with no status`
        + `${mine ? "" : ` held by ${prior.holder.id}, and only its own holder's identical re-mint can repair a half-minted pause`}; `
        + `this pause has to be reconciled on the plane before the run can go on`,
      );
    }
    await reconcileCheckpointSchedule(this.kv, this.js, this.jsm, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
    });
  }

  /** Push a live deadline out — the idle window restarting. The heartbeat CAS-advances the
   *  generation before replacing the timer, so a fire from the old one no-ops rather than racing. */
  async push(ref: CheckpointRef, deadline: number): Promise<void> {
    if (this.services) return this.services.pauses.heartbeat(ref.token, deadline);
    await heartbeatCheckpoint(this.kv, this.js, this.jsm, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      deadline,
      now: this.now(),
    });
  }

  /**
   * Take the broker's `.fire` for this deadline, if it has published one, and let the checkpoint
   * plane judge it. Answers whether the fire SETTLED the pause.
   *
   * A fire is a MESSAGE and a settlement is a FACT; `handleCheckpointFire` is what turns one into
   * the other, and a pause nobody answers ends no other way.
   *
   * READ BY SUBJECT rather than by a subscription, because the fire is a record of a deadline
   * passing and callers here are already polling: `last_by_subj` gives the current one whether it
   * arrived a moment ago or while this host was down, and a resume lands in the second case.
   *
   * IDEMPOTENT BY THE PLANE rather than by bookkeeping here: a fire handed over twice finds the
   * pause settled and declines. The one repeated verdict with a side effect is `re-armed` under
   * owner-behind clock skew, and over-emission is idempotent at the timer writer.
   */
  private async takeFire(ref: CheckpointRef): Promise<boolean> {
    if (this.services) return this.services.pauses.takeFire(ref.token);
    const subject = eptSubject(
      this.binding.space, ref.endpoint,
      this.binding.instanceId, this.binding.epoch, ref.token, "fire",
    );
    const fired = await this.jsm.streams
      .getMessage(eptStreamName(this.binding.space), { last_by_subj: subject })
      .catch((e: unknown) => {
        // 10037 is the stream saying there is no message on that subject, which IS the ordinary
        // "the timer has not fired yet" answer. Every other error is the broker refusing or
        // unreachable, and reading those as "not yet" is how a `wait` with a timeout outlives its
        // own durable deadline in silence, which is the failure this method exists to prevent.
        if ((e as { code?: unknown })?.code === 10037) return null;
        throw e;
      });
    if (fired === null || fired === undefined) return false;
    const verdict = await handleCheckpointFire(this.kv, this.js, this.jsm, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      msg: { subject, ...(fired.header !== undefined ? { headers: fired.header } : {}), data: fired.data },
      now: this.now(),
    });
    return verdict.acted;
  }

  /** Has this deadline settled? `undefined` for "no deadline" and for "not yet".
   *
   *  A `wait` observes its deadlines by polling this, so the fire is taken on the same poll: the
   *  settle fact a `wait` is reading for is one this process has to produce, and reading for it
   *  without ever producing it is how a `wait` with a timeout waited past its timeout forever. */
  async expired(ref: CheckpointRef | undefined): Promise<CheckpointSettleFact | undefined> {
    if (ref === undefined) return undefined;
    if (this.services) {
      const settled = await this.services.pauses.readSettle(ref.token);
      if (settled !== undefined) return settled;
      if (!(await this.services.pauses.takeFire(ref.token))) return undefined;
      return this.services.pauses.readSettle(ref.token);
    }
    const settled = await readCheckpointSettle(this.jsm, this.binding.space, ref);
    if (settled !== undefined) return settled;
    if (!(await this.takeFire(ref))) return undefined;
    return await readCheckpointSettle(this.jsm, this.binding.space, ref);
  }

  /** End a deadline that is no longer waited on, by claiming its one-use settlement with no answer.
   *  A timer left armed would fire into a run that has moved on; claiming it is how the plane says
   *  "this pause is over" without a second mechanism for cancellation. */
  async cancelTimer(ref: CheckpointRef): Promise<void> {
    if (this.services) return this.services.pauses.claim(ref.token);
    const st = await readCheckpointStatus(this.kv, ref);
    if (st?.value.state !== "waiting") return;
    try {
      // The presenter is the ARMING holder read off the pause's own record, as everywhere on this
      // plane: a timer minted by a predecessor is still this run's to end after a takeover, and a
      // successor presenting its own identity would be refused (resume is holder-bound, SPEC
      // 13.10). A spec that cannot be read leaves the timer to its own deadline, which the catch
      // below already tolerates: it fires, settles expired, and nobody is reading that token.
      const spec = await readCheckpointSpec(this.kv, ref);
      if (spec === undefined) return;
      await resumeCheckpoint(this.kv, this.js, this.jsm, this.binding.space, {
        ref,
        presenter: spec.holder,
        now: this.now(),
      });
    } catch (e) {
      // IT SETTLED UNDERNEATH US is one outcome, and it is the expected one: the deadline won a
      // race it was always allowed to win, the caller has its answer either way, and a claimed
      // timer is not a fact anyone reads. A BROKER THAT REFUSED OR WENT AWAY is a different thing
      // wearing the same silence, and this catch used to swallow both. It still must not replace
      // the caller's answer — a timer left armed fires, settles expired, and nobody reads that
      // token — so the second one is loud on the way past instead.
      const settledAlready = e instanceof EpEnvelopeError
        && (e.code === "conflict" || e.code === "failed-precondition");
      if (!settledAlready)
        console.error(`run ${this.binding.runId}: the pause ${ref.token} could not be claimed (${(e as Error).message}); it will fire and settle expired with nobody reading it`);
    }
  }

  /** The message at a recorded stream sequence — the re-bind path after a crash. */
  async messageAt(seq: number, requestId: string): Promise<unknown> {
    if (this.services) {
      const message = decodeMessage(await this.services.waits.messageAt(requestId, seq));
      if (message === undefined) throw new Error(`wait ${requestId}'s recorded message does not decode`);
      return message;
    }
    const m = await this.jsm.streams.getMessage(chatStream(this.binding.space), { seq });
    if (m === null || m === undefined) {
      throw new Error(`the message this wait matched (sequence ${seq}) is no longer on the channel's stream; a recorded match cannot be re-read`);
    }
    const msg = decodeMessage(m.data);
    if (msg === undefined) throw new Error(`the message at sequence ${seq} did not decode; a recorded match cannot be re-read`);
    return msg;
  }

  /**
   * Wait for this token's one-use settlement.
   *
   * A settle that ALREADY landed is the ordinary case on a resume: the run crashed while paused and
   * the timer fired, or somebody answered, without it. Reading before waiting is not an
   * optimization, it is the difference between resuming and waiting forever for an event that is
   * already in the past.
   */
  async settle(ref: CheckpointRef, signal?: CancelSignal, relayed = false): Promise<CheckpointSettleFact> {
    // #1508, and the load-bearing half: this is where a `sleep` spends its whole duration, so this
    // is where a starved host was reporting its own scheduling as the effect's failure. The pause
    // and its timer are durable facts on the plane; re-reading them observes the same world, and a
    // sleep whose deadline passed while this process was blocked settles `ok`, late.
    try {
      return await servedDespiteStarvation(() => this.settleOnce(ref, signal), this.lag, `waiting on the pause ${ref.token}`, this.onStarved);
    } catch (e) {
      // An `ask` attempt or an escalation may have relayed this token to a seat.
      if (e instanceof Cancelled && relayed) await this.withdrawCancelledRelay(ref.token);
      throw e;
    }
  }

  private async settleOnce(ref: CheckpointRef, signal?: CancelSignal): Promise<CheckpointSettleFact> {
    const already = this.services ? await this.services.pauses.readSettle(ref.token) : await readCheckpointSettle(this.jsm, this.binding.space, ref);
    if (already !== undefined) return already;
    // The watcher waits for the FACT. For a pause with an answer the fact arrives because somebody
    // answered; for a pause nobody answers - a `sleep`, or a `checkpoint` whose timeout wins - it
    // arrives only because this process took the fire and the plane wrote it. So the two run
    // together for the life of one wait, and the pump ends when the wait does.
    const wait = { over: false };
    const pump = this.pumpFires(ref, wait);
    try {
      return await Promise.race([
        this.watcher.awaitSettle(ref),
        // A pump that ENDED is not an answer, only one that FAILED is: a failure means this process
        // cannot expire the pause, so it is raised rather than absorbed and the step stays pending.
        pump.then<CheckpointSettleFact>(() => new Promise<never>(() => {})),
        // A cancelled branch stops parking NOW (§7.6): the rejection decides the race first, so a
        // `checkpoint` cannot mistake its own claim below for an answer, and then the claim ends
        // the pause in the world. The claim is not awaited here — a claim that loses its own race
        // is tolerated by `cancelTimer`, and the discharge sweep at the run's completion re-claims
        // idempotently for the case where this process died before the claim landed.
        ...(signal === undefined ? [] : [this.settleCancelled(ref, signal)]),
      ]);
    } finally {
      wait.over = true;
      // THE PUMP IS DRAINED BEFORE THE SETTLE RETURNS (#1460). The race above has already decided
      // — the fact, the failure, or the cancellation is this call's answer — but the pump's
      // in-flight `takeFire` is a journal replay under the run's takeover id, created, read and
      // deleted inside one `replayRunJournal` call with nothing serialising it across two
      // authorities for the same run and lease. A settle that returned past it let a completed
      // `driveRun` hold the replay open after it resolved, and the next reader under the same
      // takeover hit `RunJournalReplayRaced` about a driver that did not exist. So only the RETURN
      // is delayed, until the pump has ended: `wait.over` stops it after its current `takeFire`
      // without starting another, and awaiting it here means no pump fire is left in flight on any
      // exit. A pump that FAILED raises through this await on its way out, exactly as it did
      // through the race; the settle's own answer is decided either way and is what this returns.
      await pump;
    }
  }

  /** Reject with `Cancelled` the moment this branch's signal fires, then claim the pause so its
   *  armed schedule cannot fire into a run that has moved on. The claim also writes the one-use
   *  settle, which is what lets an abandoned `awaitSettle` poll loop see a fact and end. */
  private settleCancelled(ref: CheckpointRef, signal: CancelSignal): Promise<never> {
    return new Promise<never>((_, reject) => {
      let fired = false;
      const fire = (reason?: string): void => {
        if (fired) return;
        fired = true;
        reject(new Cancelled(reason ?? "cancelled"));
        void this.cancelTimer(ref).catch(() => undefined);
      };
      if (signal.cancelled) {
        fire(signal.reason);
        return;
      }
      signal.onCancel(fire);
    });
  }

  /** Take this deadline's fire for as long as somebody is waiting on it. */
  private async pumpFires(ref: CheckpointRef, wait: { over: boolean }): Promise<void> {
    while (!wait.over) {
      await this.takeFire(ref);
      // THE FLAG IS RE-READ AFTER THE FIRE, before the poll sleeps (#1460): `takeFire` is a journal
      // replay under the run's takeover id, so the wait can have ENDED while this one was in
      // flight — and a pump that slept another poll on a wait that is over keeps exactly one more
      // fire in flight past the drain `settleOnce` awaits. Checked here, the pump ends right after
      // its current fire without starting another.
      if (wait.over) break;
      await delay(FIRE_POLL_MS);
    }
  }
}
