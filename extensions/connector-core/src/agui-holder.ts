/**
 * The lifecycle seam between a connector's hooks and the AG-UI emitter.
 *
 * **This file exists so the cutover is a SWAP, not a swap plus a new lifecycle.** `TranscriptMirror`
 * presents a synchronous `adopt(path)` / `flush(path)` pair to the hook relay, because that is what
 * a hook can call: the relay must reply immediately and cannot await a publish. {@link AguiEmitter}
 * is the opposite shape: `start()` is async (it resolves the channel, runs the replica preflight,
 * and settles any frame the WAL left pending) and `pump()` is async. Something has to hold the
 * async thing behind the sync surface, and if that something is written in the same commit that
 * deletes the mirror, then the irreversible step also carries an untested lifecycle.
 *
 * So it lands first, against the shape the mirror already proved, and the cutover becomes a
 * substitution of one object for another behind an unchanged call pattern.
 *
 * **WHY LAZY.** The emitter cannot be built at construction time. Its {@link DurableSource} is the
 * session's transcript, whose path the connector does not know until a hook hands it over, and
 * `start()` reaches the broker — work that must not run for a session that never emits. First
 * `adopt` is the earliest moment the emitter is both constructible and needed.
 */
import type { AguiEmitter } from "./agui.js";

/**
 * Holds at most one {@link AguiEmitter}, started on first adopt.
 *
 * `T` is the connector's source record type; the holder never inspects one. It owns exactly three
 * things — WHEN the emitter starts, that it starts AT MOST ONCE, and that everything touching it is
 * serialized — and deliberately owns no policy about what an event means or how a frame is built.
 */
export class AguiEmitterHolder<T> {
  private emitter?: AguiEmitter<T>;
  /** The path this holder is BOUND to. Set before `starting`, so a second path is refused even
   *  while the first start is still in flight. */
  private boundPath?: string;
  /**
   * Terminal. Once set, this holder never starts, pumps, or reports success again.
   *
   * It does not retry, and that is a decision rather than an omission. A retry on the next hook
   * would re-run that preflight and a WAL recovery against a stream this holder has already
   * failed to establish itself on, on a timer set by how often the user happens to type. The
   * emitter's own answer to an uncertain publish is to halt rather than to limp, and a holder that
   * quietly reconnected underneath it would reintroduce, one layer up, exactly the silence the
   * emitter refuses.
   */
  private dead?: Error;
  /**
   * Terminal, and NOT a failure. Set by {@link close} when the owner releases this holder: it never
   * starts, pumps or closes a run again, `failure` stays empty, and `onError` is not called. Kept
   * apart from `dead` for exactly that reason: a release read as an error puts a line in the log
   * that tells an operator the event plane broke when it was retired on purpose.
   */
  private shut = false;
  /** ALL mutation runs on this chain. Hook events arrive concurrently on the control socket, so
   *  without it two flushes could read the source at the same cursor. */
  private chain: Promise<void> = Promise.resolve();

  /**
   * @param startEmitter Builds and starts the emitter for an adopted path. Injected rather than
   *   assembled here: the WAL location, the source, and the record mapper are all connector
   *   decisions, and a holder that made them would be a second place they are decided.
   * @param onError Where a failure goes. Required, and not defaulted to a swallow: this class runs
   *   behind a hook that must not throw, so the only way a failure reaches a human is if the caller
   *   is made to say where it goes.
   * @param onRunClosed Told which run {@link closeRun} closed, so the connector's own mapper can
   *   forget the run it will no longer attribute records to. Optional, and it is NOT the holder
   *   doing the forgetting: which state a record mapper keeps is the connector's business, and a
   *   holder that reached into it would be a second place that decides what a run is. Without it a
   *   mapper that still believes the run is open would emit under a `runId` the published stream has
   *   already closed, and the emitter would refuse the batch.
   */
  constructor(
    private readonly startEmitter: (path: string) => Promise<AguiEmitter<T>>,
    private readonly onError: (e: Error) => void,
    private readonly onRunClosed?: (runId: string) => void,
  ) {}

  /** True once an emitter is running here. False while a start is still in flight — it reports what
   *  IS, never what is about to be. */
  get running(): boolean {
    return this.emitter !== undefined && !this.emitter.stopped;
  }

  /** The failure that killed this holder, if one did. */
  get failure(): Error | undefined {
    return this.dead;
  }

  /** True once {@link close} has run. Distinct from {@link failure}: released, not broken. */
  get closed(): boolean {
    return this.shut;
  }

  /**
   * Release this holder: refuse every later adopt, flush and run-close, then await what is already
   * queued.
   *
   * THE REFUSAL IS TAKEN SYNCHRONOUSLY, before anything is awaited, so a hook arriving while the
   * settle is still outstanding is refused rather than racing it. Nothing is cancelled: work already
   * on the chain runs to completion, so a caller that cannot wait unboundedly has to bound this
   * itself, exactly as it bounds {@link settled}.
   *
   * WHAT IT DOES NOT RELEASE, because those lifetimes are not this object's to decide. The
   * write-ahead log and the principal lock are created by the `startEmitter` its owner injected: the
   * log outlives this holder whenever a later start could still recover from it, and the lock
   * outlives it because a lock is per principal while a holder is per thread. A holder that removed
   * either would be deciding a policy it cannot see. It closes the seam; the owner closes what the
   * seam was holding open.
   *
   * AND IT REFUSES AT THE DOOR RATHER THAN AT THE WORK, which is the distinction that keeps it from
   * quietly cancelling. The refusal is in {@link enqueue}, so a call arriving after close never gets
   * onto the chain, while a flush already on it still reads its source and publishes. A refusal
   * placed on the far side would have turned every abandoned drain into a silently dropped one, and
   * an abandoned drain is uncancelled by design: its owner stopped waiting, it did not stop.
   */
  async close(): Promise<void> {
    this.shut = true;
    await this.chain;
  }


  /** The path this holder bound to on first adopt, if it has adopted. */
  get path(): string | undefined {
    return this.boundPath;
  }

  /**
   * Adopt a transcript path, starting the emitter if this is the first one.
   *
   * Synchronous and non-throwing by contract, because a hook calls it. The work lands on the chain.
   */
  adopt(path: unknown): void {
    this.enqueue(() => this.ensureStarted(path).then(() => undefined));
  }

  /**
   * Adopt if necessary, then drain the source into frames.
   *
   * Same contract as {@link adopt}: synchronous, non-throwing, work on the chain.
   */
  flush(path: unknown): void {
    this.enqueue(async () => {
      const emitter = await this.ensureStarted(path);
      if (!emitter || emitter.stopped) return;
      await emitter.pump();
    });
  }

  /**
   * Start at most once, bind the path once.
   *
   * Returns `undefined` when there is nothing to run against — a dead holder or a path this holder
   * cannot take — rather than throwing, so a caller cannot mistake "no emitter" for "pumped".
   */
  /**
   * Close the open run at a turn boundary the record stream cannot see.
   *
   * Same contract as {@link adopt} and {@link flush}: synchronous, non-throwing, work on the chain,
   * because a lifecycle hook calls it and a hook must not be made to wait or to fail.
   *
   * It deliberately does NOT start an emitter. A session that never adopted a transcript has nothing
   * open and nothing to close, and starting one here would reach the broker on the way OUT of a
   * turn that published nothing.
   *
   * **`error` CLOSES THE RUN WITH `RUN_ERROR` INSTEAD**, for a turn the connector knows FAILED. It
   * is one parameter on the one close rather than a second method, because `RUN_ERROR` closes a run
   * by itself and a run must never carry both terminals: one call builds one terminal, and the
   * caller cannot ask for the other afterwards because the run is no longer open. This holder does
   * not decide what counts as a failure — that is a claim about a harness, and it belongs at the
   * connector's own mapping site where the harness's record is in hand.
   */
  closeRun(timestamp: number, error?: { message: string; code?: string }): void {
    this.enqueue(async () => {
      const emitter = this.emitter;
      if (this.dead || !emitter || emitter.stopped) return;
      const runId = await emitter.closeRun({ timestamp, ...(error ? { error } : {}) });
      // Reported for EITHER terminal. The mapper's job here is to stop attributing records to a run
      // the published stream has closed, and an error close closes it exactly as a finish does.
      if (runId !== null) this.onRunClosed?.(runId);
    });
  }

  private async ensureStarted(path: unknown): Promise<AguiEmitter<T> | undefined> {
    if (this.dead) return undefined;
    if (typeof path !== "string" || path.length === 0) return undefined;

    // The binding is checked BEFORE the started-emitter shortcut, and the order is load-bearing:
    // with the shortcut first, a started holder returns its emitter for ANY path and the refusal
    // below becomes unreachable code that still reads like a guard.
    if (this.boundPath !== undefined && this.boundPath !== path) {
      // REFUSED, not re-adopted. `threadId` is the native session and the WAL is keyed to it, so
      // rebinding to a second transcript would continue one session's `epoch`, `seq` and
      // `sourceCursor` against another session's bytes — a fabricated frontier, and the same class
      // of harm `EventWal` refuses when a stored principal disagrees with the live one.
      this.die(
        new Error(
          `AG-UI emitter is bound to transcript ${this.boundPath}; refusing to re-adopt ${path} — a ` +
            `second session needs its own emitter and its own write-ahead log`,
        ),
      );
      return undefined;
    }

    if (this.emitter) return this.emitter;

    if (this.boundPath === undefined) {
      // A CLOSED HOLDER NEVER STARTS, even for work that was already queued when it closed. Starting
      // reaches the broker and opens a write-ahead log for a holder its owner has already released,
      // which is the opposite of releasing it. Pumping an emitter that is ALREADY running is a
      // different act and is deliberately still allowed: see the note on `close`.
      if (this.shut) return undefined;
      this.boundPath = path;
      try {
        // WHAT KEEPS THIS TO ONE EMITTER IS THE `boundPath` GATE ABOVE, AND ONLY IT. It is set on
        // the line before this one, BEFORE the await, so every later call for this same path finds
        // it set and never reaches `startEmitter` again, whether that call arrives after the start
        // resolved or while it is still in flight. A call for a DIFFERENT path is refused earlier.
        //
        // EVERYTHING ELSE ON THIS PATH RETURNS WHATEVER `this.emitter` HOLDS, IT DOES NOT GUARD
        // ONE. The shortcut above and the `return this.emitter` at the end of this method are
        // interchangeable once a start has resolved, and neither is what stops a second start: with
        // the shortcut gone, the trailing return answers the same call with the same object. While
        // a start is still IN FLIGHT that field is unset, so a same-path caller reaching the
        // trailing return gets `undefined`, which is the honest answer and is still not a second
        // start. Anyone editing here should know that before reading a green run as a verdict on
        // the piece they touched.
        //
        // THE CHAIN IS NOT ONE OF THESE MECHANISMS. It serializes hook events so two flushes cannot
        // read the source at one cursor, which is its own job and a real one. An earlier version of
        // this comment credited it with start-once as well; that was measured and it is not true.
        //
        // WHAT A SECOND EMITTER WOULD BREAK IS NOT DESCRIBED HERE, AND THE REASON IS THE POINT.
        // Earlier versions of this comment restated protections that live in other files and were
        // wrong within the hour: one credited a mechanism with another's work, one named the wrong
        // mechanism for the path it was discussing. A comment that restates a guarantee it does not
        // own drifts away from it, and nothing in the edit that moves the guarantee tells the author
        // this sentence exists. The refusals belong next to the code that performs them: the
        // record's are in `subject-frontier.ts`, the log's stale-handle check is in `event-wal.ts`,
        // and the expectation carried on a publish is the broker's to enforce.
        //
        // What this file does own is the bracket interleave, and it is OPEN: two emitters would
        // each keep their own bracket machine and nothing detects the interleave. That is the
        // stated writer-cardinality limit.
        this.emitter = await this.startEmitter(path);
        return this.emitter;
      } catch (e) {
        this.die(e as Error);
        return undefined;
      }
    }

    return this.emitter;
  }

  private die(e: Error): void {
    // FIRST failure wins. A later one is a consequence of this one, and overwriting would replace
    // the cause with a symptom.
    if (this.dead) return;
    this.dead = e;
    this.onError(e);
  }

  private enqueue(step: () => Promise<void>): void {
    // THE ONE PLACE A CLOSED HOLDER REFUSES, so `adopt`, `flush` and `closeRun` cannot drift apart
    // and a door added later is refused by being a door. It refuses ADMISSION only; see `close`.
    if (this.shut) return;
    this.chain = this.chain.then(step).catch((e) => this.die(e as Error));
  }

  /** Await the queued work. For callers that need a settled point — a shutdown, or a cell. */
  async settled(): Promise<void> {
    await this.chain;
  }
}
