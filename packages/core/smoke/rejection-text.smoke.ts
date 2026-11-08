/**
 * One caught-value coercion and one cleanup recorder, imported from core's source.
 * A plain object keeps its message, a value that cannot be read becomes the fixed
 * sentence, and a thrown cleanup step is recorded without skipping the next one.
 *
 * Run: pnpm smoke:rejection-text
 */
import assert from "node:assert/strict";
import { attemptCleanup, describeCleanupFailures, rejectionText } from "../src/rejection-text.js";

const poisoned = {
  get message(): string { throw new Error("poisoned getter"); },
  toString(): string { throw new Error("poisoned toString"); },
};

assert.equal(rejectionText(new Error("boom")), "boom");
assert.equal(rejectionText({ message: "from a plain object" }), "from a plain object");
assert.equal(rejectionText("a string rejection"), "a string rejection");
assert.equal(rejectionText(null), "null");
assert.equal(rejectionText(undefined), "undefined");
assert.equal(rejectionText(42), "42");
assert.equal(rejectionText(poisoned), "an unreadable rejection");
assert.equal(rejectionText(Symbol("no")), "Symbol(no)");

const failed: { step: string; err: unknown }[] = [];
await attemptCleanup(failed, "actor token file", async () => { throw new Error("EACCES"); });
await attemptCleanup(failed, "health file", async () => {});
assert.equal(failed.length, 1);
assert.equal(failed[0]?.step, "actor token file");
assert.equal(failed[0]?.err instanceof Error ? failed[0].err.message : "", "EACCES");
assert.equal(describeCleanupFailures(failed), "actor token file: EACCES");
assert.deepEqual(failed.map((f) => f.step), ["actor token file"]);

const both: { step: string; err: unknown }[] = [];
await attemptCleanup(both, "secret /x/actor", async () => { throw new Error("EACCES"); });
await attemptCleanup(both, "broker teardown", async () => { throw poisoned; });
assert.equal(describeCleanupFailures(both), "secret /x/actor: EACCES; broker teardown: an unreadable rejection");

console.log("rejection-text smoke: one coercion and one recorder");
