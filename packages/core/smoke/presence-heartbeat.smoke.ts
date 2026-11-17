import assert from "node:assert/strict";
import { nextHeartbeat } from "../src/presence-heartbeat.js";

// Beats stay on the endpoint's own phase whatever instant the previous callback ran, a late loop
// skips the beats it missed instead of queueing them, and the delay is never negative.
let checks = 0;
const phase = 1_000_000, interval = 2000;
assert.deepEqual(nextHeartbeat(phase, interval, 0, phase), { beat: 1, delayMs: 2000 }); checks++;
assert.deepEqual(nextHeartbeat(phase, interval, 1, phase + 2130), { beat: 2, delayMs: 1870 }, "a callback that ran 130 ms late re-arms to the phase, not 2000 ms from now"); checks++;
assert.deepEqual(nextHeartbeat(phase, interval, 2, phase + 4000), { beat: 3, delayMs: 2000 }, "on time: the next beat is a full interval away"); checks++;
assert.deepEqual(nextHeartbeat(phase, interval, 3, phase + 11_500), { beat: 6, delayMs: 500 }, "a 5.5 s stall skips beats 4 and 5 and lands on 6"); checks++;
assert.deepEqual(nextHeartbeat(phase, interval, 3, phase + 12_000), { beat: 6, delayMs: 0 }, "exactly on a beat: due now, not queued twice"); checks++;
assert.deepEqual(nextHeartbeat(phase, interval, 0, phase - 50), { beat: 1, delayMs: 2050 }, "a clock behind the phase still counts forward"); checks++;
// two endpoints whose callbacks ran in the same late pass keep distinct phases
const a = nextHeartbeat(phase, interval, 1, phase + 2400), b = nextHeartbeat(phase + 700, interval, 1, phase + 2400);
assert.equal(a.delayMs, 1600); assert.equal(b.delayMs, 2300); checks += 2;
for (let now = phase; now < phase + 60_000; now += 37) { const { delayMs } = nextHeartbeat(phase, interval, 0, now); assert.ok(delayMs >= 0 && delayMs <= interval); }
checks++;
console.log(`presence-heartbeat: ${checks} assertion groups passed`);
