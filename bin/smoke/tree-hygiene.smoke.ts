/**
 * No scratch command output is tracked in the repository.
 *
 * `.gitignore` carries `*.out`, which stops an UNTRACKED file being added by accident. It has no
 * effect on a file that is already tracked, so a branch that committed its transcripts before that
 * rule existed still carries them, and merging that branch puts them back on main. That happened
 * four times in one day (#1122 removed five, #1056 restored them, #1125 removed them, #1042 restored
 * them), which is why this is a gate rather than another deletion.
 *
 * Run: pnpm smoke:tree-hygiene
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0, failed = 0;
const check = (name: string, condition: unknown, actual?: unknown) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, actual === undefined ? "" : actual); }
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Command transcripts written into the working tree by a fold or build routine. Two producer
 * families have been seen (`.refold*.out`, `.lane/*.out`); the extension is the property they share
 * and is what `.gitignore` matches, so it is what this gate matches too. */
const SCRATCH = /\.out$/;

const tracked = git(["ls-files"]).split("\n").filter(Boolean);

// Positive control on the instrument before believing its zero: a search of the wrong universe
// returns nothing and is indistinguishable from a real absence.
check(
  "the tracked-file listing is a plausible universe, so an empty match means absence rather than a broken read",
  tracked.length > 500 && tracked.includes("package.json"),
  { trackedFiles: tracked.length },
);

// Positive control on the PATTERN, against literals rather than the tree, so this cell keeps
// discriminating after the tree is clean.
check(
  "the pattern matches the shapes both producer families write, and spares ordinary sources",
  [".refold2-build.out", ".refold-tc.out", ".lane/guard-baseline.out"].every((p) => SCRATCH.test(p)) &&
    ![".gitignore", "package.json", "bin/smoke/tree-hygiene.smoke.ts", "docs/README.md"].some((p) => SCRATCH.test(p)),
);

const offenders = tracked.filter((p) => SCRATCH.test(p));
check(
  `no scratch command output is tracked (scanned ${tracked.length} tracked files)`,
  offenders.length === 0,
  offenders,
);

// The untracked half. Removing the files without this rule is what let them come back twice.
check(
  "`.gitignore` still refuses NEW scratch output, which tracking cannot be relied on to cover",
  readFileSync(join(root, ".gitignore"), "utf8").split("\n").includes("*.out"),
);

const EXPECTED = 4;
check(`every cell ran (${EXPECTED} before the sentinel)`, passed + failed === EXPECTED);
console.log(`TREE HYGIENE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
if (failed) process.exitCode = 1;
