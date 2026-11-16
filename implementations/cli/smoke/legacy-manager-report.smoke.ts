import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { sessionContinuityClass } from "@cotal-ai/core";
import { legacyManagerReport, legacySeatLabel } from "../src/lib/legacy-manager-report.js";
import { printLegacyReport } from "../src/commands/update.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

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

assert.equal(legacySeatLabel({ name: " " }), "(unnamed)", "a whitespace seat name with no id is unnamed");
assert.equal(legacySeatLabel({ name: "", id: "u_b.blank" }), "u_b.blank", "an empty seat name is the id");
assert.equal(legacySeatLabel({ name: "\n", id: "u_b.blank" }), "u_b.blank", "a newline seat name is the id");
assert.equal(legacySeatLabel({ name: " ada" }), " ada", "a seat name with a leading space stays");
assert.equal(legacySeatLabel({ name: "linkedin-animator" }), "linkedin-animator", "a seat name stays");
const lines: string[] = [];
printLegacyReport({ custody: "legacy", seats: [
  { name: " ", agent: "claude", continuity: "fork" },
  { name: "", agent: "claude", continuity: "fork", id: "u_b.blank" },
  { name: "\n", agent: "claude", continuity: "fork", id: "u_b.blank" },
  { name: " ada", agent: "claude", continuity: "fork" },
] }, "alpha", undefined, (line) => lines.push(line));
assert.equal(lines.filter((line) => line.includes("fork")).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "")).join("\n"), "  (unnamed): fork\n  u_b.blank: fork\n  u_b.blank: fork\n   ada: fork", "a legacy update lists a blank seat by id");

console.log("legacy manager report smoke OK");
emitSentinel({ passed: cells(), failed: 0 });
