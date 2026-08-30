/**
 * `shard.mjs` breaks at its first red, and the plan it prints at startup does not say which of
 * itself never got a banner. `neverRanBlock` is the computation shard.mjs calls at the break
 * point to say so explicitly - see bin/smoke/shard-never-ran.mjs for why that has to be the
 * shard's own statement rather than something reconstructed later from its two other statements.
 *
 * Run: pnpm smoke:shard-never-ran
 */
// @ts-expect-error - plain .mjs helper, imported by bin/smoke/shard.mjs.
import { neverRanBlock } from "./shard-never-ran.mjs";

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

console.log("shard-never-ran: the never-ran census a shard prints at its break point");

const mine = ["pnpm smoke:a", "pnpm smoke:b", "pnpm smoke:c", "pnpm smoke:d", "pnpm smoke:e"];

// ---- Failure mid-partition: everything after it is named, nothing before it is ------------------
const midBlock = neverRanBlock(mine, 1);
check("a mid-partition failure reports a non-empty block", midBlock !== "");
check("the block names the exact count that never ran", /\b3 of 5\b/.test(midBlock), midBlock);
check("every suite after the failure is named", ["smoke:c", "smoke:d", "smoke:e"].every((s) => midBlock.includes(s)), midBlock);
check("the failed suite itself is not named as never-ran", !midBlock.includes("smoke:b"), midBlock);
check("a suite before the failure is not named as never-ran", !midBlock.includes("smoke:a"), midBlock);
check(
  "the never-ran suites stay in their original execution order",
  midBlock.indexOf("smoke:c") < midBlock.indexOf("smoke:d") && midBlock.indexOf("smoke:d") < midBlock.indexOf("smoke:e"),
  midBlock,
);

// ---- Failure on the partition's LAST entry: nothing was left, so there is nothing to say --------
const lastBlock = neverRanBlock(mine, mine.length - 1);
check("a failure on the last entry of the partition reports nothing (there is nothing behind it)", lastBlock === "", lastBlock);

// ---- Failure on the FIRST entry: everything else in the partition never ran ----------------------
const firstBlock = neverRanBlock(mine, 0);
check(
  "a failure on the first entry reports every other suite in the partition as never-ran",
  /\b4 of 5\b/.test(firstBlock) && ["smoke:b", "smoke:c", "smoke:d", "smoke:e"].every((s) => firstBlock.includes(s)),
  firstBlock,
);

// ---- A partition of one: a failure there has nothing after it, same as the last-entry case -------
check("a single-suite partition's only failure reports nothing", neverRanBlock(["pnpm smoke:solo"], 0) === "");

const EXPECTED = 9;
check(
  `every cell ran - ${EXPECTED} expected, so a cell that stops existing is not mistaken for one that passed`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
