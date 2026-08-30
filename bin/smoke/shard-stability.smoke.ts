/** Frozen legacy suites must keep exact indices; whole-shard moves cannot hide behind modulo. */
import { changedSuiteIndices } from "./shard-stability.mjs";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const base = Array.from({ length: 41 }, (_, index) => `smoke:position-${index}`);
const insertAt = 13;
const additions = Array.from({ length: 4 }, (_, index) => `smoke:insert-${index}`);
const inserted = [...base.slice(0, insertAt), ...additions, ...base.slice(insertAt)];
const insertion = changedSuiteIndices(base, inserted) as { changed: string[]; examined: number };
check(
  "a mid-file whole-shard insert reports every frozen suite whose index changed",
  insertion.changed.length === base.length - insertAt,
  insertion,
);
check("the whole-shard property examined every frozen suite", insertion.examined === base.length, insertion);

const tail = changedSuiteIndices(base, [...base, "smoke:tail"]) as { changed: string[]; examined: number };
check("a fragment-style addition changes no frozen legacy index", tail.changed.length === 0, tail);
check("the addition control examined every frozen suite", tail.examined === base.length, tail);

const removed = changedSuiteIndices(base, base.slice(1)) as { changed: string[]; examined: number };
check("removing a frozen suite moves every surviving legacy index", removed.changed.length === base.length - 1, removed);
check("the removed suite is absent from the examined count", removed.examined === base.length - 1, removed);

const EXPECTED = 6;
check(`every cell ran (${EXPECTED} before sentinel)`, pass + fail === EXPECTED);
console.log(`SHARD INDEX SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
