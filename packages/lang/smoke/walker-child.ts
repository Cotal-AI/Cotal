/**
 * One program on the WALKER, in a process of its own, for the survival cell in `differential.smoke`.
 *
 * These three programs used to take the oracle's own process down - two of them by never settling
 * at all - which cannot be measured from inside a suite: it hangs the suite or kills it mid-run,
 * and neither reds a cell. They refuse cleanly now and are ordinary corpus rows, compared in the
 * suite's own process. That is exactly why this stays: a regression would put them back to hanging
 * the gate rather than reding it, and a child's exit code is the only place the fact is observable.
 */
import { Journal } from "../src/journal.js";
import { run as walk } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";

const source = process.argv[2] as string;
const options = { runId: "q", handler: new SimHandler({} as never), journal: new Journal({ run: "q" }), seed: 7, startedAt: 0, onLog: () => {} };
try {
  await walk(source, options as never);
  console.log("COMPLETED");
} catch (e) {
  console.log(`REFUSED ${(e as { code?: string }).code ?? (e as Error).name}`);
}
