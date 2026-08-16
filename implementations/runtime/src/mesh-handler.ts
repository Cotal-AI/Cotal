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
 * resumes re-derives the same token, and `mintCheckpoint` is idempotent-if-identical: the resumed
 * attempt ATTACHES to the timer the crashed one armed instead of arming a second. Nothing here has
 * to remember anything across a crash, because the identity was recorded before the work started.
 */
import {
  mintCheckpoint,
  readCheckpointSettle,
  readCheckpointAnswer,
  reconcileCheckpointSchedule,
  checkpointSettleSubject,
  epfStreamName,
  type CheckpointRef,
  type CheckpointSettleFact,
} from "@cotal-ai/core";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  parseDuration,
  type CheckpointRaw,
  type CheckpointRequest,
  type EffectContext,
  type JournalEntry,
  type SleepRequest,
  journalEntryKeyString,
} from "@cotal-ai/lang";

/** Who this handler acts as, and where. All of it is the DRIVER's identity, not the program's. */
export interface MeshHandlerBinding {
  readonly space: string;
  /** The endpoint hosting the driver — the manager daemon (§10). */
  readonly endpoint: string;
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
    await mintCheckpoint(this.kv, this.js, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      holder: this.binding.holder,
      deadline,
      now,
    });

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
   * alike; deciding it here would bake one answer into the journal (design §5.5, §6).
   */
  async checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    const ref: CheckpointRef = { endpoint: this.binding.endpoint, token: ctx.requestId };
    const now = this.now();
    const deadline = now + parseDuration(req.timeout ?? this.binding.defaultCheckpointTimeout);

    await mintCheckpoint(this.kv, this.js, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      holder: this.binding.holder,
      deadline,
      now,
    });

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
   * Wait for this token's one-use settlement.
   *
   * A settle that ALREADY landed is the ordinary case on a resume: the run crashed while paused and
   * the timer fired, or somebody answered, without it. Reading before waiting is not an
   * optimization, it is the difference between resuming and waiting forever for an event that is
   * already in the past.
   */
  private async settle(ref: CheckpointRef): Promise<CheckpointSettleFact> {
    const already = await readCheckpointSettle(this.jsm, this.binding.space, ref);
    return already ?? (await this.watcher.awaitSettle(ref));
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
 */
export function outstandingPauseTokens(entries: readonly JournalEntry[]): string[] {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) last.set(journalEntryKeyString(e), e);
  const tokens: string[] = [];
  for (const e of last.values()) {
    if (e.state !== "pending" || e.requestId === undefined) continue;
    if (e.kind === "sleep" || e.kind === "checkpoint") tokens.push(e.requestId);
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
