import assert from "node:assert/strict";
import { eventPayloadReadSubjects, eventPayloadSubject, eventPayloadStream } from "../src/event-payloads.js";
import { subjectMatches } from "../src/subjects.js";

const own = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const other = "u_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const foreign = eventPayloadSubject("payload", other, "seat");
for (const broad of [">", "events.>", "events.*.*"]) {
  const grants = eventPayloadReadSubjects("payload", own, [broad]);
  assert.ok(grants.some(g => subjectMatches(g, eventPayloadSubject("payload", own, "seat"))));
  assert.ok(!grants.some(g => subjectMatches(g, foreign)));
}
assert.ok(eventPayloadReadSubjects("payload", own, [`events.${other}.seat`]).includes(foreign));
assert.ok(eventPayloadReadSubjects("payload", own, [], true).some(g => subjectMatches(g, foreign)));
assert.ok(!subjectMatches("cotal.payload.chat.*.*.>", foreign));
assert.equal(eventPayloadStream("payload"), "EVP_payload");
console.log("event payload subject projection passed");
