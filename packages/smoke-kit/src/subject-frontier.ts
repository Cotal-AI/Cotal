/**
 * An in-memory subject frontier for suites whose subject is something else.
 *
 * **IT LIVES HERE RATHER THAN IN SHIPPED CODE, AND THAT IS THE POINT.** `AguiEmitter.start` requires
 * a subject frontier, at runtime as well as in the type, so that no connector can omit it and
 * silently republish an agent's second session against an expectation of zero. A convenience
 * constructor in the shipped module would be exactly the omission route that requirement exists to
 * close, reachable by anyone who found it. A suite double belongs on the suite side of the boundary.
 *
 * It mirrors the durable implementation's contract EXACTLY, including `seedFromThread`: a double
 * that silently lacked it would make every case with a pre-seeded write-ahead log publish against a
 * tip of zero, and the cells would go red for a reason that has nothing to do with what they test.
 */
export interface MemorySubjectFrontier {
  readonly tip: number;
  advance(seq: number): Promise<void>;
  reset(): Promise<void>;
  seedFromThread(seq: number): Promise<void>;
}

/** A fresh, virgin in-memory frontier. One per case, unless the case is about continuity. */
export function memorySubjectFrontier(initial = 0): MemorySubjectFrontier {
  let tip = initial;
  return {
    get tip() {
      return tip;
    },
    async advance(seq: number) {
      if (seq <= tip) throw new Error(`memory subject frontier: seq=${seq} does not advance the tip ${tip}`);
      tip = seq;
    },
    async reset() {
      tip = 0;
    },
    async seedFromThread(seq: number) {
      if (tip !== 0) throw new Error(`memory subject frontier: refusing to seed a record that already holds tip ${tip}`);
      if (seq > 0) tip = seq;
    },
  };
}
