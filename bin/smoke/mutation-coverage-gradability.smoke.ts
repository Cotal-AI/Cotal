/** The coverage auditor must accept a suite that imports its mutation target directly by relative path. */
import { spawnSync } from "node:child_process";

const run = spawnSync(
  process.execPath,
  ["scripts/mutation-coverage.mjs", "bin/smoke/mutations/pr-head-gate.json"],
  { cwd: process.cwd(), encoding: "utf8" },
);
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const accepted = run.status === 0 && /bin\/smoke\/pr-head-gate\.smoke\.ts\s+6 \/\s+26 cells observed failing/.test(output);
console.log(`  ${accepted ? "✓" : "✗"} a direct cross-directory source import is accepted as product-smoke gradability`);
if (!accepted) console.log(output);
console.log(`MUTATION COVERAGE GRADABILITY: ${accepted ? 1 : 0} checks passed`);
if (!accepted) process.exitCode = 1;
