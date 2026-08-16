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
import { createHash } from "node:crypto";
import {
  mintCheckpoint,
  heartbeatCheckpoint,
  resumeCheckpoint,
  readCheckpointSettle,
  readCheckpointAnswer,
  readCheckpointStatus,
  reconcileCheckpointSchedule,
  checkpointSettleSubject,
  epfStreamName,
  chatStream,
  chatSubject,
  isConcreteChannel,
  assertSafePattern,
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
   * `wait` — an event await that survives the process waiting for it.
   *
   * The mechanism is a DURABLE JetStream consumer named from `ctx.requestId`, created before the
   * wait begins. That is the whole durability argument: the consumer holds the run's position on
   * the channel, so an event published while the run's host was down is still there when the run
   * comes back and re-attaches under the same derived name. An ephemeral consumer, or one created
   * on resume, would silently start from "now" and the event would simply never have happened.
   *
   * The TIMEOUT rides the checkpoint plane, which makes it durable too: it is minted once with an
   * absolute deadline, so a wait that spans a crash resumes against the ORIGINAL deadline rather
   * than restarting the clock — a resumed 20-minute wait that had 30 seconds left has 30 seconds
   * left. A timeout resolves `null` and never throws (design §5.7, D5: `??` is `otherwise`).
   *
   * Two of the four event kinds are NOT here. `replied(agent)` and `down(agent)` are addressed to an
   * agent HANDLE, which comes from `spawn` — and `down` additionally needs `monitor` to have
   * registered interest. They are gated by their input rather than by their mechanism, and they
   * refuse through the same named seam as the durable actions themselves.
   */
  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    const ev = req.event;
    if (ev.event === "replied" || ev.event === "down") {
      throw new NotYetDurable(`wait(${ev.event}(…))`, "the durable-action machinery an agent handle comes from");
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
    try {
      for (;;) {
        // The deadline is durable and authoritative — a checkpoint's settle fact — and this is only
        // the OBSERVATION of it, so the cost of polling is lateness bounded by one poll rather than
        // a wait that outlives its deadline.
        const ended = await this.expired(outer ?? (idleFor === undefined ? primary : undefined));
        if (ended !== undefined) return null;
        if (idleFor !== undefined && (await this.expired(primary)) !== undefined) {
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
          return msg;
        }
      }
    } finally {
      // The wait is over however it ended, so its position is worthless. Deleted rather than left
      // to an inactivity threshold: a threshold that could reap a LIVE wait's consumer while its
      // host was down would lose exactly the events the durable exists to hold.
      try {
        await this.jsm.consumers.delete(stream, durable);
      } catch { /* already gone, or never created — either way there is nothing to hold */ }
    }
  }

  /** Mint a deadline, idempotently. The same token re-minted with the same deadline attaches. */
  private async arm(ref: CheckpointRef, deadline: number): Promise<void> {
    await mintCheckpoint(this.kv, this.js, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      holder: this.binding.holder,
      deadline,
      now: this.now(),
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

  /** Has this deadline settled? `undefined` for "no deadline" and for "not yet". */
  private async expired(ref: CheckpointRef | undefined): Promise<CheckpointSettleFact | undefined> {
    if (ref === undefined) return undefined;
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
    return already ?? (await this.watcher.awaitSettle(ref));
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
