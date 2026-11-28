/** Repair removes this computer's own stale Manager registration only when the space confirms it,
 *  never the current instance, and never while the old one still answers. */
import assert from "node:assert/strict";
import type { RemoteEndpointDeregisterRequest, RemoteEndpointDeregisterResult } from "@cotal-ai/core";
import { repairStaleCleanup, type StaleCleanup } from "../daemon/manager-stale-cleanup.js";

const stale: StaleCleanup = { space: "team", recorded: "manager-old", current: "manager-new" };
type Answer = (request: RemoteEndpointDeregisterRequest) => RemoteEndpointDeregisterResult;
const removed: Answer = r => ({ ...r, state: "removed", removedSpecRevision: 4, removedStatusRevision: null });
const refused = (condition: "instance-answered" | "instance-not-affirmed-gone" | "not-registered" | "permission-denied" | "unavailable"): Answer => r => ({ ...r, state: "refused", condition });
const unknown: Answer = r => ({ ...r, state: "unknown", condition: "unavailable" });

async function run(answer: Answer | undefined, read: StaleCleanup | null = stale, authority = () => {}) {
  const sent: RemoteEndpointDeregisterRequest[] = [], rebound: string[] = [];
  let starts = 0;
  const outcome = await repairStaleCleanup({
    read: () => read ?? undefined, verifyAuthority: authority,
    deregister: async request => { sent.push(request); return answer!(request); },
    rebind: current => { rebound.push(current); }, start: async () => { starts++; },
  });
  return { outcome, sent, rebound, starts };
}

{
  const r = await run(removed);
  assert.equal(r.outcome.state, "removed");
  assert.deepEqual(r.sent.map(s => s.instanceId), ["manager-old"], "only the recorded old instance is sent");
  assert.deepEqual(r.rebound, ["manager-new"]); assert.equal(r.starts, 1);
  console.log("PASS removed: 1 request for the old instance, record rebound to the current one, host started once");
}
{
  const r = await run(refused("not-registered"));
  assert.equal(r.outcome.state, "removed"); assert.deepEqual(r.rebound, ["manager-new"]); assert.equal(r.starts, 1);
  console.log("PASS already gone in the space: record rebound and host started");
}
for (const condition of ["instance-answered", "instance-not-affirmed-gone"] as const) {
  const r = await run(refused(condition));
  assert.equal(r.outcome.state, "still-answers");
  assert.equal(r.outcome.message, "An older copy of this computer's agent host still answers in team, so Repair left it alone.");
  assert.equal(r.rebound.length + r.starts, 0, `${condition}: nothing changed`);
  console.log(`PASS ${condition}: left alone with its own sentence, 0 changes`);
}
for (const [name, answer] of [["permission-denied", refused("permission-denied")], ["unavailable", refused("unavailable")], ["unknown", unknown]] as const) {
  const r = await run(answer);
  assert.equal(r.outcome.state, "kept"); assert.equal(r.rebound.length + r.starts, 0, `${name}: record kept`);
  console.log(`PASS ${name}: record kept, 0 changes`);
}
{
  const r = await run(undefined, null);
  assert.equal(r.outcome.state, "kept"); assert.equal(r.sent.length, 0);
  const same = await run(undefined, { ...stale, current: stale.recorded });
  assert.equal(same.sent.length, 0, "a record naming the current instance is never sent");
  console.log("PASS no stale pair: 0 requests");
}
{
  await assert.rejects(run(removed, stale, () => { throw new Error("authority changed"); }), /authority changed/);
  console.log("PASS changed authority: refused before any request");
}
{
  await assert.rejects(run(r => ({ ...removed(r), instanceId: "manager-new" })), /another instance/);
  console.log("PASS an answer for another instance changes nothing");
}
