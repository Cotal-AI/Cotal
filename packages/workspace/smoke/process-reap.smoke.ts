import { strict as assert } from "node:assert";
import { inspectProcessIdentity, reapProcess, type PosixProcessIdentity } from "../src/process-reap.js";

const locator: PosixProcessIdentity = { pid: 123, startToken: "old", killScope: "process-group" };
assert.equal(inspectProcessIdentity(locator, { liveness: () => "dead" }), "gone");
assert.equal(inspectProcessIdentity(locator, { liveness: () => "unknown" }), "unknown");
assert.equal(inspectProcessIdentity(locator, { liveness: () => "alive", startToken: () => undefined }), "unknown");
assert.equal(inspectProcessIdentity(locator, { liveness: () => "alive", startToken: () => "new" }), "reused");
assert.equal(inspectProcessIdentity(locator, { liveness: () => "alive", startToken: () => "old" }), "matching");

let signalled = false;
await reapProcess(locator, {
  liveness: () => "alive",
  startToken: () => "new",
  signaler: () => { signalled = true; },
});
assert.equal(signalled, false, "a reused PID is never signalled");

let alive = true;
let target: number | undefined;
await reapProcess(locator, {
  liveness: () => alive ? "alive" : "dead",
  startToken: () => "old",
  signaler: (pid) => { target = pid; alive = false; },
  timeoutMs: 20,
  pollMs: 1,
});
assert.equal(target, -123, "process-group locators signal the negative PID");

await assert.rejects(() => reapProcess(locator, {
  liveness: () => "alive", startToken: () => undefined, signaler: () => assert.fail("must not signal unknown identity"),
}), /identity is unknown/);

console.log("process reap smoke passed");
