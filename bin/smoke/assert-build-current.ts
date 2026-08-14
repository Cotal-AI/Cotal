#!/usr/bin/env -S node --import tsx
/**
 * CLI front end for the stale-build refusal, so a shell suite can call it as its first action.
 *
 * Exit codes are DISTINCT ON PURPOSE:
 *   0  — every named package's build is current
 *   94 — REFUSED: a build is stale / never-built / has no source
 *   95 — the guard itself could not run (bad usage, unreadable tree, internal error)
 *
 * 94 and 95 are separated because the first inline version of this guard was an `import` inside
 * `tsx -e`, which does not resolve `.js` to `.ts`. It exited non-zero and the caller printed
 * "REFUSING TO MEASURE: stale build" — naming a condition that had not been established. A guard
 * that reports the wrong reason for stopping is the same defect it exists to catch, one level up.
 *
 * Both non-zero codes stop the suite. Only 94 is a claim about the build.
 */
import { assertBuildCurrent } from "./_build-current.js";

const dirs = process.argv.slice(2);
try {
  if (dirs.length === 0) {
    console.error("assert-build-current: usage: assert-build-current.ts <pkgDir> [pkgDir...]");
    process.exit(95);
  }
  assertBuildCurrent(dirs);
} catch (e) {
  const msg = (e as Error).message;
  // Only a verdict from the checker itself is a build claim. Anything else is a broken guard.
  const isBuildVerdict = msg.startsWith("REFUSING TO MEASURE:") || msg.startsWith("assertBuildCurrent: REFUSING");
  console.error(msg);
  process.exit(isBuildVerdict ? 94 : 95);
}
console.log(`  build-current: ${dirs.length} package(s) current`);
