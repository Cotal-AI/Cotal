/**
 * Sparkline smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * Two halves. The SERIES: MeshView keeps a fixed 15-bucket, 60-second activity ring (one ~4 s
 * bucket each): a live message lands in the newest bucket, idle time shifts the ring left and fills
 * with zeros, and a minute of silence empties it. Driven through a stub endpoint with the clock
 * under the smoke's control. The GLYPHS: `sparkline` scales every bar to the series' own max, pads
 * to a fixed width, shows only the most recent buckets, and clamps a poisoned value to zero.
 */
import { EventEmitter } from "node:events";
import { chatSubject, type CotalEndpoint, type CotalMessage } from "@cotal-ai/core";
import { MeshView } from "../src/view/mesh-view.js";
import { sparkline } from "../src/console/ui/Sparkline.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("1. the glyphs scale to the series' own max, pad to width, and clamp bad values");
check("an empty series is a flat floor of the fixed width", sparkline([], 15) === "▁".repeat(15));
check("the bar scales to the series' own max: 1,2,4 → ▃▅█", sparkline([1, 2, 4], 15).endsWith("▃▅█"));
check("...and a series ten-fold louder draws the same bars", sparkline([2, 4], 15) === sparkline([200, 400], 15));
check("the series is left-padded with zeros to the fixed width", sparkline([1, 2, 4], 15).length === 15 && sparkline([1, 2, 4], 15).startsWith("▁".repeat(12)));
check("only the most recent `width` buckets are drawn", sparkline([9, 9, 9, 1, 1, 1, 1, 1], 5) === "▁▁▁▁▁".replace(/▁/g, "█"));
check("a NaN or negative value is clamped to zero, never poisons the max", sparkline([NaN, -5, 3], 3) === "▁▁█");

console.log("2. the activity ring: a live message lands in the newest bucket, idle time decays it");
/** The smallest endpoint MeshView.start() touches, with the live tap captured so the smoke can feed it. */
class StubEndpoint extends EventEmitter {
  space = "stub";
  tapCb?: (subject: string, msg: CotalMessage) => void;
  async start() {}
  async stop() {}
  getRoster() { return []; }
  tap(cb: (subject: string, msg: CotalMessage) => void) { this.tapCb = cb; }
  async listChannels() { return [{ channel: "general", messages: 0 }]; }
  async dmHistory() { return []; }
  async channelHistory() { return []; }
  ref() { return { id: "stub", name: "stub" }; }
  async readMembership() { return { asOf: undefined, members: [] }; }
  async watchMembership() { return { stop: async () => {} }; }
}
const realNow = Date.now;
let now = realNow();
Date.now = () => now; // the ring rolls on MeshView's own clock reads; the smoke owns the clock
const stub = new StubEndpoint();
const view = new MeshView(stub as unknown as CotalEndpoint, {});
await view.start();
await wait(60);
const msg = (i: number): CotalMessage => ({
  v: 1, id: `m${i}`, ts: now, from: { id: "alice", name: "alice" }, to: "*", channel: "general", delivery: "multicast",
  parts: [{ kind: "text", text: `hello ${i}` }],
} as unknown as CotalMessage);
const activity = () => view.snapshot().rates.activity;
const subject = chatSubject("stub", "local", "alice", "general"); // the wire's own chat subject shape, so the fold classifies it
check("the ring is 15 buckets wide and starts empty", activity().length === 15 && activity().every((n) => n === 0), activity());
for (let i = 0; i < 3; i++) stub.tapCb?.(subject, msg(i));
await wait(150); // past a flush tick
check("three live messages land in the newest bucket", activity()[14] === 3, activity());
now += 4000; // one bucket of idle time
await wait(250);
check("an idle 4 s shifts the bucket left and opens an empty newest one", activity()[13] === 3 && activity()[14] === 0, activity());
stub.tapCb?.(subject, msg(10));
await wait(150);
check("the next message counts into the new bucket, the old one keeps its count", activity()[13] === 3 && activity()[14] === 1, activity());
now += 61_000; // a minute of silence
await wait(250);
check("a minute of silence empties the whole ring", activity().every((n) => n === 0), activity());
check("the status bar would draw that as a flat floor", sparkline(activity()) === "▁".repeat(15));
await view.stop();
Date.now = realNow;

console.log(`\n${fail === 0 ? "SPARKLINE SMOKE OK ✅" : "SPARKLINE SMOKE FAILED ❌"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
