/**
 * The one reader of `bin/smoke/ci-suites.txt`, so the chain has one parser rather than one per
 * consumer. Three things read the chain - the serial/sharded runner and the gate inventory's two
 * directions - and three copies of "strip comments, split lines" is three places for them to
 * disagree about what the chain is.
 *
 * A malformed line THROWS. It does not skip: a chain that silently drops the entry it could not
 * parse is a chain that runs fewer suites than it prints, which is the failure this whole file
 * exists downstream of.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CI_SUITES_PATH = fileURLToPath(new URL("./ci-suites.txt", import.meta.url));

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
export function parseCiSuites(raw, label = CI_SUITES_PATH) {
  const out = [];
  raw.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith("#")) return;
    if (/^pnpm\s+/.test(s))
      throw new Error(
        `${label}:${i + 1}: drop the \`pnpm \` prefix - this file holds script NAMES, one per line: ` +
          `${JSON.stringify(s)}`,
      );
    if (!/^smoke:[A-Za-z0-9:_-]+$/.test(s))
      throw new Error(`${label}:${i + 1}: not a smoke script name: ${JSON.stringify(s)}`);
    out.push(s);
  });
  return out;
}

/** Reads the chain file. A MISSING or unreadable file throws here - it never yields an empty chain,
 *  because "the chain cannot be empty" is only a real guard if empty cannot be produced silently. */
export function readCiSuites(path = CI_SUITES_PATH) {
  return parseCiSuites(readFileSync(path, "utf8"), path);
}

/** The chain as the `&&` string it used to be, for consumers that grade script BODIES. */
export function ciChainBody() {
  return readCiSuites()
    .map((s) => `pnpm ${s}`)
    .join(" && ");
}
