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
/** The exact assignment the runner executes: frozen positional legacy entries plus independently
 * hashed fragment entries. Shared so the regression tests the production selector, not a copy. */
/** @param {string[]} legacy @param {string[]} fragments @param {number} shard @param {number} count @returns {string[]} */
export function suitesForShard(legacy: string[], fragments: string[], shard: number, count: number): string[];
/** The chain as the `&&` string it used to be, for consumers that grade script BODIES. */
export function ciChainBody(): string;
export const CI_SUITES_PATH: string;
export const CI_SUITES_DIR: string;
