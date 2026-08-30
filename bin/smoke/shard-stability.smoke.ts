/**
 * The shard-stability gate must defend the registry's actual invariant: every pre-existing suite
 * keeps its parsed index. Comparing only `index % shardCount` misses moves by a whole shard count.
 *
 * Run: pnpm smoke:shard-stability
 */
import { createHash } from "node:crypto";
// @ts-expect-error - plain .mjs helpers shared with the production checker.
import { parseCiSuites } from "./ci-suites.mjs";
// @ts-expect-error - plain .mjs helper shared with the production checker.
import { changedSuiteIndices } from "./shard-stability.mjs";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

console.log("shard-stability: exact parsed-index invariant");

const baseRaw = Array.from({ length: 41 }, (_, index) =>
  `${index % 5 === 0 ? `# suite ${index}\n` : ""}smoke:position-${index}`
).join("\n");
const base = parseCiSuites(baseRaw, "<base>") as string[];
const seed = createHash("sha256").update(base.join("\n")).digest().readUInt32BE(0);
const insertAt = 1 + seed % (base.length - 1);
const additions = Array.from({ length: 4 }, (_, index) => `smoke:insert-${index}`);
const inserted = [...base.slice(0, insertAt), ...additions, ...base.slice(insertAt)];
const insertionResult = changedSuiteIndices(base, inserted) as { changed: string[]; examined: number };

check(
  "a mid-file whole-shard insert reports every pre-existing suite whose index changed",
  insertionResult.changed.length === base.length - insertAt,
  `inserted at ${insertAt}; ${insertionResult.changed.length} changed of ${base.length - insertAt} expected`,
);
check(
  "the mid-file property examined every pre-existing suite",
  insertionResult.examined === base.length,
  `${insertionResult.examined} examined of ${base.length}`,
);

const tailResult = changedSuiteIndices(base, [...base, "smoke:tail"]) as {
  changed: string[];
  examined: number;
};
check("a true tail append changes no pre-existing index", tailResult.changed.length === 0);
check(
  "the tail control also examined every pre-existing suite",
  tailResult.examined === base.length,
  `${tailResult.examined} examined of ${base.length}`,
);

const removedResult = changedSuiteIndices(base, base.slice(1)) as { changed: string[]; examined: number };
check("a deletion reports the surviving suites whose indices changed", removedResult.changed.length === base.length - 1);
check(
  "a removed suite is not counted as examined",
  removedResult.examined === base.length - 1,
  `${removedResult.examined} examined of ${base.length - 1}`,
);

const EXPECTED = 6;
check(
  `every cell ran - ${EXPECTED} expected, so a missing property is not mistaken for a pass`,
  pass + fail === EXPECTED,
  `${pass + fail} cells reported`,
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
