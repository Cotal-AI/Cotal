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
   */
  closeRun(timestamp: number): void {
    this.enqueue(async () => {
      const emitter = this.emitter;
      if (this.dead || !emitter || emitter.stopped) return;
      const runId = await emitter.closeRun({ timestamp });
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
      this.boundPath = path;
      try {
        // Started INSIDE the chain, which is the only thing keeping this to one emitter, and
        // there is deliberately no second guard here. A belt-and-braces memo would not add one. It
        // would mean a cell asserting "started once" passed whether or not the chain worked, and a
        // second copy of a real guard answers for the original, so the mutation that breaks the
        // original goes on passing and the cell that reads as proof stops being proof without any
        // change to its own text.
        //
        // WHAT A SECOND EMITTER WOULD BREAK IS NO LONGER DESCRIBED HERE, AND THE REASON IS THE
        // POINT. Two earlier versions of this comment restated protections that live in other
        // files, and both were wrong inside an hour: the first credited one mechanism with a second
        // one's work, and the second named the wrong mechanism for the path it was discussing. A
        // comment that restates a guarantee it does not own drifts away from it, and nothing in the
        // edit that moves the guarantee tells the author this sentence exists. The refusals belong
        // next to the code that performs them: the record's are in `subject-frontier.ts`, the log's
        // stale-handle check is in `event-wal.ts`, and the expectation carried on a publish is the
        // broker's to enforce.
        //
        // What this file does own is the bracket interleave, and it is OPEN: two emitters would
        // each keep their own bracket machine and nothing detects the interleave. That is the
        // stated writer-cardinality limit, and this chain is the only thing between the process and
        // it, which is why the chain is the mechanism and there is exactly one cell that can fail
        // if it breaks.
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
    this.chain = this.chain.then(step).catch((e) => this.die(e as Error));
  }

  /** Await the queued work. For callers that need a settled point — a shutdown, or a cell. */
  async settled(): Promise<void> {
    await this.chain;
  }
}
