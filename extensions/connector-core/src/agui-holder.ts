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
import type { CotalMeta } from "./agui.js";
import type { AguiEmitter } from "./agui-emitter.js";

/**
 * The connector's hooks into an {@link AguiEmitterHolder}.
 *
 * Named rather than positional because the types cannot tell them apart: a `runMeta` provider is
 * assignable to `onRunClosed`, so a position would let it land there, typecheck, and lose its
 * metadata with nothing reporting why.
 */
export interface AguiEmitterHolderHooks {
  /** Where a failure goes, with the delay before the holder re-establishes the plane, or `null`
   *  when it will not because the holder is closed. Required, and not defaulted to a swallow: the
   *  holder runs behind a hook that must not throw, so the only way a failure reaches a human is if
   *  the caller is made to say where it goes. */
  onError: (e: Error, retryInMs: number | null) => void;
  /** The wait before the first re-establish attempt after a failure. Each consecutive failure
   *  doubles it, up to {@link AguiEmitterHolder.RETRY_BACKOFF_CAP_MS}. Default one second. */
  retryMs?: number;
  /**
   * Told which run {@link AguiEmitterHolder.closeRun} closed, so the connector's own mapper can
   * forget the run it will no longer attribute records to. Optional, and it is NOT the holder
   * doing the forgetting: which state a record mapper keeps is the connector's business, and a
   * holder that reached into it would be a second place that decides what a run is. Without it a
   * mapper that still believes the run is open would emit under a `runId` the published stream has
   * already closed, and the emitter would refuse the batch.
   */
  onRunClosed?: (runId: string) => void;
  /**
   * Rides out a transient endpoint rebuild window before a step pumps or closes a run. Called once
   * per queued step that needs the broker (a flush, or a close with something open); it resolves
   * when the endpoint's event plane is live, or rejects to make the whole step fail terminally
   * exactly as any other emitter failure does. This is the seam the connectors'
   * `MeshAgent`-adjacent wiring owns: the holder knows WHEN to publish, the caller knows HOW to
   * observe liveness. Without it, a rebuild window between two pumps reads `max_payload` off a
   * connection that is not there and kills the seat (#1868).
   */
  waitLive?: () => Promise<void>;
  /**
   * The Cotal metadata for the run {@link AguiEmitterHolder.closeRun} is about to close, such as
   * its stop reason or usage, put on whichever terminal closes it. Asked inside the queued close
   * rather than taken at call time, because the hook calls `closeRun` before the flush queued
   * ahead of it has mapped the turn's last records, and those are what the metadata comes from.
   * Keyed on the run id, so a provider that only knows a different run answers `undefined`
   * instead of attributing its numbers to this one.
   */
  runMeta?: (runId: string) => CotalMeta | undefined;
}

/**
 * The one line every connector logs when its event plane stops, used as a holder's `onError`.
 *
 * The seat never stops for it, on any space. It used to, on a space that requires events, and the
 * harness then restarted the connector on the next tool call: the plane was re-established anyway,
 * once per keystroke, with a dropped mesh connection each time. The holder re-establishes it in
 * process instead, on a backoff, and the seat keeps its connection; the line says when.
 */
export function eventPlaneStopped(opts: { log: (line: string) => void }): (e: Error, retryInMs: number | null) => void {
  return (e, retryInMs) =>
    opts.log(
      `AG-UI emitter stopped: ${e.message}` +
        (retryInMs === null ? "" : `; re-establishing the event plane in ${retryInMs}ms`),
    );
}

/**
 * Holds at most one {@link AguiEmitter} at a time, started on first adopt and re-established on a
 * backoff after a failure.
 *
 * `T` is the connector's source record type; the holder never inspects one. It owns four things —
 * WHEN the emitter starts, that ONE runs at a time, that everything touching it is serialized,
 * and carrying the first adopt's opaque context to the connector-owned factory — and deliberately
 * owns no policy about what that context, an event, or a frame means.
 */
export class AguiEmitterHolder<T, StartContext = undefined> {
  private emitter?: AguiEmitter<T>;
  /** The path this holder is BOUND to. Set before `starting`, so a second path is refused even
   *  while the first start is still in flight. */
  private boundPath?: string;
  /**
   * The failure the plane is down for. While set, this holder starts and pumps nothing; it clears
   * when {@link revive} re-establishes the plane.
   *
   * The re-establish runs on the holder's own backoff, never on the next hook: a retry paced by
   * how often the user happens to type would re-run the preflight and the WAL recovery at a rate
   * nothing chose. It is the same recovery a connector restart runs, so it adds no path the
   * emitter did not already take, and a pending frame is settled by `start()` before anything new
   * is read. The failure is still reported, every time, with the delay; a plane that came back on
   * its own is not a plane that failed silently.
   */
  private dead?: Error;
  /** The first adopt's context, kept so a re-establish starts the emitter as the first start did. */
  private startContext?: StartContext;
  /** Consecutive failures since the plane was last established. Paces {@link nextRetryDelayMs}. */
  private retryAttempt = 0;
  private reviveTimer?: ReturnType<typeof setTimeout>;
  /** A turn terminal owed to a run: one that arrived while the plane was down, or one whose own
   *  close failed. {@link revive} applies it once it has read on, if that run is still the open
   *  one, and drops it otherwise. The first terminal held for a run is kept over later ones. */
  private heldClose?: { runId: string; timestamp: number; error?: { message: string; code?: string } };
  /**
   * The run the wire had open when the plane went down, carried through every re-establish attempt
   * until one has gone through. It is what a terminal arriving while the plane is down, or while
   * the fresh start is still in flight, is held for: at those moments there is no emitter to ask,
   * the old one dropped and the new one not yet started, and the run open after the recovery pump
   * may already be the NEXT prompt's.
   */
  private downRun?: string;
  /** True from the moment {@link revive} drops the failed emitter until its fresh start, pump and
   *  held close have all gone through. A terminal that arrives in that window is held, never
   *  queued: a queued close would run after the recovery pump and close whatever run is open then. */
  private reviving = false;
  /** The ceiling the re-establish backoff grows to. A failure that outlives a few retries is a
   *  standing one, and retrying it every second forever is a flat load on the broker's preflight. */
  static readonly RETRY_BACKOFF_CAP_MS = 60_000;
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
  /** One shared wait for the endpoint's next live signal, while a queued step is holding for it.
   *  A single listener serves every waiter, and the field clears when it fires. */
  private liveWait?: Promise<void>;

  /**
   * @param startEmitter Builds and starts the emitter for an adopted path. `context` is the opaque
   *   value supplied with the FIRST adopt (if any); the holder only carries it, while the connector
   *   decides what it means. Injected rather than assembled here: the WAL location, the source, and
   *   the record mapper are all connector decisions, and a holder that made them would be a second
   *   place they are decided.
   */
  constructor(
    private readonly startEmitter: (path: string, context: StartContext | undefined) => Promise<AguiEmitter<T>>,
    private readonly hooks: AguiEmitterHolderHooks,
  ) {}

  /** True once an emitter is running here. False while a start is still in flight — it reports what
   *  IS, never what is about to be. A dead holder is not running: after {@link die} what IS, is
   *  that this holder is finished, whatever its unstopped emitter still says. */
  get running(): boolean {
    return this.dead === undefined && this.emitter !== undefined && !this.emitter.stopped;
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
    if (this.reviveTimer) clearTimeout(this.reviveTimer);
    this.reviveTimer = undefined;
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
  adopt(path: unknown, context?: StartContext): void {
    // Capture the context in THIS queued operation. A shared mutable slot would let a later hook
    // overwrite the first session's startup fact while the connector-owned factory is still waiting
    // on its own async preconditions.
    this.enqueue(() => this.ensureStarted(path, context).then(() => undefined));
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
      await this.holdForLive();
      await emitter.pump();
      // A pump that returned is the plane working: it read the source and published what it read.
      // The backoff resets HERE and not when a start returns, because a start reaches the broker
      // only for its preflight, so a broker that refuses every publish would pass every start and
      // the retry would never pace.
      this.retryAttempt = 0;
    });
  }

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
    if (this.shut) return;
    // DECIDED AT THE HOOK, NOT WHEN A STEP RUNS. While the plane is down, or while a re-establish is
    // in flight, THE TERMINAL IS HELD, NOT DROPPED AND NOT QUEUED. It is not a record in the source,
    // so the re-establish cannot read it back, and a run the log has open with no terminal stays
    // open on the wire until a later prompt closes it as a FINISH, which for a failed turn is the
    // wrong terminal (Sol, review of 2026-10-12). Queued, the close would run after the whole
    // recovery, and the run open by then may be the NEXT prompt's, read by the recovery pump: the
    // failed run would get the synthesized finish and its successor the error (Sol, round 7 of
    // 2026-10-13, through a real broker with the start held at its startup boundary). It is held
    // for the run the wire had open when the plane went down: a run the frozen frame opened has an
    // id the fresh start comes back with, while a run only the mapper held was never opened
    // anywhere a terminal could name it, and the re-read opens it again under a new id.
    if (this.dead !== undefined || this.reviving) {
      if (this.downRun !== undefined) {
        this.hold(this.downRun, timestamp, error);
        // The fresh emitter may be mid-recovery already, reading or publishing: an error is owed to
        // it NOW, while the run is still the open one, so the pump applies it to the finish the next
        // prompt synthesizes whether that finish is still to be mapped or already packed and not
        // yet frozen (Sol, round 8 of 2026-10-13). A debt held only for after the pump arrived too
        // late: the pump had published the finish and opened the successor, and the hold was
        // dropped for naming a closed run.
        const emitter = this.emitter;
        if (error && this.dead === undefined && emitter && !emitter.stopped && emitter.openRunId === this.downRun && emitter.owedRunId === undefined)
          emitter.oweTerminal(this.downRun, error);
      }
      return;
    }
    this.enqueue(async () => {
      const emitter = this.emitter;
      if (this.dead) {
        // A step queued behind the one that took the plane down: held for the same run.
        if (this.downRun !== undefined) this.hold(this.downRun, timestamp, error);
        return;
      }
      if (!emitter || emitter.stopped) return;
      await this.holdForLive();
      await this.closeOpenRun(emitter, timestamp, error);
    });
  }

  /**
   * Close the run `emitter` has open with this terminal, reporting the close. A close that FAILS
   * holds the terminal for that run before the failure goes on to kill the plane: the terminal is
   * owed to the run whether the log took it or not, and a close that failed before its frame froze
   * leaves the run open for the re-establish to find (Sol, review of 2026-10-13: a terminal whose
   * own log write failed was lost, and the next prompt closed the failed run as a finish). A close
   * that failed after the freeze is the frozen frame itself; the start that settles it closes the
   * run, and the held terminal is then dropped for naming a run no longer open.
   */
  private async closeOpenRun(emitter: AguiEmitter<T>, timestamp: number, error?: { message: string; code?: string }): Promise<void> {
    const open = emitter.openRunId;
    const cotal = open === undefined ? undefined : this.hooks.runMeta?.(open);
    let runId: string | null;
    try {
      runId = await emitter.closeRun({ timestamp, ...(cotal ? { cotal } : {}), ...(error ? { error } : {}) });
    } catch (e) {
      if (open !== undefined) this.hold(open, timestamp, error);
      throw e;
    }
    // Reported for EITHER terminal. The mapper's job here is to stop attributing records to a run
    // the published stream has closed, and an error close closes it exactly as a finish does.
    if (runId !== null) this.hooks.onRunClosed?.(runId);
  }

  /** Hold a terminal for `runId`. THE FIRST TERMINAL FOR A RUN WINS: a run carries one terminal,
   *  and a later one for the same run is the connector repeating itself (a stop after a stop
   *  failure, which the live seat does), not a correction. A terminal for another run replaces
   *  the held one, since that run is no longer the one open. */
  private hold(runId: string, timestamp: number, error?: { message: string; code?: string }): void {
    if (this.heldClose?.runId === runId) return;
    this.heldClose = { runId, timestamp, ...(error ? { error } : {}) };
  }

  /**
   * Start at most once, bind the path once.
   *
   * Returns `undefined` when there is nothing to run against — a dead holder or a path this holder
   * cannot take — rather than throwing, so a caller cannot mistake "no emitter" for "pumped".
   */
  private async ensureStarted(path: unknown, context?: StartContext): Promise<AguiEmitter<T> | undefined> {
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

    // A CLOSED HOLDER NEVER STARTS, even for work that was already queued when it closed. Starting
    // reaches the broker and opens a write-ahead log for a holder its owner has already released,
    // which is the opposite of releasing it. Pumping an emitter that is ALREADY running is a
    // different act and is deliberately still allowed: see the note on `close`.
    if (this.shut) return undefined;
    if (this.boundPath === undefined) {
      this.boundPath = path;
      this.startContext = context;
    }
    try {
      // WHAT KEEPS THIS TO ONE EMITTER AT A TIME IS THE CHAIN. Every caller of this method runs
      // inside one serialized step, so a start is never in flight while another step reads
      // `this.emitter`; a same-path call that arrives during a start is queued behind it and finds
      // the emitter set. The `boundPath` gate above refuses a DIFFERENT path, and the chain is
      // also what keeps two flushes from reading the source at one cursor.
      //
      // A start after {@link revive} is the same call with the FIRST adopt's path and context, so
      // the emitter comes back as it first came up: a bound source's boundary is the connector's to
      // keep across the two, and the write-ahead log on disk carries the cursor and any pending
      // frame from the emitter that stopped.
      //
      // WHAT A SECOND EMITTER WOULD BREAK IS NOT DESCRIBED HERE, AND THE REASON IS THE POINT.
      // A comment that restates a guarantee it does not own drifts away from it, and nothing in
      // the edit that moves the guarantee tells the author this sentence exists. The refusals
      // belong next to the code that performs them: the record's are in `subject-frontier.ts`,
      // the log's stale-handle check is in `event-wal.ts`, and the expectation carried on a
      // publish is the broker's to enforce.
      //
      // What this file does own is the bracket interleave, and it is OPEN: two emitters would
      // each keep their own bracket machine and nothing detects the interleave. That is the
      // stated writer-cardinality limit.
      this.emitter = await this.startEmitter(this.boundPath, this.startContext);
      return this.emitter;
    } catch (e) {
      this.die(e as Error);
      return undefined;
    }
  }

  private die(e: Error): void {
    // FIRST failure wins. A later one is a consequence of this one, and overwriting would replace
    // the cause with a symptom.
    if (this.dead) return;
    this.dead = e;
    // The run the wire has open, from the emitter that is dying. With none (a fresh start that
    // failed before it returned) the run carried from the first failure of this outage still holds:
    // nothing was published since the plane went down.
    if (this.emitter !== undefined) this.downRun = this.emitter.openRunId;
    if (this.shut) {
      this.hooks.onError(e, null);
      return;
    }
    const delay = this.nextRetryDelayMs();
    this.reviveTimer = setTimeout(() => this.revive(), delay);
    this.hooks.onError(e, delay);
  }

  /** The wait before the next re-establish: `retryMs`, doubling per failure since the last pump
   *  that returned, up to {@link RETRY_BACKOFF_CAP_MS}. The first wait is `retryMs` itself, so a
   *  transient failure recovers quickly; only a failure that repeats gets paced. */
  private nextRetryDelayMs(): number {
    const base = this.hooks.retryMs ?? 1_000;
    const delay = Math.min(base * 2 ** this.retryAttempt, AguiEmitterHolder.RETRY_BACKOFF_CAP_MS);
    this.retryAttempt++;
    return delay;
  }

  /**
   * Re-establish the plane after {@link die}'s backoff: clear the failure, drop the emitter, and
   * queue a start and a pump on the chain. The start is a fresh `startEmitter`, which reopens the
   * write-ahead log, settles any frame it left pending, and builds the connector's mapper from the
   * bracket state the log holds, before reading on from the stored cursor. A failure here is
   * reported and paced like the first.
   *
   * THE EMITTER IS DROPPED WHETHER OR NOT IT HALTED. A failure that leaves it running leaves it
   * running with state the log never accepted: a publish that failed on the wire leaves the frame
   * frozen as pending, which every later pump refuses to read past; a write that failed before the
   * freeze leaves the mapper holding a run the log never opened, so the re-read of the same record
   * closes a run the brackets never saw and the pump refuses that too. Measured on 2026-10-12 with
   * the real reader, mapper, log and frontier: with the running emitter kept, both outages wedged
   * the plane for good behind a retry every minute. Only a start settles the pending frame, and
   * only a start rebuilds the mapper from the log, so the re-establish is a start.
   */
  private revive(): void {
    this.reviveTimer = undefined;
    if (this.boundPath === undefined) return;
    const path = this.boundPath;
    // Not guarded on `shut` here: close cancels the timer, and `enqueue` refuses a shut holder,
    // so a revive that ran after close would clear the failure and then start nothing. The
    // failure staying readable after close is what shows the timer was cancelled.
    this.dead = undefined;
    this.emitter = undefined;
    this.reviving = true;
    this.enqueue(async () => {
      const emitter = await this.ensureStarted(path);
      if (!emitter || emitter.stopped) {
        // A start that failed has died again, and a terminal is held for the carried run; a start
        // that came back stopped has nothing to hold for.
        this.reviving = false;
        return;
      }
      await this.holdForLive();
      // A held ERROR terminal is owed to the emitter BEFORE the pump reads on; read here, AFTER the
      // start, so a terminal that arrived while the start was in flight is the one owed. The
      // records of that turn were written before the terminal arrived and the pump has not read
      // them yet, so a close before the pump would drop them; but the unread records may also hold
      // the NEXT prompt, whose mapping closes the held run as a finish, and the emitter publishes
      // the owed error in that finish's place, after the run's own records and before the next run
      // opens (Sol, review of 2026-10-13, through the built MCP entry point: the held error was
      // dropped behind that synthesized finish). A held finish owes nothing: the synthesized finish
      // is the same terminal. A run only the mapper held comes back under a new id the terminal
      // cannot name, and owes nothing either.
      const held = this.heldClose;
      if (held?.error && emitter.openRunId === held.runId && emitter.owedRunId === undefined) emitter.oweTerminal(held.runId, held.error);
      await emitter.pump();
      // The hold is released once the close has gone through, or once the run it names is no
      // longer the open one (the pump closed it, with the owed terminal if one was owed). Read
      // again: a terminal that arrived during the pump is held too, and closes the run here if the
      // pump left it open. A close that fails here holds the terminal again on its way out, so the
      // next re-establish still owes it. The backoff resets only once the whole re-establish has
      // gone through, owed terminal included: a terminal that keeps failing to write is a
      // repeating failure and is paced like one, not retried every second behind a pump that read
      // nothing.
      const settle = this.heldClose;
      if (settle) {
        this.heldClose = undefined;
        if (emitter.openRunId === settle.runId) await this.closeOpenRun(emitter, settle.timestamp, settle.error);
      }
      this.reviving = false;
      this.downRun = undefined;
      this.retryAttempt = 0;
    });
  }

  /** Wait for the endpoint to be live, if the caller supplied a wait. SHARED: while one step
   *  waits, every later step joins the same promise, so a burst of flushes during one outage
   *  produces one listener and one release, and the steps still run one at a time on the chain
   *  (each step's `await` happens inside its own serialized slot, so this sharing cannot
   *  reorder anything). A wait that rejects fails the step, which is the existing terminal path:
   *  liveness-waiting must never swallow an error the emitter would have surfaced. */
  private holdForLive(): Promise<void> {
    if (!this.hooks.waitLive) return Promise.resolve();
    this.liveWait ??= this.hooks.waitLive().finally(() => {
      this.liveWait = undefined;
    });
    return this.liveWait;
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
