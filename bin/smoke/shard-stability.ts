/**
 * shard-stability.check.ts — does a commit RE-SHARD the smoke chain?
 *
 * WHY THIS EXISTS. `bin/smoke/ci-suites.txt` is consumed by `shard.mjs` as round-robin
 * `index % count`. Inserting a line mid-file therefore moves every suite below it to a
 * DIFFERENT RUNNER, while membership, count, and duplicate checks all stay green.
 *
 * `smoke:gate-inventory` checks membership, duplicates, and non-emptiness. It does NOT
 * check ORDER. That is the invariant that actually failed in production:
 *
 *   7837b64c -> d1aeafc3   a two-line PURE REORDER (387 -> 387, added 0, removed 0)
 *   moved 263 of 387 suites to a different shard at the 4-shard config CI runs.
 *
 * The observed consequence: the same two deterministic failures appeared on different
 * shards across runs, and a reviewer was one step from filing CI non-determinism against
 * a system behaving perfectly. There was no flakiness. The registry was edited between
 * observations.
 *
 *   smoke:artifact-store     idx 234 -> 232   shard 2 -> 0   (matched live CI)
 *   smoke:cross-path-dedup   idx 179 -> 177   shard 3 -> 1   (matched live CI)
 *
 * NOTE THE EVIDENCE CLASS: this static computation predicted a remote runner's observed
 * behaviour on two independent data points. A model agreeing with itself proves nothing.
 *
 * USAGE:  pnpm check:shard-stability <base-sha> <head-sha> [shardCount=4]
 * Run from inside a worktree of the repo. Exits 1 if any pre-existing suite changes shard.
 *
 * CONTROLS BUILT IN, because a bare zero is not evidence:
 *   - a forced mid-file insert must report non-zero (instrument responds at all)
 *   - identity (base vs base) must report 0
 */
import { execFileSync } from "node:child_process";

const [, , base, head, countArg] = process.argv;
if (!base || !head) {
  console.error("usage: check:shard-stability <base-sha> <head-sha> [shardCount=4]");
  process.exit(2);
}
// THE SHARD COUNT IS READ FROM ci.yml, NOT DEFAULTED TO A LITERAL.
// Found by pr-review: the tool used to default to 4 while `.github/workflows/ci.yml`
// independently declared `shard: [0,1,2,3]`. They agreed, and nothing enforced that they
// keep agreeing — so a workflow change to 5 runners would leave this confidently
// answering for a topology CI no longer runs. That is this fold's own headline defect
// (an invariant living in a comment and a default value, enforced by nothing) reproduced
// inside the detector built to catch it.
const ciShardCount = (sha: string): number | null => {
  let yml: string;
  try {
    yml = execFileSync("git", ["show", `${sha}:.github/workflows/ci.yml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const m = yml.match(/shard:\s*\[([0-9,\s]+)\]/);
  if (!m) return null;
  return m[1].split(",").filter((s) => s.trim().length > 0).length;
};

const declared = ciShardCount(head);
const COUNT = countArg !== undefined ? Number(countArg) : (declared ?? 4);
if (!Number.isInteger(COUNT) || COUNT < 1) {
  console.error(`ABORT: shard count must be a positive integer, got '${countArg}'`);
  process.exit(2);
}
if (declared === null) {
  console.error(`ABORT: cannot read the shard matrix from .github/workflows/ci.yml at '${head}'; refusing to guess the topology`);
  process.exit(2);
}
if (COUNT !== declared) {
  console.error(`ABORT: shard count ${COUNT} disagrees with ci.yml's matrix of ${declared} at '${head}'.`);
  console.error(`       A verdict for a topology CI does not run is worse than no verdict.`);
  process.exit(2);
}
console.log(`shard count ${COUNT}, read from ci.yml at ${head.slice(0, 8)}`);

const read = (sha: string): string[] => {
  // EXIT 2, NOT 1, when the input cannot be read. Exit 1 means "re-shard detected";
  // a bad sha must not be indistinguishable from a real defect, or a CI job wiring
  // this in reports a typo as a production finding. Found by pr-review, who fed it a
  // bogus sha and got exit 1 where the README promised 2.
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${sha}:bin/smoke/ci-suites.txt`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error(`ABORT: cannot read bin/smoke/ci-suites.txt at '${sha}' (bad sha, or not a worktree of this repo)`);
    process.exit(2);
  }
  const list = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (list.length === 0) {
    console.error(`ABORT: chain at '${sha}' parsed to 0 suites; refusing to compare an empty chain`);
    process.exit(2);
  }
  return list;
};

const shardOf = (list: string[]) => {
  const m = new Map<string, number>();
  list.forEach((s, i) => { if (!m.has(s)) m.set(s, i % COUNT); });
  return m;
};

const moved = (a: string[], b: string[]): string[] => {
  const sa = shardOf(a), sb = shardOf(b);
  return [...sa.keys()].filter((s) => sb.has(s) && sa.get(s) !== sb.get(s));
};

const A = read(base), B = read(head);
const changed = moved(A, B);

// --- controls, printed before the verdict ---
const forced = moved(A, [...A.slice(0, 10), "smoke:FORCED-CONTROL", ...A.slice(10)]);
const identity = moved(A, A);
console.log(`CONTROL forced mid-file insert -> ${forced.length} moved  (must be > 0)`);
console.log(`CONTROL identity               -> ${identity.length} moved  (must be 0)`);
if (forced.length === 0 || identity.length !== 0) {
  console.error("ABORT: controls failed, this run cannot be trusted");
  process.exit(2);
}

const added = B.filter((s) => !A.includes(s));
const removed = A.filter((s) => !B.includes(s));
console.log(`\n${base.slice(0, 8)} -> ${head.slice(0, 8)}  @${COUNT} shards`);
console.log(`  suites: ${A.length} -> ${B.length} · added ${added.length} · removed ${removed.length}`);
console.log(`  pre-existing suites CHANGING SHARD: ${changed.length} of ${A.length}`);
if (changed.length > 0) {
  console.log(`  first few: ${changed.slice(0, 5).join(", ")}`);
  console.error(`\nRE-SHARD DETECTED. Append new suites at the END of ci-suites.txt.`);
  process.exit(1);
}
console.log(`\nSTABLE — no pre-existing suite changes runner.`);
