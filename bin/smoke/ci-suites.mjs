// @ts-check
/**
 * The one reader of the CI suite registry: the frozen positional list in `ci-suites.txt` plus one
 * file per future suite in `ci-suites.d/`. Three things read the registry - the serial/sharded
 * runner and the gate inventory's two directions - and three copies of "strip comments, split
 * lines, load fragments" is three places for them to disagree about what the gate is.
 *
 * A malformed line THROWS. It does not skip: a chain that silently drops the entry it could not
 * parse is a chain that runs fewer suites than it prints, which is the failure this whole file
 * exists downstream of.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CI_SUITES_PATH = fileURLToPath(new URL("./ci-suites.txt", import.meta.url));
export const CI_SUITES_DIR = fileURLToPath(new URL("./ci-suites.d", import.meta.url));

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
export function parseCiSuites(raw, label = CI_SUITES_PATH) {
  /** @type {string[]} */
  const out = [];
  raw.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith("#")) return;
    if (/^pnpm\s+/.test(s))
      throw new Error(
        `${label}:${i + 1}: drop the \`pnpm \` prefix - this file holds script NAMES, one per line: ` +
          `${JSON.stringify(s)}`,
      );
    if (!/^smoke(?::[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)?$/.test(s))
      throw new Error(`${label}:${i + 1}: not a smoke script name: ${JSON.stringify(s)}`);
    out.push(s);
  });
  return out;
}

/** Reads the chain file. A MISSING or unreadable file throws here - it never yields an empty chain,
 *  because "the chain cannot be empty" is only a real guard if empty cannot be produced silently. */
export function readCiSuites(path = CI_SUITES_PATH) {
  const legacy = parseCiSuites(readFileSync(path, "utf8"), path);
  if (path !== CI_SUITES_PATH) return legacy;
  return [...legacy, ...readCiSuiteFragments()];
}

/** One suite per fragment file, sorted by filename for deterministic serial execution. The file
 * name is deliberately NOT the execution/shard identity; simultaneous PRs add different paths, so
 * GitHub can merge them independently, and the suite name inside remains the audited public script. */
/** @param {string} [dir] @returns {string[]} */
export function readCiSuiteFragments(dir = CI_SUITES_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      const suites = parseCiSuites(readFileSync(path, "utf8"), path);
      if (suites.length !== 1)
        throw new Error(`${path}: a suite fragment must contain exactly one smoke script, got ${suites.length}`);
      const expected = `${createHash("sha256").update(suites[0]).digest("hex")}.txt`;
      if (entry.name !== expected)
        throw new Error(`${path}: fragment filename must be sha256(${suites[0]}) = ${expected}`);
      return suites;
    });
}

/** Stable shard for fragment suites. The frozen legacy list retains `index % count`; fragments
 * cannot use a concatenated index because another independently-merged filename before them would
 * move their runner. SHA-256 over the public suite name makes assignment independent of filenames,
 * directory order and merge order. */
/** @param {string} suite @param {number} count @returns {number} */
export function fragmentShard(suite, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be positive, got ${count}`);
  return createHash("sha256").update(suite).digest().readUInt32BE(0) % count;
}

/** The exact assignment the runner executes: frozen positional legacy entries plus independently
 * hashed fragment entries. Shared so the regression tests the production selector, not a copy. */
/** @param {string[]} legacy @param {string[]} fragments @param {number} shard @param {number} count @returns {string[]} */
export function suitesForShard(legacy, fragments, shard, count) {
  if (!Number.isInteger(shard) || !Number.isInteger(count) || count < 1 || shard < 0 || shard >= count)
    throw new Error(`invalid shard ${shard}/${count}`);
  return [
    ...legacy.filter((_, index) => index % count === shard),
    ...fragments.filter((suite) => fragmentShard(suite, count) === shard),
  ];
}

/** The chain as the `&&` string it used to be, for consumers that grade script BODIES. */
export function ciChainBody() {
  return readCiSuites()
    .map((s) => `pnpm ${s}`)
    .join(" && ");
}
