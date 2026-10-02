/**
 * ST1 probe (#1323): measure, in a FRESH child process, what importing the manager's service
 * contract module costs on top of its dependency floor (`@cotal-ai/core`, the module's own
 * baseline import). Run by `contract-vocabulary.smoke.ts` (see the import-cost cell there).
 *
 * The child imports one of two targets and reports `process.cpuUsage` delta plus wall time:
 *   --control  imports `@cotal-ai/core` (the floor: NATS client graph, Ajv itself, digest code)
 *   --contract imports `../src/manager-service-contract.js` (the floor + the contract module)
 *
 * The measured quantity is the DELTA between the two: what the contract module itself adds. At
 * module-scope compile that delta is ~500+ ms of CPU (Ajv codegen for 41 schema roots); with the
 * lazy compile it is single-digit ms. A plain wall-or-CPU ceiling on the contract run alone would
 * be the instrument error `SCHEMA_PROFILE` records: the tsx loader and the core graph dominate
 * both sides, so only the difference isolates the compile. Not a shipped module; smoke-only.
 */
import { performance } from "node:perf_hooks";

const mode = process.argv[2] ?? "";
const c0 = process.cpuUsage();
const t0 = performance.now();
if (mode === "--control") {
  await import("@cotal-ai/core");
} else if (mode === "--contract") {
  const m = await import("../src/manager-service-contract.js");
  // Read one digest: proves the lazy path is one property away, and pins the value the smoke
  // compares against the compiled closure digest (see the cell). Costs microseconds.
  void m.managerClusterDocument().commands[0]?.inputDigest;
} else {
  console.error("usage: probe --control | --contract");
  process.exit(2);
}
const c = process.cpuUsage(c0);
console.log(`PROBE ${mode === "--control" ? "control" : "contract"} ${Math.round((c.user + c.system) / 1000)} ${Math.round(performance.now() - t0)}`);
