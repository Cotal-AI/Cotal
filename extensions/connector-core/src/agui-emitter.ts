/**
 * The AG-UI event emitter, the one part of the event plane that TALKS: it reads a durable source
 * forward from the WAL's cursor, maps records to events, packs them into frames that provably fit,
 * and appends them to the principal's event channel under an optimistic-concurrency expectation
 * with a frozen dedup id. The vocabulary it speaks is `agui.ts`, which does no I/O and does not
 * import this module.
 *
 * The emitter owns no policy about WHAT an event means. That belongs to the per-connector mapping,
 * and it arrives here as an injected function. What it owns is the property none of the pieces hold
 * alone: that a frame is either on the wire and folded into the frontier, or not on the wire and
 * not folded, and that no third state is ever reported as success.
 */

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isAguiFramePart, isCasLoss, principalKey, type Part } from "@cotal-ai/core";
import {
  AguiBrackets,
  AguiVocabularyError,
  aguiFrame,
  applyAguiEgressPolicy,
  extraPropertyPath,
  frozenBodyEgressVerdict,
  RUN_ERROR_EGRESS_MESSAGE,
  AGUI_EVENT_TYPE,
  runError,
  runFinished,
  type AguiEvent,
  type AguiFrame,
  type CotalMeta,
} from "./agui.js";
import type { DurableSource, SourceGap, SourceRead } from "./durable-source.js";
import type { EventWal } from "./event-wal.js";
import { eventChannelForSession } from "./launch.js";
import type { SubjectFrontier } from "./subject-frontier.js";

/**
 * The endpoint surface the emitter needs, declared STRUCTURALLY rather than as `CotalEndpoint`.
 *
 * Not for testability as an end in itself — for a specific one. A cell that needs a live broker to
 * exercise the duplicate-ack halt cannot be written at all before a broker exists, and a cell that
 * re-implements `encodedSize` is measuring a copy. This interface is the exact set of methods the
 * emitter calls, so a cell substitutes an instrument and the production path substitutes the real
 * endpoint, and neither one is a re-implementation of the other.
 */
export interface EmitterEndpoint {
  readonly principal: { owner: string; actor: string };
  readonly actorIsEphemeral: boolean;
  /** The broker's live `max_payload`. Throws when not connected — never guesses a default. */
  readonly maxPayload: number;
  /** The single-replica preflight. The emitter calls this at startup, before anything can publish. */
  assertExpectationSemantics(): Promise<void>;
  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number;
  multicastExpecting(o: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
  }): Promise<{ ack: { seq: number; duplicate: boolean } }>;
}

/**
 * One source record's worth of events, with the cursor that resumes AFTER that record.
 *
 * One durable emit unit is one frame: the emitter splits only at source-observation boundaries that
 * are independently reconstructable from the durable source. A frame therefore ends where a record
 * ends, and carries that record's cursor, so folding it means exactly "every record here is
 * consumed".
 */
export interface EmitUnit {
  /** The run these events belong to. A frame's envelope names ONE run, so units are never
   *  mixed across runs in one frame. */
  runId: string;
  events: AguiEvent[];
  cursor: string;
  /** The turns the source began at or just before this unit, in source order: the run each one
   *  opened, or `null` for a turn that opened none. Committed as the last turn begun when the frame
   *  carrying the unit is frozen, see {@link AguiEmitter.queueTerminal}. */
  turns?: (string | null)[];
}

/** A turn terminal the connector reported at a boundary the record stream cannot see, kept until
 *  the run it belongs to can take it: `error` closes that run with `RUN_ERROR`, its absence with
 *  `RUN_FINISHED`. */
export interface HeldTerminal {
  timestamp: number;
  error?: { message: string; code?: string };
}

/** A terminal with the position the source had reached when the connector reported it: the cursor
 *  its {@link DurableSource.end} answered then. Which turn the terminal ends is read off that
 *  position, see {@link AguiEmitter.queueTerminal}. */
export interface ReportedTerminal {
  terminal: HeldTerminal;
  at: Promise<string>;
}

/**
 * What the mapper returns for one source record: its run and its events, or `null` for a record
 * this plane deliberately drops, and it drops many. `null` is NOT an error: a deliberate drop and
 * a failed map are kept apart, because conflating them turns a parser bug into skipped history.
 *
 * `{ turn: true }` is a record that BEGAN A TURN AND OPENED NO RUN: a prompt the mapper knows and
 * deliberately does not publish. It is still a turn the harness ends with a terminal, so the
 * emitter counts it as a turn when it places a terminal reported after it (see
 * {@link AguiEmitter.queueTerminal}); dropped as `null`, that terminal would land on the run begun
 * before it. A record that opens a run begins its turn by its `RUN_STARTED`.
 */
export type RecordMapper<T> = (record: T) => { runId: string; events: AguiEvent[] } | { turn: true } | null;

/**
 * A bracket violation that is OURS, not the writer's: the machine that tracks open runs and messages
 * was lost across a process restart.
 *
 * **This exists because two halts that both say "unbalanced" prove nothing about which produced
 * one.** The WAL persists `epoch`, `frontier` and the pending frame, and NOT the set of open
 * runs and messages, so a process that dies mid-run restarts with an empty {@link AguiBrackets},
 * resumes from `sourceCursor` at events whose `RUN_STARTED` was already published, and refuses the
 * first of them. Without this class the operator sees "nothing may be emitted outside an open run"
 * and files a bug against a writer that did nothing wrong.
 *
 * It is deliberately a SUBCLASS: every existing catch of {@link AguiVocabularyError} still catches
 * it, and only code that wants to tell the two apart has to know it exists.
 */
export class AguiBracketStateLost extends AguiVocabularyError {
  constructor(message: string, readonly cause: Error) {
    super(message);
    this.name = "AguiBracketStateLost";
  }
}

/**
 * The emitter has stopped and will not publish again without operator action.
 *
 * Halting is a SUCCESS of this design, not a failure of it: every halt below is a case where the
 * alternative is to report success for a message that was not stored, or to fold an ack for a body
 * we did not write. A halt is loud, bounded and recoverable by a human; the alternative is silent
 * and permanent.
 */
export class AguiEmitterHalted extends Error {
  constructor(
    readonly reason: "duplicate-ack" | "cas-loss" | "egress-policy" | "egress-unreadable" | "egress-extra-property" | "egress-run-error",
    message: string,
  ) {
    super(message);
    this.name = "AguiEmitterHalted";
  }
}

/**
 * The id used only for SIZING, and it is the longest one `assertIdToken` admits.
 *
 * Sizing must never report a smaller number than publishing will produce, and the id is not known
 * when a frame is measured — it is minted per publish attempt. Measuring at the maximum admissible
 * length makes the measurement an UPPER BOUND over every id the emitter could mint, which costs a
 * few bytes of packing density and removes an entire class of near-ceiling defect. The alternative,
 * measuring with the id we intend to use, requires minting before packing and freezing an id for a
 * frame that may never be built.
 */
const SIZING_ID = "S".repeat(64);

/**
 * Likewise for the expectation, and this one CANNOT be known at pack time even in principle.
 *
 * `expectedLastSubjectSeq` for frame k+1 is the sequence the broker assigns frame k, and the stream
 * sequence advances with every message in the space, not only ours. Its decimal length is therefore
 * unknowable while packing. `MAX_SAFE_INTEGER` is the widest value the publish path will accept, so
 * measuring at it bounds every expectation the emitter can ever send.
 */
const SIZING_EXPECTATION = Number.MAX_SAFE_INTEGER;

/**
 * Pack units into frames, splitting ONLY at unit boundaries and never inside one.
 *
 * Deliberately NOT `splitFrames`, and the difference is the durable plane's one-unit-one-frame
 * rule. `splitFrames` splits at EVENT boundaries, which is the right answer for a frame considered
 * on its own, but a frame that ends mid-record has no cursor it can honestly store: the only value
 * available says the whole record was consumed, and folding that after a crash skips the rest of the
 * record's events with no `seq` gap for a consumer to notice.
 *
 * **So the event-boundary split and the one-unit-one-frame rule are in tension, and this resolves it
 * in the direction the durable plane requires: a single unit that does not fit FAILS LOUD rather
 * than being truncated at a frame boundary.** That leaves `splitFrames`'s truncation path with no
 * caller on the durable plane, which is reported as a design conflict rather than decided here.
 *
 * @throws {AguiVocabularyError} when one unit cannot fit in a frame alone.
 */
export function packUnits(opts: {
  threadId: string;
  epoch: string;
  firstSeq: number;
  units: readonly EmitUnit[];
  measure: (frame: AguiFrame) => number;
  limit: number;
}): { frame: AguiFrame; cursor: string; unitFrom: number }[] {
  const { threadId, epoch, measure, limit } = opts;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new AguiVocabularyError(`pack limit must be a positive safe integer, got ${JSON.stringify(limit)}`);

  // `unitFrom` is the index of the first unit a frame carries, so a caller that must re-pack the
  // unpublished tail of a batch can say which units that tail is.
  const out: { frame: AguiFrame; cursor: string; unitFrom: number }[] = [];
  let seq = opts.firstSeq;
  let batch: AguiEvent[] = [];
  let batchRun: string | undefined;
  let batchCursor: string | undefined;
  let batchFrom = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    out.push({ frame: aguiFrame({ threadId, runId: batchRun as string, epoch, seq, events: batch }), cursor: batchCursor as string, unitFrom: batchFrom });
    seq += 1;
    batch = [];
    batchRun = undefined;
    batchCursor = undefined;
  };

  for (const [index, unit] of opts.units.entries()) {
    if (unit.events.length === 0)
      throw new AguiVocabularyError("packUnits was handed an empty unit; a record that maps to nothing advances the cursor and never becomes a frame");

    // A frame names ONE run. A unit from a different run cannot join the open batch even if it
    // would fit, so the run change is a flush and not a size decision.
    if (batchRun !== undefined && unit.runId !== batchRun) flush();

    const candidate = [...batch, ...unit.events];
    const fits =
      measure(aguiFrame({ threadId, runId: batchRun ?? unit.runId, epoch, seq, events: candidate })) <= limit;
    if (fits) {
      if (batch.length === 0) batchFrom = index;
      batch = candidate;
      batchRun = batchRun ?? unit.runId;
      batchCursor = unit.cursor;
      continue;
    }

    // It did not fit WITH the open batch. Flush and try it alone before concluding anything about
    // the unit itself: an ordinary unit that happens to arrive behind a nearly-full frame is not an
    // oversized unit, and treating it as one would halt the emitter on a packing accident.
    flush();
    const alone = aguiFrame({ threadId, runId: unit.runId, epoch, seq, events: unit.events });
    const aloneBytes = measure(alone);
    if (aloneBytes > limit)
      throw new AguiVocabularyError(
        `a single source observation does not fit in one frame (${aloneBytes} > ${limit} bytes, ` +
          `${unit.events.length} event(s), run ${unit.runId}). One source observation is one frame, ` +
          `and that rule requires this to fail loud rather ` +
          `than be truncated at a frame boundary: a frame that ends mid-record has no cursor it can ` +
          `honestly store, and a dropped boundary with no gap marker is worse than a halt.`,
      );
    batch = [...unit.events];
    batchRun = unit.runId;
    batchCursor = unit.cursor;
    batchFrom = index;
  }
  flush();
  return out;
}

/**
 * The event emitter: one per principal, one thread at a time.
 *
 * **BRACKET STATE SURVIVES A RESTART, AND THIS PARAGRAPH USED TO SAY THE OPPOSITE.** It described a
 * declared gap — an emitter coming back with an empty machine, resuming at events whose
 * `RUN_STARTED` had already been published, and refusing the first of them — long after the WAL
 * started persisting the machine. The words were true when they were written and stayed on the page
 * through the change that falsified them, which is the failure mode a class header is worst at
 * showing: it is the first thing a cutover author reads about recovery, and it was telling them to
 * expect a halt the code no longer produces.
 *
 * What actually happens: {@link AguiBrackets} is a property of the WRITER'S STREAM across frames, so
 * the WAL freezes the machine's state WITH each pending frame and promotes it on fold. A restart
 * therefore reopens knowing exactly which run, messages and tool calls were open at the last FOLDED
 * position, and {@link AguiBrackets.restore} continues from there rather than from empty.
 *
 * **The lost-state path still exists, and it is now the narrow case it should always have been:** a
 * document that CANNOT SAY what was open. That is a WAL migrated from v1, which recorded no bracket
 * state at all, and it loads as `null` rather than as an empty machine precisely so the difference
 * stays visible. Only there does the emitter start empty, resume into an already-open run, and
 * refuse the first event with {@link AguiBracketStateLost} — a halt rather than a loss, which is the
 * safe direction, and diagnosed by name rather than surfacing as an anonymous protocol violation.
 */
export class AguiEmitter<T> {
  /**
   * The bracket machine AT THE FOLDED POSITION — deliberately not "wherever validation got to".
   *
   * It advances one frame at a time, immediately before that frame's `beginSend`, so the state
   * frozen with a pending frame is the state that belongs to it. A machine advanced by the whole
   * batch up front would freeze a state describing events that had not been sent.
   */
  private brackets: AguiBrackets;
  private halted: AguiEmitterHalted | undefined;
  /** True once THIS process has fed an event through the bracket machine. It is the half of the
   *  restart diagnosis that keeps a genuine mid-stream violation from being blamed on a restart. */
  private fedAnyEvent = false;
  /** True once a pump has read the source: the last turn can be seeded only before that. */
  private pumped = false;
  /** Terminals owed to runs, by run: a terminal placed on a run the wire has open or a pump is
   *  about to open, published in place of the finish the source synthesizes for that run, or taken
   *  back by {@link takeOwed} for a close the holder makes. Settled at the freeze of the frame that
   *  closes the run. */
  private owed = new Map<string, ReportedTerminal>();
  /** Terminals reported at a position no pump has read up to yet, in the order they arrived. */
  private queued: ReportedTerminal[] = [];
  /**
   * The turn the frozen frames most recently began: the run it opened, `null` for one that opened
   * none, `undefined` while the log shows no turn. A terminal reported before any record a pump
   * reads is this turn's. Starts as the run the log has open, which is the last turn the log can
   * name; a holder that drops an emitter seeds the next one with what that emitter knew.
   */
  private lastTurn: string | null | undefined;

  private constructor(
    private readonly ep: EmitterEndpoint,
    private readonly wal: EventWal,
    private readonly source: DurableSource<T>,
    private readonly map: RecordMapper<T>,
    /** Derived from the endpoint's OWN principal, never from a config name or the launch env. */
    readonly channel: string,
    readonly threadId: string,
    private readonly onUnreadable: ((gap: SourceGap) => void) | undefined,
  ) {
    // RESTORED FROM THE WAL, which is the whole point of the v2 migration: a process that died
    // mid-run comes back knowing which runs and messages are open, instead of refusing the first
    // event it re-reads. `null` means the document cannot say (migrated from v1) — an empty machine
    // is the honest starting point there, and `diagnoseBracket` is what keeps the resulting refusal
    // from being blamed on the writer.
    this.brackets = wal.brackets ? AguiBrackets.restore(wal.brackets) : new AguiBrackets();
    this.lastTurn = this.brackets.runId;
  }

  /**
   * Start an emitter: resolve the channel, run the single-replica preflight, and settle any pending
   * frame.
   *
   * **THIS IS THAT PREFLIGHT'S PRODUCTION CALL SITE, AND UNTIL THIS FUNCTION EXISTED THERE WAS
   * NONE.** `CotalEndpoint.assertExpectationSemantics()` had zero production callers: it was a
   * check that shipped, was covered by its own suite, and never ran outside one. That is why it is
   * called HERE, before recovery and therefore before any publish — a serialized append on an
   * unverified stream is the exact case it exists to prevent, and doing it after recovery would
   * leave the one publish that matters most, the re-publish of a frozen frame, outside the guard.
   */
  static async start<T>(opts: {
    endpoint: EmitterEndpoint;
    /** Already open, so the caller owns `space`, the WAL path, and the `subjectMayExist` judgement
     *  — none of which the emitter can make honestly on the caller's behalf. */
    wal: EventWal;
    /**
     * The PRINCIPAL-scoped subject frontier. **Required, and not optional with a zero default.**
     *
     * The subject is shared by every thread of one principal, so the expectation a publish carries
     * is a fact about the principal and not about the thread. An optional parameter here would let
     * a new connector omit it and reintroduce, silently, the defect where an agent's second session
     * expects an empty subject its own first session filled. There is one thing to pass and there
     * is no legal way to not pass it.
     */
    subjectFrontier: SubjectFrontier;
    source: DurableSource<T>;
    map: RecordMapper<T>;
    /**
     * Where a {@link SourceGap} the source stepped over is reported. Optional, and the absence is
     * not a quiet default: a pump that meets a gap with no reporter refuses, naming the gap, so a
     * connector that never decided where gaps go keeps the loud answer rather than a silent hole.
     */
    onUnreadable?: (gap: SourceGap) => void;
  }): Promise<AguiEmitter<T>> {
    const { endpoint, wal } = opts;
    const channel = eventChannelForSession(endpoint);

    // The WAL must be THIS principal's. `EventWal.open` refuses a document whose stored principal
    // disagrees with what it was asked for, but that protects the file against being mistaken for
    // another; it cannot notice an emitter handed the wrong WAL object. Publishing under one
    // principal's identity while recovering another's frozen `E` is a fabricated frontier.
    const live = principalKey(endpoint.principal.owner, endpoint.principal.actor).key;
    if (wal.principal !== live)
      throw new Error(
        `event WAL belongs to principal ${wal.principal}, but this endpoint is ${live} — refusing to ` +
          `publish under one identity from another's write-ahead log`,
      );

    // THE SINGLE-REPLICA PREFLIGHT: before recovery, before any publish.
    await endpoint.assertExpectationSemantics();

    // REQUIRED AT RUNTIME, NOT ONLY IN THE TYPE. Smoke files in this repo are not typechecked, so a
    // caller that omits this would bind `undefined`, fall back to the per-thread number, and pass
    // every existing cell while shipping the exact defect this parameter exists to remove. A type
    // that only the compiler enforces is not a guard for the callers the compiler never sees.
    if (!opts.subjectFrontier || typeof opts.subjectFrontier.advance !== "function")
      throw new Error(
        `event emitter for ${channel}: a subject frontier is required — the subject is shared by every ` +
          `thread of this principal, so the publish expectation cannot come from one thread's log`,
      );

    // BOUND BEFORE RECOVERY, and the order matters for the same reason the preflight's does:
    // recovery can republish a frozen frame, and a WAL whose expectation still came from its own
    // thread would republish against the wrong tip.
    await wal.bindSubjectFrontier(opts.subjectFrontier);

    const em = new AguiEmitter<T>(endpoint, wal, opts.source, opts.map, channel, wal.threadId, opts.onUnreadable);
    await em.recover();
    // The run the wire has open once the pending frame is settled, which is the last turn the log
    // can name: a terminal reported before any record the first pump reads is that run's.
    em.lastTurn = em.brackets.runId;
    return em;
  }

  /** True once the emitter has stopped for good. */
  get stopped(): boolean {
    return this.halted !== undefined;
  }

  /** The run {@link closeRun} would close now, or `undefined` at a stopping point. */
  get openRunId(): string | undefined {
    return this.brackets.runId;
  }

  /**
   * Boot recovery, branching on the WAL's tag.
   *
   * `acked` NEVER republishes: the frame landed and we know it, so the only remaining work is to
   * fold. `sent_unacked` is the genuinely uncertain case and republishes with the SAME frozen `id`
   * and `E` — never the current tip, because re-deriving either is what turns an uncertain publish
   * into a second, different message.
   */
  private async recover(): Promise<void> {
    const p = this.wal.pending;
    if (!p) return;
    if (p.state === "acked") {
      await this.wal.fold();
      this.brackets = AguiBrackets.restore(p.brackets);
      return;
    }
    // The retried frame was accepted by a PREVIOUS process and is not fed through this instance's
    // machine again. Folding promotes its bracket snapshot on disk; promote the same snapshot here
    // or this emitter continues from the pre-pending state and rejects the next legal event.
    await this.attempt({ id: p.id, E: p.E, body: p.body, retry: true });
    this.brackets = AguiBrackets.restore(p.brackets);
  }

  /**
   * Read forward, map, pack, and publish. Returns what it did, so a caller can distinguish "nothing
   * to do" from "did work" without inspecting the WAL.
   */
  async pump(): Promise<{ frames: number; events: number }> {
    if (this.halted) throw this.halted;
    if (this.wal.pending)
      throw new Error(
        `event emitter for ${this.channel}: a frame is still pending; recovery must settle it before a new read`,
      );

    this.pumped = true;
    const read = await this.source.read(this.wal.frontier.sourceCursor);

    // A gap is a line the source stepped over; the cursor it returned is past it. It is handed to
    // the connector's reporter BEFORE anything below advances the frontier, so a connector that gave
    // this emitter nowhere to report keeps the old answer: the pump refuses, the cursor stays, and
    // the gap is named in the refusal. Silence is the one answer not on offer.
    for (const gap of read.unreadable ?? []) {
      if (!this.onUnreadable)
        throw new Error(
          `event emitter for ${this.channel}: the source skipped an unreadable record at offset ${gap.offset} ` +
            `(${gap.bytes} bytes): ${gap.reason}; no gap reporter was given, so refusing to advance over it silently`,
        );
      this.onUnreadable(gap);
    }

    // Every record is mapped before any is packed, so a terminal reported among them can be placed
    // on the turn the source had begun by then (see {@link queueTerminal}) before the record that
    // synthesizes that turn's finish is turned into a unit.
    const mapped = read.records.map((rec) => this.map(rec.value));
    const begun = new Map<number, string | null>();
    mapped.forEach((m, i) => {
      if (m === null) return;
      if ("turn" in m) begun.set(i, null);
      else for (const e of m.events) if (e.type === AGUI_EVENT_TYPE.RUN_STARTED) begun.set(i, e.runId);
    });
    await this.place(read, begun);

    // Units the mapper dropped are not errors and not frames. Their cursor folds FORWARD into the
    // preceding unit, so consuming that frame consumes them too and they are never re-read. A drop
    // stays apart from a mapper error, which reaches the caller with the cursor unmoved.
    const units: EmitUnit[] = [];
    // Turns begun by records since the last unit, carried on the next unit so they are committed
    // when its frame is frozen and never before: a turn a batch that failed had begun is read
    // again by the next pump.
    let turns: (string | null)[] = [];
    for (const [i, rec] of read.records.entries()) {
      const m = mapped[i]!;
      if (m !== null && "turn" in m) {
        turns.push(null);
        const last = units[units.length - 1];
        if (last) last.cursor = rec.cursor;
        continue;
      }
      if (m === null || m.events.length === 0) {
        const last = units[units.length - 1];
        if (last) last.cursor = rec.cursor;
        continue;
      }
      // An owed terminal becomes a unit OF ITS OWN RUN, ahead of this record's. `RUN_ERROR` names no
      // run, so the frame's envelope is its only attribution, and a frame names one run: left
      // inside this record's unit it would be published under the NEXT run (Sol, round 6, through
      // the built MCP entry point). Its cursor is the position BEFORE this record: the owed frame
      // can be acknowledged while this record's frame is not, and a re-read must then map this
      // record again, which the mapper rebuilt from the log does without the finish, the run being
      // closed by then.
      const owedUnit = this.takeOwedTerminal(m.events, units[units.length - 1]?.cursor ?? this.wal.frontier.sourceCursor);
      if (owedUnit) units.push(owedUnit.unit);
      // WRITE-PATH POLICY, before packing and therefore before beginSend. Disk and wire then agree.
      // A record that mapped only to forbidden kinds becomes a drop: its cursor folds forward like
      // any other drop, and packUnits never sees an empty unit.
      const events = applyAguiEgressPolicy(owedUnit ? owedUnit.rest : m.events);
      for (const e of m.events) if (e.type === AGUI_EVENT_TYPE.RUN_STARTED) turns.push(e.runId);
      if (events.length === 0) {
        const last = units[units.length - 1];
        if (last) last.cursor = rec.cursor;
        continue;
      }
      units.push({ runId: m.runId, events, cursor: rec.cursor, ...(turns.length > 0 ? { turns } : {}) });
      turns = [];
    }

    // A bounded range that mapped to nothing advances the cursor atomically and ALONE.
    //
    // THIS IS THE COMMON PATH, NOT AN EDGE CASE, and the number is here so nobody reads it as one.
    // Measured on a real Claude session of 5938 records: only 2694 (45%) carry a `message` at all —
    // the rest are attachments, queue operations, mode changes, prompt markers and system entries
    // the mapping deliberately drops. So the MAJORITY of a real session maps to nothing. An emitter
    // advanced the cursor only through an acked frame would re-read the same 55% forever, and no
    // fixture would ever show it, because a fixture author writes records that mean something.
    //
    // It must also advance on an ADOPT, which reads zero records by design: without that the position
    // is never persisted and the next read adopts a LATER end, silently skipping everything appended
    // in between.
    if (units.length === 0) {
      if (read.cursor !== this.wal.frontier.sourceCursor) await this.wal.advanceCursorOnly(read.cursor);
      this.committed([], turns);
      return { frames: 0, events: 0 };
    }

    // Validate the WHOLE batch before publishing any of it. A vocabulary violation discovered
    // halfway through would leave a valid prefix on the wire and the rest refused, and the refusal
    // is supposed to mean "this stream never carried that", not "it carried some of it".
    // Validated on a CLONE, so the machine that is in step with the disk does not advance for a
    // batch that may never be sent. The clone starts from the folded state, so it sees exactly what
    // the real machine will see, in the same order.
    const probe = this.brackets.clone();
    for (const u of units)
      for (const e of u.events) {
        try {
          probe.accept(e);
        } catch (err) {
          throw this.diagnoseBracket(err as Error);
        }
      }
    // Set only after the WHOLE batch validated. Setting it per event would make a batch that failed
    // on its FIRST event count as "this process has fed something", which is the precise input that
    // turns the restart diagnosis off.
    this.fedAnyEvent = true;

    const frames = packUnits({
      threadId: this.threadId,
      epoch: this.wal.epoch,
      firstSeq: this.wal.frontier.seq + 1,
      units,
      measure: (f) => this.measure(f),
      limit: this.ep.maxPayload,
    });

    let events = 0;
    for (let k = 0; k < frames.length; k++) {
      const { frame, cursor, unitFrom } = frames[k]!;
      const to = k + 1 < frames.length ? frames[k + 1]!.unitFrom : units.length;
      await this.publish(frame, cursor, () => this.committed(units.slice(unitFrom, to), []));
      events += frame.events.length;
    }

    // Records the mapper dropped AFTER the last unit have no frame to ride on, so their cursor is
    // advanced on its own: the same cursor-only rule, applied to the tail of the batch.
    if (read.cursor !== this.wal.frontier.sourceCursor) await this.wal.advanceCursorOnly(read.cursor);
    this.committed([], turns);

    return { frames: frames.length, events };
  }

  /**
   * Place every queued terminal the read has reached on the turn the source had begun when the
   * terminal was reported: the last of the turns begun by the records before its position, or
   * {@link lastTurn} when none of them is. A terminal reported past this read stays queued for the
   * next one. Placed on a run, the terminal becomes that run's debt; on a turn that opened no run,
   * it is consumed; on a run that already has a terminal, or one the wire has closed, it is
   * dropped as the connector repeating itself.
   */
  private async place(read: SourceRead<T>, begun: Map<number, string | null>): Promise<void> {
    for (const entry of [...this.queued]) {
      const before = await this.boundary(entry, read);
      if (before === undefined) continue;
      this.queued = this.queued.filter((q) => q !== entry);
      let turn = this.lastTurn;
      for (const [i, t] of begun) if (i < before) turn = t;
      if (turn === undefined || turn === null || this.owed.has(turn)) continue;
      if (turn !== this.brackets.runId && ![...begun.values()].includes(turn)) continue;
      this.owed.set(turn, entry);
    }
  }

  /**
   * How many of the read's records the source held when the terminal was reported, or `undefined`
   * when the terminal was reported past the read. The position is compared through the source
   * itself, never by reading the cursor: the first record after the position is the one a read
   * from it answers, and the cursor it carries is the same string this read gave that record. A
   * position whose read could not be taken, or that this emitter had already read past (a terminal
   * is reported before anything after its position is read, so that position is never behind a
   * read), drops the terminal and fails this pump, once: the plane reports it and the next pump
   * goes on without it. Waiting for a pump that reads up to such a position would wait forever.
   */
  private async boundary(entry: ReportedTerminal, read: SourceRead<T>): Promise<number | undefined> {
    let at: string;
    try {
      at = await entry.at;
    } catch (e) {
      this.queued = this.queued.filter((q) => q !== entry);
      throw new Error(
        `event emitter for ${this.channel}: dropping the turn terminal reported at ${entry.terminal.timestamp}: ` +
          `the source position it was reported at could not be read (${(e as Error).message})`,
      );
    }
    if (at === read.cursor) return read.records.length;
    let first: string | undefined;
    try {
      first = (await this.source.read(at)).records[0]?.cursor;
    } catch (e) {
      this.queued = this.queued.filter((q) => q !== entry);
      throw new Error(
        `event emitter for ${this.channel}: dropping the turn terminal reported at ${entry.terminal.timestamp}: ` +
          `the source could not be read from the position it was reported at (${(e as Error).message})`,
      );
    }
    if (first === undefined) return undefined;
    const i = read.records.findIndex((r) => r.cursor === first);
    if (i >= 0) return i;
    if ((await this.source.read(read.cursor)).records.some((r) => r.cursor === first)) return undefined;
    this.queued = this.queued.filter((q) => q !== entry);
    throw new Error(
      `event emitter for ${this.channel}: dropping the turn terminal reported at ${entry.terminal.timestamp}: ` +
        `it was reported at a position this emitter had already read past`,
    );
  }

  /**
   * The commit of frozen units and of records advanced past without a frame: the last turn they
   * began is now the turn a terminal reported before any later record ends, and a run they closed
   * owes nothing, its terminal being in the frozen frame.
   */
  private committed(units: EmitUnit[], turns: (string | null)[]): void {
    for (const u of units) {
      for (const t of u.turns ?? []) this.lastTurn = t;
      // The debt settled is the run the terminal CLOSES, not the run the frame is labelled with: the
      // finish the next prompt synthesizes for its predecessor travels in the successor's frame, and
      // a debt the successor already carries must survive that freeze.
      for (const e of u.events) {
        if (e.type === AGUI_EVENT_TYPE.RUN_FINISHED) this.owed.delete(e.runId);
        else if (e.type === AGUI_EVENT_TYPE.RUN_ERROR) this.owed.delete(u.runId);
      }
    }
    for (const t of turns) this.lastTurn = t;
  }

  /**
   * Close the run this stream currently has open, at a boundary the RECORD STREAM CANNOT SEE.
   *
   * **This exists because the two halves of the mapping were specified against different inputs.**
   * The plan sources `RUN_FINISHED` from a harness lifecycle hook, and the durable plane reads a
   * FILE: a hook fires in another process and writes no record, so a hook-sourced terminal has no
   * vehicle into a record-sourced stream. Deriving the terminal from records instead is possible but
   * lies about time in two ways that matter to a live view: the finish lands only when the NEXT turn
   * starts, so a finished agent renders as still running, and the last run of a session never closes
   * at all, because there is no later record to close it on. This is that vehicle.
   *
   * It is a FRAME LIKE ANY OTHER: same epoch, same `seq` line, same write-ahead discipline, same
   * halt rules. The single thing that differs is the cursor, which is republished UNCHANGED, because
   * this frame consumes no source record. A frame that advanced the cursor here would mark records
   * consumed that were never mapped.
   *
   * Idempotent by construction rather than by a flag: the bracket machine is the only state it
   * reads, so once the run is closed there is nothing open to close and it answers `null`. That also
   * makes it safe on a stream whose run was opened by a PREVIOUS process, since the machine is
   * restored from the WAL.
   *
   * **AN `error` CLOSES THE SAME RUN WITH `RUN_ERROR` INSTEAD, and it is one method rather than two
   * ON PURPOSE.** `RUN_ERROR` closes a run on its own, so a run that emitted one must never also
   * emit a `RUN_FINISHED`. With a second method that invariant would be a rule someone has to
   * remember; with one method and one branch it is a property of the shape: exactly one terminal is
   * built, and the bracket machine has closed the run by the time anything could ask for another, so
   * a following close answers `null` like any other close on a settled stream. Which harness signals
   * mean a turn FAILED is a connector's decision and is stated at each connector's own mapping site;
   * this file only carries the answer to the wire.
   *
   * **`error.message` AND `error.code` NEVER REACH THE WIRE.** Both are upstream values, so the close
   * publishes {@link RUN_ERROR_EGRESS_MESSAGE} with no code, the same shape the write path's
   * `egressRunError` in `agui.ts` produces (#1431). `packUnits` bounds the closing frame like any
   * other, so a close whose envelope cannot fit fails loud.
   *
   * @returns the run that was closed, or `null` when the stream was already at a stopping point.
   */
  async closeRun(o: {
    timestamp: number;
    cotal?: CotalMeta;
    /** Close with `RUN_ERROR` carrying these instead of `RUN_FINISHED`. */
    error?: { message: string; code?: string };
  }): Promise<string | null> {
    if (this.halted) throw this.halted;
    if (this.wal.pending)
      throw new Error(
        `event emitter for ${this.channel}: a frame is still pending; recovery must settle it before a run can be closed`,
      );

    const runId = this.brackets.runId;
    if (runId === undefined) return null;
    // Either terminal settles a debt owed to this run: the run is closed, and nothing can be owed
    // to a run that is no longer open.
    this.owed.delete(runId);

    const cursor = this.wal.frontier.sourceCursor;
    if (cursor === undefined)
      throw new Error(
        `event emitter for ${this.channel}: run "${runId}" is open on a frontier that carries no source ` +
          `cursor. A run can only be open because a frame published it, and a frame that published ` +
          `cannot leave the cursor unset, so this WAL disagrees with itself. Refusing to invent a ` +
          `cursor for the closing frame.`,
      );

    // `RUN_ERROR` carries no `runId` and no `threadId` of its own — its schema is `message` plus an
    // optional `code` — so the run it closes is named by the frame's unit below, not by the event.
    const event = o.error
      ? runError({
          message: RUN_ERROR_EGRESS_MESSAGE,
          timestamp: o.timestamp,
          ...(o.cotal ? { cotal: o.cotal } : {}),
        })
      : runFinished({
          threadId: this.threadId,
          runId,
          timestamp: o.timestamp,
          ...(o.cotal ? { cotal: o.cotal } : {}),
        });

    // Validated on a clone first, exactly as a mapped batch is. The refusal that matters here is a
    // message or tool call still open under this run: either terminal while something it opened is
    // unclosed is a protocol violation, and it must surface as one rather than be published.
    const probe = this.brackets.clone();
    try {
      probe.accept(event);
    } catch (err) {
      throw this.diagnoseBracket(err as Error);
    }
    this.fedAnyEvent = true;

    const frames = packUnits({
      threadId: this.threadId,
      epoch: this.wal.epoch,
      firstSeq: this.wal.frontier.seq + 1,
      units: [{ runId, events: [event], cursor }],
      measure: (f) => this.measure(f),
      limit: this.ep.maxPayload,
    });
    for (const { frame, cursor: c } of frames) await this.publish(frame, c, () => {});
    return runId;
  }

  /**
   * Queue a terminal the connector reported at a boundary the record stream cannot see, for the
   * turn the source had begun when it was reported: a terminal that arrived while the plane was
   * down, or while a re-establish was in flight. The connector reports a turn's terminal once the
   * turn's records are in the source and before the next turn's are, so the position the source
   * had reached then names the turn: the last one begun before that position. The next pump reads
   * the records up to that position and places the terminal, see {@link place}. Placed on a run,
   * an error is published in place of the first finish the mapper produces for that run, which is
   * the finish a later prompt synthesizes when it finds the run still open, so a failed turn whose
   * next prompt was already written when the plane came back is still closed as a failure, after
   * its own records and before the next run opens, in a frame of its own run; a finish is that
   * synthesized finish. A terminal the pump places on the run it leaves open is handed back by
   * {@link takeOwed} for the close the holder makes. A turn that opened no run takes its terminal
   * and does nothing with it, as a close with no run open does live; a second terminal for one
   * turn is the connector repeating itself, and replaces nothing.
   */
  queueTerminal(entry: ReportedTerminal): void {
    if (this.halted) throw this.halted;
    // A position that could not be read is reported by the pump that meets it, not as an
    // unhandled rejection before any pump has.
    entry.at.catch(() => undefined);
    this.queued.push(entry);
  }

  /** How many terminals no pump has placed yet. A pump places every one the read reaches. */
  get waitingTerminals(): number {
    return this.queued.length;
  }

  /** Take the terminal owed to `runId` back, for a close the caller makes itself. */
  takeOwed(runId: string): ReportedTerminal | undefined {
    const entry = this.owed.get(runId);
    this.owed.delete(runId);
    return entry;
  }

  /**
   * Every terminal this emitter still holds, for a holder that is dropping it: the terminals owed
   * to runs the wire has not closed, then the ones no pump has placed, each with the position it
   * was reported at, so the next emitter places them again from the log it starts from. The last
   * turn the frozen frames began rides along, so the holder can seed the next emitter with it.
   */
  unsettled(): { terminals: ReportedTerminal[]; lastTurn: string | null | undefined } {
    return { terminals: [...this.owed.values(), ...this.queued], lastTurn: this.lastTurn };
  }

  /** Seed the last turn the wire began, from the emitter this one replaces: a terminal reported
   *  before any record the first pump reads is that turn's. Allowed before anything is pumped. */
  seedLastTurn(turn: string | null | undefined): void {
    if (this.pumped) throw new Error(`event emitter for ${this.channel}: the last turn can only be seeded before the first pump`);
    this.lastTurn = turn;
  }

  /**
   * Take the first finish of an owed run out of a record's events and, for a debt that is an
   * error, answer it with a unit of that run carrying the owed error terminal instead. The error
   * carries the fixed egress message, as a close does. `before` is the cursor the owed unit
   * stores: the position ahead of the record the finish came from. A debt that is a finish is
   * answered by the finish itself and changes nothing. The debt is settled when the frame carrying
   * the terminal is frozen, not here: a frame whose write fails before the freeze is read again,
   * and the terminal must still be owed then (Sol, round 11 of 2026-10-13, through the built MCP
   * entry point: a log write refused once while the owed error was being written closed the failed
   * run as a finish).
   */
  private takeOwedTerminal(events: AguiEvent[], before: string | undefined): { unit: EmitUnit; rest: AguiEvent[] } | undefined {
    if (this.owed.size === 0) return undefined;
    const at = events.findIndex((e) => e.type === AGUI_EVENT_TYPE.RUN_FINISHED && this.owed.has(e.runId));
    if (at < 0) return undefined;
    const finish = events[at]!;
    const runId = finish.runId as string;
    const { terminal } = this.owed.get(runId)!;
    if (!terminal.error) return undefined;
    if (before === undefined)
      throw new Error(
        `event emitter for ${this.channel}: a terminal is owed to run "${runId}" on a frontier that carries no source cursor; a run can only be open because a frame published it`,
      );
    const error = runError({ message: RUN_ERROR_EGRESS_MESSAGE, timestamp: typeof finish.timestamp === "number" ? finish.timestamp : Date.now(), ...(finish.cotal ? { cotal: finish.cotal } : {}) });
    return { unit: { runId, events: [error], cursor: before }, rest: events.filter((_, i) => i !== at) };
  }

  /** Measure a candidate frame EXACTLY as the wire will, at an upper bound over id and expectation. */
  private measure(frame: AguiFrame): number {
    return this.ep.encodedSize({
      channel: this.channel,
      parts: [frame as unknown as Part],
      id: SIZING_ID,
      expectedLastSubjectSeq: SIZING_EXPECTATION,
    });
  }

  /** Transition 1 then the first network attempt. `frozen` runs once the frame is frozen on disk,
   *  before the wire is tried: the commit of what the frame carries, for state the frame settles. */
  private async publish(frame: AguiFrame, cursor: string, frozen: () => void): Promise<void> {
    // Advance a copy of the machine by exactly this frame. It cannot throw: the identical sequence
    // was already accepted by a clone starting from this same state, in this same order. It is not
    // wrapped in a diagnosis for that reason — a throw here would be a bug in this file, not a
    // stream problem, and dressing it as one would hide it. The real machine moves at the FREEZE:
    // a write that fails before it leaves the log without this frame, and the run this frame opens
    // or closes is then neither open nor closed on the wire (Sol, round 11 of 2026-10-13, through
    // the built MCP entry point: a first turn whose frame never froze was reported open, so its
    // terminal was held for a run the log never had, and dropped).
    const next = this.brackets.clone();
    for (const e of frame.events) next.accept(e);
    const brackets = next.snapshot();
    const id = randomUUID();
    // THE SUBJECT'S TIP, NOT THIS THREAD'S LAST ACK. The two were the same number until a second
    // session of the same principal existed, and then they were not: the subject is per principal
    // and the log is per thread, so a new thread's own `lastSubjectSeq` is 0 on a subject its
    // predecessor already filled.
    const E = this.wal.expectedTip;
    const body: Part[] = [frame as unknown as Part];
    // Durable BEFORE the wire. The order is the whole state machine: a crash between this line and
    // the next is recoverable precisely because the id and `E` are already frozen on disk.
    await this.wal.beginSend({ id, E, seq: frame.seq, sourceCursor: cursor, body, brackets });
    this.brackets = next;
    frozen();
    await this.attempt({ id, E, body, retry: false });
  }

  /**
   * One publish attempt — first or retry — with the FROZEN id and the FROZEN `E`. Never the tip.
   *
   * The three outcomes are not symmetric and the asymmetry is the design:
   * - `!duplicate` → transition 2 then 3. Success becomes durable before the frontier moves.
   * - `duplicate` → HALT. On a first attempt it means a body WE DID NOT WRITE holds our id, and
   *   folding its `ackSeq` would advance the frontier and the source cursor past events that were
   *   never published. On a retry it cannot happen on a single-replica stream at all, because such a
   *   stream evaluates the expectation before the dedup cache, so observing it proves the stream is
   *   not single-replica. Both are
   *   fail-loud, and neither is a case where guessing is better than stopping.
   * - CAS loss → HALT. Someone else moved the tip on a subject only this principal may write, or
   *   the subject was purged. Uncertainty plus a moved tip is exactly what must not be guessed at.
   *
   * A NETWORK error is deliberately none of these: it leaves `pending` as `sent_unacked`, which is
   * the state that means "we do not know", and the next boot retries the same frozen frame.
   */
  private async attempt(o: { id: string; E: number; body: Part[]; retry: boolean }): Promise<void> {
    const egress = frozenBodyEgressVerdict(o.body);
    if (egress === "forbidden-kind") {
      throw this.halt(
        "egress-policy",
        `event emitter for ${this.channel}: refusing to ${o.retry ? "republish a frozen" : "publish a"} ` +
          `frame whose body carries TOOL_CALL_ARGS or TOOL_CALL_RESULT onto ${this.channel}. ` +
          `That channel has a different read ACL from the one a mesh read tool ran on, and those ` +
          `kinds republish tool inputs and outputs. The body is not rewritten: the WAL froze it at ` +
          `beginSend, a retry must republish those bytes or not at all, and mutating them between ` +
          `disk and wire would break the recovery machine. An upgrade across a pending pre-fix ` +
          `frame therefore HALTS rather than leaks. Clear the pending frame only as an explicit ` +
          `abandonment of this epoch.`,
      );
    }
    if (egress === "unreadable") {
      throw this.halt(
        "egress-unreadable",
        `event emitter for ${this.channel}: refusing to ${o.retry ? "republish a frozen" : "publish a"} ` +
          `frame whose event list this policy cannot read onto ${this.channel}. A frame-shaped body ` +
          `whose \`events\` is absent, or is not an array, cannot be checked for TOOL_CALL_ARGS or ` +
          `TOOL_CALL_RESULT, and a body whose \`events\` is a bare string carries its bytes exactly ` +
          `where the check would have looked. The boundary is the wire and not what a renderer ` +
          `folds, so an uninspectable body is withheld rather than published opaque onto a channel ` +
          `with a different read ACL. \`aguiFrame\` enforces a non-empty events ARRAY at ` +
          `construction, so no frame this version writes can land here; one that does was frozen by ` +
          `something else. Clear the pending frame only as an explicit abandonment of this epoch.`,
      );
    }
    if (egress === "run-error-content") {
      throw this.halt(
        "egress-run-error",
        `event emitter for ${this.channel}: refusing to ${o.retry ? "republish a frozen" : "publish a"} ` +
          `frame whose RUN_ERROR carries upstream text onto ${this.channel}. Since #1431 a published ` +
          `RUN_ERROR has the fixed message "${RUN_ERROR_EGRESS_MESSAGE}" and no code or rawEvent, because ` +
          `the upstream error text can echo a prompt, a peer message or tool output and that channel ` +
          `has a different read ACL. The body is not rewritten: the WAL froze it at beginSend, so an ` +
          `upgrade across a pending pre-fix frame HALTS rather than leaks. Clear the pending frame ` +
          `only as an explicit abandonment of this epoch.`,
      );
    }
    if (egress === "extra-property") {
      // Re-scan to name the path. This is the error path; the cost is negligible.
      let path = "(unknown)";
      for (const part of o.body) {
        if (!isAguiFramePart(part)) continue;
        const p = extraPropertyPath(part as Record<string, unknown>);
        if (p !== undefined) { path = p; break; }
      }
      throw this.halt(
        "egress-extra-property",
        `event emitter for ${this.channel}: refusing to ${o.retry ? "republish a frozen" : "publish a"} ` +
          `frame whose body carries an unknown property at \`${path}\` onto ${this.channel}. ` +
          `The egress fence validates the whole envelope against a closed schema: known top-level ` +
          `frame keys (kind, protocol, threadId, runId, epoch, seq, events) and known per-event ` +
          `keys per type. A property outside that schema could carry tool output or other content ` +
          `that bypasses the event-kind check. The body is not rewritten: the WAL froze it at ` +
          `beginSend, and mutating it between disk and wire would break the recovery machine. ` +
          `Clear the pending frame only as an explicit abandonment of this epoch.`,
      );
    }
    let ack: { seq: number; duplicate: boolean };
    try {
      ({ ack } = await this.ep.multicastExpecting({
        channel: this.channel,
        parts: o.body,
        id: o.id,
        expectedLastSubjectSeq: o.E,
      }));
    } catch (e) {
      if (isCasLoss(e))
        throw this.halt(
          "cas-loss",
          `event emitter for ${this.channel}: the subject tip is no longer ${o.E} (${(e as Error).message}). ` +
            `The broker ACL confines this subject to one principal, so the tip moved for one of: a ` +
            `CONCURRENT emitter under this same principal. The per-principal lock refuses a second ` +
            `one, but the lock FILE lives under a workspace root, so an emitter started against a ` +
            `DIFFERENT root, or by a path that never takes the lock, meets no lock at all. Another ` +
            `host and a stale pid do not get past it; they refuse the start instead, loudly; a ` +
            `subject frontier record that disagrees with the stream, ` +
            `which is what an interrupted upgrade or a restored backup leaves behind; a RESTORED ` +
            `stream; or a FILTERED PURGE, which returns the tip to 0 for every thread on the channel. ` +
            `One more cause is not a second writer at all: this log's OWN last ack. The shared record ` +
            `advances before the log records the ack, so a crash between those two writes leaves the ` +
            `record ahead of the frozen expectation this frame carries, and the retry publishes a ` +
            `sequence the subject has already passed. On disk it reads as a pending frame in state ` +
            `sent_unacked whose E is BEHIND the record's tip, which a restored record can also look ` +
            `like, so it narrows the search rather than ending it. ` +
            `None of these is resolvable by re-reading the tip, which agent credentials cannot read in ` +
            `any case. Clearing it is an explicit abandonment of epoch, seq, E, cursor and the shared ` +
            `subject record together, and it is VALID ONLY ONCE THE SUBJECT IS ACTUALLY EMPTY, which ` +
            `of the causes above is true of the FILTERED PURGE alone. On any other cause the tip is ` +
            `still where it is, so removing this state does not clear the halt: the next session ` +
            `opens virgin, expects 0, halts on the same tip, and the sibling logs a tip could have ` +
            `been rebuilt from are gone. Purge the channel first, or find the second writer, or match the ` +
            `signature above and stop looking for one. Once ` +
            `the subject really is back to 0, no command performs the abandonment, so by hand it ` +
            `means removing ${dirname(dirname(this.wal.path))} whole, and removing less than that ` +
            `leaves a mixed state the next start refuses.`,
        );
      throw e;
    }

    if (ack.duplicate)
      throw this.halt(
        "duplicate-ack",
        `event emitter for ${this.channel}: the broker answered ${o.retry ? "a RETRY" : "a FIRST attempt"} ` +
          `for id ${o.id} with duplicate:true. ` +
          (o.retry
            ? `Under the SINGLE-REPLICA RETRY RULE this cannot happen on an R1 stream, which ` +
              `evaluates the subject expectation ` +
              `before the dedup cache — so either the stream is not R1 or a foreign body holds our ` +
              `stream-wide id. `
            : `We have never published this id, so a body we did not write holds it. `) +
          `Folding this ack would advance the frontier and the source cursor past events that were ` +
          `never published: silent loss of real events. The frontier and cursor are unchanged.`,
      );

    await this.wal.recordAck(ack.seq);
    await this.wal.fold();
  }

  /**
   * Decide whether a bracket refusal is the WRITER's fault or OURS, and say which.
   *
   * Ours iff ALL THREE hold, and each is load-bearing:
   * - this process has fed NO event through the machine yet, so the machine cannot have been put
   *   into a bad state by anything we did in this run; and
   * - the frontier is non-virgin, so frames — and therefore possibly an open `RUN_STARTED` — were
   *   published by a PREVIOUS process; and
   * - the WAL cannot say what was open. Since v2 the machine is PERSISTED, so an ordinary restart
   *   restores it and never reaches here at all; `null` means the document was migrated from v1 and
   *   genuinely never recorded the state. Without this condition the diagnosis would survive as a
   *   permanent excuse for a case the migration fixed.
   *
   * Drop the first condition and a genuine mid-stream violation by the writer gets blamed on a
   * restart that happened an hour ago. Drop the second and a violation on a virgin thread, where
   * nothing was ever published and nothing could have been lost, gets blamed on a restart that never
   * happened. Each condition alone produces a confident, wrong diagnosis — which is worse than the
   * undiagnosed error it replaced, because a named cause stops the search.
   */
  private diagnoseBracket(err: Error): Error {
    if (this.fedAnyEvent || this.wal.frontier.seq === 0 || this.wal.brackets !== null) return err;
    return new AguiBracketStateLost(
      `event emitter for ${this.channel}: bracket state was LOST ACROSS A RESTART — this is not a ` +
        `protocol violation by the writer. This process has emitted nothing yet, but the WAL says ` +
        `frame ${this.wal.frontier.seq} already went out, and the document records NO bracket state ` +
        `(it was migrated from v1, which never stored one), so any run or message the previous ` +
        `process left open is invisible to this one. Resuming from the source cursor therefore lands ` +
        `mid-run and the first event is refused. A WAL written by this build persists the machine and ` +
        `does not reach this path. The underlying refusal was: ${err.message}`,
      err,
    );
  }

  private halt(reason: "duplicate-ack" | "cas-loss" | "egress-policy" | "egress-unreadable" | "egress-extra-property" | "egress-run-error", message: string): AguiEmitterHalted {
    this.halted = new AguiEmitterHalted(reason, message);
    return this.halted;
  }
}
