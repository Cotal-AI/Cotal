/**
 * Did this process get scheduled? — the evidence a starved host can obtain about itself, and what
 * follows from it.
 *
 * THE DEFECT THIS EXISTS FOR (#1508). A `sleep` reads the pause plane while it waits. Every one of
 * those reads rides a NATS API request with a 5s client-side deadline, and that deadline is a
 * `setTimeout`. When the host is loaded hard enough that this process does not return to its event
 * loop for longer than the deadline, the deadline's own timer cannot fire either — so it fires the
 * instant the loop frees, rejects with the client's bare `timeout`, and does so even though the
 * broker answered long ago and the reply is sitting in the socket buffer. The interpreter flattens
 * that into `{ code: "L4000", kind: "handler-fault" }`, and the run dies with a record naming the
 * effect as the thing that broke. Measured on this tree before the repair: the identical read
 * returned in 1ms on a healthy loop and rejected `TimeoutError: timeout` after 9001ms with the loop
 * blocked, with the broker healthy immediately before and immediately after.
 *
 * A WALL-CLOCK DEADLINE CANNOT TELL THE TWO APART, which is the whole reason this file is not a
 * larger timeout. "The timer did not fire" and "this process was never scheduled" produce the
 * identical observation — an elapsed deadline with no answer — so widening the deadline only moves
 * the load at which the misattribution happens. The distinction has to come from a DIFFERENT
 * measurement, and there is one the process can take about itself: whether its own event loop ran.
 *
 * TWO INDEPENDENT SIGNALS, and the independence is structural rather than hopeful:
 *
 *   - LAG: a repeating tick records how late it was against the instant it was scheduled for. A
 *     loop that is running answers within a few ms; a loop that is blocked answers with the whole
 *     block.
 *   - TICK SHORTFALL: how many ticks the window should have contained against how many it did. A
 *     blocked loop loses ticks outright.
 *
 * Lag alone would be fooled by a clock that steps forward, which inflates every interval measured
 * against it while the loop was in fact running fine and losing no ticks. The shortfall is what
 * refuses that case, and it can only refuse it if the two are measured against DIFFERENT clocks.
 *
 * SO THE WINDOW IS MONOTONIC, and this is the correction a reviewer measured rather than argued.
 * An earlier draft derived `ticksExpected` from `Date.now()`, the same reading that inflates the
 * lag, so a forward step inflated BOTH while `ticksObserved` could not follow and a perfectly
 * healthy loop read as starved. Measured on this tree before the repair, loop healthy throughout:
 * a +10s step over a 1.2s window gave `{elapsed 11201, lag 10003, expected 44, observed 4}` and
 * classified `starved`, and +60s gave `{elapsed 61201, lag 60000, expected 244, observed 4}`. Worse
 * in the direction that matters here, a BACKWARD step during a genuine 3s block gave
 * `{elapsed 0, lag 0, expected 0, observed 1}` and classified `fault`, which is #1508's own
 * misattribution returning under an NTP correction. Both are gone once the window is measured on a
 * clock that only moves forward at its own rate.
 */
import { EffectError } from "@cotal-ai/lang";

/**
 * The host's two clocks, as ONE injectable object.
 *
 * Deliberately a single source rather than two independent `now`/`wall` parameters. With two, a
 * suite could step the wall while handing the window a clock that by construction never moved, so
 * the clock-step cells passed just as happily against the very wall-clock window they were written
 * to refuse — measured on this tree: with `now` and `wall` separate, forcing the window back onto
 * `Date.now()` left all 41 cells GREEN. One clock means a test steps THE HOST, and which member the
 * window reads becomes the implementation's own choice, which a cell can therefore grade.
 */
export interface HostClock {
  /**
   * Never steps, counts only forward at its own rate, origin arbitrary. Every window is measured
   * on this. Not `Date.now()`, and that is the whole correction above: a wall clock states what
   * time it IS, which an operator or NTP daemon may revise at any moment, while this file asks how
   * much time PASSED and whether this process got to run during it.
   */
  monotonic(): number;
  /** Wall time. Steps under NTP, operator edits, VM resume. Reported in the window, never measured on. */
  wall(): number;
}

/** The real host. */
export const systemClock: HostClock = {
  monotonic: () => performance.now(),
  wall: () => Date.now(),
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The measurement
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How often the observer checks in. Short enough that a window of a few seconds carries enough
 *  ticks for a shortfall to mean something, long enough that the observer is not itself load. */
export const LOOP_TICK_MS = 250;

/** A point in the observer's history. Windows are differences between two of these. */
export interface LoopLagMark {
  /** Monotonic. The window's length is a difference of these, never of wall readings. */
  readonly at: number;
  /** The WALL reading at the same instant, carried only so a step can be NOTICED. */
  readonly wallAt: number;
  readonly lagMs: number;
  readonly ticks: number;
}

/** What the loop did across one window. */
export interface LoopLagWindow {
  /** Wall time the window covers. */
  readonly elapsedMs: number;
  /** Total lateness the observer's ticks accumulated inside it. */
  readonly lagMs: number;
  /** Ticks the window was long enough to contain. */
  readonly ticksExpected: number;
  /** Ticks that actually ran. */
  readonly ticksObserved: number;
  /**
   * How far the WALL clock disagreed with the monotonic window across this interval.
   *
   * Reported rather than acted on, and that is the point: the verdict does not depend on it, so a
   * step cannot change the answer. It exists so an operator reading a starvation notice under a
   * simultaneous NTP correction can see that both happened, and so the suite can assert that the
   * step occurred and the window did NOT move with it.
   */
  readonly wallSkewMs: number;
}

export interface LoopLagObserver {
  /** Take a point to measure from. */
  mark(): LoopLagMark;
  /** What the loop did between `mark` and now. */
  since(mark: LoopLagMark): LoopLagWindow;
}

/**
 * The observer, as a self-rescheduling unrefed tick.
 *
 * UNREFED, because an observer is not a reason for a process to stay alive: a run that has finished
 * must exit, and a refed 250ms timer would hold it open forever. RESCHEDULED FROM INSIDE THE TICK
 * rather than as an interval, because `setInterval` under a blocked loop coalesces its missed fires
 * into one and the count of what DID run stops being readable — and the count is half the evidence.
 */
class TickLoopLag implements LoopLagObserver {
  private lagMs = 0;
  private ticks = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tickMs: number = LOOP_TICK_MS,
    /** The host's clock. One object, so a suite steps the HOST and not one chosen reading. */
    private readonly clock: HostClock = systemClock,
  ) {}

  start(): this {
    if (this.timer === undefined) this.schedule();
    return this;
  }

  /** Stop observing. Only the tests need this; the process observer runs for the process. */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    const due = this.clock.monotonic() + this.tickMs;
    const timer = setTimeout(() => {
      // Lateness against the instant this tick was SCHEDULED for, not against the previous tick:
      // measuring tick-to-tick would report a healthy loop's own jitter as lag and would miss a
      // block that straddled exactly one tick.
      const late = this.clock.monotonic() - due;
      if (late > 0) this.lagMs += late;
      this.ticks += 1;
      this.schedule();
    }, this.tickMs);
    // `unref` is present on Node's timer and absent on the DOM's; the host here is Node, and the
    // optional call keeps this file loadable under a bundler that types it the other way.
    timer.unref?.();
    this.timer = timer;
  }

  mark(): LoopLagMark {
    return {
      at: this.clock.monotonic(),
      wallAt: this.clock.wall(),
      lagMs: this.lagMs,
      ticks: this.ticks,
    };
  }

  since(mark: LoopLagMark): LoopLagWindow {
    const elapsedMs = Math.max(0, this.clock.monotonic() - mark.at);
    return {
      elapsedMs,
      lagMs: Math.max(0, this.lagMs - mark.lagMs),
      ticksExpected: Math.floor(elapsedMs / this.tickMs),
      ticksObserved: Math.max(0, this.ticks - mark.ticks),
      // Signed, and NOT clamped: a backward step is as much a fact as a forward one, and the
      // operator reading the notice wants to know which way it went.
      wallSkewMs: (this.clock.wall() - mark.wallAt) - elapsedMs,
    };
  }
}

/** An observer for a test to drive. Pass a `clock` whose `monotonic` STEPS and you are grading
 *  exactly the failure mode the real `systemClock` exists to remove. */
export function loopLagObserver(
  tickMs: number = LOOP_TICK_MS,
  clock: HostClock = systemClock,
): LoopLagObserver & { stop(): void } {
  return new TickLoopLag(tickMs, clock).start();
}

/**
 * The process's observer.
 *
 * ONE PER PROCESS, because event-loop lag is a property of the process and not of a run, a handler
 * or a pause: two observers would measure the same loop twice and cost two timers to do it. Started
 * on first use so a build that never performs an effect never arms it.
 */
let processObserver: TickLoopLag | undefined;
export function loopLag(): LoopLagObserver {
  processObserver ??= new TickLoopLag().start();
  return processObserver;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The classification
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Lag under this is never starvation, whatever share of the window it is: a 40ms window in which
 *  the loop was 12ms late is a loop that is running. */
export const STARVED_FLOOR_MS = 1_000;
/** And it must be a real share of the window. `4` = a quarter. A read that took a minute and lost
 *  two seconds to lag was served by a loop that was running for 58 of them. */
export const STARVED_SHARE_DIVISOR = 4;
/** And the ticks must actually be missing. `2` = the loop kept at least half of them. A window that
 *  reports large lag while losing no ticks is a clock that moved, not a loop that stopped. */
export const STARVED_TICK_KEPT_DIVISOR = 2;

const nameOf = (e: unknown): string | undefined => {
  const n = (e as { name?: unknown } | null | undefined)?.name;
  return typeof n === "string" ? n : undefined;
};

/**
 * Is this failure the SHAPE a client-side deadline produces?
 *
 * Read off the error's CLASS, never its message. The NATS client's timeout carries the bare text
 * `timeout`, and so do several unrelated failures in this tree and in other people's — matching the
 * word would classify a broker's refusal as starvation the moment somebody phrased one that way.
 *
 * Two accepting branches, because the client raises the deadline in two shapes: on its own for a
 * plain API call, and wrapped in a `RequestError` when the deadline ends a request. Each has a
 * refusing cell that differs from it only in the class involved.
 */
export function isDeadlineShaped(error: unknown): boolean {
  if (nameOf(error) === "TimeoutError") return true;
  if (nameOf(error) === "RequestError" && nameOf((error as { cause?: unknown }).cause) === "TimeoutError") return true;
  return false;
}

/** Was this process demonstrably not scheduled across the window? */
export function wasStarved(w: LoopLagWindow): boolean {
  if (w.lagMs < STARVED_FLOOR_MS) return false;
  if (w.lagMs * STARVED_SHARE_DIVISOR < w.elapsedMs) return false;
  // The second signal, and the one a clock jump cannot fake: a loop that ran is a loop whose ticks
  // happened. `ticksExpected === 0` is a window too short to have contained one, which is no
  // evidence of starvation and is refused here rather than read as a total shortfall.
  if (w.ticksExpected === 0) return false;
  if (w.ticksObserved * STARVED_TICK_KEPT_DIVISOR >= w.ticksExpected) return false;
  return true;
}

/**
 * What a failed pause-plane operation actually was.
 *
 * `fault` is TODAY'S ANSWER AND IT IS UNCHANGED: the caller raises, the interpreter records
 * `L4000`, and a genuine broken host or handler reads exactly as it did before this file existed.
 * The one thing that moves is the case where the error is deadline-shaped AND this process can show
 * its own loop was not running, which was never evidence about the plane at all.
 */
export type PauseCondition =
  | { readonly condition: "starved"; readonly window: LoopLagWindow }
  | { readonly condition: "fault" };

export function classifyPauseFailure(error: unknown, window: LoopLagWindow): PauseCondition {
  if (!isDeadlineShaped(error)) return { condition: "fault" };
  if (!wasStarved(window)) return { condition: "fault" };
  return { condition: "starved", window };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The policy
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many CONSECUTIVE starved attempts a pause operation gets before the host is declared unable
 * to serve it.
 *
 * A BOUND IS MANDATORY and it is the reason this is a count rather than "retry until served": a
 * caller that genuinely cannot be served must fail, not hang, and an unbounded retry on a host that
 * never recovers is a run that is neither alive nor dead. Each attempt costs at least the client's
 * own deadline before it can fail again, so the count is a real wall-clock bound and not a spin.
 */
export const STARVED_ATTEMPTS = 6;

/**
 * A macrotask yield between starved attempts.
 *
 * NOT A WIDENED DEADLINE, and the difference is the whole point of this file: the deadline is
 * unchanged, and this is a pause between re-entries of an operation that already elapsed one. It
 * earns its place twice. A retry that re-enters synchronously occupies the very loop whose absence
 * it is reacting to, so it would spin at full CPU during exactly the window the host needs back;
 * and a starved loop cannot run a timer either, so waiting on one is itself a small measurement of
 * whether scheduling has returned.
 */
export const STARVED_YIELD_MS = 250;

/**
 * Perform a pause-plane operation, and do not let this host's own starvation be recorded as the
 * effect's failure.
 *
 * THE OPERATION MUST BE IDEMPOTENT, which the pause plane's are by construction: `arm` mints
 * idempotently-if-identical and otherwise attaches, and `settle` reads a one-use fact that is
 * either there or not. Re-entering either after a starved attempt observes the same world.
 *
 * A SLEEP PROMISES AT-LEAST, NOT AT-MOST, so a starved one COMPLETES LATE rather than failing: the
 * broker armed a real timer, it fired while this process was off the CPU, and the fact is waiting
 * to be read. Retrying reads it and the step settles `ok`. That is the whole repair for the
 * incident in #1508 — the run in it would have completed.
 *
 * WHAT IS NOT SWALLOWED: a failure that is not deadline-shaped is raised on the FIRST attempt with
 * no retry and no inspection of the loop, and a deadline-shaped failure on a loop that was running
 * is raised the same way. Both keep `L4000` and its message exactly as they are today.
 */
export async function servedDespiteStarvation<T>(
  operation: () => Promise<T>,
  lag: LoopLagObserver,
  what: string,
  onStarved: (note: string) => void = (note) => console.error(note),
): Promise<T> {
  let last: LoopLagWindow | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const mark = lag.mark();
    try {
      return await operation();
    } catch (error) {
      const verdict = classifyPauseFailure(error, lag.since(mark));
      // The genuine fault: out by the same door it used before this wrapper existed, carrying its
      // own error, so the journal records what it always recorded.
      if (verdict.condition === "fault") throw error;
      last = verdict.window;
      const evidence = describe(last);
      if (attempt >= STARVED_ATTEMPTS) {
        throw new EffectError(
          "L4025",
          "host-starved",
          `${what} could not be served: this host did not schedule the run's process across ${attempt} consecutive attempts (${evidence}). `
          + `The pause and its timer are intact on the plane and nothing about the program or the resource it waits on is at fault; `
          + `the run can be resumed once the host has capacity.`,
          { attempts: attempt, lagMs: last.lagMs, elapsedMs: last.elapsedMs, ticksExpected: last.ticksExpected, ticksObserved: last.ticksObserved },
        );
      }
      // SAID OUT LOUD, once per starved attempt. The operator reading a slow run is the person who
      // can act on this, and "the host is overloaded" is not deducible from a run that is merely
      // taking a while.
      onStarved(`${what}: attempt ${attempt} reached its client deadline while this host was not scheduling the run's process (${evidence}); retrying rather than failing the step`);
      // Unrefed: a retry loop is not a reason for a finished process to stay alive.
      await new Promise((r) => setTimeout(r, STARVED_YIELD_MS).unref?.());
    }
  }
}

const describe = (w: LoopLagWindow): string =>
  `event-loop lag ${Math.round(w.lagMs)}ms of a ${Math.round(w.elapsedMs)}ms window, ${w.ticksObserved} of ${w.ticksExpected} scheduled ticks observed`;
