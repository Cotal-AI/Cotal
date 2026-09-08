import assert from "node:assert/strict";
import { sessionContinuityClass } from "@cotal-ai/core";
import { legacyManagerReport } from "../src/lib/legacy-manager-report.js";

const classes = [
  [{ supportsSessionContinuation: true, supportsResume: true, supportsFreshStart: true }, "exact"],
  [{ supportsResume: true, supportsFreshStart: true }, "fork"],
  [{ supportsFreshStart: true }, "fresh"],
  [{}, "drain-only"],
] as const;

for (const [flags, expected] of classes)
  assert.equal(sessionContinuityClass(flags), expected, `public flags classify as ${expected}`);

const report = await legacyManagerReport(
  {},
  [
    { name: "same-session", agent: "one" },
    { name: "fork-source", agent: "two" },
    { name: "new-session", agent: "three" },
    { name: "no-promise", agent: "four" },
  ],
  async (agent) => ({
    one: { supportsSessionContinuation: true },
    two: { supportsResume: true },
    three: { supportsFreshStart: true },
    four: {},
  })[agent],
);
assert.deepEqual(report, {
  custody: "legacy",
  seats: [
    { name: "same-session", agent: "one", continuity: "exact" },
    { name: "fork-source", agent: "two", continuity: "fork" },
    { name: "new-session", agent: "three", continuity: "fresh" },
    { name: "no-promise", agent: "four", continuity: "drain-only" },
  ],
});
assert.equal(await legacyManagerReport({ custody: "custodied" }, [], async () => ({})), undefined);

console.log("legacy manager report smoke OK");
