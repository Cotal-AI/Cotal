import assert from "node:assert/strict";
import { mock } from "node:test";
import type { Presence } from "../src/index.js";
import { nativeLoadFailures, readRosterSample } from "./_seat-idle-results.js";

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
console.log(`seat-idle-results: ${checks} assertions passed`);
