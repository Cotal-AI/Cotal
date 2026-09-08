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
import { parseSuiteSources } from "./mutation-suite-metadata.mjs";

/**
 * The config list is DISCOVERED from the tree, never a remembered list of directories: a config
 * that moves would otherwise drop out of both numerator and denominator at once, leaving a ratio
 * that is still plausible and no longer about the same suites. The pattern is any `mutations/`
 * directory rather than `smoke/mutations/`, because a config that grades a TOOL sits beside the
 * tool and a pattern keyed on where configs usually live cannot see the one that lives elsewhere.
 */
const args = process.argv.slice(2);
const configs = args.length
  ? args
  : execSync("git ls-files '*/mutations/*.json' '*.mutations.json'", { encoding: "utf8" }).split("\n").filter(Boolean);

if (configs.length === 0) {
  console.error("no mutation configs found under any mutations/ directory");
  process.exit(1);
}

let cells = 0, named = 0, mutations = 0, unkillable = 0;
const rows = [];
/**
 * A config marked `"kind": "unasserted-probe"` runs the OPPOSITE experiment: it mutates guards no
 * cell was written for and predicts SURVIVED, because a survivor names a guard nothing is watching.
 * Its `cell` fields describe the behaviour that SHOULD have a cell and usually names one that does
 * not exist — so counting them in the numerator would raise the coverage figure by exactly the
 * cells that were found to be missing. Summing the two kinds silently would make the better
 * practice look like progress and the confirm-only method look better than it is; they are reported
 * apart on purpose.
 */
const probes = [];
/**
 * A config marked `"grades": "tool"` measures one of this repo's own instruments through its
 * self-test, not a package's smoke suite. It is reported apart and never folded into the ratio
 * above: a self-test's cells and a smoke suite's cells are not the same unit, and averaging them
 * would move a coverage figure about shipped behaviour by changing a tool's test count.
 *
 * Tool configs remain separate from package coverage, but carry the same source metadata as every
 * other repository fixture so corpus validation does not have a blind spot.
 */
const tools = [];

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
 *
 * A second witness exists for suites that never IMPORT the target at all: a config may declare
 * `"assembles": ["packages/seat", …]` — source trees the suite copies into a fixture where it runs
 * a real lifecycle on the copy. The installed-distribution smoke packs an assembled seat clone, so
 * a mutation in `packages/seat/package.json` reaches the run through the copied bytes and the
 * resolver is never asked. Declaring alone proves nothing: the mutated file must live under a
 * declared root, and the suite's own source must reference that root. That reference check is the
 * same order of approximation as the `../src/` substring above — a textual witness for a data-flow
 * fact — and it is what keeps the declaration honest: a suite that only imports the package by
 * name references no source tree, so the dist trap stays refused.
 */
const quoted = (s) => `["'\`]${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`;
/**
 * Does the suite reference a repo source root? `packages/seat` matches `join(ROOT, "packages",
 * "seat")` — how this repo spells repo-relative paths, as quoted segments — and `cpSync("packages/
 * seat", …)` — one quoted path — alike. Matching only the contiguous form would refuse every suite
 * that assembles from one.
 */
const referencesRoot = (suiteSource, root) =>
  new RegExp([quoted(root), root.split("/").map(quoted).join("\\s*,\\s*")].join("|")).test(suiteSource);

const assertGradable = (configPath, suites, m, assembles) => {
  for (const suite of suites) {
    const suiteSource = readFileSync(suite, "utf8");
    if (packageRoot(m.file) === packageRoot(suite) && suiteSource.includes("../src/")) return;
    const root = assembles.find((r) => m.file === r || m.file.startsWith(r + "/"));
    if (root !== undefined && referencesRoot(suiteSource, root)) return;
  }
  throw new Error(
    `${configPath}: mutation "${m.name}" targets ${m.file}, which none of [${suites.join(", ")}] imports by source path ` +
    `nor reaches through a source tree in this config's "assembles" array — a by-name import resolves that ` +
    `package to dist and the mutation could not reach the running code. Grade it from a suite in ` +
    `${packageRoot(m.file)} that reaches into ../src, declare the source tree the suite copies and runs, ` +
    `or record it in this config's "unkillable" array with the reason.`,
  );
};

for (const path of configs) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const gradesTool = cfg.grades === "tool";
  const suites = parseSuiteSources(process.cwd(), path, cfg.suite);
  // A tool config predicts a named red and has no cell to attribute it to, because there is no
  // suite whose coverage it could be part of.
  const required = gradesTool ? REQUIRED.filter((k) => k !== "cell") : REQUIRED;
  if (cfg.assembles !== undefined
    && (!Array.isArray(cfg.assembles) || cfg.assembles.some((r) => typeof r !== "string" || r === ""))) {
    throw new Error(`${path}: "assembles" must be an array of source-tree paths the suite copies`);
  }
  for (const m of cfg.mutations) {
    for (const k of required) {
      if (typeof m[k] !== "string" || m[k] === "") throw new Error(`${path}: mutation "${m.name ?? "(unnamed)"}" is missing "${k}"`);
    }
    for (const k of REQUIRED_MAY_BE_EMPTY) {
      if (typeof m[k] !== "string") throw new Error(`${path}: mutation "${m.name ?? "(unnamed)"}" is missing "${k}"`);
    }
    if (!gradesTool) assertGradable(path, suites, m, cfg.assembles ?? []);
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
  if (gradesTool) {
    tools.push([path, cfg.mutations.length, executed]);
    continue;
  }
  if (cfg.kind === "unasserted-probe") {
    probes.push([suites.join(", "), cfg.mutations.length, executed]);
    continue;
  }
  const distinct = new Set(cfg.mutations.map((x) => x.cell));
  if (distinct.size !== cfg.mutations.length) {
    console.log(`  note: ${path} has ${cfg.mutations.length} mutations naming ${distinct.size} distinct cells`);
  }
  if (distinct.size > executed) throw new Error(`${path}: names ${distinct.size} cells but the suite ran ${executed}`);

  cells += executed;
  named += distinct.size;
  mutations += cfg.mutations.length;
  unkillable += (cfg.unkillable ?? []).length;
  rows.push([suites.join(", "), executed, distinct.size]);
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const [suite, executed, distinct] of rows) {
  console.log(`${suite.padEnd(w)}  ${String(distinct).padStart(3)} / ${String(executed).padStart(3)} cells observed failing`);
}
console.log(`${"TOTAL".padEnd(w)}  ${named} / ${cells} = ${Math.round((named / cells) * 100)}%`);
console.log(`${mutations} mutations run, ${unkillable} recorded unkillable by construction and not run.`);
console.log("A lower bound: a mutation may redden more cells than the one it names, and those are not claimed here.");
console.log(
  "And an OVER-statement in one direction: every mutation above was authored against a cell written for it,\n" +
  "so this ratio measures the guards that were aimed at, not the guards that exist.",
);
if (probes.length) {
  console.log("\nUnasserted-guard probes — mutations of guards NO cell was written for, predicting SURVIVED.");
  console.log("NOT added to the ratio above: their cells are the ones found MISSING, and counting them would");
  console.log("raise the coverage figure by exactly the gaps they were run to find.");
  for (const [suite, n, executed] of probes) {
    console.log(`  ${suite}  ${n} probes against a suite of ${executed} cells`);
  }
  console.log("  Verdicts come from mutation-proof.mjs; a SURVIVED here is a finding, not a failure.");
}
if (tools.length) {
  console.log("\nInstrument configs — this repo's own tools, graded through their self-tests.");
  console.log("NOT added to the ratio above: a self-test's cells and a smoke suite's cells are different");
  console.log("units, and averaging them would move a figure about shipped behaviour by a tool's test count.");
  for (const [path, n, executed] of tools) {
    console.log(`  ${path}  ${n} mutations against a self-test of ${executed} cells`);
  }
}
