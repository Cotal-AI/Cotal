#!/usr/bin/env node
/**
 * How much of a smoke suite has been OBSERVED failing?
 *
 * A green cell is not evidence that it can still go red. A mutation killed on a named cell is —
 * it is a direct observation of that cell failing. This script reports, per mutation config, how
 * many of the suite's executed cells have such an observation behind them.
 *
 * It counts EXECUTED cells, never cells read out of the source: a suite that generates cells in a
 * loop runs more than it spells out, and a static count silently inflates the ratio. So each
 * config's `command` is run and its terminal `<suite>: N passed, M failed` line is parsed.
 *
 * The numerator is DISTINCT cells named by mutations, not the mutation count — two mutations
 * naming one cell is one observation, and the script refuses to double-count it. It is still a
 * LOWER bound: a mutation may redden cells beyond the one it names, and those are not claimed.
 *
 *   node scripts/mutation-coverage.mjs                     # every config in the tree
 *   node scripts/mutation-coverage.mjs <config.json> …     # just these
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const DIRS = ["implementations/runtime/smoke/mutations", "packages/core/smoke/mutations"];
const args = process.argv.slice(2);
const configs = args.length
  ? args
  : DIRS.filter((d) => existsSync(d)).flatMap((d) =>
      readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => join(d, f)));

if (configs.length === 0) {
  console.error("no mutation configs found");
  process.exit(1);
}

let cells = 0, named = 0, mutations = 0, unkillable = 0;
const rows = [];

for (const path of configs) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const out = execSync(cfg.command, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (!m) throw new Error(`${path}: \`${cfg.command}\` printed no "N passed, M failed" line`);
  if (Number(m[2]) !== 0) throw new Error(`${path}: the suite is already red — coverage over a red suite means nothing`);

  const executed = Number(m[1]);
  const distinct = new Set(cfg.mutations.map((x) => x.cell));
  if (distinct.size !== cfg.mutations.length) {
    console.log(`  note: ${path} has ${cfg.mutations.length} mutations naming ${distinct.size} distinct cells`);
  }
  if (distinct.size > executed) throw new Error(`${path}: names ${distinct.size} cells but the suite ran ${executed}`);

  cells += executed;
  named += distinct.size;
  mutations += cfg.mutations.length;
  unkillable += (cfg.unkillable ?? []).length;
  rows.push([cfg.suite, executed, distinct.size]);
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const [suite, executed, distinct] of rows) {
  console.log(`${suite.padEnd(w)}  ${String(distinct).padStart(3)} / ${String(executed).padStart(3)} cells observed failing`);
}
console.log(`${"TOTAL".padEnd(w)}  ${named} / ${cells} = ${Math.round((named / cells) * 100)}%`);
console.log(`${mutations} mutations run, ${unkillable} recorded unkillable by construction and not run.`);
console.log("A lower bound: a mutation may redden more cells than the one it names, and those are not claimed here.");
