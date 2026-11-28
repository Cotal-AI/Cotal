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

async function run(answer: Answer | undefined, read: StaleCleanup | null = stale, authority = () => {}, intended = true) {
  const sent: RemoteEndpointDeregisterRequest[] = [], rebound: string[] = [], order: string[] = [];
  let starts = 0, disconnects = 0;
  const outcome = await repairStaleCleanup({
    intended: () => { order.push("intent"); return intended; },
    read: () => read ?? undefined, verifyAuthority: authority,
    deregister: async request => { order.push("deregister"); sent.push(request); return answer!(request); },
    rebind: current => { rebound.push(current); }, start: async () => { starts++; },
    finishDisconnect: async () => { disconnects++; },
  });
  return { outcome, sent, rebound, starts, disconnects, order };
}

{
  const r = await run(removed);
  assert.equal(r.outcome.state, "removed");
  assert.deepEqual(r.sent.map(s => s.instanceId), ["manager-old"], "only the recorded old instance is sent");
  assert.deepEqual(r.rebound, ["manager-new"]); assert.equal(r.starts, 1);
  console.log("PASS removed: 1 request for the old instance, record rebound to the current one, host started once");
}
{
  // Finding 2: a space the person disconnected stays disconnected; Repair finishes that disconnect.
  const r = await run(removed, stale, () => {}, false);
  assert.equal(r.order[0], "intent", "the intent is read before any request");
  assert.equal(r.starts, 0, "a disconnected space is not started again");
  assert.equal(r.disconnects, 1, "its disconnect is finished");
  assert.equal(r.outcome.message, "The old registration in team was removed and the space stays disconnected from this computer.");
  console.log("PASS a withdrawn space: old registration removed, disconnect finished, 0 starts");
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

// W9: a removal that succeeded is reported as removed, even when the step after it fails.
{
  const failing = (what: "start" | "disconnect") => repairStaleCleanup({
    intended: () => what === "start", read: () => stale, verifyAuthority: () => {},
    deregister: async request => removed(request), rebind: () => {},
    start: async () => { throw new Error("the manager did not start"); },
    finishDisconnect: async () => { throw new Error("Manager registration removal is unconfirmed"); },
  });
  const disconnect = await failing("disconnect");
  assert.equal(disconnect.state, "removed-unfinished");
  assert.equal(disconnect.message, "The old registration in team was removed, but disconnecting the space from this computer didn't finish. Choose Repair again to finish it.");
  const start = await failing("start");
  assert.equal(start.state, "removed-unfinished");
  assert.equal(start.message, "The old registration in team was removed, but the agent host didn't start again. Choose Repair again to start it.");
  console.log("PASS removed then a failed finish: says it was removed and names what is left");
}

// The account step: only a sign-in the person must give appears; a Cloud read that is retrying does not.
{
  const { accountSteps } = await import("../daemon/repair.js");
  const status = (accounts: Record<string, unknown>[]) => ({ state: "ready", protocol: 1, version: "x", pid: 1, startedAt: "", uptimeMs: 0, account: { mode: "account", hostSupport: "supported", spaces: [], accounts } }) as never;
  const base = { hostSupport: "supported", spaces: [], idpUrl: "https://cotal.cloud/api/auth" };
  const removedSteps = accountSteps(status([{ ...base, mode: "sign-in-required", reason: "computer-removed" }]));
  assert.deepEqual(removedSteps.map(step => [step.outcome, step.found]), [["needs-you", "This computer was removed from your account. Sign in to add it back."]]);
  const expired = accountSteps(status([{ ...base, mode: "sign-in-required" }]));
  assert.deepEqual(expired.map(step => step.found), ["Sign in to Cotal Cloud again to keep using this computer from your spaces."]);
  assert.equal(accountSteps(status([{ ...base, mode: "account", cloud: { state: "retrying", since: "x", reason: "refused" } }])).length, 0, "a retrying read is left to the service");
  const other = accountSteps(status([{ ...base, mode: "account" }, { ...base, idpUrl: "https://hack.cotal.ai/api/auth", mode: "sign-in-required" }]));
  assert.deepEqual(other.map(step => step.found), ["Sign in to hack.cotal.ai again to keep using this computer from your spaces."], "one step per account that needs it, named by host when the provider is not known");
  console.log("PASS account step: removed and expired sign-ins need the person, a retrying read gets 0 steps");
}
