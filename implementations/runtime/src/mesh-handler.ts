/**
 * The mesh handler: `packages/lang`'s `EffectHandler` over the real planes.
 *
 * The language performs effects through an interface and knows nothing about NATS. The simulator
 * implements that interface with scripted answers, which is what lets a program be tested without a
 * broker. This is the other implementation — the one where an effect actually happens — and it is
 * deliberately thin: everything hard about durability already lives in the planes it calls.
 *
 * **The request id IS the durable token.** `ctx.requestId` is `base64url(sha256(runId, stepKey,
 * inputHash, attempt))`, written onto the pending journal entry BEFORE the handler is called, and
 * it is a valid `<token>` by construction — same alphabet, 43 characters. So a crashed run that
 * resumes re-derives the same token and ATTACHES to the pause the crashed attempt recorded instead
 * of opening a second one. Nothing here remembers anything across a crash, because the identity was
 * recorded before the work started and the pause itself holds the rest: `mintCheckpoint` is
 * idempotent only if the ENTIRE spec is identical, and the deadline in it cannot be recomputed from
 * a clock that has moved, so `arm()` reads the recorded spec rather than doing the arithmetic
 * again.
 */
import { createHash } from "node:crypto";
import {
  mintCheckpoint,
  heartbeatCheckpoint,
  resumeCheckpoint,
  readCheckpointSettle,
  readCheckpointAnswer,
  readCheckpointStatus,
  readCheckpointSpec,
  reconcileCheckpointSchedule,
  handleCheckpointFire,
  checkpointSettleSubject,
  epfStreamName,
  eptStreamName,
  eptSubject,
  chatStream,
  chatSubject,
  isConcreteChannel,
  assertSafePattern,
  runNoticeId,
  writeRunNotice,
  type CheckpointRef,
  type CheckpointSettleFact,
  type CotalMessage,
} from "@cotal-ai/core";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  parseDuration,
  type WaitRequest,
  type CheckpointRaw,
  type CheckpointRequest,
  type EffectContext,
  type JournalEntry,
  type NotifyRequest,
  type SleepRequest,
  journalEntryKeyString,
  stepKeyString,
} from "@cotal-ai/lang";

/** Who this handler acts as, and where. All of it is the DRIVER's identity, not the program's. */
export interface MeshHandlerBinding {
  readonly space: string;
  /** The endpoint hosting the driver — the manager daemon. */
  readonly endpoint: string;
  /**
   * WHICH RUN this handler performs for.
   *
   * It is here rather than on `EffectContext` because the effect context deliberately
   * carries the step's identity and nothing about the run: `requestId` already folds the run
   * in, and a handler that needed to name the run for recovery would be recovering by something
   * other than the recorded identity. A NOTICE is keyed by its run, though — it is filed onto the
   * run — so the run is part of what this handler is bound to. A drive is already shaped that way:
   * the caller hands `drive()` a run id and a handler together.
   */
  readonly runId: string;
  readonly instanceId: string;
  readonly epoch: number;
  /**
   * MANDATORY, and the reason is worth keeping next to it: a checkpoint's resume is holder-bound,
   * so an omitted holder would make the token a BEARER credential resumable by anyone who learns
   * it (SPEC 13.6/13.10).
   */
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
  /**
   * The deadline a `checkpoint` gets when the program names no `timeout`.
   *
   * MANDATORY, because `mintCheckpoint` requires a future deadline and there is no such thing as a
   * checkpoint that waits forever on this plane: an unbounded pause is a run that can never be
   * reconciled, and picking a silent constant here would be this file deciding a pin. It is read
   * ONLY at the first mint — a resume finds the checkpoint already minted, and the recorded
   * deadline is the authority from then on, so changing this never moves a pause already taken.
   */
  readonly defaultCheckpointTimeout: string;
}

/**
 * A checkpoint resumed with no answer to read.
 *
 * The settle fact is the arbiter and it NAMES the answer it accepted, so a `resumed` settlement
 * with no id — or with an id no record answers to — means the token was presented by something
 * other than the run driver's own `resolveCheckpoint`. There is no honest value to return for it:
 * the program asked a question, something released the pause, and what was answered is not
 * recoverable. Returning `resolved` with an empty value would invent one.
 */
export class CheckpointAnswerMissing extends Error {
  constructor(readonly token: string, readonly answerId: string | undefined) {
    super(
      `checkpoint "${token}" settled as resumed but ${answerId === undefined
        ? "its settle fact names no answer"
        : `no answer record exists under the id ${answerId} it names`}; ` +
        `a workflow checkpoint is answered through the run driver's resolveCheckpoint, which writes the answer BEFORE presenting the token`,
    );
    this.name = "CheckpointAnswerMissing";
  }
}

/** How the handler learns that a checkpoint settled. Injected so a test can drive it directly. */
export interface SettleWatcher {
  /**
   * Resolve when this ref's one-use settle fact exists. Called AFTER the mint, so a fact that
   * already landed — the ordinary case for a run resuming across a crash — must resolve at once
   * rather than wait for an event that has already happened.
   */
  awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact>;
}

/**
 * The one subject the whole seam is gated by: every refused effect addresses an agent handle, and
 * only `spawn` produces one. Named once so the five refusals cannot drift into five reasons.
 */
const ACTION_MACHINERY = "the durable-action machinery an agent handle comes from";

export class MeshHandler {
  constructor(
    private readonly kv: KV,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly binding: MeshHandlerBinding,
    private readonly watcher: SettleWatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  now(): number {
    return this.clock();
  }

  /**
   * WHAT to repair when this process takes a run over. The driver decides WHEN and calls this.
   *
   * It is a method rather than an optional hook the host wires: an adopted run whose timers stay
   * armed at the predecessor's coordinates fires where nobody listens, and the object that knows how
   * to re-arm is the one the driver already holds.
   *
   * Failures are raised, not swallowed: a driver holding a run whose pauses it could not re-arm
   * cannot advance it.
   */
  async adopted(entries: readonly JournalEntry[]): Promise<string[]> {
    return await rearmOutstandingPauses(
      { kv: this.kv, js: this.js, jsm: this.jsm },
      this.binding,
      entries,
    );
  }

  /**
   * `sleep` is a checkpoint nobody answers.
   *
   * There is no separate timer plane and there should not be one: a durable pause with a deadline,
   * a token that survives a crash, and a one-use settle is exactly what the checkpoint plane is,
   * and a second mechanism would be a second thing to get wrong. The difference is only that no
   * `resolveCheckpoint` will ever arrive for this token, so the timer's expiry is the whole story
   * and `null` is the whole answer.
   */
  async sleep(req: SleepRequest, ctx: EffectContext): Promise<null> {
    const ref: CheckpointRef = { endpoint: this.binding.endpoint, token: ctx.requestId };
    const now = this.now();
    const deadline = now + parseDuration(req.duration);

    // The record is durable BEFORE the timer exists, and the MINT is what asks for the timer —
    // this handler never emits its own schedule request. That is not tidiness: mint re-emits at
    // the status's CURRENT authoritative generation, so a replay repairs the crash-before-arm
    // window without rolling a heartbeat-advanced deadline back to the one this caller computed.
    // A request emitted from here would carry the caller's coordinates and could arm a stale
    // generation the writer would then have to be trusted to ignore.
    await this.arm(ref, deadline);

    await this.settle(ref);
    return null;
  }

  /**
   * `checkpoint` is the same durable pause with somebody expected to answer it.
   *
   * The mint is identical to `sleep`'s — one token, one deadline, one settle fact — and everything
   * that differs is on the ANSWER side, which is deliberately not this handler's to arrange: the
   * run driver's `resolveCheckpoint` writes the answer record and presents the token, because the
   * checkpoint's holder is the driver and a resume is holder-bound. So this waits, and then reads
   * what the arbiter says was accepted.
   *
   * It returns the RAW outcome and never the program's result. Whether an expiry throws or returns
   * is `onExpiry`, which is computed from today's source on the live path and the replay path
   * alike; deciding it here would bake one answer into the journal.
   */
  async checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    const ref: CheckpointRef = { endpoint: this.binding.endpoint, token: ctx.requestId };
    const now = this.now();
    const deadline = now + parseDuration(req.timeout ?? this.binding.defaultCheckpointTimeout);

    await this.arm(ref, deadline);

    const settled = await this.settle(ref);
    if (settled.settle === "expired") return { outcome: "expired", at: settled.ts };
    // The settle NAMES its answer, and the record is read under that name rather than by looking
    // for "the answer to this token": two resolvers can have filed answers and only one of them
    // was accepted, so an answer found by token alone could be the loser's.
    const answer = settled.answerId === undefined
      ? undefined
      : await readCheckpointAnswer(this.kv, this.binding.endpoint, ref.token, settled.answerId);
    if (answer === undefined) throw new CheckpointAnswerMissing(ref.token, settled.answerId);
    return {
      outcome: "resolved",
      ...(answer.value !== undefined ? { value: answer.value } : {}),
      ...(answer.artifact !== undefined ? { artifact: answer.artifact } : {}),
      by: answer.by,
      answerId: answer.answerId,
      at: settled.ts,
    };
  }

  /**
   * `wait` — an event await that survives the process waiting for it.
   *
   * A DURABLE consumer named from `ctx.requestId` holds the run's position on the channel, so an
   * event published while the host was down is still there when the run re-attaches under the same
   * derived name. An ephemeral consumer, or one created on resume, starts from "now" and the event
   * never happened.
   *
   * The TIMEOUT rides the checkpoint plane and is minted once with an absolute deadline, so a
   * resumed 20-minute wait with 30 seconds left has 30 seconds left. A timeout resolves `null` and
   * never throws: `??` is `otherwise`.
   *
   * `replied(agent)` and `down(agent)` are not here. They address an agent handle, which only
   * `spawn` produces, so they refuse through the same named seam as the durable actions.
   */
  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    const ev = req.event;
    if (ev.event === "replied" || ev.event === "down") {
      throw new NotYetDurable(`wait(${ev.event}(…))`, ACTION_MACHINERY);
    }
    if (!isConcreteChannel(ev.channel)) {
      throw new Error(`wait() cannot await a wildcard channel ("${ev.channel}"); an await names one channel`);
    }
    // A recorded seq is a previous attempt's MATCH, taken before the crash. Return that message
    // rather than looking again: the consumer has already acked it, so looking again would wait for
    // a second event the program never asked for.
    const bound = ctx.resume?.chatSeq;
    if (typeof bound === "number") return await this.messageAt(bound);

    const timeoutAt = req.timeout === undefined ? undefined : this.now() + parseDuration(req.timeout);
    const idleFor = ev.event === "idle" ? parseDuration(ev.duration) : undefined;
    const matcher = ev.event === "message" && ev.matches !== undefined ? compileMatch(ev.matches) : undefined;
    const from = ev.event === "message" ? ev.from : undefined;

    // ONE token per deadline, both derived, so a resume re-derives them instead of remembering.
    // The step's own id is the deadline that DEFINES the wait — the idle window where there is one,
    // the timeout otherwise — and a second, derived id carries an idle wait's outer timeout.
    const primary = idleFor !== undefined || timeoutAt !== undefined
      ? { endpoint: this.binding.endpoint, token: ctx.requestId }
      : undefined;
    const outer = idleFor !== undefined && timeoutAt !== undefined
      ? { endpoint: this.binding.endpoint, token: derivedToken(ctx.requestId, "wait-timeout") }
      : undefined;
    if (primary !== undefined) {
      await this.arm(primary, idleFor !== undefined ? this.now() + idleFor : timeoutAt!);
    }
    if (outer !== undefined) await this.arm(outer, timeoutAt!);

    const durable = waitConsumerName(ctx.requestId);
    const stream = chatStream(this.binding.space);
    await this.jsm.consumers.add(stream, waitConsumerConfig(this.binding.space, ctx.requestId, ev.channel));
    const consumer = await this.js.consumers.get(stream, durable);
    // Set on each of the three paths that END the wait, and read by the cleanup below. A THROW is
    // not one of them — see the note there.
    let over = false;
    try {
      for (;;) {
        // The deadline is durable and authoritative — a checkpoint's settle fact — and this is only
        // the OBSERVATION of it, so the cost of polling is lateness bounded by one poll rather than
        // a wait that outlives its deadline.
        const ended = await this.expired(outer ?? (idleFor === undefined ? primary : undefined));
        if (ended !== undefined) { over = true; return null; }
        if (idleFor !== undefined && (await this.expired(primary)) !== undefined) {
          over = true;
          return { channel: ev.channel, at: this.now() };
        }
        for await (const m of await consumer.fetch({ max_messages: 16, expires: WAIT_POLL_MS })) {
          const msg = decodeMessage(m.data);
          if (idleFor !== undefined) {
            // ANY traffic resets an idle window, matched or not: "idle" is a fact about the
            // channel, not about the messages this program finds interesting.
            m.ack();
            await this.push(primary!, this.now() + idleFor);
            continue;
          }
          if (msg === undefined || !matchesEvent(msg, from, matcher)) { m.ack(); continue; }
          // BIND BEFORE ACK. The bind is durable; the ack is what makes the message unrecoverable.
          // In this order a crash in between redelivers it, and a crash after it is answered from
          // the recorded sequence — in the other order the match is simply lost.
          await ctx.bind({ chatSeq: m.seq });
          m.ack();
          if (primary !== undefined) await this.cancelTimer(primary);
          if (outer !== undefined) await this.cancelTimer(outer);
          over = true;
          return msg;
        }
      }
    } finally {
      // A THROW IS NOT AN ENDING. The three returns above are the wait being over and its position
      // worthless; a throw leaves the step pending, and the consumer's position is the only record
      // of where this run reached on the channel. `ctx.bind` is a journal append and a journal can
      // refuse one (L5010, RunSuperseded), so a throw here is ordinary operation and not only a bug.
      // Keeping the consumer costs one durable on an abandoned run, which is what a host crash
      // already costs; reaping on inactivity instead could delete a live wait's position while its
      // host was down.
      if (over) {
        try {
          await this.jsm.consumers.delete(stream, durable);
        } catch { /* already gone, or never created — either way there is nothing to hold */ }
      }
    }
  }

  /**
   * `notify` writes one bounded decision record per addressee, onto the run.
   *
   * NOT a channel post, and that is the whole point of the primitive: a post would put the program
   * into the conversation as a participant, where conversation is the data plane and
   * the program is the control plane. A notice is data filed on the run and rendered ahead of the
   * addressee's next turn.
   *
   * **One call to N agents is N records, and a retry lands on its own.** The id is derived from the
   * step's request id and the addressee, so a crash between the second and third write is repaired
   * by re-running the call: the first two creates find their own bytes and return, the third
   * happens. Nothing is written twice and nothing needs a memo of how far it got.
   *
   * The fact's bound is the language's and is enforced BEFORE this is reached (L3043 at the effect
   * boundary), so a fact that could not be rendered as one table row cannot arrive here.
   */
  async notify(req: NotifyRequest, ctx: EffectContext): Promise<null> {
    const at = this.now();
    const step = stepKeyString(ctx.key);
    for (const agent of req.agents) {
      const noticeId = runNoticeId(ctx.requestId, agent.agent);
      await writeRunNotice(this.kv, this.binding.endpoint, noticeId, {
        v: 1,
        run: this.binding.runId,
        step,
        addressee: agent.agent,
        fact: req.fact,
        at,
      });
    }
    return null;
  }

  // ── The Lane-A seam ────────────────────────────────────────────────────────────────────────────
  //
  // Every effect below addresses an AGENT HANDLE, and only `spawn` produces one. So the whole group
  // is gated by a single subject — the durable-action machinery `spawn` rides — rather than by five
  // separate absences, which is why they refuse through one class with one reason.
  //
  // THEY ARE HERE RATHER THAN ABSENT, and that is the point of the slice. A handler that simply
  // lacks the method fails as a TypeError from inside the interpreter: a fault about JavaScript
  // rather than about the run, at a call site that says nothing about what is missing or when it
  // arrives. The refusal is the honest two-exit — the simulator performs all five, so a program
  // using them can be written, validated and dry-run today, and a DURABLE run declines rather than
  // performing an effect it could not recover after a crash.
  //
  // THE REFUSAL IS TERMINAL FOR THE RUN THAT HITS IT, and the mechanism is worth stating exactly
  // rather than assumed. The interpreter settles the entry `failed` with the code the handler
  // raised, so the step is recorded as attempted-and-failed and a resume replays that failure — the
  // run does not heal the day the durable-action surface lands. It is recorded as L5016 rather than
  // a generic handler fault so the journal at least says which of the two happened.
  //
  // Whether it SHOULD be terminal is a live question and not this file's to settle: an effect a
  // host cannot perform is closer to a release than to a failure, and leaving the entry pending
  // would let a later driver perform it. That changes the interpreter's fault contract and a
  // property other lanes have been told about, so it is referred up rather than taken here.

  async spawn(_req: unknown, _ctx: EffectContext): Promise<never> {
    throw new NotYetDurable("spawn(…)", ACTION_MACHINERY);
  }

  async turn(_req: unknown, _ctx: EffectContext): Promise<never> {
    throw new NotYetDurable("turn(…)", ACTION_MACHINERY);
  }

  async ask(_req: unknown, _ctx: EffectContext): Promise<never> {
    throw new NotYetDurable("ask(…)", ACTION_MACHINERY);
  }

  async monitor(_req: unknown, _ctx: EffectContext): Promise<never> {
    throw new NotYetDurable("monitor(…)", ACTION_MACHINERY);
  }

  /**
   * A conclave, refused with the rest — and this one is an OVER-refusal, stated rather than hidden.
   *
   * A conclave's members are agent handles, so the ordinary case is gated exactly like the others.
   * `conclave([], …)` is not: a sub-team with nobody in it is a channel, and the channel plane is
   * here. It is refused anyway, because shipping the empty case alone would put half a primitive on
   * the durable plane — a program that works with no members and refuses with one is a worse thing
   * to explain than a primitive that is not here yet.
   */
  async openConclave(_req: unknown, _ctx: EffectContext): Promise<never> {
    throw new NotYetDurable("conclave(…)", ACTION_MACHINERY);
  }

  async closeConclave(_req: unknown, _ctx: EffectContext): Promise<never> {
    throw new NotYetDurable("conclave(…)", ACTION_MACHINERY);
  }

  /**
   * Arm this pause, or ATTACH to the one already recorded under the same token.
   *
   * A mint is idempotent only if the whole spec is identical, so the recorded deadline is the
   * authority and a resume may not recompute one: `now() + duration` is a different deadline a
   * second later, and the plane reads a different deadline as a different intent. The pause holds
   * it; a second copy anywhere else is a second thing to disagree.
   *
   * An already-passed deadline cannot be minted at all, correctly, because a due pause is not being
   * armed. It needs its schedule re-emitted at the status's current generation, which is the
   * reconciler's job. A spec with no status and an elapsed deadline is unrepairable from here, so it
   * is raised rather than waited on.
   */
  private async arm(ref: CheckpointRef, deadline: number): Promise<void> {
    // Over already: an expiry or an answer landed while this host was away. Nothing to arm, and the
    // caller reads the fact next.
    if ((await readCheckpointSettle(this.jsm, this.binding.space, ref)) !== undefined) return;
    const prior = await readCheckpointSpec(this.kv, ref);
    const now = this.now();
    const at = prior?.initialDeadline ?? deadline;
    if (at > now) {
      await mintCheckpoint(this.kv, this.js, this.binding.space, {
        ref,
        instanceId: this.binding.instanceId,
        epoch: this.binding.epoch,
        holder: this.binding.holder,
        deadline: at,
        now,
      });
      return;
    }
    const status = await readCheckpointStatus(this.kv, ref);
    if (status === undefined) {
      throw new Error(
        `checkpoint "${ref.token}" carries a spec with no status and its recorded deadline `
        + `(${at}) has passed; a mint repairs the missing status only while the deadline is still `
        + `ahead, so this pause has to be reconciled on the plane before the run can go on`,
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
  private async push(ref: CheckpointRef, deadline: number): Promise<void> {
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
    const subject = eptSubject(
      this.binding.space, ref.endpoint,
      this.binding.instanceId, this.binding.epoch, ref.token, "fire",
    );
    const fired = await this.jsm.streams
      .getMessage(eptStreamName(this.binding.space), { last_by_subj: subject })
      .catch(() => null);
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
  private async expired(ref: CheckpointRef | undefined): Promise<CheckpointSettleFact | undefined> {
    if (ref === undefined) return undefined;
    const settled = await readCheckpointSettle(this.jsm, this.binding.space, ref);
    if (settled !== undefined) return settled;
    if (!(await this.takeFire(ref))) return undefined;
    return await readCheckpointSettle(this.jsm, this.binding.space, ref);
  }

  /** End a deadline that is no longer waited on, by claiming its one-use settlement with no answer.
   *  A timer left armed would fire into a run that has moved on; claiming it is how the plane says
   *  "this pause is over" without a second mechanism for cancellation. */
  private async cancelTimer(ref: CheckpointRef): Promise<void> {
    const st = await readCheckpointStatus(this.kv, ref);
    if (st?.value.state !== "waiting") return;
    try {
      await resumeCheckpoint(this.kv, this.js, this.jsm, this.binding.space, {
        ref,
        presenter: this.binding.holder,
        now: this.now(),
      });
    } catch {
      // It settled underneath us — the deadline won a race it was already allowed to win. The
      // caller has its answer either way, and a cancelled timer is not a fact anyone reads.
    }
  }

  /** The message at a recorded stream sequence — the re-bind path after a crash. */
  private async messageAt(seq: number): Promise<unknown> {
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
  private async settle(ref: CheckpointRef): Promise<CheckpointSettleFact> {
    const already = await readCheckpointSettle(this.jsm, this.binding.space, ref);
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
      ]);
    } finally {
      wait.over = true;
    }
  }

  /** Take this deadline's fire for as long as somebody is waiting on it. */
  private async pumpFires(ref: CheckpointRef, wait: { over: boolean }): Promise<void> {
    while (!wait.over) {
      await this.takeFire(ref);
      // Unrefed: the loop is ended by the flag, not by this timer, and a wait that is already over
      // must not hold the process open for one more poll on its way out.
      await new Promise((r) => setTimeout(r, FIRE_POLL_MS).unref());
    }
  }
}

/** The durable that holds one wait's position on a channel. Derived from the step's own request id,
 *  which is why a resumed run finds the consumer its earlier attempt created rather than starting
 *  again from "now" — and why nothing about the wait has to be remembered across a crash. */
export function waitConsumerName(requestId: string): string {
  return `wfw_${requestId}`;
}

/**
 * The one definition of a wait's consumer, shared by the handler and by anything that has to
 * recreate it — so the name a resume looks for and the name a wait creates cannot drift apart.
 *
 * `deliver_policy: "new"` applies only to the FIRST create: an existing durable keeps its own
 * position, which is exactly what a resume needs, and events from before the program asked are not
 * this wait's to see.
 */
export function waitConsumerConfig(space: string, requestId: string, channel: string): Record<string, unknown> {
  return {
    durable_name: waitConsumerName(requestId),
    filter_subject: chatSubject(space, "*", "*", channel),
    ack_policy: "explicit",
    deliver_policy: "new",
  };
}

/** How long one poll of a wait's consumer blocks. The deadline itself is durable; this is only how
 *  late its observation can be, and a shorter poll buys latency at the cost of fetch traffic. */
const WAIT_POLL_MS = 2_000;

/** How often a pause that nobody will answer looks for the broker's fire. Same argument as
 *  `WAIT_POLL_MS`: the deadline is durable and this is only how late its observation can be. */
const FIRE_POLL_MS = 2_000;

/** A second deadline for one step, derived so a resume re-derives it instead of remembering it.
 *  Same shape and alphabet as a request id, so it is a valid `<token>` by construction. */
function derivedToken(requestId: string, purpose: string): string {
  return createHash("sha256").update(`${requestId}:${purpose}`, "utf8").digest("base64url").slice(0, 43);
}

/**
 * A `matches` pattern, admitted through the repo's bounded-regex subset before it is compiled.
 *
 * A workflow is other people's text and a channel can be busy, so an exponential pattern here is a
 * run that stalls with nothing to show for it. The subset is the same one the schema profile
 * admits, which means the same rule applies: a pattern is ANCHORED (`^…`), and an author who wants
 * "somewhere in the message" writes `^.*…` themselves. Wrapping it for them was the alternative and
 * it is worse — the wrapper turns patterns that are safe as written into refusals about a `.*` the
 * author never typed.
 */
function compileMatch(pattern: string): RegExp {
  try {
    assertSafePattern(pattern, 256);
  } catch (e) {
    throw new Error(`wait()'s \`matches\` is a bounded regular expression, anchored like every pattern in this repo: ${(e as Error).message}`);
  }
  return new RegExp(pattern);
}

function decodeMessage(data: Uint8Array): CotalMessage | undefined {
  try {
    const v = JSON.parse(new TextDecoder().decode(data)) as CotalMessage;
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    // Someone else's malformed publish is not this run's failure. It does not match, and the wait
    // goes on waiting — which is what would happen if the message had never been sent.
    return undefined;
  }
}

/** Does this message answer the await? `from` is matched on the SENDER'S NAME as the mesh records
 *  it, never on the subject: the subject carries a principal, and a program names an agent. */
function matchesEvent(msg: CotalMessage, from: string | undefined, matcher: RegExp | undefined): boolean {
  if (from !== undefined && msg.from?.name?.toLowerCase() !== from.toLowerCase()) return false;
  if (matcher === undefined) return true;
  const text = (msg.parts ?? [])
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
  return matcher.test(text);
}

/**
 * An effect whose durable substrate has not landed on this host.
 *
 * An honest two-exit, and deliberately not a fake success: the simulator implements these, so a
 * program that uses them can be written, validated and dry-run today — but a DURABLE run refuses
 * rather than performing them on a plane that could not recover them. A run that "succeeded" at an
 * effect nothing can replay would be a lie the journal then carries forever.
 */
export class NotYetDurable extends Error {
  /**
   * L5016, and it is load-bearing rather than decorative.
   *
   * The interpreter wraps a handler's fault into an `EffectError` and SETTLES the entry with it, so
   * the class does not survive the boundary — a caller of `run()` sees an `EffectError`, and the
   * journal keeps whatever code was on it. Without this the entry would read `L4000 handler-fault`:
   * "the handler broke", written durably about a step nothing ever attempted. The interpreter
   * honours an L-code a handler raises, so the recorded fact says what actually happened.
   */
  readonly code = "L5016";

  constructor(readonly effect: string, readonly needs: string) {
    super(
      `${effect} is not durable on this host yet: it rides ${needs}, which has not landed. ` +
        `The simulator performs it, so the program can be tested and dry-run; a durable run refuses ` +
        `rather than performing an effect it could not recover after a crash.`,
    );
    this.name = "NotYetDurable";
  }
}

/**
 * RE-ARM the timers of every pause this run is still holding, under THIS driver's coordinates.
 *
 * A checkpoint's armed schedule fires onto `ept.<space>.<e>.<instanceId>.<epoch>.<token>.fire`,
 * derived from the coordinates of the instance that armed it. A run adopted by another host — or by
 * the same host at a new epoch — therefore has live timers firing at a subject nobody is reading,
 * and its pauses would sit until something else swept them. Nothing about that is repaired by
 * resuming the program: the effect is a replayed pending step that goes straight back to waiting.
 *
 * So the driver re-emits a schedule request for each outstanding token at the CURRENT generation,
 * which the timer writer arms onto this instance's own fire subject. Over-emission is harmless by
 * construction (same `(timerId, generation)` re-derives the same `.armed`, a no-op replacement), so
 * this is safe to run on every takeover and needs no record of what it did last time.
 *
 * Called AFTER the barrier activated, never before: arming timers for a run this process turned out
 * not to hold would point another driver's fires at this one.
 */
export async function rearmOutstandingPauses(
  deps: { kv: KV; js: JetStreamClient; jsm: JetStreamManager },
  binding: Pick<MeshHandlerBinding, "space" | "endpoint" | "instanceId" | "epoch">,
  entries: readonly JournalEntry[],
): Promise<string[]> {
  const rearmed: string[] = [];
  for (const token of outstandingPauseTokens(entries)) {
    const r = await reconcileCheckpointSchedule(deps.kv, deps.js, deps.jsm, binding.space, {
      ref: { endpoint: binding.endpoint, token },
      instanceId: binding.instanceId,
      epoch: binding.epoch,
    });
    if (r.reEmitted) rearmed.push(token);
  }
  return rearmed;
}

/**
 * The checkpoint tokens a replayed prefix leaves open.
 *
 * An entry is open when its LAST record is `pending`, so the map is built in append order and the
 * later record wins — a step that settled has a settled entry after its pending one, and reading
 * only the first would re-arm timers for pauses that are already over.
 *
 * THE KINDS ARE THE THREE THAT ARM A TIMER, and `wait` is one of them. It mints no pause of its own
 * so it does not look like one, but its idle window and its timeout are mediated deadlines exactly
 * as `sleep`'s is, and a `wait` adopted at a new epoch would otherwise wait on a deadline no live
 * epoch fires.
 *
 * An idle wait with a timeout arms TWO, and the second is DERIVED rather than recorded, so it is
 * re-derived here for the same reason the live path derives it: a resume that had to remember it
 * would be carrying state the key already determines. Emitting it for a wait that never minted one
 * is harmless by construction — the reconciler reads the checkpoint's status first and re-emits
 * nothing when there is none — and the alternative, reading the request shape back out of the
 * entry to decide, would make the repair depend on a field a replay is not guaranteed to carry.
 */
export function outstandingPauseTokens(entries: readonly JournalEntry[]): string[] {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) last.set(journalEntryKeyString(e), e);
  const tokens: string[] = [];
  for (const e of last.values()) {
    if (e.state !== "pending" || e.requestId === undefined) continue;
    if (e.kind === "sleep" || e.kind === "checkpoint") tokens.push(e.requestId);
    else if (e.kind === "wait") tokens.push(e.requestId, derivedToken(e.requestId, "wait-timeout"));
  }
  return tokens;
}

/**
 * The settle watcher over EPF, which is where the one-use settle fact lives.
 *
 * An EPHEMERAL consumer filtered to this token's settle subject, created for one wait and removed
 * after it: the fact is written once and read once, so a durable would be a name to collide on and
 * a thing to clean up, for a subscription that outlives nothing. `deliver_policy: all` because the
 * fact may already be there — a settle is a record, not a notification, and a watcher that only saw
 * new messages would wait forever for one that already happened.
 */
export class EpfSettleWatcher implements SettleWatcher {
  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly space: string,
    private readonly pollMs = 30_000,
  ) {}

  async awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact> {
    const stream = epfStreamName(this.space);
    const filter = checkpointSettleSubject(this.space, ref);
    const created = await this.jsm.consumers.add(stream, {
      filter_subject: filter,
      ack_policy: "explicit" as never,
      deliver_policy: "all" as never,
      inactive_threshold: 300_000 * 1_000_000,
    });
    const name = created.name;
    try {
      const consumer = await this.js.consumers.get(stream, name);
      for (;;) {
        const batch = await consumer.fetch({ max_messages: 1, expires: this.pollMs });
        for await (const m of batch) {
          m.ack();
          const settled = await readCheckpointSettle(this.jsm, this.space, ref);
          // Read the fact back through the plane's own parser rather than trusting these bytes: the
          // subject is one-use, so whatever is on it IS the answer, and the parser is what says the
          // answer is well formed.
          if (settled !== undefined) return settled;
        }
      }
    } finally {
      try {
        await this.jsm.consumers.delete(stream, name);
      } catch {
        // The consumer carries its own inactivity threshold, so a failed delete is reaped rather
        // than leaked — the case `run-journal` had to learn the hard way.
      }
    }
  }
}
