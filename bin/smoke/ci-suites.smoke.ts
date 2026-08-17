/**
 * The `smoke:ci` chain file's PARSER, which is the thing this migration actually introduced.
 *
 * The chain used to be a single `&&` string in package.json. A string has no syntax: there was
 * nothing to mis-parse. A text file has syntax - comments, blank lines, whitespace - and every one
 * of those is a new way for an entry to mean something other than what it looks like.
 *
 * WHY THIS IS SEPARATE FROM THE CHAIN'S OWN CHECKS. `smoke:gate-inventory` grades the chain's
 * CONTENT: that every entry resolves to a defined script, that nothing is duplicated, that it is
 * not empty. Those checks pass against a parser that mishandles all three shapes below, because
 * the real chain file currently contains no comment, no blank line and no trailing space - so the
 * first person to add one is the person who finds out. Proving the migration preserved the chain
 * proves nothing about the parser, since the proof ran on a well-formed file.
 *
 * THE EMPTY CASE IS THE LOAD-BEARING ONE. The chain-level guard says "a chain of fewer than two
 * suites fails". That is only true if an empty chain cannot be produced SILENTLY - so a missing or
 * unreadable file must throw at the reader rather than return `[]` and let the guard decide. Which
 * of the two fires is asserted here rather than left as a property nobody wrote down.
 *
 * Run: pnpm smoke:ci-suites
 */
import { join } from "node:path";
// @ts-expect-error - plain .mjs helper, the one parser shared by shard.mjs and gate-inventory.
import { parseCiSuites, readCiSuites, CI_SUITES_PATH } from "./ci-suites.mjs";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const parse = (raw: string): string[] | string => {
  try {
    return parseCiSuites(raw, "<fixture>") as string[];
  } catch (e) {
    return `THREW: ${(e as Error).message}`;
  }
};
const same = (a: unknown, b: string[]) => JSON.stringify(a) === JSON.stringify(b);

console.log("ci-suites: the chain file's parser");

// ---- Comments and blanks are removed, and are NOT entries --------------------------------------
const withNoise = ["# a heading", "", "smoke:alpha", "   ", "# trailing note", "smoke:beta", ""].join("\n");
check(
  "comments and blank lines are dropped, and the entries survive in order",
  same(parse(withNoise), ["smoke:alpha", "smoke:beta"]),
  parse(withNoise),
);
// A whitespace-only line trimmed to "" must be dropped as blank, not fall through to the name test.
check("a whitespace-only line is a blank, not a malformed entry", !String(parse("   \nsmoke:a")).startsWith("THREW"));
// An indented comment is still a comment.
check("an indented comment is still a comment", same(parse("   # note\nsmoke:a"), ["smoke:a"]));

// ---- Trailing whitespace NORMALISES: one obvious meaning, so trimming cannot pick a wrong one ---
check("a trailing space on an entry is trimmed, not carried into the script name", same(parse("smoke:a  "), ["smoke:a"]));
check("a leading space on an entry is trimmed", same(parse("  smoke:a"), ["smoke:a"]));
check("a carriage return does not survive into the name", same(parse("smoke:a\r\nsmoke:b"), ["smoke:a", "smoke:b"]));

// ---- A `pnpm ` prefix REFUSES: every line of the old chain looked like this ---------------------
const pnpmPrefixed = parse("smoke:a\npnpm smoke:b");
check(
  "a copied-in `pnpm smoke:x` line is refused, not silently run as a script of that name",
  String(pnpmPrefixed).startsWith("THREW"),
  pnpmPrefixed,
);
check("the refusal says what to do about it", /drop the `pnpm ` prefix/.test(String(pnpmPrefixed)), pnpmPrefixed);
check("the refusal names the line number", /<fixture>:2:/.test(String(pnpmPrefixed)), pnpmPrefixed);

// ---- Anything else that is not a script name refuses, with its line ------------------------------
for (const bad of ["not-a-suite", "smoke:", "check", "&& pnpm smoke:a", "smoke:a && smoke:b"]) {
  check(`a line that is not a smoke script name is refused: ${JSON.stringify(bad)}`, String(parse(bad)).startsWith("THREW"));
}
// A malformed line must NOT be skipped: a chain that silently drops what it could not parse runs
// fewer suites than it prints, which is the failure this whole migration is downstream of.
check(
  "a malformed line aborts the parse rather than being skipped",
  String(parse("smoke:a\nnonsense\nsmoke:b")).startsWith("THREW"),
);

// ---- Empty must not be producible silently -----------------------------------------------------
// A file of only comments parses to [] legitimately - that is the chain-level guard's business.
check("a file of only comments parses to an empty list", same(parse("# nothing here\n\n"), []));
// But a MISSING file must throw at the reader. If this returned [] instead, the chain-level
// "cannot be empty" check would be reporting a policy failure for what is actually a missing file,
// and a `smoke:ci` pointed at nothing would look like a chain someone emptied on purpose.
let missingThrew = false;
try {
  readCiSuites(join(String(CI_SUITES_PATH), "..", "no-such-chain-file.txt"));
} catch {
  missingThrew = true;
}
check("a MISSING chain file throws at the reader rather than yielding an empty chain", missingThrew);

// ---- The real file is parsed by this same parser ------------------------------------------------
const real = readCiSuites() as string[];
check("the real chain file parses, and holds more than one suite", Array.isArray(real) && real.length > 1, real.length);

const EXPECTED = 18;
check(
  `every cell ran - ${EXPECTED} expected, so a cell that stops existing is not mistaken for one that passed`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
