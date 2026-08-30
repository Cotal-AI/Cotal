/**
 * The merge-safe half of the CI suite registry: one suite per file, deterministic reads, stable
 * shard assignment, and simultaneous independent additions that Git merges without a driver.
 *
 * Run: pnpm smoke:ci-fragments
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fragmentShard, readCiSuiteFragments, suitesForShard } from "./ci-suites.mjs";

let passed = 0, failed = 0;
const check = (name: string, condition: unknown) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`); }
};

const fixture = mkdtempSync(join(tmpdir(), "cotal-ci-fragments-"));
try {
  const fileFor = (suite: string) => `${createHash("sha256").update(suite).digest("hex")}.txt`;
  writeFileSync(join(fixture, fileFor("smoke:z-last")), "# z\nsmoke:z-last\n");
  writeFileSync(join(fixture, fileFor("smoke:a-first")), "smoke:a-first\n");
  const firstRead = readCiSuiteFragments(fixture);
  check(
    "fragment files are read deterministically by filename",
    JSON.stringify(firstRead) === JSON.stringify(readCiSuiteFragments(fixture)) &&
      [...firstRead].sort().join(",") === "smoke:a-first,smoke:z-last",
  );
  writeFileSync(join(fixture, "empty.txt"), "# no suite\n");
  let emptyRefused = false;
  try { readCiSuiteFragments(fixture); } catch (error) { emptyRefused = /exactly one smoke script, got 0/.test(String(error)); }
  check("an empty fragment is refused", emptyRefused);
  rmSync(join(fixture, "empty.txt"));
  writeFileSync(join(fixture, "two.txt"), "smoke:one\nsmoke:two\n");
  let multiRefused = false;
  try { readCiSuiteFragments(fixture); } catch (error) { multiRefused = /exactly one smoke script, got 2/.test(String(error)); }
  check("a multi-suite fragment is refused", multiRefused);
  rmSync(join(fixture, "two.txt"));
  writeFileSync(join(fixture, "human-topic.txt"), "smoke:human-topic\n");
  let filenameRefused = false;
  try { readCiSuiteFragments(fixture); } catch (error) { filenameRefused = /fragment filename must be sha256/.test(String(error)); }
  check("a hand-chosen shared fragment filename is refused", filenameRefused);
  rmSync(join(fixture, "human-topic.txt"));

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
  const fileFor = (suite: string) => `${createHash("sha256").update(suite).digest("hex")}.txt`;
  writeFileSync(join(mergeRoot, "bin/smoke/ci-suites.d", fileFor("smoke:base")), "smoke:base\n");
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: mergeRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(["init", "-q"]);
  git(["config", "user.name", "CI fragments smoke"]);
  git(["config", "user.email", "ci-fragments@example.invalid"]);
  git(["add", "."]); git(["commit", "-qm", "base"]); git(["branch", "incoming"]);
  writeFileSync(join(mergeRoot, "bin/smoke/ci-suites.d", fileFor("smoke:main")), "smoke:main\n");
  git(["add", "."]); git(["commit", "-qm", "main addition"]); git(["branch", "main-side"]);
  git(["checkout", "-q", "incoming"]);
  writeFileSync(join(mergeRoot, "bin/smoke/ci-suites.d", fileFor("smoke:branch")), "smoke:branch\n");
  git(["add", "."]); git(["commit", "-qm", "branch addition"]);
  const merged = spawnSync("git", ["merge", "main-side", "--no-edit"], { cwd: mergeRoot, encoding: "utf8" });
  check(
    "simultaneous additions on distinct fragment paths merge cleanly with the standard driver",
    merged.status === 0 && git(["status", "--short"]) === "" &&
      git(["ls-files", "bin/smoke/ci-suites.d/*.txt"]).split("\n").length === 3,
  );
} finally {
  rmSync(mergeRoot, { recursive: true, force: true });
}

const EXPECTED = 7;
check(`every cell ran (${EXPECTED} before the sentinel)`, passed + failed === EXPECTED);
console.log(`CI FRAGMENTS SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
if (failed) process.exitCode = 1;
