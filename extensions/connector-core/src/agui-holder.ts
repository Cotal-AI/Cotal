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
import type { AguiEmitter, HeldTerminal, ReportedTerminal } from "./agui-emitter.js";

/**
 * The connector's hooks into an {@link AguiEmitterHolder}.
 *
 * Named rather than positional because the types cannot tell them apart: a `runMeta` provider is
 * assignable to `onRunClosed`, so a position would let it land there, typecheck, and lose its
 * metadata with nothing reporting why.
 */
export interface AguiEmitterHolderHooks {
  /** Where a failure goes, with the delay before the holder re-establishes the plane (`0` when it
   *  does so at once), or `null` when it will not because the holder is closed. Required, and not
   *  defaulted to a swallow: the holder runs behind a hook that must not throw, so the only way a
   *  failure reaches a human is if the caller is made to say where it goes. */
  onError: (e: Error, retryInMs: number | null) => void;
  /**
   * The position the adopted source has reached now: its `DurableSource.end`, for the path the
   * holder is bound to. Taken when {@link AguiEmitterHolder.closeRun} is called, so a terminal the
   * plane cannot take at once is placed on the turn the source had begun by then, whatever is
   * written after it. Required: a terminal held with no position would have to be paired with a
   * turn by count, and a connector that repeats a terminal, or loses one, then shifts every later
   * terminal onto the wrong turn (Sol, round 11 of 2026-10-13).
   */
  sourceEnd: (path: string) => Promise<string>;
  /** The wait between re-establish attempts while the plane stays down. The first attempt after
   *  a failure is at once; this paces the ones after it. Default one second. */
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
 * process instead, at once, and the seat keeps its connection; the line says when.
 */
export function eventPlaneStopped(opts: { log: (line: string) => void }): (e: Error, retryInMs: number | null) => void {
  return (e, retryInMs) =>
    opts.log(
      `AG-UI emitter stopped: ${e.message}` +
        (retryInMs === null ? "" : retryInMs === 0 ? "; re-establishing the event plane now" : `; re-establishing the event plane in ${retryInMs}ms`),
    );
}

/**
 * Holds at most one {@link AguiEmitter} at a time, started on first adopt and re-established at
 * once after a failure.
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
   * The re-establish runs AT ONCE, off the failing step: a seat whose plane is down is a seat
   * whose turns are missing from the wire, and nothing is gained by waiting to find out whether
   * the fault has cleared. While it stays down the attempts follow every `retryMs`, a fixed wait
   * that neither grows nor is capped: a standing fault costs one start a second, and the plane is
   * back within that second of the fault clearing, whether or not the agent is doing anything. It
   * is the same recovery a connector restart runs, so it adds no path the emitter did not already
   * take, and a pending frame is settled by `start()` before anything new is read. The failure is
   * still reported, every time, with the delay; a plane that came back on its own is not a plane
   * that failed silently.
   */
  private dead?: Error;
  /** The first adopt's context, kept so a re-establish starts the emitter as the first start did. */
  private startContext?: StartContext;
  /** True from a failure until a re-establish has gone through in full. A failure under it is the
   *  plane still down, and the next attempt is paced by `retryMs`; without it, at once. */
  private retried = false;
  private reviveTimer?: ReturnType<typeof setTimeout>;
  /**
   * The turn terminals held while no emitter can take them: ones that arrived while the plane was
   * down or while a fresh start was in flight, one whose own close failed, and the ones a dying
   * emitter still held. Each with the position the source had reached when it was reported, which
   * is what names its turn; {@link revive} hands them to the fresh emitter, whose pump places each
   * on the turn the source had begun by that position (Sol, rounds 10 and 11 of 2026-10-13,
   * through the built MCP entry point: held by count, the second turn to end during an outage lost
   * its terminal as a repeat of the first, and a repeated terminal shifted every later one onto the
   * wrong turn).
   */
  private held: ReportedTerminal[] = [];
  /** The last turn the dying emitter had begun on the wire, for the fresh emitter to place a
   *  terminal reported before any record it reads. Absent until an emitter has been dropped. */
  private lastTurn?: { turn: string | null | undefined };
  /** True from the moment {@link revive} drops the failed emitter until its fresh start, pump and
   *  held close have all gone through. A terminal that arrives in that window is held, never
   *  queued: a queued close would run after the recovery pump and close whatever run is open then. */
  private reviving = false;
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
    this.bind(path, context);
    this.enqueue(() => this.ensureStarted(path).then(() => undefined));
  }

  /**
   * Bind to the first usable path, with the first adopt's context, AT THE CALL: a terminal reported
   * after this call, and before the start it queues has run, takes its source position from the
   * bound path. The binding is checked by every later start, see {@link ensureStarted}, and it is
   * set once: a later hook cannot overwrite the first session's startup fact while the
   * connector-owned factory is still waiting on its own async preconditions.
   */
  private bind(path: unknown, context?: StartContext): void {
    if (this.boundPath !== undefined || typeof path !== "string" || path.length === 0) return;
    this.boundPath = path;
    this.startContext = context;
  }

  /**
   * Adopt if necessary, then drain the source into frames.
   *
   * Same contract as {@link adopt}: synchronous, non-throwing, work on the chain.
   */
  flush(path: unknown): void {
    this.bind(path);
    this.enqueue(async () => {
      const emitter = await this.ensureStarted(path);
      if (!emitter || emitter.stopped) return;
      await this.holdForLive();
      await emitter.pump();
    });
  }

  /**
   * Place every terminal the emitter still has waiting, then close the open run with the terminal
   * owed to it, if one is. A terminal that arrived while a pump was reading was reported past that
   * read, so another pump reads up to it and places it; one placed on the run the pump leaves open
   * is the close the source has not synthesized, because the next prompt is not written yet. A
   * close that fails here holds the terminal again on its way out, so the next re-establish still
   * owes it. Every terminal goes this way, live or after an outage: a close of whatever run is open
   * when the step runs would end the NEXT run when the flush before it read the next prompt.
   */
  private async settle(emitter: AguiEmitter<T>): Promise<void> {
    while (emitter.waitingTerminals > 0) await emitter.pump();
    const open = emitter.openRunId;
    const owed = open === undefined ? undefined : emitter.takeOwed(open);
    if (owed) await this.closeOpenRun(emitter, owed);
  }

  /**
   * Close the open run at a turn boundary the record stream cannot see.
   *
   * Non-throwing, work on the chain, as {@link adopt} and {@link flush}: a lifecycle hook calls it
   * and a hook must not be made to fail. The promise handed back never rejects; it resolves once the
   * source position the terminal is reported at has been read, for a hook that replies after that.
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
  closeRun(timestamp: number, error?: { message: string; code?: string }): Promise<void> {
    if (this.shut || this.boundPath === undefined) return Promise.resolve();
    // THE SOURCE POSITION IS TAKEN HERE, AT THE HOOK, whatever the plane's state: it is what names
    // the terminal's turn once the plane is up (see `AguiEmitter.queueTerminal`), and a position
    // taken when a step runs would be past whatever the session wrote in between. The read is
    // issued now and awaited by whoever places the terminal; a position that cannot be read is
    // reported there, once, and the terminal dropped. The promise handed back resolves once the
    // position is read, for a hook that must reply only after that.
    const terminal: HeldTerminal = { timestamp, ...(error ? { error } : {}) };
    let at: Promise<string>;
    try {
      at = Promise.resolve(this.hooks.sourceEnd(this.boundPath));
    } catch (e) {
      at = Promise.reject(e as Error);
    }
    const taken = at.then(
      () => undefined,
      () => undefined,
    );
    const entry: ReportedTerminal = { terminal, at };
    // DECIDED AT THE HOOK, NOT WHEN A STEP RUNS. A terminal is not a record in the source, so a
    // start cannot read it back, and a run the log has open with no terminal stays open on the wire
    // until a later prompt closes it as a FINISH, which for a failed turn is the wrong terminal
    // (Sol, review of 2026-10-12). Queued only by the step below, it would reach the emitter after
    // whatever read runs before that step: the recovery pump of a re-establish (Sol, round 7 of
    // 2026-10-13), the flush the stop hook queued ahead of the close (round 8, and live on the
    // eleventh), or the flush queued behind a first start still waiting on the broker (round 16).
    // That read may answer the NEXT prompt, whose mapping closes the failed run as a finish, and
    // the terminal would then close its successor. So it goes to the live emitter now, which
    // places it on its own turn when its pump reads up to it; with no live emitter, down, mid
    // re-establish or before the first start has returned, it is HELD, and the start hands every
    // held terminal to the emitter before any pump.
    const live = this.emitter;
    const queued = this.dead === undefined && live !== undefined && !live.stopped;
    if (queued) live.queueTerminal(entry);
    else this.held.push(entry);
    this.enqueue(async () => {
      const emitter = this.emitter;
      // Behind the step that took the plane down: the terminal is held already, by the hook or
      // handed back by the dying emitter, and the re-establish settles it.
      if (this.dead || !emitter || emitter.stopped) return;
      await this.holdForLive();
      if (this.held.includes(entry)) this.handOver(emitter, entry);
      await this.settle(emitter);
    });
    return taken;
  }

  /**
   * Close the run `emitter` has open with this terminal, reporting the close. A close that FAILS
   * holds the terminal before the failure goes on to kill the plane: the terminal is owed to its
   * turn whether the log took it or not, and a close that failed before its frame froze leaves
   * the run open for the re-establish to find (Sol, review of 2026-10-13: a terminal whose own
   * log write failed was lost, and the next prompt closed the failed run as a finish). A close
   * that failed after the freeze is the frozen frame itself; the start that settles it closes the
   * run, and the held terminal is then dropped for naming a run the wire has closed.
   */
  private async closeOpenRun(emitter: AguiEmitter<T>, entry: ReportedTerminal): Promise<void> {
    const open = emitter.openRunId;
    const cotal = open === undefined ? undefined : this.hooks.runMeta?.(open);
    const { terminal } = entry;
    let runId: string | null;
    try {
      runId = await emitter.closeRun({ timestamp: terminal.timestamp, ...(cotal ? { cotal } : {}), ...(terminal.error ? { error: terminal.error } : {}) });
    } catch (e) {
      // Held FIRST, ahead of anything the dying emitter still holds: this turn ended before any
      // the emitter is still waiting on.
      if (open !== undefined) this.held.unshift(entry);
      throw e;
    }
    // Reported for EITHER terminal. The mapper's job here is to stop attributing records to a run
    // the published stream has closed, and an error close closes it exactly as a finish does.
    if (runId !== null) this.hooks.onRunClosed?.(runId);
  }

  /** Hand a held terminal to a live emitter, which places it on its turn when its pump reads up
   *  to the position it was reported at. */
  private handOver(emitter: AguiEmitter<T>, entry: ReportedTerminal): void {
    this.held = this.held.filter((h) => h !== entry);
    emitter.queueTerminal(entry);
  }

  /**
   * Start at most once, bind the path once.
   *
   * Returns `undefined` when there is nothing to run against — a dead holder or a path this holder
   * cannot take — rather than throwing, so a caller cannot mistake "no emitter" for "pumped".
   */
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

    // A CLOSED HOLDER NEVER STARTS, even for work that was already queued when it closed. Starting
    // reaches the broker and opens a write-ahead log for a holder its owner has already released,
    // which is the opposite of releasing it. Pumping an emitter that is ALREADY running is a
    // different act and is deliberately still allowed: see the note on `close`.
    if (this.shut) return undefined;
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
      this.emitter = await this.startEmitter(path, this.startContext);
      // A terminal reported while this first start was in flight goes to the emitter now, before
      // the flush queued behind the start pumps. A re-establish hands its held terminals over
      // itself, after seeding the last turn the dying emitter had begun.
      if (!this.reviving) for (const entry of [...this.held]) this.handOver(this.emitter, entry);
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
    // Every terminal the dying emitter still held, and the last turn it had begun on the wire: the
    // terminals it had were handed to it when it was the live one, and the fresh emitter takes
    // them back. With no emitter (a fresh start that failed before it returned) what was carried
    // from the first failure of this outage still holds: nothing was published since the plane
    // went down.
    if (this.emitter !== undefined) {
      const left = this.emitter.unsettled();
      this.held.push(...left.terminals);
      this.lastTurn = { turn: left.lastTurn };
    }
    if (this.shut) {
      this.hooks.onError(e, null);
      return;
    }
    // AT ONCE for the first failure, off this step: a transient fault is over by the time the
    // start runs, and the turns it left unpublished are on the wire before the agent's next
    // action. A failure under a re-establish is the plane still down, paced by `retryMs`, fixed:
    // it neither doubles nor caps, so the plane is back within one wait of the fault clearing.
    const delay = this.retried ? (this.hooks.retryMs ?? 1_000) : 0;
    this.retried = true;
    this.reviveTimer = setTimeout(() => this.revive(), delay);
    this.hooks.onError(e, delay);
  }

  /**
   * Re-establish the plane after a failure: clear the failure, drop the emitter, and queue a start
   * and a pump on the chain. The start is a fresh `startEmitter`, which reopens the
   * write-ahead log, settles any frame it left pending, and builds the connector's mapper from the
   * bracket state the log holds, before reading on from the stored cursor. A failure here is
   * reported like the first, and the next attempt follows after `retryMs`.
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
    if (this.reviveTimer !== undefined) clearTimeout(this.reviveTimer);
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
      // The held terminals go to the emitter BEFORE the pump reads on; handed here, AFTER the
      // start, so a terminal that arrived while the start was in flight is among them. The records
      // of those turns were written before the terminals arrived and the pump has not read them
      // yet, so a close before the pump would drop them; but the unread records may also hold the
      // NEXT prompt, whose mapping closes the held run as a finish, and the emitter publishes an
      // owed error in that finish's place, after the run's own records and before the next run
      // opens (Sol, review of 2026-10-13, through the built MCP entry point: the held error was
      // dropped behind that synthesized finish). A held finish is that synthesized finish. The
      // last turn the dying emitter had begun goes first, so a terminal reported before any
      // record the pump reads is placed on it.
      if (this.lastTurn) {
        emitter.seedLastTurn(this.lastTurn.turn);
        this.lastTurn = undefined;
      }
      for (const entry of [...this.held]) this.handOver(emitter, entry);
      await emitter.pump();
      // A terminal the pump placed on the run it left open closes it here. A close that fails here
      // holds the terminal again on its way out, so the next re-establish still owes it. The
      // re-establish has gone through only once the whole of it has, owed terminal included: a
      // terminal that keeps failing to write fails the re-establish, and the next attempt is paced.
      await this.settle(emitter);
      this.reviving = false;
      this.retried = false;
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
