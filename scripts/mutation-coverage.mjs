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
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * The config list is DISCOVERED from the tree, never a remembered list of directories: a config
 * that moves would otherwise drop out of both numerator and denominator at once, leaving a ratio
 * that is still plausible and no longer about the same suites.
 */
const args = process.argv.slice(2);
const configs = args.length
  ? args
  : execSync("git ls-files '*/smoke/mutations/*.json'", { encoding: "utf8" }).split("\n").filter(Boolean);

if (configs.length === 0) {
  console.error("no mutation configs found under any smoke/mutations/ directory");
  process.exit(1);
}

let cells = 0, named = 0, mutations = 0, unkillable = 0;
const rows = [];

/**
 * Only the fields THIS script's report depends on are checked here. The set of keys the harness
 * accepts is defined once, in `mutation-proof.mjs`, which refuses an unknown one before grading
 * anything — a second copy of that list here drifted the first time the harness gained a key, which
 * is the defect these two scripts exist to measure, committed by the measuring script.
 */
const REQUIRED = ["name", "file", "find", "expectRed", "cell"];
/** `replace` must EXIST but may be empty: deleting the target is a mutation like any other. */
const REQUIRED_MAY_BE_EMPTY = ["replace"];

/** `packages/core/src/x.ts` -> `packages/core`; `implementations/runtime/smoke/y.ts` -> `implementations/runtime`. */
const packageRoot = (p) => p.split("/").slice(0, 2).join("/");

/**
 * A mutation is only gradable if the suite runs the file it mutates. A suite that imports its
 * target's package BY NAME gets `dist`, so mutating the source cannot reach the running code and
 * the harness reports SURVIVED — honestly, and indistinguishably from a missing test. The check is
 * an approximation of the resolver on purpose: same package, and the suite actually reaches into
 * `../src`. It is here rather than in a note because a rule that depends on the next author
 * remembering it is the rule that just failed.
 */
const assertGradable = (configPath, suite, m) => {
  if (packageRoot(m.file) === packageRoot(suite) && readFileSync(suite, "utf8").includes("../src/")) return;
  throw new Error(
    `${configPath}: mutation "${m.name}" targets ${m.file}, which ${suite} does not import by source path — ` +
    `it would resolve that package to dist and the mutation could not reach the running code. ` +
    `Grade it from a suite in ${packageRoot(m.file)}, or record it in this config's "unkillable" array with the reason.`,
  );
};

for (const path of configs) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  for (const m of cfg.mutations) {
    for (const k of REQUIRED) {
      if (typeof m[k] !== "string" || m[k] === "") throw new Error(`${path}: mutation "${m.name ?? "(unnamed)"}" is missing "${k}"`);
    }
    for (const k of REQUIRED_MAY_BE_EMPTY) {
      if (typeof m[k] !== "string") throw new Error(`${path}: mutation "${m.name ?? "(unnamed)"}" is missing "${k}"`);
    }
    assertGradable(path, cfg.suite, m);
  }
  const out = execSync(cfg.command, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  // Two terminal shapes exist in this repo. "N passed, M failed" comes from a suite that records
  // failures and keeps going; "N checks passed" from a fail-fast one, where reaching the line at
  // all means nothing failed. Both are the SUITE's own count of what it executed, which is the
  // only number that cannot be inflated by reading the source.
  const tallied = out.match(/(\d+) passed, (\d+) failed/);
  const failFast = out.match(/(\d+) checks passed/);
  if (!tallied && !failFast) throw new Error(`${path}: \`${cfg.command}\` printed neither "N passed, M failed" nor "N checks passed"`);
  if (tallied && Number(tallied[2]) !== 0) throw new Error(`${path}: the suite is already red — coverage over a red suite means nothing`);

  const executed = Number((tallied ?? failFast)[1]);
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
