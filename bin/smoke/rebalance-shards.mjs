// @ts-check
/**
 * Measure the smoke shards from CI job logs and rebalance them in `ci-suite-costs.json`.
 *
 *   gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs > shard.log   # one per smoke job
 *   node bin/smoke/rebalance-shards.mjs shard.log [more.log ...]
 *
 * A suite's cost is the median of its observed durations. A serial suite runs from its
 * `===== pnpm <suite> =====` banner to the next banner, or to the shard's pass line; a pooled suite
 * reports its own seconds. A suite that never finished in any log keeps its recorded cost, and one
 * with no cost at all keeps its index or hash shard. Then, while the heaviest shard holds a suite
 * smaller than its gap to the lightest, the suite closest to half that gap moves. Every move is a
 * pin change in the table, so the reviewer of a rebalance reads the reassignment in its diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  CI_SUITES_PATH,
  CI_SUITE_COSTS_PATH,
  parseCiSuites,
  readCiSuiteFragments,
  readShardCosts,
  suiteShard,
} from "./ci-suites.mjs";

const logs = process.argv.slice(2);
if (logs.length === 0) {
  console.error("usage: node bin/smoke/rebalance-shards.mjs <smoke-job-log> [...]");
  process.exit(2);
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;
const BANNER = / ===== pnpm (smoke\S*) =====\s*$/;
const POOL_START = / \[pool\] start pnpm (smoke\S*)\s*$/;
const POOL_DONE = / \[pool\] done pnpm (smoke\S*): exit 0, ([0-9.]+)s\s*$/;
const PASSED = / ✓ smoke:ci shard /;

/** @type {Map<string, number[]>} */
const observed = new Map();
const observe = (/** @type {string} */ suite, /** @type {number} */ seconds) =>
  observed.set(suite, [...(observed.get(suite) ?? []), seconds]);

for (const path of logs) {
  const pooled = new Set();
  /** @type {{ suite: string, at: number } | null} */
  let running = null;
  let banners = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const stamp = STAMP.exec(line);
    if (!stamp) continue;
    const at = Date.parse(stamp[1]);
    let match;
    if ((match = POOL_START.exec(line))) pooled.add(match[1]);
    else if ((match = POOL_DONE.exec(line))) observe(match[1], Number(match[2]));
    else if ((match = BANNER.exec(line)) && !pooled.has(match[1])) {
      banners++;
      if (running) observe(running.suite, (at - running.at) / 1000);
      running = { suite: match[1], at };
    } else if (PASSED.test(line) && running) {
      observe(running.suite, (at - running.at) / 1000);
      running = null;
    }
  }
  if (banners === 0) throw new Error(`${path}: no timestamped suite banner; pass a smoke shard job log from GitHub Actions`);
}

const median = (/** @type {number[]} */ values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const previous = readShardCosts();
const count = previous.count;
const legacy = parseCiSuites(readFileSync(CI_SUITES_PATH, "utf8"), CI_SUITES_PATH);
const registry = [...legacy.map((suite, index) => ({ suite, index })), ...readCiSuiteFragments().map((suite) => ({ suite, index: -1 }))];

/** @type {Map<string, number>} */
const seconds = new Map();
for (const { suite } of registry) {
  const measured = observed.get(suite);
  const cost = measured ? Math.round(median(measured) * 10) / 10 : previous.suites.get(suite)?.seconds;
  if (cost !== undefined) seconds.set(suite, cost);
}
if (seconds.size === 0) throw new Error("no registered suite was measured in the given logs");
const estimate = median([...seconds.values()]);

/** @type {Map<string, number>} */
const shardOf = new Map();
const load = Array.from({ length: count }, () => 0);
for (const { suite, index } of registry) {
  if (shardOf.has(suite)) continue;
  const shard = suiteShard(suite, index, count, previous);
  shardOf.set(suite, shard);
  load[shard] += seconds.get(suite) ?? estimate;
}
const before = [...load];

/** @type {string[]} */
const moves = [];
for (;;) {
  const heavy = load.indexOf(Math.max(...load));
  const light = load.indexOf(Math.min(...load));
  const gap = load[heavy] - load[light];
  let best = null;
  for (const [suite, cost] of seconds) {
    if (shardOf.get(suite) !== heavy || cost <= 0 || cost >= gap) continue;
    const distance = Math.abs(gap / 2 - cost);
    if (!best || distance < best.distance || (distance === best.distance && suite < best.suite)) best = { suite, cost, distance };
  }
  if (!best) break;
  shardOf.set(best.suite, light);
  load[heavy] -= best.cost;
  load[light] += best.cost;
  moves.push(`${best.suite} ${heavy} -> ${light}`);
}

const entries = [...seconds.keys()].sort().map((suite) =>
  `    ${JSON.stringify(suite)}: { "seconds": ${seconds.get(suite)}, "shard": ${shardOf.get(suite)} }`);
writeFileSync(CI_SUITE_COSTS_PATH, `{\n  "count": ${count},\n  "suites": {\n${entries.join(",\n")}\n  }\n}\n`);

const minutes = (/** @type {number[]} */ loads) => loads.map((value, shard) => `${shard}: ${(value / 60).toFixed(1)}m`).join("  ");
console.log(`measured ${observed.size} suite(s) from ${logs.length} log(s); ${seconds.size} of ${shardOf.size} registered suites have a cost`);
console.log(`estimated load before  ${minutes(before)}`);
console.log(`estimated load after   ${minutes(load)}`);
console.log(`${moves.length} suite(s) moved${moves.length ? `:\n  ${moves.join("\n  ")}` : ""}`);
