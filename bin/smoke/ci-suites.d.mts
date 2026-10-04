// Generated from ci-suites.mjs by gen-ci-suites-dts.mts. Do not edit: run `pnpm gen:ci-suites-dts`.
// The .mjs module is the only source of truth; `pnpm smoke:ci-declarations` fails if this drifts.

/**
 * Script names in execution order. Comments and blanks removed; nothing else is.
 *
 * TRAILING WHITESPACE IS NORMALISED AND A `pnpm ` PREFIX IS REFUSED, which are deliberately
 * different answers. A stray space is a typo with exactly one meaning, so trimming it cannot pick
 * the wrong one. `pnpm smoke:x` is what every line of the OLD chain looked like, so someone will
 * paste one in - and accepting it would mean guessing that the leading token is noise. Refusing
 * names the mistake at the point it is made; the alternative is a line that reads correct and runs
 * nothing.
 */
/** @param {string} raw @param {string} [label] @returns {string[]} */
export function parseCiSuites(raw: string, label?: string): string[];
/** Filename a new suite must use under `ci-suites.d/`. Derived from the public script name so two
 *  branches adding unrelated suites cannot share a path. */
/** @param {string} suite @returns {string} */
export function fragmentFileName(suite: string): string;
/** Suite names present in `headRaw` that `baseRaw` does not already carry. Derived from the two
 *  blobs with the same parser the chain uses: comment edits and deletions do not appear, a new
 *  `smoke:*` line does. The frozen list is whatever suite names the file currently parses to, not a
 *  copy of those names kept beside it. */
/** @param {string} baseRaw @param {string} headRaw @param {string} [baseLabel] @param {string} [headLabel] @returns {string[]} */
export function addedLegacySuites(baseRaw: string, headRaw: string, baseLabel?: string, headLabel?: string): string[];
/** Reads the chain file. A MISSING or unreadable file throws here - it never yields an empty chain,
 *  because "the chain cannot be empty" is only a real guard if empty cannot be produced silently. */
export function readCiSuites(path?: string): string[];
/** One suite per fragment file, sorted by filename for deterministic serial execution. The file
 * name is deliberately NOT the execution/shard identity; simultaneous PRs add different paths, so
 * GitHub can merge them independently, and the suite name inside remains the audited public script. */
/** @param {string} [dir] @returns {string[]} */
export function readCiSuiteFragments(dir?: string): string[];
/** Stable shard for fragment suites. The frozen legacy list retains `index % count`; fragments
 * cannot use a concatenated index because another independently-merged filename before them would
 * move their runner. SHA-256 over the public suite name makes assignment independent of filenames,
 * directory order and merge order. */
/** @param {string} suite @param {number} count @returns {number} */
export function fragmentShard(suite: string, count: number): number;
/** @typedef {{ count: number, suites: Map<string, { seconds: number, shard: number }> }} ShardCosts */
/** Measured cost and pinned shard per suite, from `ci-suite-costs.json`. Neither index nor name hash
 * knows what a suite costs, so shards drift apart as suites land; `rebalance-shards.mjs` measures
 * CI job logs and writes this table, and a suite it lists runs on its pinned shard. The pins are
 * committed data, so a suite moves only when a reviewed edit to the table moves it. A malformed
 * table THROWS: a table that silently drops a pin moves that suite. */
/** @param {string} raw @param {string} [label] @returns {ShardCosts} */
export function parseShardCosts(raw: string, label?: string): ShardCosts;
/** @param {string} [path] @returns {ShardCosts} */
export function readShardCosts(path?: string): ShardCosts;
/** One suite's runner. A pin applies only under the shard count it was measured for; any other
 * count is already a full reassignment, so it falls to the frozen index or the name hash. */
/** @param {string} suite @param {number} legacyIndex @param {number} count @param {ShardCosts} costs @returns {number} */
export function suiteShard(suite: string, legacyIndex: number, count: number, costs: ShardCosts): number;
/** The exact assignment the runner executes: a pinned shard from the cost table, else the frozen
 * positional legacy index, else the independently hashed fragment name. Shared so the regression
 * tests the production selector, not a copy. */
/** @param {string[]} legacy @param {string[]} fragments @param {number} shard @param {number} count @param {ShardCosts} [costs] @returns {string[]} */
export function suitesForShard(legacy: string[], fragments: string[], shard: number, count: number, costs?: ShardCosts): string[];
/** The chain as the `&&` string it used to be, for consumers that grade script BODIES. */
export function ciChainBody(): string;
export const CI_SUITES_PATH: string;
export const CI_SUITES_DIR: string;
export const CI_SUITE_COSTS_PATH: string;
export type ShardCosts = {
    count: number;
    suites: Map<string, {
        seconds: number;
        shard: number;
    }>;
};
