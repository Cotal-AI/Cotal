/** Coverage-accounting controls; the load harness supplies native received and published IDs. */
import assert from "node:assert/strict";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { deliveryCoverage } from "./_delivery-coverage.js";

let passed = 0;
function check(name: string, run: () => void): void {
  run();
  passed++;
  console.log(`  ✓ ${name}`);
}
check("all acknowledged IDs are covered", () => {
  assert.deepEqual(deliveryCoverage(["a", "b"], new Map([["a", 1], ["b", 1]])),
    { expected: 2, distinct: 2, missing: 0, unexpected: 0, repeated: 0 });
});
check("equal totals cannot hide a missing ID behind a repeated copy", () => {
  assert.deepEqual(deliveryCoverage(["a", "b"], new Map([["a", 2]])),
    { expected: 2, distinct: 1, missing: 1, unexpected: 0, repeated: 1 });
});
check("complete at-least-once delivery retains its repeated-copy count", () => {
  assert.deepEqual(deliveryCoverage(["a", "b"], new Map([["a", 3], ["b", 1]])),
    { expected: 2, distinct: 2, missing: 0, unexpected: 0, repeated: 2 });
});
check("unexpected IDs do not replace missing acknowledged IDs", () => {
  assert.deepEqual(deliveryCoverage(["a"], new Map([["other", 1]])),
    { expected: 1, distinct: 1, missing: 1, unexpected: 1, repeated: 0 });
});
check("an empty recipient has every expected ID missing", () => {
  assert.equal(deliveryCoverage(["a", "b"], new Map()).missing, 2);
});
check("the poster expects no durable self-delivery", () => {
  assert.equal(deliveryCoverage([], new Map([["a", 1]])).unexpected, 1);
  assert.deepEqual(deliveryCoverage([], new Map()), { expected: 0, distinct: 0, missing: 0, unexpected: 0, repeated: 0 });
});
check("one recipient's repeats cannot satisfy another recipient's omissions", () => {
  const left = deliveryCoverage(["a"], new Map([["a", 2]]));
  const right = deliveryCoverage(["a"], new Map());
  assert.equal(left.missing + right.missing, 1);
  assert.equal(left.repeated + right.repeated, 1);
});
check("publish-ID collisions refuse instead of shrinking the expectation", () => {
  assert.throws(() => deliveryCoverage(["a", "a"], new Map([["a", 2]])), /publish IDs must be unique/);
});
assert.equal(passed, 8);
emitSentinel({ passed, failed: 0 });
