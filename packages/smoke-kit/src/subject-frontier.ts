/**
 * An in-memory subject frontier for suites whose subject is something else.
 *
 * **IT LIVES HERE RATHER THAN IN SHIPPED CODE, AND THAT IS THE POINT.** `AguiEmitter.start` requires
 * a subject frontier, at runtime as well as in the type, so that no connector can omit it and
 * silently republish an agent's second session against an expectation of zero. A convenience
 * constructor in the shipped module would be exactly the omission route that requirement exists to
 * close, reachable by anyone who found it. A suite double belongs on the suite side of the boundary.
 *
 * **IT MIRRORS THE DURABLE IMPLEMENTATION'S REFUSALS, NOT ONLY ITS HAPPY PATH.** A double that
 * accepts what the real one rejects turns every call site into a place the real refusal is never
 * exercised: it makes the suites agree with the double instead of with what ships. So a value that
 * is not a safe non-negative integer is refused here for the same reason it is refused there, and a
 * reviewer's probe that `advance(NaN)` and `advance(1.5)` were accepted here is why this says so.
 */
export interface MemorySubjectFrontier {
  readonly tip: number;
  advance(seq: number): Promise<void>;
  reset(): Promise<void>;
}

/** A fresh, virgin in-memory frontier. One per case, unless the case is about continuity. */
export function memorySubjectFrontier(initial = 0): MemorySubjectFrontier {
  const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!safe(initial)) throw new Error(`memory subject frontier: initial tip must be a safe non-negative integer, got ${String(initial)}`);
  let tip = initial;
  return {
    get tip() {
      return tip;
    },
    async advance(seq: number) {
      if (!safe(seq)) throw new Error(`memory subject frontier: seq must be a safe non-negative integer, got ${String(seq)}`);
      if (seq <= tip) throw new Error(`memory subject frontier: seq=${seq} does not advance the tip ${tip}`);
      tip = seq;
    },
    async reset() {
      tip = 0;
    },
  };
}
