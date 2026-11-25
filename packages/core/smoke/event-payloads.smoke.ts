import { permissionsFor } from "../src/provision.js";
import { mintLifecycleUid, historyReaderConsumer, HISTORY_READERS } from "../src/subjects.js";
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
const minted = permissionsFor("agent", "payload", { owner: own, actor: "seat", connId: "probeconnection", lifecycleUid: mintLifecycleUid() }, { allowSubscribe: [">"], allowPublish: [] }) as { sub: { allow: string[] }; pub: { allow: string[] } };
assert.ok(!minted.sub.allow.some(g => subjectMatches(g, foreign)));
assert.ok(minted.sub.allow.some(g => subjectMatches(g, eventPayloadSubject("payload", own, "sibling"))));
assert.ok(!minted.pub.allow.some(g => subjectMatches(g, `$JS.API.CONSUMER.CREATE.EVP_payload.reader.${foreign}`)));
for (const readerId of [undefined, `N${"A".repeat(55)}_7`]) {
  const grants = permissionsFor("agent", "payload", { owner: own, actor: "seat", connId: "probeconnection", readerId, lifecycleUid: mintLifecycleUid() },
    { allowSubscribe: [">", "events.>", `events.${other}.seat`] }) as typeof minted;
  const allowed = (subject: string) => grants.pub.allow.some(g => subjectMatches(g, subject));
  for (let slot = 0; slot < HISTORY_READERS; slot++) {
    const name = historyReaderConsumer(readerId ?? "probeconnection", slot);
    assert.ok(allowed(`$JS.API.CONSUMER.CREATE.EVP_payload.${name}.${eventPayloadSubject("payload", own, "sibling")}`));
    assert.ok(allowed(`$JS.API.CONSUMER.CREATE.EVP_payload.${name}.${foreign}`));
    assert.ok(!allowed(`$JS.API.CONSUMER.CREATE.EVP_payload.${name}.${eventPayloadSubject("payload", other, "ungranted")}`));
    assert.ok(!allowed(`$JS.API.CONSUMER.CREATE.EVP_payload.${name}`));
    for (const verb of ["INFO", "MSG.NEXT", "DELETE"]) {
      assert.ok(allowed(`$JS.API.CONSUMER.${verb}.EVP_payload.${name}`));
      assert.ok(!allowed(`$JS.API.CONSUMER.${verb}.EVP_payload.${historyReaderConsumer("anotherconnection", slot)}`));
    }
  }
  assert.ok(!allowed(`$JS.API.CONSUMER.CREATE.EVP_payload.hist_${readerId ?? "probeconnection"}_${HISTORY_READERS}.${foreign}`));
}
console.log("event payload subject projection passed");
