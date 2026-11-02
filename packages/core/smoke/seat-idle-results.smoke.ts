import assert from "node:assert/strict";
import { mock } from "node:test";
import type { Presence } from "../src/index.js";
import { nativeLoadFailures, readRosterSample, nativeErrorClass, nativeErrorObserver } from "./_seat-idle-results.js";

let checks = 0;
const clean = { requested: 12, up: 12, failed: 0, missingMid: 0, missingEnd: 0, staleMid: 0, staleEnd: 0, endpointErrors: 0, apiErrors: 0, slowConsumers: 0, brokerWarnings: 0 };
assert.deepEqual(nativeLoadFailures(clean), []); checks++;
for (const key of ["failed", "missingMid", "missingEnd", "staleMid", "staleEnd", "endpointErrors", "apiErrors", "slowConsumers", "brokerWarnings"] as const) {
  assert.ok(nativeLoadFailures({ ...clean, [key]: 1 }).length, key); checks++;
}
assert.ok(nativeLoadFailures({ ...clean, up: 11 }).length); checks++;
const actual = nativeLoadFailures({ ...clean, requested: 6144, up: 6143, failed: 1, missingEnd: 1, apiErrors: 21, brokerWarnings: 7, endpointErrors: 2427 });
assert.deepEqual(actual, ["starts 6143/6144, failed 1", "missingEnd=1", "endpointErrors=2427", "apiErrors=21", "brokerWarnings=7"]); checks++;

mock.timers.enable({ apis: ["Date"], now: 1000 });
try {
  const roster: Presence[] = [{ card: { id: "peer", name: "peer", kind: "agent" }, status: "idle", ts: 1200 }];
  const first = await readRosterSample({ readPresence: async () => { await Promise.resolve(); mock.timers.tick(250); return roster; } });
  assert.equal(first.sampledAt, 1250); checks++;
  const second = await readRosterSample({ readPresence: async () => { mock.timers.tick(500); return []; } });
  assert.equal(second.sampledAt, 1750); checks++;
  assert.equal(first.roster, roster); checks++;
  assert.equal(first.sampledAt - first.roster[0].ts, 50); checks++;
  const error = new Error("native read failed");
  await assert.rejects(readRosterSample({ readPresence: async () => { throw error; } }), (e) => e === error); checks++;
} finally { mock.timers.reset(); }
const timeout = Object.assign(new Error("private subject and credential"), { name: "TimeoutError" });
assert.equal(nativeErrorClass(timeout), "TimeoutError"); checks++;
assert.equal(nativeErrorClass(Object.assign(new Error("Authentication Timeout: private"), { name: "AuthorizationError" })), "AuthenticationTimeout"); checks++;
assert.equal(nativeErrorClass(Object.assign(new Error("private"), { name: "private-name" })), "other"); checks++;
assert.equal(nativeErrorClass("private"), "unknown"); checks++;
assert.equal(nativeErrorClass(new Error("timeout")), "TimeoutError"); checks++;
assert.equal(nativeErrorClass(Object.assign(new Error("private"), { name: "AuthorizationError" })), "AuthorizationError"); checks++;
const wrapped = new Error("private wrapper and subject", { cause: timeout });
assert.equal(nativeErrorClass(wrapped), "TimeoutError"); checks++;
const cycle = new Error("private cycle"); cycle.cause = cycle;
assert.equal(nativeErrorClass(cycle), "other"); checks++;
let deep: Error = timeout;
for (let i = 0; i < 4; i++) deep = new Error("private deep wrapper", { cause: deep });
assert.equal(nativeErrorClass(deep), "other"); checks++;
assert.equal(nativeErrorClass(new Error("private", { cause: "private non-error" })), "other"); checks++;
const rows: unknown[] = [];
const observation = nativeErrorObserver((row) => rows.push(row), 2);
observation.note("warning", timeout); observation.note("warning", timeout); observation.note("warning", timeout);
assert.equal(rows.length, 2); checks++;
assert.deepEqual(observation.summary(), { total: 3, emitted: 2, dropped: 1, counts: { "warning:TimeoutError": 3 } }); checks++;
assert.ok(!JSON.stringify(rows).includes("private")); checks++;
assert.deepEqual(Object.keys(rows[0] as object).sort(), ["category", "epochMs", "source"]); checks++;
assert.throws(() => nativeErrorObserver(() => {}, -1)); checks++;
const silent = nativeErrorObserver(() => { throw new Error("must not emit"); }, 0);
silent.note("start", timeout);
assert.equal(silent.summary().dropped, 1); checks++;
console.log(`seat-idle-results: ${checks} assertions passed`);
