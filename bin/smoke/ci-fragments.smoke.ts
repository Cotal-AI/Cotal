/**
 * The merge-safe half of the CI suite registry: one suite per file, deterministic reads, stable
 * shard assignment, and simultaneous independent additions that Git merges without a driver.
 *
 * Run: pnpm smoke:ci-fragments
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fragmentShard, readCiSuiteFragments, suitesForShard } from "./ci-suites.mjs";

let passed = 0;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

const fixture = mkdtempSync(join(tmpdir(), "cotal-ci-fragments-"));
try {
  writeFileSync(join(fixture, "z-last.txt"), "# z\nsmoke:z-last\n");
  writeFileSync(join(fixture, "a-first.txt"), "smoke:a-first\n");
  check(
    "fragment files are read deterministically by filename",
    JSON.stringify(readCiSuiteFragments(fixture)) === JSON.stringify(["smoke:a-first", "smoke:z-last"]),
  );
  writeFileSync(join(fixture, "empty.txt"), "# no suite\n");
  assert.throws(() => readCiSuiteFragments(fixture), /exactly one smoke script, got 0/);
  passed++; console.log("  ✓ an empty fragment is refused");
  rmSync(join(fixture, "empty.txt"));
  writeFileSync(join(fixture, "two.txt"), "smoke:one\nsmoke:two\n");
  assert.throws(() => readCiSuiteFragments(fixture), /exactly one smoke script, got 2/);
  passed++; console.log("  ✓ a multi-suite fragment is refused");
  rmSync(join(fixture, "two.txt"));

  const suite = "smoke:stable-fragment";
  const shard = fragmentShard(suite, 4);
  check("a fragment suite has a valid stable four-shard assignment", shard >= 0 && shard < 4);
  check(
    "adding another fragment before it cannot move an existing suite to another shard",
    suitesForShard([], [suite], shard, 4).includes(suite) &&
      suitesForShard([], ["smoke:sorts-before", suite], shard, 4).includes(suite),
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

const mergeRoot = mkdtempSync(join(tmpdir(), "cotal-ci-fragment-merge-"));
try {
  mkdirSync(join(mergeRoot, "bin/smoke/ci-suites.d"), { recursive: true });
  writeFileSync(join(mergeRoot, "bin/smoke/ci-suites.d/base.txt"), "smoke:base\n");
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: mergeRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "CI fragments smoke"]);
  git(["config", "user.email", "ci-fragments@example.invalid"]);
  git(["add", "."]); git(["commit", "-qm", "base"]); git(["branch", "incoming"]);
  writeFileSync(join(mergeRoot, "bin/smoke/ci-suites.d/main.txt"), "smoke:main\n");
  git(["add", "."]); git(["commit", "-qm", "main addition"]); git(["branch", "main-side"]);
  git(["checkout", "-q", "incoming"]);
  writeFileSync(join(mergeRoot, "bin/smoke/ci-suites.d/branch.txt"), "smoke:branch\n");
  git(["add", "."]); git(["commit", "-qm", "branch addition"]);
  git(["merge", "main-side", "--no-edit"]);
  check(
    "simultaneous additions on distinct fragment paths merge cleanly with the standard driver",
    git(["status", "--short"]) === "" &&
      git(["ls-files", "bin/smoke/ci-suites.d/*.txt"]).split("\n").length === 3,
  );
} finally {
  rmSync(mergeRoot, { recursive: true, force: true });
}

const EXPECTED = 6;
check(`every cell ran (${EXPECTED} before the sentinel)`, passed === EXPECTED);
console.log(`CI FRAGMENTS SMOKE OK (${passed} passed)`);
