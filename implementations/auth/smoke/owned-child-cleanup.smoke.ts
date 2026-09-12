/** Executable control for fail-closed exact-child probe cleanup. */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { spawn } from "node:child_process";
import { stopOwnedChild } from "./_owned-child-cleanup.js";
const { assert, cells } = countedAssert(nodeAssert);

const stubborn = spawn(process.execPath, ["-e", `
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  process.stdout.write("ready\\n");
`], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise<void>((resolve, reject) => {
  stubborn.once("error", reject);
  stubborn.stdout!.once("data", () => resolve());
});
const outcome = await stopOwnedChild(stubborn, { termTimeoutMs: 100, killTimeoutMs: 2_000 });
assert.equal(outcome, "kill");
assert.ok(stubborn.exitCode !== null || stubborn.signalCode !== null, "SIGKILL outcome requires observed exit");

const cooperative = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(await stopOwnedChild(cooperative, { termTimeoutMs: 2_000, killTimeoutMs: 2_000 }), "term");
assert.ok(cooperative.exitCode !== null || cooperative.signalCode !== null, "SIGTERM outcome requires observed exit");
console.log("owned child cleanup: 2 passed, 0 failed");
emitSentinel({ passed: cells(), failed: 0 });
