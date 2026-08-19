/**
 * One program on the WALKER, in a process of its own, for the quarantine cell in `differential.smoke`.
 *
 * A quarantined program is one the oracle's own process does not survive, so it cannot be measured
 * from inside a suite: the failure is an unhandled rejection, not a throw the caller can catch. The
 * suite spawns this and reads the exit code, which is the only place that fact is observable.
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
