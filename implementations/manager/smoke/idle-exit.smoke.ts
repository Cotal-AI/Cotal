/**
 * The Manager's opt-in idle exit clock. Run: tsx smoke/idle-exit.smoke.ts
 *
 * It drives the shipped IdleExit with a scripted idle state and stop, on short periods, so each cell
 * reads one rule: nothing before arm, a stop after a whole idle period, activity restarts the clock,
 * one stop handed to onStop, the stop called in the tick whose check found the Manager idle, disarm,
 * and the option's refusals. The live `cotal manager start --idle-exit` check covers a real Manager.
 */
import assert from "node:assert/strict";
import { IdleExit } from "../src/idle-exit.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PERIOD = 200;

function rig(idle: () => boolean) {
  const seen: { stops: number; handed: Promise<void>[] } = { stops: 0, handed: [] };
  const stopped = Promise.resolve();
  const watch = new IdleExit({ afterMs: PERIOD, onStop: (p) => seen.handed.push(p) }, idle, () => {
    seen.stops++;
    return stopped;
  });
  return { watch, seen, stopped };
}

let passed = 0;
async function cell(name: string, body: () => Promise<void>): Promise<void> {
  await body();
  passed++;
  console.log(`  ✓ ${name}`);
}

await cell("nothing stops before arm, however long the Manager is idle", async () => {
  const { seen } = rig(() => true);
  await wait(PERIOD * 3);
  assert.equal(seen.stops, 0);
});

await cell("an armed idle Manager stops once, after a whole period, and onStop gets that stop", async () => {
  const { watch, seen, stopped } = rig(() => true);
  const armed = Date.now();
  watch.arm();
  await wait(PERIOD / 2);
  assert.equal(seen.stops, 0, "not before the period ends");
  await wait(PERIOD * 3);
  assert.equal(seen.stops, 1, "exactly one stop");
  assert.equal(seen.handed.length, 1);
  assert.equal(seen.handed[0], stopped, "onStop receives the stop's own promise");
  assert.ok(Date.now() - armed >= PERIOD);
});

await cell("activity restarts the clock: the stop comes a whole period after the Manager last held an agent", async () => {
  let busy = false;
  const { watch, seen } = rig(() => !busy);
  watch.arm();
  await wait(PERIOD * 0.75);
  busy = true;
  await wait(PERIOD * 0.75);
  busy = false;
  const freed = Date.now();
  await wait(PERIOD * 0.75);
  assert.equal(seen.stops, 0, "the earlier idle time does not count");
  await wait(PERIOD * 2);
  assert.equal(seen.stops, 1);
  assert.ok(Date.now() - freed >= PERIOD);
  watch.disarm();
});

await cell("the stop is called inside the check that found the Manager idle, before any queued work runs", async () => {
  // Each idle read queues a microtask. A stop called synchronously in the check runs before it; a
  // stop deferred by any await or tick would run after it, when a spawn could already be admitted.
  let readPending = false;
  let pendingAtStop: boolean | undefined;
  const watch = new IdleExit({ afterMs: PERIOD, onStop: () => {} }, () => {
    readPending = true;
    queueMicrotask(() => { readPending = false; });
    return true;
  }, () => {
    pendingAtStop = readPending;
    return Promise.resolve();
  });
  watch.arm();
  await wait(PERIOD * 3);
  assert.equal(pendingAtStop, true);
});

await cell("a disarmed watch never stops", async () => {
  const { watch, seen } = rig(() => true);
  watch.arm();
  watch.disarm();
  await wait(PERIOD * 3);
  assert.equal(seen.stops, 0);
});

await cell("the option refuses a period that is not a positive whole number of milliseconds, and a missing onStop", async () => {
  const stop = () => Promise.resolve();
  for (const afterMs of [0, -1, 1.5, Number.NaN]) assert.throws(() => new IdleExit({ afterMs, onStop: () => {} }, () => true, stop), /afterMs/);
  assert.throws(() => new IdleExit({ afterMs: 1000, onStop: undefined as unknown as () => void }, () => true, stop), /onStop/);
});

console.log(`${passed} passed, 0 failed`);
