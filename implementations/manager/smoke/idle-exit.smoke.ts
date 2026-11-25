/**
 * The Manager's opt-in idle exit clock. Run: tsx smoke/idle-exit.smoke.ts
 *
 * It drives the shipped IdleExit with a scripted idle state and stop, on short periods, so each cell
 * reads one rule: nothing before arm, a stop after a whole idle period, activity restarts the clock,
 * one stop handed to onStop, the stop called in the tick whose check found the Manager idle, disarm,
 * and the option's refusals. Then a real, unstarted Manager's own idle state: its clock holds while
 * any work a stop would cut short is pending. The live `cotal manager start --idle-exit` check covers
 * a started Manager.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleExit } from "../src/idle-exit.js";
import { Manager } from "../src/manager.js";

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
let failed = 0;
async function cell(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ FAIL: ${name}: ${(error as Error).message}`);
  }
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

// The Manager's own idle state. Its clock runs only while nothing a stop would cut short is pending:
// the same work `status` reports in `stopImpact` and `cotal manager stop` refuses over. Each cell
// sets one kind of it on a real, unstarted Manager with no agents, and ends it by the same members.
// The Manager's stop is counted, not run, since an unstarted Manager has nothing to stop.
type Internals = {
  namesCapacity: { reserve(name: string, owner: string): void; release(name: string): void };
  retirement: { hold(name: string, hold: unknown): void; retiring: Map<string, unknown>; deprovisioningFlight: Map<string, Promise<void>> };
  staticLifecycle: { staticReconcileSweepsInFlight: number };
  idleExit: IdleExit;
  managerStatusData(owner: undefined): { stopImpact: Record<string, unknown> };
};
const PENDING: [string, string, (m: Internals) => () => void][] = [
  ["a launch's reserved name", "reservedLaunches", (m) => { m.namesCapacity.reserve("held", "owner"); return () => m.namesCapacity.release("held"); }],
  ["a despawned name held until its retirement completes", "retirementsPending", (m) => { m.retirement.hold("gone", { opId: "op", owner: "owner", actor: "gone", target: { name: "gone", lifecycleUid: "uid" }, startedAt: Date.now() }); return () => m.retirement.retiring.delete("gone"); }],
  ["a deprovision in flight", "deprovisioningInFlight", (m) => { m.retirement.deprovisioningFlight.set("gone", new Promise<void>(() => {})); return () => m.retirement.deprovisioningFlight.delete("gone"); }],
  ["a static reconcile sweep", "staticReconciliationInFlight", (m) => { m.staticLifecycle.staticReconcileSweepsInFlight++; return () => { m.staticLifecycle.staticReconcileSweepsInFlight--; }; }],
];
const root = mkdtempSync(join(tmpdir(), "idle-exit-"));
function manager(): { m: Internals; stops: Promise<void>[] } {
  const stops: Promise<void>[] = [];
  const real = new Manager({ space: "idle", servers: "nats://127.0.0.1:1", workspaceRoot: root, runtime: "pty", idleExit: { afterMs: PERIOD, onStop: (p) => stops.push(p) } });
  real.stop = () => Promise.resolve();
  return { m: real as unknown as Internals, stops };
}

await cell("a real Manager with no agents and nothing pending stops after a whole idle period", async () => {
  const { m, stops } = manager();
  m.idleExit.arm();
  await wait(PERIOD * 3);
  assert.equal(stops.length, 1);
});

for (const [what, field, begin] of PENDING) {
  await cell(`with ${what} pending, it does not stop, and its status shows that work; once that ends, it stops a whole period later`, async () => {
    const { m, stops } = manager();
    const end = begin(m);
    m.idleExit.arm();
    await wait(PERIOD * 3);
    assert.equal(stops.length, 0, `no stop while ${what} is pending`);
    assert.equal(m.managerStatusData(undefined).stopImpact[field], 1, `status reports ${field} while it holds the clock`);
    end();
    const ended = Date.now();
    await wait(PERIOD * 3);
    assert.equal(stops.length, 1, "one stop once it ends");
    assert.ok(Date.now() - ended >= PERIOD);
  });
}
rmSync(root, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
