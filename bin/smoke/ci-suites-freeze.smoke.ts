/**
 * The freeze on `bin/smoke/ci-suites.txt` is a sentence in a comment. Since it landed, main has
 * appended to that list anyway. A tail append looks correct, is shard-stable, and passes every
 * existing gate. The cost is a CONFLICTING PR for someone else, which GitHub will not build, so
 * that branch also gets zero CI.
 *
 * This suite grades the scan in `ci-suites.mjs`, not a copy of the rule. The positive control
 * appends a suite line onto the real file and asserts the SET of names the scan returns.
 * The required unit job reaches the same scan through `pnpm check:shard-stability`.
 *
 * Run: pnpm smoke:ci-suites-freeze
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { addedLegacySuites, fragmentFileName, parseCiSuites, CI_SUITES_PATH } from "./ci-suites.mjs";

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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("ci-suites-freeze: added names on the frozen list");

const real = readFileSync(CI_SUITES_PATH, "utf8");
const control = "smoke:ci-suites-freeze-control";
if (real.split("\n").some((line) => line.trim() === control)) {
  throw new Error(`${CI_SUITES_PATH} already names ${control}; pick another control suite`);
}
const withNewline = real.endsWith("\n") ? real : `${real}\n`;

check(
  "identical frozen files add no suite names",
  same(addedLegacySuites(real, real), []),
  addedLegacySuites(real, real),
);

check(
  "a comment-only edit of the frozen file adds no suite names",
  same(addedLegacySuites(real, `${withNewline}# freeze note only\n`), []),
  addedLegacySuites(real, `${withNewline}# freeze note only\n`),
);

const legacy = parseCiSuites(real) as string[];
if (legacy.length < 2) throw new Error(`${CI_SUITES_PATH} parsed to fewer than two suites`);
const last = legacy[legacy.length - 1];
const deleted = withNewline
  .split("\n")
  .filter((line) => line.trim() !== last)
  .join("\n");
check(
  "deleting a frozen suite adds no suite names",
  same(addedLegacySuites(real, deleted), []),
  addedLegacySuites(real, deleted),
);

const appended = `${withNewline}${control}\n`;
check(
  "an appended suite is named as the set of offenders",
  same(addedLegacySuites(real, appended), [control]),
  addedLegacySuites(real, appended),
);

const firstSuite = legacy[0];
const inserted = withNewline.replace(`${firstSuite}\n`, `${firstSuite}\n${control}\n`);
check(
  "a mid-file insert is named as the set of offenders",
  same(addedLegacySuites(real, inserted), [control]),
  addedLegacySuites(real, inserted),
);

const second = "smoke:ci-suites-freeze-control-b";
check(
  "two appended suites are both named",
  same(addedLegacySuites(real, `${appended}${second}\n`), [control, second]),
  addedLegacySuites(real, `${appended}${second}\n`),
);

const expectedFragment = fragmentFileName(control);
check(
  "the named fragment for an added suite is a 64-hex digest of the public script name",
  /^[0-9a-f]{64}\.txt$/.test(expectedFragment),
  expectedFragment,
);
check(
  "two different suite names cannot share a fragment path",
  fragmentFileName("smoke:other") !== expectedFragment,
);

const base = process.env.BASE;
const head = process.env.HEAD;
if (base && head) {
  const show = (sha: string): string =>
    execFileSync("git", ["--no-replace-objects", "show", `${sha}:bin/smoke/ci-suites.txt`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  let live: string[] | string;
  try {
    live = addedLegacySuites(show(base), show(head), `ci-suites.txt@${base}`, `ci-suites.txt@${head}`);
  } catch (error) {
    live = `THREW: ${(error as Error).message}`;
  }
  const offenders = Array.isArray(live) ? live : [];
  check(
    "the committed frozen list added no suite names versus base",
    Array.isArray(live) && offenders.length === 0,
    Array.isArray(live)
      ? offenders.map((suite) => `${suite} -> bin/smoke/ci-suites.d/${fragmentFileName(suite)}`).join(", ")
      : live,
  );
}

const EXPECTED = base && head ? 9 : 8;
check(
  `every cell ran - ${EXPECTED} expected, so a cell that stops existing is not mistaken for one that passed`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`CI SUITES FREEZE SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
